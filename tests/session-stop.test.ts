/**
 * Stop, disposal and quit for a session's runtime: a Stop never hangs on a runtime that is slow to
 * shut down or still starting, what a disposing runtime reports is still recorded, and a runtime
 * that has been superseded can no longer touch the session.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { CreateSessionRequest, UserInput } from '../src/shared/types';
import { deferred } from '../src/main/util/async';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));

let root: string;
let store: SessionStore;
let manager: SessionManager;
let settings: ReturnType<typeof defaultSettings>;
let runtimes: ReturnType<typeof scripted>[];
let deps: ReturnType<typeof dependencies>;

function scripted(ctx: HarnessContext) {
  const runtime = {
    ctx,
    adapter: {
      id: 'native', busy: false,
      start: vi.fn<HarnessAdapter['start']>(async () => undefined),
      send: vi.fn(async (_input: UserInput) => { ctx.emit({ type: 'status', status: 'running' }); }),
      interrupt: vi.fn(async () => undefined),
      dispose: vi.fn<HarnessAdapter['dispose']>(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setEffort: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
    } satisfies HarnessAdapter,
    finish: (id = 'turn') => {
      ctx.emit({ type: 'item.upsert', item: { id, kind: 'turn', ts: Date.now(), status: 'completed' } });
      ctx.emit({ type: 'status', status: 'idle' });
    },
  };
  return runtime;
}

function dependencies(sessionStore: SessionStore) {
  return {
    store: sessionStore,
    settings: { get: () => settings, update: vi.fn(async () => settings) } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordUserInputs: vi.fn(), flush: vi.fn(async () => undefined), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn(), recordSubagent: vi.fn() } as unknown as AnalyticsStore,
    getSecret: vi.fn<(_providerId: string) => Promise<string | undefined>>(async () => undefined),
    pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
  };
}

function request(projectRoot = root): CreateSessionRequest {
  return { title: 'Ordinary', config: { harness: 'native', projectRoot, permissionMode: 'full-auto', model: { provider: 'local', model: 'exact-model' } } };
}

const within = <T>(promise: Promise<T>, ms = 2_000) => Promise.race([promise.then(() => 'settled' as const), new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), ms))]);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-session-stop-'));
  store = new SessionStore(root);
  await store.load();
  settings = defaultSettings();
  runtimes = [];
  deps = dependencies(store);
  manager = new SessionManager(deps);
  vi.mocked(createAdapter).mockReset().mockImplementation((_id, ctx) => {
    const runtime = scripted(ctx);
    runtimes.push(runtime);
    return runtime.adapter;
  });
});

afterEach(async () => {
  for (const runtime of runtimes) runtime.adapter.dispose.mockImplementation(async () => undefined);
  await manager.stopAll();
  await manager.flushPendingPersists();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('session stop and disposal', () => {
  it('bounds a Stop whose disposal hangs and keeps the session usable', async () => {
    manager = new SessionManager({ ...deps, disposeWaitMs: 50 });
    const meta = await manager.create(request());
    await manager.send(meta.id, { text: 'Work' }); runtimes[0].finish();
    const hung = deferred<void>(); runtimes[0].adapter.dispose.mockImplementationOnce(() => hung.promise);
    expect(await within(manager.stop(meta.id))).toBe('settled');
    expect(deps.log).toHaveBeenCalledWith('warn', expect.stringContaining('still shutting down'));
    expect(manager.get(meta.id)?.status).toBe('idle');
    expect(manager.activity(meta.id)).toMatchObject({ tearingDown: true, quiescent: false });
    await manager.send(meta.id, { text: 'Next' });
    expect(runtimes[1].adapter.send).toHaveBeenCalledTimes(1);
    runtimes[1].finish();
    hung.resolve();
    await vi.waitFor(() => expect(manager.activity(meta.id)).toMatchObject({ tearingDown: false, quiescent: true }));
  });

  it('does not make Stop wait for a pending startup, and disposes a start that finishes afterwards', async () => {
    const started = deferred<void>();
    vi.mocked(createAdapter).mockImplementationOnce((_id, ctx) => {
      const runtime = scripted(ctx); runtimes.push(runtime);
      runtime.adapter.start.mockImplementation(() => started.promise);
      return runtime.adapter;
    });
    const meta = await manager.create(request());
    const sending = manager.send(meta.id, { text: 'Never sent' });
    const rejected = expect(sending).rejects.toThrow(/stopped/i);
    await vi.waitFor(() => expect(runtimes[0]?.adapter.start).toHaveBeenCalledTimes(1));
    expect(await within(manager.stop(meta.id))).toBe('settled');
    expect(runtimes[0].adapter.dispose).toHaveBeenCalledTimes(1);
    started.resolve();
    await rejected;
    await vi.waitFor(() => expect(runtimes[0].adapter.dispose).toHaveBeenCalledTimes(2));
    expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
    await manager.send(meta.id, { text: 'A fresh runtime' });
    expect(runtimes[1].adapter.send).toHaveBeenCalledTimes(1);
  });

  it('records the turn, usage and history a runtime reports while Stop disposes it, and fences it once superseded', async () => {
    const meta = await manager.create(request());
    await manager.send(meta.id, { text: 'Interrupt me' });
    const old = runtimes[0];
    old.adapter.dispose.mockImplementationOnce(async () => {
      old.ctx.emit({ type: 'item.upsert', item: { id: 'turn_interrupted', kind: 'turn', ts: Date.now(), status: 'interrupted' } });
      old.ctx.emit({ type: 'usage', totals: { ...meta.usage, costUsd: 1.25 } });
      await old.ctx.writeJson('history.json', { persisted: true });
    });
    await manager.stop(meta.id);
    expect((await manager.transcript(meta.id)).some((item) => item.id === 'turn_interrupted')).toBe(true);
    expect(deps.analytics.recordTurn).toHaveBeenCalledWith(expect.objectContaining({ id: meta.id }), expect.objectContaining({ id: 'turn_interrupted' }));
    expect(manager.get(meta.id)?.usage.costUsd).toBe(1.25);
    expect(JSON.parse(await fs.readFile(path.join(store.sessionDir(meta.id), 'history.json'), 'utf8'))).toEqual({ persisted: true });
    await manager.send(meta.id, { text: 'Replacement' });
    old.ctx.emit({ type: 'item.upsert', item: { id: 'turn_late', kind: 'turn', ts: Date.now(), status: 'completed' } });
    old.ctx.updateMeta({ title: 'Late title' });
    await old.ctx.writeJson('late.json', { stale: true });
    expect((await manager.transcript(meta.id)).some((item) => item.id === 'turn_late')).toBe(false);
    expect(manager.get(meta.id)?.title).toBe('Ordinary');
    expect(await fs.stat(path.join(store.sessionDir(meta.id), 'late.json')).catch(() => null)).toBeNull();
  });

  it('reads the live permission mode while a runtime is being disposed', async () => {
    const meta = await manager.create(request());
    await manager.send(meta.id, { text: 'Work' });
    await manager.setPermissionMode(meta.id, 'plan');
    const seen: string[] = [];
    runtimes[0].adapter.dispose.mockImplementationOnce(async () => { seen.push(runtimes[0].ctx.permissionMode(), runtimes[0].ctx.session().config.permissionMode); });
    await manager.stop(meta.id);
    expect(seen).toEqual(['plan', 'plan']);
  });

  it('never rejects stopAll at quit, so persistence can still be flushed', async () => {
    const first = await manager.create(request());
    const second = await manager.create(request());
    await manager.send(first.id, { text: 'Work' });
    await manager.send(second.id, { text: 'Work' });
    runtimes[0].adapter.dispose.mockRejectedValueOnce(new Error('first dispose failed'));
    runtimes[1].adapter.dispose.mockRejectedValueOnce(new Error('second dispose failed'));
    await expect(manager.stopAll()).resolves.toBeUndefined();
    expect(runtimes[0].adapter.dispose).toHaveBeenCalledTimes(1);
    expect(runtimes[1].adapter.dispose).toHaveBeenCalledTimes(1);
    await expect(manager.flushPendingPersists()).resolves.toBeUndefined();
  });
});
