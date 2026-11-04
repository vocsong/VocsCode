import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../src/main/store';
import { SettingsStore } from '../src/main/settings';
import { SessionManager, type SessionManagerDeps } from '../src/main/session-manager';
import { emptyUsage } from '../src/main/models/static-models';
import type { ParsedChatImport } from '../src/main/chat-import';
import type { SessionMeta } from '../src/shared/types';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-chat-import-'));
  dirs.push(dir);
  const store = new SessionStore(dir);
  await store.load();
  const settings = new SettingsStore(dir);
  await settings.load();
  const pushSessions = vi.fn();
  const deps = {
    store, settings, pushSessions, pushEvent: vi.fn(), notify: vi.fn(), log: vi.fn(),
    runtime: {}, analytics: {}, getSecret: async () => undefined
  } as unknown as SessionManagerDeps;
  return { dir, store, settings, manager: new SessionManager(deps), pushSessions };
}

function chat(projectRoot: string, source: 'claude' | 'codex' = 'claude', sourceSessionId = 'external-id'): ParsedChatImport {
  return {
    candidate: { id: `${source}_${sourceSessionId}`, source, sourceSessionId, title: 'Imported question', projectRoot, createdAt: 1000, updatedAt: 2000, messageCount: 2 },
    items: [{ id: 'user', kind: 'user', text: 'Imported question', ts: 1000 }, { id: 'assistant', kind: 'assistant', text: 'Historical answer', ts: 2000 }]
  };
}

