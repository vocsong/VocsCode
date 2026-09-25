/** Production receipt wiring: real coordinator operations, Git CAS, checks and local delivery.
 * Only Pi's model/process boundary is scripted; its truthful not-started ownership is separate
 * from integration/delivery proof. Recovery must never execute the lost operation again. */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as commands from '../src/main/runtime';
import { MissionRuntime } from '../src/main/mission/runtime';
import { MissionStore, MissionStoreError } from '../src/main/mission/store';
import { assertMissionRecord } from '../src/main/mission/state';
import { MissionDeliveryService } from '../src/main/mission/delivery';
import { MissionWorkspaces } from '../src/main/mission/workspaces';
import { MissionVerification } from '../src/main/mission/verification';
import { checkOwnershipDirectory, processOwnershipIntents } from '../src/main/mission/process-ownership';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { createAdapter } from '../src/main/harness/registry';
import { createManagedPiOwnershipIntent, recordUnlaunchedManagedPiIntent } from '../src/main/harness/pi-ownership';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { TerminalManager } from '../src/main/terminal';
import type { MissionDeliveryPolicy, MissionRecord } from '../src/shared/mission';
import type { MissionToolName } from '../src/main/mission/tools';
import { missionFixture } from './support/mission-fixture';
import { fixtureGitHubRemote, fixtureGitHubRepo, fixtureGitHubTransport, fixturePr } from './support/mission-github-fixture';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
let root: string, project: string, data: string, crash: string;
let runtime: MissionRuntime, sessions: SessionManager, settings: ReturnType<typeof defaultSettings>;
let contexts: Map<string, HarnessContext>, sends: number, sequence: number;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const wait = (assertion: () => void) => vi.waitFor(assertion, { timeout: 30_000, interval: 25 });
const current = (id: string) => runtime.service.get(id)!;
const operation = (id: string, opId: string) => current(id).operations.find((op) => op.id === opId)!;

