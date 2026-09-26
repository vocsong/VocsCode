/**
 * Ordinary (non-Mission) sessions and terminals keep their pre-Mission behaviour unless ordinary
 * process ownership is enabled (Windows, Missions configured, a working Job helper), and Mission
 * ownership bookkeeping never makes an ordinary operation fail or wedge.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from '@lydell/node-pty';
import { SessionManager, type MissionSessionHooks, type SessionManagerDeps } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { CreateSessionRequest, UserInput } from '../src/shared/types';
import { deferred } from '../src/main/util/async';
import { MissionWorkspaceAdmission } from '../src/main/mission/admission';
import { TerminalManager, type TerminalManagerDeps } from '../src/main/terminal';
import { DEFAULT_TERMINAL_SETTINGS } from '../src/shared/terminal';
import { createProcessOwnershipIntent, recordUnlaunchedProcessIntent } from '../src/main/mission/process-ownership';
import { OwnedWindowsJobProbe, missionsConfigured, ordinaryProcessOwnership, probeOwnedWindowsJob } from '../src/main/owned-windows-job';
import { createDefaultMissionConfig } from '../src/shared/mission-config';

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

/** Adapters created from now on report this writer state (a Pi-like runtime). */
function tracking(state: () => ReturnType<NonNullable<HarnessAdapter['workspaceWriterState']>>) {
  vi.mocked(createAdapter).mockImplementation((_id, ctx) => {
    const runtime = scripted(ctx); runtimes.push(runtime);
    return Object.assign(runtime.adapter, { workspaceWriterState: state });
  });
}

function dependencies(sessionStore: SessionStore) {
  return {
    store: sessionStore,
    settings: { get: () => settings, update: vi.fn(async () => settings) } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn(), recordSubagent: vi.fn() } as unknown as AnalyticsStore,
    getSecret: vi.fn<(_providerId: string) => Promise<string | undefined>>(async () => undefined),
    pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
  };
}

function request(projectRoot = root): CreateSessionRequest {
  return { title: 'Ordinary', config: { harness: 'native', projectRoot, permissionMode: 'full-auto', model: { provider: 'local', model: 'exact-model' } } };
}

const within = <T>(promise: Promise<T>, ms = 2_000) => Promise.race([promise.then(() => 'settled' as const), new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), ms))]);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ordinary-ownership-'));
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

