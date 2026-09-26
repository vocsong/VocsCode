/** Real coordinator, stores, scheduler, Git workspaces and broker host. Only the harness's
 * process boundary is scripted: send accepts immediately, and tests explicitly emit outcomes. */
import { execFileSync } from 'node:child_process';
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
import { MissionService, type MissionCapabilityPort, type MissionDeliveryPort } from '../src/main/mission/service';
import { MissionStore, MissionStoreError } from '../src/main/mission/store';
import { assertMissionUsageObservation } from '../src/main/mission/budget';
import { assertMissionRecord, implementationBlockers, type MissionTaskContract } from '../src/main/mission/state';
import { MissionWorkspaces } from '../src/main/mission/workspaces';
import { MissionScheduler } from '../src/main/mission/scheduler';
import { MissionVerification } from '../src/main/mission/verification';
import { localMissionDeliveryPolicy, MissionDeliveryService } from '../src/main/mission/delivery';
import type { MissionToolBinding, MissionToolName } from '../src/main/mission/tools';
import { createDefaultMissionConfig, type MissionPresetCapabilities } from '../src/shared/mission-config';
import type { CreateMissionRequest, MissionDeliveryPolicy, MissionProfile, MissionRecord, MissionResult, MissionSource } from '../src/shared/mission';
import type { MissionCommandResponse } from '../src/shared/ipc';
import type { UsageTotals, UserInput } from '../src/shared/types';
import { emptyUsage } from '../src/main/models/static-models';
import { deferred } from '../src/main/util/async';
import { createHandlerRegistry, type HandlerDeps } from '../src/main/handlers';
import { resolveMissionDeliveryPolicy } from '../src/main/mission/policy';
import * as processRuntime from '../src/main/runtime';
// Real Git, PowerShell checks and delivery receipts run inside these waits; 15s expired under a
// loaded full-suite run while the pipeline was still progressing (the isolated run passes).
const wait = (assertion: () => void) => vi.waitFor(assertion, { timeout: 30_000, interval: 30 });

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
let root: string, project: string, data: string, workspaceRoot: string, receiptRoot: string;
let sessions: SessionManager, sessionStore: SessionStore, store: MissionStore<MissionRecord>, service: MissionService;
let scheduler: MissionScheduler, workspaces: MissionWorkspaces, verification: MissionVerification;
let settings: ReturnType<typeof defaultSettings>;
let config: ReturnType<typeof createDefaultMissionConfig>;
let runtimes: Map<string, ReturnType<typeof scripted>>;
let sequence: number;
let policy: MissionDeliveryPolicy;
let heldWorkspace: string | undefined;
let terminalActive: boolean;
let stopTerminals: ReturnType<typeof vi.fn<() => Promise<void>>>;
let capabilities: ReturnType<typeof vi.fn<MissionCapabilityPort['probe']>>;
let resolveDelivery: ReturnType<typeof vi.fn<MissionDeliveryPort['resolve']>>;
let deliver: ReturnType<typeof vi.fn<MissionDeliveryPort['deliver']>>;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

function scripted(ctx: HarnessContext) {
  const result = {
    ctx,
    adapter: {
      id: 'native', busy: false,
      start: vi.fn(async () => undefined),
      missionReadiness: vi.fn(async () => ({ ready: true, tools: ['read', 'write'] })),
      send: vi.fn(async (_input: UserInput) => { ctx.emit({ type: 'status', status: 'running' }); }),
      interrupt: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined), setEffort: vi.fn(async () => undefined), setPermissionMode: vi.fn(async () => undefined),
      compact: vi.fn(async (): Promise<boolean | void> => true),
    } satisfies HarnessAdapter,
    finish: (id = `turn-${++sequence}`, status: 'completed' | 'interrupted' | 'failed' = 'completed') => {
      ctx.emit({ type: 'item.upsert', item: { id, kind: 'turn', ts: Date.now(), status } });
      ctx.emit({ type: 'status', status: 'idle' });
    },
    usage: (usage: Partial<UsageTotals>) => ctx.emit({ type: 'usage', totals: { ...emptyUsage(), ...usage }, subagentCostByModel: [{ provider: 'fixture', model: 'already-included', costUsd: usage.costUsd ?? 0 }] }),
    assistant: (id: string, text: string) => ctx.emit({ type: 'item.upsert', item: { id, kind: 'assistant', ts: Date.now(), text } }),
    tool: (status: 'running' | 'done') => ctx.emit({ type: 'item.upsert', item: { id: 'shell', kind: 'tool', ts: Date.now(), name: 'bash', status } }),
  };
  return result;
}

