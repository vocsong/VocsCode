/** Real MCP/service/store, isolated Git workspaces, checks and local delivery. Only the model
 * process is scripted; no host evidence, review outcome or delivery receipt is seeded. */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { MissionService } from '../src/main/mission/service';
import { MissionStore, MissionStoreError } from '../src/main/mission/store';
import { assertMissionUsageObservation } from '../src/main/mission/budget';
import { assertMissionRecord, completionBlockers, implementationBlockers, reduceMission, type MissionTaskContract } from '../src/main/mission/state';
import { MissionWorkspaces } from '../src/main/mission/workspaces';
import { MissionScheduler } from '../src/main/mission/scheduler';
import { MissionVerification } from '../src/main/mission/verification';
import { localMissionDeliveryPolicy, MissionDeliveryService } from '../src/main/mission/delivery';
import type { MissionToolBinding, MissionToolName } from '../src/main/mission/tools';
import { createDefaultMissionConfig } from '../src/shared/mission-config';
import type { MissionCandidate, MissionCheck, MissionCriterion, MissionProfile, MissionRecord, MissionReview } from '../src/shared/mission';
import type { UserInput } from '../src/shared/types';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
const wait = (assertion: () => void) => vi.waitFor(assertion, { timeout: 45_000, interval: 30 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
let root: string, project: string, data: string;
let sessions: SessionManager, sessionStore: SessionStore, store: MissionStore<MissionRecord>, service: MissionService;
let scheduler: MissionScheduler, workspaces: MissionWorkspaces, delivery: MissionDeliveryService;
let runtimes: Map<string, ReturnType<typeof scripted>>, sequence: number;
let delivered: ReturnType<typeof vi.fn<MissionDeliveryService['deliver']>>;

function scripted(ctx: HarnessContext) {
  return {
    ctx,
    adapter: {
      id: 'native', busy: false, start: vi.fn(async () => undefined),
      missionReadiness: vi.fn(async () => ({ ready: true, tools: ['read', 'write'] })),
      send: vi.fn(async (_input: UserInput) => { ctx.emit({ type: 'status', status: 'running' }); }),
      interrupt: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined), setEffort: vi.fn(async () => undefined), setPermissionMode: vi.fn(async () => undefined),
    } satisfies HarnessAdapter,
    finish: () => {
      ctx.emit({ type: 'item.upsert', item: { id: `turn-${++sequence}`, kind: 'turn', ts: Date.now(), status: 'completed' } });
      ctx.emit({ type: 'status', status: 'idle' });
    },
    claim: () => ctx.emit({ type: 'item.upsert', item: { id: `claim-${++sequence}`, kind: 'assistant', ts: Date.now(), text: 'Independent review and delivery passed. GOAL_COMPLETE.' } }),
  };
}
function binding(record: MissionRecord, sessionId = record.leadSessionId): MissionToolBinding {
  const owner = sessions.get(sessionId)!.mission!;
  return { missionId: record.id, actor: owner.role === 'lead' ? { kind: 'lead', sessionId, generation: owner.generation }
    : { kind: 'worker', sessionId, generation: owner.generation, attemptId: owner.attemptId! } };
}
async function tool(record: MissionRecord, name: MissionToolName, payload: Record<string, unknown>, sessionId = record.leadSessionId) {
  const idempotencyKey = `call-${++sequence}`;
  for (let retry = 0; ; retry++) {
    try { return await service.toolHost.invoke(binding(record, sessionId), name, { expectedRevision: service.get(record.id)!.revision, idempotencyKey, payload }); }
    catch (error) { if (!(error instanceof MissionStoreError) || error.code !== 'REVISION_CONFLICT' || retry >= 10) throw error; }
  }
}
function task(id: string, patch: Partial<MissionTaskContract> = {}): MissionTaskContract {
  return { id, revision: 1, specificationRevision: 1, objective: `Implement or review ${id}`, scope: 'feature.cjs', ownedPaths: ['feature.cjs'], exclusions: [], dependsOn: [],
    decisionRefs: [], sharedContracts: [], requiredTools: ['write'], criteria: [], verificationIds: [], assignment: { kind: 'lead' }, required: true, ...patch };
}
async function report(record: MissionRecord, attemptId: string) {
  const attempt = service.get(record.id)!.attempts.find((a) => a.id === attemptId)!;
  await tool(record, 'mission_report', { result: { taskId: attempt.taskId, taskRevision: attempt.taskRevision, attemptId, specificationRevision: attempt.specificationRevision,
    status: 'candidate', summary: 'The assigned work is ready for host evaluation', artifactIds: [], evidenceIds: [], decisionIds: [], unresolved: [] } }, attempt.sessionId);
}
function criteria(combined: boolean): MissionCriterion[] {
  return combined ? [{ id: 'all-kinds', description: 'All checks, independent review and actual delivery succeed', required: true, evidenceKinds: ['test', 'build', 'behavior', 'review', 'delivery'] }]
    : [{ id: 'review-only', description: 'Independently review the final content', required: true, evidenceKinds: ['review'] },
      { id: 'delivery-only', description: 'Deliver the verified content through the project endpoint', required: true, evidenceKinds: ['delivery'] }];
}
function checks(combined: boolean): MissionCheck[] {
  return combined ? (['test', 'build', 'behavior'] as const).map((kind) => ({ id: kind, name: kind, kind, criterionIds: ['all-kinds'], required: true, heavy: false, timeoutMs: 10_000,
    command: kind === 'test' ? 'node --test --test-reporter=tap feature.test.cjs' : kind === 'build' ? 'node --check feature.cjs'
      : 'node -e "require(\'node:assert/strict\').equal(require(\'./feature.cjs\'),\'implemented\')"',
    ...(kind === 'test' ? { testReport: { format: 'node-tap' as const, minimumTests: 1, maximumSkipped: 0 } } : {}),
  })) : [];
}
async function planned(combined = false) {
  const record = await service.create({ idempotencyKey: 'launch', objective: 'Implement and independently review a feature, then deliver it locally', projectRoot: project, mode: 'autonomous', permissionMode: 'auto' });
  await wait(() => expect(runtimes.get(record.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  await service.broker.start();
  const server = service.broker.attach(binding(record)), client = new Client({ name: 'criterion-evidence-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.def.url!), { requestInit: { headers: server.def.headers } }));
    const listed = await client.listTools();
    expect(listed.tools.find((t) => t.name === 'mission_plan_update')?.inputSchema).toMatchObject({ properties: { payload: { properties: { plan: { properties: { criteria: {
      items: { properties: { evidenceKinds: { items: { enum: ['test', 'build', 'review', 'behavior', 'delivery'] } } } },
    } } } } } } });
    const current = service.get(record.id)!;
    const response = await client.callTool({ name: 'mission_plan_update', arguments: { expectedRevision: current.revision, idempotencyKey: 'first-plan', payload: {
      expectedPlanRevision: 0, plan: { ...current.plan, criteria: criteria(combined) }, tasks: [task('author', { criteria: criteria(combined) })], checks: checks(combined),
    } } });
    expect(response.isError).toBe(false);
    expect(service.get(record.id)?.plan.criteria).toEqual(criteria(combined));
    expect(service.get(record.id)?.tasks[0].criteria).toEqual(criteria(combined));
  } finally { await client.close(); }
  return service.get(record.id)!;
}
async function authored(record: MissionRecord) {
  const author = await tool(record, 'mission_task_claim', { taskId: 'author' }) as { attemptId: string };
  runtimes.get(record.leadSessionId)!.finish();
  await wait(() => expect(sessions.get(record.leadSessionId)?.mission?.sourceAccess).toBe('assigned_workspace'));
  await wait(() => expect(sessions.activity(record.leadSessionId).turn).toBe(true));
  await fs.writeFile(path.join(sessions.get(record.leadSessionId)!.cwd, 'feature.cjs'), "module.exports = 'implemented';\n");
  await report(record, author.attemptId); runtimes.get(record.leadSessionId)!.finish();
  await wait(() => expect(service.get(record.id)?.candidates).toHaveLength(1));
  await wait(() => expect(sessions.get(record.leadSessionId)?.mission?.sourceAccess).toBe('read_only'));
  await wait(() => expect(sessions.activity(record.leadSessionId).turn).toBe(true));
  return { author, candidate: service.get(record.id)!.candidates[0] };
}
async function reviewer(record: MissionRecord, candidate?: MissionCandidate) {
  const id = `reviewer-${++sequence}`;
  const profile: MissionProfile = { id, revision: 1, name: 'Independent reviewer', purpose: 'Review original criteria and raw exact-content artifacts', instructions: 'Inspect the immutable candidate independently',
    tierId: 3, contextRefs: candidate ? [candidate.id] : [], requestedTools: ['read'], sourceAccess: 'read_only', resultExpectations: 'Evidence-backed findings' };
  await tool(record, 'mission_profile_upsert', { profile });
  const current = service.get(record.id)!;
  await tool(record, 'mission_plan_update', { expectedPlanRevision: current.planRevision, plan: current.plan,
    tasks: [task(id, { required: false, requiredTools: ['read'], assignment: { kind: 'worker', profileId: id, profileRevision: 1 } })] });
  const result = await tool(record, 'mission_task_delegate', { taskId: id, presetId: 'standard', reason: 'Independent exact-content review', ...(candidate ? { candidateId: candidate.id } : {}) }) as { attemptId: string; sessionId: string };
  await wait(() => expect(runtimes.get(result.sessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  return result;
}
async function settledReview(record: MissionRecord, candidate: MissionCandidate) {
  const reviewerAttempt = await reviewer(record, candidate);
  expect(await fs.readFile(path.join(sessions.get(reviewerAttempt.sessionId)!.cwd, 'feature.cjs'), 'utf8')).toBe("module.exports = 'implemented';\n");
  const review: MissionReview = { id: `review-${++sequence}`, candidateId: candidate.id, reviewerAttemptId: reviewerAttempt.attemptId, sourceRevision: candidate.revision,
    criterionIds: record.plan.criteria.filter((c) => c.evidenceKinds.some((kind) => kind !== 'delivery')).map((c) => c.id), findings: [], submittedAt: Date.now() };
  await tool(record, 'mission_review_submit', { review }, reviewerAttempt.sessionId);
  await report(record, reviewerAttempt.attemptId); runtimes.get(reviewerAttempt.sessionId)!.finish();
  await wait(() => expect(service.get(record.id)?.attempts.find((a) => a.id === reviewerAttempt.attemptId)?.outcome).toBe('submitted'));
  await wait(() => expect(service.get(record.id)?.candidates.some((c) => c.attemptId === reviewerAttempt.attemptId)).toBe(true));
  return reviewerAttempt;
}
async function verifyCandidate(record: MissionRecord, candidate: MissionCandidate) {
  for (const check of service.get(record.id)!.deliveryPolicy.checks) {
    const result = await tool(record, 'mission_verification_request', { candidateId: candidate.id, checkId: check.id }) as { operationId: string };
    await tool(record, 'mission_yield', { events: ['verification'] }); runtimes.get(record.leadSessionId)!.finish();
    await wait(() => expect(service.get(record.id)?.operations.find((op) => op.id === result.operationId)?.state).toBe('succeeded'));
    await wait(() => expect(sessions.activity(record.leadSessionId).turn).toBe(true));
  }
}
async function complete(record: MissionRecord, candidate: MissionCandidate, attemptId: string) {
  await tool(record, 'mission_task_accept', { taskId: 'author', attemptId });
  const integration = await tool(record, 'mission_integration_request', { candidateId: candidate.id, expectedContentHash: record.acceptedRevision!.contentHash }) as { operationId: string };
  await tool(record, 'mission_yield', { events: ['integration'] }); runtimes.get(record.leadSessionId)!.finish();
  await wait(() => expect(service.get(record.id)?.operations.find((o) => o.id === integration.operationId)?.state).toBe('succeeded'));
  await wait(() => expect(sessions.activity(record.leadSessionId).turn).toBe(true));
  const before = service.get(record.id)!;
  expect(before.delivery).toBeUndefined();
  expect(completionBlockers(before, { quiescent: true })).toContain(`Criterion ${record.plan.criteria.at(-1)!.id} lacks valid delivery evidence.`);
  const finish = await tool(record, 'mission_finish_request', { commitMessage: 'feat: Deliver independently reviewed criteria' }) as { operationId: string };
  runtimes.get(record.leadSessionId)!.finish();
  await wait(() => expect(service.get(record.id)?.status).toBe('completed'));
  const completed = service.get(record.id)!;
  expect(completed.phase).toBe('done');
  expect(completed.operations.filter((op) => op.kind === 'deliver')).toEqual([expect.objectContaining({ id: finish.operationId, state: 'succeeded' })]);
  expect(completed.delivery).toMatchObject({ operationId: finish.operationId, status: 'delivered', endpoint: 'local_commit', revision: completed.acceptedRevision });
  expect(completed.evidence.every((e) => ['test', 'build', 'behavior'].includes(e.kind))).toBe(true);
  expect(git(project, 'rev-parse', `${completed.delivery!.commitSha}^{tree}`)).toBe(completed.acceptedRevision!.contentHash);
  expect(git(project, 'show', `${completed.delivery!.commitSha}:feature.cjs`)).toBe("module.exports = 'implemented';");
  expect(git(project, 'rev-parse', 'HEAD')).toBe(record.baseline!.baseCommitSha);
  expect(git(project, 'status', '--porcelain')).toBe('');
  expect(delivered).toHaveBeenCalledTimes(1);
  expect(scheduler.snapshot().active).toEqual([]);
  const retained = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord, validateObservation: assertMissionUsageObservation });
  await retained.load(); expect(retained.get(record.id)).toEqual(completed);
  return completed;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-')); project = path.join(root, 'p'); data = path.join(root, 'd');
  await fs.mkdir(project); git(project, 'init', '-b', 'main');
  // Identity belongs only to this disposable repository, never the developer's checkout.
  git(project, 'config', 'user.name', 'Mission Criteria Test'); git(project, 'config', 'user.email', 'mission-criteria@example.invalid');
  git(project, 'config', 'core.autocrlf', 'false'); git(project, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(project, 'feature.cjs'), "module.exports = 'original';\n");
  await fs.writeFile(path.join(project, 'feature.test.cjs'), "require('node:test')('implemented behavior',()=>require('node:assert/strict').equal(require('./feature.cjs'),'implemented'));\n");
  git(project, 'add', '.'); git(project, 'commit', '-m', 'Fixture baseline');
  const settings = defaultSettings(); settings.providers = [];
  const config = createDefaultMissionConfig(), lead = { id: 'frontier', name: 'Principal', revision: 1, harnessId: 'native' as const, model: { provider: 'fixture', model: 'frontier' }, reasoning: { kind: 'default' as const }, enabled: true };
  config.presets = [lead, { ...lead, id: 'standard', name: 'Specialist', model: { provider: 'fixture', model: 'standard' } }];
  config.tiers[4].presetIds = ['frontier']; config.tiers[2].presetIds = ['standard']; config.defaultLeadPresetId = 'frontier';
  sequence = 0; runtimes = new Map();
  sessionStore = new SessionStore(data); await sessionStore.load();
  sessions = new SessionManager({ store: sessionStore, settings: { get: () => settings } as SettingsStore, runtime: {} as RuntimeResolver,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn() });
  store = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord, validateObservation: assertMissionUsageObservation }); await store.load();
  scheduler = new MissionScheduler(config.limits);
  const held = new Set<string>();
  workspaces = new MissionWorkspaces({ root: path.join(data, 'w'), quiescence: { acquire: async (cwd) => {
    const quiet = () => !sessions.list().some((s) => path.resolve(s.cwd) === path.resolve(cwd) && !sessions.activity(s.id).quiescent);
    if (held.has(cwd) || !quiet()) return null;
    held.add(cwd);
    return { assertQuiescent: async () => { if (!quiet() || !held.has(cwd)) throw new Error('Lost workspace admission'); }, release: () => { held.delete(cwd); } };
  } } });
  const contentIdentity = (cwd: string) => workspaces.contentIdentity(cwd);
  const verification = new MissionVerification({ scheduler, windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'), contentIdentity, saveArtifact: (id, bytes) => store.writeArtifact(id, bytes),
    authorize: async (req) => { if (!service.get(req.missionId)?.operations.some((op) => op.id === req.operationId && op.state === 'in_flight')) throw new Error('No admitted check'); } });
  delivery = new MissionDeliveryService({ root: path.join(data, 'receipts'), contentIdentity, isQuiescent: async (r) => service.isQuiescent(r),
    authorize: async (req) => { if (service.get(req.mission.id)?.status !== 'running') throw new Error('No delivery authorization'); },
    implementationBlockers: (r) => implementationBlockers(r, { quiescent: service.isQuiescent(r), deliveryOperationId: r.operations.find((op) => op.kind === 'deliver' && op.state === 'in_flight')?.id }),
  });
  delivered = vi.fn((req) => delivery.deliver(req));
  vi.mocked(createAdapter).mockReset().mockImplementation((_harness, ctx) => { const runtime = scripted(ctx); runtimes.set(ctx.sessionId, runtime); return runtime.adapter; });
  service = new MissionService({ store, sessions, workspaces, scheduler, verification, settings: () => ({ config }),
    capabilities: { probe: async (_preset, scope) => {
      const { readiness } = await sessions.prepareManaged(scope.sessionId, scope.generation);
      return { source: 'runtime', runtime: { available: true, authenticated: true }, connectionAvailable: true, modelAvailable: true, projectAllowed: true,
        harnessCapabilities: { interrupt: true }, controlProtocol: readiness.ready, worktreeCwd: true, completionObservation: true, cancellationObservation: true, missionTools: readiness.ready, delegationControl: true, tools: readiness.tools };
    } }, delivery: { resolve: async () => localMissionDeliveryPolicy(), deliver: delivered },
  });
});
afterEach(async () => {
  await service.close(); await sessions.stopAll(); await sessions.flushPendingPersists(); vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('Required review and delivery criteria at real boundaries', () => {
  it.each([false, true])('completes the first accepted MCP plan using real independent review and a local Git receipt (combined kinds: %s)', async (combined) => {
    const record = await planned(combined), { author, candidate } = await authored(record);
    await verifyCandidate(record, candidate);
    const review = await settledReview(record, candidate);
    expect(review.sessionId).not.toBe(record.leadSessionId); expect(review.attemptId).not.toBe(author.attemptId);
    const completed = await complete(record, candidate, author.attemptId);
    expect(completed.reviews).toHaveLength(1);
    expect(completed.evidence.filter((e) => e.result === 'passed').map((e) => e.kind)).toEqual(combined ? ['test', 'build', 'behavior', 'test', 'build', 'behavior'] : []);
    expect(completed.evidence.find((e) => e.kind === 'test')).toEqual(combined ? expect.objectContaining({ executedTests: 1, skippedTests: 0, provenance: 'host_executed' }) : undefined);
    expect(completed.completionReport?.checks).toHaveLength(combined ? 3 : 0);
    expect(completed.completionReport?.checks.every(({ evidence, verified }) => verified && evidence?.sourceRevision.contentHash === completed.acceptedRevision!.contentHash)).toBe(true);
    expect(completed.completionReport?.checks.find(({ check }) => check.kind === 'test')?.evidence).toEqual(combined ? expect.objectContaining({ executedTests: 1, skippedTests: 0, provenance: 'host_executed' }) : undefined);
    expect(completed.completionReport?.delivery).toEqual(completed.delivery);

    // Corrupt copies of an actually completed ledger must fail the production completion and
    // persistence boundaries. They never seed a fabricated success in the running service.
    const corruptions: Array<[string, (r: MissionRecord) => void]> = [
      ['review', (r) => { r.reviews[0].sourceRevision = r.baseline!; }],
      ['review', (r) => { r.reviews[0].reviewerAttemptId = author.attemptId; }],
      ['review', (r) => { r.reviews[0].criterionIds = []; }],
      ['review', (r) => { r.attempts.find((a) => a.id === review.attemptId)!.effectiveModel = { provider: 'unapproved', model: 'substitute' }; }],
      ['review', (r) => { r.attempts.find((a) => a.id === review.attemptId)!.result!.unresolved.push({ description: 'Review could not be completed', blocking: true }); }],
      ['review', (r) => { const t = r.tasks.find((t) => t.currentAttemptId === review.attemptId)!; t.status = 'canceled'; t.reason = 'Review result is no longer accepted'; }],
      ['delivery', (r) => { r.delivery!.status = 'blocked'; }],
      ['delivery', (r) => { r.delivery!.revision = r.baseline!; }],
      ['delivery', (r) => { r.operations.find((op) => op.id === r.delivery!.operationId)!.state = 'failed'; }],
      ['delivery', (r) => { delete r.delivery!.commitSha; }],
    ];
    if (combined) for (const kind of ['test', 'build', 'behavior'] as const) corruptions.push([kind, (r) => { for (const evidence of r.evidence.filter((e) => e.kind === kind)) evidence.provenance = 'agent_claim'; }]);
    for (const [kind, corrupt] of corruptions) {
      const changed = structuredClone(completed); corrupt(changed);
      expect(() => assertMissionRecord(changed)).toThrow(/completion gates/);
      changed.status = 'running'; changed.phase = 'delivering'; delete changed.completionReport;
      const criterionId = combined ? 'all-kinds' : kind === 'review' ? 'review-only' : 'delivery-only';
      expect(completionBlockers(changed, { quiescent: true })).toContain(`Criterion ${criterionId} lacks valid ${kind} evidence.`);
      expect(() => reduceMission(changed, { kind: 'host' }, { kind: 'host.complete', quiescent: true })).toThrow(`Criterion ${criterionId} lacks valid ${kind} evidence.`);
      expect(changed.status).toBe('running');
      if (kind === 'delivery') expect(implementationBlockers(changed, { quiescent: true })).toEqual([]);
      else expect(implementationBlockers(changed, { quiescent: true })).toContain(`Criterion ${criterionId} lacks valid ${kind} evidence.`);
    }
  }, 150_000);

  it('does not promote prose, the author, an old-source reviewer or an unsettled review into criterion evidence', async () => {
    const record = await planned(), { author, candidate } = await authored(record);
    const accept = () => tool(record, 'mission_task_accept', { taskId: 'author', attemptId: author.attemptId });
    runtimes.get(record.leadSessionId)!.claim();
    await expect(accept()).rejects.toThrow(/criteria|review/i);
    await expect(tool(record, 'mission_review_submit', { review: { id: 'own-review', candidateId: candidate.id, reviewerAttemptId: author.attemptId,
      sourceRevision: candidate.revision, criterionIds: ['review-only'], findings: [], submittedAt: Date.now() } })).rejects.toThrow(/read-only reviewer/);
    const stale = await reviewer(record);
    expect(await fs.readFile(path.join(sessions.get(stale.sessionId)!.cwd, 'feature.cjs'), 'utf8')).toBe("module.exports = 'original';\n");
    await expect(tool(record, 'mission_review_submit', { review: { id: 'stale-review', candidateId: candidate.id, reviewerAttemptId: stale.attemptId,
      sourceRevision: candidate.revision, criterionIds: ['review-only'], findings: [], submittedAt: Date.now() } }, stale.sessionId)).rejects.toThrow(/bound to the assigned content/);
    await report(record, stale.attemptId); runtimes.get(stale.sessionId)!.finish();
    await wait(() => expect(service.get(record.id)?.attempts.find((a) => a.id === stale.attemptId)?.outcome).toBe('submitted'));
    await wait(() => expect(service.get(record.id)?.candidates.some((c) => c.attemptId === stale.attemptId)).toBe(true));
    expect(service.get(record.id)?.reviews).toEqual([]); expect(service.get(record.id)?.delivery).toBeUndefined();
    await expect(accept()).rejects.toThrow(/criteria|review/i);
    const fresh = await reviewer(record, candidate);
    await tool(record, 'mission_review_submit', { review: { id: 'genuine-review', candidateId: candidate.id, reviewerAttemptId: fresh.attemptId,
      sourceRevision: candidate.revision, criterionIds: ['review-only'], findings: [], submittedAt: Date.now() } }, fresh.sessionId);
    await expect(accept()).rejects.toThrow(/criteria|review/i);
    expect(service.get(record.id)?.tasks.find((t) => t.id === 'author')?.status).toBe('candidate_ready');
    expect(service.get(record.id)?.delivery).toBeUndefined(); expect(delivered).not.toHaveBeenCalled();
    await report(record, fresh.attemptId); runtimes.get(fresh.sessionId)!.finish();
    await wait(() => expect(service.get(record.id)?.candidates.some((c) => c.attemptId === fresh.attemptId)).toBe(true));
    await complete(record, candidate, author.attemptId);
  }, 90_000);
});
