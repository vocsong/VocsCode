import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessContext } from '../src/main/harness/types';
import type { SessionEvent, SessionMeta } from '../src/shared/types';
import { MissionToolBroker, type MissionToolHost } from '../src/main/mission/tools';
import { PiAdapter } from '../src/main/harness/pi';
import { inspectManagedPiOwnership } from '../src/main/harness/pi-ownership';
import type { OwnedWindowsJob, OwnedWindowsJobOptions } from '../src/main/owned-windows-job';
import { ClaudeAdapter } from '../src/main/harness/claude';
import { gateAction, isTrustedMissionCoordination } from '../src/main/harness/permissions';
import { closeMcpBridge, loadMcpBridge, mcpReadOnlyToolNames } from '../resources/pi/vocs-code-mcp';
import { MISSION_PI_CORE_TOOLS } from '../resources/pi/vocs-code-mission';
import { deferred } from '../src/main/util/async';
import { STATIC_MODELS_BY_PROVIDER } from '../src/main/models/static-models';

const sdk = vi.hoisted(() => ({ query: vi.fn(), createSdkMcpServer: vi.fn(), tool: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk);
const spawn = vi.hoisted(() => ({ spawnTool: vi.fn(), shutdownChild: vi.fn(), usesWindowsCommandShim: () => false }));
vi.mock('../src/main/harness/spawn', () => spawn);
const processApi = vi.hoisted(() => ({ supervisor: vi.fn(), owned: vi.fn() }));
vi.mock('../src/main/owned-windows-job', async (original) => ({
  ...await original<typeof import('../src/main/owned-windows-job')>(),
  launchOwnedWindowsJob: (options: OwnedWindowsJobOptions<ChildProcess>) => processApi.owned(options),
  spawnIndependentWindowsSupervisor: (file: string, args: string[], options: SpawnOptionsWithoutStdio) => processApi.supervisor(file, args, options),
}));
const overrides = vi.hoisted(() => vi.fn());
vi.mock('../src/main/pi-agents', () => ({ installPiAgentOverrides: overrides }));
const roots: string[] = [];
const brokers: MissionToolBroker[] = [];
const adapters: (PiAdapter | ClaudeAdapter)[] = [];
const jobs: (OwnedWindowsJob<ChildProcess> & { releaseTeardown(): void; close(): void })[] = [];
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  sdk.tool.mockImplementation((name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }));
  sdk.createSdkMcpServer.mockImplementation(({ name }) => ({ type: 'sdk', name, instance: {} }));
  sdk.query.mockImplementation(() => {
    const closed = deferred<void>();
    const bridgeTools = sdk.tool.mock.results.map((entry) => ({ name: entry.value.name }));
    return {
      [Symbol.asyncIterator]: async function* () { await closed.promise; }, close: () => closed.resolve(), interrupt: vi.fn(), setPermissionMode: vi.fn(),
      initializationResult: async () => ({ hooks_applied: true, models: [{ value: 'fixed-model' }], account: {} }),
      mcpServerStatus: async () => [{ name: 'vocs-mission', source: 'sdk', status: 'connected', tools: bridgeTools }],
    };
  });
});
afterEach(async () => {
  // Release a deliberately delayed receipt even when a test failed before reaching its release.
  const owned = jobs.splice(0);
  for (const job of owned) job.releaseTeardown();
  const cleanup = await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
  cleanup.push(...await Promise.allSettled([
    Promise.resolve().then(() => closeMcpBridge()),
    ...brokers.splice(0).map((broker) => broker.close()),
  ]));
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  cleanup.push(...await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));
  expect(cleanup.filter((result) => result.status === 'rejected')).toEqual([]);
  expect(owned.every((job) => job.state === 'quiescent' && job.process.exitCode === 0 && job.process.stdin?.destroyed && job.process.stdout?.destroyed && job.process.stderr?.destroyed)).toBe(true);
});

