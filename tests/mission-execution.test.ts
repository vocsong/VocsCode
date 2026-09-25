import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type MissionSessionHooks } from '../src/main/session-manager';
import type { ResolvedServer } from '../src/main/mcp/effective';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { MissionOwnership } from '../src/shared/mission';
import type { CreateSessionRequest, SessionEventEnvelope, UserInput } from '../src/shared/types';
import { deferred } from '../src/main/util/async';
import { MissionWorkspaceAdmission } from '../src/main/mission/admission';

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
      compact: vi.fn(async (): Promise<boolean | void> => true),
    } satisfies HarnessAdapter,
    finish: (id = 'turn') => {
      ctx.emit({ type: 'item.upsert', item: { id, kind: 'turn', ts: Date.now(), status: 'completed' } });
      ctx.emit({ type: 'status', status: 'idle' });
    },
    tool: (status: 'running' | 'done') => ctx.emit({ type: 'item.upsert', item: { id: 'tool', kind: 'tool', ts: Date.now(), name: 'read', status } }),
  };
  return runtime;
}

function dependencies(sessionStore: SessionStore) {
  return {
    store: sessionStore,
    settings: { get: () => settings, update: vi.fn(async () => settings) } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: vi.fn<(_providerId: string) => Promise<string | undefined>>(async () => undefined),
    pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
  };
}

function ownership(generation = 1): MissionOwnership {
  return { missionId: 'mission', role: 'worker', generation, attemptId: 'attempt', sourceAccess: 'assigned_workspace', requestedTools: ['read'], reasoningDefault: true };
}

function request(): CreateSessionRequest {
  return { title: 'Managed worker', config: { harness: 'native', projectRoot: root, permissionMode: 'ask', model: { provider: 'local', model: 'exact-model' } } };
}

async function create(id = 'managed') {
  return manager.createManaged(request(), { id, cwd: root, ownership: ownership() });
}

