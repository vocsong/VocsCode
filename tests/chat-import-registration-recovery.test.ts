import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandlerRegistry, type HandlerDeps, type HandlerRegistry } from '../src/main/handlers';
import { SessionManager, type SessionManagerDeps } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { SettingsStore } from '../src/main/settings';
import { emptyUsage } from '../src/main/models/static-models';
import { PUSH_CHANNELS } from '../src/shared/ipc';
import type { ChatImportPreview } from '../src/shared/chat-import';
import type { SessionMeta } from '../src/shared/types';

const dirs: string[] = [];
const registries = new Set<HandlerRegistry>();
const sourceSessionId = 'registration-recovery-source';
const start = '2026-06-01T12:00:00.000Z';
const finish = '2026-06-01T12:00:02.000Z';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all([...registries].map((registry) => registry.shutdown()));
  registries.clear();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function openApp(dir: string) {
  const store = new SessionStore(dir);
  await store.load();
  const settings = new SettingsStore(dir);
  await settings.load();
  const pushes: [string, unknown][] = [];
  const push = (channel: string, payload: unknown) => { pushes.push([channel, payload]); };
  const log = vi.fn();
  const runtime = { resolve: () => null } as unknown as SessionManagerDeps['runtime'];
  const analytics = {} as SessionManagerDeps['analytics'];
  const manager = new SessionManager({
    store, settings, runtime, analytics, getSecret: async () => undefined,
    pushEvent: vi.fn(), pushSessions: (sessions) => push(PUSH_CHANNELS.sessionsChanged, sessions),
    notify: vi.fn(), log
  });
  const registry = createHandlerRegistry({
    settings, sessions: manager, runtime, analytics, log, push,
    secrets: {} as HandlerDeps['secrets'],
    terminals: { list: () => [] } as unknown as HandlerDeps['terminals'],
    search: {} as HandlerDeps['search'],
    desktop: { userDataPath: () => dir } as HandlerDeps['desktop']
  });
  registries.add(registry);
  return { store, settings, manager, registry, pushes };
}

type App = Awaited<ReturnType<typeof openApp>>;

async function closeApp(app: App) {
  await app.registry.shutdown();
  registries.delete(app.registry);
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-chat-registration-'));
  dirs.push(dir);
  const userData = path.join(dir, 'user-data');
  const claudeDir = path.join(dir, 'claude-config');
  const root = path.join(dir, 'original-project');
  const sourceFile = path.join(claudeDir, 'projects', 'encoded-project', 'session.jsonl');
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await writeSource(sourceFile, root);
  const app = await openApp(userData);
  // Establish durable settings so a read-only rescan can be checked byte-for-byte.
  await app.settings.update({ folders: [], recentProjects: [] });
  return { app, userData, root, sourceFile };
}