describe('ordinary sessions never fail on writer ownership bookkeeping', () => {
  it('stops, sends again, archives and deletes a Pi-like runtime whose writers stay unproven', async () => {
    tracking(() => 'unknown');
    const meta = await manager.create(request());
    await manager.send(meta.id, { text: 'Leaves unproven writers' }); runtimes[0].finish();
    expect(manager.get(meta.id)?.workspaceWriterClaims).toHaveLength(1);
    await manager.stop(meta.id);
    expect(manager.activity(meta.id)).toMatchObject({ active: false, tearingDown: false });
    expect(manager.get(meta.id)?.status).toBe('idle');
    // The unproven claim stays, but only as Mission admission information.
    expect(manager.get(meta.id)?.workspaceWriterClaims).toHaveLength(1);
    expect(manager.activity(meta.id).uncertain).toBe(true);
    expect(deps.log).toHaveBeenCalledWith('warn', expect.stringContaining('kept for Mission admission only'));
    await manager.send(meta.id, { text: 'Sends again after Stop' });
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1].adapter.send).toHaveBeenCalledTimes(1);
    runtimes[1].finish();
    await manager.setArchived(meta.id, true);
    expect(manager.get(meta.id)?.archived).toBe(true);
    await manager.delete(meta.id);
    expect(manager.get(meta.id)).toBeUndefined();
  });

  it('persists no claim and never routes ordinary sends through Mission admission while ordinary ownership is off', async () => {
    tracking(() => undefined); // Pi with ordinary process ownership off reports "untracked".
    const withWorkspaceDispatch = vi.fn<NonNullable<SessionManagerDeps['withWorkspaceDispatch']>>((_meta, dispatch) => dispatch());
    manager = new SessionManager({ ...deps, withWorkspaceDispatch, ordinaryProcessOwnership: () => false });
    const meta = await manager.create(request());
    await manager.send(meta.id, { text: 'Work' }); runtimes[0].finish();
    await manager.setPermissionMode(meta.id, 'auto');
    expect(withWorkspaceDispatch).not.toHaveBeenCalled();
    expect(manager.get(meta.id)?.workspaceWriterClaims).toBeUndefined();
    await manager.flushPendingPersists();
    const reloaded = new SessionStore(root); await reloaded.load();
    expect(reloaded.get(meta.id)?.workspaceWriterClaims).toBeUndefined();
    await expect(manager.stop(meta.id)).resolves.toBeUndefined();
    expect(manager.activity(meta.id)).toMatchObject({ active: false, uncertain: false, quiescent: true });
  });

  it.each(['stop', 'archive', 'delete', 'move'] as const)('lets an explicit %s release a claim left by an earlier app run', async (action) => {
    const meta = await manager.create(request());
    meta.workspaceWriterClaims = ['writer_crashed']; // The app died while an owned Pi runtime was live.
    await store.upsert(meta);
    const restoredStore = new SessionStore(root); await restoredStore.load();
    const restoredDeps = dependencies(restoredStore);
    const restored = new SessionManager(restoredDeps);
    manager = restored; // afterEach cleans up the manager under test.
    expect(restored.activity(meta.id)).toMatchObject({ uncertain: true, quiescent: false });
    // Quitting is not an acknowledgment; the claim outlives stopAll.
    await restored.send(meta.id, { text: 'Ordinary use works meanwhile' });
    await restored.stopAll();
    expect(restored.get(meta.id)?.workspaceWriterClaims).toEqual(['writer_crashed']);
    if (action === 'stop') await restored.stop(meta.id);
    else if (action === 'archive') await restored.setArchived(meta.id, true);
    else if (action === 'delete') await restored.delete(meta.id);
    else await restored.moveTo(meta.id, path.join(root, 'moved'));
    if (action === 'delete') expect(restored.get(meta.id)).toBeUndefined();
    else {
      expect(restored.get(meta.id)?.workspaceWriterClaims).toBeUndefined();
      expect(restored.activity(meta.id)).toMatchObject({ uncertain: false, quiescent: true });
    }
    expect(restoredDeps.log).toHaveBeenCalledWith('warn', expect.stringContaining('released 1 unproven workspace writer claim'));
  });

  it.each([undefined, 'claude'] as const)('never copies writer claims into a fork (harness: %s)', async (harness) => {
    const meta = await manager.create(request());
    meta.workspaceWriterClaims = ['writer_source'];
    await store.upsert(meta);
    const fork = await manager.fork(meta.id, harness);
    expect(fork?.workspaceWriterClaims).toBeUndefined();
    expect(manager.get(meta.id)?.workspaceWriterClaims).toEqual(['writer_source']);
    await manager.delete(fork!.id);
    expect(manager.get(fork!.id)).toBeUndefined();
  });

  it('bounds a Stop whose disposal hangs and keeps the session usable', async () => {
    manager = new SessionManager({ ...deps, disposeWaitMs: 50 });
    const meta = await manager.create(request());
    await manager.send(meta.id, { text: 'Work' }); runtimes[0].finish();
    const hung = deferred<void>(); runtimes[0].adapter.dispose.mockImplementationOnce(() => hung.promise);
    expect(await within(manager.stop(meta.id))).toBe('settled');
    expect(deps.log).toHaveBeenCalledWith('warn', expect.stringContaining('still shutting down'));
    expect(manager.get(meta.id)?.status).toBe('idle');
    expect(manager.activity(meta.id)).toMatchObject({ tearingDown: true, quiescent: false }); // Admission still sees it.
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

  it('keeps an ordinary send working through admission when its folder disappeared under a live runtime', async () => {
    const admission = new MissionWorkspaceAdmission({ sessions: () => manager.list(), activity: (id) => manager.activity(id), terminals: () => [] });
    manager = new SessionManager({ ...deps, withWorkspaceDispatch: (meta, dispatch) => admission.dispatch(meta.cwd, dispatch), ordinaryProcessOwnership: () => true });
    const folder = path.join(root, 'project'); await fs.mkdir(folder);
    const meta = await manager.create(request(folder));
    await manager.send(meta.id, { text: 'First' }); runtimes[0].finish();
    await fs.rm(folder, { recursive: true, force: true });
    await manager.send(meta.id, { text: 'Still accepted' });
    expect(runtimes[0].adapter.send).toHaveBeenCalledTimes(2);
    admission.close();
  });

  it('never rejects stopAll at quit, so persistence can still be flushed', async () => {
    const ordinary = await manager.create(request());
    await manager.send(ordinary.id, { text: 'Work' });
    runtimes[0].adapter.dispose.mockRejectedValueOnce(new Error('ordinary dispose failed'));
    await manager.createManaged(request(), { id: 'managed', cwd: root, ownership: { missionId: 'mission', role: 'worker', generation: 1, attemptId: 'attempt', sourceAccess: 'assigned_workspace', requestedTools: [], reasoningDefault: true } });
    const hooks: MissionSessionHooks = { beforeDispatch: async () => undefined, mcpServers: async (_meta, existing) => existing };
    manager.attachMissionHooks(hooks);
    await manager.sendManaged('managed', { text: 'Work' }, 1);
    runtimes[1].adapter.dispose.mockRejectedValueOnce(new Error('managed dispose failed'));
    await expect(manager.stopAll()).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('warn', expect.stringContaining('managed dispose failed'));
    await expect(manager.flushPendingPersists()).resolves.toBeUndefined();
    runtimes[1].adapter.dispose.mockImplementation(async () => undefined);
    await manager.stopManaged('managed', 1);
  });
});

