/** Production restart composition + real Job receipts. No provider/network, PID absence, or
 * invented Native restart certification. The old host fixture is killed, never its target tree. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionRuntime } from '../src/main/mission/runtime';
import { MissionRecovery } from '../src/main/mission/recovery';
import { MissionStore, MissionStoreError } from '../src/main/mission/store';
import { assertMissionRecord } from '../src/main/mission/state';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { TerminalManager } from '../src/main/terminal';
import { DEFAULT_TERMINAL_SETTINGS } from '../src/shared/terminal';
import type { MissionOperation, MissionRecord } from '../src/shared/mission';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { bindManagedPiLaunch, createManagedPiOwnershipIntent, recordUnlaunchedManagedPiIntent } from '../src/main/harness/pi-ownership';
import { checkOwnershipDirectory, createProcessOwnershipIntent, processOwnershipIntents, processOwnershipQuiescent, recordUnlaunchedProcessIntent } from '../src/main/mission/process-ownership';
import { independentWindowsSupervisorScript, windowsJobCommandLine } from '../src/main/owned-windows-job';
import { missionFixture } from './support/mission-fixture';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn(() => { throw new Error('Recovery must not launch a harness'); }) }));
let root: string, data: string, project: string;
const runtimes: MissionRuntime[] = [], managers: SessionManager[] = [], children: ChildProcess[] = [];
const helper = path.resolve('resources/mission/windows-check-job.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sessionDir = () => path.join(data, 'sessions', 'lead');
const checkRoot = () => path.join(data, 'mission-process-ownership');
const checkDir = () => checkOwnershipDirectory(checkRoot(), 'mission');
const terminalDir = () => path.join(data, 'terminals');
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-restart-')); data = path.join(root, 'data'); project = path.join(root, 'project');
  await fs.mkdir(project); vi.mocked(createAdapter).mockReset().mockImplementation(() => { throw new Error('Recovery must not launch a harness'); });
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>((resolve) => child.once('close', () => resolve())); child.kill(); await closed; }
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const manager of managers.splice(0)) { await manager.stopAll(); await manager.flushPendingPersists(); }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const operation = (id: string, kind: MissionOperation['kind'], payload: MissionOperation['payload'] = {}): MissionOperation => ({ id, idempotencyKey: id, kind, actor: 'host', expectedRevision: 1, state: 'in_flight', payload });
function record(operations: MissionOperation[] = []): MissionRecord {
  const value = missionFixture({ projectRoot: project, sourceCwd: project, operations });
  value.leadPreset.harnessId = 'pi'; value.config.presets[0].harnessId = 'pi';
  return value;
}
async function piIntent(generation = 1, nonce = randomUUID()) {
  await bindManagedPiLaunch(sessionDir(), { sessionId: 'lead', missionId: 'mission', generation }, nonce);
  return createManagedPiOwnershipIntent(sessionDir(), { sessionId: 'lead', missionId: 'mission', generation });
}
const dispatch = (nonce: string, generation = 1, stage: 'starting_runtime' | 'sending' = 'sending') => operation('dispatch', 'dispatch', {
  sessionId: 'lead', generation, lead: true, runtimeStartRequestedAt: Date.now(), dispatchStage: stage,
  runtimeLaunch: { sessionId: 'lead', generation, nonce, harnessId: 'pi' }, mailboxIds: ['mail'], ...(stage === 'sending' ? { dispatchStartedAt: Date.now() } : {}),
});
async function persist(value: MissionRecord) {
  const store = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord });
  await store.create(value, { idempotencyKey: 'seed', actor: 'host', expectedRevision: 0, kind: 'fixture.crash' });
}
async function boot(harness: 'pi' | 'native' = 'pi') {
  const store = new SessionStore(data); await store.load();
  const settings = defaultSettings(); settings.mission = record().config;
  const sessions = new SessionManager({ store, settings: { get: () => settings } as SettingsStore, runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as never,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn() });
  managers.push(sessions);
  if (!sessions.get('lead')) await sessions.createManaged({ title: 'Retained lead', config: { harness, projectRoot: project, permissionMode: 'plan', model: { provider: 'fixture', model: 'frontier' } } },
    { id: 'lead', cwd: project, ownership: { missionId: 'mission', role: 'lead', generation: 1, sourceAccess: 'read_only', requestedTools: [], reasoningDefault: true } });
  let runtime: MissionRuntime | undefined;
  const terminals = new TerminalManager({ dir: terminalDir(), settings: () => DEFAULT_TERMINAL_SETTINGS, version: 'test', cwdOf: (id) => sessions.get(id)?.cwd,
    isManaged: (id) => !!sessions.get(id)?.mission, windowsJobHelper: helper, beforeSpawn: (cwd) => runtime?.admission.assertAvailableSync(cwd), push: vi.fn(), log: vi.fn() });
  await terminals.load();
  runtime = new MissionRuntime({ userData: data, sessions, terminals, settings: { get: () => settings, onChange: () => () => undefined }, windowsJobHelper: helper, changed: vi.fn(), log: vi.fn() });
  runtimes.push(runtime); await runtime.load();
  return { runtime, sessions, terminals };
}

it('binds each production dispatch nonce before startup and never reuses a parked runtime for a new operation', async () => {
  const starts: string[] = [], contexts: HarnessContext[] = [], stopped: string[] = [];
  vi.mocked(createAdapter).mockImplementation((_harness, ctx): HarnessAdapter => {
    contexts.push(ctx);
    let intent: Awaited<ReturnType<typeof createManagedPiOwnershipIntent>> | undefined;
    return { id: 'pi', busy: false,
      start: async () => {
        const owner = ctx.session().mission!;
        intent = await createManagedPiOwnershipIntent(ctx.sessionDir, { sessionId: ctx.sessionId, missionId: owner.missionId, generation: owner.generation });
        starts.push(intent.record.nonce); ctx.emit({ type: 'status', status: 'idle' });
      },
      missionReadiness: async () => ({ ready: true, tools: ['read', 'mission_read', 'mission_report'], model: { provider: 'fixture', model: 'frontier' }, modelAvailable: true, connectionAvailable: true }),
      listModels: async () => [], send: async () => { ctx.emit({ type: 'status', status: 'running' }); }, interrupt: async () => undefined,
      dispose: async () => { if (intent) { await recordUnlaunchedManagedPiIntent(intent); stopped.push(intent.record.nonce); intent = undefined; } },
      setModel: async () => undefined, setEffort: async () => undefined, setPermissionMode: async () => undefined,
    };
  });
  const { runtime } = await boot();
  const created = await runtime.service.create({ idempotencyKey: 'two-dispatches', projectRoot: project, objective: 'Investigate', mode: 'interactive_plan', permissionMode: 'auto' });
  await vi.waitFor(() => expect(starts).toHaveLength(1), { timeout: 10000 });
  await vi.waitFor(() => expect(runtime.service.get(created.id)!.operations.some((op) => op.payload.dispatchStartedAt !== undefined)).toBe(true), { timeout: 10000 });
  contexts[0].emit({ type: 'item.upsert', item: { id: 'first-turn', kind: 'turn', ts: Date.now(), status: 'completed' } });
  contexts[0].emit({ type: 'status', status: 'idle' });
  await vi.waitFor(() => expect(runtime.service.get(created.id)!.operations.find((op) => op.kind === 'dispatch')!.state).toBe('succeeded'), { timeout: 10000 });
  for (let retry = 0; ; retry++) {
    try {
      await runtime.service.control({ missionId: created.id, idempotencyKey: 'continue', expectedRevision: runtime.service.get(created.id)!.revision, control: { action: 'steer', text: 'Investigate the next detail' } });
      break;
    } catch (error) { if (!(error instanceof MissionStoreError) || error.code !== 'REVISION_CONFLICT' || retry >= 5) throw error; }
  }
  await vi.waitFor(() => expect(starts).toHaveLength(2), { timeout: 10000 });
  const dispatches = runtime.service.get(created.id)!.operations.filter((op) => op.kind === 'dispatch');
  expect(dispatches).toHaveLength(2);
  expect(dispatches.map((op) => (op.payload.runtimeLaunch as { nonce: string }).nonce)).toEqual(starts);
  expect(new Set(starts).size).toBe(2);
  expect(stopped).toEqual([starts[0]]);
  expect(contexts).toHaveLength(2);
});

it.each(['starting_runtime', 'sending'] as const)('recovers the exact %s launch from positive proof without replaying model input or inventing evidence', async (stage) => {
  const intent = await piIntent(); await recordUnlaunchedManagedPiIntent(intent);
  const saved = record([dispatch(intent.record.nonce, 1, stage)]);
  saved.mailbox.push({ id: 'mail', kind: 'user', sessionId: 'lead', text: 'Do not duplicate this input', artifactIds: [], createdAt: 1 });
  await persist(saved);
  const { runtime } = await boot();
  expect(runtime.service.get('mission')).toMatchObject({ status: 'paused', attempts: [], evidence: [], candidates: [], mailbox: [stage === 'sending' ? { deliveredAt: expect.any(Number) } : { id: 'mail' }] });
  expect(runtime.service.get('mission')!.operations.find((entry) => entry.id === 'dispatch')).toMatchObject({ state: 'failed', payload: { externalQuiescenceReceipt: expect.stringContaining(intent.record.nonce) } });
  expect(runtime.service.isQuiescent(runtime.service.get('mission')!)).toBe(true);
  await runtime.close();
  const restarted = await boot();
  expect(restarted.runtime.service.get('mission')!.operations.filter((entry) => entry.id === 'dispatch')).toHaveLength(1);
  expect(restarted.runtime.service.get('mission')).toMatchObject({ status: 'paused', attempts: [], evidence: [], candidates: [] });
  expect(createAdapter).not.toHaveBeenCalled();
});

it.each(['absent', 'pending', 'old_nonce', 'wrong_generation', 'corrupt_receipt', 'orphan_receipt'] as const)('keeps recovery blocked with %s ownership, despite a new empty process manager', async (failure) => {
  const expected = randomUUID();
  if (failure !== 'absent') {
    const intent = await piIntent(failure === 'wrong_generation' ? 2 : 1, failure === 'old_nonce' ? randomUUID() : expected);
    if (failure !== 'pending') await recordUnlaunchedManagedPiIntent(intent);
    if (failure === 'corrupt_receipt') await fs.writeFile(intent.receiptPath, '{partial');
    if (failure === 'orphan_receipt') await fs.rm(intent.path);
  }
  await persist(record([dispatch(expected)]));
  const { runtime, sessions } = await boot();
  expect(sessions.activity('lead')).toMatchObject({ active: false, quiescent: true });
  expect(runtime.service.get('mission')!.status).toBe('recovering');
  expect(runtime.service.isQuiescent(runtime.service.get('mission')!)).toBe(false);
  expect(runtime.service.get('mission')!.operations.find((entry) => entry.id === 'dispatch')!.state).toBe('reconciling');
  expect(runtime.service.get('mission')!.blockers.filter((blocker) => blocker.resolvedAt === undefined)).toHaveLength(1);
  expect(createAdapter).not.toHaveBeenCalled();
});

it('does not treat a scripted Native runtime as having production crash ownership', async () => {
  const saved = record([dispatch(randomUUID())]); saved.leadPreset.harnessId = 'native'; saved.config.presets[0].harnessId = 'native';
  await persist(saved); const { runtime } = await boot('native');
  expect(runtime.service.get('mission')!.status).toBe('recovering');
  expect(runtime.service.get('mission')!.blockers[0].message).toMatch(/native.*not supported/);
  expect(createAdapter).not.toHaveBeenCalled();
});

it('keeps a verification operation blocked if the host died before persisting its process intent', async () => {
  await persist(record([operation('check', 'verify')])); const { runtime } = await boot();
  expect(runtime.service.get('mission')!.status).toBe('recovering');
  expect(runtime.service.get('mission')!.evidence).toEqual([]);
  expect(runtime.service.isQuiescent(runtime.service.get('mission')!)).toBe(false);
  expect(createAdapter).not.toHaveBeenCalled();
});

it('does not allow cleanup of a final Mission whose prior idle runtime lost its teardown receipt', async () => {
  const saved = record([dispatch(randomUUID())]); saved.status = 'stopped'; saved.operations[0].state = 'failed'; saved.operations[0].error = 'Stopped by user';
  await persist(saved); const { runtime } = await boot();
  expect(runtime.service.get('mission')!.status).toBe('stopped');
  expect(runtime.service.isQuiescent(runtime.service.get('mission')!)).toBe(false);
  await expect(runtime.service.control({ missionId: saved.id, idempotencyKey: 'cleanup', expectedRevision: runtime.service.get(saved.id)!.revision, control: { action: 'cleanup' } })).rejects.toThrow(/quiescent|reconciled/);
});

it('requires every retained check intent, not only the latest completed check, to be positively receipted', async () => {
  const first = createProcessOwnershipIntent(checkDir(), { kind: 'mission-check', missionId: 'mission', operationId: 'first' });
  const last = createProcessOwnershipIntent(checkDir(), { kind: 'mission-check', missionId: 'mission', operationId: 'last' });
  recordUnlaunchedProcessIntent(last);
  await persist(record([operation('first', 'verify'), operation('last', 'verify')]));
  const { runtime } = await boot();
  expect(runtime.service.get('mission')!.status).toBe('recovering');
  recordUnlaunchedProcessIntent(first);
  await runtime.close();
  const next = await boot();
  expect(next.runtime.service.get('mission')).toMatchObject({ status: 'paused', evidence: [] });
  expect(next.runtime.service.get('mission')!.operations.filter((entry) => entry.kind === 'verify').map((entry) => entry.state)).toEqual(['failed', 'failed']);
});

it('holds workspace admission for the complete receipt inspection and releases it afterward', async () => {
  const intent = await piIntent(); await recordUnlaunchedManagedPiIntent(intent);
  const value = record([dispatch(intent.record.nonce)]);
  await persist(value); const { runtime, sessions, terminals } = await boot();
  const recovery = new MissionRecovery({ userData: data, ownershipRoot: checkRoot(), sessions, terminals, admission: runtime.admission });
  let held = false;
  const realReconcile = terminals.reconcileOwnership.bind(terminals);
  const observe = vi.spyOn(terminals, 'reconcileOwnership').mockImplementation(async (ids) => {
    if (held) expect(() => runtime.admission.assertAvailableSync(project)).toThrow(/capturing|reconciling/);
    await realReconcile(ids);
  });
  const realAcquire = runtime.admission.acquire.bind(runtime.admission);
  vi.spyOn(runtime.admission, 'acquire').mockImplementation(async (cwd) => { const lease = await realAcquire(cwd); held = !!lease; return lease; });
  expect((await recovery.reconcileExternalActivity(value)).quiescent).toBe(true);
  expect(observe).toHaveBeenCalledTimes(2);
  expect(() => runtime.admission.assertAvailableSync(project)).not.toThrow();
});

/** Real previous-host death. The trusted helper is started by an old app fixture with the exact
 * production wire protocol; the next MissionRuntime uses its actual production recovery port. */
