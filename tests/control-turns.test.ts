import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { SessionManager, type SessionManagerDeps } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings } from '../src/main/settings';
import { emptyUsage } from '../src/main/models/static-models';
import { deferred } from '../src/main/util/async';
import * as persistence from '../src/main/util/fs';
import type { CreateSessionRequest, SessionMeta, UserInput } from '../src/shared/types';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));

interface Scripted {
  ctx: HarnessContext;
  adapter: HarnessAdapter;
  busy: boolean;
  begin(): void;
  finish(status?: 'completed' | 'failed' | 'interrupted', turnId?: string): void;
}
let runtimes: Scripted[];
let script: (runtime: Scripted, input: UserInput) => Promise<void>;
let start: (runtime: Scripted) => Promise<void>;
let writers: 'quiescent' | 'active' | 'unknown' | undefined;
const dirs: string[] = [];
const managers: SessionManager[] = [];

beforeEach(() => {
  vi.mocked(createAdapter).mockClear();
  runtimes = [];
  writers = 'quiescent';
  start = async () => undefined;
  script = async (runtime) => {
    runtime.begin();
    runtime.ctx.emit({ type: 'item.upsert', item: { id: 'answer', kind: 'assistant', ts: 2, text: 'Done' } });
    runtime.finish();
  };
  vi.mocked(createAdapter).mockImplementation((_id, ctx) => {
    const runtime: Scripted = {
      ctx, adapter: undefined as unknown as HarnessAdapter, busy: false,
      begin() { this.busy = true; ctx.emit({ type: 'status', status: 'running' }); },
      finish(status = 'completed', turnId = 'turn') {
        this.busy = false;
        ctx.emit({ type: 'item.upsert', item: { id: turnId, kind: 'turn', ts: 3, status } });
        ctx.emit({ type: 'status', status: 'idle' });
      },
    };
    runtime.adapter = {
      id: 'native', get busy() { return runtime.busy; },
      workspaceWriterState: () => writers,
      start: vi.fn(async () => { await start(runtime); ctx.emit({ type: 'status', status: 'idle' }); }),
      send: vi.fn(async (input) => script(runtime, input)),
      interrupt: vi.fn(async () => runtime.finish('interrupted')),
      dispose: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined), setEffort: vi.fn(async () => undefined), setPermissionMode: vi.fn(async () => undefined),
      compact: vi.fn(async () => undefined),
    };
    runtimes.push(runtime);
    return runtime.adapter;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) { await manager.stopAll(); await manager.flushPendingPersists(); }
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-controlled-'));
  dirs.push(dir);
  const store = new SessionStore(dir);
  await store.load();
  const settings = { ...defaultSettings(), providers: [], autoCompactionThreshold: undefined };
  const deps: SessionManagerDeps = {
    store, settings: { get: () => settings, update: vi.fn(async () => settings) } as never, runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordTurn: vi.fn(), recordUserMessage: vi.fn(), recordSubagent: vi.fn() } as never,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(), disposeWaitMs: 20,
  };
  const manager = new SessionManager(deps);
  managers.push(manager);
  const meta: SessionMeta = {
    id: 'session', title: 'Controlled', createdAt: 1, updatedAt: 1, cwd: dir,
    config: { projectRoot: dir, harness: 'native', permissionMode: 'ask' },
    status: 'idle', harnessRef: {}, usage: emptyUsage(), queued: 0,
  };
  await store.upsert(meta);
  const restart = async () => {
    const restartedStore = new SessionStore(dir);
    await restartedStore.load();
    const restarted = new SessionManager({ ...deps, store: restartedStore });
    managers.push(restarted);
    return { manager: restarted, store: restartedStore };
  };
  return { manager, store, meta, deps, dir, restart };
}

const control = (operationId = 'operation', beforeDispatch: () => Promise<void> = async () => undefined) => ({ operationId, inputId: `input_${operationId}`, beforeDispatch });
const run = (manager: SessionManager, operationId = 'operation', beforeDispatch?: () => Promise<void>) => manager.runControlled('session', { text: 'Do the task' }, control(operationId, beforeDispatch));
const pendingTurn = () => { script = async (runtime) => { runtime.begin(); }; };
const dispatched = async () => { await vi.waitFor(() => expect(runtimes.at(-1)?.adapter.send).toHaveBeenCalledTimes(1)); return runtimes.at(-1)!; };

