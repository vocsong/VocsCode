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

function chat(projectRoot: string, source: 'claude' | 'codex' = 'claude'): ParsedChatImport {
  return {
    candidate: { id: `${source}_external`, source, sourceSessionId: 'external-id', title: 'Imported question', projectRoot, createdAt: 1000, updatedAt: 2000, messageCount: 2 },
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