describe('chat import persistence', () => {
  it('restores complete transcripts, project folders and provenance after restart without owning the source session', async () => {
    const { dir, store, settings, manager, pushSessions } = await setup();
    const input = chat(path.join(dir, 'original-project'));
    const { imported } = await manager.importChats([input]);
    expect(imported).toHaveLength(1);
    const meta = imported[0]!;
    expect(meta).toMatchObject({ title: 'Imported question', createdAt: 1000, updatedAt: 2000, status: 'idle', importedFrom: { source: 'claude', sessionId: 'external-id' }, config: { permissionMode: 'ask', useWorktree: false }, harnessRef: {}, pendingForkContext: true });
    expect(meta.worktreeBranch).toBeUndefined();
    expect(meta.usage.costUsd).toBe(0);
    expect(meta.usage.turns).toBe(0);
    expect(settings.get().folders).toContain(input.candidate.projectRoot);
    expect(pushSessions).toHaveBeenCalledTimes(1);
    expect(await store.readBlob(meta.id, 'fork-context.md')).toContain('Historical answer');
    const restarted = new SessionStore(dir);
    await restarted.load();
    expect(restarted.get(meta.id)).toEqual({ ...JSON.parse(JSON.stringify(meta)), queued: 0 });
    expect(await restarted.readTranscript(meta.id)).toEqual(input.items);
    expect(await manager.importChats([input])).toEqual({ imported: [], skipped: 1 });
  });

  it('serializes concurrent imports and treats the two providers as separate identities', async () => {
    const { dir, store, manager } = await setup();
    const input = chat(dir);
    const results = await Promise.all([manager.importChats([input, input]), manager.importChats([input])]);
    expect(results.map((result) => result.imported.length)).toEqual([1, 0]);
    expect(results.map((result) => result.skipped)).toEqual([1, 1]);
    await manager.importChats([chat(dir, 'codex')]);
    expect(store.list()).toHaveLength(2);
  });

  it.each([
    { harness: 'claude', source: 'claude', harnessRef: { claudeSessionId: 'external-id' } },
    { harness: 'codex', source: 'codex', harnessRef: { codexThreadId: 'external-id' } },
    { harness: 'codex-exec', source: 'codex', harnessRef: { codexThreadId: 'external-id' } },
  ] as const)('does not clone a provider conversation already represented by a $harness session', async ({ harness, source, harnessRef }) => {
    const { dir, store, settings, manager } = await setup();
    const ordinary: SessionMeta = {
      id: 'ordinary-session', title: 'Existing conversation', createdAt: 1, updatedAt: 2,
      config: { harness, projectRoot: dir, permissionMode: 'ask' }, cwd: dir,
      status: 'idle', harnessRef, usage: { ...emptyUsage(), costUsd: 1.25 }, queued: 0
    };
    await store.upsert(ordinary);
    const previous = [{ id: 'original-user', kind: 'user' as const, ts: 1, text: 'Original Vocs conversation' }];
    await store.rewriteTranscript(ordinary.id, previous);
    expect(await manager.importChats([chat(dir, source)])).toEqual({ imported: [], skipped: 1 });
    expect(store.list()).toEqual([ordinary]);
    expect(await store.readTranscript(ordinary.id)).toEqual(previous);
    expect(await store.readBlob(ordinary.id, 'fork-context.md')).toBeNull();
    expect(settings.get().folders).toContain(dir);
    const restarted = new SessionStore(dir);
    await restarted.load();
    expect(restarted.list()).toHaveLength(1);
    expect(restarted.get(ordinary.id)!.usage.costUsd).toBe(1.25);
  });

  it('does not confuse the same provider identifier across Claude and Codex', async () => {
    const { dir, store, manager } = await setup();
    await store.upsert({ id: 'ordinary-claude', title: 'Claude original', createdAt: 1, updatedAt: 2,
      config: { harness: 'claude', projectRoot: dir, permissionMode: 'ask' }, cwd: dir,
      status: 'idle', harnessRef: { claudeSessionId: 'external-id' }, usage: emptyUsage() });
    expect((await manager.importChats([chat(dir, 'codex')])).imported).toHaveLength(1);
    expect(store.list()).toHaveLength(2);
  });

  it('registers committed project folders even when a later selected chat fails', async () => {
    const { dir, store, settings, manager, pushSessions } = await setup();
    const one = chat(path.join(dir, 'first-project'), 'claude', 'first');
    const two = chat(path.join(dir, 'second-project'), 'claude', 'second');
    const rename = fs.rename.bind(fs);
    let writes = 0;
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('transcript.jsonl') && ++writes === 2) throw Object.assign(new Error('second import failed'), { code: 'ENOSPC' });
      return rename(from, to);
    });
    await expect(manager.importChats([one, two])).rejects.toThrow('second import failed');
    failure.mockRestore();
    expect(store.list()).toHaveLength(1);
    expect(settings.get().folders).toContain(one.candidate.projectRoot);
    expect(settings.get().folders).not.toContain(two.candidate.projectRoot);
    expect(pushSessions).toHaveBeenCalledTimes(1);
    expect(await manager.importChats([one, two])).toMatchObject({ skipped: 1, imported: [expect.objectContaining({ importedFrom: { source: 'claude', sessionId: 'second' } })] });
    expect(store.list()).toHaveLength(2);
    expect(settings.get().folders).toEqual(expect.arrayContaining([one.candidate.projectRoot, two.candidate.projectRoot]));
    const restarted = new SettingsStore(dir);
    await restarted.load();
    expect(restarted.get().folders).toEqual(settings.get().folders);
  });

  it('repairs project registration on a deduplicated retry after a settings write failed', async () => {
    const { dir, store, settings, manager } = await setup();
    const input = chat(path.join(dir, 'unregistered-project'));
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('settings.json')) throw Object.assign(new Error('settings write failed'), { code: 'ENOSPC' });
      return rename(from, to);
    });
    await expect(manager.importChats([input])).rejects.toThrow('settings write failed');
    failure.mockRestore();
    expect(store.list()).toHaveLength(1);
    expect(settings.get().folders).not.toContain(input.candidate.projectRoot);
    expect(await manager.importChats([input])).toEqual({ imported: [], skipped: 1 });
    expect(store.list()).toHaveLength(1);
    expect(settings.get().folders).toContain(input.candidate.projectRoot);
    expect(settings.get().recentProjects).toContain(input.candidate.projectRoot);
    const imported = store.list()[0]!;
    await manager.patch(imported.id, { archived: true });
    const restartedSettings = new SettingsStore(dir);
    await restartedSettings.load();
    expect(restartedSettings.get().folders).toContain(input.candidate.projectRoot);
    const restartedStore = new SessionStore(dir);
    await restartedStore.load();
    expect(restartedStore.list()).toHaveLength(1);
    expect(await restartedStore.readTranscript(imported.id)).toEqual(input.items);
  });

  it('preserves the import error when both a later chat and project registration fail, and repairs on retry', async () => {
    const { dir, store, settings, manager } = await setup();
    const one = chat(path.join(dir, 'first-project'), 'claude', 'first');
    const two = chat(path.join(dir, 'second-project'), 'claude', 'second');
    const rename = fs.rename.bind(fs);
    let writes = 0;
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('transcript.jsonl') && ++writes === 2) throw Object.assign(new Error('original import error'), { code: 'ENOSPC' });
      if (String(to).endsWith('settings.json')) throw Object.assign(new Error('registration error'), { code: 'ENOSPC' });
      return rename(from, to);
    });
    await expect(manager.importChats([one, two])).rejects.toThrow('original import error');
    failure.mockRestore();
    expect(store.list()).toHaveLength(1);
    expect(settings.get().folders).not.toContain(one.candidate.projectRoot);
    expect(await manager.importChats([one])).toEqual({ imported: [], skipped: 1 });
    expect(settings.get().folders).toContain(one.candidate.projectRoot);
    expect(store.list()).toHaveLength(1);
    expect(await store.readTranscript(store.list()[0]!.id)).toEqual(one.items);
  });

  it('does not persist a failed import through a concurrent ordinary session update', async () => {
    const { dir, store, manager, pushSessions } = await setup();
    const ordinary: SessionMeta = {
      id: 'ordinary-session', title: 'Original title', createdAt: 1, updatedAt: 1,
      config: { harness: 'claude', projectRoot: dir, permissionMode: 'ask', useWorktree: false },
      cwd: dir, status: 'idle', harnessRef: {}, usage: emptyUsage(), queued: 0
    };
    await store.upsert(ordinary);
    let signalIndexStarted!: () => void;
    let releaseIndex!: () => void;
    const indexStarted = new Promise<void>((resolve) => { signalIndexStarted = resolve; });
    const indexReleased = new Promise<void>((resolve) => { releaseIndex = resolve; });
    const rename = fs.rename.bind(fs);
    let heldFirstIndexWrite = false;
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('sessions.json') && !heldFirstIndexWrite) {
        heldFirstIndexWrite = true;
        signalIndexStarted();
        await indexReleased;
        throw Object.assign(new Error('injected concurrent index failure'), { code: 'ENOSPC' });
      }
      return rename(from, to);
    });
    const importResult = expect(manager.importChats([chat(dir)])).rejects.toThrow('injected concurrent index failure');
    await indexStarted;
    const updated = { ...ordinary, title: 'Updated during import' };
    const ordinaryWrite = store.upsert(updated);
    releaseIndex();
    await Promise.all([importResult, ordinaryWrite]);
    failure.mockRestore();

    expect(store.list()).toEqual([updated]);
    expect(pushSessions).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(dir, 'sessions'))).toEqual([]);
    const restarted = new SessionStore(dir);
    expect(await restarted.load()).toEqual([updated]);
    expect((await manager.importChats([chat(dir)])).imported).toHaveLength(1);
    expect(store.list()).toHaveLength(2);
  });

  it.each(['transcript', 'index'] as const)('recovers from a failed %s write without a phantom session or duplicate on retry', async (stage) => {
    const { dir, store, manager, pushSessions } = await setup();
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(stage === 'index' ? 'sessions.json' : 'transcript.jsonl')) throw Object.assign(new Error('injected write failure'), { code: 'ENOSPC' });
      return rename(from, to);
    });
    await expect(manager.importChats([chat(dir)])).rejects.toThrow('injected write failure');
    failure.mockRestore();
    expect(store.list()).toEqual([]);
    expect(pushSessions).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(dir, 'sessions'))).toEqual([]);
    const restarted = new SessionStore(dir);
    expect(await restarted.load()).toEqual([]);
    expect((await manager.importChats([chat(dir)])).imported).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });
});