async function compose() {
  const store = new SessionStore(data); await store.load();
  sessions = new SessionManager({ store, settings: { get: () => settings } as SettingsStore, runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as never,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
    withWorkspaceDispatch: (meta, dispatch) => runtime.admission.dispatch(meta.cwd, dispatch) });
  runtime = new MissionRuntime({ userData: data, sessions, settings: { get: () => settings, onChange: () => () => undefined },
    windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'), changed: vi.fn(), log: vi.fn(),
    terminals: { activity: () => [], closeManagedSession: async () => undefined, reconcileOwnership: async () => undefined } as unknown as TerminalManager });
}
async function tool(id: string, name: MissionToolName, payload: Record<string, unknown>) {
  const idempotencyKey = `tool-${++sequence}`;
  for (let retry = 0; ; retry++) {
    const record = current(id);
    try { return await runtime.service.invoke({ missionId: id, actor: { kind: 'lead', sessionId: record.leadSessionId, generation: record.leadGeneration } }, name,
      { expectedRevision: record.revision, idempotencyKey, payload }); }
    catch (error) { if (!(error instanceof MissionStoreError) || error.code !== 'REVISION_CONFLICT' || retry >= 10) throw error; }
  }
}
function finish(id: string) {
  const ctx = contexts.get(current(id).leadSessionId)!;
  ctx.emit({ type: 'item.upsert', item: { id: `turn-${++sequence}`, kind: 'turn', ts: Date.now(), status: 'completed' } });
  ctx.emit({ type: 'status', status: 'idle' });
}
async function start(kind: 'candidate' | 'target' = 'candidate', value = 'candidate', checkValue = value, publication?: Partial<MissionDeliveryPolicy>) {
  let targetHead: string | undefined;
  if (kind === 'target') {
    const remote = path.join(root, 'remote.git'), upstream = path.join(root, 'upstream');
    git(root, 'init', '--bare', '--initial-branch=main', remote); git(project, 'remote', 'add', 'origin', remote); git(project, 'push', 'origin', 'main');
    git(root, 'clone', remote, upstream); git(upstream, 'config', 'user.name', 'Recovery Fixture'); git(upstream, 'config', 'user.email', 'recovery@example.invalid'); git(upstream, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(upstream, 'remote.txt'), 'target'); git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'Target fixture'); git(upstream, 'push', 'origin', 'main');
    targetHead = git(upstream, 'rev-parse', 'HEAD');
  }
  await fs.mkdir(path.join(project, '.vocs-code'));
  await fs.writeFile(path.join(project, '.vocs-code', 'mission-delivery.json'), JSON.stringify({ version: 1,
    endpoint: kind === 'target' ? 'open_pr' : 'local_commit', requireIndependentReview: false,
    ...(kind === 'target' ? { remote: 'origin', targetBranch: 'main', allowPush: true, allowMerge: false } : {}), ...publication, checks: [] }));
  git(project, 'add', '.'); git(project, 'commit', '-m', 'Delivery policy fixture');
  if (publication) git(project, 'push', path.join(root, 'remote.git'), 'main');
  const record = await runtime.service.create({ idempotencyKey: 'receipt', projectRoot: project, objective: 'Recover exact completed receipts', mode: 'autonomous', permissionMode: 'full-auto' });
  await wait(() => expect(sends).toBe(1));
  const check = { id: 'behavior', name: 'Actual combined content', kind: 'behavior', command: `node -e "require('node:assert').equal(require('node:fs').readFileSync('${kind === 'target' ? 'remote.txt' : 'a.txt'}','utf8').trim(),'${kind === 'target' ? 'target' : checkValue}')"`, criterionIds: ['outcome'], required: true, heavy: false, timeoutMs: 10_000 };
  await tool(record.id, 'mission_plan_update', { expectedPlanRevision: current(record.id).planRevision,
    plan: { ...current(record.id).plan, criteria: [{ id: 'outcome', description: 'The actual content is checked', required: true, evidenceKinds: ['behavior'] }] }, checks: [check],
    tasks: kind === 'target' ? [] : [{ id: 'task', revision: 1, specificationRevision: 1, objective: 'Change a.txt', scope: 'a.txt', ownedPaths: ['a.txt'], exclusions: [], dependsOn: [], decisionRefs: [], sharedContracts: [], requiredTools: ['write'], criteria: [], verificationIds: [], assignment: { kind: 'lead' }, required: true }] });
  await tool(record.id, 'mission_phase_set', { phase: 'executing' });
  if (kind === 'candidate') {
    const claimed = await tool(record.id, 'mission_task_claim', { taskId: 'task' }) as { attemptId: string };
    finish(record.id); await wait(() => expect(sends).toBe(2));
    await fs.writeFile(path.join(sessions.get(record.leadSessionId)!.cwd, 'a.txt'), `${value}\n`);
    await tool(record.id, 'mission_report', { result: { taskId: 'task', taskRevision: 1, specificationRevision: 1, attemptId: claimed.attemptId, status: 'candidate', summary: 'Captured requested change', artifactIds: [], evidenceIds: [], decisionIds: [], unresolved: [] } });
    finish(record.id); await wait(() => expect(sends).toBe(3));
    await wait(() => expect(current(record.id).candidates).toHaveLength(1));
    await tool(record.id, 'mission_task_accept', { taskId: 'task', attemptId: claimed.attemptId });
  }
  return { id: record.id, targetHead, before: structuredClone(current(record.id)) };
}
async function requestIntegration(id: string, kind: 'candidate' | 'target') {
  return await tool(id, 'mission_integration_request', { ...(kind === 'target' ? { target: 'approved' } : { candidateId: current(id).candidates[0].id }), expectedContentHash: current(id).acceptedRevision!.contentHash }) as { operationId: string };
}
async function snapshot() { await fs.cp(path.join(data, 'missions'), path.join(crash, 'missions'), { recursive: true }); }
async function mutateSnapshot(apply: (record: MissionRecord) => void) {
  const store = new MissionStore<MissionRecord>(crash, { validate: assertMissionRecord }); await store.load();
  const record = store.list()[0];
  await store.transact(record.id, { idempotencyKey: 'fixture-mutation', actor: 'host', kind: 'fixture.mutation', expectedRevision: record.revision }, (state) => { apply(state); return state; });
}
async function restartFromCrash() {
  await runtime.close(); await sessions.stopAll(); await sessions.flushPendingPersists();
  await fs.rm(path.join(data, 'missions'), { recursive: true, force: true });
  await fs.cp(path.join(crash, 'missions'), path.join(data, 'missions'), { recursive: true });
  await compose();
  const starts = vi.mocked(createAdapter).mock.calls.length, sent = sends;
  const check = vi.spyOn(MissionVerification.prototype, 'run');
  const deliver = vi.spyOn(MissionDeliveryService.prototype, 'deliver');
  const candidate = vi.spyOn(MissionWorkspaces.prototype, 'integrate');
  const target = vi.spyOn(MissionWorkspaces.prototype, 'integrateObservedTarget');
  const transport = vi.isMockFunction(commands.runCapture) ? vi.mocked(commands.runCapture).getMockImplementation() : undefined;
  const original = transport ?? commands.runCapture, effects: string[][] = [];
  const capture = vi.spyOn(commands, 'runCapture').mockImplementation(async (file, args, options) => {
    if (args.some((arg) => ['apply', 'update-ref', 'commit-tree', 'fetch', 'push', 'checkout-index', 'read-tree'].includes(arg)) || args.includes('worktree') && args.includes('add')) effects.push(args);
    return original(file, args, options);
  });
  try {
    await runtime.load();
    expect(check).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled(); expect(candidate).not.toHaveBeenCalled(); expect(target).not.toHaveBeenCalled(); expect(effects).toEqual([]);
    expect(createAdapter).toHaveBeenCalledTimes(starts); expect(sends).toBe(sent);
  } finally {
    check.mockRestore(); deliver.mockRestore(); candidate.mockRestore(); target.mockRestore();
    if (transport) capture.mockImplementation(transport); else capture.mockRestore();
  }
}
function loseGit(when: 'before' | 'after') {
  const original = commands.runCapture; let lost = false;
  const spy = vi.spyOn(commands, 'runCapture').mockImplementation(async (file, args, options) => {
    if (lost || !args.includes('update-ref') || !args.includes('--stdin')) return original(file, args, options);
    lost = true;
    if (when === 'after') expect((await original(file, args, options)).code).toBe(0);
    await snapshot(); throw new Error(`Lost ${when} Git promotion acknowledgment`);
  });
  return () => { spy.mockRestore(); expect(lost).toBe(true); };
}
function loseJournal(opId: string, suffix: 'promotion' | 'receipt', when: 'before' | 'after') {
  const transact = runtime.store.transact.bind(runtime.store); let lost = false;
  const spy = vi.spyOn(runtime.store, 'transact').mockImplementation(async (id, metadata, apply) => {
    if (lost || metadata.kind !== `${opId}-${suffix}`) return transact(id, metadata, apply);
    lost = true;
    if (when === 'after') await transact(id, metadata, apply);
    await snapshot(); throw new Error(`Lost ${when} journal acknowledgment`);
  });
  return () => { spy.mockRestore(); expect(lost).toBe(true); };
}
async function failIntegration(id: string, kind: 'candidate' | 'target', boundary: 'git' | 'journal', when: 'before' | 'after') {
  const { operationId } = await requestIntegration(id, kind);
  const restore = boundary === 'git' ? loseGit(when) : loseJournal(operationId, 'promotion', when);
  await tool(id, 'mission_yield', { events: ['integration'] }); finish(id);
  await wait(() => expect(operation(id, operationId)?.state).toBe('failed')); restore();
  expect(current(id).evidence).toEqual([expect.objectContaining({ result: 'passed', provenance: 'host_executed', exitCode: 0 })]);
  return operationId;
}
async function failDelivery(when: 'before' | 'after') {
  const { id } = await start();
  const integrated = await requestIntegration(id, 'candidate'); await tool(id, 'mission_yield', { events: ['integration'] }); finish(id);
  await wait(() => expect(operation(id, integrated.operationId)?.state).toBe('succeeded'));
  await wait(() => expect(sessions.activity(current(id).leadSessionId).turn).toBe(true));
  const request = await tool(id, 'mission_finish_request', { commitMessage: 'feat: Recover completed receipt' }) as { operationId: string };
  const restore = loseJournal(request.operationId, 'receipt', when); finish(id);
  await wait(() => expect(operation(id, request.operationId)?.state).toBe('failed')); restore();
  return { id, opId: request.operationId, receiptFile: path.join(data, 'mission-delivery', id, `${request.operationId}.json`) };
}
/** Explicit GitHub API fixture over a real bare repository, not live GitHub. Only a remote
 * effect's acknowledgment/durable receipt is lost; production load owns all recovery. */
