/**
 * The Processes panel attributes a harness's processes to its session without any adapter knowing
 * about it: the session manager runs every adapter call as the session. A scripted adapter driven
 * through the real SessionManager and SessionStore shows that what it starts on start, on send, on
 * a failed send and on teardown is reported as the session's; that wrapping it changes nothing about
 * streaming, stop or restart; and that a second session's processes are its own.
 */
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { observeOwnedSpawns } from '../src/main/process-context';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { ProcessOwner } from '../src/shared/processes';
import type { SessionEvent, SessionMeta, UserInput } from '../src/shared/types';

const script = vi.hoisted(() => ({
  started: [] as { label: string; pid: number }[],
  adapters: 0,
  disposed: 0,
  failSend: false
}));

async function run(label: string): Promise<void> {
  // Like an SDK: the spawn happens a few async hops away from the call that caused it.
  await new Promise((r) => setTimeout(r, 1));
  const child = spawn(process.execPath, ['-e', '', label], { stdio: 'ignore' });
  await new Promise((r) => child.once('exit', r));
  if (child.pid) script.started.push({ label, pid: child.pid });
}

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (_id: string, ctx: { sessionId: string; emit: (event: SessionEvent) => void }) => {
    script.adapters++;
    let busy = false;
    return {
      id: 'native',
      get busy() {
        return busy;
      },
      start: async () => {
        await run(`${ctx.sessionId}:cli`);
        ctx.emit({ type: 'status', status: 'idle' });
      },
      send: async (input: UserInput) => {
        busy = true;
        ctx.emit({ type: 'status', status: 'running' });
        await run(`${ctx.sessionId}:tool`);
        if (script.failSend) {
          busy = false;
          throw new Error('tool crashed');
        }
        ctx.emit({ type: 'item.upsert', item: { id: `a_${script.started.length}`, kind: 'assistant', ts: Date.now(), text: `ran ${input.text}` } });
        busy = false;
        ctx.emit({ type: 'status', status: 'idle' });
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setEffort: async () => undefined,
      setPermissionMode: async () => undefined,
      dispose: async () => {
        script.disposed++;
        // Teardown spawns too (taskkill on Windows); that is still the session's work.
        await run(`${ctx.sessionId}:teardown`);
      }
    };
  }
}));

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };
let dir: string;
let stop: (() => void) | null = null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-session-owner-'));
  script.started = [];
  script.adapters = 0;
  script.disposed = 0;
  script.failSend = false;
});

afterEach(async () => {
  stop?.();
  stop = null;
  await fs.rm(dir, { recursive: true, force: true });
});

function meta(id: string): SessionMeta {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    cwd: dir,
    config: { harness: 'native', projectRoot: dir, permissionMode: 'ask' },
    harnessRef: { nativeHistory: true },
    status: 'idle',
    usage: { ...ZERO },
    queued: 0
  };
}

async function fixture(ids: string[]) {
  const store = new SessionStore(dir);
  await store.load();
  for (const id of ids) await store.upsert(meta(id));
  const manager = new SessionManager({
    store,
    settings: { get: () => defaultSettings() } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: vi.fn()
  });
  return { store, manager };
}

describe('session process ownership', () => {
  it('reports what a harness starts across its lifecycle as its session\'s, without changing the lifecycle', async () => {
    const reported: [number, ProcessOwner][] = [];
    stop = observeOwnedSpawns((pid, owner) => reported.push([pid, owner]));
    const { store, manager } = await fixture(['s_a', 's_b']);

    // Start and a streamed turn.
    await manager.send('s_a', { text: 'npm run dev' });
    await expect.poll(() => script.started.length).toBe(2);
    await manager.flushPendingPersists();
    expect((await store.readTranscript('s_a')).some((item) => item.kind === 'assistant' && item.text === 'ran npm run dev')).toBe(true);
    expect(manager.get('s_a')?.status).not.toBe('error');

    // A send that fails still owns what it started before failing.
    script.failSend = true;
    await manager.send('s_a', { text: 'npm run update' }).catch(() => undefined);
    await expect.poll(() => script.started.length).toBe(3);
    script.failSend = false;

    // Stop tears the real adapter down through the wrapper; its teardown work is the session's too.
    await manager.stop('s_a');
    await expect.poll(() => script.disposed).toBe(1);
    await expect.poll(() => script.started.length).toBe(4);

    // Restart: the next send starts a fresh runtime, still the session's.
    await manager.send('s_a', { text: 'again' });
    await expect.poll(() => script.started.length).toBe(6);
    expect(script.adapters).toBe(2);

    // Another session's harness is its own.
    await manager.send('s_b', { text: 'batch job' });
    await expect.poll(() => script.started.length).toBe(8);

    expect(script.started.map((s) => s.label)).toEqual(['s_a:cli', 's_a:tool', 's_a:tool', 's_a:teardown', 's_a:cli', 's_a:tool', 's_b:cli', 's_b:tool']);
    const ownerOf = new Map(reported.map(([pid, owner]) => [pid, owner]));
    for (const { label, pid } of script.started) expect(ownerOf.get(pid), label).toEqual({ sessionId: label.split(':')[0] });
    expect(reported).toHaveLength(script.started.length);
  });
});
