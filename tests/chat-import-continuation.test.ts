import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../src/main/store';
import { SettingsStore } from '../src/main/settings';
import { SessionManager, type SessionManagerDeps } from '../src/main/session-manager';
import type { HarnessContext } from '../src/main/harness/types';
import type { UserInput } from '../src/shared/types';

const runtime = vi.hoisted(() => ({ sent: [] as UserInput[], disposed: 0 }));
vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (_id: string, ctx: HarnessContext) => ({
    id: 'claude', busy: false,
    start: async () => undefined,
    send: async (input: UserInput) => {
      runtime.sent.push(input);
      const id = `answer-${runtime.sent.length}`;
      ctx.emit({ type: 'status', status: 'running' });
      ctx.emit({ type: 'item.upsert', item: { id, kind: 'assistant', ts: Date.now(), text: '', streaming: true } });
      ctx.emit({ type: 'item.delta', id, textDelta: 'Scripted answer' });
      ctx.emit({ type: 'item.upsert', item: { id, kind: 'assistant', ts: Date.now(), text: 'Scripted answer', streaming: false } });
      ctx.emit({ type: 'item.upsert', item: { id: `${id}-turn`, kind: 'turn', ts: Date.now(), status: 'completed' } });
      ctx.emit({ type: 'status', status: 'idle' });
    },
    interrupt: async () => undefined,
    setModel: async () => undefined, setEffort: async () => undefined, setPermissionMode: async () => undefined,
    dispose: async () => { runtime.disposed++; }
  })
}));

const managers: SessionManager[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.stopAll();
    await manager.flushPendingPersists();
  }
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  runtime.sent.length = 0;
  runtime.disposed = 0;
});

async function open(dir: string) {
  const store = new SessionStore(dir);
  await store.load();
  const settings = new SettingsStore(dir);
  await settings.load();
  const deps = {
    store, settings, runtime: {}, getSecret: async () => undefined,
    analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() },
    pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn()
  } as unknown as SessionManagerDeps;
  const manager = new SessionManager(deps);
  managers.push(manager);
  return { store, manager };
}

describe('imported conversation continuation', () => {
  it.each([false, true])('carries history once across restart, including a fresh fork (%s), then streams and tears down normally', async (fork) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-import-continue-'));
    dirs.push(dir);
    const first = await open(dir);
    const { imported } = await first.manager.importChats([{
      candidate: { id: 'claude-source', source: 'claude', sourceSessionId: 'external', title: 'Imported question', projectRoot: dir, createdAt: 1, updatedAt: 2, messageCount: 2 },
      items: [{ id: 'old-user', kind: 'user', ts: 1, text: 'Historical question' }, { id: 'old-assistant', kind: 'assistant', ts: 2, text: 'Historical answer' }]
    }]);
    const { store, manager } = await open(dir);
    const session = fork ? (await manager.fork(imported[0]!.id))! : store.get(imported[0]!.id)!;
    if (fork) expect(session.importedFrom).toBeUndefined();
    await manager.send(session.id, { text: 'Continue now' });
    expect(runtime.sent).toHaveLength(1);
    expect(runtime.sent[0]!.text).toContain('Historical question');
    expect(runtime.sent[0]!.text).toContain('Historical answer');
    expect(runtime.sent[0]!.text.endsWith('Continue now')).toBe(true);
    expect(manager.get(session.id)!.pendingForkContext).toBeUndefined();
    await manager.send(session.id, { text: 'Next question' });
    expect(runtime.sent).toHaveLength(2);
    expect(runtime.sent[1]!.text).toBe('Next question');
    await manager.stop(session.id);
    await manager.flushPendingPersists();
    expect(runtime.disposed).toBe(1);
    expect(manager.get(session.id)!.status).toBe('idle');
    const items = await store.readTranscript(session.id);
    expect(items.filter((item) => item.kind === 'turn')).toHaveLength(2);
    expect(items.filter((item) => item.kind === 'assistant' && item.text === 'Scripted answer')).toHaveLength(2);
    expect(items.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual(['Historical question', 'Continue now', 'Next question']);
    const restarted = await open(dir);
    expect(await restarted.store.readTranscript(session.id)).toEqual(items);
    expect(restarted.store.get(session.id)!.pendingForkContext).toBeUndefined();
  });
});