async function loseRemoteDelivery(endpoint: 'open_pr' | 'merge_pr' | 'held_pr', stage: 'creating_pr' | 'pr_created' | 'merging' | 'uncertain' | 'pushed', staleMerge = false) {
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(remote, 'config', 'user.name', 'Remote Recovery Fixture'); git(remote, 'config', 'user.email', 'remote-recovery@example.invalid'); git(remote, 'config', 'commit.gpgsign', 'false');
  git(project, 'remote', 'add', 'origin', fixtureGitHubRemote);
  const transport = fixtureGitHubTransport(remote), calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const ok = (stdout = ''): commands.CaptureResult => ({ code: 0, stdout, stderr: '' });
  const api = { pr: undefined as ReturnType<typeof fixturePr> | undefined,
    readPr: (pr: ReturnType<typeof fixturePr>) => pr,
    readCommit: (commit: { sha: string; html_url: string; tree: { sha: string } }) => commit };
  let loseAck = stage === 'uncertain', missObservation = false;
  vi.spyOn(commands, 'runCapture').mockImplementation(async (file, args, options) => {
    calls.push({ args, env: options?.env });
    if (args[0] === 'api') {
      expect(args).toEqual(['api', '--hostname', 'example.invalid', `repos/fixture/repository/git/commits/${api.pr!.mergeCommit!.oid}`]);
      const sha = api.pr!.mergeCommit!.oid;
      return ok(JSON.stringify(api.readCommit({ sha, html_url: `https://${fixtureGitHubRepo}/commit/${sha}`, tree: { sha: git(remote, 'rev-parse', `${sha}^{tree}`) } })));
    }
    if (args[0] !== 'pr') return transport(file, args, options);
    expect(args[args.indexOf('--repo') + 1]).toBe(fixtureGitHubRepo);
    if (args[1] === 'list') {
      if (missObservation) { missObservation = false; return ok('[]'); }
      return ok(JSON.stringify(api.pr ? [api.readPr(api.pr)] : []));
    }
    if (args[1] === 'create') {
      const branch = args[args.indexOf('--head') + 1];
      api.pr = fixturePr(branch, git(remote, 'rev-parse', `refs/heads/${branch}`), 'main');
    } else if (args[1] === 'merge') {
      const pr = api.pr!, target = git(remote, 'rev-parse', 'refs/heads/main');
      expect(args).toContain(pr.headRefOid);
      // A distinct server-side merge object must be inspected without fetching it locally.
      const tree = git(remote, 'rev-parse', `${staleMerge ? target : pr.headRefOid}^{tree}`);
      const merged = git(remote, 'commit-tree', tree, '-p', target, '-p', pr.headRefOid, '-m', 'Remote fixture merge');
      git(remote, 'update-ref', 'refs/heads/main', merged, target);
      pr.state = 'MERGED'; pr.mergeCommit = { oid: merged };
    } else throw new Error('Unexpected fixture GitHub mutation');
    if (loseAck && args[1] === (endpoint === 'merge_pr' ? 'merge' : 'create')) {
      loseAck = false; missObservation = true; throw new Error('Lost remote effect acknowledgment');
    }
    return ok(api.pr!.url);
  });
  const { id } = await start('candidate', 'candidate', 'candidate', { endpoint: endpoint === 'open_pr' ? 'open_pr' : 'merge_pr', remote: 'origin', targetBranch: 'main', allowPush: true,
    allowMerge: endpoint !== 'open_pr', ...(endpoint === 'held_pr' ? { holdConditions: ['Required human review'], holdIsEndpoint: true } : {}) });
  const integrated = await requestIntegration(id, 'candidate'); await tool(id, 'mission_yield', { events: ['integration'] }); finish(id);
  await wait(() => expect(operation(id, integrated.operationId)?.state).toBe('succeeded'));
  await wait(() => expect(sessions.activity(current(id).leadSessionId).turn).toBe(true));
  const { operationId: opId } = await tool(id, 'mission_finish_request', { commitMessage: 'feat: Recover the exact remote endpoint' }) as { operationId: string };
  const receiptFile = path.join(data, 'mission-delivery', id, `${opId}.json`), rename = fs.rename.bind(fs);
  let lost = false;
  const save = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!lost && String(to) === receiptFile) {
      const receipt = JSON.parse(await fs.readFile(from, 'utf8'));
      const boundary = stage === 'uncertain' ? receipt.stage === 'uncertain'
        : stage === 'creating_pr' ? receipt.stage === 'pr_created'
          : stage === 'pr_created' ? endpoint === 'merge_pr' ? receipt.stage === 'merging' && !receipt.mergedCommitSha : ['delivered', 'held'].includes(receipt.stage)
            : stage === 'merging' ? receipt.stage === 'merging' && !!receipt.mergedCommitSha
              : receipt.stage === 'creating_pr';
      if (boundary) {
        lost = true;
        if (stage === 'uncertain') await rename(from, to);
        await snapshot();
        if (stage === 'uncertain') return;
        throw new Error('Lost final delivery receipt durability');
      }
    }
    return rename(from, to);
  });
  finish(id);
  await wait(() => expect(operation(id, opId).state).toBe('failed')); save.mockRestore(); expect(lost).toBe(true);
  expect(JSON.parse(await fs.readFile(receiptFile, 'utf8')).stage).toBe(stage);
  const effects = () => ({ commits: calls.filter(({ args }) => args.includes('commit-tree')).length,
    pushes: calls.filter(({ args }) => args.includes('push')).length,
    creates: calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'create').length,
    merges: calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'merge').length });
  expect(effects()).toEqual({ commits: 1, pushes: 1, creates: stage === 'pushed' ? 0 : 1, merges: endpoint === 'merge_pr' && ['merging', 'uncertain'].includes(stage) ? 1 : 0 });
  return { id, opId, remote, receiptFile, api, calls, effects };
}
async function repositoryState() {
  return { head: git(project, 'rev-parse', 'HEAD'), index: await fs.readFile(path.join(project, '.git', 'index')),
    status: git(project, 'status', '--porcelain=v1', '--untracked-files=all'), bytes: await fs.readFile(path.join(project, 'a.txt')),
    refs: git(project, 'for-each-ref', '--format=%(refname) %(objectname)') };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mrr-')); project = path.join(root, 'p'); data = path.join(root, 'd'); crash = path.join(root, 'crash');
  await fs.mkdir(project); git(project, 'init', '-b', 'main'); git(project, 'config', 'user.name', 'Receipt Recovery Fixture'); git(project, 'config', 'user.email', 'receipt-recovery@example.invalid'); git(project, 'config', 'commit.gpgsign', 'false'); git(project, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(project, 'a.txt'), 'base\n'); git(project, 'add', '.'); git(project, 'commit', '-m', 'Receipt baseline');
  settings = defaultSettings(); settings.providers = []; settings.mcpDisabledBuiltins = ['gitnexus', 'vocs-memory', 'cua-driver']; settings.mission = missionFixture().config;
  settings.mission.presets[0].harnessId = 'pi'; contexts = new Map(); sends = 0; sequence = 0;
  vi.mocked(createAdapter).mockReset().mockImplementation((_harness, ctx): HarnessAdapter => {
    contexts.set(ctx.sessionId, ctx);
    let intent: Awaited<ReturnType<typeof createManagedPiOwnershipIntent>> | undefined;
    return { id: 'pi', busy: false, start: async () => {
      intent = await createManagedPiOwnershipIntent(ctx.sessionDir, { sessionId: ctx.sessionId, missionId: ctx.session().mission!.missionId, generation: ctx.session().mission!.generation });
      ctx.emit({ type: 'status', status: 'idle' });
    }, missionReadiness: async () => ({ ready: true, tools: ['read', 'write'], model: { provider: 'fixture', model: 'frontier' }, modelAvailable: true, connectionAvailable: true }),
    listModels: async () => [], send: async () => { sends++; ctx.emit({ type: 'status', status: 'running' }); }, interrupt: async () => undefined,
    dispose: async () => { if (intent) { await recordUnlaunchedManagedPiIntent(intent); intent = undefined; } },
    setModel: async () => undefined, setEffort: async () => undefined, setPermissionMode: async () => undefined };
  });
  await compose(); await runtime.load();
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await runtime.close(); await sessions.stopAll(); await sessions.flushPendingPersists();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.each(['candidate', 'target'] as const)('production %s integration recovery', (kind) => {
  it.each(['before', 'after'] as const)('inspects a lost %s-CAS acknowledgment without apply/check/fetch replay', async (when) => {
    const { id, before, targetHead } = await start(kind);
    const opId = await failIntegration(id, kind, 'git', when), evidence = structuredClone(current(id).evidence), source = await repositoryState();
    await restartFromCrash();
    const restored = current(id);
    expect(restored.status, JSON.stringify(restored.blockers)).toBe('paused');
    expect(restored.evidence).toEqual(evidence); expect(restored.baseline).toEqual(before.baseline);
    expect(restored.operations.filter((op) => op.kind === 'integrate')).toHaveLength(1);
    expect(operation(id, opId).state, JSON.stringify(restored.blockers)).toBe(when === 'after' ? 'succeeded' : 'failed');
    if (when === 'after') {
      expect(restored.acceptedRevision).toEqual(await runtime.workspaces.acceptedRevision(id));
      expect(restored.acceptedRevision).not.toEqual(before.acceptedRevision);
      expect(restored.blockers.filter((blocker) => !blocker.resolvedAt)).toEqual([]);
      if (kind === 'candidate') expect(restored.tasks[0].status).toBe('integrated');
      else expect(restored.deliveryPolicy.targetHead).toBe(targetHead);
    } else {
      expect(restored.acceptedRevision).toEqual(before.acceptedRevision);
      expect(restored.blockers.some((blocker) => !blocker.resolvedAt && /No exact atomic promotion receipt/.test(blocker.message))).toBe(true);
    }
    expect(await repositoryState()).toEqual(source);
  }, 90_000);

  it.each(['before', 'after'] as const)('recovers %s coordinator-journal acknowledgment with the exact persisted checks', async (when) => {
    const { id } = await start(kind);
    const opId = await failIntegration(id, kind, 'journal', when), evidence = structuredClone(current(id).evidence), source = await repositoryState();
    await restartFromCrash();
    expect(current(id).status, JSON.stringify(current(id).blockers)).toBe('paused');
    expect(current(id).evidence).toEqual(evidence); expect(operation(id, opId)).toMatchObject({ state: 'succeeded', payload: { reconciledReceipt: true } });
    expect(current(id).blockers.filter((blocker) => !blocker.resolvedAt)).toEqual([]);
    expect(current(id).acceptedRevision).toEqual(await runtime.workspaces.acceptedRevision(id));
    expect(await repositoryState()).toEqual(source);
  }, 90_000);
});

it('does not infer an empty-delta promotion from accepted-tree equality', async () => {
  const { id, before } = await start('candidate', 'base');
  const opId = await failIntegration(id, 'candidate', 'git', 'before');
  expect(current(id).candidates[0].revision).toEqual(before.acceptedRevision);
  await restartFromCrash();
  expect(operation(id, opId).state).toBe('failed'); expect(current(id).tasks[0].status).toBe('accepted');
  expect(current(id).candidates[0].integratedRevision).toBeUndefined();
  expect(current(id).blockers.some((blocker) => !blocker.resolvedAt && /No exact atomic promotion receipt/.test(blocker.message))).toBe(true);
}, 90_000);

it.each(['evidence', 'authorization', 'policy'] as const)('retains a completed integration blocker when its %s fence differs', async (field) => {
  const { id, before } = await start(); const opId = await failIntegration(id, 'candidate', 'git', 'after');
  await mutateSnapshot((record) => {
    if (field === 'evidence') record.evidence[0].invalidatedBy = 'Retained evidence no longer valid';
    else if (field === 'authorization') record.requestedPermissionMode = 'ask';
    else record.deliveryPolicy.requireIndependentReview = true;
  });
  await restartFromCrash();
  expect(operation(id, opId).state).toBe('failed'); expect(current(id).acceptedRevision).toEqual(before.acceptedRevision);
  expect(current(id).blockers.some((blocker) => !blocker.resolvedAt && blocker.message.startsWith(`Integration ${opId} `))).toBe(true);
}, 90_000);

it('keeps a known rejected candidate/base attempt immutable even for a new explicit request', async () => {
  const { id } = await start('candidate', 'candidate', 'not-candidate');
  const first = await requestIntegration(id, 'candidate'); await tool(id, 'mission_yield', { events: ['integration'] }); finish(id);
  await wait(() => expect(operation(id, first.operationId)?.state).toBe('failed'));
  await wait(() => expect(sends).toBe(4));
  const evidence = structuredClone(current(id).evidence), workspaces = current(id).workspaces.filter((workspace) => workspace.role === 'verification');
  expect(evidence).toEqual([expect.objectContaining({ result: 'failed' })]); expect(workspaces).toHaveLength(1);
  const second = await requestIntegration(id, 'candidate'); await tool(id, 'mission_yield', { events: ['integration'] }); finish(id);
  await wait(() => expect(operation(id, second.operationId)?.state).toBe('failed'));
  expect(second.operationId).not.toBe(first.operationId); expect(current(id).evidence).toEqual(evidence);
  expect(current(id).workspaces.filter((workspace) => workspace.role === 'verification')).toEqual(workspaces);
  expect(operation(id, second.operationId).error).toContain('repair in a fresh assigned workspace');
  await wait(() => expect(sends).toBe(5)); // Snapshot a bound launch, not an unrelated startup gap.
  await snapshot(); await restartFromCrash();
  expect(current(id).status, JSON.stringify(current(id).blockers)).toBe('paused');
  expect(current(id).blockers.filter((blocker) => !blocker.resolvedAt)).toEqual([]);
  expect(current(id).evidence).toEqual(evidence);
  expect(current(id).operations.filter((op) => op.kind === 'integrate').map((op) => op.state)).toEqual(['failed', 'failed']);
}, 90_000);

it.each(['before', 'after'] as const)('wires completed local delivery inspection after %s journal acknowledgment loss without another commit', async (when) => {
  const { id, opId, receiptFile } = await failDelivery(when);
  const evidence = structuredClone(current(id).evidence), source = await repositoryState(), receiptBytes = await fs.readFile(receiptFile);
  const inspect = vi.spyOn(MissionDeliveryService.prototype, 'inspect');
  await restartFromCrash();
  expect(inspect).toHaveBeenCalledTimes(1); inspect.mockRestore();
  expect(current(id).status, JSON.stringify(current(id).blockers)).toBe('paused');
  expect(current(id).delivery).toMatchObject({ operationId: opId, status: 'delivered', revision: current(id).acceptedRevision });
  expect(current(id).evidence).toEqual(evidence); expect(operation(id, opId), JSON.stringify(current(id).blockers)).toMatchObject({ state: 'succeeded', payload: { reconciledReceipt: true } });
  expect(current(id).blockers.filter((blocker) => !blocker.resolvedAt)).toEqual([]);
  expect(await fs.readFile(receiptFile)).toEqual(receiptBytes); expect(await repositoryState()).toEqual(source);
  const completed = await runtime.service.control({ missionId: id, expectedRevision: current(id).revision, idempotencyKey: 'explicit-resume', control: { action: 'resume' } });
  expect(completed.status).toBe('completed'); expect(completed.evidence).toEqual(evidence); expect(await repositoryState()).toEqual(source);
  expect(completed.completionReport).toMatchObject({ objective: completed.objective, acceptedRevision: completed.acceptedRevision, delivery: completed.delivery });
  expect(completed.completionReport!.delivery.commitSha).toBe(git(project, 'rev-parse', `${completed.delivery!.commitSha}^{commit}`));
  expect(completed.completionReport!.checks.map(({ evidence }) => evidence)).toEqual([completed.evidence.at(-1)]);
  await runtime.close(); await sessions.stopAll(); await sessions.flushPendingPersists();
  const durable = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord }); await durable.load();
  expect(durable.get(id)?.completionReport).toEqual(completed.completionReport);
  // Old, otherwise valid completed journals may predate the cached report. Host boot derives
  // and durably retains it from those same facts without asking a model or replaying delivery.
  await durable.transact(id, { idempotencyKey: 'legacy-report-fixture', actor: 'fixture', kind: 'fixture.legacy', expectedRevision: durable.get(id)!.revision }, (record) => { delete record.completionReport; return record; });
  await compose();
  const replay = vi.spyOn(MissionDeliveryService.prototype, 'deliver'), starts = vi.mocked(createAdapter).mock.calls.length;
  await runtime.load();
  expect(current(id).completionReport).toEqual(completed.completionReport);
  expect(runtime.store.get(id)?.completionReport).toEqual(completed.completionReport);
  expect(replay).not.toHaveBeenCalled(); expect(createAdapter).toHaveBeenCalledTimes(starts); replay.mockRestore();
}, 90_000);