// These exercise the production manager/store boundary, not a second completion implementation.
describe('exclusive controlled turns', () => {
  it('binds synchronous completion to one stable input and persists the exact reply before returning', async () => {
    const { manager, restart, deps } = await fixture();
    const result = await run(manager);
    expect(result).toEqual({ outcome: 'succeeded', inputId: 'input_operation', runtimeId: expect.stringMatching(/^runtime_/), turnId: 'turn', outputIds: ['answer'] });
    expect(runtimes[0].adapter.send).toHaveBeenCalledWith({ text: 'Do the task', transcriptItemId: 'input_operation' });
    const restored = await restart();
    expect((await restored.manager.transcript('session')).map((item) => [item.id, item.kind])).toEqual([
      ['input_operation', 'user'], ['answer', 'assistant'], ['turn', 'turn'],
    ]);
    expect(restored.store.get('session')).toMatchObject({ status: 'idle', queued: 0 });
    expect(deps.pushEvent).toHaveBeenCalledWith(expect.objectContaining({
      control: { operationId: 'operation', inputId: 'input_operation', runtimeId: result.runtimeId, turnId: 'turn' },
      event: expect.objectContaining({ type: 'item.upsert', item: expect.objectContaining({ kind: 'turn' }) }),
    }));
  });

  it('does not turn send acceptance or idle into completion; settles streamed deltas on the bound terminal', async () => {
    const { manager, restart } = await fixture();
    script = async (runtime) => {
      runtime.begin();
      runtime.ctx.emit({ type: 'item.upsert', item: { id: 'stream', kind: 'assistant', ts: 2, text: '', streaming: true } });
    };
    let resolved = false;
    const result = run(manager).then((value) => { resolved = true; return value; });
    const runtime = await dispatched();
    runtime.ctx.emit({ type: 'item.delta', id: 'stream', textDelta: 'A persistent answer', thinkingDelta: 'Thinking' });
    runtime.ctx.emit({ type: 'status', status: 'idle' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toBe(false);
    runtime.finish();
    expect(await result).toMatchObject({ outcome: 'succeeded', outputIds: ['stream'] });
    expect((await (await restart()).manager.transcript('session')).find((item) => item.id === 'stream'))
      .toEqual({ id: 'stream', kind: 'assistant', ts: 2, text: 'A persistent answer', thinking: 'Thinking', streaming: false });
  });

  it('reserves before the first await and rejects a competing control, human send, queue, steer and unsafe edits', async () => {
    const { manager, meta } = await fixture();
    const ready = deferred<void>();
    start = async () => ready.promise;
    const result = run(manager);
    expect(manager.activity(meta.id)).toMatchObject({ queued: 1, quiescent: false });
    await expect(run(manager, 'competitor')).rejects.toThrow('busy');
    for (const mode of ['now', 'queue', 'steer'] as const) await expect(manager.send(meta.id, { text: 'intrude', mode })).rejects.toThrow('controlled');
    const original = structuredClone(meta.config);
    for (const mutation of [
      () => manager.setModel(meta.id, { provider: 'new', model: 'new' }),
      () => manager.setEffort(meta.id, 'high'), () => manager.setFastMode(meta.id, false),
      () => manager.setPermissionMode(meta.id, 'full-auto'), () => manager.patch(meta.id, { config: { ...original, permissionMode: 'full-auto' } }),
      () => manager.clearTranscript(meta.id), () => manager.editAndResend(meta.id, 'input_operation', { text: 'replace' }),
      () => manager.goal(meta.id, 'set', { objective: 'continue' }), () => manager.compact(meta.id),
      () => manager.setArchived(meta.id, true), () => manager.moveTo(meta.id, meta.cwd), () => manager.delete(meta.id),
      () => manager.subagentCommand(meta.id, 'child', 'steer', 'continue'),
    ]) await expect(mutation()).rejects.toThrow('controlled');
    expect(meta.config).toEqual(original);
    ready.resolve();
    expect(await result).toMatchObject({ outcome: 'succeeded' });
    expect((await manager.transcript(meta.id)).filter((item) => item.kind === 'user')).toHaveLength(1);
  });

  it('rejects control when a human send entered first and is awaiting the preamble', async () => {
    const { manager, meta, deps } = await fixture();
    meta.pendingAppInstructions = true;
    const preamble = deferred<string>();
    deps.appInstructions = () => preamble.promise;
    const human = manager.send(meta.id, { text: 'human' });
    await expect(run(manager)).rejects.toThrow('busy');
    preamble.resolve('Instructions');
    await human;
    expect(runtimes[0].adapter.send).toHaveBeenCalledTimes(1);
    expect((await manager.transcript(meta.id)).filter((item) => item.kind === 'user').map((item) => item.text)).toEqual(['human']);
  });

  it.each(['queued', 'starting', 'awaiting', 'running', 'goal', 'mission', 'uncertain'] as const)('rejects %s sessions before dispatch', async (state) => {
    const { manager, meta } = await fixture();
    if (state === 'queued') meta.queued = 1;
    else if (state === 'goal') meta.goal = { objective: 'ongoing', status: 'active', createdAt: 1, updatedAt: 1, iterations: 0, maxIterations: 2, autoContinue: true };
    else if (state === 'mission') meta.mission = { missionId: 'managed' } as never;
    else if (state === 'uncertain') meta.workspaceWriterClaims = ['unknown_previous_runtime'];
    else meta.status = state;
    const beforeDispatch = vi.fn(async () => undefined);
    await expect(run(manager, 'operation', beforeDispatch)).rejects.toThrow();
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(createAdapter).not.toHaveBeenCalled();
    expect(await manager.transcript(meta.id)).toEqual([]);
  });

  it('waits for compaction/readiness, then rechecks the grant immediately before dispatch', async () => {
    const { manager } = await fixture();
    await manager.send('session', { text: 'human first' });
    const compacted = deferred<void>();
    vi.mocked(runtimes[0].adapter.compact!).mockImplementationOnce(() => compacted.promise);
    const compact = manager.compact('session');
    const beforeDispatch = vi.fn(async () => { expect(runtimes).toHaveLength(2); expect(runtimes[1].adapter.send).not.toHaveBeenCalled(); });
    const result = run(manager, 'operation', beforeDispatch);
    expect(beforeDispatch).not.toHaveBeenCalled();
    compacted.resolve();
    await compact;
    expect(await result).toMatchObject({ outcome: 'succeeded' });
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects activity that starts autonomously while the pre-dispatch hook is awaiting', async () => {
    const { manager } = await fixture();
    const gate = deferred<void>();
    const beforeDispatch = vi.fn(() => gate.promise);
    const result = run(manager, 'operation', beforeDispatch);
    const rejected = expect(result).rejects.toThrow('unproven');
    await vi.waitFor(() => expect(beforeDispatch).toHaveBeenCalledTimes(1));
    runtimes[0].begin();
    gate.resolve();
    await rejected;
    expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
  });

  it('reserves ordinary file preparation before its first filesystem await', async () => {
    const { manager } = await fixture();
    const human = manager.send('session', { text: 'human upload', files: [{ name: 'note.txt', mimeType: 'text/plain', data: Buffer.from('note').toString('base64') }] });
    await expect(run(manager)).rejects.toThrow('busy');
    await human;
    expect(runtimes[0].adapter.send).toHaveBeenCalledTimes(1);
  });

  it('keeps provider history writes following a normalized terminal until send settles', async () => {
    const { manager, store } = await fixture();
    const saved = deferred<void>();
    script = async (runtime) => {
      runtime.begin(); runtime.finish();
      await saved.promise;
      await runtime.ctx.writeJson('provider-history.json', { messages: ['task', 'reply'] });
    };
    let settled = false;
    const result = run(manager).then((value) => { settled = true; return value; });
    await dispatched();
    expect(settled).toBe(false);
    saved.resolve();
    expect(await result).toMatchObject({ outcome: 'succeeded' });
    expect(JSON.parse((await store.readBlob('session', 'provider-history.json'))!)).toEqual({ messages: ['task', 'reply'] });
  });

  it('a rejected grant recheck never sends input and releases admission', async () => {
    const { manager } = await fixture();
    await expect(run(manager, 'operation', async () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
    expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
    expect(await run(manager, 'retry')).toMatchObject({ outcome: 'succeeded' });
  });

  it('interrupts only the exact operation and fences late events before the next ordinary runtime', async () => {
    const { manager } = await fixture();
    pendingTurn();
    const result = run(manager);
    const old = await dispatched();
    await expect(manager.interruptControlled('session', 'different')).rejects.toThrow('no longer active');
    expect(old.adapter.interrupt).not.toHaveBeenCalled();
    await manager.interruptControlled('session', 'operation');
    expect(await result).toMatchObject({ outcome: 'interrupted', turnId: 'turn' });
    await manager.send('session', { text: 'later human' });
    const later = runtimes[1];
    old.ctx.emit({ type: 'item.upsert', item: { id: 'late', kind: 'assistant', ts: 9, text: 'must not land' } });
    old.finish('completed', 'late_turn');
    await expect(manager.interruptControlled('session', 'operation')).rejects.toThrow('no longer active');
    expect(later.adapter.interrupt).not.toHaveBeenCalled();
    expect((await manager.transcript('session')).some((item) => item.id.startsWith('late'))).toBe(false);
    later.finish('completed', 'human_turn');
  });

  it('never binds a retired runtime terminal to a subsequent controlled operation', async () => {
    const { manager } = await fixture();
    const first = await run(manager);
    const old = runtimes[0];
    pendingTurn();
    let settled = false;
    const next = run(manager, 'next').then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(runtimes).toHaveLength(2));
    const current = await dispatched();
    expect(current).not.toBe(old);
    old.finish('completed', 'late_old_turn');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    current.finish('completed', 'next_turn');
    const result = await next;
    expect(result).toMatchObject({ outcome: 'succeeded', inputId: 'input_next', turnId: 'next_turn', outputIds: [] });
    expect(result.runtimeId).not.toBe(first.runtimeId);
    expect((await manager.transcript('session')).filter((item) => item.kind === 'turn').map((item) => item.id)).toEqual(['turn', 'next_turn']);
  });

  it.each(['interrupt', 'stop'] as const)('keeps human %s available during a controlled turn', async (action) => {
    const { manager, restart } = await fixture();
    script = async (runtime) => {
      runtime.begin();
      runtime.ctx.emit({ type: 'item.upsert', item: { id: 'partial', kind: 'assistant', ts: 2, text: 'Partial', streaming: true } });
    };
    const result = run(manager);
    await dispatched();
    await manager[action]('session');
    expect(await result).toMatchObject({ outcome: action === 'interrupt' ? 'interrupted' : 'unknown' });
    expect((await (await restart()).manager.transcript('session')).find((item) => item.id === 'partial')).toMatchObject({ text: 'Partial', streaming: false });
  });

  it('cancels admission while the durable dispatch hook is waiting, with no later send', async () => {
    const { manager } = await fixture();
    const intent = deferred<void>();
    const beforeDispatch = vi.fn(() => intent.promise);
    const result = run(manager, 'operation', beforeDispatch);
    const rejected = expect(result).rejects.toThrow('canceled');
    await vi.waitFor(() => expect(beforeDispatch).toHaveBeenCalledTimes(1));
    await manager.interruptControlled('session', 'operation');
    intent.resolve();
    await rejected;
    expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
  });

  it.each(['untracked', 'unknown', 'child', 'orphan-child', 'untracked-tool', 'missing-start', 'fatal', 'transport'] as const)('returns unknown instead of certifying %s completion', async (reason) => {
    const { manager } = await fixture();
    if (reason === 'untracked') writers = undefined;
    script = async (runtime) => {
      if (reason !== 'missing-start') runtime.begin();
      if (reason === 'unknown') writers = 'unknown';
      if (reason === 'child') runtime.ctx.emit({ type: 'subagent.run', run: { runId: 'child', agent: 'worker', description: 'running', mode: 'background', status: 'running', startedAt: 1 } });
      if (reason === 'orphan-child') runtime.ctx.emit({ type: 'subagent.run', run: { runId: 'child', agent: 'worker', description: 'unknown start', mode: 'background', status: 'completed', startedAt: 1 } });
      if (reason === 'untracked-tool') runtime.ctx.emit({ type: 'item.upsert', item: { id: 'delegate', kind: 'tool', ts: 2, name: 'Delegate', hint: 'agent', status: 'done' } });
      if (reason === 'fatal') { runtime.ctx.emit({ type: 'error', fatal: true, message: 'crashed' }); return; }
      if (reason === 'transport') throw new Error('send failed after possible acceptance');
      runtime.finish();
    };
    expect(await run(manager)).toMatchObject({ outcome: 'unknown' });
  });

  it('returns a normalized failed turn without confusing it with transport acceptance', async () => {
    const { manager } = await fixture();
    script = async (runtime) => { runtime.begin(); runtime.finish('failed'); };
    expect(await run(manager)).toMatchObject({ outcome: 'failed', turnId: 'turn', outputIds: [] });
  });

  it('rejects retiring runtimes and tracked child activity instead of treating idle as ready', async () => {
    const { manager } = await fixture();
    await manager.send('session', { text: 'human' });
    const runtime = runtimes[0];
    runtime.ctx.emit({ type: 'subagent.run', run: { runId: 'child', agent: 'worker', description: 'running', mode: 'background', status: 'running', startedAt: 1 } });
    await expect(run(manager)).rejects.toThrow('busy');
    runtime.ctx.emit({ type: 'subagent.run', run: { runId: 'child', agent: 'worker', description: 'done', mode: 'background', status: 'completed', startedAt: 1 } });
    const disposal = deferred<void>();
    vi.mocked(runtime.adapter.dispose).mockImplementation(() => disposal.promise);
    await manager.stop('session');
    await expect(run(manager)).rejects.toThrow('busy');
    disposal.resolve();
  });
});

describe('controlled persistence barrier', () => {
  it('holds the result and lease after the terminal event until the actual final append lands', async () => {
    const { manager, store, deps, restart } = await fixture();
    const persisted = deferred<void>();
    const append = store.appendTranscript.bind(store);
    vi.spyOn(store, 'appendTranscript').mockImplementation(async (id, item) => {
      if (item.id === 'answer') await persisted.promise;
      await append(id, item);
    });
    let settled = false;
    const result = run(manager).then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(deps.pushEvent).toHaveBeenCalledWith(expect.objectContaining({ event: { type: 'item.upsert', item: expect.objectContaining({ kind: 'turn' }) } })));
    expect(settled).toBe(false);
    await expect(manager.send('session', { text: 'race final write' })).rejects.toThrow('controlled');
    persisted.resolve();
    expect(await result).toMatchObject({ outcome: 'succeeded' });
    expect((await (await restart()).manager.transcript('session')).find((item) => item.id === 'answer')).toMatchObject({ text: 'Done' });
  });

  it.each(['answer', 'turn', 'input_operation'] as const)('does not forget a failed %s write even when a subsequent flush succeeds', async (failedId) => {
    const { manager, store } = await fixture();
    const append = store.appendTranscript.bind(store);
    let failed = false;
    vi.spyOn(store, 'appendTranscript').mockImplementation(async (id, item) => {
      if (!failed && item.id === failedId) { failed = true; throw new Error('disk full'); }
      return append(id, item);
    });
    await expect(run(manager)).rejects.toThrow('persistence');
    expect(failed).toBe(true);
    expect(await run(manager, 'recovered')).toMatchObject({ outcome: 'succeeded' });
  });

  it('propagates terminal metadata failure, rather than letting the debounced UI write certify success', async () => {
    const { manager, store } = await fixture();
    let terminal = false;
    script = async (runtime) => { runtime.begin(); runtime.finish(); terminal = true; };
    const upsert = store.upsert.bind(store);
    vi.spyOn(store, 'upsert').mockImplementation(async (meta) => {
      if (terminal) throw new Error('index unavailable');
      return upsert(meta);
    });
    await expect(run(manager)).rejects.toThrow(/index unavailable|persistence failed/);
  });

  it('does not report success when the fsynced terminal snapshot fails after ordinary appends succeeded', async () => {
    const { manager, restart } = await fixture();
    const write = persistence.writeText;
    const atomic = vi.spyOn(persistence, 'writeText').mockImplementation(async (file, text) => {
      if (file.endsWith('transcript.jsonl') && text.includes('"kind":"turn"')) throw new Error('fsync unavailable');
      return write(file, text);
    });
    await expect(run(manager)).rejects.toThrow('fsync unavailable');
    expect(atomic).toHaveBeenCalled();
    atomic.mockRestore();
    const restored = await restart();
    expect((await restored.manager.transcript('session')).filter((item) => item.kind === 'user')).toHaveLength(1);
    expect(await run(restored.manager, 'recovery')).toMatchObject({ outcome: 'succeeded' });
  });
});

describe('correlated controller creation', () => {
  const operationId = '11111111-2222-4333-8444-555555555555';
  it('creates exactly one session concurrently and returns that same durable identity after restart', async () => {
    const { manager, store, dir, restart } = await fixture();
    const req: CreateSessionRequest = { title: 'Created by controller', config: { projectRoot: dir, harness: 'native', permissionMode: 'ask' } };
    const [first, duplicate] = await Promise.all([manager.createControlled(req, operationId), manager.createControlled(req, operationId)]);
    expect(first).toBe(duplicate);
    expect(first.id).toBe('s_control_11111111222243338444555555555555');
    expect(store.list().filter((meta) => meta.controlCreation?.operationId === operationId)).toHaveLength(1);
    const restored = await restart();
    expect((await restored.manager.createControlled(req, operationId)).id).toBe(first.id);
    expect(restored.store.list().filter((meta) => meta.controlCreation?.operationId === operationId)).toHaveLength(1);
    expect(createAdapter).not.toHaveBeenCalled();
    await expect(restored.manager.createControlled({ ...req, title: 'different payload' }, operationId)).rejects.toThrow('conflicts');
  });

  it('recovers an already-created session after ancillary settings persistence failed without another create effect', async () => {
    const { manager, store, dir, deps, restart } = await fixture();
    const req: CreateSessionRequest = { config: { projectRoot: dir, harness: 'native', permissionMode: 'ask' } };
    const digest = vi.fn(async () => 'Project guidance');
    deps.knowledgeDigest = digest;
    vi.mocked(deps.settings.update).mockRejectedValueOnce(new Error('settings unavailable'));
    await expect(manager.createControlled(req, operationId)).rejects.toThrow('settings unavailable');
    const recovered = await manager.createControlled(req, operationId);
    expect(recovered.controlCreation?.operationId).toBe(operationId);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(store.list().filter((meta) => meta.controlCreation)).toHaveLength(1);
    const restored = await restart();
    expect((await restored.manager.createControlled(req, operationId)).id).toBe(recovered.id);
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it('retains failed creation admission when no session was persisted instead of duplicating earlier effects', async () => {
    const { manager, store, dir, deps } = await fixture();
    const req: CreateSessionRequest = { config: { projectRoot: dir, harness: 'native', permissionMode: 'ask' } };
    const digest = vi.fn(async () => 'Project guidance');
    deps.knowledgeDigest = digest;
    vi.spyOn(store, 'upsert').mockRejectedValueOnce(new Error('index write failed'));
    await expect(manager.createControlled(req, operationId)).rejects.toThrow('index write failed');
    await expect(manager.createControlled(req, operationId)).rejects.toThrow('index write failed');
    expect(digest).toHaveBeenCalledTimes(1);
    expect(store.list()).toHaveLength(1);
  });

  it('refuses invalid identities, implicit dispatch and forged ordinary provenance before effects', async () => {
    const { manager, store, dir } = await fixture();
    const req: CreateSessionRequest = { config: { projectRoot: dir, harness: 'native', permissionMode: 'ask' } };
    await expect(manager.createControlled(req, '../invalid')).rejects.toThrow('ID');
    await expect(manager.createControlled({ ...req, initialPrompt: 'run' }, operationId)).rejects.toThrow('initial input');
    await expect(manager.createControlled({ ...req, goal: 'autonomous' }, operationId)).rejects.toThrow('initial input');
    await expect(manager.patch('session', { controlCreation: { operationId, requestHash: 'forged' } })).rejects.toThrow('host-owned');
    expect(store.list()).toHaveLength(1);
  });
});
