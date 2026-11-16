/**
 * Built-in MCP server names are reserved in every spelling a harness folds into the same tool name
 * (case, and `-` / `_` / `.`), and two user servers may not fold into the same names either. A
 * definition that breaks either rule is refused when saved and never selected for a session; one
 * already on disk stays visible with the reason rather than vanishing.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppSettings, McpServerDef } from '../src/shared/types';
import { effectiveEntries } from '../src/main/mcp/effective';
import { parseMcpJson } from '../src/main/mcp/file';
import { cuaBaseDef, gitnexusBaseDef, memoryServerDef, projectInfo, resolveForSession, vocsMemoryBaseDef } from '../src/main/mcp';
import { SettingsStore, defaultSettings, mcpServersSaveError, normalizeMcpServers } from '../src/main/settings';

const MEMORY_ALIASES = ['vocs_memory', 'vocs.memory', 'Vocs-Memory'];
const CODE_GRAPH_ALIASES = ['GitNexus', 'GITNEXUS', 'gitnexus_'];
const ALIASES = [...MEMORY_ALIASES, ...CODE_GRAPH_ALIASES, 'cua_driver', 'Vocs.Mission'];

const dirs: string[] = [];
const savedHome = process.env.GITNEXUS_HOME;
beforeEach(async () => {
  // An empty code-graph registry, so no built-in is served and only user definitions are in play.
  process.env.GITNEXUS_HOME = await temp('vocs-reserved-gn-');
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
  else process.env.GITNEXUS_HOME = savedHome;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const http = (id: string): McpServerDef => ({ id, transport: 'http', url: 'https://mcp.example.invalid/mcp' });
const stdio = (id: string): McpServerDef => ({ id, transport: 'stdio', command: process.execPath, args: ['server.mjs'] });

function settingsWith(patch: Partial<AppSettings>): AppSettings {
  return { ...defaultSettings(), ...patch } as AppSettings;
}

async function session(settings: AppSettings, repo?: Record<string, unknown>) {
  const project = await temp('vocs-reserved-proj-');
  if (repo) await writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: repo }), 'utf8');
  return { settings, cwd: project, projectRoot: project, harness: 'pi' as const };
}

/** The user and repository servers a session gets; a built-in this machine happens to serve is not under test. */
const resolve = async (scope: Awaited<ReturnType<typeof session>>) => (await resolveForSession(scope, { getSecret: async () => undefined })).filter((r) => !r.def.builtin);

describe('global MCP definitions', () => {
  it.each(ALIASES)('refuses to save %s and names the built-in it collides with', async (id) => {
    const dir = await temp('vocs-reserved-settings-');
    const store = new SettingsStore(dir);
    await store.load();
    await expect(store.update({ mcpServers: [http('files'), http(id)] })).rejects.toThrow(/reserved for the built-in/);
    expect(store.get().mcpServers).toEqual([]);
    await expect(readFile(path.join(dir, 'settings.json'), 'utf8')).rejects.toThrow();
  });

  it('refuses two servers whose names fold into the same tool names', async () => {
    const store = new SettingsStore(await temp('vocs-reserved-settings-'));
    await store.load();
    await store.update({ mcpServers: [http('my-server')] });
    await expect(store.update({ mcpServers: [http('my-server'), http('My_Server')] })).rejects.toThrow(/"My_Server".*"my-server"/);
    expect(store.get().mcpServers.map((d) => d.id)).toEqual(['my-server']);
  });

  it('never refuses removing a server because of a collision already stored elsewhere', async () => {
    const dir = await temp('vocs-reserved-settings-');
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ mcpServers: [http('x'), http('X'), http('x.')] }), 'utf8');
    const store = new SettingsStore(dir);
    await store.load();
    // Removing `x` changes which server `x.` is reported against, not whether it was already flagged.
    await expect(store.update({ mcpServers: [http('X'), http('x.')] })).resolves.toBeTruthy();
    expect(store.get().mcpServers.map((d) => d.id)).toEqual(['X', 'x.']);
    expect(mcpServersSaveError([http('X'), http('x.'), http('X_')], store.get().mcpServers)).toMatch(/"X_".*"X"/);
  });

  it.each(ALIASES)('keeps a stored %s visible as not loaded and never selects it', async (id) => {
    const dir = await temp('vocs-reserved-settings-');
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ mcpServers: [http(id), http('files')] }), 'utf8');
    const store = new SettingsStore(dir);
    await store.load();
    expect(store.get().mcpServers.map((d) => d.id)).toEqual([id, 'files']);

    const scope = await session(store.get());
    const info = await projectInfo(scope);
    expect(info.rejected).toEqual([{ id, scope: 'global', reason: expect.stringMatching(/reserved for the built-in/) }]);
    expect(info.effective.find((e) => e.def.id === id)).toMatchObject({ enabled: false, reason: 'reserved' });
    expect((await resolve(scope)).map((r) => r.def.id)).toEqual(['files']);

    // An unrelated save still goes through; the flagged entry stays flagged.
    await expect(store.update({ mcpServers: [...store.get().mcpServers, http('docs')] })).resolves.toBeTruthy();
    await expect(store.update({ mcpServers: [http('Vocs_Memory_')] })).rejects.toThrow(/reserved for the built-in/);
  });
});