it.each(['partial', 'mismatch', 'authorization'] as const)('blocks %s delivery receipts on actual runtime recovery without repeating external effects', async (failure) => {
  const { id, opId, receiptFile } = await failDelivery('before');
  if (failure === 'authorization') await mutateSnapshot((record) => { record.requestedPermissionMode = 'ask'; });
  else {
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    if (failure === 'partial') receipt.stage = 'committed';
    else receipt.commitSha = current(id).baseline!.baseCommitSha;
    await fs.writeFile(receiptFile, JSON.stringify(receipt));
  }
  const receiptBytes = await fs.readFile(receiptFile), evidence = structuredClone(current(id).evidence), source = await repositoryState();
  await restartFromCrash();
  expect(current(id).delivery).toBeUndefined(); expect(operation(id, opId).state).toBe('failed');
  expect(current(id).evidence).toEqual(evidence);
  expect(current(id).blockers.some((blocker) => !blocker.resolvedAt && blocker.message.startsWith(`Delivery ${opId} `))).toBe(true);
  expect(await fs.readFile(receiptFile)).toEqual(receiptBytes); expect(await repositoryState()).toEqual(source);
  await expect(runtime.service.control({ missionId: id, expectedRevision: current(id).revision, idempotencyKey: 'blocked-resume', control: { action: 'resume' } })).rejects.toThrow();
}, 90_000);