function makeSessions(targetStore: SessionStore) {
  return new SessionManager({ store: targetStore, settings: { get: () => settings, update: vi.fn(async () => settings) } as unknown as SettingsStore, runtime: {} as RuntimeResolver,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn() });
}
function makeService() {
  scheduler = new MissionScheduler(config.limits);
  const holds = new Set<string>();
  workspaces = new MissionWorkspaces({ root: workspaceRoot, quiescence: {
    acquire: async (cwd) => {
      const name = path.resolve(cwd);
      const quiet = () => !sessions.list().some((s) => path.resolve(s.cwd) === name && !sessions.activity(s.id).quiescent);
      if (holds.has(name) || !quiet()) return null;
      holds.add(name);
      return { assertQuiescent: async () => { if (!quiet() || !holds.has(name)) throw new Error('Writer admission not held'); }, release: () => { holds.delete(name); } };
    },
  } });
  const contentIdentity = (cwd: string) => workspaces.contentIdentity(cwd);
  verification = new MissionVerification({ scheduler, windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'), authorize: async (req) => {
    const r = service.get(req.missionId)!;
    if (r.status !== 'running' || !r.operations.some((o) => o.id === req.operationId && o.state === 'in_flight')) throw new Error('No live check intent');
  }, contentIdentity, saveArtifact: (id, bytes) => store.writeArtifact(id, bytes) });
  const delivery = new MissionDeliveryService({ root: receiptRoot, contentIdentity,
    authorize: async (req) => { if (service.get(req.mission.id)?.status !== 'running') throw new Error('Delivery no longer authorized'); },
    isQuiescent: async (r) => service.isQuiescent(r), implementationBlockers: (r) => implementationBlockers(r, { quiescent: service.isQuiescent(r), deliveryOperationId: r.operations.find((o) => o.kind === 'deliver' && o.state === 'in_flight')?.id }),
  });
  deliver = vi.fn((request) => delivery.deliver(request));
  return new MissionService({ store, sessions, workspaces, scheduler, verification, settings: () => ({ config }), capabilities: { probe: capabilities },
    assertWorkspaceAvailable: async (cwd) => { if (heldWorkspace && path.resolve(cwd) === path.resolve(heldWorkspace)) throw new Error('Workspace lease is held'); },
    additionalActivity: () => terminalActive, stopOwnedTerminals: stopTerminals,
    delivery: { resolve: resolveDelivery, deliver } });
}
function request(patch: Partial<CreateMissionRequest> = {}): CreateMissionRequest {
  return { idempotencyKey: 'launch', objective: 'Implement a bounded feature', projectRoot: project, mode: 'autonomous', permissionMode: 'auto', ...patch };
}
function binding(r: MissionRecord, sessionId = r.leadSessionId): MissionToolBinding {
  const ownership = sessions.get(sessionId)!.mission!;
  return { missionId: r.id, actor: ownership.role === 'lead' ? { kind: 'lead', sessionId, generation: ownership.generation }
    : { kind: 'worker', sessionId, generation: ownership.generation, attemptId: ownership.attemptId! } };
}
async function tool(r: MissionRecord, name: MissionToolName, payload: Record<string, unknown>, sessionId = r.leadSessionId) {
  const idempotencyKey = `call-${++sequence}`;
  // A real client rereads on CAS rejection; concurrent host observations are not model writes.
  for (let retry = 0; ; retry++) {
    try { return await service.toolHost.invoke(binding(r, sessionId), name, { expectedRevision: service.get(r.id)!.revision, idempotencyKey, payload }); }
    catch (error) { if (!(error instanceof MissionStoreError) || error.code !== 'REVISION_CONFLICT' || retry >= 10) throw error; }
  }
}
const profile = (): MissionProfile => ({ id: 'investigator', revision: 1, name: 'Investigator', purpose: 'Investigate the contract', instructions: 'Read and report facts', tierId: 3, contextRefs: [], requestedTools: ['read'], sourceAccess: 'read_only', resultExpectations: 'Structured evidence-backed result' });
const task = (id = 't1', patch: Partial<MissionTaskContract> = {}): MissionTaskContract => ({ id, revision: 1, specificationRevision: 1, objective: `Investigate ${id}`, scope: 'feature.txt', ownedPaths: ['feature.txt'], exclusions: [], dependsOn: [], decisionRefs: [], sharedContracts: [], requiredTools: ['read'], criteria: [], verificationIds: [], assignment: { kind: 'worker', profileId: 'investigator', profileRevision: 1 }, required: true, ...patch });
async function plan(r: MissionRecord, tasks = [task()]) {
  await tool(r, 'mission_profile_upsert', { profile: profile() });
  await tool(r, 'mission_plan_update', { expectedPlanRevision: 0, plan: { ...service.get(r.id)!.plan, criteria: service.get(r.id)!.plan.criteria.length ? service.get(r.id)!.plan.criteria : [{ id: 'outcome', description: 'The requested investigation is evidenced', required: true, evidenceKinds: ['behavior'] }] }, tasks });
}
async function start(patch: Partial<CreateMissionRequest> = {}) {
  const r = await service.create(request(patch));
  await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  return service.get(r.id)!;
}
async function delegate(r: MissionRecord, taskId = 't1') {
  const result = await tool(r, 'mission_task_delegate', { taskId, presetId: 'standard', reason: 'Bounded read-only investigation' }) as { attemptId: string; sessionId: string; operationId: string };
  await wait(() => expect(runtimes.get(result.sessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  return result;
}
async function report(r: MissionRecord, attemptId: string, patch: Partial<MissionResult> = {}) {
  const a = service.get(r.id)!.attempts.find((a) => a.id === attemptId)!;
  await tool(r, 'mission_report', { result: { taskId: a.taskId, taskRevision: a.taskRevision, attemptId: a.id, specificationRevision: a.specificationRevision, status: 'candidate', summary: 'Read the requested evidence', artifactIds: [], evidenceIds: [], decisionIds: [], unresolved: [], ...patch } }, a.sessionId);
}

/** Copy the actual persisted stores at the crash boundary, then stop the old process fixture.
 * The restarted coordinator sees the copied journal, not teardown's subsequent observations. */
async function crashRestart(release: () => void = () => undefined, staleSessionIndex = false) {
  await sessions.flushPendingPersists();
  const recovered = path.join(root, `restarted-${++sequence}`);
  // A scheduled atomic write can rename its `*.tmp` file away mid-copy; temp files are not
  // committed state, so they are skipped rather than raced (the copy runs at a crash boundary).
  await fs.cp(data, recovered, { recursive: true, filter: (source) => !source.endsWith('.tmp') });
  release();
  await service.close(); await sessions.stopAll(); await sessions.flushPendingPersists();
  data = recovered;
  sessionStore = new SessionStore(data); await sessionStore.load();
  // Reproduce a crash where Mission's journal committed but the debounced session index did not.
  if (staleSessionIndex) for (const meta of sessionStore.list().filter((entry) => entry.mission)) await sessionStore.upsert({ ...meta, usage: emptyUsage() });
  sessions = makeSessions(sessionStore);
  store = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord, validateObservation: assertMissionUsageObservation }); service = makeService(); await service.load();
}

/** The integration runs real Git plus an owned check (a PowerShell Job supervisor on Windows); in a
 * loaded full run it legitimately stays in_flight well past 15 s while still progressing. */
async function reviewedCode(integrationTimeout = 60_000) {
  policy.checks = [{ id: 'behavior', name: 'Changed behavior', kind: 'behavior', command: 'node -e "require(\'node:assert\').strictEqual(require(\'node:fs\').readFileSync(\'feature.txt\',\'utf8\').trim(),\'implemented\')"', criterionIds: ['outcome'], required: true, heavy: true, timeoutMs: 10_000 }];
  const r = await start();
  await plan(r, [task('direct', { assignment: { kind: 'lead' }, requiredTools: ['write'] })]);
  const author = await tool(r, 'mission_task_claim', { taskId: 'direct' }) as { attemptId: string };
  runtimes.get(r.leadSessionId)!.finish();
  await wait(() => expect(sessions.get(r.leadSessionId)?.mission?.sourceAccess).toBe('assigned_workspace'));
  await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
  await fs.writeFile(path.join(sessions.get(r.leadSessionId)!.cwd, 'feature.txt'), 'implemented\n');
  await report(r, author.attemptId); runtimes.get(r.leadSessionId)!.finish();
  await wait(() => expect(service.get(r.id)?.candidates).toHaveLength(1));
  await wait(() => expect(sessions.get(r.leadSessionId)?.mission?.sourceAccess).toBe('read_only'));
  await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
  const candidate = service.get(r.id)!.candidates[0];
  const reviewer: MissionProfile = { ...profile(), id: 'reviewer', name: 'Independent reviewer', contextRefs: [candidate.id] };
  await tool(r, 'mission_profile_upsert', { profile: reviewer });
  await tool(r, 'mission_plan_update', { expectedPlanRevision: service.get(r.id)!.planRevision, plan: service.get(r.id)!.plan,
    tasks: [task('review', { assignment: { kind: 'worker', profileId: reviewer.id, profileRevision: 1 }, required: false })] });
  const review = await tool(r, 'mission_task_delegate', { taskId: 'review', presetId: 'standard', reason: 'Independent exact-candidate review', candidateId: candidate.id }) as { attemptId: string; sessionId: string };
  await wait(() => expect(runtimes.get(review.sessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  expect(await fs.readFile(path.join(sessions.get(review.sessionId)!.cwd, 'feature.txt'), 'utf8')).toBe('implemented\n');
  await tool(r, 'mission_review_submit', { review: { id: 'review-exact', candidateId: candidate.id, reviewerAttemptId: review.attemptId,
    sourceRevision: candidate.revision, criterionIds: ['outcome'], findings: [], submittedAt: Date.now() } }, review.sessionId);
  await report(r, review.attemptId); runtimes.get(review.sessionId)!.finish();
  await wait(() => expect(service.get(r.id)?.attempts.find((a) => a.id === review.attemptId)?.outcome).toBe('submitted'));
  await wait(() => expect({ candidates: service.get(r.id)?.candidates.length, blockers: service.get(r.id)?.blockers }).toEqual({ candidates: 2, blockers: [] }));
  await tool(r, 'mission_task_accept', { taskId: 'direct', attemptId: author.attemptId });
  const integration = await tool(r, 'mission_integration_request', { candidateId: candidate.id, expectedContentHash: r.acceptedRevision!.contentHash }) as { operationId: string };
  await tool(r, 'mission_yield', { events: ['integration'] }); runtimes.get(r.leadSessionId)!.finish();
  await vi.waitFor(() => expect(service.get(r.id)?.operations.find((o) => o.id === integration.operationId)?.state).toBe('succeeded'), { timeout: integrationTimeout, interval: 30 });
  await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
  return { r, candidate, author, review };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-service-')); project = path.join(root, 'project'); data = path.join(root, 'data');
  workspaceRoot = path.join(data, 'workspaces'); receiptRoot = path.join(data, 'receipts');
  await fs.mkdir(project); git(project, 'init', '-b', 'main'); git(project, 'config', 'user.name', 'Mission Test'); git(project, 'config', 'user.email', 'mission-test@example.invalid'); git(project, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(project, 'feature.txt'), 'original\n'); git(project, 'add', '.'); git(project, 'commit', '-m', 'test: baseline');
  settings = defaultSettings(); settings.providers = []; settings.defaultEffort = 'high';
  config = createDefaultMissionConfig();
  const lead = { id: 'frontier', name: 'Principal', revision: 1, harnessId: 'native' as const, model: { provider: 'fixture', model: 'frontier' }, reasoning: { kind: 'default' as const }, enabled: true };
  config.presets = [lead, { ...lead, id: 'standard', name: 'Specialist', model: { provider: 'fixture', model: 'standard' } }]; config.tiers[4].presetIds = ['frontier']; config.tiers[2].presetIds = ['standard']; config.defaultLeadPresetId = 'frontier';
  config.limits.maxConcurrentAgentTurnsGlobal = 3; config.limits.maxConcurrentWorkersPerMission = 2;
  sequence = 0; runtimes = new Map(); policy = localMissionDeliveryPolicy(); heldWorkspace = undefined; terminalActive = false;
  stopTerminals = vi.fn(async () => { terminalActive = false; });
  capabilities = vi.fn(async (_preset, scope): Promise<MissionPresetCapabilities> => {
    const { readiness } = await sessions.prepareManaged(scope.sessionId, scope.generation);
    expect(sessions.get(scope.sessionId)?.cwd).toBe(scope.cwd);
    return { source: 'runtime', runtime: { available: true, authenticated: true }, connectionAvailable: true, modelAvailable: true, projectAllowed: true, harnessCapabilities: { interrupt: true }, controlProtocol: readiness.ready, worktreeCwd: true, completionObservation: true, cancellationObservation: true, missionTools: readiness.ready, delegationControl: true, tools: [...readiness.tools] };
  });
  resolveDelivery = vi.fn(async () => structuredClone(policy));
  sessionStore = new SessionStore(data); await sessionStore.load(); sessions = makeSessions(sessionStore);
  store = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord, validateObservation: assertMissionUsageObservation }); await store.load();
  vi.mocked(createAdapter).mockReset().mockImplementation((_harness, ctx) => {
    const runtime = scripted(ctx); runtimes.set(ctx.sessionId, runtime); return runtime.adapter;
  });
  service = makeService();
});
afterEach(async () => {
  terminalActive = false; stopTerminals.mockImplementation(async () => undefined);
  await service.close(); await sessions.stopAll(); await sessions.flushPendingPersists();
  vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('Mission command attachments through the registered host', () => {
  const image = { mimeType: 'image/png', data: 'ZXhhY3QgcGl4ZWxz', name: 'current.png' };
  const registry = () => createHandlerRegistry({ missions: service, sessions, settings: { get: () => settings }, runtime: {}, desktop: { userDataPath: () => data }, log: vi.fn(), push: vi.fn() } as unknown as HandlerDeps);

  it('retains large command images in immutable source, not journal metadata, and preserves exact launch identity across retry/restart', async () => {
    await service.close();
    store = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord, validateObservation: assertMissionUsageObservation, maxBlobBytes: 64 * 1024 * 1024 });
    await store.load(); service = makeService();
    const source = await sessions.create({ title: 'Source discussion', config: { harness: 'native', projectRoot: project, permissionMode: 'ask' } });
    const prior = { id: 'prior-image', kind: 'user' as const, ts: 1, text: 'Original source instruction', images: [{ ...image, name: 'previous.png' }] };
    await sessionStore.appendTranscript(source.id, prior);
    const before = structuredClone(sessions.get(source.id));
    // Valid command payload above the journal's 16 MiB bound, below source's 64 MiB bound.
    const attached = { ...image, data: 'A'.repeat(18 * 1024 * 1024) };
    const input = { sessionId: source.id, text: '  /mission plan Implement this visual design  ', images: [attached, { ...image, name: 'second.png' }], idempotencyKey: 'large-image-command' };
    const host = registry();
    const replies = await Promise.all([host.invoke('missions:command', input), host.invoke('missions:command', input)]) as MissionCommandResponse[];
    const r = replies[0].mission!;
    expect(replies.map((reply) => reply.mission?.id)).toEqual([r.id, r.id]); expect(service.list()).toHaveLength(1);
    await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
    expect(service.get(r.id)?.executionAuthorization).toBeUndefined();
    const bytes = await store.readSource(r.id, r.sourceSnapshotId!);
    const retained = JSON.parse(bytes.toString()) as MissionSource;
    expect(retained).toMatchObject({ originSessionId: source.id, cutoffId: prior.id, submittedCommand: input.text, items: [prior], images: input.images });
    expect(r.sourceCutoffId).toBe(prior.id);
    expect(await sessions.transcript(source.id)).toEqual([prior, expect.objectContaining({ kind: 'info', text: expect.stringContaining('Mission created:') })]);
    expect(sessions.get(source.id)?.config).toEqual(before?.config); expect(sessions.get(source.id)?.usage).toEqual(before?.usage); expect(sessions.get(source.id)?.cwd).toBe(before?.cwd);
    expect(await fs.readFile(path.join(project, 'feature.txt'), 'utf8')).toBe('original\n'); expect(git(project, 'status', '--porcelain')).toBe('');
    const journal = await fs.readFile(path.join(data, 'missions', r.id, 'journal.jsonl'), 'utf8');
    expect(journal.includes(attached.data)).toBe(false); expect(journal.includes(image.data)).toBe(false);
    expect(journal.split('\n').filter((line) => line.includes('"kind":"mission.create"'))).toHaveLength(1);
    const sourceFiles = await fs.readdir(path.join(data, 'missions', r.id, 'source'));
    await sessions.note(source.id, 'Later source context must not move the cutoff');
    expect((await host.invoke('missions:command', input) as MissionCommandResponse).mission?.sourceSnapshotId).toBe(r.sourceSnapshotId);
    expect(await fs.readdir(path.join(data, 'missions', r.id, 'source'))).toEqual(sourceFiles);
    await crashRestart();
    // Read this production-sized source with the same explicit runtime bound after restart.
    const recovered = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord, maxBlobBytes: 64 * 1024 * 1024 }); await recovered.load();
    expect((await registry().invoke('missions:command', input) as MissionCommandResponse).mission?.sourceSnapshotId).toBe(r.sourceSnapshotId);
    expect((await recovered.readSource(r.id, r.sourceSnapshotId!)).equals(bytes)).toBe(true);
    for (const changed of [
      { ...input, images: [] }, { ...input, images: [...input.images].reverse() },
      { ...input, images: [{ ...attached, data: 'Y2hhbmdlZA==' }, input.images[1]] },
      { ...input, images: [{ ...attached, name: 'changed.png' }, input.images[1]] },
      { ...input, text: '/mission plan Different objective' },
    ]) await expect(registry().invoke('missions:command', changed)).rejects.toThrow(/idempotency/i);
    expect(service.list()).toHaveLength(1); expect(sessions.list().filter((meta) => meta.mission?.role === 'lead')).toHaveLength(1);
    expect((await recovered.readSource(r.id, r.sourceSnapshotId!)).equals(bytes)).toBe(true);
  }, 60_000);

  it('retains image steering from the exact command once after a lost acknowledgment, without granting approval', async () => {
    const r = await start({ mode: 'interactive_plan' }); await plan(r);
    const lead = runtimes.get(r.leadSessionId)!;
    lead.assistant('ready-plan', 'Ready plan. Proceed with execution?');
    await tool(r, 'mission_execution_propose', { proposal: { id: 'visual-proposal', specificationRevision: 1, planRevision: 1 } });
    lead.finish(); await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    const host = registry(), input = { sessionId: r.leadSessionId, text: '/mission yes', images: [image], idempotencyKey: 'command-clarification' };
    const send = service.sendUser.bind(service);
    const lost = vi.spyOn(service, 'sendUser').mockImplementationOnce(async (...args) => { await send(...args); throw new Error('Lost reply after retained command'); });
    await expect(host.invoke('missions:command', input)).rejects.toThrow(/Lost reply/); lost.mockRestore();
    await wait(() => expect(lead.adapter.send).toHaveBeenCalledTimes(2));
    const mail = service.get(r.id)!.mailbox.filter((item) => item.userAction);
    expect(mail).toHaveLength(1); expect(mail[0]).toMatchObject({ text: input.text, userAction: { kind: 'instruction' }, attachments: [{ mimeType: image.mimeType, name: image.name, ref: expect.any(String) }] });
    expect(service.get(r.id)?.pendingProposal).toBeUndefined(); expect(service.get(r.id)?.executionAuthorization).toBeUndefined();
    expect(sessions.get(r.leadSessionId)?.config.permissionMode).toBe('plan'); expect(lead.adapter.send.mock.calls[1][0].images).toEqual([image]);
    const artifact = await store.readArtifact(r.id, mail[0].attachments![0].ref);
    await host.invoke('missions:command', input);
    expect(service.get(r.id)!.mailbox.filter((item) => item.userAction)).toEqual(mail);
    expect((await store.readArtifact(r.id, mail[0].attachments![0].ref)).equals(artifact)).toBe(true); expect(lead.adapter.send).toHaveBeenCalledTimes(2);
    await expect(host.invoke('missions:command', { ...input, images: [{ ...image, data: 'Y2hhbmdlZA==' }] })).rejects.toThrow(/idempotency/i);
    expect(service.get(r.id)?.executionAuthorization).toBeUndefined();
  });

  it('treats a genuine yes with new images as context requiring clarification rather than execution approval', async () => {
    const r = await start({ mode: 'interactive_plan' }); await plan(r);
    const lead = runtimes.get(r.leadSessionId)!;
    lead.assistant('proposal-image', 'Current plan. Proceed with execution?');
    await tool(r, 'mission_execution_propose', { proposal: { id: 'new-images', specificationRevision: 1, planRevision: 1 } });
    lead.finish(); await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    const host = registry(), input = { id: r.leadSessionId, input: { text: 'yes', images: [image] }, idempotencyKey: 'yes-with-image' };
    await host.invoke('sessions:send', input);
    await wait(() => expect(lead.adapter.send).toHaveBeenCalledTimes(2));
    expect(service.get(r.id)).toMatchObject({ phase: 'planning', status: 'running', specificationRevision: 1, planRevision: 1 });
    expect(service.get(r.id)?.pendingProposal).toBeUndefined(); expect(service.get(r.id)?.executionAuthorization).toBeUndefined();
    expect(lead.adapter.send.mock.calls[1][0].images).toEqual([image]); expect(sessions.get(r.leadSessionId)?.config.permissionMode).toBe('plan');
    await host.invoke('sessions:send', input);
    expect(service.get(r.id)!.mailbox.filter((item) => item.userAction)).toHaveLength(1);
    expect(lead.adapter.send).toHaveBeenCalledTimes(2);
    expect(git(project, 'status', '--porcelain')).toBe('');
  });
});