describe('repository .mcp.json definitions', () => {
  it.each(ALIASES)('reports %s as not loaded, even when the repo switch enables it', async (id) => {
    const project = await session(settingsWith({}), { [id]: { command: process.execPath, args: ['server.mjs'] }, notes: { command: process.execPath } });
    project.settings = settingsWith({ mcpProjectState: { [project.projectRoot]: { enabledRepo: [id, 'notes'] } } });
    const info = await projectInfo(project);
    expect(info.repo.map((d) => d.id)).toEqual([id, 'notes']);
    expect(info.rejected).toEqual([{ id, scope: 'repo', reason: expect.stringMatching(/reserved for the built-in/) }]);
    expect(info.effective.find((e) => e.def.id === id)).toMatchObject({ scope: 'repo', enabled: false, reason: 'reserved' });
    expect((await resolve(project)).map((r) => r.def.id)).toEqual(['notes']);
  });

  it('loads only the first of two entries whose names fold together', async () => {
    const project = await session(settingsWith({}), { 'a-b': { command: process.execPath }, 'A.B': { command: process.execPath } });
    project.settings = settingsWith({ mcpProjectState: { [project.projectRoot]: { enabledRepo: ['a-b', 'A.B'] } } });
    const info = await projectInfo(project);
    expect(info.rejected).toEqual([{ id: 'A.B', scope: 'repo', reason: expect.stringMatching(/same tool names as "a-b"/) }]);
    expect((await resolve(project)).map((r) => r.def.id)).toEqual(['a-b']);
  });

  it('lets the repo entry win over a global one that folds to the same name', async () => {
    const project = await session(settingsWith({}), { notes_server: { command: process.execPath } });
    project.settings = settingsWith({ mcpServers: [stdio('notes-server')], mcpProjectState: { [project.projectRoot]: { enabledRepo: ['notes_server'] } } });
    expect((await resolve(project)).map((r) => r.def.id)).toEqual(['notes_server']);
    const info = await projectInfo(project);
    expect(info.effective.find((e) => e.def.id === 'notes-server')).toMatchObject({ scope: 'global', enabled: false, reason: 'shadowed' });
  });

  it.each(ALIASES)('refuses to write %s into the repo file', (id) => {
    expect(mcpServersSaveError([stdio('notes'), stdio(id)], [])).toMatch(/reserved for the built-in/);
    expect(mcpServersSaveError([stdio('notes'), stdio('Notes')], [])).toMatch(/same tool names/);
    expect(mcpServersSaveError([stdio('notes'), stdio('docs')], [])).toBeNull();
  });

  it('keeps every entry selectable that breaks no rule', () => {
    const entries = effectiveEntries({ global: [stdio('docs')], repo: [stdio('notes')], state: { enabledRepo: ['notes'] }, harness: 'pi', support: 'inject', builtin: [vocsMemoryBaseDef()] });
    expect(entries.map((e) => [e.def.id, e.enabled])).toEqual([['notes', true], ['docs', true]]);
  });
});

describe('built-in provenance', () => {
  it('is set on every definition the app builds for its own servers', () => {
    expect(vocsMemoryBaseDef().builtin).toBe('vocs-memory');
    expect(memoryServerDef({ projectRoot: '/p', cwd: '/p' }, vocsMemoryBaseDef(), { memoryServerPath: '/m.mjs' })?.builtin).toBe('vocs-memory');
    expect(gitnexusBaseDef().builtin).toBe('gitnexus');
    expect(gitnexusBaseDef('/bin/gitnexus').builtin).toBe('gitnexus');
    expect(cuaBaseDef(defaultSettings()).builtin).toBe('cua-driver');
  });

  it('is never taken from a user or repository definition', async () => {
    const claimed = { id: 'notes', transport: 'stdio', command: 'node', builtin: 'vocs-memory' };
    expect(normalizeMcpServers([claimed])[0]).not.toHaveProperty('builtin');
    expect(parseMcpJson(JSON.stringify({ mcpServers: { notes: { command: 'node', builtin: 'vocs-memory' } } })).servers[0]).not.toHaveProperty('builtin');
    const dir = await temp('vocs-reserved-settings-');
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ mcpServers: [claimed] }), 'utf8');
    const store = new SettingsStore(dir);
    await store.load();
    expect(store.get().mcpServers[0]).not.toHaveProperty('builtin');
  });
});
