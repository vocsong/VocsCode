/** R13: real coordinator, stores, SessionManager and Git capture/CAS; only model IO is scripted. */
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
import { MissionScheduler } from '../src/main/mission/scheduler';
import { MissionVerification } from '../src/main/mission/verification';
import { localMissionDeliveryPolicy } from '../src/main/mission/delivery';
import type { MissionToolName } from '../src/main/mission/tools';
import { createDefaultMissionConfig } from '../src/shared/mission-config';
import type { MissionProfile, MissionRecord } from '../src/shared/mission';
import type { UserInput } from '../src/shared/types';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
const wait = (assertion: () => void) => vi.waitFor(assertion, { timeout: 15_000, interval: 25 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' } }).trim();
let root: string, project: string, sequence: number;
let service: MissionService, sessions: SessionManager, sessionStore: SessionStore, store: MissionStore<MissionRecord>, workspaces: MissionWorkspaces;
let runtimes: Map<string, ReturnType<typeof scripted>>;
function scripted(ctx: HarnessContext) {
  return { adapter: {
    id: 'native', busy: false, start: vi.fn(async () => undefined), missionReadiness: vi.fn(async () => ({ ready: true, tools: ['read', 'write'] })),
    send: vi.fn(async (_input: UserInput) => { ctx.emit({ type: 'status', status: 'running' }); }), interrupt: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined), setEffort: vi.fn(async () => undefined), setPermissionMode: vi.fn(async () => undefined), compact: vi.fn(async () => true),
  } satisfies HarnessAdapter,
  finish: () => { ctx.emit({ type: 'item.upsert', item: { id: `turn-${++sequence}`, kind: 'turn', ts: Date.now(), status: 'completed' } }); ctx.emit({ type: 'status', status: 'idle' }); } };
}
function current(r: MissionRecord) { return service.get(r.id)!; }
async function tool(r: MissionRecord, name: MissionToolName, payload: Record<string, unknown>, sessionId = r.leadSessionId) {
  const idempotencyKey = `tool-${++sequence}`, owner = sessions.get(sessionId)!.mission!;
  const binding = { missionId: r.id, actor: owner.role === 'lead' ? { kind: 'lead' as const, sessionId, generation: owner.generation }
    : { kind: 'worker' as const, sessionId, generation: owner.generation, attemptId: owner.attemptId! } };
  for (let retry = 0; ; retry++) {
    try { return await service.toolHost.invoke(binding, name, { expectedRevision: current(r).revision, idempotencyKey, payload }); }
    catch (error) { if (!(error instanceof MissionStoreError) || error.code !== 'REVISION_CONFLICT' || retry >= 10) throw error; }
  }
}
async function start(options: { ownedPaths?: string[]; exclusions?: string[]; planExclusions?: string[]; readOnly?: boolean } = {}) {
  const r = await service.create({ idempotencyKey: 'launch', projectRoot: project, objective: 'Implement only the assigned feature', mode: 'autonomous', permissionMode: 'auto' });
  await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  const profile: MissionProfile = { id: 'specialist', revision: 1, name: 'Specialist', purpose: 'Work within the feature contract', instructions: 'Only change owned files', tierId: 3,
    contextRefs: [], requestedTools: options.readOnly ? ['read'] : ['read', 'write'], sourceAccess: options.readOnly ? 'read_only' : 'assigned_workspace', resultExpectations: 'Structured result' };
  const task: MissionTaskContract = { id: 'feature', revision: 1, specificationRevision: 1, objective: 'Implement the feature', scope: 'Owned feature only', ownedPaths: options.ownedPaths ?? ['owned/**'], exclusions: options.exclusions ?? [],
    dependsOn: [], decisionRefs: [], sharedContracts: [], requiredTools: profile.requestedTools, criteria: [], verificationIds: [], assignment: { kind: 'worker', profileId: profile.id, profileRevision: 1 }, required: true };
  await tool(r, 'mission_profile_upsert', { profile });
  await tool(r, 'mission_plan_update', { expectedPlanRevision: 0, plan: { ...current(r).plan, exclusions: options.planExclusions ?? [],
    criteria: [{ id: 'outcome', description: 'Feature stays in its contract', required: true, evidenceKinds: ['behavior'] }] }, tasks: [task] });
  await tool(r, 'mission_phase_set', { phase: 'executing' });
  const assigned = await tool(r, 'mission_task_delegate', { taskId: task.id, presetId: 'standard', reason: 'Bounded implementation' }) as { attemptId: string; sessionId: string };
  await wait(() => expect(runtimes.get(assigned.sessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  return { r, ...assigned, cwd: sessions.get(assigned.sessionId)!.cwd };
}
async function report({ r, attemptId, sessionId }: Awaited<ReturnType<typeof start>>) {
  await tool(r, 'mission_report', { result: { taskId: 'feature', taskRevision: 1, attemptId, specificationRevision: 1, status: 'candidate',
    summary: 'Changed only owned/feature.txt; no other files were changed.', artifactIds: [], evidenceIds: [], decisionIds: [], unresolved: [] } }, sessionId);
  runtimes.get(sessionId)!.finish();
  await wait(() => expect(current(r).candidates).toHaveLength(1));
  await wait(() => expect(current(r).operations.filter((o) => o.kind === 'capture').map((o) => o.state)).toEqual(['succeeded']));
  return current(r).candidates[0];
}
async function integrate(r: MissionRecord) {
  const candidate = current(r).candidates[0];
  const op = await tool(r, 'mission_integration_request', { candidateId: candidate.id, expectedContentHash: current(r).acceptedRevision!.contentHash }) as { operationId: string };
  await tool(r, 'mission_yield', { events: ['integration'] }); runtimes.get(r.leadSessionId)!.finish();
  await wait(() => expect(['succeeded', 'failed']).toContain(current(r).operations.find((o) => o.id === op.operationId)?.state));
  return current(r).operations.find((o) => o.id === op.operationId)!;
}
async function preserved() {
  return { head: git(project, 'rev-parse', 'HEAD'), index: await fs.readFile(git(project, 'rev-parse', '--path-format=absolute', '--git-path', 'index')),
    status: git(project, 'status', '--porcelain=v1', '-z', '--untracked-files=all'), owned: await fs.readFile(path.join(project, 'owned/feature.txt')), outside: await fs.readFile(path.join(project, 'outside.txt')) };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-')); project = path.join(root, 'p'); sequence = 0; runtimes = new Map();
  await fs.mkdir(path.join(project, 'owned'), { recursive: true }); git(project, 'init', '-b', 'main');
  for (const [key, value] of [['user.name', 'Scope Fixture'], ['user.email', 'scope@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(project, 'config', key, value);
  await fs.writeFile(path.join(project, 'owned/feature.txt'), 'original\n'); await fs.writeFile(path.join(project, 'outside.txt'), 'outside\n'); git(project, 'add', '.'); git(project, 'commit', '-m', 'Scope fixture baseline');
  const config = createDefaultMissionConfig(), lead = { id: 'frontier', name: 'Principal', revision: 1, harnessId: 'native' as const, model: { provider: 'fixture', model: 'frontier' }, reasoning: { kind: 'default' as const }, enabled: true };
  config.presets = [lead, { ...lead, id: 'standard', name: 'Specialist', model: { provider: 'fixture', model: 'standard' } }]; config.tiers[4].presetIds = ['frontier']; config.tiers[2].presetIds = ['standard']; config.defaultLeadPresetId = 'frontier';
  const settings = defaultSettings(); settings.providers = [];
  sessionStore = new SessionStore(path.join(root, 'd')); await sessionStore.load();
  sessions = new SessionManager({ store: sessionStore, settings: { get: () => settings } as SettingsStore, runtime: {} as RuntimeResolver,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn() });
  store = new MissionStore<MissionRecord>(path.join(root, 'd'), { validate: assertMissionRecord }); await store.load();
  const scheduler = new MissionScheduler(config.limits), held = new Set<string>();
  workspaces = new MissionWorkspaces({ root: path.join(root, 'w'), quiescence: { acquire: async (cwd) => {
    const quiet = () => !sessions.list().some((s) => path.resolve(s.cwd) === path.resolve(cwd) && !sessions.activity(s.id).quiescent);
    if (held.has(cwd) || !quiet()) return null; held.add(cwd);
    return { assertQuiescent: async () => { if (!held.has(cwd) || !quiet()) throw new Error('Lease lost'); }, release: () => { held.delete(cwd); } };
  } } });
  const verification = new MissionVerification({ scheduler, authorize: async () => { throw new Error('No checks configured in this scope fixture'); }, contentIdentity: (cwd) => workspaces.contentIdentity(cwd), saveArtifact: (id, bytes) => store.writeArtifact(id, bytes) });
  vi.mocked(createAdapter).mockImplementation((_harness, ctx) => { const runtime = scripted(ctx); runtimes.set(ctx.sessionId, runtime); return runtime.adapter; });
  service = new MissionService({ store, sessions, workspaces, scheduler, verification, settings: () => ({ config }), capabilities: { probe: async (_preset, scope) => {
    const { readiness } = await sessions.prepareManaged(scope.sessionId, scope.generation);
    return { source: 'runtime', runtime: { available: true, authenticated: true }, connectionAvailable: true, modelAvailable: true, projectAllowed: true,
      harnessCapabilities: { interrupt: true }, controlProtocol: readiness.ready, worktreeCwd: true, completionObservation: true, cancellationObservation: true, missionTools: readiness.ready, delegationControl: true, tools: readiness.tools };
  } }, delivery: { resolve: async () => ({ ...localMissionDeliveryPolicy(), requireIndependentReview: false }), deliver: async () => { throw new Error('Not a delivery fixture'); } } });
});
afterEach(async () => { await service.close(); await sessions.stopAll(); await sessions.flushPendingPersists(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

describe('host-captured scope through the real Git service boundary', () => {
  it.each(['edit', 'delete', 'rename-in', 'rename-out', 'add'] as const)('refuses an omitted out-of-scope %s at acceptance and before Git promotion, retaining the complete candidate', async (action) => {
    const worker = await start(), { r, cwd, attemptId } = worker, before = await preserved();
    await fs.writeFile(path.join(cwd, 'owned/feature.txt'), 'implemented\n');
    if (action === 'edit') await fs.writeFile(path.join(cwd, 'outside.txt'), 'undeclared edit\n');
    if (action === 'delete') await fs.unlink(path.join(cwd, 'outside.txt'));
    if (action === 'rename-in') await fs.rename(path.join(cwd, 'outside.txt'), path.join(cwd, 'owned/moved.txt'));
    if (action === 'rename-out') await fs.rename(path.join(cwd, 'owned/feature.txt'), path.join(cwd, 'escaped.txt'));
    if (action === 'add') await fs.writeFile(path.join(cwd, 'undeclared.txt'), 'untracked addition\n');
    const candidate = await report(worker);
    const expected = action === 'rename-in' ? ['outside.txt', 'owned/feature.txt', 'owned/moved.txt'] : action === 'rename-out' ? ['escaped.txt', 'owned/feature.txt'] : action === 'add' ? ['owned/feature.txt', 'undeclared.txt'] : ['outside.txt', 'owned/feature.txt'];
    expect(candidate.changedPaths).toEqual(expected);
    expect(current(r).attempts[0].result?.summary).toBe('Changed only owned/feature.txt; no other files were changed.');
    await expect(tool(r, 'mission_task_accept', { taskId: 'feature', attemptId })).rejects.toThrow(/scope/i);
    expect(current(r).tasks[0].status).toBe('candidate_ready'); expect(current(r).candidates).toEqual([candidate]);
    // Fixture for a pre-enforcement journal: promotion cannot trust an older accepted status.
    await store.transact(r.id, { idempotencyKey: 'legacy-accepted', actor: 'fixture', expectedRevision: current(r).revision, kind: 'fixture.legacy' }, (state) => { state.tasks[0].status = 'accepted'; });
    expect(await integrate(r)).toMatchObject({ state: 'failed', error: expect.stringMatching(/scope/i) });
    expect(current(r).tasks[0].status).toBe('accepted'); expect(current(r).candidates).toEqual([candidate]);
    expect(current(r).acceptedRevision).toEqual(r.acceptedRevision); expect(await workspaces.acceptedRevision(r.id)).toEqual(r.acceptedRevision);
    expect(git(project, 'for-each-ref', '--format=%(refname)', 'refs/vocs-missions').split('\n').filter((ref) => ref.includes('/candidate-promotions/'))).toEqual([]);
    expect(await preserved()).toEqual(before);
  }, 45_000);

  it.each(['task-exclusion', 'plan-exclusion', 'no-ownership'] as const)('rejects actual writes under %s even when the result claims only owned work', async (kind) => {
    const worker = await start(kind === 'no-ownership' ? { ownedPaths: [] } : kind === 'task-exclusion' ? { exclusions: ['owned/feature.txt'] } : { planExclusions: ['owned/**'] });
    const before = await preserved(); await fs.writeFile(path.join(worker.cwd, 'owned/feature.txt'), 'excluded\n');
    const candidate = await report(worker); expect(candidate.changedPaths).toEqual(['owned/feature.txt']);
    await expect(tool(worker.r, 'mission_task_accept', { taskId: 'feature', attemptId: worker.attemptId })).rejects.toThrow(/scope/i);
    expect(current(worker.r).tasks[0].status).toBe('candidate_ready'); expect(await workspaces.acceptedRevision(worker.r.id)).toEqual(worker.r.acceptedRevision); expect(await preserved()).toEqual(before);
  }, 30_000);

  it('accepts and integrates the complete valid scoped diff without filtering edits, additions or deletions', async () => {
    const worker = await start({ exclusions: ['Do not add runtime dependencies'] }), { r, cwd } = worker, before = await preserved();
    await fs.rename(path.join(cwd, 'owned/feature.txt'), path.join(cwd, 'owned/renamed.txt'));
    await fs.writeFile(path.join(cwd, 'owned/renamed.txt'), 'implemented\n'); await fs.writeFile(path.join(cwd, 'owned/added.txt'), 'new behavior\n');
    const candidate = await report(worker); expect(candidate.changedPaths).toEqual(['owned/added.txt', 'owned/feature.txt', 'owned/renamed.txt']);
    await tool(r, 'mission_task_accept', { taskId: 'feature', attemptId: worker.attemptId }); expect(current(r).tasks[0].status).toBe('accepted');
    expect(await integrate(r)).toMatchObject({ state: 'succeeded' }); expect(current(r).tasks[0].status).toBe('integrated');
    expect(current(r).candidates[0].integratedRevision).toEqual(candidate.revision); expect(await workspaces.acceptedRevision(r.id)).toEqual(candidate.revision);
    expect(git(project, 'ls-tree', '-r', '--name-only', candidate.revision.contentHash)).toBe('outside.txt\nowned/added.txt\nowned/renamed.txt');
    expect(git(project, 'show', `${candidate.revision.contentHash}:owned/renamed.txt`)).toBe('implemented'); expect(await preserved()).toEqual(before);
  }, 45_000);

  it('accepts a read-only scout with empty ownership and an empty host-captured delta', async () => {
    const worker = await start({ readOnly: true, ownedPaths: [] }), before = await preserved();
    expect(sessions.get(worker.sessionId)?.mission?.sourceAccess).toBe('read_only');
    const candidate = await report(worker); expect(candidate.changedPaths).toEqual([]); expect(candidate.revision).toEqual(worker.r.acceptedRevision);
    await tool(worker.r, 'mission_task_accept', { taskId: 'feature', attemptId: worker.attemptId });
    expect(current(worker.r).tasks[0].status).toBe('accepted'); expect(current(worker.r).blockers).toEqual([]); expect(await preserved()).toEqual(before);
  }, 30_000);
});