async function host(harness: 'pi' | 'claude', role: 'lead' | 'worker' = 'lead', questionId?: string) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mission-adapters-'));
  roots.push(root);
  const events: SessionEvent[] = [];
  const logs: string[] = [];
  const invoke = vi.fn<MissionToolHost['invoke']>(async () => ({ revision: 2 }));
  const broker = new MissionToolBroker({ validate: () => {}, invoke });
  brokers.push(broker);
  await broker.start();
  const server = broker.attach({ missionId: 'm1', ...(questionId ? { questionId } : {}), actor: role === 'lead' ? { kind: 'lead', sessionId: 's1', generation: 1 } : { kind: 'worker', sessionId: 's1', generation: 1, attemptId: 'a1' } });
  const meta: SessionMeta = {
    id: 's1', title: 'Mission', createdAt: 0, updatedAt: 0, cwd: root, status: 'idle', harnessRef: {},
    config: { harness, projectRoot: root, permissionMode: 'full-auto', model: { provider: 'anthropic', model: 'fixed-model' }, appendSystemPrompt: 'PROJECT_INSTRUCTIONS_PRESERVED' },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    mission: { missionId: 'm1', role, generation: 1, sourceAccess: questionId ? 'read_only' : 'assigned_workspace', requestedTools: [], reasoningDefault: true, ...(questionId ? { questionId } : {}) },
  };
  const settings = { pi: { extraArgs: [] as string[] }, claude: { settingSources: [], useProviderKey: false }, providers: [] };
  const approve = vi.fn(async () => ({ optionId: 'deny' }));
  const ctx = {
    sessionId: 's1', session: () => meta, settings: () => settings, sessionDir: root,
    runtime: { resolve: () => ({ path: path.join(root, 'pi.exe') }), resource: (...parts: string[]) => path.resolve('resources', ...parts) },
    permissionMode: () => meta.config.permissionMode, effort: () => 'high', getApiKey: async () => undefined,
    mcpServers: async () => [server], ownedMcpIds: () => ['vocs-mission'], requestApproval: approve,
    emit: (event: SessionEvent) => events.push(event), log: (_level: string, message: string) => logs.push(message),
    updateRef: (patch: object) => Object.assign(meta.harnessRef, patch), updateMeta: (patch: object) => Object.assign(meta, patch),
  } as unknown as HarnessContext;
  return { ctx, meta, settings, events, logs, root, server, invoke, approve };
}

/** Offline ownership boundary only. The real Windows/process + installed-Pi suites certify containment.
 * Keep pi-ownership real: an exact persisted intent must precede launch, and teardown writes its
 * matching receipt before confirming supervisor exit. A root close alone cannot resolve quiescence.
 */
function scriptedOwnership(options: OwnedWindowsJobOptions<ChildProcess>, deferTeardown: boolean) {
  const intent = options.ownershipIntent!;
  const text = readFileSync(intent.path, 'utf8');
  expect(createHash('sha256').update(text).digest('hex')).toBe(intent.hash);
  const record = JSON.parse(text);
  const child = options.launch('mission-adapter-supervisor-fixture', []);
  const quiet = deferred<void>(); void quiet.promise.catch(() => undefined);
  const teardown = deferred<void>();
  if (!deferTeardown) teardown.resolve();
  let state: OwnedWindowsJob<ChildProcess>['state'] = 'live';
  let closed = false, receipted = false, canceling = false;
  const settle = () => { if (closed && receipted) { state = 'quiescent'; quiet.resolve(); } };
  options.observeExit(child, () => { closed = true; settle(); });
  const close = () => {
    if (closed) return;
    Object.assign(child, { exitCode: 0 });
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    child.emit('close', 0);
  };
  const owned = {
    process: child, quiescent: quiet.promise,
    get state() { return state; },
    get exitCode() { return receipted ? 0 : undefined; },
    releaseTeardown: () => teardown.resolve(), close,
    cancel: vi.fn(() => {
      if (state === 'quiescent' || canceling) return;
      canceling = true; state = 'closing';
      void (async () => {
        await teardown.promise;
        const receipt = { ...record, intentHash: intent.hash, source: 'supervisor', outcome: 'job_empty', quiescent: true, childTreeZero: true, completedAt: Date.now() };
        const file = await fs.open(intent.path.replace('.intent.json', '.receipt.json'), 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(receipt) + '\n', 'utf8'); await file.sync(); } finally { await file.close(); }
        receipted = true; settle(); close();
      })().catch((error) => { state = 'uncertain'; quiet.reject(error); close(); });
    }),
  };
  jobs.push(owned);
  return owned;
}

