/** One delivery owner, explicit targets and replayable receipts. Never infer publishing authority. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MissionCodeRevision, MissionDelivery, MissionDeliveryPolicy, MissionRecord } from '../../shared/mission';
import { runCapture, which, type CaptureResult } from '../runtime';
import { writeJson } from '../util/fs';
import type { TargetObservation } from './workspaces';
import { missionGitHubEnvironment, missionGitHubTarget, missionRemoteUrl, readMissionRemoteEndpoint, runMissionGit, sensitiveGitDiagnostic, type MissionGitHubTarget } from './git-boundary';

export interface MissionDeliveryRequest {
  mission: MissionRecord;
  operationId: string;
  commitMessage?: string;
  report?: string;
}
export interface MissionDeliveryDeps {
  root: string;
  /** Existing permission mechanism + current policy; a lead never answers as the user. */
  authorize(request: MissionDeliveryRequest, action: 'commit' | 'push' | 'create_pr' | 'merge_pr'): Promise<void>;
  contentIdentity(cwd: string): Promise<MissionCodeRevision>;
  /** Host-owned workspace receipt, never an observation/SHA supplied by the model. */
  integratedTarget?(mission: MissionRecord): Promise<TargetObservation | undefined>;
  isQuiescent(mission: MissionRecord): Promise<boolean>;
  /** Final criteria/checks/reviews, without pretending delivery already happened. */
  implementationBlockers(mission: MissionRecord): string[];
  /** Injectable process boundary for deterministic remote tests; production uses real git/gh. */
  run?: (file: string, args: string[], cwd: string) => Promise<CaptureResult>;
}
interface Receipt {
  schemaVersion: 1;
  operationId: string;
  missionId: string;
  requestHash: string;
  branch: string;
  contentHash: string;
  baseCommitSha: string;
  expectedTargetHead?: string;
  /** The admitted endpoint, never a mutable remote alias or a credential-bearing URL. */
  remoteUrl?: string;
  parentCommitSha?: string;
  targetObservationId?: string;
  commitSha?: string;
  pullRequestUrl?: string;
  mergedCommitSha?: string;
  stage: 'intent' | 'committed' | 'pushing' | 'pushed' | 'creating_pr' | 'pr_created' | 'merging' | 'delivered' | 'held' | 'uncertain';
  pendingAction?: string;
}

const locks = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const pending = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
  locks.set(key, pending);
  try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
}
const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const gitOid = (value: string): boolean => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function safeId(value: string): void { if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)) throw new Error('Invalid delivery operation identity'); }
function safeRef(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) || value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.lock')) throw new Error('Invalid delivery branch/remote'); }

/** Execution and recovery must compute exactly the same immutable intent, including policy. */
function deliveryIntent(request: MissionDeliveryRequest, observed: TargetObservation | undefined, remoteUrl: string | undefined): { receipt: Receipt; commitMessage: string } {
  const { mission, operationId } = request, revision = mission.acceptedRevision!, policy = mission.deliveryPolicy;
  const commitMessage = request.commitMessage?.trim() || `feat: Complete ${mission.title.slice(0, 52)}`;
  if (!commitMessage || commitMessage.length > 10_000 || commitMessage.includes('\0')) throw new Error('Invalid delivery commit message');
  return { commitMessage, receipt: { schemaVersion: 1, operationId, missionId: mission.id,
    requestHash: sha({ missionId: mission.id, operationId, revision, policy, commitMessage, report: request.report ?? '' }),
    branch: missionDeliveryBranch(mission, observed), contentHash: revision.contentHash, baseCommitSha: revision.baseCommitSha,
    expectedTargetHead: policy.targetHead, remoteUrl, parentCommitSha: policy.endpoint === 'local_commit' ? revision.baseCommitSha : policy.targetHead!, targetObservationId: observed?.id, stage: 'intent' } };
}

function assertReceiptIdentity(receipt: Receipt, expected: Receipt): void {
  for (const key of ['schemaVersion', 'missionId', 'operationId', 'requestHash', 'branch', 'contentHash', 'baseCommitSha', 'expectedTargetHead', 'targetObservationId', 'remoteUrl'] as const) {
    if (receipt[key] !== expected[key]) throw new Error('Delivery receipt identity/payload conflict');
  }
  if ((receipt.parentCommitSha ?? receipt.baseCommitSha) !== expected.parentCommitSha) throw new Error('Delivery receipt identity/payload conflict');
  if (receipt.commitSha && !gitOid(receipt.commitSha)) throw new Error('Invalid delivery commit receipt');
  if (!['intent', 'committed', 'pushing', 'pushed', 'creating_pr', 'pr_created', 'merging', 'delivered', 'held', 'uncertain'].includes(receipt.stage)) throw new Error('Invalid delivery receipt stage');
}
const holdReason = (policy: MissionDeliveryPolicy): string => `Project review hold: ${policy.holdConditions.join('; ')}`;

