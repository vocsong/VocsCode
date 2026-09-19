import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppSettings, McpServerDef } from '../src/shared/types';
import { builtinEntries, effectiveEntries, effectiveServers } from '../src/main/mcp/effective';
import { projectInfo, resolveForSession } from '../src/main/mcp';
import { normalizeSettings } from '../src/main/settings';
import {
  GITNEXUS_SERVER_ID,
  gitnexusBaseDef,
  gitnexusSharedRoots,
  isBuiltinServerId,
  isGitnexusIndexed,
  readGitnexusRegistry,
  realGitnexusHome,
  visibleGitnexusEntries
} from '../src/main/mcp/gitnexus';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const entry = (name: string, p: string) => ({ name, path: p, storagePath: path.join(p, '.gitnexus') });

describe('GitNexus registry reading', () => {
  it('treats a missing or malformed registry as empty', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gn-'));
    dirs.push(dir);
    expect(await readGitnexusRegistry(dir)).toEqual([]);
    await writeFile(path.join(dir, 'registry.json'), '{ not json', 'utf8');
    expect(await readGitnexusRegistry(dir)).toEqual([]);
    await writeFile(path.join(dir, 'registry.json'), '{"not":"an array"}', 'utf8');
    expect(await readGitnexusRegistry(dir)).toEqual([]);
  });

  it('honours GITNEXUS_HOME over the default home', () => {
    expect(realGitnexusHome({ GITNEXUS_HOME: '/custom/gn' } as NodeJS.ProcessEnv, '/home/u')).toBe('/custom/gn');
    expect(realGitnexusHome({} as NodeJS.ProcessEnv, '/home/u')).toBe(path.join('/home/u', '.gitnexus'));
  });
});

describe('GitNexus visibility is strict', () => {
  const entries = [entry('Y', 'G:/work/y'), entry('X', 'G:/work/x'), entry('Z', 'D:/other/z')];

  it('shows only the session repo when nothing is shared', () => {
    const visible = visibleGitnexusEntries(entries, { projectRoot: 'G:/work/y', cwd: 'G:/work/y', sharedRoots: [] });
    expect(visible.map((e) => e.name)).toEqual(['Y']);
  });

  it('shows a shared repo alongside the session repo, and nothing else', () => {
    const visible = visibleGitnexusEntries(entries, { projectRoot: 'G:/work/y', cwd: 'G:/work/y', sharedRoots: ['G:/work/x'] });
    expect(visible.map((e) => e.name).sort()).toEqual(['X', 'Y']);
  });

  it('matches a worktree cwd to its own index without leaking others', () => {
    const visible = visibleGitnexusEntries(entries, { projectRoot: 'G:/work/y', cwd: 'G:/work/y/.vocs-code/worktrees/wt', sharedRoots: [] });
    expect(visible.map((e) => e.name)).toEqual(['Y']);
  });

  it('normalises separators and case so Windows paths match', () => {
    const visible = visibleGitnexusEntries(entries, { projectRoot: 'g:\\work\\Y', cwd: 'g:/work/y/', sharedRoots: [] });
    expect(visible.map((e) => e.name)).toEqual(['Y']);
  });

  it('reports indexed only for the session repo', () => {
    expect(isGitnexusIndexed(entries, { projectRoot: 'G:/work/y', cwd: 'G:/work/y' })).toBe(true);
    expect(isGitnexusIndexed(entries, { projectRoot: 'G:/work/missing', cwd: 'G:/work/missing' })).toBe(false);
  });
});

describe('built-in GitNexus in the effective set', () => {
  const def = gitnexusBaseDef();
  const none: McpServerDef[] = [];

  it('is enabled by default for inject harnesses and shadowed by no user entry', () => {
    const entries = builtinEntries({ builtin: [def], state: {}, harness: 'claude', support: 'inject' });
    expect(entries).toEqual([{ def, scope: 'builtin', enabled: true }]);
  });

  it('is off when the repo switched it off', () => {
    const [e] = builtinEntries({ builtin: [def], state: { disabledBuiltin: [GITNEXUS_SERVER_ID] }, harness: 'claude', support: 'inject' });
    expect(e.enabled).toBe(false);
    expect(e.reason).toBe('disabled');
  });

  it('is off when the MCP page switched it off everywhere', () => {
    const [e] = builtinEntries({ builtin: [def], state: {}, globalDisabled: [GITNEXUS_SERVER_ID], harness: 'claude', support: 'inject' });
    expect(e.enabled).toBe(false);
    expect(e.reason).toBe('disabled');
  });

  it('is not injected into harnesses that read their own store or take nothing', () => {
    for (const support of ['none', 'inherit'] as const) {
      const [e] = builtinEntries({ builtin: [def], state: {}, harness: 'cursor', support });
      expect(e.enabled).toBe(false);
      expect(e.reason).toBe('not-injected');
    }
  });

  it('shadows a user server with the same id instead of injecting it twice', () => {
    const user = { id: GITNEXUS_SERVER_ID, transport: 'stdio' as const, command: 'npx', args: ['-y', 'gitnexus@latest', 'mcp'] };
    const input = { global: [user], repo: none, state: {}, harness: 'claude' as const, support: 'inject' as const, builtin: [def] };
    expect(effectiveServers(input)).toEqual([]);
    expect(effectiveEntries(input)[0].reason).toBe('shadowed');
  });

  it('exposes the shared roots the UI toggles', () => {
    const settings = { mcpProjectState: { a: { gitnexusGlobal: true }, b: { gitnexusGlobal: false }, c: {} } } as unknown as AppSettings;
    expect(gitnexusSharedRoots(settings)).toEqual(['a']);
  });

  it('knows its own id', () => {
    expect(isBuiltinServerId(GITNEXUS_SERVER_ID)).toBe(true);
    expect(isBuiltinServerId('github')).toBe(false);
  });
});