async function crashHost(kind: 'pi' | 'check' | 'terminal') {
  const intent = kind === 'pi' ? await piIntent() : createProcessOwnershipIntent(kind === 'check' ? checkDir() : path.join(terminalDir(), 'process-ownership', 'lead'),
    kind === 'check' ? { kind: 'mission-check', missionId: 'mission', operationId: 'check' } : { kind: 'terminal', sessionId: 'lead', terminalId: 'terminal', cwd: project });
  const marker = path.join(project, 'started'), late = path.join(project, 'late');
  const writer = path.join(project, 'writer.cjs'), target = path.join(project, 'target.cjs');
  await fs.writeFile(writer, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'UNSAFE'), 2200); setInterval(() => {}, 1000);`);
  await fs.writeFile(target, `require('node:child_process').spawn(process.execPath, [${JSON.stringify(writer)}], { detached: true, stdio: 'ignore' }).unref(); setInterval(() => {}, 1000);`);
  const pipe = `recovery-test-${randomUUID()}`;
  const argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, ...(kind === 'check' ? [] : ['-ControlPipe', pipe]), '-OwnerIntent', intent.path, '-OwnerHash', intent.hash];
  const request = kind === 'check'
    ? { shell: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), command: `"${process.execPath}" "${target}"`, cwd: project, timeoutMs: 60000, waitForResume: true }
    : { executable: process.execPath, commandLine: windowsJobCommandLine(process.execPath, [target]), cwd: project, timeoutMs: 0, inheritStdio: true, waitForResume: true };
  const script = path.join(root, 'old-app.cjs');
  await fs.writeFile(script, `
