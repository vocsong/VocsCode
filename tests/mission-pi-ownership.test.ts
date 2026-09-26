/** Scripted ownership failures through the real Pi adapter and SessionManager/SessionStore. */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { existsSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../src/main/harness/pi';
import type { HarnessContext } from '../src/main/harness/types';
import { createAdapter } from '../src/main/harness/registry';
import { SessionManager, type SessionManagerDeps } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { MissionWorkspaceAdmission } from '../src/main/mission/admission';
import type { OwnedWindowsJob, OwnedWindowsJobOptions } from '../src/main/owned-windows-job';
import { inspectManagedPiOwnership } from '../src/main/harness/pi-ownership';
import { deferred } from '../src/main/util/async';

const processApi = vi.hoisted(() => ({ spawn: vi.fn(), spawnTool: vi.fn(), shutdownChild: vi.fn(), owned: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => args[0] === 'owned-supervisor-fixture' ? processApi.spawn(...args) : actual.spawn(...args) };
});
vi.mock('../src/main/harness/spawn', async (original) => ({
  ...await original<typeof import('../src/main/harness/spawn')>(),
  spawnTool: (...args: unknown[]) => processApi.spawnTool(...args),
  shutdownChild: (...args: unknown[]) => processApi.shutdownChild(...args),
}));
vi.mock('../src/main/owned-windows-job', async (original) => ({
  ...await original<typeof import('../src/main/owned-windows-job')>(),
  launchOwnedWindowsJob: (options: OwnedWindowsJobOptions<ChildProcess>) => processApi.owned(options),
  spawnIndependentWindowsSupervisor: (file: string, args: string[], options: object) => processApi.spawn(file, args, options),
}));
vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
vi.mock('../src/main/pi-agents', () => ({ installPiAgentOverrides: vi.fn() }));

let root: string, manager: SessionManager, store: SessionStore;
let deps: SessionManagerDeps;
let adapters: PiAdapter[], contexts: HarnessContext[], controls: ReturnType<typeof controller>[];
let commands: Record<string, unknown>[];
let helperAvailable: boolean;
/** Ordinary process ownership (Windows + Missions configured + working helper) for ordinary Pi. */
let ordinaryOwnership: boolean;
const settings = defaultSettings();
settings.providers = []; settings.mcpDisabledBuiltins = ['gitnexus', 'vocs-memory', 'cua-driver'];
settings.autoCompactionThreshold = undefined;

function scriptedChild(env: NodeJS.ProcessEnv): ChildProcess {
  const child = new EventEmitter(); const stdout = new PassThrough();
  const emit = (event: object) => stdout.write(JSON.stringify(event) + '\n');
  const model = { provider: 'fixture', id: 'fixed', name: 'Fixture' };
  const stdin = new Writable({ write(chunk, _encoding, done) {
    const command = JSON.parse(String(chunk)); commands.push(command);
    queueMicrotask(() => {
      if (command.type === 'get_state') for (const capability of ['approvals', 'tools', 'mcp', 'mission', 'subagents']) emit({
        type: 'extension_ui_request', method: 'notify', message: 'VCODE_PI_READY::' + JSON.stringify({
          version: 1, nonce: env.VOCS_CODE_PI_NONCE, capability, ready: true,
          ...(capability === 'mission' ? { tools: ['read', 'mission_read', 'mission_report'] } : {}),
        }),
      });
      emit({ type: 'response', id: command.id, command: command.type, success: true,
        data: command.type === 'get_state' ? { model, thinkingLevel: 'off' } : command.type === 'get_available_models' ? { models: [model] } : {},
      });
    });
    done();
  } });
  return Object.assign(child, { stdin, stdout, stderr: new PassThrough(), exitCode: null, signalCode: null }) as unknown as ChildProcess;
}

function controller(child: ChildProcess, intent?: OwnedWindowsJobOptions<ChildProcess>['ownershipIntent']) {
  const quiet = deferred<void>(); void quiet.promise.catch(() => undefined);
  let state: OwnedWindowsJob<ChildProcess>['state'] = 'live';
  const cancel = vi.fn(() => { if (state !== 'quiescent') state = 'closing'; });
  return {
    process: child, quiescent: quiet.promise, cancel,
    get state() { return state; },
    prove() {
      if (intent) {
        const record = JSON.parse(readFileSync(intent.path, 'utf8'));
        writeFileSync(intent.path.replace('.intent.json', '.receipt.json'), JSON.stringify({ ...record, intentHash: intent.hash, source: 'supervisor', outcome: 'job_empty', quiescent: true, childTreeZero: true, completedAt: Date.now() }));
      }
      state = 'quiescent'; quiet.resolve();
    },
    loseReceipt() { state = 'uncertain'; quiet.reject(new Error('Owned Job receipt lost')); },
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-pi-ownership-'));
  store = new SessionStore(path.join(root, 'data')); await store.load();
  adapters = []; contexts = []; controls = []; commands = []; helperAvailable = true; ordinaryOwnership = false;
  processApi.spawn.mockImplementation((_file, _args, options) => scriptedChild(options.env));
  processApi.spawnTool.mockImplementation((_file, _args, options) => scriptedChild(options.env));
  processApi.shutdownChild.mockImplementation(async (child: ChildProcess) => { child.emit('close', 0); });
  processApi.owned.mockImplementation((options: OwnedWindowsJobOptions<ChildProcess>) => {
    const owned = controller(options.launch('owned-supervisor-fixture', []), options.ownershipIntent); controls.push(owned); return owned;
  });
  vi.mocked(createAdapter).mockImplementation((_id, ctx) => { contexts.push(ctx); const adapter = new PiAdapter(ctx); adapters.push(adapter); return adapter; });
  deps = {
    store, settings: { get: () => settings, update: async () => settings } as unknown as SettingsStore,
    runtime: { resolve: () => ({ path: path.join(root, 'pi.exe'), source: 'installed' }), resource: (...parts: string[]) => path.resolve(helperAvailable ? 'resources' : path.join(root, 'missing-resources'), ...parts) } as never,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn(), recordSubagent: vi.fn() } as never,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
    ordinaryProcessOwnership: () => ordinaryOwnership,
  };
  manager = new SessionManager(deps);
  manager.attachMissionHooks({ beforeDispatch: async () => undefined,
    mcpServers: async () => [{ def: { id: 'vocs-mission', transport: 'http', url: 'http://127.0.0.1:1', headers: { Authorization: 'Bearer ownership-test-secret' } }, missing: [], secretEnvKeys: [], secretHeaderKeys: [] }],
  });
  await manager.createManaged({ title: 'Managed Pi', config: { harness: 'pi', permissionMode: 'full-auto', projectRoot: root, model: { provider: 'fixture', model: 'fixed' } } }, {
    id: 'managed', cwd: root,
    ownership: { missionId: 'mission', role: 'worker', generation: 1, attemptId: 'attempt', sourceAccess: 'assigned_workspace', requestedTools: [], reasoningDefault: true },
  });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const owned of controls) { owned.prove(); owned.cancel.mockImplementation(() => undefined); }
  await manager.stopAll().catch(() => undefined);
  await Promise.all(adapters.map((adapter) => adapter.dispose().catch(() => undefined)));
  await manager.flushPendingPersists();
  vi.restoreAllMocks(); vi.clearAllMocks();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const prepare = async () => {
  expect((await manager.prepareManaged('managed', 1)).readiness.ready).toBe(true);
  expect(processApi.owned).toHaveBeenCalledTimes(1);
  expect(processApi.owned.mock.calls[0][0].helperPath).toBe(path.resolve('resources', 'mission', 'windows-check-job.ps1'));
  expect(processApi.spawnTool).not.toHaveBeenCalled();
};

describe.runIf(process.platform === 'win32')('managed Pi ownership evidence', () => {
  it('leaves an exact not-started receipt when a managed launch cannot resolve Pi', async () => {
    // The service normally records the launch nonce and binds it before start; here the missing
    // executable is the point: the write-ahead intent must exist anyway, with a positive
    // not-started receipt, so restart recovery does not read the dispatch as unknown ownership.
    const runtime = deps.runtime as { resource: (...parts: string[]) => string };
    manager = new SessionManager({ ...deps, runtime: { resolve: () => null, resource: runtime.resource } as never });
    manager.attachMissionHooks({ beforeDispatch: async () => undefined,
      mcpServers: async () => [{ def: { id: 'vocs-mission', transport: 'http', url: 'http://127.0.0.1:1', headers: { Authorization: 'Bearer ownership-test-secret' } }, missing: [], secretEnvKeys: [], secretHeaderKeys: [] }],
    });
    await expect(manager.prepareManaged('managed', 1)).rejects.toThrow(/pi is not installed/);
    expect(processApi.owned).not.toHaveBeenCalled();
    const dir = path.join(store.sessionDir('managed'), 'pi', 'process-ownership');
    const intents = (await fs.readdir(dir)).filter((name) => name.endsWith('.intent.json'));
    expect(intents).toHaveLength(1);
    const nonce = intents[0].slice(0, -'.intent.json'.length);
    await expect(inspectManagedPiOwnership(store.sessionDir('managed'), { sessionId: 'managed', missionId: 'mission', generation: 1, nonce })).resolves.toMatchObject({ state: 'quiescent', quiescent: true, intents: 1 });
  });

  it('keeps root exit unavailable until a positive Job receipt, not generic shutdownChild', async () => {
    await prepare(); const completed = vi.fn();
    const stopping = manager.stopManaged('managed', 1).then(completed);
    await vi.waitFor(() => expect(controls[0].cancel).toHaveBeenCalledTimes(1));
    controls[0].process.emit('close', 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completed).not.toHaveBeenCalled();
    expect(manager.activity('managed')).toMatchObject({ active: true, tearingDown: true, quiescent: false });
    await expect(adapters[0].start()).rejects.toThrow('ownership must be released');
    controls[0].prove(); await stopping;
    expect(completed).toHaveBeenCalledTimes(1);
    expect(manager.activity('managed')).toMatchObject({ active: false, quiescent: true });
    expect(processApi.shutdownChild).not.toHaveBeenCalled();
  });

  it('retains SessionManager ownership and blocks capture, dispatch and readiness after an uncertain stop; scoped retry releases it', async () => {
    await prepare();
    controls[0].cancel.mockImplementationOnce(() => { throw new Error('Owned Job query unavailable'); });
    await expect(manager.stopManaged('managed', 1)).rejects.toThrow('Owned Job query unavailable');
    expect(manager.activity('managed')).toMatchObject({ active: true, tearingDown: true, uncertain: true, quiescent: false });
    await expect(manager.prepareManaged('managed', 1)).rejects.toThrow('not idle');
    await expect(manager.sendManaged('managed', { text: 'must not start' }, 1)).rejects.toThrow('not ready');
    await expect(manager.updateManaged('managed', 1, { mission: { generation: 2 } })).rejects.toThrow('not quiescent');
    expect(await adapters[0].missionReadiness()).toMatchObject({ ready: false, tools: [] });
    const admission = new MissionWorkspaceAdmission({ sessions: () => manager.list(), activity: (id) => manager.activity(id), terminals: () => [] });
    try { expect(await admission.acquire(root)).toBeUndefined(); } finally { admission.close(); }
    controls[0].cancel.mockImplementation(() => controls[0].prove());
    await manager.stopManaged('managed', 1);
    expect(controls[0].cancel).toHaveBeenCalledTimes(2);
    expect(manager.activity('managed')).toMatchObject({ active: false, uncertain: false, quiescent: true });
    expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
    expect(processApi.owned).toHaveBeenCalledTimes(1);
  });

  it('does not turn a disposal deadline into proof, and a later receipt can complete the retry', async () => {
    await prepare(); vi.useFakeTimers();
    const stopping = manager.stopManaged('managed', 1);
    const rejected = expect(stopping).rejects.toThrow('process-tree teardown timed out');
    await vi.advanceTimersByTimeAsync(15_001); await rejected;
    expect(manager.activity('managed')).toMatchObject({ active: true, uncertain: true, quiescent: false });
    expect(await adapters[0].missionReadiness()).toMatchObject({ ready: false });
    controls[0].prove(); await manager.stopManaged('managed', 1);
    expect(controls[0].cancel).toHaveBeenCalledTimes(2);
    expect(manager.activity('managed')).toMatchObject({ active: false, quiescent: true });
  });

  it('shares a successful ownership receipt across concurrent disposal callers', async () => {
    await prepare();
    const first = adapters[0].dispose(); const second = adapters[0].dispose();
    controls[0].prove();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(await adapters[0].missionReadiness()).toMatchObject({ ready: false });
    expect(processApi.owned).toHaveBeenCalledTimes(1);
  });

  it('never treats a lost receipt plus root exit as safe disposal or allows a replacement process', async () => {
    await prepare(); controls[0].loseReceipt(); controls[0].process.emit('close', 0);
    await expect(manager.stopManaged('managed', 1)).rejects.toThrow('Owned Job receipt lost');
    expect(manager.activity('managed')).toMatchObject({ active: true, uncertain: true, quiescent: false });
    await expect(adapters[0].start()).rejects.toThrow('ownership must be released');
    await expect(adapters[0].dispose()).rejects.toThrow('Owned Job receipt lost');
    expect(processApi.owned).toHaveBeenCalledTimes(1);
    expect(processApi.shutdownChild).not.toHaveBeenCalled();
    // A later exact durable proof plus the already-observed supervisor close can recover a lost
    // pipe. Neither alone released ownership above, and no replacement launch was needed.
    controls[0].prove();
    await manager.stopManaged('managed', 1);
    expect(manager.activity('managed')).toMatchObject({ active: false, uncertain: false, quiescent: true });
  });

  it('cannot spawn after disposal returned while managed startup was waiting on its bridge', async () => {
    await prepare(); controls[0].prove(); await manager.stopManaged('managed', 1);
    processApi.owned.mockClear();
    const servers = await contexts[0].mcpServers().catch(() => []);
    const bridge = deferred<Awaited<ReturnType<HarnessContext['mcpServers']>>>();
    const mcpServers = vi.fn(() => bridge.promise);
    const adapter = new PiAdapter({ ...contexts[0], mcpServers }); adapters.push(adapter);
    const starting = adapter.start();
    await vi.waitFor(() => expect(mcpServers).toHaveBeenCalledTimes(1));
    await expect(adapter.start()).rejects.toThrow('ownership must be released');
    expect(mcpServers).toHaveBeenCalledTimes(1);
    await adapter.dispose();
    bridge.resolve(servers.length ? servers : [{ def: { id: 'vocs-mission', transport: 'http', url: 'http://127.0.0.1:1', headers: { Authorization: 'Bearer startup-test-secret' } }, missing: [], secretEnvKeys: [], secretHeaderKeys: [] }]);
    await expect(starting).rejects.toThrow('startup was canceled');
    expect(processApi.owned).not.toHaveBeenCalled();
  });

  it('bounds ordinary Pi while ordinary ownership is enabled and retains writers through mode changes and root idle', async () => {
    ordinaryOwnership = true;
    const source = await manager.create({ title: 'Ordinary', config: { harness: 'pi', permissionMode: 'full-auto', projectRoot: root } });
    await manager.send(source.id, { text: 'Background work' });
    expect(processApi.owned).toHaveBeenCalledTimes(1); expect(processApi.spawnTool).not.toHaveBeenCalled();
    const child = controls[0].process;
    (child.stdout as PassThrough).write(JSON.stringify({ type: 'agent_end' }) + '\n');
    await vi.waitFor(() => expect(manager.activity(source.id).turn).toBe(false));
    await manager.setPermissionMode(source.id, 'plan');
    const admission = new MissionWorkspaceAdmission({ sessions: () => manager.list(), activity: (id) => manager.activity(id), terminals: () => [] });
    expect(await admission.acquire(root)).toBeUndefined();
    const stopping = manager.stop(source.id);
    await vi.waitFor(() => expect(controls[0].cancel).toHaveBeenCalledTimes(1));
    child.emit('close', 0);
    expect(manager.activity(source.id)).toMatchObject({ active: true, tearingDown: true, quiescent: false });
    expect(await admission.acquire(root)).toBeUndefined();
    controls[0].prove(); await stopping;
    const lease = await admission.acquire(root); expect(lease).toBeDefined(); await lease!.assertQuiescent(); await lease!.release(); admission.close();
    expect(processApi.shutdownChild).not.toHaveBeenCalled();
  });

  it.each(['synchronous', 'asynchronous'] as const)('falls back to a plain untracked Pi when an owned launch fails %sly before Pi ever ran', async (failure) => {
    ordinaryOwnership = true;
    processApi.owned.mockImplementation((options: OwnedWindowsJobOptions<ChildProcess>) => {
      if (failure === 'synchronous') throw new Error('Job helper blocked by policy');
      const owned = controller(options.launch('owned-supervisor-fixture', []), options.ownershipIntent); controls.push(owned);
      const established = Promise.reject(new Error('Job supervisor exited before establishing process ownership'));
      established.catch(() => undefined);
      return Object.assign(owned, { established });
    });
    const source = await manager.create({ title: 'Ordinary', config: { harness: 'pi', permissionMode: 'full-auto', projectRoot: root } });
    await manager.send(source.id, { text: 'Still works' });
    expect(processApi.owned).toHaveBeenCalledTimes(1);
    expect(processApi.spawnTool).toHaveBeenCalledTimes(1);
    expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(1);
    expect(adapters.at(-1)!.workspaceWriterState()).toBeUndefined();
    await manager.stop(source.id);
    expect(manager.get(source.id)?.workspaceWriterClaims).toBeUndefined();
    expect(manager.activity(source.id)).toMatchObject({ active: false, uncertain: false, quiescent: true });
  });

  it('does not require stopping a fixed read-only ordinary Pi source without child work', async () => {
    helperAvailable = false;
    const source = await manager.create({ title: 'Discussion', config: { harness: 'pi', permissionMode: 'plan', projectRoot: root } });
    await manager.send(source.id, { text: 'Read-only discussion' });
    (processApi.spawnTool.mock.results[0].value.stdout as PassThrough).write(JSON.stringify({ type: 'agent_end' }) + '\n');
    await vi.waitFor(() => expect(manager.activity(source.id).turn).toBe(false));
    const admission = new MissionWorkspaceAdmission({ sessions: () => manager.list(), activity: (id) => manager.activity(id), terminals: () => [] });
    const lease = await admission.acquire(root); expect(lease).toBeDefined(); await lease!.assertQuiescent(); await lease!.release(); admission.close();
    expect(processApi.shutdownChild).not.toHaveBeenCalled(); expect(processApi.owned).not.toHaveBeenCalled();
  });

  it('refuses managed POSIX startup and readiness without an equivalent descendant proof', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...original, value: 'linux' });
      await expect(manager.prepareManaged('managed', 1)).rejects.toThrow('ownership is unverified on this platform');
      expect(await adapters[0].missionReadiness()).toMatchObject({ ready: false, tools: [], reason: expect.stringContaining('unverified on this platform') });
      expect(processApi.owned).not.toHaveBeenCalled(); expect(processApi.spawnTool).not.toHaveBeenCalled();
      expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
    } finally { Object.defineProperty(process, 'platform', original); }
  });
});