describe('Mission coordinator', () => {
  it('does not equate send acceptance, idle, prose, or a goal token with success', async () => {
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    lead.assistant('answer', 'GOAL_COMPLETE — everything is done'); lead.ctx.emit({ type: 'status', status: 'idle' });
    expect(service.get(r.id)).toMatchObject({ status: 'running', phase: 'planning', candidates: [] });
    expect(service.get(r.id)?.delivery).toBeUndefined();
    expect(scheduler.snapshot().active).toHaveLength(1);
    expect(sessions.activity(r.leadSessionId).quiescent).toBe(false);
    expect(lead.ctx.effort()).toBeUndefined();
    expect(sessions.get(r.leadSessionId)?.config.permissionMode).toBe('plan');
    expect(await fs.readFile(path.join(project, 'feature.txt'), 'utf8')).toBe('original\n');
  });

  it.each(['tokens', 'cost'] as const)('enforces a whole-Mission %s threshold across lead and repeated worker attempts without double counting', async (cap) => {
    if (cap === 'tokens') config.limits.maxTokens = 500;
    else config.limits.maxBudgetUsd = 6;
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    lead.usage({ inputTokens: 70, outputTokens: 30, reasoningTokens: 25, costUsd: 1 });
    await plan(r);
    const first = await delegate(r);
    const worker = runtimes.get(first.sessionId)!;
    worker.usage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 15, costUsd: 2 });
    worker.usage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 15, costUsd: 2 });
    await report(r, first.attemptId, { status: 'failed' }); worker.finish();
    await wait(() => expect(service.get(r.id)?.attempts[0].status).toBe('terminal'));
    const second = await delegate(r);
    expect(second.sessionId).not.toBe(first.sessionId);
    const retry = runtimes.get(second.sessionId)!;
    retry.usage({ inputTokens: 200, outputTokens: 49, reasoningTokens: 40, costUsd: 2.99 });
    retry.usage({ inputTokens: 200, outputTokens: 49, reasoningTokens: 40, costUsd: 2.99 });
    expect(service.get(r.id)?.status).toBe('running');
    expect(service.view(r.id)?.usage.costUsd).toBeCloseTo(5.99);
    expect(sessions.list().filter((s) => s.mission?.missionId === r.id).every((s) => s.config.maxBudgetUsd === undefined)).toBe(true);
    retry.usage({ inputTokens: 200, outputTokens: 50, reasoningTokens: 40, costUsd: 3 });
    await wait(() => expect(service.get(r.id)?.status).toBe('paused'));
    expect(scheduler.snapshot().active).toEqual([]); expect(scheduler.snapshot().queued).toEqual([]);
    expect(service.get(r.id)?.blockers.filter((b) => b.id.startsWith('budget_'))).toEqual([expect.objectContaining({ message: expect.stringContaining(cap === 'tokens' ? 'token threshold reached (500 / 500)' : 'USD threshold reached (6 / 6)') })]);
    expect(lead.adapter.send).toHaveBeenCalledTimes(1); expect(worker.adapter.send).toHaveBeenCalledTimes(1); expect(retry.adapter.send).toHaveBeenCalledTimes(1);
    await crashRestart(() => undefined, true);
    expect(sessions.list().filter((entry) => entry.mission).every((entry) => entry.usage.inputTokens === 0 && entry.usage.costUsd === 0)).toBe(true);
    expect(service.get(r.id)?.status).toBe('paused');
    await expect(service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'budget-resume', control: { action: 'resume' } })).rejects.toThrow(/threshold reached/);
    expect(scheduler.snapshot().active).toEqual([]);
  }, 30_000);

  it('retains aggregate usage below the threshold across a store restart and counts a resumed lead only once', async () => {
    config.limits.maxTokens = 300;
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    lead.usage({ inputTokens: 20, outputTokens: 80, reasoningTokens: 80, costUsd: 1 });
    await plan(r); const first = await delegate(r);
    const worker = runtimes.get(first.sessionId)!;
    worker.usage({ inputTokens: 100, costUsd: 1 });
    await report(r, first.attemptId, { status: 'failed' }); worker.finish();
    await wait(() => expect(service.get(r.id)?.attempts[0].status).toBe('terminal'));
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'pause-under-budget', control: { action: 'pause' } });
    await crashRestart();
    expect(service.get(r.id)?.status).toBe('paused'); expect(scheduler.snapshot().active).toEqual([]);
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'resume-under-budget', control: { action: 'resume' } });
    await wait(() => expect(runtimes.get(r.leadSessionId)).not.toBe(lead));
    const resumed = runtimes.get(r.leadSessionId)!;
    await wait(() => expect(resumed.adapter.send).toHaveBeenCalledTimes(1));
    resumed.usage({ inputTokens: 100, outputTokens: 99, reasoningTokens: 90, costUsd: 2 });
    expect(service.get(r.id)?.status).toBe('running');
    resumed.usage({ inputTokens: 100, outputTokens: 100, reasoningTokens: 90, costUsd: 2 });
    await wait(() => expect(service.get(r.id)?.status).toBe('paused'));
    expect(service.get(r.id)?.blockers.filter((b) => b.id.startsWith('budget_'))).toEqual([expect.objectContaining({ message: expect.stringContaining('300 / 300') })]);
    expect(resumed.adapter.send).toHaveBeenCalledTimes(1);
  }, 30_000);

  it.each(['tokens', 'cost'] as const)('pauses on unknown %s after work without treating missing telemetry as zero or killing a healthy long turn', async (cap) => {
    if (cap === 'tokens') config.limits.maxTokens = 1000;
    else config.limits.maxBudgetUsd = 10;
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    lead.tool('running');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_400_000);
    lead.ctx.emit({ type: 'status', status: 'running' });
    expect(service.get(r.id)?.status).toBe('running'); expect(lead.adapter.interrupt).not.toHaveBeenCalled();
    clock.mockRestore(); lead.tool('done');
    if (cap === 'cost') lead.usage({ inputTokens: 100, costUsd: 0 });
    lead.finish();
    await wait(() => expect(service.get(r.id)?.status).toBe('paused'));
    expect(service.get(r.id)?.blockers.filter((b) => b.id.startsWith('budget_'))).toEqual([expect.objectContaining({ message: expect.stringContaining(cap === 'cost' ? 'cost is unknown' : 'token usage is unknown') })]);
    expect(lead.adapter.send).toHaveBeenCalledTimes(1);
    await crashRestart();
    await expect(service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'unknown-resume', control: { action: 'resume' } })).rejects.toThrow(/unknown/);
    // Removing a cap is explicit user configuration, not an automatic account/model substitution.
    delete config.limits.maxTokens; delete config.limits.maxBudgetUsd; config.revision++;
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'clear-cap', control: { action: 'apply_configuration' } });
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'explicit-resume', control: { action: 'resume' } });
    await wait(() => expect(runtimes.get(r.leadSessionId)).not.toBe(lead));
    await wait(() => expect(runtimes.get(r.leadSessionId)!.adapter.send).toHaveBeenCalledTimes(1));
    expect(service.get(r.id)?.leadPreset).toEqual(r.leadPreset);
  }, 30_000);

  it('retains a settled worker candidate but pauses when only the lead has known cost telemetry', async () => {
    config.limits.maxBudgetUsd = 10;
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    lead.usage({ inputTokens: 100, costUsd: 1 });
    await plan(r); const first = await delegate(r);
    const worker = runtimes.get(first.sessionId)!;
    worker.usage({ inputTokens: 100 });
    await report(r, first.attemptId); worker.finish();
    await wait(() => expect(service.get(r.id)?.status).toBe('paused'));
    expect(service.get(r.id)?.candidates).toEqual([expect.objectContaining({ attemptId: first.attemptId })]);
    expect(service.get(r.id)?.blockers.filter((b) => b.id.startsWith('budget_'))).toEqual([expect.objectContaining({ message: expect.stringContaining('cost is unknown') })]);
    expect(lead.adapter.send).toHaveBeenCalledTimes(1); expect(worker.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('fences a queued worker before its capability probe can dispatch after aggregate usage reaches the threshold', async () => {
    config.limits.maxTokens = 100;
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    await plan(r);
    const checked = deferred<void>(), release = deferred<void>();
    const probe = capabilities.getMockImplementation()!;
    capabilities.mockImplementation(async (preset, scope) => {
      const result = await probe(preset, scope);
      if (scope.role === 'worker') { checked.resolve(); await release.promise; }
      return result;
    });
    const attempt = await tool(r, 'mission_task_delegate', { taskId: 't1', presetId: 'standard', reason: 'Wait at exact dispatch preflight' }) as { sessionId: string };
    await checked.promise;
    lead.usage({ inputTokens: 100, costUsd: 1 });
    release.resolve();
    await wait(() => expect(service.get(r.id)?.status).toBe('paused'));
    expect(runtimes.get(attempt.sessionId)?.adapter.send).not.toHaveBeenCalled();
    expect(service.get(r.id)?.leadPreset).toEqual(r.leadPreset);
    expect(scheduler.snapshot().active).toEqual([]);
  });

  it('fails budget admission closed after a usage checkpoint write fails and still refuses unknown work after restart', async () => {
    config.limits.maxTokens = 1000;
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    const transact = store.transact.bind(store);
    const checkpoint = vi.spyOn(store, 'transact').mockImplementation((id, metadata, update) => {
      if (metadata.kind.startsWith('budget-usage_')) return Promise.reject(new Error('injected budget checkpoint failure'));
      return transact(id, metadata, update);
    });
    lead.usage({ inputTokens: 10, costUsd: 1 });
    await wait(() => expect(service.get(r.id)?.status).toBe('paused'));
    expect(service.get(r.id)?.blockers.filter((b) => b.id.startsWith('budget_'))).toEqual([expect.objectContaining({ message: expect.stringContaining('usage checkpoint failed') })]);
    expect(lead.adapter.send).toHaveBeenCalledTimes(1);
    checkpoint.mockRestore();
    await crashRestart();
    await expect(service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'failed-checkpoint-resume', control: { action: 'resume' } })).rejects.toThrow(/unknown/);
    expect(scheduler.snapshot().active).toEqual([]);
  });

  it('does not reuse an earlier positive cost report as proof of billing for a later lead turn', async () => {
    config.limits.maxBudgetUsd = 10;
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    lead.usage({ inputTokens: 100, costUsd: 1 }); lead.finish();
    await wait(() => expect(lead.adapter.send).toHaveBeenCalledTimes(2));
    lead.usage({ inputTokens: 200, costUsd: 1 }); lead.finish();
    await wait(() => expect(service.get(r.id)?.status).toBe('paused'));
    expect(service.get(r.id)?.blockers.filter((b) => b.id.startsWith('budget_'))).toEqual([expect.objectContaining({ message: expect.stringContaining('cost is unknown') })]);
    expect(lead.adapter.send).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent and later launch retries and preserves the exact source cutoff', async () => {
    const source = await sessions.create({ title: 'Original discussion', config: { harness: 'native', projectRoot: project, permissionMode: 'ask' } });
    await sessionStore.appendTranscript(source.id, { id: 'original-message', kind: 'user', ts: 1, text: 'Important requirement '.repeat(2_000) });
    const sourceBefore = structuredClone(sessions.get(source.id));
    const req = request({ originSessionId: source.id, submittedCommand: '/mission Implement a bounded feature' });
    const [one, two] = await Promise.all([service.create(req), service.create(req)]);
    expect(one.id).toBe(two.id); expect(service.list()).toHaveLength(1);
    const snapshot = JSON.parse((await store.readSource(one.id, one.sourceSnapshotId!)).toString());
    expect(snapshot.items).toHaveLength(1); expect(snapshot.items[0].text.length).toBeGreaterThan(24_000); expect(snapshot.cutoffId).toBe('original-message');
    expect(sessions.get(source.id)?.config).toEqual(sourceBefore?.config); expect(sessions.get(source.id)?.cwd).toBe(project);
    await sessions.note(source.id, 'Later discussion is not in the launch cutoff');
    await service.create(req);
    expect(service.get(one.id)?.sourceSnapshotId).toBe(one.sourceSnapshotId);
    expect(sessions.list().filter((s) => s.mission?.role === 'lead')).toHaveLength(1);
    await expect(service.create({ ...req, objective: 'different request' })).rejects.toThrow(/idempotency/i);
  });

  it('answers an explicit execution-time authorization question once through sendUser without changing grants', async () => {
    const r = await start(); await plan(r);
    await tool(r, 'mission_phase_set', { phase: 'executing' });
    const before = service.get(r.id)!;
    await expect(tool(r, 'mission_question_ask', { question: { id: 'routine', text: 'Which implementation style?' } })).rejects.toThrow(/clarification/);
    await tool(r, 'mission_question_ask', { question: { id: 'dependency', text: 'Project policy requires human approval for this runtime dependency. Approve this dependency?', purpose: 'authorization' } });
    expect(service.get(r.id)).toMatchObject({ phase: 'executing', status: 'waiting_for_user' });
    runtimes.get(r.leadSessionId)!.finish(); await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    await Promise.all([service.sendUser(r.leadSessionId, { text: 'Yes, this dependency only.' }, 'dependency-answer'), service.sendUser(r.leadSessionId, { text: 'Yes, this dependency only.' }, 'dependency-answer')]);
    await wait(() => expect(runtimes.get(r.leadSessionId)!.adapter.send).toHaveBeenCalledTimes(2));
    const answered = service.get(r.id)!;
    expect(answered.questions).toHaveLength(1); expect(answered.questions[0]).toMatchObject({ id: 'dependency', purpose: 'authorization', answer: 'Yes, this dependency only.', sourceUserActionId: expect.stringMatching(/^user_[0-9a-f]{32}$/) });
    expect(answered.mailbox.filter((entry) => entry.id === answered.questions[0].sourceUserActionId)).toHaveLength(1);
    for (const field of ['executionAuthorization', 'requestedPermissionMode', 'leadPreset', 'config', 'providerRestrictions', 'deliveryPolicy'] as const) expect(answered[field]).toEqual(before[field]);
    expect(sessions.get(r.leadSessionId)?.goal).toBeUndefined();
    const persisted = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord, validateObservation: assertMissionUsageObservation }); await persisted.load();
    expect(persisted.get(r.id)?.questions).toEqual(answered.questions);
  });

  it('retains an already-running worker candidate while a genuine blocker question waits for user input', async () => {
    const r = await start(); await plan(r); const worker = await delegate(r);
    await tool(r, 'mission_question_ask', { question: { id: 'blocker', text: 'Which unavailable credential can the host use?', purpose: 'blocker' } });
    await report(r, worker.attemptId); runtimes.get(worker.sessionId)!.finish();
    await wait(() => expect(service.get(r.id)?.candidates).toHaveLength(1));
    expect(service.get(r.id)).toMatchObject({ status: 'waiting_for_user', blockers: [] });
    expect(runtimes.get(worker.sessionId)!.adapter.send).toHaveBeenCalledTimes(1);
    runtimes.get(r.leadSessionId)!.finish(); await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    expect(service.get(r.id)?.status).toBe('waiting_for_user');
    expect(runtimes.get(r.leadSessionId)!.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('retains source images after source-session deletion and exposes descriptors and image bytes only to assigned participants', async () => {
    const source = await sessions.create({ title: 'Source with attachments', config: { harness: 'native', projectRoot: project, permissionMode: 'ask' } });
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVSUAAAAASUVORK5CYII=';
    const first = { mimeType: 'image/png', data, name: 'original.png' }, second = { mimeType: 'image/png', data, name: 'launch.png' };
    await sessionStore.appendTranscript(source.id, { id: 'image-message', kind: 'user', ts: 1, text: 'Implement this visual behavior', images: [first] });
    const r = await start({ originSessionId: source.id, images: [second] }); const ref = r.sourceSnapshotId!;
    await sessions.delete(source.id); expect(sessions.get(source.id)).toBeUndefined(); expect(await sessionStore.readTranscript(source.id)).toEqual([]);
    const read = (payload: Record<string, unknown>, sessionId = r.leadSessionId) => service.toolHost.invoke(binding(service.get(r.id)!, sessionId), 'mission_context_read', { payload: { ref, ...payload } });
    const descriptors = await read({ listImages: true });
    expect(descriptors).toEqual({ kind: 'source_images', ref, images: [{ imageIndex: 0, mimeType: 'image/png', name: 'original.png' }, { imageIndex: 1, mimeType: 'image/png', name: 'launch.png' }] });
    expect(JSON.stringify(descriptors)).not.toContain(data);
    expect(await read({ imageIndex: 0 })).toEqual({ kind: 'source_image', image: first });
    expect(await read({ imageIndex: 1 })).toEqual({ kind: 'source_image', image: second });
    await service.broker.start();
    const capability = service.broker.attach(binding(r));
    const response = await fetch(capability.def.url!, { method: 'POST', headers: { 'Content-Type': 'application/json', ...capability.def.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mission_context_read', arguments: { payload: { ref, imageIndex: 1 } } } }) });
    const rpc = await response.json();
    expect(rpc.error).toBeUndefined(); expect(rpc.result.isError).toBe(false);
    expect(rpc.result.content).toHaveLength(2);
    expect(rpc.result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data });
    expect(rpc.result.content[0].text).not.toContain(data);
    for (const selectors of [{ imageIndex: -1 }, { imageIndex: 0.5 }, { imageIndex: 0, listImages: true }, { imageIndex: 0, offset: 0 }, { listImages: true, limit: 10 }, { listImages: false }]) await expect(read(selectors)).rejects.toThrow();
    await expect(read({ imageIndex: 2 })).rejects.toThrow(/image.*index|index.*image/i);
    await plan(r); const worker = await delegate(r);
    const sourceRead = vi.spyOn(store, 'readSource'); sourceRead.mockClear();
    for (const selectors of [{ imageIndex: 0 }, { listImages: true }, {}]) await expect(read(selectors, worker.sessionId)).rejects.toThrow(/assigned/);
    expect(sourceRead).not.toHaveBeenCalled();
    const authorized = { ...profile(), id: 'visual-reviewer', contextRefs: [ref] };
    await tool(r, 'mission_profile_upsert', { profile: authorized });
    await tool(r, 'mission_plan_update', { expectedPlanRevision: service.get(r.id)!.planRevision, plan: service.get(r.id)!.plan, tasks: [task('visual', { assignment: { kind: 'worker', profileId: authorized.id, profileRevision: 1 } })] });
    const visual = await delegate(r, 'visual');
    expect(await read({ imageIndex: 1 }, visual.sessionId)).toEqual({ kind: 'source_image', image: second });
    expect(await read({ listImages: true }, visual.sessionId)).toEqual(descriptors);
    await report(r, worker.attemptId); runtimes.get(worker.sessionId)!.finish(); await wait(() => expect(service.get(r.id)?.candidates).toHaveLength(1));
    const candidateRead = vi.spyOn(workspaces, 'candidate'); candidateRead.mockClear();
    await expect(read({ ref: service.get(r.id)!.candidates[0].id, imageIndex: 0 })).rejects.toThrow(/retained source/);
    expect(candidateRead).not.toHaveBeenCalled();
  });

  it('requires a current proposal and real user affirmative; planning and execution keep the same lead', async () => {
    const r = await start({ mode: 'interactive_plan' });
    const originalHead = git(project, 'rev-parse', 'HEAD');
    await plan(r);
    await tool(r, 'mission_question_ask', { question: { id: 'question', text: 'Preserve the existing names?' } });
    runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'answer-design', control: { action: 'steer', text: 'yes' } });
    expect(service.get(r.id)?.executionAuthorization).toBeUndefined();
    await wait(() => expect(runtimes.get(r.leadSessionId)!.adapter.send).toHaveBeenCalledTimes(2));
    const lead = runtimes.get(r.leadSessionId)!;
    const current = service.get(r.id)!;
    const proposal = { id: 'proposal', specificationRevision: current.specificationRevision, planRevision: current.planRevision };
    await expect(tool(r, 'mission_execution_propose', { proposal })).rejects.toThrow(/actual current assistant/);
    lead.assistant('approval-message', 'The consolidated plan is ready. Proceed with execution?');
    await expect(tool(r, 'mission_execution_propose', { proposal: { ...proposal, assistantMessageId: 'invented-message' } })).rejects.toThrow(/actual current assistant/);
    await expect(tool(r, 'mission_execution_propose', { proposal: { ...proposal, requestedAt: 'invented-time' } })).rejects.toThrow();
    const beforeProposal = Date.now();
    await tool(r, 'mission_execution_propose', { proposal });
    const recorded = service.get(r.id)!.pendingProposal!;
    expect(recorded.assistantMessageId).toBe((await sessions.transcript(r.leadSessionId)).findLast((item) => item.kind === 'assistant')!.id);
    expect(recorded.requestedAt).toBeGreaterThanOrEqual(beforeProposal);
    lead.finish(); await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    await expect(service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'wrong-revision', control: { action: 'execute', proposalId: 'proposal', specificationRevision: 99 } })).rejects.toThrow(/proposal/i);
    await expect(service.toolHost.invoke(binding(r), 'mission_execution_propose', { expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'spoof', payload: { authorization: true } })).rejects.toThrow(/authority/);
    const approved = await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'user-proceed', control: { action: 'steer', text: 'yes, proceed' } });
    expect(approved).toMatchObject({ phase: 'executing', executionAuthorization: { kind: 'approved_plan', specificationRevision: current.specificationRevision }, leadSessionId: r.leadSessionId });
    expect(approved.executionAuthorization?.sourceUserActionId).not.toBe('user-proceed');
    expect(git(project, 'status', '--porcelain')).toBe(''); expect(git(project, 'rev-parse', 'HEAD')).toBe(originalHead);
  });

  it('keeps dirty source intact and records an actionable baseline blocker instead of using HEAD', async () => {
    await fs.writeFile(path.join(project, 'feature.txt'), 'user edits\n');
    const r = await start({ mode: 'interactive_plan' });
    expect(r.baseline).toBeUndefined(); expect(r.blockers.some((b) => /clean|commit/i.test(b.message))).toBe(true);
    expect(sessions.get(r.leadSessionId)?.config.permissionMode).toBe('plan');
    expect(await fs.readFile(path.join(project, 'feature.txt'), 'utf8')).toBe('user edits\n');
    expect(git(project, 'status', '--porcelain')).toContain('feature.txt');
  });

  it('routes workers through assigned scoped tools and refuses direct user/lead operations', async () => {
    const r = await start(); await plan(r); const worker = await delegate(r);
    await expect(sessions.send(worker.sessionId, { text: 'user bypass' })).rejects.toThrow(/Mission/);
    await expect(tool(r, 'mission_task_delegate', { taskId: 't1', presetId: 'standard', reason: 'grandchild' }, worker.sessionId)).rejects.toThrow(/principal|depth/);
    await expect(tool(r, 'mission_plan_update', { expectedPlanRevision: 1, plan: service.get(r.id)!.plan }, worker.sessionId)).rejects.toThrow(/principal/i);
    const read = await service.toolHost.invoke(binding(r, worker.sessionId), 'mission_read', { payload: {} }) as Record<string, unknown>;
    expect(read).toHaveProperty('task'); expect(read).not.toHaveProperty('sourceSnapshotId'); expect(read).not.toHaveProperty('profiles');
    await expect(service.toolHost.invoke(binding(r, worker.sessionId), 'mission_context_read', { payload: { ref: r.sourceSnapshotId } })).rejects.toThrow(/assigned/);
    expect(sessions.get(worker.sessionId)?.mission).toMatchObject({ sourceAccess: 'read_only', reasoningDefault: true });
    expect(sessions.get(worker.sessionId)?.config.model).toEqual(config.presets[1].model);
  });

  it('holds capacity and candidate capture until a real terminal turn AND running tools settle; duplicates do not recapture', async () => {
    const r = await start(); await plan(r); const worker = await delegate(r); const runtime = runtimes.get(worker.sessionId)!;
    await report(r, worker.attemptId); runtime.tool('running'); runtime.finish('one-terminal');
    expect(service.get(r.id)?.candidates).toHaveLength(0); expect(scheduler.snapshot().active).toHaveLength(2);
    runtime.tool('done');
    await wait(() => expect(service.get(r.id)?.candidates).toHaveLength(1));
    runtime.finish('one-terminal'); runtime.tool('done');
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.get(r.id)?.candidates).toHaveLength(1); expect(service.get(r.id)?.attempts[0].outcome).toBe('submitted');
    expect(service.get(r.id)?.tasks[0].status).toBe('candidate_ready'); expect(service.get(r.id)?.status).not.toBe('completed');
  });

  it('admits independent tasks in parallel, bounds workers, and refuses unsatisfied code dependencies', async () => {
    const r = await start(); await plan(r, [task('one'), task('two'), task('three'), task('dependent', { dependsOn: [{ taskId: 'one', condition: 'integrated_code' }] })]);
    const one = await delegate(r, 'one'); const two = await delegate(r, 'two');
    const third = await tool(r, 'mission_task_delegate', { taskId: 'three', presetId: 'standard', reason: 'Independent third task' }) as { sessionId: string };
    await wait(() => expect(scheduler.snapshot().queued).toHaveLength(1));
    expect(runtimes.has(third.sessionId)).toBe(false); expect(scheduler.snapshot().active).toHaveLength(3);
    await expect(tool(r, 'mission_task_delegate', { taskId: 'dependent', presetId: 'standard', reason: 'Must wait' })).rejects.toThrow(/dependencies/);
    await report(r, one.attemptId); runtimes.get(one.sessionId)!.finish();
    await wait(() => expect(runtimes.get(third.sessionId)?.adapter.send).toHaveBeenCalledTimes(1));
    expect(service.get(r.id)?.attempts.filter((a) => a.status !== 'terminal')).toHaveLength(2);
    expect(runtimes.get(two.sessionId)!.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('allows only one result-format repair and never accepts natural-language worker completion', async () => {
    const r = await start(); await plan(r); const worker = await delegate(r); const runtime = runtimes.get(worker.sessionId)!;
    runtime.assistant('prose', 'All done, tests pass!'); runtime.finish('first');
    await wait(() => expect(runtime.adapter.send).toHaveBeenCalledTimes(2));
    runtime.finish('first'); // Repeated terminal of the prior turn cannot settle the repair.
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.get(r.id)?.attempts[0].status).toBe('running');
    runtime.finish('repair');
    await wait(() => expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'failed', repairTurns: 1, failure: { kind: 'protocol' } }));
    expect(runtime.adapter.send).toHaveBeenCalledTimes(2); expect(service.get(r.id)?.candidates).toHaveLength(0);
  });

  it('pauses admission immediately, stops only owned runtimes, and restart never automatically dispatches', async () => {
    const unrelated = await sessions.create({ config: { harness: 'native', projectRoot: project, permissionMode: 'ask' } });
    await sessions.send(unrelated.id, { text: 'Unrelated work' });
    runtimes.get(unrelated.id)!.finish();
    const r = await start(); await plan(r); const worker = await delegate(r);
    const oldBinding = binding(r, worker.sessionId);
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'pause', control: { action: 'pause' } });
    expect(service.get(r.id)?.status).toBe('paused'); expect(scheduler.snapshot().active).toHaveLength(0);
    expect(runtimes.get(unrelated.id)!.adapter.dispose).not.toHaveBeenCalled();
    await expect(service.toolHost.invoke(oldBinding, 'mission_read', { payload: {} })).rejects.toThrow(/authorized/);
    await service.close(); await sessions.stopAll(); await sessions.flushPendingPersists();
    const priorStarts = vi.mocked(createAdapter).mock.calls.length;
    sessionStore = new SessionStore(data); await sessionStore.load(); sessions = makeSessions(sessionStore);
    store = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord, validateObservation: assertMissionUsageObservation }); service = makeService(); await service.load();
    expect(service.get(r.id)?.status).toBe('paused'); expect(vi.mocked(createAdapter)).toHaveBeenCalledTimes(priorStarts);
    expect(service.get(r.id)?.attempts[0].outcome).toBe('interrupted');
  });

  it('stop is terminal and late duplicate events cannot reopen it', async () => {
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'stop', control: { action: 'stop' } });
    expect(service.get(r.id)?.status).toBe('stopped');
    lead.finish(); lead.assistant('late', 'GOAL_COMPLETE');
    await expect(service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'resume', control: { action: 'resume' } })).rejects.toThrow(/immutable|stopped/i);
    expect(service.get(r.id)?.status).toBe('stopped'); expect(lead.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('claims real implementation in the same lead session only after the planning turn settles', async () => {
    const r = await start();
    await plan(r, [task('direct', { assignment: { kind: 'lead' }, requiredTools: ['write'] })]);
    const initial = runtimes.get(r.leadSessionId)!;
    const claim = await tool(r, 'mission_task_claim', { taskId: 'direct' }) as { attemptId: string; sessionId: string };
    expect(claim.sessionId).toBe(r.leadSessionId);
    expect(sessions.get(r.leadSessionId)?.mission?.sourceAccess).toBe('read_only');
    initial.finish('claim-boundary');
    await wait(() => expect(service.get(r.id)?.attempts.find((a) => a.id === claim.attemptId)?.status).toBe('running'));
    // The durable running transition precedes the replacement runtime's startup. The retired
    // planning runtime already has one send, so waiting on that count alone can pass early and
    // emit the implementation turn into a runtime the manager no longer observes.
    await wait(() => expect(runtimes.get(r.leadSessionId)).not.toBe(initial));
    await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
    await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
    expect(sessions.list().filter((s) => s.mission?.role === 'lead')).toHaveLength(1);
    expect(sessions.get(r.leadSessionId)?.mission).toMatchObject({ attemptId: claim.attemptId, sourceAccess: 'assigned_workspace' });
    expect(sessions.get(r.leadSessionId)?.config.permissionMode).toBe('auto');
    await fs.writeFile(path.join(sessions.get(r.leadSessionId)!.cwd, 'feature.txt'), 'implemented\n');
    await report(r, claim.attemptId); runtimes.get(r.leadSessionId)!.finish('implementation');
    await wait(() => expect(service.get(r.id)?.candidates).toHaveLength(1));
    expect(service.get(r.id)?.candidates[0].changedPaths).toEqual(['feature.txt']);
    expect(await fs.readFile(path.join(project, 'feature.txt'), 'utf8')).toBe('original\n');
  });

  it('runs actual isolated verification, integrates with CAS, and completes only with a real delivery receipt', async () => {
    policy.checks = [{ id: 'behavior', name: 'Behavior check', kind: 'behavior', command: 'node -e "require(\'node:assert\').strictEqual(require(\'node:fs\').readFileSync(\'feature.txt\',\'utf8\').trim(),\'original\')"', criterionIds: ['outcome'], required: true, heavy: true, timeoutMs: 10_000 }];
    const r = await start(); await plan(r); const worker = await delegate(r);
    await report(r, worker.attemptId); runtimes.get(worker.sessionId)!.finish();
    await wait(() => expect(service.get(r.id)?.candidates).toHaveLength(1));
    const candidate = service.get(r.id)!.candidates[0];
    await tool(r, 'mission_task_accept', { taskId: 't1', attemptId: worker.attemptId });
    const integration = await tool(r, 'mission_integration_request', { candidateId: candidate.id, expectedContentHash: r.acceptedRevision!.contentHash }) as { operationId: string };
    await tool(r, 'mission_yield', { events: ['integration'] }); runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(service.get(r.id)?.operations.find((o) => o.id === integration.operationId)?.state).toBe('succeeded'));
    expect(service.get(r.id)?.evidence).toContainEqual(expect.objectContaining({ provenance: 'host_executed', result: 'passed', exitCode: 0 }));
    expect(service.get(r.id)?.status).not.toBe('completed');
    await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
    const finish = await tool(r, 'mission_finish_request', { commitMessage: 'feat: Retain verified Mission investigation' }) as { operationId: string };
    expect(service.get(r.id)?.delivery).toBeUndefined();
    runtimes.get(r.leadSessionId)!.finish('final-lead-turn');
    await wait(() => expect(service.get(r.id)?.status).toBe('completed'));
    const completed = service.get(r.id)!;
    expect(completed.delivery).toMatchObject({ operationId: finish.operationId, status: 'delivered', endpoint: 'local_commit' });
    expect(git(project, 'rev-parse', `${completed.delivery!.commitSha}^{tree}`)).toBe(completed.acceptedRevision!.contentHash);
    expect(git(project, 'rev-parse', 'HEAD')).toBe(r.baseline!.baseCommitSha);
    expect(completed.operations.filter((o) => o.kind === 'deliver' && o.state === 'succeeded')).toHaveLength(1);
    const cleanup = vi.spyOn(workspaces, 'cleanup');
    const cleanupRequest = { missionId: r.id, expectedRevision: completed.revision, idempotencyKey: 'completed-cleanup', control: { action: 'cleanup' as const } };
    const [cleaned] = await Promise.all([service.control(cleanupRequest), service.control(cleanupRequest)]);
    expect(cleaned.status).toBe('completed');
    expect(cleaned.operations.filter((o) => o.kind === 'cleanup')).toEqual([expect.objectContaining({ state: 'succeeded' })]);
    expect(cleanup).toHaveBeenCalledTimes(completed.workspaces.length);
    expect(cleaned.workspaces.every((workspace) => workspace.cleanedAt !== undefined)).toBe(true);
    for (const field of ['candidates', 'evidence', 'reviews', 'attempts', 'delivery'] as const) expect(cleaned[field]).toEqual(completed[field]);
    expect(await workspaces.candidate(candidate.id)).toMatchObject({ id: candidate.id, revision: candidate.revision });
    const retained = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord, validateObservation: assertMissionUsageObservation }); await retained.load();
    expect(retained.get(r.id)).toEqual(cleaned);
    await service.control(cleanupRequest); expect(cleanup).toHaveBeenCalledTimes(completed.workspaces.length);
  });

  it('waits event-driven for a held workspace lease without replacing the writer or failing the turn', async () => {
    const r = await start({ mode: 'interactive_plan' });
    await tool(r, 'mission_yield', { events: ['user'] }); runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    const runtime = runtimes.get(r.leadSessionId)!;
    heldWorkspace = sessions.get(r.leadSessionId)!.cwd;
    await service.sendUser(r.leadSessionId, { text: 'Inspect the edge case next' }, 'held-user-action');
    await wait(() => expect(scheduler.snapshot().active).toHaveLength(1));
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1); expect(runtime.adapter.dispose).not.toHaveBeenCalled();
    const cwd = heldWorkspace; heldWorkspace = undefined; service.workspaceAvailable(cwd);
    await wait(() => expect(runtime.adapter.send).toHaveBeenCalledTimes(2));
    expect(service.get(r.id)?.blockers).toEqual([]);
  });

  it('checks exact pinned capabilities and live revocation before each new dispatch', async () => {
    const r = await start(); await plan(r);
    config.presets[1].enabled = false;
    await tool(r, 'mission_task_delegate', { taskId: 't1', presetId: 'standard', reason: 'Must be refused live' });
    await wait(() => expect(service.get(r.id)?.operations.some((o) => o.payload.taskId === 't1' && o.state === 'failed')).toBe(true));
    expect(sessions.list().filter((s) => s.mission?.role === 'worker')).toHaveLength(0);
    expect(service.get(r.id)?.blockers).toEqual([]);
    expect(service.get(r.id)?.status).toBe('running');
    expect(service.get(r.id)?.mailbox.some((m) => /disabled|removed/i.test(m.text))).toBe(true);
    expect(capabilities.mock.calls.length).toBeGreaterThan(0);
  });

  it('lets the lead add discovered required checks without weakening prior gates and invalidates old evidence', async () => {
    policy.checks = [{ id: 'baseline-check', name: 'Baseline behavior', kind: 'behavior', command: 'node -e "process.exit(0)"', criterionIds: ['baseline-outcome'], required: true, heavy: true, timeoutMs: 10_000 }];
    const r = await start(); await plan(r); const worker = await delegate(r);
    await report(r, worker.attemptId); runtimes.get(worker.sessionId)!.finish();
    await wait(() => expect(service.get(r.id)?.candidates).toHaveLength(1));
    const candidate = service.get(r.id)!.candidates[0];
    const verify = await tool(r, 'mission_verification_request', { checkId: 'baseline-check', candidateId: candidate.id }) as { operationId: string };
    await tool(r, 'mission_yield', { events: ['verification'] }); runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(service.get(r.id)?.operations.find((op) => op.id === verify.operationId)?.state).toBe('succeeded'));
    await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
    const before = service.get(r.id)!;
    await tool(r, 'mission_plan_update', { expectedPlanRevision: before.planRevision, plan: { ...before.plan,
      criteria: [...before.plan.criteria, { id: 'discovered-outcome', description: 'Exercise the discovered boundary', required: true, evidenceKinds: ['behavior'] }],
      assumptions: [...before.plan.assumptions, { id: 'discovered-boundary', description: 'The inspected boundary needs a regression check', rationale: 'Extra verification narrows the original objective rather than removing a requirement', source: 'Read the actual boundary implementation', affectedTaskIds: [], criterionIds: ['discovered-outcome'], status: 'assumed' }] },
      material: { source: { kind: 'assumption', assumptionId: 'discovered-boundary' }, affectedTaskIds: [] },
      checks: [{ id: 'discovered-check', name: 'Discovered boundary check', kind: 'behavior', command: 'node -e "process.exit(0)"', criterionIds: ['discovered-outcome'], required: true, heavy: true, timeoutMs: 10_000 }] });
    const changed = service.get(r.id)!;
    expect(changed.specificationRevision).toBe(before.specificationRevision + 1);
    expect(changed.deliveryPolicy.checks.map((check) => check.id)).toEqual(['baseline-check', 'discovered-check']);
    expect(changed.evidence).toHaveLength(1); expect(changed.evidence[0].invalidatedBy).toBeTruthy();
    await expect(tool(r, 'mission_plan_update', { expectedPlanRevision: changed.planRevision, plan: changed.plan,
      checks: [{ ...changed.deliveryPolicy.checks[0], required: false, command: 'node -e "process.exit(0)"' }] })).rejects.toThrow(/immutable|weaken|check|required/i);
    expect(service.get(r.id)?.deliveryPolicy.checks).toEqual(changed.deliveryPolicy.checks);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('hands over only to an approved T5 after pausing, retaining old workspaces and revoking the old generation', async () => {
    const alternative = { ...config.presets[0], id: 'alternative', name: 'Alternative principal' };
    config.presets.push(alternative); config.tiers[4].presetIds.push(alternative.id);
    const r = await start(); await plan(r); const worker = await delegate(r);
    const oldBinding = binding(r), oldCwd = sessions.get(r.leadSessionId)!.cwd;
    await expect(service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'active-handover', control: { action: 'replace_lead', presetId: alternative.id } })).rejects.toThrow(/Pause|quiescen/);
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'handover-pause', control: { action: 'pause' } });
    await expect(service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'wrong-tier', control: { action: 'replace_lead', presetId: 'standard' } })).rejects.toThrow(/T5/);
    const workerBefore = structuredClone(sessions.get(worker.sessionId));
    const changed = await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'replace-lead', control: { action: 'replace_lead', presetId: alternative.id } });
    expect(changed.status).toBe('paused'); expect(changed.blockers).toEqual([]);
    expect(changed.leadPreset.id).toBe(alternative.id); expect(changed.leadGeneration).toBe(r.leadGeneration + 1);
    expect(changed.leadSessionId).not.toBe(r.leadSessionId);
    expect(sessions.get(changed.leadSessionId)?.cwd).not.toBe(oldCwd);
    expect(runtimes.has(changed.leadSessionId)).toBe(false);
    expect(await fs.readFile(path.join(oldCwd, 'feature.txt'), 'utf8')).toBe('original\n');
    expect(sessions.get(worker.sessionId)?.config).toEqual(workerBefore?.config);
    await expect(service.toolHost.invoke(oldBinding, 'mission_read', { payload: {} })).rejects.toThrow(/authorized|Stale/);
    await service.control({ missionId: r.id, expectedRevision: changed.revision, idempotencyKey: 'handover-resume', control: { action: 'resume' } });
    await wait(() => expect(runtimes.get(changed.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
    expect(scheduler.snapshot().active.filter((a) => a.kind === 'lead')).toHaveLength(1);
  });

  it('cleans only quiescent managed workspaces and retains uncaptured files with a genuine refusal receipt', async () => {
    const r = await start();
    await expect(service.control({ missionId: r.id, expectedRevision: r.revision, idempotencyKey: 'unsafe-cleanup', control: { action: 'cleanup' } })).rejects.toThrow(/paused|quiescen/);
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'cleanup-pause', control: { action: 'pause' } });
    const cwd = sessions.get(r.leadSessionId)!.cwd;
    await fs.writeFile(path.join(cwd, 'uncaptured.txt'), 'retain me\n');
    const cleaned = await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'cleanup', control: { action: 'cleanup' } });
    const operation = cleaned.operations.find((op) => op.kind === 'cleanup')!;
    expect(operation.state).toBe('failed');
    expect(operation.payload.receipts).toContainEqual(expect.objectContaining({ removed: false, reason: 'uncaptured' }));
    expect(cleaned.workspaces.find((w) => w.ownerSessionId === r.leadSessionId)?.cleanedAt).toBeUndefined();
    expect(await fs.readFile(path.join(cwd, 'uncaptured.txt'), 'utf8')).toBe('retain me\n');
    expect(await fs.readFile(path.join(project, 'feature.txt'), 'utf8')).toBe('original\n');
    expect(cleaned.workspaces.find((w) => w.role === 'integration')?.cleanedAt).toBeTypeOf('number');
  });

  it('journals cleanup for a stopped Mission while retaining source, ownership and the terminal state', async () => {
    const r = await start();
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'stop-for-cleanup', control: { action: 'stop' } });
    const stopped = service.get(r.id)!;
    const cleaned = await service.control({ missionId: r.id, expectedRevision: stopped.revision, idempotencyKey: 'stopped-cleanup', control: { action: 'cleanup' } });
    expect(cleaned.status).toBe('stopped'); expect(cleaned.operations.find((op) => op.kind === 'cleanup')?.state).toBe('succeeded');
    expect(cleaned.workspaces.map(({ id, ownerSessionId }) => ({ id, ownerSessionId }))).toEqual(stopped.workspaces.map(({ id, ownerSessionId }) => ({ id, ownerSessionId })));
    expect(cleaned.workspaces.every((workspace) => workspace.cleanedAt !== undefined)).toBe(true);
    expect(await store.readSource(r.id, r.sourceSnapshotId!)).toEqual(await store.readSource(r.id, stopped.sourceSnapshotId!));
    expect(await fs.readFile(path.join(project, 'feature.txt'), 'utf8')).toBe('original\n');
    const retained = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord, validateObservation: assertMissionUsageObservation }); await retained.load(); expect(retained.get(r.id)).toEqual(cleaned);
  });

  it('does not release capacity or claim paused while a host-owned terminal is still closing or uncertain', async () => {
    const r = await start(); terminalActive = true;
    stopTerminals.mockImplementation(async () => undefined);
    expect(service.isQuiescent(service.get(r.id)!)).toBe(false);
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'shell-pause', control: { action: 'pause' } });
    expect(stopTerminals).toHaveBeenCalledTimes(1);
    expect(service.get(r.id)?.status).toBe('pausing'); expect(scheduler.snapshot().active).toHaveLength(1);
    expect(service.get(r.id)?.blockers.some((b) => /terminal/.test(b.message))).toBe(true);
    await expect(service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'shell-cleanup', control: { action: 'cleanup' } })).rejects.toThrow(/paused|quiescen/);
  });

  it('probes the initialized exact worker before its first model call and refuses unsupported readiness without sending', async () => {
    const r = await start(); await plan(r);
    const original = capabilities.getMockImplementation()!;
    capabilities.mockImplementation(async (preset, scope) => {
      if (scope.role === 'worker') {
        expect(scope).toMatchObject({ projectRoot: project, role: 'worker', sourceAccess: 'read_only', permissionMode: 'plan', generation: 1 });
        expect(scope.sessionId).not.toBe(r.leadSessionId);
        expect(scope.cwd).not.toBe(project);
        const runtime = runtimes.get(scope.sessionId)!;
        expect(runtime.adapter.start).toHaveBeenCalledTimes(1);
        expect(runtime.adapter.send).not.toHaveBeenCalled();
        expect(service.get(r.id)!.operations).toContainEqual(expect.objectContaining({ kind: 'dispatch', state: 'in_flight', payload: expect.objectContaining({ sessionId: scope.sessionId }) }));
        return { ...await original(preset, scope), modelAvailable: false };
      }
      return original(preset, scope);
    });
    const dispatched = await tool(r, 'mission_task_delegate', { taskId: 't1', presetId: 'standard', reason: 'Must verify this live runtime' }) as { sessionId: string; operationId: string };
    await wait(() => expect(service.get(r.id)?.operations.find((o) => o.id === dispatched.operationId)?.state).toBe('failed'));
    expect(runtimes.get(dispatched.sessionId)!.adapter.send).not.toHaveBeenCalled();
    expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'failed' });
    expect(scheduler.snapshot().active).toHaveLength(1);
  });

  it('batches new mailbox arrivals behind a single pending lead turn while a workspace lease is held', async () => {
    const r = await start({ mode: 'interactive_plan' });
    await tool(r, 'mission_yield', { events: ['user'] }); runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    const runtime = runtimes.get(r.leadSessionId)!;
    heldWorkspace = sessions.get(r.leadSessionId)!.cwd;
    await service.sendUser(r.leadSessionId, { text: 'First correction' }, 'mail-first');
    await wait(() => expect(scheduler.snapshot().active).toHaveLength(1));
    await service.sendUser(r.leadSessionId, { text: 'Second correction' }, 'mail-second');
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.get(r.id)!.operations.filter((op) => op.payload.lead && ['intent_recorded', 'in_flight'].includes(op.state))).toHaveLength(1);
    expect(scheduler.snapshot().queued).toHaveLength(0);
    const cwd = heldWorkspace; heldWorkspace = undefined; service.workspaceAvailable(cwd);
    await wait(() => expect(runtime.adapter.send).toHaveBeenCalledTimes(2));
    await tool(r, 'mission_yield', { events: ['user'] }); runtime.finish();
    await wait(() => expect(runtime.adapter.send).toHaveBeenCalledTimes(3));
    expect(runtime.adapter.send.mock.calls.filter(([input]) => input.text.includes('First correction'))).toHaveLength(1);
    expect(runtime.adapter.send.mock.calls.filter(([input]) => input.text.includes('Second correction'))).toHaveLength(1);
  });

  it('restarts from the stored dispatch boundary without replaying an unacknowledged lead send', async () => {
    const r = await start({ mode: 'interactive_plan' });
    await tool(r, 'mission_yield', { events: ['user'] }); runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    const old = runtimes.get(r.leadSessionId)!;
    const acknowledgment = deferred<void>();
    old.adapter.send.mockImplementation(async () => { old.ctx.emit({ type: 'status', status: 'running' }); await acknowledgment.promise; });
    await service.sendUser(r.leadSessionId, { text: 'Do not duplicate this instruction' }, 'uncertain-send');
    await wait(() => expect(old.adapter.send).toHaveBeenCalledTimes(2));
    const priorStarts = vi.mocked(createAdapter).mock.calls.length;
    await crashRestart(() => acknowledgment.resolve());
    expect(service.get(r.id)?.status).toBe('recovering');
    expect(vi.mocked(createAdapter)).toHaveBeenCalledTimes(priorStarts);
    const recovered = service.get(r.id)!;
    expect(recovered.mailbox.find((m) => m.text === 'Do not duplicate this instruction')?.deliveredAt).toBeTypeOf('number');
    expect(recovered.operations.filter((o) => o.payload.dispatchStartedAt !== undefined)).toHaveLength(2);
    expect(recovered.operations.filter((o) => o.state === 'reconciling')).toHaveLength(1);
    expect(recovered.blockers.some((blocker) => /External ownership is uncertain/.test(blocker.message))).toBe(true);
    expect(service.isQuiescent(recovered)).toBe(false);
    await expect(service.control({ missionId: r.id, expectedRevision: recovered.revision, idempotencyKey: 'resume-after-crash', control: { action: 'resume' } })).rejects.toThrow(/paused|reconciled/);
    expect(vi.mocked(createAdapter)).toHaveBeenCalledTimes(priorStarts);
    expect(old.adapter.send).toHaveBeenCalledTimes(2);
    expect(sessions.list().filter((s) => s.mission?.role === 'lead')).toHaveLength(1);
  });

  it('reconciles a pre-runtime workspace intent after restart without creating or dispatching the worker', async () => {
    const r = await start(); await plan(r);
    const provisioned = deferred<void>(), release = deferred<void>();
    const provision = workspaces.provision.bind(workspaces);
    vi.spyOn(workspaces, 'provision').mockImplementation(async (input) => {
      const workspace = await provision(input);
      if (input.role === 'worker') { provisioned.resolve(); await release.promise; }
      return workspace;
    });
    const worker = await tool(r, 'mission_task_delegate', { taskId: 't1', presetId: 'standard', reason: 'Preallocated crash-boundary worker' }) as { sessionId: string; operationId: string };
    await tool(r, 'mission_yield', { events: ['candidate'] }); runtimes.get(r.leadSessionId)!.finish();
    await provisioned.promise;
    await wait(() => expect(service.get(r.id)!.operations.filter((o) => o.payload.lead && o.state === 'succeeded')).toHaveLength(1));
    expect(sessions.get(worker.sessionId)).toBeUndefined();
    const intent = service.get(r.id)!.operations.find((op) => op.id === worker.operationId)!;
    expect(intent.payload.dispatchStage).toBe('preparing');
    const starts = vi.mocked(createAdapter).mock.calls.length;
    await crashRestart(() => release.resolve());
    const restored = service.get(r.id)!;
    expect(restored.status).toBe('paused'); expect(restored.blockers).toEqual([]);
    expect(restored.operations.find((op) => op.id === worker.operationId)?.state).toBe('failed');
    expect(restored.workspaces).toContainEqual(expect.objectContaining({ id: intent.payload.workspaceId, ownerSessionId: worker.sessionId, role: 'worker' }));
    expect(restored.attempts).toHaveLength(0); expect(sessions.get(worker.sessionId)).toBeUndefined();
    expect(vi.mocked(createAdapter)).toHaveBeenCalledTimes(starts);
  });

  it('imports a retained candidate receipt after a failed index write without recapturing later workspace edits', async () => {
    const r = await start(); await plan(r); const worker = await delegate(r);
    const persist = store.transact.bind(store);
    let failed = false;
    const fault = vi.spyOn(store, 'transact').mockImplementation(async (id, metadata, mutate) => {
      if (!failed && metadata.kind.endsWith('-candidate')) { failed = true; throw new Error('Injected candidate index acknowledgment loss'); }
      return persist(id, metadata, mutate);
    });
    await report(r, worker.attemptId); runtimes.get(worker.sessionId)!.finish();
    await wait(() => expect(service.get(r.id)!.operations.find((op) => op.kind === 'capture')?.state).toBe('failed'));
    await wait(() => expect(service.get(r.id)!.mailbox.some((entry) => entry.kind === 'candidate' && entry.sessionId === worker.sessionId && entry.text.includes('ended'))).toBe(true));
    fault.mockRestore();
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'capture-pause', control: { action: 'pause' } });
    const receipt = (await workspaces.candidatesForAttempt(r.id, worker.attemptId))[0];
    expect(service.get(r.id)?.candidates).toHaveLength(0);
    const cwd = sessions.get(worker.sessionId)!.cwd;
    await fs.writeFile(path.join(cwd, 'feature.txt'), 'later human edit\n');
    const starts = vi.mocked(createAdapter).mock.calls.length;
    await crashRestart();
    const restored = service.get(r.id)!;
    expect(restored.status).toBe('paused'); expect(restored.candidates).toHaveLength(1);
    expect(restored.candidates[0]).toMatchObject({ id: receipt.id, revision: receipt.revision, changedPaths: [] });
    expect(restored.operations.find((op) => op.kind === 'capture')).toMatchObject({ state: 'succeeded', payload: { reconciledFromReceipt: receipt.id } });
    expect(restored.blockers.filter((b) => b.resolvedAt === undefined)).toEqual([]);
    expect(await fs.readFile(path.join(cwd, 'feature.txt'), 'utf8')).toBe('later human edit\n');
    expect(vi.mocked(createAdapter)).toHaveBeenCalledTimes(starts);
  });

  it('retains pausing and capacity when the owned runtime cannot confirm teardown', async () => {
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    lead.adapter.dispose.mockRejectedValueOnce(new Error('Owned process is uncertain'));
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'uncertain-pause', control: { action: 'pause' } });
    expect(service.get(r.id)?.status).toBe('pausing');
    expect(scheduler.snapshot().active).toHaveLength(1);
    expect(service.get(r.id)!.operations.filter((op) => op.kind === 'interrupt' && op.state === 'succeeded')).toHaveLength(0);
    expect(service.get(r.id)!.blockers.some((blocker) => /did not stop/.test(blocker.message))).toBe(true);
    await expect(service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'unsafe-resume', control: { action: 'resume' } })).rejects.toThrow(/paused|reconciled/);
  });

  it.each([undefined, 'All 999 tests passed; merged at invented-merge in https://github.com/invented/repository/pull/99.'])('automatically reports reviewed local delivery and durable host facts, regardless of optional narrative: %s', async (narrative) => {
    const { r, candidate, author, review } = await reviewedCode();
    expect(review.sessionId).not.toBe(r.leadSessionId); expect(review.attemptId).not.toBe(author.attemptId);
    expect(service.get(r.id)?.evidence).toContainEqual(expect.objectContaining({ result: 'passed', sourceRevision: candidate.revision, provenance: 'host_executed' }));
    await expect(tool(r, 'mission_finish_request', { commitMessage: 'feat: Deliver independently reviewed behavior', completionReport: { delivery: { mergedCommitSha: 'invented' } } })).rejects.toThrow();
    const finish = await tool(r, 'mission_finish_request', { commitMessage: 'feat: Deliver independently reviewed behavior', ...(narrative ? { report: narrative } : {}) }) as { operationId: string };
    runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(service.get(r.id)?.status).toBe('completed'));
    const completed = service.get(r.id)!;
    expect(completed.delivery).toMatchObject({ operationId: finish.operationId, status: 'delivered', endpoint: 'local_commit', revision: candidate.revision });
    expect(git(project, 'show', `${completed.delivery!.commitSha}:feature.txt`)).toBe('implemented');
    expect(git(project, 'show', 'HEAD:feature.txt')).toBe('original');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(resolveDelivery).toHaveBeenLastCalledWith(project, { changedPaths: ['feature.txt'] });
    expect(scheduler.snapshot().active).toHaveLength(0);
    const report = completed.completionReport!;
    expect(report).toMatchObject({ objective: r.objective, acceptedRevision: candidate.revision, delivery: completed.delivery,
      tasks: { required: 1, satisfiedRequired: 1 }, review: { required: true, integratedCandidates: 1, independentlyReviewedCandidates: 1, reviews: completed.reviews } });
    expect(report.checks).toEqual([{ check: completed.deliveryPolicy.checks[0], evidence: completed.evidence.at(-1), verified: true }]);
    expect(report.checks[0].evidence?.executedTests).toBeUndefined();
    expect(report.delivery.commitSha).toBe(git(project, 'rev-parse', `${report.delivery.commitSha}^{commit}`));
    expect(report.delivery.pullRequestUrl).toBeUndefined(); expect(report.delivery.mergedCommitSha).toBeUndefined();
    expect(report.narrative).toEqual(narrative ? { sessionId: r.leadSessionId, text: narrative } : undefined);
    expect((await sessions.transcript(r.leadSessionId)).filter((item) => item.kind === 'assistant')).toEqual([]);
    const restored = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord }); await restored.load();
    expect(restored.get(r.id)?.completionReport).toEqual(report);
    const events = (await fs.readFile(path.join(data, 'missions', r.id, 'journal.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { payload: MissionRecord });
    expect(events.filter((event) => event.payload.status === 'completed').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.payload.status === 'completed').every((event) => !!event.payload.completionReport)).toBe(true);
  });

  it('enforces genuine local-only user delivery through the handler, restart, policy reread and a real local commit without remote effects', async () => {
    const check = { id: 'behavior', name: 'Changed behavior', kind: 'behavior', command: 'node -e "require(\'node:assert\').strictEqual(require(\'node:fs\').readFileSync(\'feature.txt\',\'utf8\').trim(),\'implemented\')"', criterionIds: ['outcome'], required: true, heavy: true, timeoutMs: 10_000 };
    await fs.mkdir(path.join(project, '.vocs-code'));
    await fs.writeFile(path.join(project, '.vocs-code', 'mission-delivery.json'), JSON.stringify({ version: 1, endpoint: 'merge_pr', remote: 'origin', targetBranch: 'develop', allowPush: true, allowMerge: true, requireIndependentReview: true, checks: [check] }));
    git(project, 'add', '.'); git(project, 'commit', '-m', 'test: Repository merge policy');
    const remoteProbe = vi.fn(async (_cwd: string, args: string[]) => ({ code: 0, stdout: args[0] === 'ls-remote' ? `${git(project, 'rev-parse', 'HEAD')}\trefs/heads/develop\n` : '', stderr: '' }));
    resolveDelivery.mockImplementation((root, scope) => resolveMissionDeliveryPolicy(root, { ...scope, runGit: remoteProbe }));
    const capture = processRuntime.runCapture;
    const metadataRead = (file: string, args: string[]) => /(?:^|[/\\])gh(?:\.exe)?$/i.test(file) && JSON.stringify(args) === JSON.stringify(['pr', 'list', '--state', 'all', '--limit', '50', '--json', 'number,state,headRefName,baseRefName,url,title']);
    // SessionManager's unrelated PR-status refresh is not Mission delivery. Keep that read
    // offline; every delivery-owned Git/GitHub process still reaches the real capture boundary.
    const processes = vi.spyOn(processRuntime, 'runCapture').mockImplementation((file, args, options) => metadataRead(file, args) ? Promise.resolve({ code: 0, stdout: '[]', stderr: '' }) : capture(file, args, options));
    const { r, candidate } = await reviewedCode(60_000);
    const registry = createHandlerRegistry({ missions: service, sessions, settings: { get: () => settings }, runtime: {}, desktop: { userDataPath: () => data }, log: vi.fn(), push: vi.fn() } as unknown as HandlerDeps);
    let before = service.get(r.id)!;
    expect(before.deliveryPolicy).toMatchObject({ endpoint: 'merge_pr', allowPush: true, allowMerge: true });
    const request = { missionId: r.id, expectedRevision: before.revision, idempotencyKey: 'keep-local', control: { action: 'narrow_delivery', endpoint: 'local_commit' } };
    await expect(registry.invoke('missions:control', { ...request, expectedRevision: before.revision - 1 })).rejects.toThrow(/revision/i);
    await expect(registry.invoke('missions:control', { ...request, actor: 'user' })).rejects.toThrow();
    // Refresh a rejected CAS, like the genuine UI: final lead-start observations may still arrive.
    for (let retry = 0; ; retry++) {
      before = service.get(r.id)!; request.expectedRevision = before.revision;
      try { await registry.invoke('missions:control', request); break; }
      catch (error) { if (retry >= 10 || !/Expected revision|Stale Mission revision/.test(String(error))) throw error; }
    }
    const restricted = service.get(r.id)!;
    expect(restricted.status).toBe('paused');
    expect(restricted.deliveryPolicy).toMatchObject({ endpoint: 'local_commit', allowPush: false, allowMerge: false, requireIndependentReview: true, checks: before.deliveryPolicy.checks });
    expect(restricted.publicationRestrictions).toHaveLength(1);
    expect(restricted.publicationRestrictions![0]).toMatchObject({ endpoint: 'local_commit', previousEndpoint: 'merge_pr', receivedRevision: before.revision, sourceUserActionId: expect.stringMatching(/^user_/), priorRemoteOperationIds: [] });
    const immutable = structuredClone(restricted.publicationRestrictions);
    await service.control(request as Parameters<MissionService['control']>[0]);
    expect(service.get(r.id)?.publicationRestrictions).toEqual(immutable);
    const probesBeforeDelivery = remoteProbe.mock.calls.length;
    processes.mockClear();
    await crashRestart();
    expect(service.get(r.id)?.publicationRestrictions).toEqual(immutable);
    await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'resume-local', control: { action: 'resume' } });
    await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
    await expect(tool(r, 'mission_integration_request', { target: 'approved', expectedContentHash: candidate.revision.contentHash })).rejects.toThrow(/remote target/);
    const finish = await tool(r, 'mission_finish_request', { commitMessage: 'feat: Deliver only locally' }) as { operationId: string };
    runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(service.get(r.id)?.status).toBe('completed'));
    const completed = service.get(r.id)!;
    expect(completed.delivery).toMatchObject({ operationId: finish.operationId, status: 'delivered', endpoint: 'local_commit', revision: candidate.revision });
    expect(completed.delivery?.pullRequestUrl).toBeUndefined(); expect(completed.delivery?.mergedCommitSha).toBeUndefined();
    expect(git(project, 'show', `${completed.delivery!.commitSha}:feature.txt`)).toBe('implemented');
    expect(git(project, 'show', 'HEAD:feature.txt')).toBe('original');
    expect(resolveDelivery).toHaveBeenLastCalledWith(project, { changedPaths: ['feature.txt'], localOnly: true });
    expect(remoteProbe.mock.calls.slice(probesBeforeDelivery).some(([, args]) => args[0] === 'ls-remote')).toBe(false);
    expect(processes.mock.calls.filter(([file, args]) => !metadataRead(file, args) && (/(?:^|[/\\])gh(?:\.exe)?$/i.test(file) || args.some((arg) => ['push', 'fetch', 'ls-remote'].includes(arg)))).map(([file, args]) => [file, args])).toEqual([]);
    expect(deliver).toHaveBeenCalledTimes(1); expect(completed.publicationRestrictions).toEqual(immutable);
    const events = (await fs.readFile(path.join(data, 'missions', r.id, 'journal.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const audit = events.filter((event) => event.kind === 'user.narrow_delivery');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: `user:${immutable![0].sourceUserActionId}`, request });
    expect(completed.deliveryPolicy.provenance).toContainEqual(expect.objectContaining({ source: `user:${immutable![0].sourceUserActionId}` }));
  });

  it('makes user publication reductions monotone without treating natural steering as endpoint authority or clearing gates', async () => {
    policy = { ...policy, endpoint: 'merge_pr', remote: 'origin', targetBranch: 'develop', targetHead: 'a'.repeat(40), allowPush: true, allowMerge: true, fallback: false, holdConditions: ['Independent human hold'], holdIsEndpoint: true };
    const r = await start();
    await service.sendUser(r.leadSessionId, { text: 'Keep this Mission local; do not publish.' }, 'natural-steering');
    expect(service.get(r.id)?.deliveryPolicy).toEqual(policy); expect(service.get(r.id)?.publicationRestrictions).toBeUndefined();
    await tool(r, 'mission_yield', { events: ['user'] }); runtimes.get(r.leadSessionId)!.finish();
    // Consume the genuine steering message, then wait at a stable control boundary.
    await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(2));
    await tool(r, 'mission_yield', { events: ['user'] }); runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    const narrow = (endpoint: 'open_pr' | 'local_commit', idempotencyKey: string = endpoint) => service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey, control: { action: 'narrow_delivery', endpoint } });
    const opened = await narrow('open_pr');
    expect(opened.deliveryPolicy).toEqual({ ...policy, endpoint: 'open_pr', allowMerge: false, provenance: expect.any(Array) });
    const local = await narrow('local_commit');
    expect(local.deliveryPolicy).toEqual({ ...policy, endpoint: 'local_commit', allowPush: false, allowMerge: false, provenance: expect.any(Array) });
    expect(local.publicationRestrictions?.map((restriction) => restriction.endpoint)).toEqual(['open_pr', 'local_commit']);
    const before = service.get(r.id)!;
    await expect(narrow('open_pr', 'widen')).rejects.toThrow(/only reduce/);
    await expect(service.control({ missionId: r.id, expectedRevision: before.revision, idempotencyKey: 'forged', control: { action: 'narrow_delivery', endpoint: 'local_commit', checks: [] } } as unknown as Parameters<MissionService['control']>[0])).rejects.toThrow();
    expect(service.get(r.id)).toEqual(before);
    local.publicationRestrictions![0].sourceUserActionId = 'forged';
    expect(service.get(r.id)?.publicationRestrictions?.[0].sourceUserActionId).not.toBe('forged');
    await crashRestart();
    expect(service.get(r.id)?.publicationRestrictions).toEqual(before.publicationRestrictions);
    expect(service.get(r.id)?.deliveryPolicy.holdConditions).toEqual(['Independent human hold']);
    await expect(narrow('open_pr', 'widen-after-restart')).rejects.toThrow(/only reduce/);
  });

  it('retains the user publication ceiling exactly once after a lost journal acknowledgment and restart', async () => {
    policy = { ...policy, endpoint: 'merge_pr', remote: 'origin', targetBranch: 'develop', targetHead: 'a'.repeat(40), allowPush: true, allowMerge: true, fallback: false };
    const r = await start();
    await tool(r, 'mission_yield', { events: ['user'] }); runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    const request = { missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'durable-limit', control: { action: 'narrow_delivery' as const, endpoint: 'local_commit' as const } };
    const transact = store.transact.bind(store);
    const failure = vi.spyOn(store, 'transact').mockImplementation((id, metadata, apply) => metadata.kind === 'user.narrow_delivery' ? Promise.reject(new Error('Injected pre-commit failure')) : transact(id, metadata, apply));
    await expect(service.control(request)).rejects.toThrow(/Injected pre-commit/);
    expect(service.get(r.id)?.publicationRestrictions).toBeUndefined();
    expect(service.get(r.id)?.deliveryPolicy.endpoint).toBe('merge_pr');
    failure.mockImplementation(async (id, metadata, apply) => {
      const committed = await transact(id, metadata, apply);
      if (metadata.kind === 'user.narrow_delivery') throw new Error('Injected lost acknowledgment after commit');
      return committed;
    });
    request.expectedRevision = service.get(r.id)!.revision;
    await expect(service.control(request)).rejects.toThrow(/lost acknowledgment/);
    const restrictions = service.get(r.id)!.publicationRestrictions;
    expect(restrictions).toHaveLength(1); expect(service.get(r.id)?.status).toBe('pausing');
    failure.mockRestore();
    await crashRestart();
    expect(service.get(r.id)?.publicationRestrictions).toEqual(restrictions);
    await service.control(request);
    expect(service.get(r.id)?.publicationRestrictions).toEqual(restrictions);
    expect(service.get(r.id)?.deliveryPolicy).toMatchObject({ endpoint: 'local_commit', allowPush: false, allowMerge: false });
    expect(service.get(r.id)?.deliveryPolicy.provenance.filter((entry) => entry.source === `user:${restrictions![0].sourceUserActionId}`)).toHaveLength(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('fences and waits for a crossed delivery boundary without erasing its local commit or claiming remote effects were undone', async () => {
    policy = { ...policy, endpoint: 'merge_pr', remote: 'origin', targetBranch: 'develop', targetHead: 'a'.repeat(40), allowPush: true, allowMerge: true, fallback: false };
    const { r } = await reviewedCode(60_000);
    const held = deferred<void>(), entered = deferred<void>();
    let retainedCommit: string | undefined;
    // The external port has crossed its recorded boundary. Retain a real local commit just as
    // delivery does before push approval; its uncertain remote outcome must never be replayed.
    deliver.mockImplementationOnce(async (request) => {
      const revision = request.mission.acceptedRevision!;
      retainedCommit = git(project, 'commit-tree', revision.contentHash, '-p', revision.baseCommitSha, '-m', `feat: Retained old delivery\n\nMission-Operation: ${request.operationId}`);
      git(project, 'update-ref', `refs/heads/mission/${r.id}-delivery`, retainedCommit, '0'.repeat(40));
      entered.resolve(); await held.promise;
      throw new Error('Remote delivery outcome is uncertain; retained receipt requires reconciliation.');
    });
    const finish = await tool(r, 'mission_finish_request', {}) as { operationId: string };
    runtimes.get(r.leadSessionId)!.finish(); await entered.promise;
    let settled = false;
    const restriction = service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'late-local', control: { action: 'narrow_delivery', endpoint: 'local_commit' } }).then((value) => { settled = true; return value; });
    try {
      await wait(() => expect(service.get(r.id)?.publicationRestrictions).toHaveLength(1));
      expect(service.get(r.id)?.status).toBe('pausing'); expect(settled).toBe(false);
      expect(service.get(r.id)?.publicationRestrictions?.[0].priorRemoteOperationIds).toEqual([finish.operationId]);
      expect(service.get(r.id)?.blockers.some((blocker) => /may already have published/.test(blocker.message) && !blocker.resolvedAt)).toBe(true);
      expect(git(project, 'rev-parse', `refs/heads/mission/${r.id}-delivery`)).toBe(retainedCommit);
    } finally { held.resolve(); }
    await restriction;
    expect(service.get(r.id)?.status).toBe('paused'); expect(service.get(r.id)?.delivery).toBeUndefined();
    await expect(service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'unsafe-late-resume', control: { action: 'resume' } })).rejects.toThrow(/blockers/);
    expect(deliver).toHaveBeenCalledTimes(1);
    const retained = service.get(r.id)!.operations.find((op) => op.id === finish.operationId)!;
    expect(retained).toMatchObject({ state: 'failed', payload: { deliveryPolicy: { endpoint: 'merge_pr' } } });
    expect(git(project, 'log', '-1', '--format=%B', retainedCommit!)).toContain(`Mission-Operation: ${finish.operationId}`);
    expect(git(project, 'rev-parse', `refs/heads/mission/${r.id}-delivery`)).toBe(retainedCommit);
  });

  it('persists final changed-path policy tightening and blocks delivery rather than relabeling old checks or widening grants', async () => {
    const { r } = await reviewedCode();
    resolveDelivery.mockImplementation(async (_root, scope) => {
      expect(scope?.changedPaths).toEqual(['feature.txt']);
      return { ...structuredClone(policy), allowPush: true, allowMerge: true,
        holdConditions: ['Sensitive changes require human review'], holdIsEndpoint: true,
        checks: [...policy.checks, { id: 'sensitive-behavior', name: 'Sensitive path check', kind: 'behavior', command: 'node -e "process.exit(0)"', criterionIds: ['sensitive-outcome'], required: true, heavy: true, timeoutMs: 10_000 }] };
    });
    const finish = await tool(r, 'mission_finish_request', {}) as { operationId: string };
    runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(service.get(r.id)?.operations.find((op) => op.id === finish.operationId)?.state).toBe('failed'));
    expect(service.get(r.id)?.deliveryPolicy).toMatchObject({ allowPush: false, allowMerge: false, holdConditions: ['Sensitive changes require human review'], holdIsEndpoint: true });
    expect(service.get(r.id)?.deliveryPolicy.checks.map((check) => check.id)).toEqual(['behavior', 'sensitive-behavior']);
    expect(service.get(r.id)?.plan.criteria).toContainEqual(expect.objectContaining({ id: 'sensitive-outcome', required: true }));
    expect(service.get(r.id)?.delivery).toBeUndefined(); expect(deliver).not.toHaveBeenCalled();
    expect(git(project, 'branch', '--list', `mission/${r.id}-delivery`)).toBe('');
    const persisted = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord, validateObservation: assertMissionUsageObservation }); await persisted.load();
    expect(persisted.get(r.id)?.deliveryPolicy).toEqual(service.get(r.id)?.deliveryPolicy);
  });
});