const realSpawn = require('node:child_process').spawn;
const spawn = ${kind === 'terminal'
  ? `(file, args, options) => require(${JSON.stringify(createRequire(import.meta.url).resolve('@lydell/node-pty'))}).spawn(file, args, { cwd: options.cwd, env: process.env, name: 'xterm-256color', cols: 80, rows: 24 })`
  : `(file, args, options) => realSpawn(process.execPath, ['-e', ${JSON.stringify(independentWindowsSupervisorScript)}, file, JSON.stringify(args)], { ...options, detached: true })`};
const errorLog = require('node:fs').openSync(${JSON.stringify(path.join(root, 'supervisor.log'))}, 'a');
const request = ${JSON.stringify(JSON.stringify(request) + '\n')};
process.stdin.once('data', () => process.abort());
function observe(input, output) {
  let pending = ''; input.setEncoding('utf8'); input.on('error', () => {}); output.on('error', () => {});
  input.on('data', chunk => { pending += chunk; let end; while ((end = pending.indexOf('\\n')) >= 0) { const frame = JSON.parse(pending.slice(0, end)); require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'frames.jsonl'))}, JSON.stringify(frame) + '\\n'); pending = pending.slice(end + 1); if (frame.type === 'ready') output.write('resume\\n'); } });
  output.write(request);
}
${kind === 'check' ? `const child = spawn(${JSON.stringify(powershell)}, ${JSON.stringify(argv)}, { cwd: ${JSON.stringify(project)}, windowsHide: true, stdio: ['pipe', 'pipe', errorLog] }); observe(child.stdout, child.stdin);`
  : `require('node:net').createServer(socket => observe(socket, socket)).listen(${JSON.stringify(`\\\\.\\pipe\\${pipe}`)}, () => spawn(${JSON.stringify(powershell)}, ${JSON.stringify(argv)}, { cwd: ${JSON.stringify(project)}, windowsHide: true, stdio: ['pipe', 'pipe', errorLog] }));`}
