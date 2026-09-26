/** Failure recovery at the real SessionManager -> MissionService normalized-event boundary.
 * Only the harness process is scripted; admission, approvals, stores and attempt counts are real. */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsStore } from '../src/main/analytics';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { localMissionDeliveryPolicy } from '../src/main/mission/delivery';
import { MissionScheduler } from '../src/main/mission/scheduler';
import { MissionService } from '../src/main/mission/service';
import { assertMissionRecord } from '../src/main/mission/state';
import { MissionStore, MissionStoreError } from '../src/main/mission/store';
import type { MissionToolName } from '../src/main/mission/tools';
import { MissionVerification } from '../src/main/mission/verification';
import { MissionWorkspaces } from '../src/main/mission/workspaces';
import type { RuntimeResolver } from '../src/main/runtime';
import { SessionManager } from '../src/main/session-manager';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import { createDefaultMissionConfig } from '../src/shared/mission-config';
import type { MissionRecord, MissionResult } from '../src/shared/mission';
import type { SessionEvent, TranscriptItem, UserInput } from '../src/shared/types';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
const wait = (assert: () => void) => vi.waitFor(assert, { timeout: 15_000, interval: 20 });
let root: string, data: string, project: string, sessions: SessionManager, service: MissionService;
let store: MissionStore<MissionRecord>, scheduler: MissionScheduler, config: ReturnType<typeof createDefaultMissionConfig>;
let runtimes: Map<string, ReturnType<typeof scripted>>, sequence: number;
let startError: string | undefined, sendError: string | undefined;