// The macOS/Linux regression: ordinary Pi must behave exactly as before wherever ordinary process
// ownership is off, so this block runs on every platform.
describe('ordinary Pi without process ownership', () => {
  it.each([
    ['ordinary ownership is off', false, true],
    ['the helper is missing although ownership is on', true, false],
  ])('runs ordinary Pi untracked when %s: plain spawn, graceful stop, no claim, and the session keeps working', async (_case, enabled, helper) => {
    ordinaryOwnership = enabled; helperAvailable = helper;
    processApi.owned.mockImplementation((options: OwnedWindowsJobOptions<ChildProcess>) => {
      if (!existsSync(options.helperPath)) throw new Error('Process ownership requires the bundled Windows Job Object helper');
      const owned = controller(options.launch('owned-supervisor-fixture', []), options.ownershipIntent); controls.push(owned); return owned;
    });
    const source = await manager.create({ title: 'Ordinary', config: { harness: 'pi', permissionMode: 'full-auto', projectRoot: root } });
    await manager.send(source.id, { text: 'First' });
    expect(processApi.spawnTool).toHaveBeenCalledTimes(1);
    expect(controls).toHaveLength(0);
    expect(adapters.at(-1)!.workspaceWriterState()).toBeUndefined();
    expect(manager.get(source.id)?.workspaceWriterClaims).toBeUndefined();
    (processApi.spawnTool.mock.results[0].value.stdout as PassThrough).write(JSON.stringify({ type: 'agent_end' }) + '\n');
    await vi.waitFor(() => expect(manager.activity(source.id).turn).toBe(false));
    expect(manager.activity(source.id)).toMatchObject({ active: true, processes: false, uncertain: false, quiescent: true });
    await manager.stop(source.id);
    expect(processApi.shutdownChild).toHaveBeenCalledTimes(1); // Stdin EOF first, exactly as before.
    await manager.send(source.id, { text: 'A new runtime after stop' });
    expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(2);
    await manager.setArchived(source.id, true);
    await manager.delete(source.id);
    expect(manager.get(source.id)).toBeUndefined();
    expect(processApi.shutdownChild).toHaveBeenCalledTimes(2);
  });
});
