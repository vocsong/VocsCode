/** Real SessionManager, coordinator, admission and Git; only the model process is scripted.
 * Interrupted lead work is retained evidence, never an implicit candidate for the next claim. */
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
import { MissionService } from '../src/main/mission/service';
import { MissionStore, MissionStoreError } from '../src/main/mission/store';
import { assertMissionRecord, type MissionTaskContract } from '../src/main/mission/state';
import { MissionWorkspaces } from '../src/main/mission/workspaces';
import { MissionWorkspaceAdmission } from '../src/main/mission/admission';
import { MissionScheduler } from '../src/main/mission/scheduler';
import { MissionVerification } from '../src/main/mission/verification';
import { localMissionDeliveryPolicy } from '../src/main/mission/delivery';
import type { MissionToolName } from '../src/main/mission/tools';
import { createDefaultMissionConfig } from '../src/shared/mission-config';
import type { MissionRecord } from '../src/shared/mission';
import type { UserInput } from '../src/shared/types';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
const wait = (assertion: () => void) => vi.waitFor(assertion, { timeout: 15_000, interval: 25 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' } }).trim();
let root: string, project: string, data: string, sequence: number;
let service: MissionService, sessions: SessionManager, sessionStore: SessionStore, store: MissionStore<MissionRecord>;
let workspaces: MissionWorkspaces, admission: MissionWorkspaceAdmission, scheduler: MissionScheduler;
let config: ReturnType<typeof createDefaultMissionConfig>;
let runtimes: Map<string, ReturnType<typeof scripted>>;

function scripted(ctx: HarnessContext) {
  const finish = (status: 'completed' | 'interrupted' = 'completed') => {
    ctx.emit({ type: 'item.upsert', item: { id: `turn-${++sequence}`, kind: 'turn', ts: Date.now(), status } });
    ctx.emit({ type: 'status', status: 'idle' });
  };
  return { ctx, finish, adapter: {
    id: 'native', busy: false, start: vi.fn(async () => undefined), missionReadiness: vi.fn(async () => ({ ready: true, tools: ['read', 'write'] })),
    send: vi.fn(async (_input: UserInput) => { ctx.emit({ type: 'status', status: 'running' }); }),
    interrupt: vi.fn(async () => { finish('interrupted'); }), dispose: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined), setEffort: vi.fn(async () => undefined), setPermissionMode: vi.fn(async () => undefined),
  } satisfies HarnessAdapter };
}
function current(r: MissionRecord) { return service.get(r.id)!; }
async function tool(r: MissionRecord, name: MissionToolName, payload: Record<string, unknown>) {
  const idempotencyKey = `tool-${++sequence}`, owner = sessions.get(r.leadSessionId)!.mission!;
  for (let retry = 0; ; retry++) {
    try { return await service.toolHost.invoke({ missionId: r.id, actor: { kind: 'lead', sessionId: r.leadSessionId, generation: owner.generation } }, name,
      { expectedRevision: current(r).revision, idempotencyKey, payload }); }
    catch (error) { if (!(error instanceof MissionStoreError) || error.code !== 'REVISION_CONFLICT' || retry >= 10) throw error; }
  }
}
function task(id = 'feature', ownedPaths = ['feature.txt', 'feature.test.txt']): MissionTaskContract {
  return { id, revision: 1, specificationRevision: 1, objective: `Implement ${id}`, scope: ownedPaths.join(', '), ownedPaths, exclusions: [], dependsOn: [],
    decisionRefs: [], sharedContracts: [], requiredTools: ['read', 'write'], criteria: [], verificationIds: [], assignment: { kind: 'lead' }, required: true };
}
async function start(tasks = [task()]) {
  const r = await service.create({ idempotencyKey: 'launch', projectRoot: project, objective: 'Recover scoped lead work without losing retained bytes', mode: 'autonomous', permissionMode: 'auto' });
  await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  await tool(r, 'mission_plan_update', { expectedPlanRevision: 0, plan: { ...current(r).plan,
    criteria: [{ id: 'outcome', description: 'The feature is verified', required: true, evidenceKinds: ['behavior'] }] }, tasks });
  return current(r);
}
async function claim(r: MissionRecord, taskId = 'feature') {
  const queued = await tool(r, 'mission_task_claim', { taskId }) as { attemptId: string; operationId: string };
  await tool(r, 'mission_yield', { events: ['claim'] }); runtimes.get(r.leadSessionId)!.finish();
  await wait(() => expect(current(r).attempts.find((a) => a.id === queued.attemptId)?.status).toBe('running'));
  await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
  expect(sessions.get(r.leadSessionId)?.mission).toMatchObject({ sourceAccess: 'assigned_workspace', attemptId: queued.attemptId });
  return { ...queued, cwd: sessions.get(r.leadSessionId)!.cwd };
}
async function coordination(r: MissionRecord) {
  await wait(() => expect(sessions.get(r.leadSessionId)?.mission?.sourceAccess).toBe('read_only'));
  await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
}
async function report(r: MissionRecord, attemptId: string) {
  const attempt = current(r).attempts.find((a) => a.id === attemptId)!;
  await tool(r, 'mission_report', { result: { taskId: attempt.taskId, taskRevision: attempt.taskRevision, attemptId, specificationRevision: attempt.specificationRevision,
    status: 'candidate', summary: 'Assigned work is ready for evaluation', artifactIds: [], evidenceIds: [], decisionIds: [], unresolved: [] } });
  runtimes.get(r.leadSessionId)!.finish();
  await wait(() => expect(current(r).candidates.some((c) => c.attemptId === attemptId)).toBe(true));
  await coordination(r);
  return current(r).candidates.find((c) => c.attemptId === attemptId)!;
}
async function preserved(cwd = project) {
  return { head: git(cwd, 'rev-parse', 'HEAD'), index: await fs.readFile(git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index')),
    status: git(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'), feature: await fs.readFile(path.join(cwd, 'feature.txt')) };
}
async function open() {
  const settings = defaultSettings(); settings.providers = [];
  sessionStore = new SessionStore(data); await sessionStore.load();
  sessions = new SessionManager({ store: sessionStore, settings: { get: () => settings } as SettingsStore, runtime: {} as RuntimeResolver,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
    withWorkspaceDispatch: (meta, dispatch) => admission.dispatch(meta.cwd, dispatch) });
  admission = new MissionWorkspaceAdmission({ sessions: () => sessions.list(), activity: (id) => sessions.activity(id), terminals: () => [], released: (cwd) => service?.workspaceAvailable(cwd) });
  store = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord }); await store.load();
  scheduler = new MissionScheduler(config.limits);
  workspaces = new MissionWorkspaces({ root: path.join(root, 'w'), quiescence: admission });
  const verification = new MissionVerification({ scheduler, authorize: async () => { throw new Error('No checks configured in this recovery fixture'); },
    contentIdentity: (cwd) => workspaces.contentIdentity(cwd), saveArtifact: (id, bytes) => store.writeArtifact(id, bytes) });
  service = new MissionService({ store, sessions, workspaces, scheduler, verification, settings: () => ({ config }), assertWorkspaceAvailable: (cwd) => admission.assertAvailable(cwd),
    capabilities: { probe: async (_preset, scope) => {
      const { readiness } = await sessions.prepareManaged(scope.sessionId, scope.generation);
      return { source: 'runtime', runtime: { available: true, authenticated: true }, connectionAvailable: true, modelAvailable: true, projectAllowed: true,
        harnessCapabilities: { interrupt: true }, controlProtocol: readiness.ready, worktreeCwd: true, completionObservation: true, cancellationObservation: true,
        missionTools: readiness.ready, delegationControl: true, tools: readiness.tools };
    } }, delivery: { resolve: async () => ({ ...localMissionDeliveryPolicy(), requireIndependentReview: false }), deliver: async () => { throw new Error('No delivery is requested in this recovery fixture'); } } });
}
async function close() { await service.close(); await sessions.stopAll(); await sessions.flushPendingPersists(); admission.close(); }
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mlr-')); project = path.join(root, 'p'); data = path.join(root, 'd'); sequence = 0; runtimes = new Map();
  await fs.mkdir(project); git(project, 'init', '-b', 'main');
  for (const [key, value] of [['user.name', 'Lead Recovery Fixture'], ['user.email', 'lead-recovery@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(project, 'config', key, value);
  await fs.writeFile(path.join(project, 'feature.txt'), 'original\n'); git(project, 'add', '.'); git(project, 'commit', '-m', 'Lead recovery baseline');
  config = createDefaultMissionConfig();
  const lead = { id: 'frontier', name: 'Principal', revision: 1, harnessId: 'native' as const, model: { provider: 'fixture', model: 'frontier' }, reasoning: { kind: 'default' as const }, enabled: true };
  config.presets = [lead]; config.tiers[4].presetIds = ['frontier']; config.defaultLeadPresetId = 'frontier';
  vi.mocked(createAdapter).mockReset().mockImplementation((_harness, ctx) => { const runtime = scripted(ctx); runtimes.set(ctx.sessionId, runtime); return runtime.adapter; });
  await open();
});
afterEach(async () => { await close(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

describe('lead attempt workspace recovery', () => {
  it('settles a failed lead provision intent before another explicit resume and claim', async () => {
    const r = await start(), original = await preserved();
    const first = await claim(r);
    await fs.writeFile(path.join(first.cwd, 'feature.txt'), 'retained unfinished work\n');
    const retained = await preserved(first.cwd);
    await service.control({ missionId: r.id, expectedRevision: current(r).revision, idempotencyKey: 'pause-first', control: { action: 'pause' } });
    await service.control({ missionId: r.id, expectedRevision: current(r).revision, idempotencyKey: 'resume-first', control: { action: 'resume' } });
    await coordination(r);
    const provision = vi.spyOn(workspaces, 'provision').mockRejectedValueOnce(new Error('Temporary workspace provisioning failure'));
    const failed = await tool(r, 'mission_task_claim', { taskId: 'feature' }) as { operationId: string };
    await tool(r, 'mission_yield', { events: ['claim'] }); runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(current(r).operations.find((op) => op.id === failed.operationId)).toMatchObject({ state: 'failed', error: expect.stringContaining('Temporary workspace provisioning failure') }));
    await wait(() => expect(current(r).status).toBe('blocked'));
    expect(current(r).attempts).toHaveLength(1); expect(current(r).candidates).toEqual([]);
    expect(sessions.activity(r.leadSessionId)).toMatchObject({ active: false, quiescent: true });
    expect(scheduler.snapshot().active).toEqual([]);
    provision.mockRestore();
    await service.control({ missionId: r.id, expectedRevision: current(r).revision, idempotencyKey: 'pause-retry', control: { action: 'pause' } });
    await service.control({ missionId: r.id, expectedRevision: current(r).revision, idempotencyKey: 'resume-retry', control: { action: 'resume' } });
    await coordination(r);
    const next = await claim(r);
    expect(next.cwd).not.toBe(first.cwd); expect(current(r).attempts).toHaveLength(2);
    expect(current(r).operations.find((op) => op.id === failed.operationId)?.state).toBe('failed');
    expect(current(r).candidates).toEqual([]); expect(current(r).delivery).toBeUndefined();
    expect(await preserved(first.cwd)).toEqual(retained); expect(await preserved()).toEqual(original);
  }, 60_000);

  it.each([false, true])('resumes uncaptured lead work in a fresh attempt without adoption or data loss (restart: %s)', async (restart) => {
    const r = await start(), original = await preserved(), planning = structuredClone(sessions.get(r.leadSessionId)!);
    const first = await claim(r), writer = runtimes.get(r.leadSessionId)!;
    await fs.writeFile(path.join(first.cwd, 'feature.txt'), 'staged partial core\n'); git(first.cwd, 'add', 'feature.txt');
    await fs.writeFile(path.join(first.cwd, 'feature.txt'), 'unfinished core\n');
    await fs.writeFile(path.join(first.cwd, 'feature.test.txt'), 'unfinished tests\n');
    const retained = await preserved(first.cwd);
    await service.control({ missionId: r.id, expectedRevision: current(r).revision, idempotencyKey: 'pause', control: { action: 'pause' } });
    expect(current(r)).toMatchObject({ status: 'paused', candidates: [], attempts: [{ id: first.attemptId, status: 'terminal', outcome: 'interrupted' }] });
    expect(current(r).attempts[0].result).toBeUndefined(); expect(service.isQuiescent(current(r))).toBe(true);
    expect(sessions.activity(r.leadSessionId)).toMatchObject({ active: false, quiescent: true });
    expect(writer.adapter.interrupt).toHaveBeenCalledTimes(1); expect(writer.adapter.dispose).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot().active).toEqual([]); expect(scheduler.snapshot().queued).toEqual([]);
    if (restart) {
      await close();
      // A stale session index cannot choose the first retained lead tree over the journal's last attempt.
      await sessionStore.upsert({ ...planning, status: 'stopped' });
      await open(); await service.load();
      expect(current(r).status).toBe('paused'); expect(current(r).candidates).toEqual([]);
    }
    await service.control({ missionId: r.id, expectedRevision: current(r).revision, idempotencyKey: 'resume', control: { action: 'resume' } });
    await coordination(r);
    expect(sessions.get(r.leadSessionId)?.cwd).toBe(first.cwd);
    expect(sessions.get(r.leadSessionId)?.config.permissionMode).toBe('plan');
    const read = await tool(r, 'mission_read', {}) as MissionRecord;
    expect(read.workspaces.find((w) => w.id === read.attempts[0].workspaceId)?.path).toBe(first.cwd);
    const next = await claim(r);
    expect(next.cwd).not.toBe(first.cwd);
    const attempt = current(r).attempts.find((a) => a.id === next.attemptId)!;
    const fresh = await workspaces.workspace(attempt.workspaceId);
    expect(fresh).toMatchObject({ cwd: next.cwd, attemptId: next.attemptId, baseRevision: r.acceptedRevision });
    expect(sessions.get(r.leadSessionId)?.worktreeBranch).toBe(fresh.branch);
    expect(sessions.get(r.leadSessionId)?.config.permissionMode).toBe('auto');
    expect(await fs.readFile(path.join(next.cwd, 'feature.txt'), 'utf8')).toBe('original\n');
    expect(await fs.readdir(next.cwd)).not.toContain('feature.test.txt');
    await fs.writeFile(path.join(next.cwd, 'feature.txt'), 'deliberate repair\n');
    expect(current(r).attempts.map((a) => [a.id, a.status, a.outcome])).toEqual([[first.attemptId, 'terminal', 'interrupted'], [next.attemptId, 'running', undefined]]);
    expect(current(r).candidates).toEqual([]); expect(await workspaces.candidatesForAttempt(r.id, first.attemptId)).toEqual([]);
    expect(current(r).operations.filter((op) => op.kind === 'capture')).toEqual([]);
    expect(current(r).delivery).toBeUndefined(); expect(current(r).status).toBe('running');
    expect(await workspaces.acceptedRevision(r.id)).toEqual(r.acceptedRevision);
    expect(await preserved(first.cwd)).toEqual(retained);
    expect(await fs.readFile(path.join(first.cwd, 'feature.test.txt'), 'utf8')).toBe('unfinished tests\n');
    expect(await preserved()).toEqual(original);
  }, 60_000);

  it('starts successive claims from advanced accepted content while retaining uncaptured edits and enforcing the full new diff', async () => {
    const r = await start([task(), task('second', ['second.txt'])]), original = await preserved();
    const first = await claim(r);
    await fs.writeFile(path.join(first.cwd, 'feature.txt'), 'accepted implementation\n');
    const candidate = await report(r, first.attemptId);
    await tool(r, 'mission_task_accept', { taskId: 'feature', attemptId: first.attemptId });
    const integration = await tool(r, 'mission_integration_request', { candidateId: candidate.id, expectedContentHash: r.acceptedRevision!.contentHash }) as { operationId: string };
    await tool(r, 'mission_yield', { events: ['integration'] }); runtimes.get(r.leadSessionId)!.finish();
    await wait(() => expect(current(r).operations.find((op) => op.id === integration.operationId)?.state).toBe('succeeded'));
    await coordination(r);
    expect(current(r).acceptedRevision).toEqual(candidate.revision);
    await fs.writeFile(path.join(first.cwd, 'feature.txt'), 'later unknown edits\n');
    await fs.writeFile(path.join(first.cwd, 'retained.txt'), 'not a candidate\n');
    const retained = await preserved(first.cwd), firstReceipt = await workspaces.candidate(candidate.id);
    const second = await claim(r, 'second');
    expect(second.cwd).not.toBe(first.cwd);
    expect(await fs.readFile(path.join(second.cwd, 'feature.txt'), 'utf8')).toBe('accepted implementation\n');
    expect(await fs.readdir(second.cwd)).not.toContain('retained.txt');
    expect(current(r).attempts[1].sourceRevision).toEqual(candidate.revision);
    await fs.writeFile(path.join(second.cwd, 'second.txt'), 'new scoped work\n');
    await fs.writeFile(path.join(second.cwd, 'undeclared.txt'), 'must not be filtered\n');
    const secondCandidate = await report(r, second.attemptId);
    expect(secondCandidate.changedPaths).toEqual(['second.txt', 'undeclared.txt']);
    await expect(tool(r, 'mission_task_accept', { taskId: 'second', attemptId: second.attemptId })).rejects.toThrow(/scope/i);
    expect(current(r).candidates).toHaveLength(2); expect(current(r).delivery).toBeUndefined();
    expect(current(r).tasks.map((t) => t.status)).toEqual(['integrated', 'candidate_ready']);
    expect(await workspaces.acceptedRevision(r.id)).toEqual(candidate.revision);
    expect(await workspaces.candidate(candidate.id)).toEqual(firstReceipt);
    expect(await preserved(first.cwd)).toEqual(retained);
    expect(await fs.readFile(path.join(first.cwd, 'retained.txt'), 'utf8')).toBe('not a candidate\n');
    expect(await preserved()).toEqual(original);
  }, 60_000);
});