`);
  const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  let errors = ''; child.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
  await vi.waitFor(async () => expect(await fs.readFile(marker, 'utf8').catch(async () => errors + await fs.readFile(path.join(root, 'supervisor.log'), 'utf8') + await fs.readFile(path.join(root, 'frames.jsonl'), 'utf8').catch(() => ''))).toBe('ready'), { timeout: 20000 });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve())); child.stdin!.end('crash'); await closed;
  await vi.waitFor(async () => expect(await fs.readFile(intent.receiptPath, 'utf8').catch(async () => await fs.readFile(path.join(root, 'supervisor.log'), 'utf8'))).toContain('"quiescent":true'), { timeout: 15000 });
  return { intent, late };
}

describe.runIf(process.platform === 'win32')('real app-death production recovery', () => {
  it.each(['pi', 'check', 'terminal'] as const)('recovers %s only from a supervisor receipt after detached descendants stop', async (kind) => {
    const { intent, late } = await crashHost(kind);
    const saved = record(kind === 'pi' ? [dispatch(intent.record.nonce)] : kind === 'check' ? [operation('check', 'verify')] : []);
    await persist(saved); const { runtime, terminals } = await boot();
    expect(runtime.service.get('mission')).toMatchObject({ status: 'paused', attempts: [], evidence: [], candidates: [] });
    expect(runtime.service.isQuiescent(runtime.service.get('mission')!)).toBe(true);
    expect(terminals.activity()).toEqual([]);
    expect(createAdapter).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 2400));
    expect(await fs.stat(late).catch(() => null)).toBeNull();
  }, 45000);
});

it('retains a terminal intent with no tab/owner-file until an exact positive receipt arrives', async () => {
  const intent = createProcessOwnershipIntent(path.join(terminalDir(), 'process-ownership', 'lead'), { kind: 'terminal', sessionId: 'lead', terminalId: 'lost-tab', cwd: project });
  await persist(record()); const { runtime, terminals } = await boot();
  expect(terminals.list()).toEqual([]);
  expect(terminals.activity()).toEqual([expect.objectContaining({ terminalId: 'lost-tab', state: 'uncertain' })]);
  expect(runtime.service.get('mission')!.status).toBe('recovering');
  recordUnlaunchedProcessIntent(intent);
  const proof = JSON.parse(await fs.readFile(intent.receiptPath, 'utf8'));
  await fs.writeFile(intent.receiptPath, JSON.stringify({ ...proof, kind: 'mission-pi' }));
  await terminals.reconcileOwnership(); expect(terminals.activity()).toHaveLength(1);
  await fs.writeFile(intent.receiptPath, JSON.stringify(proof));
  await terminals.reconcileOwnership(); expect(terminals.activity()).toEqual([]);
  expect(await processOwnershipQuiescent((await processOwnershipIntents(path.dirname(intent.path)))[0])).toBe(true);
});