describe('GitNexus serving (one shared server)', () => {
  const saved = process.env.GITNEXUS_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = saved;
  });

  it('drops the retired serving-mode setting, even one left on disk', () => {
    const setting = (s: unknown) => (normalizeSettings(s as never) as unknown as { gitnexus?: unknown }).gitnexus;
    expect(setting(undefined)).toBeUndefined();
    expect(setting({ gitnexus: { mode: 'per-repo' } })).toBeUndefined();
    expect(setting({ gitnexus: { mode: 'shared' } })).toBeUndefined();
  });

  it('keeps the app-wide switch and drops a user entry claiming the built-in id', () => {
    const s = normalizeSettings({
      mcpDisabledBuiltins: [GITNEXUS_SERVER_ID, '', 5 as never, GITNEXUS_SERVER_ID],
      mcpServers: [{ id: GITNEXUS_SERVER_ID, transport: 'stdio', command: 'npx', args: ['-y', 'gitnexus@latest', 'mcp'] }]
    } as never);
    expect(s.mcpDisabledBuiltins).toEqual([GITNEXUS_SERVER_ID]);
    expect(s.mcpServers).toEqual([]);
  });

  it('injects the scope proxy for an indexed repo, never a per-repo process', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'gn-proj-'));
    const home = await mkdtemp(path.join(tmpdir(), 'gn-home-'));
    const base = await mkdtemp(path.join(tmpdir(), 'gn-base-'));
    dirs.push(project, home, base);
    await writeFile(path.join(home, 'registry.json'), JSON.stringify([entry('proj', project)]), 'utf8');
    process.env.GITNEXUS_HOME = home;

    const proxyPath = path.join(base, 'gitnexus-scope.mjs');
    const settings = { mcpProjectState: {}, mcpServers: [], cua: { enabled: false } } as unknown as AppSettings;
    const out = await resolveForSession(
      { settings, cwd: project, projectRoot: project, harness: 'claude' },
      {
        getSecret: async () => undefined,
        sharedGitnexus: async () => 'http://127.0.0.1:4799/api/mcp',
        gitnexusProxyPath: proxyPath
      }
    );
    expect(out.map((r) => r.def.id)).toEqual([GITNEXUS_SERVER_ID]);
    expect(out[0].def.args).toEqual([proxyPath]);
    expect(out[0].def.env?.VOCS_GITNEXUS_URL).toBe('http://127.0.0.1:4799/api/mcp');
    expect(JSON.parse(out[0].def.env?.VOCS_GITNEXUS_ALLOW ?? '[]')).toEqual([{ name: 'proj', path: project }]);
  });

  it('serves through the proxy even when an older settings file still asked for per-repo', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'gn-proj-'));
    const home = await mkdtemp(path.join(tmpdir(), 'gn-home-'));
    const base = await mkdtemp(path.join(tmpdir(), 'gn-base-'));
    dirs.push(project, home, base);
    await writeFile(path.join(home, 'registry.json'), JSON.stringify([entry('proj', project)]), 'utf8');
    process.env.GITNEXUS_HOME = home;
    const proxyPath = path.join(base, 'gitnexus-scope.mjs');
    const settings = { mcpProjectState: {}, mcpServers: [], cua: { enabled: false }, gitnexus: { mode: 'per-repo' } } as unknown as AppSettings;
    const out = await resolveForSession(
      { settings, cwd: project, projectRoot: project, harness: 'claude' },
      {
        getSecret: async () => undefined,
        sharedGitnexus: async () => 'http://127.0.0.1:4799/api/mcp',
        gitnexusProxyPath: proxyPath
      }
    );
    expect(out.map((r) => r.def.id)).toEqual([GITNEXUS_SERVER_ID]);
    expect(out[0].def.args).toEqual([proxyPath]);
    expect(out[0].def.env?.GITNEXUS_HOME).toBeUndefined();
  });

  it('injects nothing when the shared server is unavailable', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'gn-proj-'));
    const home = await mkdtemp(path.join(tmpdir(), 'gn-home-'));
    dirs.push(project, home);
    await writeFile(path.join(home, 'registry.json'), JSON.stringify([entry('proj', project)]), 'utf8');
    process.env.GITNEXUS_HOME = home;
    const settings = { mcpProjectState: {}, mcpServers: [], cua: { enabled: false } } as unknown as AppSettings;
    const out = await resolveForSession(
      { settings, cwd: project, projectRoot: project, harness: 'claude' },
      { getSecret: async () => undefined, sharedGitnexus: async () => null, gitnexusProxyPath: '/tmp/p.mjs' }
    );
    expect(out).toEqual([]);
  });

  it('injects nothing for a repo with no index, even with the server running', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'gn-proj-'));
    const other = await mkdtemp(path.join(tmpdir(), 'gn-other-'));
    const home = await mkdtemp(path.join(tmpdir(), 'gn-home-'));
    dirs.push(project, other, home);
    await writeFile(path.join(home, 'registry.json'), JSON.stringify([entry('other', other)]), 'utf8');
    process.env.GITNEXUS_HOME = home;
    const settings = { mcpProjectState: {}, mcpServers: [], cua: { enabled: false } } as unknown as AppSettings;
    const out = await resolveForSession(
      { settings, cwd: project, projectRoot: project, harness: 'claude' },
      {
        getSecret: async () => undefined,
        sharedGitnexus: async () => 'http://127.0.0.1:4799/api/mcp',
        gitnexusProxyPath: '/tmp/p.mjs'
      }
    );
    expect(out).toEqual([]);
  });

  it('keeps a repo out of the shared server when its switch is off', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'gn-proj-'));
    const home = await mkdtemp(path.join(tmpdir(), 'gn-home-'));
    dirs.push(project, home);
    await writeFile(path.join(home, 'registry.json'), JSON.stringify([entry('proj', project)]), 'utf8');
    process.env.GITNEXUS_HOME = home;
    const settings = {
      mcpProjectState: { [project]: { disabledBuiltin: [GITNEXUS_SERVER_ID] } },
      mcpServers: [],
      cua: { enabled: false }
    } as unknown as AppSettings;
    const out = await resolveForSession(
      { settings, cwd: project, projectRoot: project, harness: 'claude' },
      {
        getSecret: async () => undefined,
        sharedGitnexus: async () => 'http://127.0.0.1:4799/api/mcp',
        gitnexusProxyPath: '/tmp/p.mjs'
      }
    );
    expect(out).toEqual([]);
    const info = await projectInfo({ settings, cwd: project, projectRoot: project, harness: 'claude' });
    expect(info.builtin[0]).toMatchObject({ enabled: false, indexed: true, shared: false });
    expect(info.effective[0]).toMatchObject({ scope: 'builtin', enabled: false, reason: 'disabled' });
  });

  it('injects nothing anywhere when the MCP page switch is off', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'gn-proj-'));
    const home = await mkdtemp(path.join(tmpdir(), 'gn-home-'));
    dirs.push(project, home);
    await writeFile(path.join(home, 'registry.json'), JSON.stringify([entry('proj', project)]), 'utf8');
    process.env.GITNEXUS_HOME = home;
    const settings = { mcpDisabledBuiltins: [GITNEXUS_SERVER_ID], mcpProjectState: {}, mcpServers: [], cua: { enabled: false } } as unknown as AppSettings;
    const out = await resolveForSession(
      { settings, cwd: project, projectRoot: project, harness: 'claude' },
      {
        getSecret: async () => undefined,
        sharedGitnexus: async () => 'http://127.0.0.1:4799/api/mcp',
        gitnexusProxyPath: '/tmp/p.mjs'
      }
    );
    expect(out).toEqual([]);
    const info = await projectInfo({ settings, cwd: project, projectRoot: project, harness: 'claude' });
    expect(info.builtin[0]).toMatchObject({ enabled: false, disabledGlobally: true, indexed: true });
    expect(info.effective[0]).toMatchObject({ scope: 'builtin', enabled: false, reason: 'disabled' });
  });

  it('hands the switch and the share toggle to the panel', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'gn-proj-'));
    const home = await mkdtemp(path.join(tmpdir(), 'gn-home-'));
    dirs.push(project, home);
    await writeFile(path.join(home, 'registry.json'), JSON.stringify([entry('proj', project)]), 'utf8');
    process.env.GITNEXUS_HOME = home;
    const settings = {
      mcpProjectState: { [project]: { gitnexusGlobal: true } },
      mcpServers: [],
      cua: { enabled: false }
    } as unknown as AppSettings;
    const info = await projectInfo({ settings, cwd: project, projectRoot: project, harness: 'claude' });
    expect(info.builtin[0]).toMatchObject({ enabled: true, indexed: true, shared: true });
    expect(info.effective[0]).toMatchObject({ scope: 'builtin', enabled: true });
  });
});