/** Never forward an API-returned URL to gh. Its host/repository must match the admitted
 * endpoint exactly before extracting a repository-scoped, positive PR number. */
function pullRequestNumber(value: unknown, github: MissionGitHubTarget): number {
  const match = typeof value === 'string' && !/\s/.test(value) ? /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(value) : null;
  if (!match || match[1].toLowerCase() !== github.host || match[2].toLowerCase() !== github.owner.toLowerCase() || match[3].toLowerCase() !== github.name.toLowerCase()
    || !Number.isSafeInteger(Number(match[4]))) throw new Error('Invalid exact PR receipt');
  return Number(match[4]);
}

export class MissionDeliveryService {
  constructor(private readonly deps: MissionDeliveryDeps) {}

  /** Recovery is observation only. An exact admitted remote effect can complete a partial
   * receipt in memory; no authorization, fetch, storage creation, receipt rewriting, or
   * commit/publish effect is replayed here. Unknown/unfinished endpoints stay blocked. */
  async inspect(input: MissionDeliveryRequest): Promise<MissionDelivery | undefined> {
    const request = structuredClone(input), { mission, operationId } = request;
    safeId(mission.id); safeId(operationId);
    const workspace = mission.workspaces.find((w) => w.role === 'integration' && !w.cleanedAt), revision = mission.acceptedRevision;
    if (!workspace || !revision) return undefined;
    if (!gitOid(revision.contentHash) || !gitOid(revision.baseCommitSha)) throw new Error('Invalid verified Git content identity');
    const policy = mission.deliveryPolicy;
    if (policy.endpoint === 'custom' || policy.conflicts.length) throw new Error('Cannot inspect delivery under unresolved/conflicting project policy');
    if (policy.endpoint !== 'local_commit') {
      if (!policy.allowPush || !policy.remote || !policy.targetBranch || !policy.targetHead || !gitOid(policy.targetHead) || policy.endpoint === 'merge_pr' && !policy.allowMerge) throw new Error('Remote receipt inspection requires its exact approved delivery policy');
      safeRef(policy.remote); safeRef(policy.targetBranch);
    }
    const common = (await this.command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], workspace.path)).trim();
    return serialized(`${common}:${policy.remote ?? 'local'}:${policy.targetBranch ?? ''}`, async () => {
      let receipt: Receipt;
      try { receipt = JSON.parse(await fs.readFile(await this.receiptFile(mission.id, operationId, false), 'utf8')) as Receipt; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
      const observed = policy.endpoint === 'local_commit' ? undefined : await this.deps.integratedTarget?.(mission);
      if (observed && (observed.missionId !== mission.id || observed.remote !== policy.remote || observed.targetBranch !== policy.targetBranch || observed.commitSha !== policy.targetHead)) throw new Error('Integrated target observation differs from the approved delivery target');
      const remoteUrl = policy.endpoint === 'local_commit' ? undefined : observed?.remoteUrl ?? receipt.remoteUrl;
      if (policy.endpoint !== 'local_commit' && (!remoteUrl || missionRemoteUrl(remoteUrl) !== remoteUrl)) throw new Error('Delivery receipt has no canonical approved remote endpoint; explicit reconciliation is required.');
      if (remoteUrl) missionGitHubTarget(remoteUrl);
      assertReceiptIdentity(receipt, deliveryIntent(request, observed, remoteUrl).receipt);
      if (!receipt.commitSha) return undefined;
      if (!['delivered', 'held'].includes(receipt.stage)) {
        const confirmed = await this.inspectRemoteEffect(receipt, policy, workspace.path);
        if (!confirmed) return undefined;
        receipt = confirmed;
      }
      if (receipt.pendingAction !== undefined) return undefined;
      await this.verifyReceipt(receipt, policy, workspace.path, true);
      return { operationId, revision, endpoint: policy.endpoint, status: receipt.stage as 'delivered' | 'held', expectedTargetHead: policy.targetHead,
        commitSha: receipt.commitSha, pullRequestUrl: receipt.pullRequestUrl, mergedCommitSha: receipt.mergedCommitSha,
        ...(receipt.stage === 'held' ? { reason: holdReason(policy) } : {}), completedAt: Date.now() };
    });
  }

  async deliver(input: MissionDeliveryRequest): Promise<MissionDelivery> {
    const request = structuredClone(input);
    safeId(request.mission.id); safeId(request.operationId);
    const workspace = request.mission.workspaces.find((w) => w.role === 'integration' && !w.cleanedAt);
    if (!workspace || !request.mission.acceptedRevision) throw new Error('Delivery requires a retained integration workspace and accepted content');
    const common = (await this.command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], workspace.path)).trim();
    const policy = request.mission.deliveryPolicy;
    // Repository-target lock spans all Missions, not merely this branch's model turn.
    return serialized(`${common}:${policy.remote ?? 'local'}:${policy.targetBranch ?? ''}`, () => this.perform(request, workspace.path));
  }

  private async perform(request: MissionDeliveryRequest, cwd: string): Promise<MissionDelivery> {
    const { mission, operationId } = request;
    const revision = mission.acceptedRevision!;
    const policy = mission.deliveryPolicy;
    const blockers = this.deps.implementationBlockers(mission);
    if (blockers.length) throw new Error(`Delivery prerequisites: ${blockers.join('; ')}`);
    if (!(await this.deps.isQuiescent(mission))) throw new Error('Delivery is waiting for all owned activity to settle');
    if ((await this.deps.contentIdentity(cwd)).contentHash !== revision.contentHash) throw new Error('Integration content no longer matches final verified evidence');
    if (policy.conflicts.length) throw new Error(`Conflicting project policy: ${policy.conflicts.join('; ')}`);
    if (policy.endpoint === 'custom') throw new Error('Custom delivery requires an explicitly configured project mechanism; no deployment authority was inferred');
    if (policy.endpoint !== 'local_commit') {
      if (!policy.allowPush || !policy.remote || !policy.targetBranch || !policy.targetHead) throw new Error('Remote delivery requires an authorized remote, target branch and observed target head');
      safeRef(policy.remote); safeRef(policy.targetBranch);
      if (!gitOid(policy.targetHead)) throw new Error('Invalid recorded delivery target head');
      if (policy.endpoint === 'merge_pr' && !policy.allowMerge) throw new Error('Project policy does not authorize merging');
    }
    if (!gitOid(revision.contentHash) || !gitOid(revision.baseCommitSha)) throw new Error('Invalid verified Git content identity');
    const observed = policy.endpoint === 'local_commit' ? undefined : await this.deps.integratedTarget?.(mission);
    if (observed) {
      if (observed.missionId !== mission.id || observed.remote !== policy.remote || observed.targetBranch !== policy.targetBranch || observed.commitSha !== policy.targetHead || !gitOid(observed.commitSha)) throw new Error('Integrated target observation differs from the approved delivery target; refresh integration and policy together.');
      if (missionRemoteUrl(observed.remoteUrl) !== observed.remoteUrl) throw new Error('Integrated target endpoint is not canonical; observe and approve it again.');
    } else if (policy.endpoint !== 'local_commit' && (await this.tryCommand('git', ['merge-base', '--is-ancestor', policy.targetHead!, revision.baseCommitSha], cwd)).code !== 0) {
      throw new Error('The approved target is not included in the source baseline. Observe, integrate and reverify its exact head before delivery.');
    }
    const remoteUrl = policy.endpoint === 'local_commit' ? undefined : observed?.remoteUrl ?? await this.remoteEndpoint(policy.remote!, cwd);
    // Establish the GitHub authority before recording intent, committing, or publishing content.
    const github = remoteUrl ? missionGitHubTarget(remoteUrl) : undefined;
    if (remoteUrl) await this.checkRemoteEndpoint(policy.remote!, remoteUrl, cwd);
    // A refreshed/repaired result never resets an older retained delivery branch or its PR.
    const { receipt: intent, commitMessage } = deliveryIntent(request, observed, remoteUrl);
    const { branch, parentCommitSha } = intent;
    const file = await this.receiptFile(mission.id, operationId);
    let receipt: Receipt;
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Receipt;
      assertReceiptIdentity(raw, intent);
      receipt = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      receipt = intent;
      await writeJson(file, receipt);
    }
    const save = async (patch: Partial<Receipt>) => { receipt = { ...receipt, ...patch }; await writeJson(file, receipt); };
    const asDelivery = (status: MissionDelivery['status'], reason?: string): MissionDelivery => ({
      operationId, revision, endpoint: policy.endpoint, status, expectedTargetHead: policy.targetHead,
      commitSha: receipt.commitSha, pullRequestUrl: receipt.pullRequestUrl, mergedCommitSha: receipt.mergedCommitSha,
      reason, ...(status === 'delivered' || status === 'held' ? { completedAt: Date.now() } : {}),
    });
    if (receipt.stage === 'delivered' || receipt.stage === 'held') {
      await this.verifyReceipt(receipt, policy, cwd);
      return asDelivery(receipt.stage, receipt.stage === 'held' ? holdReason(policy) : undefined);
    }
    // An uncertain command is reconciled through Git/remote inspection below, never blindly repeated.
    if (!receipt.commitSha) {
      await this.deps.authorize(request, 'commit');
      const existing = await this.tryCommand('git', ['rev-parse', '--verify', `refs/heads/${branch}`], cwd);
      if (existing.code === 0) {
        const commit = existing.stdout.trim();
        const tree = (await this.command('git', ['rev-parse', `${commit}^{tree}`], cwd)).trim();
        const body = await this.command('git', ['log', '-1', '--format=%B', commit], cwd);
        const parents = (await this.command('git', ['show', '-s', '--format=%P', commit], cwd)).trim();
        if (tree !== revision.contentHash || parents !== parentCommitSha || !body.includes(`Mission-Operation: ${operationId}`)) throw new Error('Delivery branch already exists with unrelated content or ancestry');
        await save({ commitSha: commit, stage: 'committed' });
      } else {
        if (receipt.pendingAction === 'commit') throw new Error('Commit creation acknowledgment was lost; reconcile the retained intent instead of creating another commit.');
        // No author/committer override: git config and the session owner's ordinary environment win.
        const message = `${commitMessage}\n\nMission-Operation: ${operationId}`;
        await save({ pendingAction: 'commit' });
        const commit = (await this.command('git', ['commit-tree', revision.contentHash, '-p', parentCommitSha!, '-m', message], cwd)).trim();
        if (!gitOid(commit)) throw new Error('Git returned no verifiable commit');
        await save({ commitSha: commit, pendingAction: 'update_delivery_branch' });
        await this.command('git', ['update-ref', `refs/heads/${branch}`, commit, '0'.repeat(commit.length)], cwd);
        await save({ stage: 'committed', pendingAction: undefined });
      }
    } else {
      await this.ensureLocalBranch(receipt, cwd);
    }
    if (policy.endpoint === 'local_commit') {
      await this.verifyReceipt(receipt, policy, cwd);
      await save({ stage: 'delivered', pendingAction: undefined });
      return asDelivery('delivered');
    }
    // All Git reads/writes name this exact endpoint, never re-resolve the remote during spawn.
    const remote = remoteUrl!, target = policy.targetBranch!;
    await this.checkRemoteEndpoint(policy.remote!, remote, cwd);
    // A completed merge may itself advance target. Inspect that exact PR before demanding the old head.
    const existingPr = await this.findPr(github!, branch, target, receipt.commitSha!, cwd);
    if (receipt.pullRequestUrl && (!existingPr || pullRequestNumber(receipt.pullRequestUrl, github!) !== existingPr.number)) throw new Error('Recorded PR delivery identity changed');
    if (existingPr?.state === 'MERGED') {
      if (existingPr.headRefOid !== receipt.commitSha || !gitOid(existingPr.mergeCommit?.oid ?? '')) throw new Error('Merged PR does not match this verified delivery commit');
      await save({ pullRequestUrl: existingPr.url, mergedCommitSha: existingPr.mergeCommit!.oid, stage: 'merging' });
      await this.verifyMergedContent(receipt, policy, cwd);
      await save({ stage: 'delivered', pendingAction: undefined });
      return asDelivery('delivered');
    }
    const targetHead = await this.remoteHead(remote, target, cwd);
    if (targetHead !== policy.targetHead) return asDelivery('blocked', 'Remote target advanced. Integrate and reverify against its new head; no force push was attempted.');
    await this.deps.authorize(request, 'push');
    await this.checkRemoteEndpoint(policy.remote!, remote, cwd);
    if (await this.remoteHead(remote, target, cwd) !== policy.targetHead) return asDelivery('blocked', 'Remote target advanced during push approval; refresh integration and verification.');
    const remoteHead = await this.remoteHead(remote, branch, cwd);
    if (remoteHead && remoteHead !== receipt.commitSha) throw new Error('Remote delivery branch contains different content; no force push was attempted');
    if (!remoteHead) {
      if (receipt.pendingAction === 'push') throw new Error('Push outcome is uncertain and the recorded branch is absent; no external mutation was replayed.');
      await save({ stage: 'pushing', pendingAction: 'push' });
      await this.checkRemoteEndpoint(policy.remote!, remote, cwd);
      try { await this.command('git', ['push', remote, `${receipt.commitSha}:refs/heads/${branch}`], cwd); }
      catch (error) { await save({ stage: 'uncertain' }); throw error; }
      if (await this.remoteHead(remote, branch, cwd) !== receipt.commitSha) throw new Error('Pushed branch acknowledgment could not be verified');
    }
    if (receipt.pendingAction !== 'create_pr' && receipt.pendingAction !== 'merge_pr') await save({ stage: 'pushed', pendingAction: undefined });
    let pr = existingPr ?? await this.findPr(github!, branch, target, receipt.commitSha!, cwd);
    if (pr && pr.headRefOid !== receipt.commitSha) throw new Error('Existing PR head differs from the verified commit');
    if (pr?.state === 'CLOSED') return asDelivery('blocked', 'The exact delivery PR is closed without merging; it was not reopened or duplicated.');
    if (!pr) {
      if (receipt.pendingAction === 'create_pr' || receipt.pendingAction === 'merge_pr') throw new Error('PR outcome is uncertain and the exact PR is absent; no external mutation was replayed.');
      await this.deps.authorize(request, 'create_pr');
      await this.checkRemoteEndpoint(policy.remote!, remote, cwd);
      if (await this.remoteHead(remote, target, cwd) !== policy.targetHead) return asDelivery('blocked', 'Remote target advanced before PR creation; refresh integration and verification.');
      await save({ stage: 'creating_pr', pendingAction: 'create_pr' });
      let createdUrl: string | undefined;
      try {
        createdUrl = (await this.command('gh', ['pr', 'create', '--repo', github!.repository, '--head', branch, '--base', target, '--title', commitMessage.split('\n')[0], '--body', request.report ?? `Mission ${mission.id}\n\nVerified content: ${revision.contentHash}\n\nMission-Operation: ${operationId}`], cwd)).trim();
      } catch (error) {
        // Lost acknowledgment is not proof of failure. Look up the exact head/base pair first.
        pr = await this.findPr(github!, branch, target, receipt.commitSha!, cwd);
        if (!pr) { await save({ stage: 'uncertain' }); throw error; }
      }
      const createdNumber = createdUrl === undefined ? undefined : pullRequestNumber(createdUrl, github!);
      pr ??= await this.findPr(github!, branch, target, receipt.commitSha!, cwd);
      if (!pr || createdNumber !== undefined && pr.number !== createdNumber) throw new Error('Invalid exact PR receipt: creation could not be verified');
    }
    if (receipt.pendingAction === 'merge_pr') throw new Error('Merge outcome is uncertain and the exact PR is not merged; no merge was replayed.');
    await save({ pullRequestUrl: pr.url, stage: 'pr_created', pendingAction: undefined });
    if (policy.endpoint === 'open_pr') {
      if (await this.remoteHead(remote, target, cwd) !== policy.targetHead) return asDelivery('blocked', 'Remote target advanced while creating the PR; refresh integration and verification.');
      await save({ stage: 'delivered' }); return asDelivery('delivered');
    }
    if (policy.holdConditions.length) {
      // Conditions supplied by resolved project policy are a hold, never automatic review approval.
      if (policy.holdIsEndpoint) {
        await this.verifyReceipt({ ...receipt, stage: 'held' }, policy, cwd);
        await save({ stage: 'held', pendingAction: undefined });
      }
      return asDelivery(policy.holdIsEndpoint ? 'held' : 'blocked', holdReason(policy));
    }
    await this.deps.authorize(request, 'merge_pr');
    await this.checkRemoteEndpoint(policy.remote!, remote, cwd);
    if (await this.remoteHead(remote, target, cwd) !== policy.targetHead) return asDelivery('blocked', 'Remote target advanced before merge; refresh integration and verification.');
    const currentPr = await this.findPr(github!, branch, target, receipt.commitSha!, cwd);
    if (!currentPr || currentPr.number !== pr.number || currentPr.state !== 'OPEN') throw new Error('Invalid exact PR receipt before merge');
    await save({ stage: 'merging', pendingAction: 'merge_pr' });
    try { await this.command('gh', ['pr', 'merge', String(pr.number), '--repo', github!.repository, `--${policy.mergeMethod ?? 'merge'}`, '--match-head-commit', receipt.commitSha!], cwd); }
    catch (error) {
      const actual = await this.findPr(github!, branch, target, receipt.commitSha!, cwd);
      if (actual?.state !== 'MERGED' || actual.number !== pr.number) { await save({ stage: 'uncertain' }); throw error; }
    }
    pr = await this.findPr(github!, branch, target, receipt.commitSha!, cwd);
    if (pr?.state !== 'MERGED' || pr.number !== currentPr.number || pr.headRefOid !== receipt.commitSha || !gitOid(pr.mergeCommit?.oid ?? '')) throw new Error('The exact PR is not verified merged');
    await save({ mergedCommitSha: pr.mergeCommit!.oid, stage: 'merging' });
    await this.verifyMergedContent(receipt, policy, cwd);
    await save({ stage: 'delivered', pendingAction: undefined });
    return asDelivery('delivered');
  }

  /** Only an already-admitted action may be reconciled. A pushed branch alone is not a PR,
   * and an open PR is not a merge endpoint unless its exact policy explicitly permits a hold. */
  private async inspectRemoteEffect(receipt: Receipt, policy: MissionDeliveryPolicy, cwd: string): Promise<Receipt | undefined> {
    if (policy.endpoint === 'local_commit' || !receipt.remoteUrl) return undefined;
    const creating = receipt.pendingAction === 'create_pr' && ['creating_pr', 'uncertain'].includes(receipt.stage);
    const created = receipt.stage === 'pr_created' && receipt.pendingAction === undefined;
    const merging = receipt.pendingAction === 'merge_pr' && ['merging', 'uncertain'].includes(receipt.stage);
    if (!creating && !created && !merging) return undefined;
    if (merging && (policy.endpoint !== 'merge_pr' || policy.holdConditions.length || !receipt.pullRequestUrl)) return undefined;
    await this.ensureLocalBranch(receipt, cwd);
    await this.checkRemoteEndpoint(policy.remote!, receipt.remoteUrl, cwd);
    const github = missionGitHubTarget(receipt.remoteUrl);
    const pr = await this.findPr(github, receipt.branch, policy.targetBranch!, receipt.commitSha!, cwd);
    if (!pr) return undefined;
    if (receipt.pullRequestUrl && pullRequestNumber(receipt.pullRequestUrl, github) !== pr.number) throw new Error('Recorded PR delivery identity changed');
    if (pr.state === 'CLOSED') return undefined;
    let stage: 'delivered' | 'held' = 'delivered';
    let mergedCommitSha = receipt.mergedCommitSha;
    if (policy.endpoint === 'merge_pr') {
      if (policy.holdConditions.length) {
        if (!policy.holdIsEndpoint || pr.state !== 'OPEN' || mergedCommitSha) return undefined;
        stage = 'held';
      } else {
        if (!merging || pr.state !== 'MERGED' || !gitOid(pr.mergeCommit?.oid ?? '')) return undefined;
        if (mergedCommitSha && mergedCommitSha !== pr.mergeCommit!.oid) throw new Error('Recorded PR merge identity changed');
        mergedCommitSha = pr.mergeCommit!.oid;
      }
    }
    if (pr.state === 'OPEN' && await this.remoteHead(receipt.remoteUrl, receipt.branch, cwd) !== receipt.commitSha) throw new Error('Remote delivery branch no longer matches the verified commit');
    return { ...receipt, pullRequestUrl: pr.url, mergedCommitSha, stage, pendingAction: undefined };
  }

  private async ensureLocalBranch(receipt: Receipt, cwd: string): Promise<void> {
    const actual = await this.tryCommand('git', ['rev-parse', '--verify', `refs/heads/${receipt.branch}`], cwd);
    if (actual.code !== 0 || actual.stdout.trim() !== receipt.commitSha) throw new Error('Local delivery branch changed or its acknowledgment is uncertain; the recorded effect was not replayed');
    const tree = (await this.command('git', ['rev-parse', `${receipt.commitSha}^{tree}`], cwd)).trim();
    const parents = (await this.command('git', ['show', '-s', '--format=%P', receipt.commitSha!], cwd)).trim();
    if (tree !== receipt.contentHash || parents !== (receipt.parentCommitSha ?? receipt.baseCommitSha)) throw new Error('Delivery commit does not contain verified content and the exact observed parent');
    const body = await this.command('git', ['log', '-1', '--format=%B', receipt.commitSha!], cwd);
    if (!body.split(/\r?\n/).includes(`Mission-Operation: ${receipt.operationId}`)) throw new Error('Delivery commit does not belong to the retained operation');
  }

  private async verifyReceipt(receipt: Receipt, policy: MissionDeliveryPolicy, cwd: string, readOnly = false): Promise<void> {
    if (receipt.stage === 'held' && (policy.endpoint !== 'merge_pr' || !policy.holdIsEndpoint || !policy.holdConditions.length)) throw new Error('Recorded hold no longer matches the approved delivery endpoint');
    await this.ensureLocalBranch(receipt, cwd);
    if (policy.endpoint === 'local_commit') return;
    if (!receipt.remoteUrl) throw new Error('Delivery receipt has no approved remote endpoint; explicit reconciliation is required.');
    await this.checkRemoteEndpoint(policy.remote!, receipt.remoteUrl, cwd);
    const github = missionGitHubTarget(receipt.remoteUrl), number = pullRequestNumber(receipt.pullRequestUrl, github);
    const pr = await this.findPr(github, receipt.branch, policy.targetBranch!, receipt.commitSha!, cwd);
    if (!pr || pr.number !== number || pr.headRefOid !== receipt.commitSha || pr.state === 'CLOSED') throw new Error('Recorded PR delivery is no longer satisfied');
    if (receipt.stage === 'held') {
      if (pr.state !== 'OPEN' || receipt.mergedCommitSha) throw new Error('Recorded review hold is not satisfied by an open unmerged PR');
      if (await this.remoteHead(receipt.remoteUrl, policy.targetBranch!, cwd) !== receipt.expectedTargetHead) throw new Error('Remote target advanced during the recorded review hold; refresh integration and verification.');
      return;
    }
    if (policy.endpoint === 'open_pr' && pr.state !== 'MERGED' && await this.remoteHead(receipt.remoteUrl, policy.targetBranch!, cwd) !== receipt.expectedTargetHead) throw new Error('Remote target advanced after PR delivery; refresh integration and verification.');
    if (policy.endpoint === 'merge_pr') {
      if (pr.state !== 'MERGED' || pr.mergeCommit?.oid !== receipt.mergedCommitSha) throw new Error('Recorded PR merge is not satisfied');
      await this.verifyMergedContent(receipt, policy, cwd, readOnly);
    }
  }

  private async verifyMergedContent(receipt: Receipt, policy: MissionDeliveryPolicy, cwd: string, readOnly = false): Promise<void> {
    if (!policy.remote || !receipt.remoteUrl || !receipt.mergedCommitSha || !gitOid(receipt.mergedCommitSha)) throw new Error('Missing exact merge identity');
    await this.checkRemoteEndpoint(policy.remote, receipt.remoteUrl, cwd);
    // A merge may finish before its object is retained locally. Read its exact GitHub object
    // during recovery: even probing a missing local object can lazy-fetch in a partial clone.
    let actualTree: string;
    if (readOnly) actualTree = await this.remoteCommitTree(missionGitHubTarget(receipt.remoteUrl), receipt.mergedCommitSha, cwd);
    else {
      await this.command('git', ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-maintenance', '--refmap=', receipt.remoteUrl, receipt.mergedCommitSha], cwd);
      actualTree = (await this.command('git', ['rev-parse', `${receipt.mergedCommitSha}^{tree}`], cwd)).trim();
    }
    if (actualTree !== receipt.contentHash) throw new Error('The PR merged, but its actual combined content differs from the verified revision. Preserve the receipt and verify/repair it; delivery is not complete.');
  }

  private async remoteCommitTree(github: MissionGitHubTarget, commit: string, cwd: string): Promise<string> {
    const output = await this.command('gh', ['api', '--hostname', github.host, `repos/${github.owner}/${github.name}/git/commits/${commit}`], cwd);
    let object: { sha?: string; html_url?: string; tree?: { sha?: string } } | null;
    try { object = JSON.parse(output); } catch { throw new Error('Invalid exact merge commit receipt'); }
    const url = typeof object?.html_url === 'string' ? /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/commit\/([a-f0-9]+)$/.exec(object.html_url) : null;
    if (object?.sha !== commit || !gitOid(object.tree?.sha ?? '') || !url || url[1].toLowerCase() !== github.host
      || url[2].toLowerCase() !== github.owner.toLowerCase() || url[3].toLowerCase() !== github.name.toLowerCase() || url[4] !== commit) throw new Error('Invalid exact merge commit receipt');
    return object.tree!.sha!;
  }

  private async findPr(github: MissionGitHubTarget, branch: string, target: string, commit: string, cwd: string): Promise<PrReceipt | undefined> {
    const output = await this.command('gh', ['pr', 'list', '--repo', github.repository, '--head', branch, '--base', target, '--state', 'all', '--json', 'number,url,state,headRefOid,headRefName,baseRefName,headRepository,headRepositoryOwner,isCrossRepository,mergeCommit'], cwd);
    let rows: unknown;
    try { rows = JSON.parse(output); } catch { throw new Error('Invalid exact PR receipt'); }
    if (!Array.isArray(rows) || rows.length > 1) throw new Error('Exact delivery PR lookup is ambiguous');
    if (!rows.length) return undefined;
    if (!rows[0] || typeof rows[0] !== 'object') throw new Error('Invalid exact PR receipt');
    const pr = rows[0] as Partial<PrReceipt>;
    if (pullRequestNumber(pr.url, github) !== pr.number || !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state ?? '') || !gitOid(pr.headRefOid ?? '') || pr.headRefOid !== commit
      || pr.headRefName !== branch || pr.baseRefName !== target || pr.isCrossRepository !== false
      || typeof pr.headRepository?.nameWithOwner !== 'string' || pr.headRepository.nameWithOwner.toLowerCase() !== `${github.owner}/${github.name}`.toLowerCase()
      || typeof pr.headRepositoryOwner?.login !== 'string' || pr.headRepositoryOwner.login.toLowerCase() !== github.owner.toLowerCase()) throw new Error('Invalid exact PR receipt');
    return pr as PrReceipt;
  }

  private remoteEndpoint(remote: string, cwd: string): Promise<string> {
    return readMissionRemoteEndpoint(cwd, remote, (args) => this.tryCommand('git', args, cwd));
  }

  private async checkRemoteEndpoint(remote: string, expected: string, cwd: string): Promise<void> {
    if (missionRemoteUrl(expected) !== expected || await this.remoteEndpoint(remote, cwd) !== expected) throw new Error('Approved target endpoint changed since observation; no remote action was authorized for the replacement.');
  }

  private async remoteHead(remote: string, branch: string, cwd: string): Promise<string | undefined> {
    const output = (await this.command('git', ['ls-remote', '--heads', remote, `refs/heads/${branch}`], cwd)).trim();
    if (!output) return undefined;
    const rows = output.split(/\r?\n/);
    const [oid, ref] = rows[0].split(/\s+/);
    if (rows.length !== 1 || !gitOid(oid) || ref !== `refs/heads/${branch}`) throw new Error('Remote head lookup is ambiguous');
    return oid;
  }

  private async receiptFile(missionId: string, operationId: string, create = true): Promise<string> {
    const root = path.resolve(this.deps.root);
    if (create) await fs.mkdir(root, { recursive: true });
    if ((await fs.lstat(root)).isSymbolicLink() || await fs.realpath(root) !== root) throw new Error('Delivery storage root must not traverse a symlink/junction');
    const folder = path.join(root, missionId);
    if (create) await fs.mkdir(folder, { recursive: true });
    if ((await fs.lstat(folder)).isSymbolicLink()) throw new Error('Unsafe delivery storage path');
    const file = path.join(folder, `${operationId}.json`);
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Unsafe delivery receipt'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return file;
  }

  private async tryCommand(file: 'git' | 'gh', args: string[], cwd: string): Promise<CaptureResult> {
    const result = this.deps.run ? await this.deps.run(file, args, cwd)
      : file === 'git' ? await runMissionGit(cwd, args, { timeoutMs: 120_000 })
        : await runCapture(which(file) ?? file, args, { cwd, timeoutMs: 120_000, env: missionGitHubEnvironment() });
    if (result.timedOut || result.truncated) throw new Error(`${file} command outcome is uncertain; reconcile its recorded target before retrying`);
    return result;
  }
  private async command(file: 'git' | 'gh', args: string[], cwd: string): Promise<string> {
    const result = await this.tryCommand(file, args, cwd);
    if (result.code !== 0) throw new Error(`${file} ${args[0]} failed${file === 'gh' || sensitiveGitDiagnostic(args) ? '. Check the approved endpoint and noninteractive Git credentials.' : `: ${(result.stderr || result.stdout).slice(0, 4_000)}`}`);
    return result.stdout;
  }
}
interface PrReceipt {
  number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; headRefOid: string; headRefName: string; baseRefName: string;
  headRepository: { nameWithOwner: string }; headRepositoryOwner: { login: string }; isCrossRepository: boolean; mergeCommit?: { oid: string } | null;
}

/** Host permission displays use the same exact retained delivery branch as execution. */
export function missionDeliveryBranch(mission: MissionRecord, observed?: TargetObservation): string {
  const suffix = observed ? `-${sha([observed.id, mission.acceptedRevision]).slice(0, 16)}` : '';
  return `mission/${mission.id}-delivery${suffix}`;
}

/** Safe fallback only. Callers resolving repository instructions must retain provenance and
 * explicitly supply any remote endpoint; this function never infers publication from an objective. */
export function localMissionDeliveryPolicy(provenance: MissionDeliveryPolicy['provenance'] = []): MissionDeliveryPolicy {
  return { endpoint: 'local_commit', checks: [], requireIndependentReview: true, allowPush: false, allowMerge: false, holdConditions: [], holdIsEndpoint: false,
    provenance: [...provenance, { source: 'Mission MVP fallback A13', text: 'No delivery endpoint was resolved; finish at a verified local commit without publishing.' }], fallback: true, conflicts: [] };
}