describe('production remote delivery recovery (explicit GitHub fixture, real bare Git)', () => {
  it.each([
    { endpoint: 'open_pr', stage: 'creating_pr' },
    { endpoint: 'open_pr', stage: 'pr_created' },
    { endpoint: 'open_pr', stage: 'uncertain' },
    { endpoint: 'held_pr', stage: 'pr_created' },
    { endpoint: 'merge_pr', stage: 'merging' },
    { endpoint: 'merge_pr', stage: 'uncertain' },
  ] as const)('recovers $endpoint from $stage only by observation and explicit Resume', async ({ endpoint, stage }) => {
    const fixture = await loseRemoteDelivery(endpoint, stage), { id, opId, remote, receiptFile, api, effects } = fixture;
    const evidence = structuredClone(current(id).evidence), source = await repositoryState(), bytes = await fs.readFile(receiptFile);
    const remoteRefs = git(remote, 'for-each-ref', '--format=%(refname) %(objectname)'), counts = effects();
    const objectCount = git(project, 'count-objects', '-v'), callCount = fixture.calls.length;
    const inspect = vi.spyOn(MissionDeliveryService.prototype, 'inspect');
    vi.stubEnv('GH_REPO', 'foreign.invalid/other/repository'); vi.stubEnv('GH_HOST', 'foreign.invalid'); vi.stubEnv('GH_HTTP_UNIX_SOCKET', '/foreign/transport');
    await restartFromCrash();
    expect(inspect).toHaveBeenCalledTimes(1); inspect.mockRestore();
    expect(api.pr).toBeDefined();
    const pr = api.pr!;
    const expected = { operationId: opId, endpoint: endpoint === 'open_pr' ? 'open_pr' : 'merge_pr', status: endpoint === 'held_pr' ? 'held' : 'delivered',
      commitSha: pr.headRefOid, pullRequestUrl: pr.url, ...(pr.mergeCommit ? { mergedCommitSha: pr.mergeCommit.oid } : {}), revision: current(id).acceptedRevision };
    expect(current(id).status, JSON.stringify(current(id).blockers)).toBe('paused');
    expect(current(id).delivery, JSON.stringify(current(id).blockers)).toMatchObject(expected);
    expect(current(id).delivery?.mergedCommitSha).toBe(api.pr!.mergeCommit?.oid);
    expect(operation(id, opId)).toMatchObject({ state: 'succeeded', payload: { reconciledReceipt: true } });
    expect(current(id).operations.filter((op) => op.kind === 'deliver')).toHaveLength(1);
    expect(current(id).blockers.filter((blocker) => !blocker.resolvedAt)).toEqual([]);
    expect(current(id).evidence).toEqual(evidence); expect(await fs.readFile(receiptFile)).toEqual(bytes);
    const starts = vi.mocked(createAdapter).mock.calls.length, sent = sends;
    const completed = await runtime.service.control({ missionId: id, expectedRevision: current(id).revision, idempotencyKey: 'explicit-remote-resume', control: { action: 'resume' } });
    expect(completed.status).toBe('completed'); expect(completed.delivery).toMatchObject(expected); expect(completed.evidence).toEqual(evidence);
    expect(completed.completionReport?.delivery).toMatchObject(expected);
    expect(completed.completionReport?.checks.map(({ evidence }) => evidence)).toEqual([completed.evidence.at(-1)]);
    expect(completed.completionReport?.deliveryPolicy.holdIsEndpoint).toBe(endpoint === 'held_pr');
    expect(createAdapter).toHaveBeenCalledTimes(starts); expect(sends).toBe(sent);
    expect(effects()).toEqual(counts); expect(await repositoryState()).toEqual(source);
    expect(git(remote, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(remoteRefs);
    expect(git(project, 'count-objects', '-v')).toBe(objectCount); expect(await fs.readFile(receiptFile)).toEqual(bytes);
    const reads = fixture.calls.slice(callCount).filter(({ args }) => ['pr', 'api'].includes(args[0]));
    expect(reads.length).toBeGreaterThan(0);
    for (const { args, env } of reads) {
      expect(args[0] === 'api' || args[1] === 'list').toBe(true);
      for (const key of ['GH_REPO', 'GH_HOST', 'GH_HTTP_UNIX_SOCKET']) expect(env?.[key], key).toBeUndefined();
      expect(env?.GH_PROMPT_DISABLED).toBe('1');
    }
    if (endpoint === 'merge_pr') {
      expect(reads.filter(({ args }) => args[0] === 'api')).toHaveLength(1);
      // Do not probe the absent merge object through Git either: partial clones can lazy-fetch.
      expect(fixture.calls.slice(callCount).some(({ args }) => args.includes(`${api.pr!.mergeCommit!.oid}^{tree}`))).toBe(false);
    }
  }, 90_000);

  it.each(['pushed without PR', 'open without merge', 'foreign PR', 'stale merged content', 'revoked authorization', 'uncertain owner'] as const)('keeps %s blocked without replay or false completion', async (failure) => {
    const merge = ['open without merge', 'stale merged content', 'uncertain owner'].includes(failure);
    const fixture = await loseRemoteDelivery(merge ? 'merge_pr' : 'open_pr', failure === 'pushed without PR' ? 'pushed'
      : failure === 'open without merge' ? 'pr_created' : merge ? 'merging' : 'creating_pr', failure === 'stale merged content');
    const { id, opId, receiptFile, remote, api, effects } = fixture;
    if (failure === 'foreign PR') api.readPr = (pr) => ({ ...pr, url: 'https://foreign.invalid/fixture/repository/pull/1' });
    if (failure === 'revoked authorization') await mutateSnapshot((record) => { delete record.executionAuthorization; record.phase = 'planning'; });
    if (failure === 'uncertain owner') {
      const checks = await processOwnershipIntents(checkOwnershipDirectory(path.join(data, 'mission-process-ownership'), id));
      expect(checks).toHaveLength(1); await fs.rm(checks[0].receiptPath);
    }
    const source = await repositoryState(), bytes = await fs.readFile(receiptFile), counts = effects();
    const evidence = structuredClone(current(id).evidence), remoteRefs = git(remote, 'for-each-ref', '--format=%(refname) %(objectname)');
    const inspect = vi.spyOn(MissionDeliveryService.prototype, 'inspect');
    await restartFromCrash();
    expect(current(id).status).toBe(failure === 'uncertain owner' ? 'recovering' : 'paused');
    expect(current(id).delivery).toBeUndefined(); expect(current(id).completionReport).toBeUndefined();
    expect(operation(id, opId).state).toBe(failure === 'uncertain owner' ? 'reconciling' : 'failed');
    if (['uncertain owner', 'revoked authorization'].includes(failure)) expect(inspect).not.toHaveBeenCalled();
    else expect(inspect).toHaveBeenCalledTimes(1);
    expect(current(id).blockers.some((blocker) => !blocker.resolvedAt && (failure === 'uncertain owner'
      ? /External ownership is uncertain/.test(blocker.message) : blocker.message.startsWith(`Delivery ${opId} `)))).toBe(true);
    const starts = vi.mocked(createAdapter).mock.calls.length, sent = sends;
    await expect(runtime.service.control({ missionId: id, expectedRevision: current(id).revision, idempotencyKey: 'refused-remote-resume', control: { action: 'resume' } })).rejects.toThrow();
    expect(createAdapter).toHaveBeenCalledTimes(starts); expect(sends).toBe(sent);
    expect(current(id).evidence).toEqual(evidence); expect(effects()).toEqual(counts);
    expect(await fs.readFile(receiptFile)).toEqual(bytes); expect(await repositoryState()).toEqual(source);
    expect(git(remote, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(remoteRefs);
  }, 90_000);

  it('rejects foreign or mismatched remote merge objects before importing a recovered delivery', async () => {
    const fixture = await loseRemoteDelivery('merge_pr', 'merging'), { id, opId, receiptFile, api, effects } = fixture;
    const source = await repositoryState(), bytes = await fs.readFile(receiptFile), counts = effects();
    const request = { mission: current(id), operationId: opId, commitMessage: operation(id, opId).payload.commitMessage as string };
    for (const patch of [
      { html_url: `https://foreign.invalid/fixture/repository/commit/${api.pr!.mergeCommit!.oid}` },
      { html_url: `https://example.invalid/fixture/other/commit/${api.pr!.mergeCommit!.oid}` },
      { sha: 'd'.repeat(40) }, { tree: { sha: 'not-a-tree' } },
    ]) {
      api.readCommit = (commit) => ({ ...commit, ...patch });
      await expect(runtime.delivery.inspect(request)).rejects.toThrow('Invalid exact merge commit receipt');
      expect(await fs.readFile(receiptFile)).toEqual(bytes);
    }
    await restartFromCrash();
    expect(current(id).delivery).toBeUndefined(); expect(operation(id, opId).state).toBe('failed');
    expect(current(id).blockers.some((blocker) => !blocker.resolvedAt && /Invalid exact merge commit receipt/.test(blocker.message))).toBe(true);
    await expect(runtime.service.control({ missionId: id, expectedRevision: current(id).revision, idempotencyKey: 'invalid-merge-resume', control: { action: 'resume' } })).rejects.toThrow();
    expect(effects()).toEqual(counts); expect(await fs.readFile(receiptFile)).toEqual(bytes); expect(await repositoryState()).toEqual(source);
  }, 90_000);
});

it('does not substitute a completed integration marker for missing process ownership proof', async () => {
  const { id, before } = await start(); const opId = await failIntegration(id, 'candidate', 'git', 'after');
  const checks = await processOwnershipIntents(checkOwnershipDirectory(path.join(data, 'mission-process-ownership'), id));
  expect(checks).toHaveLength(1); await fs.rm(checks[0].receiptPath);
  const source = await repositoryState();
  await restartFromCrash();
  expect(current(id).status).toBe('recovering'); expect(runtime.service.isQuiescent(current(id))).toBe(false);
  expect(operation(id, opId).state).toBe('reconciling'); expect(current(id).acceptedRevision).toEqual(before.acceptedRevision);
  expect(current(id).blockers.some((blocker) => !blocker.resolvedAt && /External ownership is uncertain/.test(blocker.message))).toBe(true);
  expect(await repositoryState()).toEqual(source);
}, 90_000);