function scripted(ctx: HarnessContext) {
  const adapter = {
    id: 'native', busy: false,
    start: vi.fn(async () => { if (ctx.session().mission?.role === 'worker' && startError) throw new Error(startError); }),
    missionReadiness: vi.fn(async () => ({ ready: true, tools: ['read', 'bash'] })),
    send: vi.fn(async (_input: UserInput) => {
      if (ctx.session().mission?.role === 'worker' && sendError) throw new Error(sendError);
      ctx.emit({ type: 'status', status: 'running' });
    }),
    interrupt: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
    setModel: vi.fn<HarnessAdapter['setModel']>(async (_model) => undefined),
    setEffort: vi.fn<HarnessAdapter['setEffort']>(async (_effort) => undefined),
    setPermissionMode: vi.fn(async () => undefined),
  } satisfies HarnessAdapter;
  return { ctx, adapter,
    finish: (status: 'completed' | 'failed' | 'interrupted' = 'failed', error?: string, id = `turn-${++sequence}`) => {
      ctx.emit({ type: 'item.upsert', item: { id, kind: 'turn', ts: Date.now(), status, error } });
      ctx.emit({ type: 'status', status: 'idle' });
      return id;
    },
    emit: (event: SessionEvent) => ctx.emit(event),
  };
}
async function tool(r: MissionRecord, name: MissionToolName, payload: Record<string, unknown>, sessionId = r.leadSessionId): Promise<unknown> {
  const owner = sessions.get(sessionId)!.mission!;
  const binding = { missionId: r.id, actor: owner.role === 'lead' ? { kind: 'lead' as const, sessionId, generation: owner.generation }
    : { kind: 'worker' as const, sessionId, generation: owner.generation, attemptId: owner.attemptId! } };
  const idempotencyKey = `tool-${++sequence}`;
  for (let i = 0; ; i++) {
    try { return await service.invoke(binding, name, { expectedRevision: service.get(r.id)!.revision, idempotencyKey, payload }); }
    catch (error) { if (!(error instanceof MissionStoreError) || error.code !== 'REVISION_CONFLICT' || i >= 10) throw error; }
  }
}
async function start() {
  const r = await service.create({ idempotencyKey: 'launch', projectRoot: project, objective: 'Investigate a bounded failure', mode: 'autonomous', permissionMode: 'auto' });
  await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  await tool(r, 'mission_profile_upsert', { profile: { id: 'reader', revision: 1, name: 'Reader', purpose: 'Read facts', instructions: 'Read and report', tierId: 3, contextRefs: [], requestedTools: ['read', 'bash'], sourceAccess: 'read_only', resultExpectations: 'Typed result' } });
  await tool(r, 'mission_plan_update', { expectedPlanRevision: 0, plan: { ...r.plan, criteria: [{ id: 'observed', description: 'Retain observed facts', required: true, evidenceKinds: ['behavior'] }] }, tasks: [{ id: 'task', revision: 1, specificationRevision: 1, objective: 'Investigate', scope: 'feature.txt', ownedPaths: ['feature.txt'], exclusions: [], dependsOn: [], decisionRefs: [], sharedContracts: [], requiredTools: ['read'], criteria: [], verificationIds: [], assignment: { kind: 'worker', profileId: 'reader', profileRevision: 1 }, required: true }] });
  return service.get(r.id)!;
}
async function delegate(r: MissionRecord, sent = true) {
  const result = await tool(r, 'mission_task_delegate', { taskId: 'task', presetId: 'standard', reason: 'Same bounded preset' }) as { attemptId: string; sessionId: string; operationId: string };
  if (sent) await wait(() => expect(runtimes.get(result.sessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  return result;
}
async function report(r: MissionRecord, attemptId: string, status: MissionResult['status'] = 'candidate', summary = 'Retained result', unresolved: MissionResult['unresolved'] = []) {
  const a = service.get(r.id)!.attempts.find((a) => a.id === attemptId)!;
  await tool(r, 'mission_report', { result: { taskId: a.taskId, taskRevision: a.taskRevision, specificationRevision: a.specificationRevision, attemptId, status, summary, artifactIds: [], evidenceIds: [], decisionIds: [], unresolved } }, a.sessionId);
}
function shell(runtime: ReturnType<typeof scripted>, command: string, output: string, exitCode = 1) {
  runtime.emit({ type: 'item.upsert', item: { id: `tool-${++sequence}`, kind: 'tool', ts: Date.now(), name: 'bash', hint: 'execute', input: { command }, output, exitCode, status: 'error' } });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-failures-')); project = path.join(root, 'project'); data = path.join(root, 'data');
  await fs.mkdir(project);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true });
  git('init', '-b', 'main'); git('config', 'user.name', 'Mission Test'); git('config', 'user.email', 'mission-test@example.invalid'); git('config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(project, 'feature.txt'), 'original\n'); git('add', '.'); git('commit', '-m', 'test: baseline');
  config = createDefaultMissionConfig();
  const preset = { id: 'frontier', revision: 1, name: 'Principal', harnessId: 'native' as const, model: { provider: 'fixture', model: 'frontier' }, reasoning: { kind: 'default' as const }, enabled: true };
  config.presets = [preset, { ...preset, id: 'standard', model: { provider: 'fixture', model: 'standard' } }]; config.defaultLeadPresetId = 'frontier';
  config.tiers[4].presetIds = ['frontier']; config.tiers[2].presetIds = ['standard'];
  const settings = defaultSettings(); settings.providers = []; settings.defaultEffort = undefined;
  const sessionStore = new SessionStore(data); await sessionStore.load();
  sessions = new SessionManager({ store: sessionStore, settings: { get: () => settings } as SettingsStore, runtime: {} as RuntimeResolver,
    analytics: { touchSession: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn() });
  store = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord }); await store.load();
  scheduler = new MissionScheduler(config.limits);
  const workspaces = new MissionWorkspaces({ root: path.join(data, 'workspaces'), quiescence: { acquire: async () => ({ assertQuiescent: async () => undefined, release: () => undefined }) } });
  const verification = new MissionVerification({ scheduler, contentIdentity: (cwd) => workspaces.contentIdentity(cwd), authorize: async () => undefined, saveArtifact: (id, bytes) => store.writeArtifact(id, bytes) });
  runtimes = new Map(); sequence = 0; startError = undefined; sendError = undefined;
  vi.mocked(createAdapter).mockReset().mockImplementation((_id, ctx) => { const runtime = scripted(ctx); runtimes.set(ctx.sessionId, runtime); return runtime.adapter; });
  service = new MissionService({ sessions, store, scheduler, workspaces, verification, settings: () => ({ config }), capabilities: { probe: async (_preset, scope) => {
    const { readiness } = await sessions.prepareManaged(scope.sessionId, scope.generation);
    return { source: 'runtime', runtime: { available: true, authenticated: true }, connectionAvailable: true, modelAvailable: true, projectAllowed: true,
      controlProtocol: readiness.ready, missionTools: readiness.ready, worktreeCwd: true, completionObservation: true, cancellationObservation: true, delegationControl: true, harnessCapabilities: { interrupt: true }, tools: readiness.tools };
  } }, delivery: { resolve: async () => localMissionDeliveryPolicy(), deliver: async () => { throw new Error('Not a delivery test'); } } });
});
afterEach(async () => {
  await service.close(); await sessions.stopAll(); await sessions.flushPendingPersists();
  vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Mission observed failures', () => {
  it.each([
    { kind: 'rate_limit', event: { type: 'error', message: 'HTTP 429 Too many requests; rate limit exceeded' } as SessionEvent },
    { kind: 'provider', event: { type: 'error', message: 'HTTP 503 Service unavailable' } as SessionEvent },
    { kind: 'environment', command: 'python --version', output: 'bash: python: command not found', exit: 127 },
    { kind: 'implementation', command: 'npm test', output: 'AssertionError: expected false to be true\nTests 1 failed', exit: 1 },
    { kind: 'integration', command: 'git merge feature', output: 'CONFLICT (content): Merge conflict in feature.txt\nAutomatic merge failed', exit: 1 },
  ])('classifies $kind without retrying, upgrading or changing accounts', async (fixture) => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    if (fixture.event) runtime.emit(fixture.event);
    else shell(runtime, fixture.command!, fixture.output!, fixture.exit);
    const turnId = runtime.finish();
    await wait(() => expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'failed', terminalTurnId: turnId, repairTurns: 0, failure: { kind: fixture.kind } }));
    await wait(() => expect(service.get(r.id)?.mailbox.some((mail) => mail.sessionId === worker.sessionId && mail.text.includes('Failure classification:'))).toBe(true));
    const current = service.get(r.id)!;
    expect(current.status).toBe('running'); expect(current.attempts).toHaveLength(1); expect(current.candidates).toHaveLength(0);
    expect(current.attempts[0].preset).toEqual(config.presets[1]); expect(current.leadPreset).toEqual(config.presets[0]);
    expect(current.attempts[0].failure).toMatchObject({ confidence: 'heuristic' });
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1); expect(runtime.adapter.interrupt).not.toHaveBeenCalled();
    expect(runtime.adapter.dispose).not.toHaveBeenCalled(); expect(runtimes.get(r.leadSessionId)!.adapter.send).toHaveBeenCalledTimes(1);
    const restored = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord }); await restored.load();
    expect(restored.get(r.id)?.attempts[0].failure).toEqual(current.attempts[0].failure);
    const lead = runtimes.get(r.leadSessionId)!;
    lead.finish('completed');
    await wait(() => expect(lead.adapter.send).toHaveBeenCalledTimes(2));
    expect(lead.adapter.send.mock.calls[1][0].text).toContain(`\"kind\":\"${fixture.kind}\"`);
    expect(lead.adapter.send.mock.calls[1][0].text).toContain('No preset, account, permission or retry policy was changed.');
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1); expect(service.get(r.id)?.attempts).toHaveLength(1);
  });

  it.each([
    { output: 'ModuleNotFoundError: No module named pytest_dependency', kind: 'environment', status: 'running' },
    { output: 'PermissionError: EACCES: permission denied opening required fixture', kind: 'permission', status: 'paused' },
  ])('does not relabel $kind diagnostics as implementation failures just because pytest exited 1', async (fixture) => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    shell(runtime, 'pytest tests/test_required.py', fixture.output);
    runtime.finish();
    await wait(() => expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'failed', repairTurns: 0, failure: { kind: fixture.kind, source: 'tool', confidence: 'heuristic' } }));
    await wait(() => expect(service.get(r.id)?.status).toBe(fixture.status));
    expect(service.get(r.id)?.attempts).toHaveLength(1); expect(service.get(r.id)?.candidates).toHaveLength(0);
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1); expect(service.get(r.id)?.attempts[0].preset).toEqual(config.presets[1]);
  });

  it('keeps a normalized provider failure ahead of a secondary implementation diagnostic', async () => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    runtime.emit({ type: 'error', message: 'HTTP 503 Service unavailable' });
    shell(runtime, 'npm test', 'AssertionError: expected true to be false\nTests 1 failed');
    runtime.finish();
    await wait(() => expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'failed', failure: { kind: 'provider', source: 'error' } }));
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1); expect(service.get(r.id)?.attempts).toHaveLength(1);
  });

  it('leaves normalized Pi/Codex backoff with the harness and ignores recovered trouble on success', async () => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    runtime.emit({ type: 'item.upsert', item: { id: 'pi-backoff', kind: 'info', ts: Date.now(), level: 'warn', text: 'Retrying (1/3): HTTP 429 rate limit exceeded' } });
    runtime.emit({ type: 'item.upsert', item: { id: 'codex-backoff', kind: 'info', ts: Date.now(), level: 'warn', text: '503 Service unavailable (retrying)' } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'running', repairTurns: 0 });
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1); expect(runtime.adapter.interrupt).not.toHaveBeenCalled();
    await report(r, worker.attemptId); runtime.finish('completed');
    await wait(() => expect(service.get(r.id)?.candidates).toHaveLength(1));
    expect(service.get(r.id)?.attempts[0]).toMatchObject({ outcome: 'submitted', repairTurns: 0 });
    expect(service.get(r.id)?.attempts[0].failure).toBeUndefined(); expect(service.get(r.id)?.attempts).toHaveLength(1);
  });

  it('uses retained backoff on exhausted turns, then requires a lead decision for one new same-preset attempt', async () => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    runtime.emit({ type: 'item.upsert', item: { id: 'retry', kind: 'info', ts: Date.now(), level: 'warn', text: 'Retrying (3/3): 429 Too many requests' } });
    runtime.finish();
    await wait(() => expect(service.get(r.id)?.attempts[0].failure).toMatchObject({ kind: 'rate_limit', source: 'backoff', recovery: 'same_preset_after_backoff' }));
    expect(service.get(r.id)?.attempts).toHaveLength(1); expect(runtime.adapter.send).toHaveBeenCalledTimes(1);
    await tool(r, 'mission_task_diagnose', { taskId: 'task', afterAttempt: worker.attemptId, approach: 'Provider backoff has settled. Inspect retained work before a single explicit same-preset attempt.' });
    const next = await delegate(r), second = runtimes.get(next.sessionId)!;
    runtime.emit({ type: 'error', message: '401 invalid API key' }); runtime.finish();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(service.get(r.id)?.attempts[1]).toMatchObject({ status: 'running', preset: config.presets[1] });
    second.finish('failed', '503 Service unavailable');
    await wait(() => expect(service.get(r.id)?.attempts[1].failure?.kind).toBe('provider'));
    expect(service.get(r.id)?.attempts).toHaveLength(2); expect(second.adapter.send).toHaveBeenCalledTimes(1); expect(runtime.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('uses actual approval option kinds, not option IDs or model claims, and pauses on denial', async () => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    const decision = runtime.ctx.requestApproval({ kind: 'command', title: 'Read protected facts', options: [{ id: 'opaque-yes', label: 'Allow', kind: 'allow' }, { id: 'opaque-no', label: 'No', kind: 'deny' }] });
    const items = await sessions.transcript(worker.sessionId);
    const approval = items.findLast((item): item is Extract<TranscriptItem, { kind: 'approval' }> => item.kind === 'approval')!;
    await sessions.respondApproval(worker.sessionId, approval.request.id, { optionId: 'opaque-no' }); await decision;
    runtime.finish('failed', '503 Service unavailable'); // A later provider failure cannot turn the denial into retry authority.
    await wait(() => expect(service.get(r.id)?.status).toBe('paused'));
    expect(service.get(r.id)?.attempts[0]).toMatchObject({ outcome: 'failed', repairTurns: 0, failure: { kind: 'permission', confidence: 'observed', source: 'approval', recovery: 'user_action' } });
    expect(service.get(r.id)?.attempts).toHaveLength(1); expect(runtime.adapter.send).toHaveBeenCalledTimes(1); expect(scheduler.snapshot().active).toHaveLength(0);
    expect(service.get(r.id)?.requestedPermissionMode).toBe('auto');
    const pausedLead = runtimes.get(r.leadSessionId)!;
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'explicit-resume', control: { action: 'resume' } });
    await wait(() => expect(runtimes.get(r.leadSessionId)).not.toBe(pausedLead));
    await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
    expect(runtimes.get(r.leadSessionId)!.adapter.send.mock.calls[0][0].text).toContain('Failure classification:');
    expect(service.get(r.id)?.requestedPermissionMode).toBe('auto'); expect(service.get(r.id)?.attempts).toHaveLength(1); expect(runtime.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('does not infer denial from an option ID whose actual action was allow', async () => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    const decision = runtime.ctx.requestApproval({ kind: 'command', title: 'Inspect protected input', options: [{ id: 'deny', label: 'Permit this action', kind: 'allow' }, { id: 'opaque-stop', label: 'Refuse', kind: 'deny' }] });
    const items = await sessions.transcript(worker.sessionId);
    const approval = items.findLast((item): item is Extract<TranscriptItem, { kind: 'approval' }> => item.kind === 'approval')!;
    await sessions.respondApproval(worker.sessionId, approval.request.id, { optionId: 'deny' }); await decision;
    runtime.finish();
    await wait(() => expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'failed', failure: { kind: 'unknown' } }));
    expect(service.get(r.id)?.status).toBe('running'); expect(service.get(r.id)?.attempts).toHaveLength(1);
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1); expect(runtime.adapter.interrupt).not.toHaveBeenCalled();
  });

  it.each([
    { reason: 'spawn python ENOENT', stage: 'start', kind: 'environment', sends: 0, status: 'running' },
    { reason: 'HTTP 429 Too many requests', stage: 'send', kind: 'rate_limit', sends: 1, status: 'running' },
    { reason: '401 invalid API key', stage: 'send', kind: 'provider', sends: 1, status: 'paused' },
    { reason: 'opaque runtime rejection', stage: 'send', kind: 'unknown', sends: 1, status: 'running' },
  ])('classifies dispatch $reason and retains exact send/attempt counts', async (fixture) => {
    const r = await start();
    if (fixture.stage === 'start') startError = fixture.reason; else sendError = fixture.reason;
    const worker = await delegate(r, false);
    await wait(() => expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'failed', failure: { kind: fixture.kind } }));
    await wait(() => expect(service.get(r.id)?.status).toBe(fixture.status));
    expect(service.get(r.id)?.attempts).toHaveLength(1); expect(runtimes.get(worker.sessionId)!.adapter.send).toHaveBeenCalledTimes(fixture.sends);
    expect(service.get(r.id)?.operations.find((op) => op.id === worker.operationId)).toMatchObject({ state: 'failed', payload: { failure: { kind: fixture.kind } } });
    expect(service.get(r.id)?.attempts[0].preset).toEqual(config.presets[1]); expect(service.get(r.id)?.candidates).toHaveLength(0);
  });

  it('pauses on normalized credential failures and retains a human-action notice without retry', async () => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    runtime.emit({ type: 'status', status: 'error', detail: '401 invalid API key' }); runtime.finish();
    await wait(() => expect(service.get(r.id)?.status).toBe('paused'));
    const current = service.get(r.id)!;
    expect(current.attempts).toEqual([expect.objectContaining({ status: 'terminal', outcome: 'failed', repairTurns: 0, failure: expect.objectContaining({ kind: 'provider', source: 'status', code: 'credentials_unavailable', recovery: 'user_action' }) })]);
    expect(current.mailbox).toContainEqual(expect.objectContaining({ kind: 'permission', sessionId: worker.sessionId, text: expect.stringContaining('Resume explicitly after resolution') }));
    expect(scheduler.snapshot().active).toEqual([]); expect(current.candidates).toEqual([]);
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1); expect(current.attempts[0].preset).toEqual(config.presets[1]);
  });

  it('settles a fatal runtime error without fabricating a terminal turn or another attempt', async () => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    runtime.emit({ type: 'error', fatal: true, message: 'HTTP 503 Service unavailable' });
    await wait(() => expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'failed', failure: { kind: 'provider' } }));
    runtime.finish('completed'); // Disposed runtime must not turn its failure into a candidate.
    expect(service.get(r.id)?.operations.find((op) => op.id === worker.operationId)).toMatchObject({ state: 'failed', payload: { failure: { kind: 'provider' } } });
    expect(service.get(r.id)?.attempts[0].terminalTurnId).toBeUndefined(); expect(service.get(r.id)?.progress.completedTurns).toBe(0);
    expect(service.get(r.id)?.attempts).toHaveLength(1); expect(service.get(r.id)?.candidates).toHaveLength(0);
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1); expect(runtime.adapter.dispose).toHaveBeenCalledTimes(1);
  });

  it('ignores retired generation callbacks and classifies only the current lead terminal', async () => {
    const r = await start(), retired = runtimes.get(r.leadSessionId)!;
    const control = (control: Parameters<MissionService['control']>[0]['control']) => service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: `control-${++sequence}`, control });
    await control({ action: 'pause' });
    const handover = await control({ action: 'replace_lead', presetId: 'frontier' });
    expect(handover.leadGeneration).toBe(2); expect(handover.leadSessionId).not.toBe(r.leadSessionId);
    await control({ action: 'resume' });
    await wait(() => expect(runtimes.get(handover.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
    const before = service.get(r.id)!;
    retired.emit({ type: 'error', message: '401 invalid API key' }); retired.finish('failed', '429 Too many requests');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(service.get(r.id)).toEqual(before);
    const current = runtimes.get(handover.leadSessionId)!;
    current.finish('failed', '503 Service unavailable');
    await wait(() => expect(service.get(r.id)?.status).toBe('blocked'));
    const result = service.get(r.id)!;
    expect(result.leadGeneration).toBe(2); expect(result.attempts).toHaveLength(0); expect(result.progress.completedTurns).toBe(before.progress.completedTurns + 1);
    expect(result.blockers).toHaveLength(1); expect(result.blockers[0].kind).toBe('provider');
    expect(result.operations.findLast((op) => op.payload.sessionId === handover.leadSessionId)).toMatchObject({ state: 'failed', payload: { failure: { kind: 'provider', source: 'turn' } } });
    expect(retired.adapter.send).toHaveBeenCalledTimes(1); expect(current.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('does not carry recovered trouble or duplicate old terminals into the one format repair', async () => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    runtime.emit({ type: 'error', message: '429 Too many requests' });
    runtime.finish('completed', undefined, 'first-turn');
    await wait(() => expect(runtime.adapter.send).toHaveBeenCalledTimes(2));
    runtime.finish('failed', '401 invalid API key', 'first-turn');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'running', repairTurns: 1 });
    runtime.finish('failed');
    await wait(() => expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'failed', repairTurns: 1, failure: { kind: 'unknown', confidence: 'unknown' } }));
    expect(service.get(r.id)?.status).toBe('running'); expect(service.get(r.id)?.attempts).toHaveLength(1); expect(runtime.adapter.send).toHaveBeenCalledTimes(2);
  });

  it('fences a retired runtime on the same lead session when a fresh implementation attempt takes ownership', async () => {
    const r = await start(), retired = runtimes.get(r.leadSessionId)!;
    const current = service.get(r.id)!, { status: _status, ...contract } = current.tasks[0];
    await tool(r, 'mission_plan_update', { expectedPlanRevision: current.planRevision, plan: current.plan, tasks: [{ ...contract, revision: 2, assignment: { kind: 'lead' } }] });
    const claim = await tool(r, 'mission_task_claim', { taskId: 'task' }) as { attemptId: string; sessionId: string; operationId: string };
    retired.finish('completed');
    await wait(() => expect(runtimes.get(r.leadSessionId)).not.toBe(retired));
    const runtime = runtimes.get(r.leadSessionId)!;
    await wait(() => expect(runtime.adapter.send).toHaveBeenCalledTimes(1));
    const before = service.get(r.id)!;
    retired.emit({ type: 'error', message: '401 invalid API key', fatal: true });
    retired.emit({ type: 'status', status: 'error', detail: 'Permission denied' });
    retired.finish('failed', '429 Too many requests');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(service.get(r.id)).toEqual(before); expect(sessions.activity(r.leadSessionId).turn).toBe(true);
    runtime.finish('failed', '503 Service unavailable');
    await wait(() => expect(service.get(r.id)?.attempts[0]).toMatchObject({ id: claim.attemptId, status: 'terminal', outcome: 'failed', failure: { kind: 'provider', source: 'turn' } }));
    expect(service.get(r.id)?.attempts).toHaveLength(1); expect(service.get(r.id)?.progress.completedTurns).toBe(before.progress.completedTurns + 1);
    expect(retired.adapter.send).toHaveBeenCalledTimes(1); expect(runtime.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('requires diagnosis at exactly the configured failure bound and does not reuse it after the next failed attempt', async () => {
    const r = await start(), limit = r.config.limits.maxTaskAttemptsBeforeLeadDiagnosis;
    const workers: Awaited<ReturnType<typeof delegate>>[] = [];
    for (let index = 0; index < limit; index++) {
      const worker = await delegate(r); workers.push(worker);
      runtimes.get(worker.sessionId)!.finish('failed', '429 Too many requests');
      await wait(() => expect(service.get(r.id)?.attempts[index]).toMatchObject({ status: 'terminal', outcome: 'failed', repairTurns: 0, failure: { kind: 'rate_limit' } }));
    }
    const refused = await delegate(r, false);
    await wait(() => expect(service.get(r.id)?.operations.find((op) => op.id === refused.operationId)?.state).toBe('failed'));
    await wait(() => expect(service.get(r.id)?.mailbox).toContainEqual(expect.objectContaining({ text: expect.stringContaining('Repeated failures require lead diagnosis of the latest failed attempt') })));
    expect(service.get(r.id)?.attempts).toHaveLength(limit); expect(runtimes.has(refused.sessionId)).toBe(false);
    for (const worker of workers) expect(runtimes.get(worker.sessionId)!.adapter.send).toHaveBeenCalledTimes(1);
    await expect(tool(r, 'mission_task_diagnose', { taskId: 'task', afterAttempt: workers[0].attemptId, approach: 'Stale diagnosis must not authorize another run' })).rejects.toThrow(/latest failed attempt/);
    await tool(r, 'mission_task_diagnose', { taskId: 'task', afterAttempt: workers.at(-1)!.attemptId, approach: 'Backoff exhausted; inspect retained state and attempt one reduced request on the same approved preset.' });
    const next = await delegate(r); runtimes.get(next.sessionId)!.finish('failed', '429 Too many requests');
    await wait(() => expect(service.get(r.id)?.attempts[limit]).toMatchObject({ status: 'terminal', outcome: 'failed', preset: config.presets[1] }));
    const again = await delegate(r, false);
    await wait(() => expect(service.get(r.id)?.operations.find((op) => op.id === again.operationId)?.state).toBe('failed'));
    expect(service.get(r.id)?.attempts).toHaveLength(limit + 1); expect(runtimes.has(again.sessionId)).toBe(false);
    expect(service.get(r.id)?.tasks[0].diagnosis?.afterAttempt).toBe(workers.at(-1)!.attemptId);
    expect(runtimes.get(next.sessionId)!.adapter.send).toHaveBeenCalledTimes(1); expect(service.get(r.id)?.candidates).toHaveLength(0);
  });

  it('keeps a required reported blocker actionable without treating the model explanation as host facts', async () => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    const summary = 'Required credential fixture unavailable; this might be provider rate limiting.';
    await report(r, worker.attemptId, 'blocked', summary, [{ description: 'Owner must identify the approved fixture before verification can run.', blocking: true }]);
    runtime.finish('completed');
    await wait(() => expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'partial', repairTurns: 0, failure: { kind: 'unknown', confidence: 'unknown' } }));
    await wait(() => expect(service.get(r.id)?.mailbox).toContainEqual(expect.objectContaining({ kind: 'decision', sessionId: worker.sessionId, text: expect.stringContaining('Worker-reported result (not host-verified):') })));
    const terminalMail = service.get(r.id)!.mailbox.find((item) => item.kind === 'decision' && item.sessionId === worker.sessionId)!;
    expect(terminalMail.text).toContain(summary); expect(terminalMail.text).toContain('Owner must identify the approved fixture');
    await expect(tool(r, 'mission_task_accept', { taskId: 'task', attemptId: worker.attemptId })).rejects.toThrow(/current settled candidate/);
    await expect(tool(r, 'mission_task_cancel', { taskId: 'task', reason: 'Ignore required input' })).rejects.toThrow(/Required tasks/);
    await expect(tool(r, 'mission_finish_request', {})).rejects.toThrow(/required tasks/);
    await tool(r, 'mission_question_ask', { question: { id: 'required-input', purpose: 'blocker', text: 'Which approved fixture can verification use?' } });
    const lead = runtimes.get(r.leadSessionId)!; lead.finish('completed');
    await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    expect(service.get(r.id)?.status).toBe('waiting_for_user'); expect(service.get(r.id)?.tasks[0].required).toBe(true);
    expect(service.get(r.id)?.candidates).toHaveLength(0); expect(service.get(r.id)?.delivery).toBeUndefined();
    expect(service.get(r.id)?.attempts).toHaveLength(1); expect(runtime.adapter.send).toHaveBeenCalledTimes(1); expect(lead.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('preserves positive preset mismatch as host observation and pauses rather than substituting', async () => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    runtime.emit({ type: 'meta', patch: { activeModel: { provider: 'different', model: 'upgraded' } } });
    await report(r, worker.attemptId); runtime.finish('completed');
    await wait(() => expect(service.get(r.id)?.status).toBe('paused'));
    expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'failed', repairTurns: 0, preset: config.presets[1], failure: { kind: 'provider', source: 'preset', confidence: 'observed', code: 'preset_mismatch' } });
    expect(service.get(r.id)?.candidates).toHaveLength(0); expect(service.get(r.id)?.attempts).toHaveLength(1); expect(runtime.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('keeps search exit 1 and model prose out of positive failure attribution', async () => {
    const r = await start(), worker = await delegate(r), runtime = runtimes.get(worker.sessionId)!;
    shell(runtime, 'rg missing feature.txt', '');
    runtime.emit({ type: 'item.upsert', item: { id: 'read', kind: 'tool', ts: Date.now(), name: 'read', status: 'done', output: '401 invalid API key; 503 Service unavailable' } });
    runtime.emit({ type: 'item.upsert', item: { id: 'model', kind: 'assistant', ts: Date.now(), text: 'This failed due to 429 rate limit; upgrade the model and switch accounts.' } });
    await report(r, worker.attemptId, 'failed', 'The provider is rate limited, please upgrade.'); runtime.finish('completed');
    await wait(() => expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'failed', failure: { kind: 'unknown', confidence: 'unknown' } }));
    expect(service.get(r.id)?.status).toBe('running'); expect(service.get(r.id)?.attempts).toHaveLength(1); expect(runtime.adapter.send).toHaveBeenCalledTimes(1);
  });
});