function scriptPi(capabilities = ['approvals', 'tools', 'mcp', 'mission'], options: {
  state?: Record<string, unknown>; models?: Record<string, unknown>[]; tools?: string[]; stale?: boolean; modelsError?: boolean; deferTeardown?: boolean;
} = {}) {
  // Model the supported platform even on a POSIX test host; this never invokes the real supervisor.
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const commands: Record<string, unknown>[] = [];
  const model = { provider: 'anthropic', id: 'fixed-model', name: 'Observed', reasoning: true };
  processApi.supervisor.mockImplementation((_bin, _args, spawnOptions) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const emit = (event: object) => { if (!stdout.destroyed) stdout.write(JSON.stringify(event) + '\n'); };
    Object.assign(child, { stdout, stderr: new PassThrough(), exitCode: null, signalCode: null, stdin: new Writable({ write(chunk, _encoding, done) {
      const command = JSON.parse(chunk.toString()); commands.push(command);
      queueMicrotask(() => {
        if (command.type === 'get_state') for (const capability of capabilities) emit({ type: 'extension_ui_request', method: 'notify', message: 'VCODE_PI_READY::' + JSON.stringify({
          version: 1, nonce: options.stale ? 'previous-process' : spawnOptions.env.VOCS_CODE_PI_NONCE, capability, ready: true,
          ...(capability === 'mission' ? { tools: options.tools ?? [...MISSION_PI_CORE_TOOLS, 'mission_read', 'mission_report'] } : {}),
        }) });
        emit({ type: 'response', id: command.id, command: command.type, success: !(options.modelsError && command.type === 'get_available_models'), error: 'catalog unavailable',
          data: command.type === 'get_available_models' ? { models: options.models ?? [model] } : command.type === 'get_state' ? options.state ?? { model, thinkingLevel: 'medium' } : {} });
      });
      done();
    } }) });
    return child;
  });
  processApi.owned.mockImplementation((jobOptions: OwnedWindowsJobOptions<ChildProcess>) => scriptedOwnership(jobOptions, !!options.deferTeardown));
  spawn.spawnTool.mockImplementation(() => { throw new Error('Managed Pi must launch through owned process containment'); });
  spawn.shutdownChild.mockImplementation(() => { throw new Error('Managed Pi must cancel its owned process, not generic shutdownChild'); });
  return commands;
}

const coordination = 'mcp__vocs-mission__mission_plan_update';
const provenance = { name: 'vocs-mission', source: 'sdk' };

/** Drive the SDK hooks exactly where a tool would execute, not just a helper verdict. */
async function dispatch(options: Options, tool: string, input: Record<string, unknown>, execute: () => Promise<unknown>, server?: typeof provenance) {
  const hook = options.hooks!.PreToolUse![0].hooks[0];
  const result = await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'call1', session_id: 'cli', transcript_path: '', cwd: '.', mcp_server: server } as never, 'call1', { signal: new AbortController().signal });
  if ('hookSpecificOutput' in result && result.hookSpecificOutput && 'permissionDecision' in result.hookSpecificOutput) {
    if (result.hookSpecificOutput.permissionDecision === 'deny') return result;
    if (result.hookSpecificOutput.permissionDecision === 'allow') return execute();
  }
  const verdict = await options.canUseTool!(tool, input, { signal: new AbortController().signal, suggestions: [], toolUseID: 'call1', requestId: 'request1', mcpServer: server });
  if (verdict?.behavior === 'allow') return execute();
  return verdict;
}

async function claude(options: { readOnly?: boolean; role?: 'lead' | 'worker'; requested?: string[] } = {}) {
  const h = await host('claude', options.role);
  if (options.readOnly) h.meta.mission!.sourceAccess = 'read_only';
  if (options.requested) h.meta.mission!.requestedTools = options.requested;
  const adapter = new ClaudeAdapter(h.ctx); adapters.push(adapter);
  await adapter.start();
  return { ...h, adapter, options: sdk.query.mock.calls.at(-1)![0].options as Options };
}