function hooks() {
  const beforeDispatch = vi.fn<MissionSessionHooks['beforeDispatch']>(async () => undefined);
  const mcpServers = vi.fn<MissionSessionHooks['mcpServers']>(async (_meta, existing) => existing);
  const onEvent = vi.fn();
  const detach = manager.attachMissionHooks({ beforeDispatch, mcpServers, onEvent });
  return { beforeDispatch, mcpServers, onEvent, detach };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-execution-'));
  store = new SessionStore(root);
  await store.load();
  settings = defaultSettings();
  settings.defaultEffort = 'high';
  settings.defaultModelByHarness.native = { provider: 'fallback', model: 'wrong-model' };
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
  vi.useRealTimers();
  for (const runtime of runtimes) {
    runtime.adapter.dispose.mockImplementation(async () => undefined);
    if ('workspaceWriterState' in runtime.adapter) Object.assign(runtime.adapter, { workspaceWriterState: () => 'quiescent' });
  }
  await manager.stopAll();
  await manager.flushPendingPersists();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('Mission managed execution', () => {
  it('tracks ordinary native children after root idle and releases only the current child completion under admission', async () => {
    const admission = new MissionWorkspaceAdmission({ sessions: () => manager.list(), activity: (id) => manager.activity(id), terminals: () => [] });
    const meta = await manager.create(request());
    await manager.send(meta.id, { text: 'Delegate a background writer' });
    const child = (status: 'running' | 'completed') => ({ type: 'subagent.run' as const, run: { runId: 'child', agent: 'general-purpose', description: 'writer', mode: 'background' as const, status, startedAt: 1 } });
    const previous = runtimes[0];
    previous.ctx.emit(child('running')); previous.tool('done'); previous.finish();
    expect(await admission.acquire(meta.cwd)).toBeUndefined();
    expect(manager.activity(meta.id)).toMatchObject({ turn: false, nativeChildren: 1, quiescent: false });
    await manager.setPermissionMode(meta.id, 'plan');
    expect(await admission.acquire(meta.cwd)).toBeUndefined(); // Current root mode does not revoke an existing child.
    previous.ctx.emit(child('completed'));
    const lease = await admission.acquire(meta.cwd); expect(lease).toBeDefined(); await lease!.assertQuiescent(); await lease!.release();
    await manager.stop(meta.id);
    await manager.setPermissionMode(meta.id, 'ask');
    await manager.send(meta.id, { text: 'New runtime' });
    runtimes[1].ctx.emit(child('running')); runtimes[1].finish('next');
    previous.ctx.emit(child('completed')); previous.finish('late');
    expect(manager.activity(meta.id)).toMatchObject({ nativeChildren: 1, quiescent: false });
    expect(await admission.acquire(meta.cwd)).toBeUndefined();
    runtimes[1].ctx.emit(child('completed'));
    const next = await admission.acquire(meta.cwd); expect(next).toBeDefined(); await next!.release(); admission.close();
  });

  it('persists ordinary writer debt before dispatch and never treats a fresh manager or a later runtime as old-tree proof', async () => {
    const writerState = vi.fn<NonNullable<HarnessAdapter['workspaceWriterState']>>(() => 'active');
    vi.mocked(createAdapter).mockImplementation((_id, ctx) => {
      const runtime = scripted(ctx); runtimes.push(runtime);
      return Object.assign(runtime.adapter, { workspaceWriterState: writerState });
    });
    const meta = await manager.create(request()); await manager.send(meta.id, { text: 'Can leave descendants' }); runtimes[0].finish();
    await manager.flushPendingPersists();
    const restoredStore = new SessionStore(root); await restoredStore.load();
    const restored = new SessionManager(dependencies(restoredStore));
    const admission = new MissionWorkspaceAdmission({ sessions: () => restored.list(), activity: (id) => restored.activity(id), terminals: () => [] });
    expect(restored.activity(meta.id)).toMatchObject({ active: false, uncertain: true, quiescent: false });
    expect(await admission.acquire(meta.cwd)).toBeUndefined();
    await restored.setPermissionMode(meta.id, 'plan');
    expect(await admission.acquire(meta.cwd)).toBeUndefined();
    await restored.setPermissionMode(meta.id, 'ask');
    await restored.send(meta.id, { text: 'Ordinary use still works despite missing old-tree proof' }); runtimes[1].finish();
    writerState.mockReturnValue('quiescent');
    await expect(restored.stop(meta.id)).rejects.toThrow('earlier session process tree');
    expect(restored.activity(meta.id)).toMatchObject({ active: false, uncertain: true, quiescent: false });
    expect(await admission.acquire(meta.cwd)).toBeUndefined();
    await expect(restored.moveTo(meta.id, path.join(root, 'elsewhere'))).rejects.toThrow('earlier session process tree');
    await expect(restored.delete(meta.id)).rejects.toThrow('earlier session process tree');
    expect(restored.get(meta.id)?.cwd).toBe(meta.cwd);
    await restored.flushPendingPersists(); admission.close();
    await manager.stop(meta.id);
  });

  it('holds a read-only source permission escalation behind an acquired baseline lease before persisting its writer claim', async () => {
    const admission = new MissionWorkspaceAdmission({ sessions: () => manager.list(), activity: (id) => manager.activity(id), terminals: () => [] });
    manager = new SessionManager({ ...deps, withWorkspaceDispatch: (meta, dispatch) => admission.dispatch(meta.cwd, dispatch) });
    vi.mocked(createAdapter).mockImplementation((_id, ctx) => {
      const runtime = scripted(ctx); runtimes.push(runtime);
      return Object.assign(runtime.adapter, { workspaceWriterState: () => 'quiescent' as const });
    });
    const source = request(); source.config.permissionMode = 'plan';
    const meta = await manager.create(source); await manager.send(meta.id, { text: 'Read-only discussion' }); runtimes[0].finish();
    const lease = await admission.acquire(meta.cwd); expect(lease).toBeDefined();
    const escalating = manager.setPermissionMode(meta.id, 'full-auto');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(meta.config.permissionMode).toBe('plan'); expect(runtimes[0].adapter.setPermissionMode).not.toHaveBeenCalled();
    await lease!.assertQuiescent(); await lease!.release(); await escalating;
    expect(runtimes[0].adapter.setPermissionMode).toHaveBeenCalledExactlyOnceWith('full-auto');
    expect(await admission.acquire(meta.cwd)).toBeUndefined();
    await manager.stop(meta.id); const released = await admission.acquire(meta.cwd); expect(released).toBeDefined(); await released!.release(); admission.close();
  });

  it('keeps ordinary deferred and rejected disposal owned without admitting a replacement or baseline', async () => {
    const admission = new MissionWorkspaceAdmission({ sessions: () => manager.list(), activity: (id) => manager.activity(id), terminals: () => [] });
    const meta = await manager.create(request()); await manager.send(meta.id, { text: 'Work' }); runtimes[0].finish();
    const disposed = deferred<void>(); runtimes[0].adapter.dispose.mockImplementationOnce(() => disposed.promise);
    const stopping = manager.stop(meta.id); const rejected = expect(stopping).rejects.toThrow('unproven tree');
    expect(manager.activity(meta.id)).toMatchObject({ active: true, tearingDown: true, quiescent: false });
    expect(await admission.acquire(meta.cwd)).toBeUndefined();
    runtimes[0].finish('late'); disposed.reject(new Error('unproven tree')); await rejected;
    expect(manager.activity(meta.id)).toMatchObject({ active: true, tearingDown: true, uncertain: true, quiescent: false });
    expect(await admission.acquire(meta.cwd)).toBeUndefined();
    await expect(manager.send(meta.id, { text: 'No replacement' })).rejects.toThrow(/stopping|uncertain/);
    await manager.stop(meta.id);
    const lease = await admission.acquire(meta.cwd); expect(lease).toBeDefined(); await lease!.release(); admission.close();
  });

  it.each(['stopped', 'fatal', 'startup'] as const)('retains ordinary uncertainty when %s cleanup cannot prove disposal', async (failure) => {
    const meta = await manager.create(request());
    if (failure === 'startup') {
      vi.mocked(createAdapter).mockImplementationOnce((_id, ctx) => {
        const runtime = scripted(ctx); runtimes.push(runtime);
        runtime.adapter.start.mockRejectedValueOnce(new Error('handshake failed'));
        runtime.adapter.dispose.mockRejectedValueOnce(new Error('tree unproven'));
        return runtime.adapter;
      });
      await expect(manager.send(meta.id, { text: 'Start' })).rejects.toThrow('handshake failed');
    } else {
      await manager.send(meta.id, { text: 'Work' });
      runtimes[0].adapter.dispose.mockRejectedValueOnce(new Error('tree unproven'));
      runtimes[0].ctx.emit(failure === 'fatal' ? { type: 'error', message: 'crashed', fatal: true } : { type: 'status', status: 'stopped' });
    }
    await vi.waitFor(() => expect(manager.activity(meta.id)).toMatchObject({ active: true, tearingDown: true, uncertain: true, quiescent: false }));
    await manager.stop(meta.id); expect(manager.activity(meta.id).quiescent).toBe(true);
  });

  it('defers an ordinary source prompt behind a held snapshot, then retains writer activity until a terminal turn', async () => {
    const admission = new MissionWorkspaceAdmission({ sessions: () => manager.list(), activity: (id) => manager.activity(id), terminals: () => [] });
    manager = new SessionManager({ ...deps, withWorkspaceDispatch: (meta, dispatch) => admission.dispatch(meta.cwd, dispatch) });
    const ordinary = await manager.create(request());
    const lease = await admission.acquire(ordinary.cwd); expect(lease).toBeDefined();
    const pending = manager.send(ordinary.id, { text: 'Change a source file' });
    await vi.waitFor(() => expect(runtimes).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
    await lease!.release(); await pending;
    expect(runtimes[0].adapter.send).toHaveBeenCalledTimes(1);
    expect(runtimes[0].adapter.busy).toBe(false); // Transport acceptance is not completion.
    expect(await admission.acquire(ordinary.cwd)).toBeUndefined();
    runtimes[0].finish();
    const after = await admission.acquire(ordinary.cwd); expect(after).toBeDefined(); await after!.release(); admission.close();
  });

  it('requests a host operation through the real lead approval channel without a model prompt', async () => {
    await manager.createManaged(request(), { id: 'lead', cwd: root, ownership: { ...ownership(), role: 'lead', attemptId: undefined } });
    hooks();
    const pending = manager.requestManagedApproval('lead', 1, { title: 'Run final checks?', kind: 'tool', options: [{ id: 'allow', label: 'Allow once', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }] });
    await vi.waitFor(() => expect(manager.activity('lead').approvals).toBe(1));
    const event = deps.pushEvent.mock.calls.map(([env]) => env as SessionEventEnvelope).find((env) => env.event.type === 'approval.request')!;
    if (event.event.type !== 'approval.request') throw new Error('Missing approval event');
    expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
    await manager.respondApproval('lead', event.event.request.id, { optionId: 'allow' });
    expect(await pending).toEqual({ optionId: 'allow' });
    expect(manager.activity('lead').quiescent).toBe(true);
  });

  it('refuses to reuse a user approval after the owning Mission hooks have detached', async () => {
    await manager.createManaged(request(), { id: 'lead', cwd: root, ownership: { ...ownership(), role: 'lead', attemptId: undefined } });
    const attached = hooks();
    const pending = manager.requestManagedApproval('lead', 1, { title: 'Run final checks?', kind: 'tool', options: [{ id: 'allow', label: 'Allow', kind: 'allow' }] });
    const rejection = expect(pending).rejects.toThrow(/owner changed/i);
    await vi.waitFor(() => expect(manager.activity('lead').approvals).toBe(1));
    const event = deps.pushEvent.mock.calls.map(([env]) => env as SessionEventEnvelope).find((env) => env.event.type === 'approval.request')!;
    if (event.event.type !== 'approval.request') throw new Error('Missing approval event');
    attached.detach(); await manager.respondApproval('lead', event.event.request.id, { optionId: 'allow' });
    await rejection; expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
  });

  it('preflights only a managed runtime with host hooks and never dispatches or invents readiness', async () => {
    await create();
    await expect(manager.prepareManaged('managed', 1)).rejects.toThrow(/hooks/i);
    expect(createAdapter).not.toHaveBeenCalled();
    hooks();
    const result = await manager.prepareManaged('managed', 1);
    expect(result.readiness).toMatchObject({ ready: false, tools: [] });
    expect(result.models).toEqual([]);
    expect(runtimes[0].adapter.start).toHaveBeenCalledTimes(1);
    expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
    expect(await manager.transcript('managed')).toEqual([]);
    expect(manager.activity('managed').quiescent).toBe(true);
    await expect(manager.prepareManaged('managed', 2)).rejects.toThrow(/generation/i);
  });

  it('returns observed managed readiness without substituting its configured model', async () => {
    await create(); hooks();
    const observed = { ready: true, tools: ['read'], model: { provider: 'actual', model: 'observed-model' } };
    vi.mocked(createAdapter).mockImplementationOnce((_id, ctx) => {
      const runtime = scripted(ctx); runtimes.push(runtime);
      return { ...runtime.adapter, missionReadiness: async () => observed, listModels: async () => [] };
    });
    expect((await manager.prepareManaged('managed', 1)).readiness).toEqual(observed);
    expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
  });

  it('rejects an async readiness observation when its ownership hooks detach before readback', async () => {
    await create(); const attached = hooks();
    const gate = deferred<{ ready: boolean; tools: string[] }>();
    vi.mocked(createAdapter).mockImplementationOnce((_id, ctx) => {
      const runtime = scripted(ctx); runtimes.push(runtime);
      return { ...runtime.adapter, missionReadiness: () => gate.promise };
    });
    const preparing = manager.prepareManaged('managed', 1);
    await vi.waitFor(() => expect(runtimes[0]?.adapter.start).toHaveBeenCalledTimes(1));
    const rejected = expect(preparing).rejects.toThrow(/stale/i);
    attached.detach(); gate.resolve({ ready: true, tools: ['read'] });
    await rejected;
    expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
  });

  it('keeps an accepted send active until a terminal turn AND running tools settle', async () => {
    await create();
    hooks();
    await manager.sendManaged('managed', { text: 'Work' }, 1);
    const runtime = runtimes[0];
    expect(runtime.adapter.busy).toBe(false); // Deliberately not sufficient evidence of completion.
    expect(manager.activity('managed')).toMatchObject({ active: true, turn: true, quiescent: false });
    runtime.ctx.emit({ type: 'status', status: 'idle' });
    expect(manager.activity('managed').quiescent).toBe(false);
    runtime.tool('running');
    runtime.finish();
    expect(manager.activity('managed')).toMatchObject({ turn: false, tools: 1, quiescent: false });
    runtime.tool('done');
    expect(manager.activity('managed')).toMatchObject({ active: true, tools: 0, quiescent: true });
  });

  it('creates only the exact prescribed session, without dispatch or app defaults, and deduplicates the descriptor', async () => {
    const req = { ...request(), initialPrompt: 'Must not run', goal: 'Must not become a goal' };
    req.config.model = undefined;
    const descriptor = { id: 'managed', cwd: root, worktreeBranch: 'mission-worker', ownership: ownership() };
    const [first, retry] = await Promise.all([manager.createManaged(req, descriptor), manager.createManaged(req, descriptor)]);
    expect(retry).toBe(first);
    expect(store.list()).toHaveLength(1);
    expect(first).toMatchObject({ id: 'managed', cwd: root, worktreeBranch: 'mission-worker', mission: ownership() });
    expect(first.config.model).toBeUndefined();
    expect(first.activeModel).toBeUndefined();
    expect(first.goal).toBeUndefined();
    expect(first.nativeGoal).toBeUndefined();
    expect(await manager.transcript('managed')).toEqual([]);
    expect(createAdapter).not.toHaveBeenCalled();
    await expect(manager.createManaged(req, { ...descriptor, cwd: path.join(root, 'other') })).rejects.toThrow(/descriptor/i);
    await expect(manager.createManaged({ ...req, config: { ...req.config, permissionMode: 'full-auto' } }, descriptor)).rejects.toThrow(/descriptor/i);
    await expect(manager.createManaged(req, { ...descriptor, ownership: ownership(2) })).rejects.toThrow(/descriptor/i);
  });

  it('requires an attached authorization hook and never turns Mission input into user recency or analytics', async () => {
    const meta = await create();
    await expect(manager.sendManaged(meta.id, { text: 'No service' }, 1)).rejects.toThrow(/hooks/i);
    expect(createAdapter).not.toHaveBeenCalled();
    const attached = hooks();
    await manager.sendManaged(meta.id, { text: 'Host continuation' }, 1);
    expect(attached.beforeDispatch).toHaveBeenCalledExactlyOnceWith(meta, expect.objectContaining({ text: 'Host continuation', transcriptItemId: expect.any(String) }));
    expect(meta.lastUserMessageAt).toBeUndefined();
    expect(deps.analytics.recordUserMessage).not.toHaveBeenCalled();
    expect(runtimes[0].ctx.effort()).toBeUndefined();
    expect(meta.config.effort).toBeUndefined();
    expect((await manager.transcript(meta.id)).filter((item) => item.kind === 'user')).toHaveLength(1);
    runtimes[0].finish();
    attached.detach();
    await expect(manager.sendManaged(meta.id, { text: 'Detached service' }, 1)).rejects.toThrow(/hooks/i);
    expect(runtimes[0].adapter.send).toHaveBeenCalledTimes(1);
  });

  it('refuses unauthorized dispatch and observes startup until it actually settles', async () => {
    await create();
    const attached = hooks();
    const started = deferred<void>();
    vi.mocked(createAdapter).mockImplementationOnce((_id, ctx) => {
      const runtime = scripted(ctx);
      runtime.adapter.start.mockImplementation(() => started.promise);
      runtimes.push(runtime);
      return runtime.adapter;
    });
    attached.beforeDispatch.mockRejectedValueOnce(new Error('Execution not authorized'));
    const sending = manager.sendManaged('managed', { text: 'Work' }, 1);
    expect(manager.activity('managed')).toMatchObject({ active: true, starting: true, queued: 1, quiescent: false });
    const rejection = expect(sending).rejects.toThrow('Execution not authorized');
    started.resolve();
    await rejection;
    expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
    expect(manager.activity('managed')).toMatchObject({ starting: false, turn: false, queued: 0, quiescent: true });
  });

  it('publishes events after terminal/tool/approval bookkeeping and supports unsubscribe', async () => {
    await create();
    const attached = hooks();
    await manager.sendManaged('managed', { text: 'Work' }, 1);
    const runtime = runtimes[0];
    const observed: Array<{ env: SessionEventEnvelope; activity: ReturnType<SessionManager['activity']> }> = [];
    const unsubscribe = manager.subscribe((env) => observed.push({ env, activity: manager.activity(env.sessionId) }));
    runtime.tool('running');
    expect(observed.at(-1)?.activity.tools).toBe(1);
    const approval = runtime.ctx.requestApproval({ title: 'Read file?', kind: 'tool', options: [{ id: 'allow', label: 'Allow', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }] });
    const requested = observed.find((value) => value.env.event.type === 'approval.request')!;
    expect(requested.activity.approvals).toBe(1);
    if (requested.env.event.type !== 'approval.request') throw new Error('Missing approval event');
    await manager.respondApproval('managed', requested.env.event.request.id, { optionId: 'deny' });
    await expect(approval).resolves.toEqual({ optionId: 'deny' });
    expect(observed.at(-1)?.activity.approvals).toBe(0);
    runtime.finish();
    expect(observed.find((value) => value.env.event.type === 'item.upsert' && value.env.event.item.kind === 'turn')?.activity).toMatchObject({ turn: false, tools: 1, quiescent: false });
    runtime.tool('done');
    expect(observed.at(-1)?.activity.quiescent).toBe(true);
    expect(attached.onEvent).toHaveBeenCalledWith(observed.at(-1)?.env);
    unsubscribe();
    const count = observed.length;
    runtime.ctx.emit({ type: 'log', level: 'info', message: 'after unsubscribe' });
    expect(observed).toHaveLength(count);
  });

  it('never accepts a goal token or native advertisement and never runs a legacy goal timer', async () => {
    const meta = await create();
    hooks();
    await manager.sendManaged('managed', { text: 'Work' }, 1);
    const runtime = runtimes[0];
    settings.goalDefaults.preferHarness = true;
    runtime.ctx.updateMeta({ harnessCommands: ['goal'] });
    await manager.refreshGoalDrivers();
    expect(meta.nativeGoal).toBeUndefined();
    // Simulate legacy on-disk/app state that outlived an ownership migration.
    meta.goal = { objective: 'Legacy goal', status: 'active', createdAt: 1, updatedAt: 1, iterations: 0, maxIterations: 5, autoContinue: true };
    runtime.ctx.emit({ type: 'item.upsert', item: { id: 'answer', kind: 'assistant', ts: 1, text: 'GOAL_COMPLETE' } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    runtime.finish();
    expect(meta.goal.status).toBe('active');
    expect(meta.goal.iterations).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1);
    expect(deps.notify).not.toHaveBeenCalled();
    await expect(manager.sendManaged('managed', { text: '/goal Start a native loop' }, 1)).rejects.toThrow(/native goals/i);
    await manager.refreshGoalDrivers();
    expect(meta.goal).toBeUndefined();
    expect(meta.nativeGoal).toBeUndefined();
  });

  it('retains failure notifications while suppressing routine managed completion notices', async () => {
    const meta = await create();
    hooks();
    settings.notifications = true;
    await manager.sendManaged(meta.id, { text: 'Work' }, 1);
    runtimes[0].ctx.emit({ type: 'item.upsert', item: { id: 'failed', kind: 'turn', ts: 1, status: 'failed', error: 'provider offline' } });
    expect(deps.notify).toHaveBeenCalledExactlyOnceWith(meta.id, meta.title, 'Turn failed: provider offline');
  });

  it('drops a goal continuation already scheduled before legacy ownership was attached', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const meta = await manager.create(request());
    await manager.send(meta.id, { text: 'Ordinary first turn' });
    meta.goal = { objective: 'Legacy goal', status: 'active', createdAt: 1, updatedAt: 1, iterations: 0, maxIterations: 5, autoContinue: true };
    const runtime = runtimes[0];
    runtime.finish();
    expect(meta.goal.iterations).toBe(1);
    meta.mission = ownership(); // Host migration of an existing record, not the forbidden generic patch.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('denies every ordinary mutation route while allowing title and pin changes', async () => {
    const meta = await create();
    const original = structuredClone(meta);
    const calls = [
      () => manager.send(meta.id, { text: 'ordinary bypass' }),
      () => manager.goal(meta.id, 'set', { objective: 'bypass' }),
      () => manager.setModel(meta.id, { provider: 'other', model: 'other' }),
      () => manager.setEffort(meta.id, 'low'),
      () => manager.setPermissionMode(meta.id, 'full-auto'),
      () => manager.moveTo(meta.id, root),
      () => manager.fork(meta.id),
      () => manager.editAndResend(meta.id, 'missing', { text: 'bypass' }),
      () => manager.clearTranscript(meta.id),
      () => manager.subagentCommand(meta.id, 'agent', 'stop'),
      () => manager.delete(meta.id, true),
      () => manager.deleteMany([meta.id]),
      () => manager.setArchived(meta.id, true, true, true),
      () => manager.setArchived(meta.id, false),
      () => manager.stop(meta.id),
      () => manager.interrupt(meta.id),
      () => manager.patch(meta.id, { mission: undefined }),
      () => manager.patch(meta.id, { config: { ...meta.config, permissionMode: 'full-auto' } }),
      () => manager.patch(meta.id, { cwd: path.join(root, 'elsewhere') }),
      () => manager.patch(meta.id, { archived: true }),
      () => manager.patch(meta.id, { goal: { objective: 'bypass', status: 'active', createdAt: 1, updatedAt: 1, iterations: 0, maxIterations: 5, autoContinue: true } }),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow(/Mission/i);
    expect(meta).toEqual(original);
    expect(createAdapter).not.toHaveBeenCalled();
    expect(await manager.transcript(meta.id)).toEqual([]);
    await manager.patch(meta.id, { title: 'Renamed' });
    await manager.setPinned(meta.id, true);
    expect(meta).toMatchObject({ title: 'Renamed', pinned: true });
    const ordinary = await manager.create(request());
    await expect(manager.patch(ordinary.id, { mission: ownership() })).rejects.toThrow(/Mission/i);
  });

  it('rejects stale generations before start and again after compaction', async () => {
    const meta = await create();
    const attached = hooks();
    await expect(manager.sendManaged(meta.id, { text: 'Stale' }, 0)).rejects.toThrow(/generation/i);
    expect(createAdapter).not.toHaveBeenCalled();
    await manager.sendManaged(meta.id, { text: 'First' }, 1);
    const runtime = runtimes[0];
    runtime.finish();
    const compacted = deferred<boolean>();
    runtime.adapter.compact.mockImplementation(() => compacted.promise);
    const compaction = manager.compact(meta.id);
    const waiting = manager.sendManaged(meta.id, { text: 'Waiting' }, 1);
    const rejection = expect(waiting).rejects.toThrow(/generation/i);
    expect(manager.activity(meta.id)).toMatchObject({ compacting: true, queued: 1, quiescent: false });
    await expect(manager.updateManaged(meta.id, 1, { mission: { generation: 2 } })).rejects.toThrow(/quiescent/i);
    meta.mission!.generation = 2; // Host revocation while the already-admitted send awaits compaction.
    compacted.resolve(true);
    await compaction;
    await rejection;
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1);
    expect(attached.beforeDispatch).toHaveBeenCalledTimes(1);
    await expect(manager.stopManaged(meta.id, 1)).rejects.toThrow(/generation/i);
    await expect(manager.interruptManaged(meta.id, 1)).rejects.toThrow(/generation/i);
  });

  it('waits for compaction, then calls the current dispatch guard immediately before sending', async () => {
    await create();
    const attached = hooks();
    await manager.sendManaged('managed', { text: 'First' }, 1);
    const runtime = runtimes[0];
    runtime.finish();
    const compacted = deferred<boolean>();
    runtime.adapter.compact.mockImplementation(() => compacted.promise);
    const compaction = manager.compact('managed');
    const waiting = manager.sendManaged('managed', { text: 'Second' }, 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1);
    compacted.resolve(true);
    await compaction;
    await waiting;
    expect(runtime.adapter.send).toHaveBeenCalledTimes(2);
    expect(attached.beforeDispatch).toHaveBeenCalledTimes(2);
    expect(attached.beforeDispatch.mock.invocationCallOrder[1]).toBeLessThan(runtime.adapter.send.mock.invocationCallOrder[1]);
  });

  it.each([false, true])('invalidates a pending authorization when hooks detach (reattach: %s)', async (reattach) => {
    await create();
    const attached = hooks();
    const allowed = deferred<void>();
    attached.beforeDispatch.mockImplementation(() => allowed.promise);
    const waiting = manager.sendManaged('managed', { text: 'Work' }, 1);
    const rejection = expect(waiting).rejects.toThrow(/hooks/i);
    await vi.waitFor(() => expect(attached.beforeDispatch).toHaveBeenCalledTimes(1));
    attached.detach();
    if (reattach) {
      manager.attachMissionHooks(attached);
      attached.detach(); // The old unsubscribe must not detach the new registration.
    }
    allowed.resolve();
    await rejection;
    expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
    if (reattach) {
      await manager.sendManaged('managed', { text: 'New authorization' }, 1);
      expect(runtimes[0].adapter.send).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps disposal owned, propagates failure, and prevents workspace reuse until disposal succeeds', async () => {
    await create();
    hooks();
    await manager.sendManaged('managed', { text: 'Work' }, 1);
    const runtime = runtimes[0];
    runtime.ctx.emit({ type: 'item.upsert', item: { id: 'partial', kind: 'assistant', ts: 1, text: 'Unfinished work', streaming: true } });
    const disposed = deferred<void>();
    runtime.adapter.dispose.mockImplementationOnce(() => disposed.promise);
    const stopping = manager.stopManaged('managed', 1);
    const failure = expect(stopping).rejects.toThrow('process still alive');
    expect(manager.activity('managed')).toMatchObject({ active: true, tearingDown: true, quiescent: false });
    runtime.finish(); // Late callbacks during teardown are not evidence of a successful disposal.
    disposed.reject(new Error('process still alive'));
    await failure;
    expect(manager.activity('managed')).toMatchObject({ active: true, tearingDown: true, uncertain: true, quiescent: false });
    await expect(manager.sendManaged('managed', { text: 'Conflicting replacement' }, 1)).rejects.toThrow(/ready/i);
    await expect(manager.updateManaged('managed', 1, { mission: { generation: 2 } })).rejects.toThrow(/quiescent/i);
    await expect(manager.archiveManaged('managed', 1)).rejects.toThrow(/stop all/i);
    await manager.stopManaged('managed', 1);
    expect(manager.activity('managed')).toMatchObject({ active: false, tearingDown: false, uncertain: false, quiescent: true });
    expect((await manager.transcript('managed')).find((item) => item.id === 'partial')).toMatchObject({ text: 'Unfinished work', streaming: false });
  });

  it.each(['stop', 'interrupt', 'stopAll'] as const)('cancels admitted input before startup when %s arrives from an event observer', async (action) => {
    await create();
    hooks();
    let stopping: Promise<void> | undefined;
    manager.subscribe((env) => {
      if (env.event.type !== 'item.upsert' || env.event.item.kind !== 'user') return;
      stopping = action === 'stopAll' ? manager.stopAll() : action === 'stop' ? manager.stopManaged('managed', 1) : manager.interruptManaged('managed', 1);
    });
    await expect(manager.sendManaged('managed', { text: 'Never dispatch' }, 1)).rejects.toThrow(/stopped/i);
    await stopping;
    expect(createAdapter).not.toHaveBeenCalled();
    expect(manager.activity('managed')).toMatchObject({ active: false, queued: 0, quiescent: true });
  });

  it('deduplicates reentrant stop requests made by an event subscriber during approval cancellation', async () => {
    await create();
    hooks();
    await manager.sendManaged('managed', { text: 'Work' }, 1);
    const runtime = runtimes[0];
    const approval = runtime.ctx.requestApproval({ title: 'Pending', kind: 'tool', options: [] });
    let repeated: Promise<void> | undefined;
    manager.subscribe((env) => { if (env.event.type === 'approval.resolved') repeated = manager.stopManaged('managed', 1); });
    await manager.stopManaged('managed', 1);
    await repeated;
    expect(await approval).toMatchObject({ optionId: 'deny' });
    expect(runtime.adapter.dispose).toHaveBeenCalledTimes(1);
    expect(manager.activity('managed').quiescent).toBe(true);
  });

  it('waits for a delayed start before disposal and never dispatches its canceled input', async () => {
    await create();
    hooks();
    const started = deferred<void>();
    vi.mocked(createAdapter).mockImplementationOnce((_id, ctx) => {
      const runtime = scripted(ctx);
      runtime.adapter.start.mockImplementation(() => started.promise);
      runtimes.push(runtime);
      return runtime.adapter;
    });
    const sending = manager.sendManaged('managed', { text: 'Work' }, 1);
    const rejection = expect(sending).rejects.toThrow(/stopped/i);
    const stopping = manager.stopManaged('managed', 1);
    expect(manager.activity('managed')).toMatchObject({ starting: true, tearingDown: true, quiescent: false });
    expect(runtimes[0].adapter.dispose).not.toHaveBeenCalled();
    started.resolve();
    await rejection;
    await stopping;
    expect(runtimes[0].adapter.send).not.toHaveBeenCalled();
    expect(runtimes[0].adapter.dispose).toHaveBeenCalledTimes(1);
    expect(manager.activity('managed')).toMatchObject({ active: false, queued: 0, quiescent: true });
  });

  it('keeps interrupt outstanding until normalized terminal and tool events settle', async () => {
    await create();
    hooks();
    await manager.sendManaged('managed', { text: 'Work' }, 1);
    const runtime = runtimes[0];
    runtime.tool('running');
    await manager.interruptManaged('managed', 1);
    expect(runtime.adapter.interrupt).toHaveBeenCalledTimes(1);
    expect(manager.activity('managed').quiescent).toBe(false);
    runtime.finish();
    expect(manager.activity('managed').quiescent).toBe(false);
    runtime.tool('done');
    expect(manager.activity('managed').quiescent).toBe(true);
    runtime.adapter.interrupt.mockRejectedValueOnce(new Error('interrupt timeout'));
    await expect(manager.interruptManaged('managed', 1)).rejects.toThrow('interrupt timeout');
    expect(manager.activity('managed')).toMatchObject({ uncertain: true, quiescent: false });
  });

  it.each([1, 2])('fences stale disposed-runtime callbacks when the replacement uses generation %s', async (generation) => {
    const meta = await create();
    hooks();
    await manager.sendManaged(meta.id, { text: 'First' }, 1);
    const previous = runtimes[0];
    previous.ctx.updateRef({ nativeHistory: true });
    await manager.stopManaged(meta.id, 1);
    await manager.updateManaged(meta.id, 1, { mission: { generation }, config: { model: { provider: 'local', model: 'replacement' } } });
    await manager.sendManaged(meta.id, { text: 'Replacement' }, generation);
    const events = deps.pushEvent.mock.calls.length;
    const snapshot = structuredClone(meta);
    previous.ctx.emit({ type: 'error', message: 'late fatal', fatal: true });
    previous.ctx.emit({ type: 'meta', patch: { config: { ...meta.config, permissionMode: 'full-auto' }, mission: ownership(99) } });
    previous.ctx.updateMeta({ activeModel: { provider: 'late', model: 'late' }, queued: 99, harnessCommands: ['goal'] });
    previous.ctx.updateRef({ nativeHistory: false });
    await previous.ctx.writeJson('late.json', { stale: true });
    await expect(previous.ctx.requestApproval({ title: 'Late approval', kind: 'tool', options: [] })).resolves.toMatchObject({ optionId: 'deny' });
    expect(meta).toEqual(snapshot);
    expect(deps.pushEvent).toHaveBeenCalledTimes(events);
    expect(await fs.stat(path.join(store.sessionDir(meta.id), 'late.json')).catch(() => null)).toBeNull();
    expect(manager.activity(meta.id)).toMatchObject({ active: true, turn: true, approvals: 0 });
    expect(runtimes[1].adapter.dispose).not.toHaveBeenCalled();
  });

  it('blocks managed reconfiguration without silently resetting a live worker and retains fields across restart', async () => {
    await create();
    hooks();
    await manager.sendManaged('managed', { text: 'Work' }, 1);
    const runtime = runtimes[0];
    await expect(manager.updateManaged('managed', 1, { config: { effort: 'low' } })).rejects.toThrow(/quiescent/i);
    runtime.finish();
    await expect(manager.updateManaged('managed', 1, { config: { effort: 'low' } })).rejects.toThrow(/stop/i);
    expect(runtime.adapter.dispose).not.toHaveBeenCalled();
    await manager.stopManaged('managed', 1);
    const updated = await manager.updateManaged('managed', 1, { mission: { generation: 2 }, config: { effort: 'low' } });
    await manager.flushPendingPersists();
    const restartedStore = new SessionStore(root);
    await restartedStore.load();
    const restarted = new SessionManager(dependencies(restartedStore));
    expect(restarted.get('managed')).toMatchObject({ mission: ownership(2), config: { effort: 'low' }, activeEffort: 'low', cwd: root });
    expect(restarted.activity('managed')).toMatchObject({ active: false, quiescent: true });
    await expect(restarted.sendManaged('managed', { text: 'Unattached recovery' }, 2)).rejects.toThrow(/hooks/i);
    expect(updated.mission?.generation).toBe(2);
    expect(createAdapter).toHaveBeenCalledTimes(1); // Restart did not automatically spawn.
  });

  it('archives only after the host stops every child and preserves each workspace', async () => {
    const workspaceFile = path.join(root, 'retained.txt');
    await fs.writeFile(workspaceFile, 'candidate');
    const lead = await manager.createManaged(request(), { id: 'lead', cwd: root, ownership: { ...ownership(), role: 'lead', attemptId: undefined } });
    await create();
    hooks();
    await manager.sendManaged('managed', { text: 'Worker still running' }, 1);
    await expect(manager.archiveManaged(lead.id, 1)).rejects.toThrow(/stop all/i);
    await manager.stopAll(); // Generic app shutdown must use the managed teardown path internally.
    await manager.archiveManaged(lead.id, 1);
    await manager.archiveManaged('managed', 1);
    expect(store.list().every((session) => session.archived)).toBe(true);
    expect(await fs.readFile(workspaceFile, 'utf8')).toBe('candidate');
    expect(store.list()).toHaveLength(2);
    expect(runtimes[0].adapter.dispose).toHaveBeenCalledTimes(1);
  });

  it('resolves MCP normally before the Mission hook and preserves secret provenance', async () => {
    settings.mcpServers = [{ id: 'existing', transport: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${MISSION_TEST_SECRET}' } }];
    deps.getSecret.mockResolvedValue('test-secret');
    await create();
    const attached = hooks();
    const bridge: ResolvedServer = { def: { id: 'mission', transport: 'http', url: 'http://127.0.0.1/mcp' }, missing: [], secretEnvKeys: [], secretHeaderKeys: [] };
    attached.mcpServers.mockImplementation(async (_meta, existing) => [...existing, bridge]);
    await manager.sendManaged('managed', { text: 'Work' }, 1);
    const resolved = await runtimes[0].ctx.mcpServers();
    expect(attached.mcpServers).toHaveBeenCalledTimes(1);
    expect(attached.mcpServers.mock.calls[0][1]).toContainEqual(expect.objectContaining({ def: expect.objectContaining({ id: 'existing', headers: { Authorization: 'Bearer test-secret' } }), secretHeaderKeys: ['Authorization'] }));
    expect(resolved.at(-1)).toEqual(bridge);
    attached.detach();
    await expect(runtimes[0].ctx.mcpServers()).rejects.toThrow(/hooks/i);
  });

  it.each(['stopped', 'fatal', 'startup'] as const)('retains uncertain ownership after a %s runtime fails disposal', async (failure) => {
    await create();
    hooks();
    if (failure === 'startup') {
      vi.mocked(createAdapter).mockImplementationOnce((_id, ctx) => {
        const runtime = scripted(ctx);
        runtime.adapter.start.mockRejectedValueOnce(new Error('handshake failed'));
        runtime.adapter.dispose.mockRejectedValueOnce(new Error('still running'));
        runtimes.push(runtime);
        return runtime.adapter;
      });
      await expect(manager.sendManaged('managed', { text: 'Start' }, 1)).rejects.toThrow('handshake failed');
    } else {
      await manager.sendManaged('managed', { text: 'Work' }, 1);
      const runtime = runtimes[0];
      runtime.adapter.dispose.mockRejectedValueOnce(new Error('still running'));
      runtime.ctx.emit(failure === 'fatal' ? { type: 'error', message: 'crashed', fatal: true } : { type: 'status', status: 'stopped' });
    }
    await vi.waitFor(() => expect(manager.activity('managed')).toMatchObject({ active: true, tearingDown: true, uncertain: true, quiescent: false }));
    expect(runtimes[0].adapter.dispose).toHaveBeenCalledTimes(1);
    await manager.stopManaged('managed', 1);
    expect(manager.activity('managed').quiescent).toBe(true);
  });
});