describe('Mission lifecycle dead-ends', () => {
  const control = (r: MissionRecord, action: 'pause' | 'resume' | 'stop', idempotencyKey: string) => service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey, control: { action } });
  const open = (r: MissionRecord) => service.get(r.id)!.blockers.filter((blocker) => blocker.resolvedAt === undefined);

  it('captures a submitted candidate and records no blocker when Pause lands while its terminal turn settles', async () => {
    const r = await start(); await plan(r); const worker = await delegate(r);
    await report(r, worker.attemptId);
    const transact = store.transact.bind(store);
    let paused: Promise<MissionRecord> | undefined;
    const race = vi.spyOn(store, 'transact').mockImplementation(async (id, metadata, mutate) => {
      const committed = await transact(id, metadata, mutate);
      if (!paused && metadata.kind.startsWith('turn_')) {
        // The attempt is recorded terminal; the user pauses before its candidate capture.
        paused = service.control({ missionId: r.id, expectedRevision: committed.revision, idempotencyKey: 'pause-during-settle', control: { action: 'pause' } });
        await vi.waitFor(() => expect(service.get(r.id)?.status).toBe('pausing'), { timeout: 15_000, interval: 10 });
      }
      return committed;
    });
    runtimes.get(worker.sessionId)!.finish();
    await wait(() => expect(paused).toBeDefined());
    await paused; race.mockRestore();
    const settled = service.get(r.id)!;
    expect(settled.status).toBe('paused');
    expect(settled.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'submitted' });
    expect(settled.candidates).toEqual([expect.objectContaining({ attemptId: worker.attemptId })]);
    expect(open(r)).toEqual([]);
    await control(r, 'resume', 'resume-after-settle');
    expect(service.get(r.id)?.status).toBe('running');
  });

  it('retains a submitted candidate when a budget fence closes admission before its terminal turn arrives', async () => {
    config.limits.maxTokens = 1_000;
    const r = await start(); await plan(r); const worker = await delegate(r); const runtime = runtimes.get(worker.sessionId)!;
    await report(r, worker.attemptId);
    runtime.usage({ inputTokens: 1_000, costUsd: 1 }); // Fences synchronously, before the turn card.
    runtime.finish();
    await wait(() => expect(service.get(r.id)?.status).toBe('paused'));
    const paused = service.get(r.id)!;
    expect(paused.attempts[0]).toMatchObject({ status: 'terminal', outcome: 'submitted' });
    expect(paused.candidates).toEqual([expect.objectContaining({ attemptId: worker.attemptId })]);
    expect(open(r).map((blocker) => blocker.id)).toEqual([expect.stringMatching(/^budget_/)]);
    expect(runtime.adapter.send).toHaveBeenCalledTimes(1);
  });

  it('resolves its own did-not-stop blocker once a later reconciliation proves quiescence, so Resume works', async () => {
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    lead.adapter.dispose.mockRejectedValueOnce(new Error('Owned process is uncertain'));
    await control(r, 'pause', 'uncertain-pause');
    expect(service.get(r.id)?.status).toBe('pausing');
    expect(open(r)).toEqual([expect.objectContaining({ id: expect.stringMatching(/^quiesce_/), message: expect.stringContaining('did not stop') })]);
    service.ownedActivityChanged(r.id);
    await wait(() => expect(service.get(r.id)?.status).toBe('paused'));
    expect(open(r)).toEqual([]);
    expect(service.get(r.id)!.blockers).toEqual([expect.objectContaining({ message: expect.stringContaining('did not stop'), resolvedAt: expect.any(Number) })]);
    await control(r, 'resume', 'resume-after-proof');
    await wait(() => expect(runtimes.get(r.leadSessionId)).not.toBe(lead));
    await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  });

  it('turns an unexpected coordinator failure into a blocker that Pause and Resume clear', async () => {
    const r = await start(); await plan(r); const worker = await delegate(r);
    await report(r, worker.attemptId);
    const transact = store.transact.bind(store);
    let injected = false;
    const fault = vi.spyOn(store, 'transact').mockImplementation((id, metadata, mutate) => {
      if (!injected && metadata.kind.startsWith('mail_') && metadata.kind.endsWith('-mail')) { injected = true; return Promise.reject(new Error('Injected coordinator fault')); }
      return transact(id, metadata, mutate);
    });
    runtimes.get(worker.sessionId)!.finish();
    await wait(() => expect(open(r)).toEqual([expect.objectContaining({ id: expect.stringMatching(/^pump_/), message: expect.stringContaining('Injected coordinator fault') })]));
    fault.mockRestore();
    expect(service.get(r.id)?.candidates).toHaveLength(1);
    await control(r, 'pause', 'pause-after-fault');
    expect(service.get(r.id)?.status).toBe('paused');
    await control(r, 'resume', 'resume-after-fault');
    expect(service.get(r.id)?.status).toBe('running'); expect(open(r)).toEqual([]);
    await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send.mock.calls.at(-1)?.[0].text).toContain('User resume'));
  });

  it('re-probes a dirty baseline on Resume with an actionable blocker instead of refusing forever', async () => {
    await fs.writeFile(path.join(project, 'feature.txt'), 'user edits\n');
    const r = await start();
    const blocked = service.get(r.id)!;
    expect(blocked.baseline).toBeUndefined();
    expect(open(r)).toEqual([expect.objectContaining({ id: expect.stringMatching(/^baseline_/), message: expect.stringMatching(/feature\.txt.*Resume/) })]);
    await control(r, 'pause', 'pause-dirty');
    git(project, 'checkout', '--', 'feature.txt');
    await control(r, 'resume', 'resume-clean');
    const resumed = service.get(r.id)!;
    expect(resumed.status).toBe('running');
    expect(resumed.baseline).toMatchObject({ baseCommitSha: git(project, 'rev-parse', 'HEAD') });
    expect(open(r)).toEqual([]);
    expect(resumed.blockers.filter((blocker) => blocker.id.startsWith('baseline_')).every((blocker) => blocker.resolvedAt !== undefined)).toBe(true);
    expect(resumed.mailbox.some((item) => item.text.includes('Clean source baseline established'))).toBe(true);
    await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send.mock.calls.at(-1)?.[0].text).toContain('Clean source baseline established'));
    expect(git(project, 'status', '--porcelain')).toBe('');
  });

  it('re-probes a still-blocked baseline at the lead turn boundary once execution is authorized', async () => {
    await fs.writeFile(path.join(project, 'feature.txt'), 'user edits\n');
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    const probe = vi.spyOn(workspaces, 'probeBaseline');
    lead.finish('dirty-boundary');
    await wait(() => expect(lead.adapter.send).toHaveBeenCalledTimes(2));
    expect(probe).toHaveBeenCalledTimes(1); expect(service.get(r.id)?.baseline).toBeUndefined();
    expect(open(r).filter((blocker) => blocker.id.startsWith('baseline_'))).toHaveLength(1);
    git(project, 'checkout', '--', 'feature.txt');
    lead.finish('clean-boundary');
    await wait(() => expect(service.get(r.id)?.baseline).toBeDefined());
    expect(open(r)).toEqual([]);
    await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send.mock.calls.at(-1)?.[0].text).toContain('Clean source baseline established'));
  });

  it('wakes the claimed task of the principal engineer on the result of its own verification request', async () => {
    policy.checks = [{ id: 'behavior', name: 'Behavior check', kind: 'behavior', command: 'node -e "process.exit(0)"', criterionIds: ['outcome'], required: true, heavy: true, timeoutMs: 10_000 }];
    const r = await start();
    await plan(r, [task('direct', { assignment: { kind: 'lead' }, requiredTools: ['write'] })]);
    const planning = runtimes.get(r.leadSessionId)!;
    const claim = await tool(r, 'mission_task_claim', { taskId: 'direct' }) as { attemptId: string };
    planning.finish('claim-boundary');
    await wait(() => expect(runtimes.get(r.leadSessionId)).not.toBe(planning));
    await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
    const claimed = runtimes.get(r.leadSessionId)!;
    const verify = await tool(r, 'mission_verification_request', { checkId: 'behavior' }) as { operationId: string };
    await tool(r, 'mission_yield', { events: ['verification'] });
    claimed.finish('await-verification');
    await wait(() => expect(service.get(r.id)?.operations.find((op) => op.id === verify.operationId)?.state).toBe('succeeded'));
    await wait(() => expect(claimed.adapter.send).toHaveBeenCalledTimes(2));
    expect(claimed.adapter.send.mock.calls[1][0].text).toMatch(/Events for your claimed task direct[\s\S]*Check behavior: passed/);
    expect(service.get(r.id)?.attempts.find((a) => a.id === claim.attemptId)).toMatchObject({ status: 'running', repairTurns: 0 });
    expect(service.get(r.id)?.mailbox.filter((item) => item.deliveredAt === undefined)).toEqual([]);
  });

  it('asks a worker for its result and tells the lead when it yields with nothing that could wake it', async () => {
    const r = await start(); await plan(r); const worker = await delegate(r); const runtime = runtimes.get(worker.sessionId)!;
    await tool(r, 'mission_yield', { events: ['decision'] }, worker.sessionId);
    runtime.finish('idle-yield');
    await wait(() => expect(runtime.adapter.send).toHaveBeenCalledTimes(2));
    expect(runtime.adapter.send.mock.calls[1][0].text).toMatch(/nothing you requested is pending/);
    expect(service.get(r.id)?.attempts[0]).toMatchObject({ status: 'running', repairTurns: 1 });
    expect(service.get(r.id)?.mailbox).toContainEqual(expect.objectContaining({ kind: 'decision', sessionId: worker.sessionId, text: expect.stringContaining('yielded for ["decision"]') }));
  });

  it('accepts the same Steer key at the fresh revision after a concurrent host write rejected its CAS', async () => {
    const r = await start();
    const transact = store.transact.bind(store);
    let raced = false;
    const race = vi.spyOn(store, 'transact').mockImplementation(async (id, metadata, mutate) => {
      if (!raced && metadata.kind === 'user.steer') {
        raced = true;
        await transact(id, { idempotencyKey: 'concurrent-host-write', actor: 'host', kind: 'test.host-write', expectedRevision: service.get(id)!.revision, request: { key: 'concurrent' } }, (state) => state);
      }
      return transact(id, metadata, mutate);
    });
    const steer = () => service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'steer-after-race', control: { action: 'steer', text: 'Also cover the empty input edge case' } });
    await expect(steer()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    race.mockRestore();
    await steer();
    expect(service.get(r.id)!.mailbox.filter((item) => item.userAction)).toEqual([expect.objectContaining({ text: 'Also cover the empty input edge case' })]);
  });

  it('refuses a publishing repository check at request time even in full-auto, without running it', async () => {
    const marker = path.join(root, 'published.txt');
    policy.checks = [{ id: 'release', name: 'Release', kind: 'behavior', command: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')" && git push origin HEAD`, criterionIds: ['outcome'], required: true, heavy: true, timeoutMs: 10_000 }];
    const r = await start({ permissionMode: 'full-auto' }); await plan(r); const worker = await delegate(r);
    await report(r, worker.attemptId); runtimes.get(worker.sessionId)!.finish();
    await wait(() => expect(service.get(r.id)?.candidates).toHaveLength(1));
    const candidate = service.get(r.id)!.candidates[0];
    await expect(tool(r, 'mission_verification_request', { checkId: 'release', candidateId: candidate.id })).rejects.toThrow(/only verify content.*git push/);
    expect(service.get(r.id)?.operations.filter((op) => op.kind === 'verify')).toEqual([]);
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
  });

  it('finishes an interrupted lead handover from its retained intent on Resume', async () => {
    const alternative = { ...config.presets[0], id: 'alternative', name: 'Alternative principal' };
    config.presets.push(alternative); config.tiers[4].presetIds.push(alternative.id);
    const r = await start();
    await control(r, 'pause', 'handover-pause');
    const startup = vi.spyOn(sessions, 'createManaged').mockRejectedValueOnce(new Error('Injected replacement startup failure'));
    const changed = await service.control({ missionId: r.id, expectedRevision: service.get(r.id)!.revision, idempotencyKey: 'failed-handover', control: { action: 'replace_lead', presetId: alternative.id } });
    startup.mockRestore();
    expect(changed.status).toBe('paused');
    expect(open(r)).toEqual([expect.objectContaining({ id: expect.stringMatching(/^handover_/), message: expect.stringContaining('Injected replacement startup failure') })]);
    expect(runtimes.has(changed.leadSessionId)).toBe(false);
    await control(r, 'resume', 'resume-handover');
    expect(open(r)).toEqual([]);
    await wait(() => expect(runtimes.get(changed.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
    expect(runtimes.get(changed.leadSessionId)!.adapter.send.mock.calls[0][0].text).toContain('Explicit T5 handover');
    expect(sessions.get(changed.leadSessionId)?.cwd).toBe(service.get(r.id)!.workspaces.find((w) => w.role === 'lead' && w.ownerSessionId === changed.leadSessionId)?.path);
  });
});