describe('managed Mission adapter boundaries', () => {
  it('Claude answer-only scope accepts only broker getters, even after permission widening', async () => {
    const h = await host('claude', 'lead', 'user-question'); h.meta.config.permissionMode = 'plan';
    const adapter = new ClaudeAdapter(h.ctx); adapters.push(adapter); await adapter.start();
    const options = sdk.query.mock.calls.at(-1)![0].options as Options;
    const execute = vi.fn(async () => 'observed');
    expect(await dispatch(options, 'mcp__vocs-mission__mission_read', { payload: {} }, execute, provenance)).toBe('observed');
    await adapter.setPermissionMode('full-auto');
    for (const name of ['Read', 'Write', 'Bash', 'Agent', 'mcp__vocs-mission__mission_plan_update', 'mcp__vocs-mission__mission_task_delegate', 'mcp__vocs-mission__mission_finish_request']) {
      const denied = await dispatch(options, name, { payload: { questionId: 'user-question', readOnly: true } }, execute, name.startsWith('mcp__') ? provenance : undefined);
      expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    }
    expect(execute).toHaveBeenCalledTimes(1); expect(h.approve).not.toHaveBeenCalled();
  });

  it('Pi answer-only startup requires exactly the getter inventory, not the execution Mission handshake', async () => {
    const h = await host('pi', 'lead', 'user-question'); h.meta.config.permissionMode = 'plan';
    const commands = scriptPi(undefined, { tools: ['mission_read', 'mission_context_read'] });
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter); await adapter.send({ text: 'Which check ran?' });
    expect(await adapter.missionReadiness()).toMatchObject({ ready: true, tools: ['mission_read', 'mission_context_read'] });
    const policy = JSON.parse(processApi.supervisor.mock.calls[0][2].env.VOCS_CODE_MISSION_POLICY);
    expect(policy).toMatchObject({ questionId: 'user-question', sourceAccess: 'read_only', requestedTools: [] });
    expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(1);
  });

  it('Pi refuses answer-only startup if execution tools remain advertised', async () => {
    const h = await host('pi', 'lead', 'user-question');
    const commands = scriptPi(undefined, { tools: ['mission_read', 'mission_context_read', 'mission_report'] });
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter);
    await expect(adapter.send({ text: 'Do not execute' })).rejects.toThrow();
    expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
  });
  it('Pi loads only shipped managed extensions, preserves prompt/default reasoning and never writes broker auth', async () => {
    const h = await host('pi'); scriptPi();
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter);
    await adapter.send({ text: 'go' });
    expect(processApi.owned).toHaveBeenCalledTimes(1);
    expect(processApi.supervisor).toHaveBeenCalledTimes(1);
    expect(spawn.spawnTool).not.toHaveBeenCalled();
    const { executable, args, helperPath } = processApi.owned.mock.calls[0][0] as OwnedWindowsJobOptions<ChildProcess>;
    const [file, argv, options] = processApi.supervisor.mock.calls[0];
    expect(executable).toBe(path.join(h.root, 'pi.exe'));
    expect(helperPath).toBe(path.resolve('resources', 'mission', 'windows-check-job.ps1'));
    // The independent supervisor helper owns detached/stdio setup; this is the adapter boundary.
    expect([file, argv]).toEqual(['mission-adapter-supervisor-fixture', []]);
    expect(options).toEqual({ cwd: h.root, env: expect.any(Object) });
    expect(args).toContain('--no-extensions');
    expect(args.filter((value: string) => value.endsWith('.ts')).map((value: string) => path.basename(value))).toEqual(['vocs-code-mission.ts', 'vocs-code-approvals.ts', 'vocs-code-tools.ts', 'vocs-code-mcp.ts']);
    expect(args).toContain('PROJECT_INSTRUCTIONS_PRESERVED');
    expect(args).not.toContain('--no-context-files');
    expect(args).not.toContain('--thinking');
    expect(overrides).not.toHaveBeenCalled();
    expect(options.env.VOCS_CODE_SUBAGENT_DIR).toBeUndefined();
    expect(JSON.parse(options.env.VOCS_CODE_MCP_EPHEMERAL).servers).toEqual([h.server.def]);
    expect(await fs.readFile(path.join(h.root, 'pi', 'reasoning-effort.json'), 'utf8')).toBe('null');
    expect(await fs.readdir(path.join(h.root, 'pi'))).not.toContain('mcp.json');
    expect(JSON.stringify([args, h.events, h.logs])).not.toContain(h.server.def.headers!.Authorization);
  });

  it.each(['mission', 'mcp', 'tools', 'approvals'])('Pi refuses a prompt without %s readiness', async (missing) => {
    const h = await host('pi');
    const commands = scriptPi(['approvals', 'tools', 'mcp', 'mission'].filter((name) => name !== missing));
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter);
    await expect(adapter.send({ text: 'do not execute' })).rejects.toThrow('Missing readiness');
    expect(jobs[0].cancel).toHaveBeenCalledTimes(1);
    expect(spawn.shutdownChild).not.toHaveBeenCalled();
    expect(await inspectManagedPiOwnership(h.root, { sessionId: 's1', missionId: 'm1', generation: 1 })).toEqual({ state: 'quiescent', quiescent: true, intents: 1 });
    expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
    expect(h.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(0);
  });

  it('Pi readiness observes model, thinking and active tools without a prompt or stale metadata', async () => {
    const h = await host('pi');
    h.meta.activeModel = { provider: 'stale', model: 'previous' }; h.meta.activeEffort = 'max';
    const commands = scriptPi(undefined, { tools: ['read', 'mission_read', 'mission_report'] });
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter); await adapter.start();
    expect(await adapter.missionReadiness()).toEqual({ ready: true, tools: ['read', 'mission_read', 'mission_report'], model: { provider: 'anthropic', model: 'fixed-model' }, effort: 'medium', modelAvailable: true, connectionAvailable: true });
    expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
    await adapter.dispose();
    expect(await adapter.missionReadiness()).toMatchObject({ ready: false, tools: [] });
  });

  it('Pi disposal waits for the owned receipt after supervisor close and permits only a receipted relaunch', async () => {
    const h = await host('pi'); const commands = scriptPi(undefined, { deferTeardown: true });
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter); await adapter.start();
    const job = jobs[0]; const completed = vi.fn();
    const stopping = adapter.dispose().then(completed);
    await vi.waitFor(() => expect(job.cancel).toHaveBeenCalledTimes(1));
    job.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).not.toHaveBeenCalled();
    expect(await inspectManagedPiOwnership(h.root, { sessionId: 's1', missionId: 'm1', generation: 1 })).toMatchObject({ state: 'unknown', quiescent: false, intents: 1 });
    expect(await adapter.missionReadiness()).toMatchObject({ ready: false, tools: [] });
    await expect(adapter.start()).rejects.toThrow('ownership must be released');
    expect(processApi.owned).toHaveBeenCalledTimes(1);
    job.releaseTeardown(); await stopping;
    expect(completed).toHaveBeenCalledTimes(1);
    expect(await inspectManagedPiOwnership(h.root, { sessionId: 's1', missionId: 'm1', generation: 1 })).toEqual({ state: 'quiescent', quiescent: true, intents: 1 });
    await adapter.start();
    expect(processApi.owned).toHaveBeenCalledTimes(2);
    expect(processApi.owned.mock.calls[1][0].ownershipIntent.path).not.toBe(processApi.owned.mock.calls[0][0].ownershipIntent.path);
    expect(await adapter.missionReadiness()).toMatchObject({ ready: true });
    expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
    expect(spawn.shutdownChild).not.toHaveBeenCalled();
  });

  it.each([
    ['missing effective model', { state: {} }],
    ['missing effective thinking state', { state: { model: { provider: 'anthropic', id: 'fixed-model' } } }],
    ['unknown effective thinking state', { state: { model: { provider: 'anthropic', id: 'fixed-model' }, thinkingLevel: 'unknown' } }],
    ['unavailable selected model', { models: [{ provider: 'anthropic', id: 'different' }] }],
    ['unavailable selected connection', { models: [{ provider: 'openai', id: 'fixed-model' }] }],
    ['model list failure', { modelsError: true }],
    ['substituted model', { state: { model: { provider: 'anthropic', id: 'substitution' }, thinkingLevel: 'medium' } }],
    ['missing gate tool inventory', { tools: [] }],
    ['stale extension nonce', { stale: true }],
  ] as const)('Pi refuses before prompting: %s', async (_label, script) => {
    const h = await host('pi');
    // Credentials and historical metadata cannot compensate for the observed failure.
    h.ctx.getApiKey = async () => 'configured-but-not-runtime-proof';
    h.meta.activeModel = h.meta.config.model; h.meta.activeEffort = 'high';
    const commands = scriptPi(undefined, script as Parameters<typeof scriptPi>[1]);
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter);
    await expect(adapter.send({ text: 'not accepted' })).rejects.toThrow();
    expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
    expect(h.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(0);
    expect(await adapter.missionReadiness()).toMatchObject({ ready: false });
  });

  it('Pi picker catalog augmentation cannot certify a model removed from the raw runtime list', async () => {
    const h = await host('pi');
    const selected = STATIC_MODELS_BY_PROVIDER.anthropic[0];
    h.meta.config.model = { provider: selected.provider, model: selected.id };
    h.settings.providers.push({ id: selected.provider, enabled: true } as never);
    const model = { provider: selected.provider, id: selected.id, name: selected.displayName };
    const script = { state: { model, thinkingLevel: 'medium' }, models: [model] };
    const commands = scriptPi(undefined, script);
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter); await adapter.start();
    script.models = [{ provider: selected.provider, id: 'different-runtime-model', name: 'Other' }];
    expect(await adapter.listModels()).toContainEqual(expect.objectContaining({ provider: selected.provider, id: selected.id }));
    expect(await adapter.missionReadiness()).toMatchObject({ ready: false, modelAvailable: false, connectionAvailable: true });
    await expect(adapter.send({ text: 'must not run' })).rejects.toThrow('model is unavailable');
    expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
  });

  it('Pi refuses an explicit effort clamped by the runtime instead of declaring the configured effort', async () => {
    const h = await host('pi'); h.meta.mission!.reasoningDefault = false;
    const commands = scriptPi();
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter);
    await expect(adapter.send({ text: 'not accepted' })).rejects.toThrow(/effort/i);
    expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
  });

  it.each([['--model', 'other'], ['--mode=json'], ['-e', 'untrusted.ts'], ['--tools', 'subagent'], ['--thinking', 'off'], ['--', 'prompt'], ['--session', 'other']])('Pi rejects competing extraArgs %j before spawning', async (...extraArgs) => {
    const h = await host('pi'); scriptPi(); h.settings.pi.extraArgs = extraArgs;
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter);
    await expect(adapter.start()).rejects.toThrow('extraArgs are incompatible');
    expect(processApi.owned).not.toHaveBeenCalled();
    expect(processApi.supervisor).not.toHaveBeenCalled();
    expect(spawn.spawnTool).not.toHaveBeenCalled();
    expect(overrides).not.toHaveBeenCalled();
  });

  it('Pi managed turns remain busy until agent_settled, then publish exactly one terminal turn', async () => {
    const h = await host('pi'); const commands = scriptPi();
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter); await adapter.send({ text: 'work' });
    const child = jobs[0].process;
    const emit = (event: object) => child.stdout!.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
    emit({ type: 'agent_start' }); emit({ type: 'agent_end', messages: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.busy).toBe(true);
    expect(h.events.filter((event) => event.type === 'item.upsert' && event.item.kind === 'turn')).toHaveLength(0);
    emit({ type: 'agent_settled' }); emit({ type: 'agent_settled' });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(h.events.filter((event) => event.type === 'item.upsert' && event.item.kind === 'turn')).toHaveLength(1);
    const before = commands.length; await adapter.interrupt();
    expect(commands.slice(before).map((command) => command.type)).toEqual(['clear_queue', 'abort']);
    expect(jobs[0].cancel).not.toHaveBeenCalled();
  });

  it.each(['select', 'confirm', 'input', 'editor'])('Pi cancels direct worker %s questions without sending a user approval', async (method) => {
    const h = await host('pi', 'worker'); const commands = scriptPi();
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter); await adapter.start();
    const child = jobs[0].process;
    child.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'extension_ui_request', id: 'question1', method, title: 'Should I continue?' }) + '\n'));
    await vi.waitFor(() => expect(commands).toContainEqual({ type: 'extension_ui_response', id: 'question1', cancelled: true }));
    expect(h.approve).not.toHaveBeenCalled();
  });

  it('Pi retains a read-only ceiling across permission changes', async () => {
    const h = await host('pi'); scriptPi(); h.meta.mission!.sourceAccess = 'read_only';
    const adapter = new PiAdapter(h.ctx); adapters.push(adapter); await adapter.start();
    await adapter.setPermissionMode('full-auto');
    expect(await fs.readFile(path.join(h.root, 'pi', 'permission-mode.txt'), 'utf8')).toBe('plan');
    await expect(adapter.setModel({ provider: 'anthropic', model: 'other' })).rejects.toThrow('fixed');
    await expect(adapter.send({ text: '/goal bypass' })).rejects.toThrow('Mission owns');
  });

  it('Claude scopes disallowedTools and holds broker credentials only in the host bridge, not CLI options', async () => {
    const h = await claude();
    expect(h.options.disallowedTools).toEqual(expect.arrayContaining(['Agent', 'Task', 'AskUserQuestion', 'ExitPlanMode', 'Goal']));
    expect(h.options.strictMcpConfig).toBe(true);
    expect(h.options.tools).not.toContain('Agent');
    expect(h.options.effort).toBeUndefined();
    expect(JSON.stringify([h.options, h.events, h.logs])).not.toContain(h.server.def.headers!.Authorization);
    expect(h.options.mcpServers!['vocs-mission']).toMatchObject({ type: 'sdk', name: 'vocs-mission' });
    expect(await h.adapter.listAgents()).toEqual([]);
  });

  it.each(['Agent', 'Task', 'AskUserQuestion', 'ExitPlanMode', 'Goal', 'CronCreate', 'mcp__other__spawn_worker', 'mcp__other__set_model', 'late_unknown_tool'])('Claude denies %s through PreToolUse, even at Full access', async (name) => {
    const h = await claude({ role: 'worker' }); const execute = vi.fn();
    const result = await dispatch(h.options, name, {}, execute);
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(execute).not.toHaveBeenCalled(); expect(h.approve).not.toHaveBeenCalled();
  });

  it.each(['git -C . push origin feature', 'gh pr create --title feature', 'gh pr merge --squash', 'npm publish', 'npx wrangler deploy', 'npm run build', 'npm test', 'npx vitest run', 'pnpm run typecheck'])('Claude blocks known independent delivery/heavy commands: %s', async (command) => {
    const h = await claude(); const execute = vi.fn();
    const result = await dispatch(h.options, 'Bash', { command }, execute);
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    if (/build|test|typecheck/.test(command)) expect(JSON.stringify(result)).toContain('mission_verification_request');
    expect(execute).not.toHaveBeenCalled();
  });

  it('Claude planning can coordinate but never write; fake server names/annotations cannot gain that privilege', async () => {
    const h = await claude({ readOnly: true }); const write = vi.fn(async () => fs.writeFile(path.join(h.root, 'forbidden'), 'bad'));
    expect(h.options.permissionMode).toBe('plan');
    await dispatch(h.options, 'Write', { file_path: 'forbidden', content: 'bad' }, write);
    await dispatch(h.options, 'Bash', { command: 'echo bad > forbidden' }, write);
    expect(write).not.toHaveBeenCalled();
    expect(await fs.readdir(h.root)).not.toContain('forbidden');
    const tool = sdk.tool.mock.results.map((entry) => entry.value).find((entry) => entry.name === 'mission_plan_update');
    const request = { expectedRevision: 1, idempotencyKey: 'plan1', payload: {} };
    await dispatch(h.options, coordination, request, () => tool.handler(request), provenance);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    await dispatch(h.options, coordination, request, () => tool.handler(request), { ...provenance, source: 'project' });
    await dispatch(h.options, 'mcp__vocs_mission__mission_plan_update', request, () => tool.handler(request), provenance);
    await dispatch(h.options, 'mcp__vocs-mission__mission_authorize_execution', request, () => tool.handler(request), provenance);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.approve).not.toHaveBeenCalled();
  });

  it('Claude validates requested tools and enforces the subset while preserving normal edit approvals', async () => {
    const h = await claude({ requested: ['Read'] }); const execute = vi.fn();
    await dispatch(h.options, 'Write', { file_path: 'bad', content: 'bad' }, execute);
    expect(execute).not.toHaveBeenCalled();
    const invalid = await host('claude'); invalid.meta.mission!.requestedTools = ['Agent'];
    const adapter = new ClaudeAdapter(invalid.ctx); adapters.push(adapter);
    await expect(adapter.start()).rejects.toThrow('unavailable or prohibited');
    const ordinaryEdit = await claude(); ordinaryEdit.meta.config.permissionMode = 'ask';
    await dispatch(ordinaryEdit.options, 'Write', { file_path: 'normal', content: 'ok' }, execute);
    expect(ordinaryEdit.approve).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
  });

  it('Claude enforces ordinary approval ceilings through PreToolUse even if CLI permission rules would skip canUseTool', async () => {
    const h = await claude(); h.meta.config.permissionMode = 'auto';
    const execute = vi.fn();
    await dispatch(h.options, 'Bash', { command: 'sudo echo blocked' }, execute);
    await dispatch(h.options, 'Write', { file_path: path.join(h.root, '..', 'outside.txt'), content: 'blocked' }, execute);
    expect(h.approve).toHaveBeenCalledTimes(2); expect(execute).not.toHaveBeenCalled();
  });

  it('Claude fails startup when the runtime has not connected its Mission tools', async () => {
    sdk.query.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, close: vi.fn(), initializationResult: async () => ({ hooks_applied: true }), mcpServerStatus: async () => [{ name: 'vocs-mission', source: 'sdk', status: 'failed' }] });
    const h = await host('claude'); const adapter = new ClaudeAdapter(h.ctx); adapters.push(adapter);
    await expect(adapter.send({ text: 'not accepted' })).rejects.toThrow('not connected');
    expect(h.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(0);
  });

  it('Claude SDK initialization and a connected bridge do not certify unknown effective model or provider availability', async () => {
    const h = await claude();
    h.meta.activeModel = h.meta.config.model; h.meta.activeEffort = 'high';
    const readiness = await h.adapter.missionReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.model).toBeUndefined(); expect(readiness.effort).toBeUndefined();
    expect(readiness.modelAvailable).not.toBe(true); expect(readiness.connectionAvailable).not.toBe(true);
    expect(readiness.tools).toEqual([]);
    await expect(h.adapter.send({ text: 'no speculative model call' })).rejects.toThrow(/unverified|not observed/i);
    expect(h.adapter.busy).toBe(false);
  });

  it.each([undefined, false])('Claude refuses unknown/unapplied SDK hook registration (%s) before any model prompt', async (hooksApplied) => {
    sdk.query.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {}, close: vi.fn(),
      initializationResult: async () => ({ hooks_applied: hooksApplied, models: [], account: {} }),
      mcpServerStatus: async () => [{ name: 'vocs-mission', source: 'sdk', status: 'connected' }],
    });
    const h = await host('claude'); const adapter = new ClaudeAdapter(h.ctx); adapters.push(adapter);
    await expect(adapter.send({ text: 'not accepted' })).rejects.toThrow(/hook/i);
    expect(adapter.busy).toBe(false);
    expect(await adapter.missionReadiness()).toMatchObject({ ready: false, tools: [] });
  });

  it('ordinary Claude retains native delegation and ordinary unknown MCP gating', async () => {
    const h = await host('claude'); delete h.meta.mission; h.ctx.mcpServers = async () => [];
    const adapter = new ClaudeAdapter(h.ctx); adapters.push(adapter); await adapter.start();
    const options = sdk.query.mock.calls.at(-1)![0].options as Options;
    expect(options.disallowedTools).toBeUndefined(); expect(options.strictMcpConfig).toBeUndefined();
    h.meta.config.permissionMode = 'plan'; const execute = vi.fn();
    await dispatch(options, 'mcp__vocs-mission__mission_plan_update', {}, execute, provenance);
    expect(execute).not.toHaveBeenCalled();
    expect(gateAction('plan', { mutating: true, isEdit: false })).toBe('deny');
    expect(isTrustedMissionCoordination(coordination, provenance)).toBe(true);
    expect(isTrustedMissionCoordination(coordination, { ...provenance, source: 'project' })).toBe(false);
  });

  it('Pi consumes ephemeral auth before children spawn and never mislabels coordination as read-only', async () => {
    const h = await host('pi');
    vi.stubEnv('VOCS_CODE_MISSION_POLICY', JSON.stringify(h.meta.mission));
    vi.stubEnv('VOCS_CODE_MCP_CONFIG', '');
    vi.stubEnv('VOCS_CODE_MCP_EPHEMERAL', JSON.stringify({ servers: [h.server.def] }));
    const tools = await loadMcpBridge();
    expect(process.env.VOCS_CODE_MCP_EPHEMERAL).toBeUndefined();
    expect(tools.find((entry) => entry.name === 'mission_plan_update')).toMatchObject({ missionCoordination: true, readOnly: false });
    expect((await mcpReadOnlyToolNames()).size).toBe(0);
    await tools.find((entry) => entry.name === 'mission_read')!.execute('one', { payload: {} });
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it('the shipped Pi bridge accepts host-bound answer getters without granting general MCP read-only authority', async () => {
    const h = await host('pi', 'lead', 'host-question');
    vi.stubEnv('VOCS_CODE_MISSION_POLICY', JSON.stringify(h.meta.mission)); vi.stubEnv('VOCS_CODE_MCP_CONFIG', '');
    vi.stubEnv('VOCS_CODE_MCP_EPHEMERAL', JSON.stringify({ servers: [h.server.def] }));
    const tools = await loadMcpBridge();
    expect(tools.map((tool) => tool.name)).toEqual(['mission_read', 'mission_context_read']);
    expect(tools.every((tool) => tool.missionCoordination && !tool.readOnly)).toBe(true);
    expect((await mcpReadOnlyToolNames()).size).toBe(0);
    await tools[0].execute('read', { payload: {} });
    await tools[1].execute('context', { payload: { ref: 'retained-output' } });
    expect(h.invoke.mock.calls.map(([binding, name]) => ({ binding, name }))).toEqual([
      { binding: { missionId: 'm1', actor: { kind: 'lead', sessionId: 's1', generation: 1 }, questionId: 'host-question' }, name: 'mission_read' },
      { binding: { missionId: 'm1', actor: { kind: 'lead', sessionId: 's1', generation: 1 }, questionId: 'host-question' }, name: 'mission_context_read' },
    ]);
    expect(process.env.VOCS_CODE_MCP_EPHEMERAL).toBeUndefined();
  });

  it('the shipped Pi bridge rejects mutation inventory under an answer-only host policy', async () => {
    const h = await host('pi'); // The execution broker must not masquerade as an answer scope.
    vi.stubEnv('VOCS_CODE_MISSION_POLICY', JSON.stringify({ ...h.meta.mission, questionId: 'host-question', sourceAccess: 'read_only' }));
    vi.stubEnv('VOCS_CODE_MCP_CONFIG', ''); vi.stubEnv('VOCS_CODE_MCP_EPHEMERAL', JSON.stringify({ servers: [h.server.def] }));
    await expect(loadMcpBridge()).rejects.toThrow('Required Mission MCP surface is incompatible');
    expect(h.invoke).not.toHaveBeenCalled(); expect(process.env.VOCS_CODE_MCP_EPHEMERAL).toBeUndefined();
  });

  it('Pi refuses a failed required broker handshake instead of silently omitting Mission tools', async () => {
    const h = await host('pi'); await brokers.at(-1)!.close();
    vi.stubEnv('VOCS_CODE_MISSION_POLICY', JSON.stringify(h.meta.mission)); vi.stubEnv('VOCS_CODE_MCP_CONFIG', '');
    vi.stubEnv('VOCS_CODE_MCP_EPHEMERAL', JSON.stringify({ servers: [h.server.def] }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadMcpBridge()).rejects.toThrow('Required Mission MCP handshake failed');
    expect(log).not.toHaveBeenCalled(); expect(process.env.VOCS_CODE_MCP_EPHEMERAL).toBeUndefined();
  });
});