describe('ordinary process ownership predicate and Job helper probe', () => {
  const configured = () => {
    const mission = createDefaultMissionConfig();
    mission.presets.push({ id: 'lead', revision: 1, name: 'Lead', harnessId: 'pi', model: { provider: 'fixture', model: 'lead' }, reasoning: { kind: 'default' }, enabled: true });
    mission.tiers.find((tier) => tier.id === 5)!.presetIds.push('lead');
    mission.defaultLeadPresetId = 'lead';
    return mission;
  };

  it('counts Missions as configured only with a default T5 lead, globally or per project', () => {
    expect(missionsConfigured({})).toBe(false);
    expect(missionsConfigured({ mission: createDefaultMissionConfig() })).toBe(false);
    expect(missionsConfigured({ mission: configured() })).toBe(true);
    const unset = configured(); delete unset.defaultLeadPresetId;
    expect(missionsConfigured({ mission: unset, missionProjects: { [root]: { schemaVersion: 1, revision: 1, defaultLeadPresetId: 'lead' } } })).toBe(true);
    expect(missionsConfigured({ mission: configured(), missionProjects: { [root]: { schemaVersion: 1, revision: 1, defaultLeadPresetId: null } } })).toBe(true);
  });

  it('runs one lazy probe, treats not-yet-known as unavailable, and gates on Windows plus configuration', async () => {
    const result = deferred<boolean>();
    const run = vi.fn(() => result.promise);
    const probe = new OwnedWindowsJobProbe(run);
    const mission = configured();
    expect(ordinaryProcessOwnership({ mission }, probe, 'linux')).toBe(false);
    expect(ordinaryProcessOwnership({ mission: createDefaultMissionConfig() }, probe, 'win32')).toBe(false);
    expect(run).not.toHaveBeenCalled(); // Nobody without Missions configured ever launches the helper.
    expect(ordinaryProcessOwnership({ mission }, probe, 'win32')).toBe(false); // Unknown counts as unavailable.
    expect(probe.capability).toBe('unknown');
    result.resolve(true);
    await probe.start();
    expect(ordinaryProcessOwnership({ mission }, probe, 'win32')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    const failing = new OwnedWindowsJobProbe(async () => { throw new Error('blocked by policy'); });
    expect(await failing.start()).toBe(false);
    expect(ordinaryProcessOwnership({ mission }, failing, 'win32')).toBe(false);
    expect(failing.capability).toBe('unavailable');
  });

  it.runIf(process.platform === 'win32')('probes the real bundled helper on this machine and rejects a missing one', async () => {
    expect(await probeOwnedWindowsJob(path.resolve('resources/mission/windows-check-job.ps1'))).toBe(true);
    expect(await probeOwnedWindowsJob(path.join(root, 'missing-helper.ps1'))).toBe(false);
  }, 60_000);
});

/** A PTY stand-in: records calls and lets the test drive exits. */
function fakePty(pid = 4242) {
  const exits = new Set<(exit: { exitCode: number; signal?: number }) => void>();
  return {
    pid, cols: 80, rows: 24, process: 'fake', handleFlowControl: false,
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener: (exit: { exitCode: number; signal?: number }) => void) => { exits.add(listener); return { dispose: () => { exits.delete(listener); } }; },
    write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(), clear: vi.fn(),
    exit: (exitCode = 1) => { for (const listener of [...exits]) listener({ exitCode }); },
  };
}