async function writeSource(filename: string, root: string) {
  const records = [
    { type: 'user', uuid: 'question', parentUuid: null, sessionId: sourceSessionId, cwd: root, timestamp: start, message: { role: 'user', content: 'Preserve the original question' } },
    { type: 'assistant', uuid: 'answer', parentUuid: 'question', sessionId: sourceSessionId, cwd: root, timestamp: finish, message: { role: 'assistant', content: 'Preserve the historical answer', model: 'claude-fixture' } }
  ];
  await fs.writeFile(filename, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

async function preview(app: App): Promise<ChatImportPreview> {
  return await app.registry.invoke('sessions:importList', { source: 'claude' }) as ChatImportPreview;
}

function failSettingsWrite(userData: string) {
  const rename = fs.rename.bind(fs);
  return vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === path.join(userData, 'settings.json')) {
      throw Object.assign(new Error('registration settings write failed'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  });
}

async function sessionBytes(userData: string, id: string) {
  return {
    index: await fs.readFile(path.join(userData, 'sessions.json')),
    transcript: await fs.readFile(path.join(userData, 'sessions', id, 'transcript.jsonl')),
    context: await fs.readFile(path.join(userData, 'sessions', id, 'fork-context.md'))
  };
}

async function expectReadOnlyPreview(app: App, userData: string, id: string, root: string, pending: boolean) {
  const settingsBefore = structuredClone(app.settings.get());
  const settingsBytes = await fs.readFile(path.join(userData, 'settings.json'));
  app.pushes.length = 0;
  const writes = vi.spyOn(fs, 'rename');
  const result = await preview(app);
  expect(writes).not.toHaveBeenCalled();
  writes.mockRestore();
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({ id, imported: true });
  if (pending) expect(result.candidates[0]!.projectRoot).toBe(root);
  expect(result.candidates[0]!.registrationPending ?? false).toBe(pending);
  expect(app.settings.get()).toEqual(settingsBefore);
  expect(await fs.readFile(path.join(userData, 'settings.json'))).toEqual(settingsBytes);
  expect(app.pushes).toEqual([]);
}

function settingsPushes(app: App) {
  return app.pushes.filter(([channel]) => channel === PUSH_CHANNELS.settingsChanged);
}

describe('registered chat-import project recovery', () => {
  it('survives failed import registration and failed repair across restarts without rewriting the committed chat', async () => {
    const { app, userData, root, sourceFile } = await setup();
    const initial = await preview(app);
    expect(initial.candidates).toHaveLength(1);
    const candidate = initial.candidates[0]!;
    expect(candidate).toMatchObject({ source: 'claude', sourceSessionId, projectRoot: root, imported: false, messageCount: 2 });
    const request = { source: 'claude', ids: [candidate.id] };
    const failure = failSettingsWrite(userData);
    await expect(app.registry.invoke('sessions:import', request)).rejects.toThrow('registration settings write failed');
    failure.mockRestore();

    expect(app.store.list()).toHaveLength(1);
    const original = structuredClone(app.store.list()[0]!);
    expect(original).toMatchObject({ importedFrom: { source: 'claude', sessionId: sourceSessionId }, config: { projectRoot: root }, harnessRef: {}, usage: emptyUsage(), pendingForkContext: true });
    const originalItems = await app.store.readTranscript(original.id);
    expect(originalItems).toMatchObject([
      { kind: 'user', text: 'Preserve the original question', ts: Date.parse(start) },
      { kind: 'assistant', text: 'Preserve the historical answer', ts: Date.parse(finish), model: 'claude-fixture' }
    ]);
    expect(originalItems).toHaveLength(2);
    expect(await app.store.readBlob(original.id, 'fork-context.md')).toContain('Preserve the historical answer');
    const bytes = await sessionBytes(userData, original.id);
    expect(app.settings.get().folders).not.toContain(root);
    expect(settingsPushes(app)).toEqual([[PUSH_CHANNELS.settingsChanged, app.settings.get()]]);
    await closeApp(app);

    // The source may move or grow after import; repair must use the committed project root.
    const changedSourceRoot = path.join(path.dirname(root), 'changed-source-project');
    await writeSource(sourceFile, changedSourceRoot);
    const sourceBytes = await fs.readFile(sourceFile);
    const reopened = await openApp(userData);
    expect(reopened.store.list()).toEqual([original]);
    await expectReadOnlyPreview(reopened, userData, candidate.id, root, true);
    const repair = { ...request, repairOnly: true };
    const repairFailure = failSettingsWrite(userData);
    await expect(reopened.registry.invoke('sessions:import', repair)).rejects.toThrow('registration settings write failed');
    repairFailure.mockRestore();
    expect(reopened.store.list()).toEqual([original]);
    expect(await sessionBytes(userData, original.id)).toEqual(bytes);
    expect(reopened.settings.get().folders).not.toContain(root);
    expect(reopened.settings.get().folders).not.toContain(changedSourceRoot);
    expect(await fs.readFile(sourceFile)).toEqual(sourceBytes);
    expect(settingsPushes(reopened)).toEqual([[PUSH_CHANNELS.settingsChanged, reopened.settings.get()]]);
    await closeApp(reopened);

    const retry = await openApp(userData);
    await expectReadOnlyPreview(retry, userData, candidate.id, root, true);
    await expect(retry.registry.invoke('sessions:import', repair)).resolves.toEqual({ imported: [], skipped: 1 });
    expect(retry.store.list()).toEqual([original]);
    expect(await retry.store.readTranscript(original.id)).toEqual(originalItems);
    expect(await sessionBytes(userData, original.id)).toEqual(bytes);
    expect(await fs.readdir(path.join(userData, 'sessions'))).toEqual([original.id]);
    expect(retry.settings.get().folders).toEqual([root]);
    expect(retry.settings.get().recentProjects).toEqual([root]);
    expect(await fs.readFile(sourceFile)).toEqual(sourceBytes);
    expect(settingsPushes(retry)).toEqual([[PUSH_CHANNELS.settingsChanged, retry.settings.get()]]);
    await expectReadOnlyPreview(retry, userData, candidate.id, root, false);
    await closeApp(retry);

    const durable = await openApp(userData);
    expect(durable.store.list()).toEqual([original]);
    expect(durable.settings.get().folders).toEqual([root]);
    expect(durable.settings.get().recentProjects).toEqual([root]);
    expect(await sessionBytes(userData, original.id)).toEqual(bytes);
    await expectReadOnlyPreview(durable, userData, candidate.id, root, false);
  });

  it('refuses a stale repair after the committed chat was removed, even while its source remains importable', async () => {
    const { app, userData, root } = await setup();
    const candidate = (await preview(app)).candidates[0]!;
    const failure = failSettingsWrite(userData);
    await expect(app.registry.invoke('sessions:import', { source: 'claude', ids: [candidate.id] })).rejects.toThrow('registration settings write failed');
    failure.mockRestore();
    expect(app.store.list()).toHaveLength(1);
    await closeApp(app);

    const reopened = await openApp(userData);
    await expectReadOnlyPreview(reopened, userData, candidate.id, root, true);
    await reopened.store.remove(reopened.store.list()[0]!.id);
    expect(reopened.store.list()).toEqual([]);
    expect(await fs.readdir(path.join(userData, 'sessions'))).toEqual([]);
    const settingsBefore = structuredClone(reopened.settings.get());
    const settingsBytes = await fs.readFile(path.join(userData, 'settings.json'));
    await expect(reopened.registry.invoke('sessions:import', { source: 'claude', ids: [candidate.id], repairOnly: true })).rejects.toThrow(/no longer[\s\S]*Scan again/i);
    expect(reopened.store.list()).toEqual([]);
    expect(await fs.readdir(path.join(userData, 'sessions'))).toEqual([]);
    expect(reopened.settings.get()).toEqual(settingsBefore);
    expect(reopened.settings.get().folders).not.toContain(root);
    expect(await fs.readFile(path.join(userData, 'settings.json'))).toEqual(settingsBytes);
    expect(settingsPushes(reopened)).toEqual([[PUSH_CHANNELS.settingsChanged, reopened.settings.get()]]);
    expect((await preview(reopened)).candidates).toEqual([expect.objectContaining({ id: candidate.id, imported: false })]);
    await closeApp(reopened);

    const durable = await openApp(userData);
    expect(durable.store.list()).toEqual([]);
    expect(await fs.readdir(path.join(userData, 'sessions'))).toEqual([]);
    expect(durable.settings.get().folders).not.toContain(root);
  });

  it('repairs native provider-reference registration at the stored root without changing usage, provenance or session bytes', async () => {
    const { app, userData, root } = await setup();
    const candidate = (await preview(app)).candidates[0]!;
    const storedRoot = path.join(path.dirname(root), 'native-conversation-project');
    const original: SessionMeta = {
      id: 'ordinary-claude', title: 'Existing Vocs conversation', createdAt: 1, updatedAt: 2,
      config: { harness: 'claude', projectRoot: storedRoot, permissionMode: 'ask' }, cwd: storedRoot,
      status: 'idle', queued: 0, harnessRef: { claudeSessionId: sourceSessionId },
      usage: { ...emptyUsage(), inputTokens: 123, outputTokens: 45, turns: 2, costUsd: 1.25 }
    };
    await app.store.importSession(original, [{ id: 'native-user', kind: 'user', ts: 1, text: 'Do not replace the native conversation' }], 'Keep the existing continuation context.');
    const bytes = await sessionBytes(userData, original.id);
    await closeApp(app);

    const reopened = await openApp(userData);
    await expectReadOnlyPreview(reopened, userData, candidate.id, storedRoot, true);
    await expect(reopened.registry.invoke('sessions:import', { source: 'claude', ids: [candidate.id], repairOnly: true })).resolves.toEqual({ imported: [], skipped: 1 });
    expect(reopened.store.list()).toEqual([original]);
    expect(await sessionBytes(userData, original.id)).toEqual(bytes);
    expect(await fs.readdir(path.join(userData, 'sessions'))).toEqual([original.id]);
    expect(reopened.settings.get().folders).toEqual([storedRoot]);
    expect(reopened.settings.get().recentProjects).toEqual([storedRoot]);
    expect(settingsPushes(reopened)).toEqual([[PUSH_CHANNELS.settingsChanged, reopened.settings.get()]]);
    await expectReadOnlyPreview(reopened, userData, candidate.id, storedRoot, false);
    await closeApp(reopened);

    const durable = await openApp(userData);
    expect(durable.store.list()).toEqual([original]);
    expect(durable.settings.get().folders).toEqual([storedRoot]);
    expect(await sessionBytes(userData, original.id)).toEqual(bytes);
  });
});