describe('ordinary terminals', () => {
  const managers: TerminalManager[] = [];
  afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.closeAll())); });

  async function terminals(options: Partial<TerminalManagerDeps> = {}) {
    const dir = path.join(root, `terminals-${randomUUID()}`);
    const ptys: ReturnType<typeof fakePty>[] = [];
    const spawn = vi.fn((file: string) => { const pty = Object.assign(fakePty(4242 + ptys.length), { file }); ptys.push(pty); return pty as unknown as IPty; });
    const spawnOwned = vi.fn<NonNullable<TerminalManagerDeps['spawnOwned']>>();
    const log = vi.fn();
    const manager = new TerminalManager({
      dir, version: 'test', cwdOf: (id) => id === 'broken' ? path.join(root, 'broken-cwd') : root,
      settings: () => ({ ...DEFAULT_TERMINAL_SETTINGS, shell: 'custom', customShellPath: 'test-shell' }),
      isManaged: () => false, windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'),
      spawn, spawnOwned, killTree: (pty) => pty.kill(), push: vi.fn(), log, ...options,
    });
    managers.push(manager);
    return { manager, dir, ptys, spawn, spawnOwned, log };
  }

  /** Runs with process.platform reporting Windows, where ordinary shells can be Job-contained. */
  async function asWindows<T>(run: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
    try { return await run(); } finally { Object.defineProperty(process, 'platform', original); }
  }

  it('spawns directly with ordinary ownership off: no Job, no gate, no records, and nothing left after exit', async () => {
    const beforeSpawn = vi.fn();
    await asWindows(async () => {
      const { manager, dir, ptys, spawnOwned } = await terminals({ beforeSpawn });
      const failed = manager.create('source');
      const closed = manager.create('source');
      expect(spawnOwned).not.toHaveBeenCalled();
      expect(beforeSpawn).not.toHaveBeenCalled();
      expect(await fs.readdir(dir).catch(() => [])).toEqual([]);
      expect(manager.activity('source')).toEqual([expect.objectContaining({ state: 'live' }), expect.objectContaining({ state: 'live' })]);
      ptys[0].exit(1);
      ptys[1].exit(0);
      expect(manager.activity('source')).toEqual([]);
      await vi.waitFor(() => expect(manager.list().map((t) => t.id)).toEqual([failed.id]));
      expect(manager.list()[0].exit?.code).toBe(1);
      expect(closed.id).not.toBe(failed.id);
    });
  });

  it('wraps an ordinary Windows shell only once the helper probe reported it available', async () => {
    await asWindows(async () => {
      const result = deferred<boolean>();
      const probe = new OwnedWindowsJobProbe(() => result.promise);
      const mission = (() => {
        const config = createDefaultMissionConfig();
        config.presets.push({ id: 'lead', revision: 1, name: 'Lead', harnessId: 'pi', model: { provider: 'fixture', model: 'lead' }, reasoning: { kind: 'default' }, enabled: true });
        config.tiers.find((tier) => tier.id === 5)!.presetIds.push('lead');
        config.defaultLeadPresetId = 'lead';
        return config;
      })();
      const { manager, spawnOwned, spawn } = await terminals({ ordinaryProcessOwnership: () => ordinaryProcessOwnership({ mission }, probe) });
      spawnOwned.mockImplementation((file, args, options, start) => ({ pty: start(file, args, options), quiescent: new Promise<void>(() => undefined), close: vi.fn() }));
      manager.create('source'); // Probe still running: a synchronous spawn cannot wait.
      expect(spawnOwned).not.toHaveBeenCalled();
      result.resolve(true); await probe.start();
      manager.create('source');
      expect(spawnOwned).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(2);
    });
  });

  it('falls back to a plain shell in the same tab when an ordinary Job launch never ran the shell', async () => {
    await asWindows(async () => {
      const { manager, dir, ptys, spawnOwned, spawn } = await terminals({ ordinaryProcessOwnership: () => true });
      let refuse!: (error: Error) => void;
      spawnOwned.mockImplementation((file, args, options, start) => {
        const established = new Promise<void>((_, reject) => { refuse = reject; });
        return { pty: start(file, args, options), quiescent: new Promise<void>(() => undefined), established, close: vi.fn() };
      });
      const terminal = manager.create('source');
      expect(spawnOwned).toHaveBeenCalledTimes(1);
      refuse(new Error('Job supervisor exited before establishing process ownership'));
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
      expect(ptys[0].kill).toHaveBeenCalledTimes(1); // Only the supervisor, which never started the shell.
      expect(manager.list()).toEqual([expect.objectContaining({ id: terminal.id, exit: undefined })]);
      expect(manager.activity('source')).toEqual([expect.objectContaining({ state: 'live', pid: 4243 })]);
      expect((await fs.readdir(dir)).filter((file) => file.endsWith('.owner'))).toEqual([]);
      ptys[1].exit(1);
      expect(manager.activity('source')).toEqual([]);
    });
  });

  it('falls back synchronously when an ordinary Job launch throws, while a managed shell still fails closed', async () => {
    await asWindows(async () => {
      const ordinary = await terminals({ ordinaryProcessOwnership: () => true });
      ordinary.spawnOwned.mockImplementation(() => { throw new Error('Job helper blocked by policy'); });
      ordinary.manager.create('source');
      expect(ordinary.spawn).toHaveBeenCalledTimes(1);
      expect(ordinary.manager.activity('source')).toEqual([expect.objectContaining({ state: 'live' })]);
      const managed = await terminals({ isManaged: () => true });
      managed.spawnOwned.mockImplementation(() => { throw new Error('Job helper blocked by policy'); });
      expect(() => managed.manager.create('lead')).toThrow(/Job helper blocked by policy/);
      expect(managed.spawn).not.toHaveBeenCalled();
    });
  });

  it('retires settled and legacy ownership records at load, and keeps a broken session record only as that session\'s uncertainty', async () => {
    const { dir, log } = await terminals();
    const sessions = path.join(dir, 'process-ownership');
    await fs.mkdir(dir, { recursive: true });
    // An earlier build's record of an ordinary shell it never contained.
    await fs.writeFile(path.join(dir, 't_old.p_legacy.owner'), JSON.stringify({ terminalId: 't_old', sessionId: 'source', cwd: root, reportedCwd: root, managed: false, state: 'uncertain' }));
    // A positively settled generation whose records a crash left behind.
    const settled = createProcessOwnershipIntent(path.join(sessions, 'source'), { kind: 'terminal', sessionId: 'source', terminalId: 't_done', cwd: root });
    recordUnlaunchedProcessIntent(settled);
    await fs.writeFile(path.join(dir, `t_done.${settled.record.nonce}.owner`), JSON.stringify({ terminalId: 't_done', sessionId: 'source', cwd: root, reportedCwd: root, managed: false, state: 'uncertain', ownershipNonce: settled.record.nonce }));
    // What an interrupted cleanup leaves: a receipt without its intent.
    await fs.writeFile(path.join(sessions, 'source', `${randomUUID()}.receipt.json`), '{}');
    // An unreadable intent of another session.
    const broken = path.join(sessions, 'broken', `${randomUUID()}.intent.json`);
    await fs.mkdir(path.dirname(broken), { recursive: true });
    await fs.writeFile(broken, '{partial');
    const restored = new TerminalManager({ dir, version: 'test', settings: () => DEFAULT_TERMINAL_SETTINGS, cwdOf: (id) => id === 'broken' ? path.join(root, 'broken-cwd') : root, push: vi.fn(), log });
    managers.push(restored);
    await restored.load(); // Never fails the app start.
    expect((await fs.readdir(dir)).filter((file) => file.endsWith('.owner'))).toEqual([]);
    expect(await fs.readdir(path.join(sessions, 'source')).catch(() => [])).toEqual([]);
    expect(restored.activity()).toEqual([expect.objectContaining({ sessionId: 'broken', cwd: path.join(root, 'broken-cwd'), state: 'uncertain' })]);
    expect(await fs.readFile(broken, 'utf8')).toBe('{partial');
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('broken'));
    // An attributable problem stays that session's uncertainty; other sessions' recovery proceeds.
    await expect(restored.reconcileOwnership(new Set(['source']))).resolves.toBeUndefined();
  });
});
