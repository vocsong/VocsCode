/**
 * Mission-owned Git workspaces and immutable trees. No commits, stashes, source-index writes,
 * resets, forced removals, or automatic cleanup. Git worktrees are isolation, not a sandbox.
 * The coordinator owns task/review authorization; this layer owns content identity and CAS.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { slugify } from '../git';
import type { CaptureResult } from '../runtime';
import { writeJson } from '../util/fs';
import { assertMissionRemoteRouting, MissionGitFilterError, missionRemoteUrl, readMissionRemoteEndpoint, runMissionGit, sensitiveGitDiagnostic } from './git-boundary';

export interface CodeRevision {
  readonly baseCommitSha: string;
  /** A host-written Git tree object, not a branch name or worker claim. */
  readonly contentHash: string;
}

export interface WorkspaceQuiescenceLease {
  /** Must fail if ownership is uncertain or a writer can have restarted. */
  assertQuiescent(): Promise<void>;
  release(): Promise<void> | void;
}

export interface WorkspaceQuiescenceProvider {
  /** Hold exclusive writer admission until release; null/undefined means busy/uncertain. Not an idle poll. */
  acquire(cwd: string): Promise<WorkspaceQuiescenceLease | null | undefined>;
}

export interface MissionWorkspacesOptions {
  /** App-owned storage, outside the source checkout (e.g. <userData>/mission-workspaces). */
  root: string;
  quiescence: WorkspaceQuiescenceProvider;
}

export interface MissionBaseline {
  readonly sourceCwd: string;
  readonly sourceRoot: string;
  readonly gitCommonDir: string;
  readonly revision: CodeRevision;
}

export interface BaselineChange {
  readonly path: string;
  readonly status: string;
}

export type BaselineProbe =
  | { ok: true; baseline: MissionBaseline }
  | { ok: false; reason: 'not_git' | 'unborn' | 'dirty' | 'busy' | 'unsafe' | 'changed'; message: string; changes: BaselineChange[] };

export type MissionWorkspaceRole = 'lead' | 'integration' | 'worker' | 'integration-attempt' | 'verification';

export interface MissionWorkspace {
  readonly id: string;
  readonly missionId: string;
  readonly role: MissionWorkspaceRole;
  readonly attemptId?: string;
  readonly operationId?: string;
  readonly cwd: string;
  readonly branch: string;
  readonly baseRevision: CodeRevision;
  /** Last host-accounted state; required when refreshing, not a promise that it is still current. */
  readonly fingerprint: string;
}

export interface CandidateChange {
  readonly path: string;
  readonly status: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldObjectSha: string;
  readonly newObjectSha: string;
}

export interface WorkspaceCandidate {
  readonly id: string;
  readonly missionId: string;
  readonly workspaceId: string;
  readonly attemptId: string;
  readonly baseRevision: CodeRevision;
  readonly revision: CodeRevision;
  /** Retains the staged version too, when unstaged edits differ from it. */
  readonly indexContentHash: string;
  readonly fingerprint: string;
  readonly changes: readonly CandidateChange[];
  readonly changedPaths: readonly string[];
  readonly createdAt: string;
  /** SHA-256 of the host-captured manifest (excluding this field). */
  readonly hostHash: string;
}

export interface IntegrationCheck {
  readonly workspace: MissionWorkspace;
  readonly revision: CodeRevision;
  readonly candidate: WorkspaceCandidate;
}

/** Host-observed approved branch. No caller-supplied commit is accepted by target integration. */
export interface TargetObservation {
  readonly id: string;
  readonly missionId: string;
  readonly operationId: string;
  readonly remote: string;
  readonly targetBranch: string;
  readonly remoteUrl: string;
  readonly commitSha: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly hostHash: string;
}

export interface TargetFetchAuthorization {
  missionId: string;
  operationId: string;
  cwd: string;
  remote: string;
  targetBranch: string;
  remoteUrl: string;
  /** Exact Git argv, including the fixed branch-to-owned-ref refspec. */
  args: string[];
}

export interface TargetIntegrationCheck {
  readonly workspace: MissionWorkspace;
  readonly revision: CodeRevision;
  readonly observation: TargetObservation;
}

export type IntegrationResult =
  | { status: 'accepted'; revision: CodeRevision; workspace: MissionWorkspace }
  | { status: 'stale'; revision: CodeRevision; workspace?: MissionWorkspace }
  | { status: 'conflict' | 'rejected' | 'changed'; revision: CodeRevision; workspace: MissionWorkspace; message: string };

export type WorkspaceCleanupResult =
  | { removed: true }
  | { removed: false; reason: 'busy' | 'uncaptured' | 'not_owned' | 'git_refused'; message: string };

export class MissionWorkspaceError extends Error {
  constructor(readonly code: 'busy' | 'unsafe' | 'drift' | 'not_owned' | 'git' | 'storage', message: string) {
    super(message);
    this.name = 'MissionWorkspaceError';
  }
}

interface MissionRecord {
  version: 1;
  baseline: MissionBaseline;
  acceptedRef: string;
  /** Written after the initial ref CAS; missing metadata can only reconcile, never reset a ref. */
  initialized?: true;
}

interface CaptureIntent {
  version: 1;
  id: string;
  missionId: string;
  workspaceId: string;
  attemptId: string;
  baseRevision: CodeRevision;
  fingerprint: string;
  createdAt: string;
  candidate?: WorkspaceCandidate;
}

interface WorkspaceRecord extends MissionWorkspace {
  version: 1;
  gitDir: string;
  state: 'provisioning' | 'ready' | 'refreshing' | 'removing' | 'removed';
  accounted?: Snapshot;
  integration?: { candidateId: string; expected: CodeRevision; status: string; result?: CodeRevision };
  /** The pinned source snapshot and exact target of an in-flight refresh/removal checkout. */
  transition?: { from: Snapshot; to: CodeRevision };
}

interface TargetObservationIntent {
  version: 1;
  id: string;
  missionId: string;
  operationId: string;
  remote: string;
  targetBranch: string;
  remoteUrl: string;
  workspaceId: string;
  createdAt: string;
  expectedHead?: string;
  stage: 'prepared' | 'fetching';
}

interface CandidateIntegrationReceipt {
  version: 1;
  id: string;
  missionId: string;
  candidateId: string;
  candidateHostHash: string;
  expected: CodeRevision;
  workspaceId: string;
  status: 'prepared' | 'applying' | 'conflict' | 'checking' | 'rejected' | 'changed' | 'promoting' | 'accepted' | 'stale';
  result?: CodeRevision;
  message?: string;
}

interface TargetIntegrationReceipt {
  version: 1;
  id: string;
  missionId: string;
  observationId: string;
  previousObservationId?: string;
  previousObservationObject?: string;
  expected: CodeRevision;
  fromTree: string;
  workspaceId: string;
  status: 'prepared' | 'applying' | 'conflict' | 'checking' | 'rejected' | 'changed' | 'promoting' | 'accepted' | 'stale';
  result?: CodeRevision;
  message?: string;
}

interface Snapshot {
  contentHash: string;
  indexContentHash: string;
  fingerprint: string;
}

// Shared by instances in the desktop process. Git's update-ref old-value CAS also covers other
// processes; no filesystem lock is silently stolen after a crash.
const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const equalPath = (a: string, b: string): boolean => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const contains = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const sameRevision = (a: CodeRevision, b: CodeRevision): boolean => a.baseCommitSha === b.baseCommitSha && a.contentHash === b.contentHash;
const revision = (baseCommitSha: string, contentHash: string): CodeRevision => Object.freeze({ baseCommitSha, contentHash });
// Bind the operation to identity AND base, not content equality or a caller's object key order.
const candidateIntegrationId = (missionId: string, candidateId: string, expected: CodeRevision): string => `i_${hash(JSON.stringify([missionId, candidateId, expected.baseCommitSha, expected.contentHash])).slice(0, 32)}`;

function identifier(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) throw new MissionWorkspaceError('unsafe', 'Invalid or nonportable Mission/workspace/artifact identifier.');
  return id;
}

function objectId(id: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) throw new MissionWorkspaceError('unsafe', 'Invalid Git object identity.');
  return id;
}

function gitPath(file: string, spellings?: Map<string, string>): void {
  // Portable names only. In particular, never let Windows aliases/ADS turn a Git path into an
  // administrative file or let a POSIX backslash become a Windows path separator on restore.
  const parts = file.split('/');
  if (!file || file.includes('\ufffd') || /[\\<>:"|?*\x00-\x1f]/.test(file) || parts.some((part) => !part || part === '.' || part === '..' || /^\.GIT(?:[ .]|$)/.test(part.toUpperCase()) || /^GIT~\d/.test(part.toUpperCase()) || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/.test(part.toUpperCase()) || /[ .]$/.test(part))) {
    throw new MissionWorkspaceError('unsafe', `Unsafe or unsupported Git path: ${JSON.stringify(file)}`);
  }
  if (spellings) {
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const key = prefix.normalize('NFC').toUpperCase();
      const previous = spellings.get(key);
      if (previous !== undefined && previous !== prefix) throw new MissionWorkspaceError('unsafe', `Aliased Git paths cannot be materialized portably: ${JSON.stringify(previous)}, ${JSON.stringify(prefix)}`);
      spellings.set(key, prefix);
    }
  }
}

async function git(cwd: string, args: string[], opts: { index?: string; input?: string; allowFailure?: boolean; filterCwd?: string } = {}): Promise<CaptureResult> {
  const result = await runMissionGit(cwd, args, opts).catch((error: unknown) => {
    if (error instanceof MissionGitFilterError) throw new MissionWorkspaceError('unsafe', error.message);
    throw error;
  });
  if (result.truncated || result.timedOut || (result.code !== 0 && !opts.allowFailure)) {
    const detail = sensitiveGitDiagnostic(args) ? ' Check the approved endpoint and noninteractive Git credentials.' : `: ${(result.stderr || result.stdout).trim()}`;
    throw new MissionWorkspaceError('git', `git ${args[0]} failed${result.truncated ? ' (output limit)' : ''}${detail}`);
  }
  return result;
}

async function gitText(cwd: string, args: string[], opts: { index?: string; input?: string } = {}): Promise<string> {
  return (await git(cwd, args, opts)).stdout.trim();
}

async function maybeStat(file: string): Promise<Stats | undefined> {
  try { return await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Inspect each component without following links/junctions, including an absent/deleted leaf. */
async function noLinks(root: string, file: string): Promise<void> {
  if (!contains(root, file)) throw new MissionWorkspaceError('unsafe', 'Path is outside its owned root.');
  let current = root;
  for (const part of ['', ...path.relative(root, file).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const stat = await maybeStat(current);
    if (stat?.isSymbolicLink()) throw new MissionWorkspaceError('unsafe', `Symlink/junction workspace paths are not supported: ${current}`);
  }
}

/** Fail closed on Git links/submodules until their capture and materialization have explicit policy. */
async function safeTree(cwd: string, tree: string): Promise<void> {
  objectId(tree);
  if (await gitText(cwd, ['cat-file', '-t', tree]) !== 'tree') throw new MissionWorkspaceError('unsafe', 'Expected an immutable tree object.');
  const entries = (await git(cwd, ['ls-tree', '-rz', tree])).stdout.split('\0').filter(Boolean);
  const spellings = new Map<string, string>();
  for (const entry of entries) {
    const match = /^(\d{6}) \w+ [0-9a-f]+\t([\s\S]+)$/.exec(entry);
    if (!match || !['100644', '100755'].includes(match[1])) throw new MissionWorkspaceError('unsafe', 'Submodule and symlink trees are not supported for Mission execution.');
    gitPath(match[2], spellings);
  }
}

function publicWorkspace(record: WorkspaceRecord): MissionWorkspace {
  return Object.freeze({ id: record.id, missionId: record.missionId, role: record.role, ...(record.attemptId ? { attemptId: record.attemptId } : {}), ...(record.operationId ? { operationId: record.operationId } : {}), cwd: record.cwd, branch: record.branch, baseRevision: revision(record.baseRevision.baseCommitSha, record.baseRevision.contentHash), fingerprint: record.fingerprint });
}

export class MissionWorkspaces {
  private root?: string;
  /** Existing stores keep their original namespace; new refs do not rename retained history. */
  private readonly refNamespaces = new Map<string, string>();
  /** Reuse only this async owner's live lease, never another concurrent caller's lease. */
  private readonly leases = new AsyncLocalStorage<ReadonlyMap<string, { lease: WorkspaceQuiescenceLease; active: boolean }>>();

  constructor(private readonly options: MissionWorkspacesOptions) {}

  /** Read-only even for dirty/unborn/plain folders: never initialize, stash, or omit changes. */
  async probeBaseline(sourceCwd: string): Promise<BaselineProbe> {
    const blocked = (reason: Extract<BaselineProbe, { ok: false }>['reason'], note: string, changes: BaselineChange[] = []): BaselineProbe => ({ ok: false, reason, message: note, changes });
    const rootProbe = await git(sourceCwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    if (rootProbe.code !== 0) return blocked('not_git', 'Choose an existing Git checkout; Mission does not initialize repositories.');
    const sourceRoot = await fs.realpath(rootProbe.stdout.trim());
    const lease = await this.options.quiescence.acquire(sourceRoot);
    if (!lease) return blocked('busy', 'Stop or yield the source writer before choosing a baseline.');
    try {
      await lease.assertQuiescent();
      const head = await git(sourceRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true });
      if (head.code !== 0) return blocked('unborn', 'Create the first commit outside Mission before starting execution.');
      const status = await this.status(sourceRoot);
      const changes = status.split('\0').filter(Boolean).map((line) => ({ path: line.slice(3), status: line.slice(0, 2) }));
      if (changes.length) return blocked('dirty', 'Commit or clean the listed source changes outside Mission; dirty overlays are not supported.', changes);
      await this.checkIndexFlags(sourceRoot);
      const sha = objectId(head.stdout.trim());
      const tree = await gitText(sourceRoot, ['rev-parse', `${sha}^{tree}`]);
      await safeTree(sourceRoot, tree);
      // status can report clean using only cached file stats. Verify the effective bytes through
      // the same fresh-index capture as candidates, without refreshing the user's real index.
      await this.storage(sourceRoot);
      const gitDir = await fs.realpath(await gitText(sourceRoot, ['rev-parse', '--absolute-git-dir']));
      const snapshot = await this.snapshot({ cwd: sourceRoot, gitDir }, lease);
      if (snapshot.contentHash !== tree || snapshot.indexContentHash !== tree) {
        const changed = new Map<string, string>();
        for (const change of await this.changes(sourceRoot, tree, snapshot.indexContentHash)) changed.set(change.path, `${change.status} `);
        for (const change of await this.changes(sourceRoot, snapshot.indexContentHash, snapshot.contentHash)) changed.set(change.path, `${changed.get(change.path)?.[0] ?? ' '}${change.status}`);
        return blocked('dirty', 'Source bytes differ from the baseline despite cached Git status; commit or clean them outside Mission.', [...changed].map(([file, state]) => ({ path: file, status: state })));
      }
      await lease.assertQuiescent();
      if (sha !== await gitText(sourceRoot, ['rev-parse', 'HEAD^{commit}']) || status !== await this.status(sourceRoot)) return blocked('changed', 'Source changed during baseline selection; wait for its writer to settle.');
      const common = await fs.realpath(await gitText(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      return { ok: true, baseline: Object.freeze({ sourceCwd: await fs.realpath(sourceCwd), sourceRoot, gitCommonDir: common, revision: revision(sha, tree) }) };
    } catch (error) {
      if (error instanceof MissionWorkspaceError && error.code === 'unsafe') return blocked('unsafe', error.message);
      throw error;
    } finally { await lease.release(); }
  }

  /** Lead/integration and a named worker attempt are idempotent; distinct attempts never share cwd. */
  async provision(input: { missionId: string; baseline: MissionBaseline; role: 'lead' | 'integration' | 'worker'; attemptId?: string; workspaceId?: string }): Promise<MissionWorkspace> {
    identifier(input.missionId);
    if (input.attemptId !== undefined) identifier(input.attemptId);
    if (input.workspaceId !== undefined) identifier(input.workspaceId);
    if (!['lead', 'integration', 'worker'].includes(input.role) || (input.role === 'worker' && !input.attemptId)) throw new MissionWorkspaceError('unsafe', 'A worker workspace needs an attempt identity and a supported role.');
    await this.storage(input.baseline.sourceRoot);
    return this.queue(input.missionId, async () => {
      const mission = await this.ensureMission(input.missionId, input.baseline);
      const records = await this.records();
      if (input.role === 'lead' && !input.workspaceId && records.filter((record) => record.missionId === input.missionId && record.role === 'lead' && record.state !== 'removed').length > 1) throw new MissionWorkspaceError('not_owned', 'Multiple lead generations are retained; supply the current host-mapped workspace identity.');
      for (const record of records) {
        if (input.workspaceId && record.id.toLowerCase() === input.workspaceId.toLowerCase() && (record.id !== input.workspaceId || record.missionId !== input.missionId || record.role !== input.role || record.attemptId !== input.attemptId || record.state === 'removed')) throw new MissionWorkspaceError('not_owned', 'Preallocated workspace identity already belongs to another intent.');
        if (record.missionId === input.missionId && record.role === input.role && record.attemptId === input.attemptId && record.state !== 'removed') {
          // A user-authorized lead handover names a new workspace. The coordinator owns the one
          // current session mapping; this store retains older generations without reusing them.
          if (input.workspaceId && record.id !== input.workspaceId) {
            if (input.role === 'lead') continue;
            throw new MissionWorkspaceError('not_owned', 'This dispatch already owns a different workspace identity.');
          }
          return publicWorkspace(await this.recover(record, mission));
        }
      }
      return publicWorkspace(await this.createWorkspace(input.missionId, mission, input.role, await this.accepted(input.missionId, mission), input.attemptId, input.workspaceId));
    });
  }

  /** Retained selection, not another probe of the user's now possibly dirty or advanced checkout. */
  async baseline(missionId: string): Promise<MissionBaseline> {
    const { baseline } = await this.mission(missionId);
    return Object.freeze({ ...baseline, revision: revision(baseline.revision.baseCommitSha, baseline.revision.contentHash) });
  }

  /** Validate live Git ownership. The fingerprint remains the last accounted state, not new work. */
  async workspace(id: string): Promise<MissionWorkspace> {
    const record = await this.record(id);
    await this.owned(record, await this.mission(record.missionId));
    return publicWorkspace(record);
  }

  /** Current host record plus live Git ownership, including integration-attempt/verification scratch. */
  async workspaceAt(cwd: string): Promise<MissionWorkspace> {
    return publicWorkspace(await this.directory(cwd));
  }

  /** Exact registered worktree roots only; an enclosing directory or a path alias is not ownership. */
  async isOwnedDirectory(cwd: string): Promise<boolean> {
    try { await this.workspaceAt(cwd); return true; } catch { return false; }
  }

  /** Hold writer admission across a host check/delivery. Nested reads reuse only this owner's lease. */
  async withQuiescence<T>(cwd: string, run: () => Promise<T>): Promise<T> {
    const record = await this.directory(cwd);
    const inspect = async (lease: WorkspaceQuiescenceLease): Promise<T> => {
      await lease.assertQuiescent();
      await this.owned(await this.record(record.id), await this.mission(record.missionId));
      const result = await run();
      await lease.assertQuiescent();
      return result;
    };
    const held = this.leases.getStore()?.get(record.cwd);
    return held?.active ? inspect(held.lease) : this.quiet(record.cwd, inspect);
  }

  /** Host-computed effective Git tree; never stages, refreshes, or accounts for the real worktree.
   * No Mission queue: integration callbacks already hold admission and must not queue behind self.
   */
  async contentIdentity(cwd: string): Promise<CodeRevision> {
    return this.withQuiescence(cwd, async () => {
      const record = await this.directory(cwd);
      const held = this.leases.getStore()?.get(record.cwd);
      if (!held?.active) throw new MissionWorkspaceError('busy', 'Content identity requires a held workspace lease.');
      const snapshot = await this.snapshot(record, held.lease);
      await this.owned(record, await this.mission(record.missionId));
      await held.lease.assertQuiescent();
      return revision(record.baseRevision.baseCommitSha, snapshot.contentHash);
    });
  }

  /** Ambiguous/partially written work is retained and throws; recovery never resets or rehomes it. */
  async recoverWorkspace(id: string): Promise<MissionWorkspace> {
    const initial = await this.record(id);
    return this.queue(initial.missionId, async () => {
      const record = await this.record(id);
      const mission = await this.initializeAccepted(record.missionId, await this.mission(record.missionId));
      return publicWorkspace(await this.recover(record, mission));
    });
  }

  async reconcile(id: string): Promise<MissionWorkspace> {
    return this.recoverWorkspace(id);
  }

  async acceptedRevision(missionId: string): Promise<CodeRevision> {
    return this.queue(missionId, async () => this.accepted(missionId, await this.initializeAccepted(missionId, await this.mission(missionId))));
  }

  /** Every path a permitted delivery can publish, for policy holds: baseline→accepted (a local
   * commit; target refreshes and deletions absent from worker candidates included) and, once the
   * integrated target contains the baseline so a PR may be built on it, target→accepted. That PR
   * delta can hold paths the baseline delta does not, e.g. an upstream change the Mission reverts.
   * A baseline the target lacks can never be published remotely (delivery refuses it). */
  async acceptedChangedPaths(missionId: string): Promise<string[]> {
    return this.queue(missionId, async () => {
      const mission = await this.mission(missionId);
      const accepted = await this.accepted(missionId, mission);
      const cwd = mission.baseline.sourceRoot;
      const paths = new Set((await this.changes(cwd, mission.baseline.revision.contentHash, accepted.contentHash)).map((change) => change.path));
      const target = await this.integratedTargetObservation(missionId);
      if (target && (await git(cwd, ['merge-base', '--is-ancestor', mission.baseline.revision.baseCommitSha, objectId(target.commitSha)], { allowFailure: true })).code === 0) {
        for (const change of await this.changes(cwd, target.contentHash, accepted.contentHash)) paths.add(change.path);
      }
      return [...paths].sort();
    });
  }

  /** Host-only port: remote/branch come from the approved policy, never the model request.
   * Fetches exactly that branch into a unique retained ref, not FETCH_HEAD or tracking refs.
   * Once fetch is in flight, retries inspect that ref; an absent/changed ref is uncertainty,
   * not permission to fetch a different head under the same operation identity.
   */
  async observeApprovedTarget(input: { missionId: string; operationId: string; remote: string; targetBranch: string; authorize: (request: TargetFetchAuthorization) => Promise<void> }): Promise<TargetObservation> {
    identifier(input.operationId);
    for (const value of [input.remote, input.targetBranch]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) || value.includes('..') || value.includes('//') || value.endsWith('/') || value.split('/').some((part) => part.endsWith('.lock') || part.endsWith('.'))) throw new MissionWorkspaceError('unsafe', 'Invalid approved remote/branch.');
    }
    if (typeof input.authorize !== 'function') throw new MissionWorkspaceError('unsafe', 'Target fetch requires host authorization.');
    return this.queue(input.missionId, async () => {
      const mission = await this.mission(input.missionId);
      const id = `o_${hash(`${input.missionId}\0${input.operationId}`)}`;
      const matches = (value: Pick<TargetObservation, 'missionId' | 'operationId' | 'remote' | 'targetBranch'>): void => {
        if (value.missionId !== input.missionId || value.operationId !== input.operationId || value.remote !== input.remote || value.targetBranch !== input.targetBranch) throw new MissionWorkspaceError('not_owned', 'Target observation identity belongs to a different approved target.');
      };
      if (await maybeStat(this.file('target-observations', id))) {
        const observation = await this.targetObservation(id);
        matches(observation);
        return observation;
      }
      const file = this.file('target-observation-intents', id);
      let intent = await maybeStat(file) ? await this.json<TargetObservationIntent>(file) : undefined;
      if (intent) {
        matches(intent);
        if (intent.version !== 1 || intent.id !== id) throw new MissionWorkspaceError('storage', 'Invalid target observation intent.');
      }
      const record = intent ? await this.record(intent.workspaceId) : (await this.records()).find((w) => w.missionId === input.missionId && w.role === 'integration' && w.state === 'ready');
      if (!record || record.missionId !== input.missionId || record.role !== 'integration') throw new MissionWorkspaceError('not_owned', 'Target observation requires the owned integration workspace.');
      return this.quiet(record.cwd, async (lease) => {
        await this.owned(record, mission);
        const endpoint = async (): Promise<string> => {
          try {
            // Remote configuration belongs to the original source, not an owned worktree's cwd.
            const url = await readMissionRemoteEndpoint(mission.baseline.sourceRoot, input.remote);
            await assertMissionRemoteRouting(record.cwd, url);
            return url;
          } catch (error) { throw new MissionWorkspaceError('unsafe', message(error)); }
        };
        if (!intent) {
          const remoteUrl = await endpoint();
          intent = { version: 1, id, missionId: input.missionId, operationId: input.operationId, remote: input.remote, targetBranch: input.targetBranch, remoteUrl, workspaceId: record.id, createdAt: new Date().toISOString(), stage: 'prepared' };
          await this.immutable(file, intent);
        }
        // Older/interrupted receipts do not gain authority to publish an unsafe URL to an approval.
        if (missionRemoteUrl(intent.remoteUrl) !== intent.remoteUrl) throw new MissionWorkspaceError('unsafe', 'Retained target endpoint is not canonical; observe with a new operation identity.');
        const checkEndpoint = async (): Promise<void> => {
          if (await endpoint() !== intent!.remoteUrl) throw new MissionWorkspaceError('drift', 'Approved target endpoint changed; the retained operation cannot authorize its replacement.');
        };
        const commitRef = this.ref(input.missionId, `observations/${id}/commit`);
        if (intent.stage === 'prepared') {
          const args = ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-maintenance', '--refmap=', intent.remoteUrl, `refs/heads/${intent.targetBranch}:${commitRef}`];
          await input.authorize({ missionId: input.missionId, operationId: input.operationId, cwd: record.cwd, remote: intent.remote, targetBranch: intent.targetBranch, remoteUrl: intent.remoteUrl, args: [...args] });
          await lease.assertQuiescent();
          await this.owned(record, mission);
          await checkEndpoint();
          const rows = (await gitText(record.cwd, ['ls-remote', '--heads', intent.remoteUrl, `refs/heads/${intent.targetBranch}`])).split(/\r?\n/);
          const [head, ref] = rows[0].split(/\s+/);
          if (rows.length !== 1 || ref !== `refs/heads/${intent.targetBranch}`) throw new MissionWorkspaceError('git', 'Approved remote target is missing or ambiguous.');
          intent = { ...intent, expectedHead: objectId(head), stage: 'fetching' };
          await this.writeOwned(file, intent);
          await lease.assertQuiescent();
          await checkEndpoint();
          await git(record.cwd, args);
        }
        const fetched = await git(record.cwd, ['rev-parse', '--verify', '--quiet', commitRef], { allowFailure: true });
        if (fetched.code !== 0 || fetched.stdout.trim() !== intent.expectedHead) throw new MissionWorkspaceError('drift', 'Target fetch outcome is uncertain or the branch advanced during fetch; retain this intent and observe with a new operation identity.');
        const commitSha = objectId(fetched.stdout.trim());
        if (await gitText(record.cwd, ['cat-file', '-t', commitSha]) !== 'commit') throw new MissionWorkspaceError('unsafe', 'Approved target is not a commit.');
        const contentHash = await gitText(record.cwd, ['rev-parse', `${commitSha}^{tree}`]);
        await safeTree(record.cwd, contentHash);
        const data = { id, missionId: input.missionId, operationId: input.operationId, remote: intent.remote, targetBranch: intent.targetBranch, remoteUrl: intent.remoteUrl, commitSha, contentHash, createdAt: intent.createdAt };
        const observation = { ...data, hostHash: hash(JSON.stringify(data)) };
        await lease.assertQuiescent();
        // This is a receipt blob, never an unverified checkpoint commit or an arbitrary tree.
        const receiptObject = await gitText(record.cwd, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(observation) });
        const receiptRef = this.ref(input.missionId, `observations/${id}/receipt`);
        const existing = await git(record.cwd, ['rev-parse', '--verify', '--quiet', receiptRef], { allowFailure: true });
        if (existing.code === 0 && existing.stdout.trim() !== receiptObject) throw new MissionWorkspaceError('storage', 'Target receipt ref changed.');
        if (existing.code !== 0) {
          await lease.assertQuiescent();
          await git(record.cwd, ['update-ref', receiptRef, receiptObject, '0'.repeat(receiptObject.length)]);
        }
        await this.immutable(this.file('target-observations', id), observation);
        return Object.freeze(observation);
      });
    });
  }

  async targetObservation(id: string): Promise<TargetObservation> {
    const observation = await this.json<TargetObservation>(this.file('target-observations', id));
    const { hostHash, ...data } = observation;
    if (observation.id !== id || hash(JSON.stringify(data)) !== hostHash || id !== `o_${hash(`${observation.missionId}\0${observation.operationId}`)}`) throw new MissionWorkspaceError('storage', 'Target observation integrity check failed.');
    if (missionRemoteUrl(observation.remoteUrl) !== observation.remoteUrl) throw new MissionWorkspaceError('unsafe', 'Retained observation endpoint is not canonical; observe with a new operation identity.');
    const mission = await this.mission(observation.missionId);
    await this.repository(mission);
    const cwd = mission.baseline.sourceRoot;
    const ref = this.ref(observation.missionId, `observations/${id}`);
    if (await gitText(cwd, ['rev-parse', `${ref}/commit`]) !== objectId(observation.commitSha)
      || await gitText(cwd, ['rev-parse', `${observation.commitSha}^{tree}`]) !== objectId(observation.contentHash)
      || await gitText(cwd, ['cat-file', 'blob', `${ref}/receipt`]) !== JSON.stringify(observation)) throw new MissionWorkspaceError('storage', 'Retained target observation does not match its Git receipt.');
    await safeTree(cwd, observation.contentHash);
    return Object.freeze(observation);
  }

  /** The pointer advances atomically with accepted content, including acknowledgment-loss recovery. */
  async integratedTargetObservation(missionId: string): Promise<TargetObservation | undefined> {
    const mission = await this.mission(missionId);
    const result = await git(mission.baseline.sourceRoot, ['rev-parse', '--verify', '--quiet', this.ref(missionId, 'integrated-target')], { allowFailure: true });
    if (result.code === 1) return undefined;
    if (result.code !== 0) throw new MissionWorkspaceError('git', 'Unable to read integrated target identity.');
    const stored = JSON.parse(await gitText(mission.baseline.sourceRoot, ['cat-file', 'blob', objectId(result.stdout.trim())])) as TargetObservation;
    const observation = await this.targetObservation(stored.id);
    if (observation.missionId !== missionId || JSON.stringify(observation) !== JSON.stringify(stored)) throw new MissionWorkspaceError('storage', 'Integrated target receipt belongs to another observation.');
    return observation;
  }

  /** Stable operation identity; only host-recorded trees from this Mission are admissible. */
  async provisionVerification(input: { missionId: string; revision: CodeRevision; operationId: string }): Promise<MissionWorkspace> {
    identifier(input.operationId);
    objectId(input.revision.baseCommitSha);
    objectId(input.revision.contentHash);
    return this.queue(input.missionId, async () => {
      const mission = await this.initializeAccepted(input.missionId, await this.mission(input.missionId));
      await this.authorizeRevision(input.missionId, mission, input.revision);
      const id = `v_${hash(`${input.missionId}\0${input.operationId}`)}`;
      const existing = await maybeStat(this.file('workspaces', id));
      let record: WorkspaceRecord;
      if (existing) {
        record = await this.record(id);
        if (record.missionId !== input.missionId || record.role !== 'verification' || record.operationId !== input.operationId) throw new MissionWorkspaceError('not_owned', 'Verification operation ownership changed.');
        if (!sameRevision(record.baseRevision, input.revision)) throw new MissionWorkspaceError('drift', 'Verification operation is already bound to a different revision.');
        record = await this.recover(record, mission);
      } else {
        record = await this.createWorkspace(input.missionId, mission, 'verification', input.revision, undefined, id, input.operationId);
      }
      return this.quiet(record.cwd, async (lease) => {
        await this.owned(record, mission);
        await this.retireHostDependencies(record);
        const snapshot = await this.snapshot(record, lease);
        if (snapshot.contentHash !== input.revision.contentHash || snapshot.indexContentHash !== input.revision.contentHash || snapshot.fingerprint !== record.fingerprint || await this.ignored(record.cwd)) throw new MissionWorkspaceError('drift', 'Verification workspace changed; retained instead of restoring over uncertain work.');
        return publicWorkspace(record);
      });
    });
  }

  async captureCandidate(workspaceId: string, attemptId: string, candidateId = `c_${randomUUID()}`): Promise<WorkspaceCandidate> {
    identifier(attemptId);
    identifier(candidateId);
    const initial = await this.record(workspaceId);
    return this.queue(initial.missionId, async () => {
      const record = await this.record(workspaceId);
      if (record.attemptId && record.attemptId !== attemptId) throw new MissionWorkspaceError('not_owned', 'Candidate attempt does not own this workspace.');
      const matches = (receipt: { id: string; missionId: string; workspaceId: string; attemptId: string }): void => {
        if (receipt.id !== candidateId || receipt.missionId !== record.missionId || receipt.workspaceId !== workspaceId || receipt.attemptId !== attemptId) throw new MissionWorkspaceError('not_owned', 'Candidate identity belongs to another capture intent.');
      };
      const file = this.file('candidates', candidateId);
      if (await maybeStat(file)) {
        const candidate = await this.candidate(candidateId);
        matches(candidate);
        return candidate;
      }
      const intentFile = this.file('captures', candidateId);
      let intent = await maybeStat(intentFile) ? await this.json<CaptureIntent>(intentFile) : undefined;
      if (intent) {
        matches(intent);
        if (intent.version !== 1) throw new MissionWorkspaceError('storage', 'Invalid capture intent.');
      }
      const mission = await this.mission(record.missionId);
      return this.quiet(record.cwd, async (lease) => {
        await this.owned(record, mission);
        if (!intent) {
          intent = { version: 1, id: candidateId, missionId: record.missionId, workspaceId, attemptId, baseRevision: record.baseRevision, fingerprint: await this.fingerprint(record.cwd), createdAt: new Date().toISOString() };
          await this.immutable(intentFile, intent);
        }
        if (!intent.candidate) {
          if (!sameRevision(intent.baseRevision, record.baseRevision) || intent.fingerprint !== await this.fingerprint(record.cwd)) throw new MissionWorkspaceError('drift', 'Interrupted capture no longer describes this workspace; retain it and use a new capture identity.');
          const snapshot = await this.snapshot(record, lease);
          if (snapshot.fingerprint !== intent.fingerprint) throw new MissionWorkspaceError('drift', 'Workspace changed since capture intent.');
          const changes = await this.changes(record.cwd, intent.baseRevision.contentHash, snapshot.contentHash);
          const data = {
            id: candidateId, missionId: record.missionId, workspaceId, attemptId,
            baseRevision: intent.baseRevision, revision: revision(intent.baseRevision.baseCommitSha, snapshot.contentHash),
            indexContentHash: snapshot.indexContentHash, fingerprint: snapshot.fingerprint,
            changes, changedPaths: changes.map((change) => change.path), createdAt: intent.createdAt,
          };
          intent = { ...intent, candidate: { ...data, hostHash: hash(JSON.stringify(data)) } };
          await this.writeOwned(intentFile, intent);
        }
        const candidate = intent.candidate!;
        matches(candidate);
        await this.validateCandidate(candidate, candidateId);
        const snapshot = { contentHash: candidate.revision.contentHash, indexContentHash: candidate.indexContentHash, fingerprint: candidate.fingerprint };
        await this.pin(record, candidateId, snapshot, lease);
        await this.immutable(file, candidate);
        // A resumed retention write must not account for a writer's later content (or roll back a
        // newer capture). The original immutable receipt is still returned without recapturing it.
        await lease.assertQuiescent();
        if (await this.fingerprint(record.cwd) === candidate.fingerprint) await this.save({ ...record, accounted: snapshot, fingerprint: snapshot.fingerprint });
        return candidate;
      });
    });
  }

  async candidatesForAttempt(missionId: string, attemptId: string): Promise<WorkspaceCandidate[]> {
    identifier(attemptId);
    await this.mission(missionId);
    const candidates = await this.candidates(missionId);
    return candidates.filter((candidate) => candidate.attemptId === attemptId);
  }

  /** Reads the host's retained manifest and Git objects; callers supply an id, never a claimed tree. */
  async candidate(candidateId: string): Promise<WorkspaceCandidate> {
    const candidate = await this.json<WorkspaceCandidate>(this.file('candidates', identifier(candidateId)));
    return this.validateCandidate(candidate, candidateId);
  }

  private async validateCandidate(candidate: WorkspaceCandidate, candidateId: string): Promise<WorkspaceCandidate> {
    const { hostHash, ...data } = candidate;
    if (candidate.id !== candidateId || hash(JSON.stringify(data)) !== hostHash) throw new MissionWorkspaceError('storage', 'Candidate manifest integrity check failed.');
    const mission = await this.mission(candidate.missionId);
    if (candidate.revision.baseCommitSha !== mission.baseline.revision.baseCommitSha || candidate.baseRevision.baseCommitSha !== candidate.revision.baseCommitSha) throw new MissionWorkspaceError('storage', 'Candidate baseline does not match its Mission.');
    await safeTree(mission.baseline.sourceRoot, candidate.revision.contentHash);
    await safeTree(mission.baseline.sourceRoot, candidate.baseRevision.contentHash);
    await safeTree(mission.baseline.sourceRoot, candidate.indexContentHash);
    return candidate;
  }

  /** Checks run once on a stable, base-bound attempt; an uncertain apply/check is never replayed. */
  async integrate(input: { missionId: string; candidateId: string; expectedAccepted: CodeRevision; check: (attempt: IntegrationCheck) => Promise<boolean> }): Promise<IntegrationResult> {
    objectId(input.expectedAccepted.baseCommitSha);
    objectId(input.expectedAccepted.contentHash);
    return this.queue(input.missionId, async () => {
      const mission = await this.mission(input.missionId);
      const candidate = await this.candidate(input.candidateId);
      if (candidate.missionId !== input.missionId) throw new MissionWorkspaceError('not_owned', 'Candidate belongs to another Mission.');
      const id = candidateIntegrationId(input.missionId, candidate.id, input.expectedAccepted);
      const file = this.file('candidate-integrations', id);
      let receipt = await maybeStat(file) ? await this.json<CandidateIntegrationReceipt>(file) : undefined;
      if (receipt && (receipt.version !== 1 || receipt.id !== id || receipt.workspaceId !== id || receipt.missionId !== input.missionId || receipt.candidateId !== candidate.id || receipt.candidateHostHash !== candidate.hostHash || !sameRevision(receipt.expected, input.expectedAccepted))) throw new MissionWorkspaceError('storage', 'Candidate integration receipt identity changed.');
      if (!receipt) {
        // Old random attempts cannot prove which CAS succeeded. Preserve them, including their
        // original refs, rather than laundering uncertainty into a new operation and new checks.
        if ((await this.records()).some((record) => record.missionId === input.missionId && record.integration?.candidateId === candidate.id && sameRevision(record.integration.expected, input.expectedAccepted))) throw new MissionWorkspaceError('drift', 'Legacy candidate integration is retained without replay; its promotion has no operation marker.');
        const previous = await this.accepted(input.missionId, mission);
        if (!sameRevision(previous, input.expectedAccepted)) return { status: 'stale', revision: previous };
        receipt = { version: 1, id, missionId: input.missionId, candidateId: candidate.id, candidateHostHash: candidate.hostHash, expected: previous, workspaceId: id, status: 'prepared' };
        // Intent precedes even worktree provisioning, so all retries keep this exact identity.
        await this.immutable(file, receipt);
      }
      const confirmed = await this.inspectIntegration(input);
      if (confirmed) return confirmed;
      if (receipt.status === 'accepted') throw new MissionWorkspaceError('storage', 'Missing candidate promotion acknowledgment; retained without replay.');
      if (receipt.status === 'applying' || receipt.status === 'checking') throw new MissionWorkspaceError('drift', 'Candidate integration was interrupted; its attempt is retained and will not be reapplied or rechecked under the same identity.');
      const save = async (patch: Partial<CandidateIntegrationReceipt>): Promise<void> => {
        receipt = { ...receipt!, ...patch };
        await this.writeOwned(file, receipt);
      };
      let record = await this.queue(input.missionId, async () => {
        if (!(await maybeStat(this.file('workspaces', id)))) {
          if (receipt!.status !== 'prepared') throw new MissionWorkspaceError('storage', 'Candidate attempt disappeared after effects; it cannot be recreated.');
          return this.createWorkspace(input.missionId, mission, 'integration-attempt', receipt!.expected, undefined, id, id);
        }
        const retained = await this.record(id);
        if (retained.missionId !== input.missionId || retained.role !== 'integration-attempt' || retained.operationId !== id || !sameRevision(retained.baseRevision, receipt!.expected)) throw new MissionWorkspaceError('not_owned', 'Candidate attempt no longer matches its durable intent.');
        if (receipt!.status === 'prepared') return this.recover(retained, mission);
        await this.owned(retained, mission);
        return retained;
      });
      if (['conflict', 'rejected', 'changed'].includes(receipt.status)) return { status: receipt.status as 'conflict' | 'rejected' | 'changed', revision: receipt.expected, workspace: publicWorkspace(record), message: receipt.message ?? 'Candidate integration did not pass.' };
      if (receipt.status === 'stale') return { status: 'stale', revision: await this.accepted(input.missionId, mission), workspace: publicWorkspace(record) };
      if (!['prepared', 'promoting'].includes(receipt.status)) throw new MissionWorkspaceError('storage', 'Invalid candidate integration stage; retained without replay.');
      return this.quiet(record.cwd, async (lease) => {
        await this.owned(record, mission);
        if (receipt!.status === 'prepared') {
          const previous = await this.accepted(input.missionId, mission);
          if (!sameRevision(previous, receipt!.expected)) {
            await save({ status: 'stale' });
            return { status: 'stale', revision: previous, workspace: publicWorkspace(record) };
          }
          const before = await this.snapshot(record, lease);
          if (before.fingerprint !== record.fingerprint || before.contentHash !== receipt!.expected.contentHash || before.indexContentHash !== before.contentHash || await this.ignored(record.cwd)) throw new MissionWorkspaceError('drift', 'Candidate attempt changed before apply; no files were overwritten.');
          const patch = (await git(record.cwd, ['diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', candidate.baseRevision.contentHash, candidate.revision.contentHash, '--'])).stdout;
          await save({ status: 'applying' });
          await lease.assertQuiescent();
          const applied = patch ? await git(record.cwd, ['apply', '--3way', '--index', '--whitespace=nowarn', '-'], { input: patch, allowFailure: true }) : { code: 0, stdout: '', stderr: '' };
          if (applied.code !== 0) {
            const note = (applied.stderr || applied.stdout).trim();
            await save({ status: 'conflict', message: note });
            return { status: 'conflict', revision: receipt!.expected, workspace: publicWorkspace(record), message: note };
          }
          const snapshot = await this.snapshot(record, lease);
          const next = revision(receipt!.expected.baseCommitSha, snapshot.contentHash);
          await this.pin(record, 'integrated', snapshot, lease);
          record = { ...record, accounted: snapshot, fingerprint: snapshot.fingerprint, integration: { candidateId: candidate.id, expected: receipt!.expected, status: 'checking', result: next } };
          await this.save(record);
          await save({ status: 'checking', result: next });
          let passed = false;
          let note = 'Required integrated checks did not pass.';
          try { passed = await input.check({ workspace: publicWorkspace(record), revision: next, candidate }) === true; } catch (error) { note = message(error); }
          await lease.assertQuiescent();
          const after = await this.snapshot(record, lease);
          if (after.fingerprint !== snapshot.fingerprint || after.contentHash !== snapshot.contentHash) {
            const note = 'Check workspace changed; evidence does not describe the resulting content.';
            await save({ status: 'changed', message: note });
            return { status: 'changed', revision: receipt!.expected, workspace: publicWorkspace(record), message: note };
          }
          if (!passed) {
            await save({ status: 'rejected', message: note });
            return { status: 'rejected', revision: receipt!.expected, workspace: publicWorkspace(record), message: note };
          }
          record = { ...record, integration: { ...record.integration!, status: 'promoting' } };
          await this.save(record);
          await save({ status: 'promoting' });
        }
        return this.queue(input.missionId, async (): Promise<IntegrationResult> => {
          const next = receipt!.result;
          if (!next || next.baseCommitSha !== receipt!.expected.baseCommitSha || !record.integration?.result || !sameRevision(record.integration.result, next) || record.integration.candidateId !== candidate.id || !sameRevision(record.integration.expected, receipt!.expected)) throw new MissionWorkspaceError('storage', 'Candidate promotion no longer matches its checked intent.');
          const snapshot = await this.snapshot(record, lease);
          if (snapshot.contentHash !== next.contentHash || snapshot.fingerprint !== record.fingerprint) throw new MissionWorkspaceError('drift', 'Check workspace changed before promotion.');
          await this.owned(record, mission);
          const marker = this.ref(input.missionId, `candidate-promotions/${id}`);
          // The create (never update) binds this exact operation atomically with accepted CAS.
          // Equal trees and later accepted revisions cannot masquerade as this acknowledgment.
          const transaction = `start\nupdate ${mission.acceptedRef} ${next.contentHash} ${receipt!.expected.contentHash}\ncreate ${marker} ${next.contentHash}\nprepare\ncommit\n`;
          await lease.assertQuiescent();
          const promoted = await git(record.cwd, ['update-ref', '--stdin'], { input: transaction, allowFailure: true });
          if (promoted.code !== 0) {
            const confirmed = await this.inspectIntegration(input);
            if (confirmed) return confirmed;
            await save({ status: 'stale' });
            return { status: 'stale', revision: await this.accepted(input.missionId, mission), workspace: publicWorkspace(record) };
          }
          await this.save({ ...record, integration: { ...record.integration!, status: 'accepted' } });
          await save({ status: 'accepted' });
          return { status: 'accepted', revision: next, workspace: publicWorkspace(record) };
        });
      });
    }, 'integration');
  }

  /** Passive crash reconciliation: no provisioning, recovery, captures, checks, or ref writes. */
  async inspectIntegration(input: { missionId: string; candidateId: string; expectedAccepted: CodeRevision }): Promise<Extract<IntegrationResult, { status: 'accepted' }> | undefined> {
    return this.inspectPromotion(input, 'candidate', input.candidateId);
  }

  /** Uses the existing target receipt key and its immutable atomic-promotion marker. */
  async inspectTargetIntegration(input: { missionId: string; observationId: string; expectedAccepted: CodeRevision }): Promise<Extract<IntegrationResult, { status: 'accepted' }> | undefined> {
    return this.inspectPromotion(input, 'target', input.observationId);
  }

  private async inspectPromotion(input: { missionId: string; expectedAccepted: CodeRevision }, kind: 'candidate' | 'target', artifactId: string): Promise<Extract<IntegrationResult, { status: 'accepted' }> | undefined> {
    identifier(input.missionId);
    identifier(artifactId);
    objectId(input.expectedAccepted.baseCommitSha);
    objectId(input.expectedAccepted.contentHash);
    // Deliberately bypass json/mission/record/owned: their storage() calls may mkdir. Even an
    // entirely absent store must remain absent when the coordinator inspects receipts on boot.
    if (!(await maybeStat(path.resolve(this.options.root)))) return undefined;
    const root = await fs.realpath(this.options.root);
    if (this.root && !equalPath(root, this.root)) throw new MissionWorkspaceError('unsafe', 'Mission storage location changed.');
    const read = async <T>(folder: string, id: string): Promise<T | undefined> => {
      const file = path.join(root, folder, `${identifier(id)}.json`);
      await noLinks(root, file);
      await this.portableIdentity(file);
      try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    };
    const mission = await read<MissionRecord>('missions', input.missionId);
    if (!mission) return undefined;
    const compact = `refs/vocs-missions/${hash(`${root}\0${input.missionId}`).slice(0, 32)}`;
    const legacy = `refs/vocs-missions/${hash(root).slice(0, 20)}/${input.missionId}`;
    if (mission.version !== 1 || ![`${compact}/accepted`, `${legacy}/accepted`].includes(mission.acceptedRef) || contains(root, mission.baseline.sourceRoot) || contains(mission.baseline.sourceRoot, root)) throw new MissionWorkspaceError('storage', 'Mission workspace metadata is invalid.');
    if (input.expectedAccepted.baseCommitSha !== mission.baseline.revision.baseCommitSha) return undefined;
    const id = kind === 'candidate' ? candidateIntegrationId(input.missionId, artifactId, input.expectedAccepted) : `t_${hash(JSON.stringify([input.missionId, artifactId, input.expectedAccepted]))}`;
    const receipt = await read<CandidateIntegrationReceipt | TargetIntegrationReceipt>(`${kind}-integrations`, id);
    if (!receipt) return undefined;
    if (receipt.version !== 1 || receipt.id !== id || receipt.workspaceId !== id || receipt.missionId !== input.missionId || !sameRevision(receipt.expected, input.expectedAccepted) || (kind === 'candidate' ? (receipt as CandidateIntegrationReceipt).candidateId : (receipt as TargetIntegrationReceipt).observationId) !== artifactId) throw new MissionWorkspaceError('storage', 'Integration receipt identity changed.');
    if (!['promoting', 'accepted'].includes(receipt.status) || !receipt.result) return undefined;
    if (receipt.result.baseCommitSha !== input.expectedAccepted.baseCommitSha) throw new MissionWorkspaceError('storage', 'Integration result belongs to another baseline.');
    const record = await read<WorkspaceRecord>('workspaces', id);
    if (!record) return undefined;
    if (record.version !== 1 || record.id !== id || record.missionId !== input.missionId || record.role !== 'integration-attempt' || record.operationId !== id || !equalPath(record.cwd, path.join(root, 'worktrees', id)) || !sameRevision(record.baseRevision, input.expectedAccepted)) throw new MissionWorkspaceError('not_owned', 'Integration workspace no longer matches its durable intent.');
    await this.repository(mission);
    const cwd = mission.baseline.sourceRoot;
    const namespace = mission.acceptedRef.slice(0, -'/accepted'.length);
    const marker = await git(cwd, ['rev-parse', '--verify', '--quiet', `${namespace}/${kind}-promotions/${id}`], { allowFailure: true });
    if (marker.code === 1) return undefined;
    if (marker.code !== 0 || marker.stdout.trim() !== objectId(receipt.result.contentHash)) throw new MissionWorkspaceError('storage', 'Integration promotion marker conflicts with its receipt.');
    if (kind === 'candidate') {
      const candidate = await read<WorkspaceCandidate>('candidates', artifactId);
      if (!candidate) return undefined;
      const { hostHash, ...data } = candidate;
      if (candidate.id !== artifactId || candidate.missionId !== input.missionId || candidate.revision.baseCommitSha !== input.expectedAccepted.baseCommitSha || candidate.baseRevision.baseCommitSha !== input.expectedAccepted.baseCommitSha || hash(JSON.stringify(data)) !== hostHash || hostHash !== (receipt as CandidateIntegrationReceipt).candidateHostHash || record.integration?.candidateId !== artifactId || !sameRevision(record.integration.expected, receipt.expected) || !record.integration.result || !sameRevision(record.integration.result, receipt.result)) throw new MissionWorkspaceError('storage', 'Candidate integration no longer matches its captured identity.');
    } else {
      const observation = await read<TargetObservation>('target-observations', artifactId);
      if (!observation) return undefined;
      const { hostHash, ...data } = observation;
      if (observation.id !== artifactId || observation.missionId !== input.missionId || artifactId !== `o_${hash(`${input.missionId}\0${observation.operationId}`)}` || hash(JSON.stringify(data)) !== hostHash || missionRemoteUrl(observation.remoteUrl) !== observation.remoteUrl) throw new MissionWorkspaceError('storage', 'Target integration no longer matches its observed identity.');
      const ref = `${namespace}/observations/${artifactId}`;
      if (await gitText(cwd, ['rev-parse', `${ref}/commit`]) !== objectId(observation.commitSha) || await gitText(cwd, ['rev-parse', `${observation.commitSha}^{tree}`]) !== objectId(observation.contentHash) || await gitText(cwd, ['cat-file', 'blob', `${ref}/receipt`]) !== JSON.stringify(observation)) throw new MissionWorkspaceError('storage', 'Retained target observation does not match its Git receipt.');
    }
    await safeTree(cwd, receipt.result.contentHash);
    return { status: 'accepted', revision: revision(receipt.result.baseCommitSha, receipt.result.contentHash), workspace: publicWorkspace(record) };
  }

  /** Integrate only an observed approved target. The immutable source baseline never moves.
   * First contact uses the common ancestor (not a baseline-to-target replacement); subsequent
   * contacts apply the delta since the last integrated target, preserving Mission changes.
   */
  async integrateObservedTarget(input: { missionId: string; observationId: string; expectedAccepted: CodeRevision; check: (attempt: TargetIntegrationCheck) => Promise<boolean> }): Promise<IntegrationResult> {
    return this.queue(input.missionId, async () => {
      const mission = await this.mission(input.missionId);
      const observation = await this.targetObservation(input.observationId);
      if (observation.missionId !== input.missionId) throw new MissionWorkspaceError('not_owned', 'Target observation belongs to another Mission.');
      const id = `t_${hash(JSON.stringify([input.missionId, observation.id, input.expectedAccepted]))}`;
      const file = this.file('target-integrations', id);
      let receipt = await maybeStat(file) ? await this.json<TargetIntegrationReceipt>(file) : undefined;
      if (receipt && (receipt.version !== 1 || receipt.id !== id || receipt.workspaceId !== id || receipt.missionId !== input.missionId || receipt.observationId !== observation.id || !sameRevision(receipt.expected, input.expectedAccepted))) throw new MissionWorkspaceError('storage', 'Target integration receipt identity changed.');
      if (!receipt) {
        const previous = await this.accepted(input.missionId, mission);
        if (!sameRevision(previous, input.expectedAccepted)) return { status: 'stale', revision: previous };
        const integrated = await this.integratedTargetObservation(input.missionId);
        if (integrated && (integrated.remote !== observation.remote || integrated.targetBranch !== observation.targetBranch || integrated.remoteUrl !== observation.remoteUrl)) throw new MissionWorkspaceError('not_owned', 'Observed target changed the approved repository or branch.');
        let fromTree: string;
        let previousObservationObject: string | undefined;
        if (integrated) {
          if ((await git(mission.baseline.sourceRoot, ['merge-base', '--is-ancestor', integrated.commitSha, observation.commitSha], { allowFailure: true })).code !== 0) throw new MissionWorkspaceError('drift', 'Remote target history was rewritten; explicit reconciliation is required.');
          fromTree = integrated.contentHash;
          previousObservationObject = await gitText(mission.baseline.sourceRoot, ['rev-parse', this.ref(input.missionId, `observations/${integrated.id}/receipt`)]);
        } else {
          const ancestors = (await gitText(mission.baseline.sourceRoot, ['merge-base', '--all', mission.baseline.revision.baseCommitSha, observation.commitSha])).split(/\r?\n/);
          if (ancestors.length !== 1) throw new MissionWorkspaceError('drift', 'Target has no unambiguous common ancestor with the source baseline.');
          fromTree = await gitText(mission.baseline.sourceRoot, ['rev-parse', `${objectId(ancestors[0])}^{tree}`]);
        }
        await safeTree(mission.baseline.sourceRoot, fromTree);
        receipt = { version: 1, id, missionId: input.missionId, observationId: observation.id, previousObservationId: integrated?.id, previousObservationObject, expected: previous, fromTree, workspaceId: id, status: 'prepared' };
        await this.immutable(file, receipt);
      }
      const save = async (patch: Partial<TargetIntegrationReceipt>): Promise<void> => {
        receipt = { ...receipt!, ...patch };
        await this.writeOwned(file, receipt);
      };
      let record = await this.queue(input.missionId, async () => {
        if (!(await maybeStat(this.file('workspaces', id)))) {
          if (receipt!.status !== 'prepared') throw new MissionWorkspaceError('storage', 'Target attempt disappeared after effects; it cannot be recreated.');
          return this.createWorkspace(input.missionId, mission, 'integration-attempt', receipt!.expected, undefined, id, id);
        }
        const retained = await this.record(id);
        if (retained.missionId !== input.missionId || retained.role !== 'integration-attempt' || retained.operationId !== id || !sameRevision(retained.baseRevision, receipt!.expected)) throw new MissionWorkspaceError('not_owned', 'Target attempt no longer matches its durable intent.');
        return this.recover(retained, mission);
      });
      const marker = this.ref(input.missionId, `target-promotions/${id}`);
      // The transaction marker proves this exact check/promotion even if later integrations have
      // advanced acceptance. Never infer success just because two operations produced equal trees.
      const promoted = await git(record.cwd, ['rev-parse', '--verify', '--quiet', marker], { allowFailure: true });
      if (promoted.code === 0) {
        if (!receipt.result || promoted.stdout.trim() !== receipt.result.contentHash || !['promoting', 'accepted'].includes(receipt.status)) throw new MissionWorkspaceError('storage', 'Target promotion marker conflicts with its receipt.');
        await save({ status: 'accepted' });
        return { status: 'accepted', revision: receipt.result, workspace: publicWorkspace(record) };
      }
      if (promoted.code !== 1 || receipt.status === 'accepted') throw new MissionWorkspaceError('storage', 'Missing target promotion acknowledgment; retained without replay.');
      if (['conflict', 'rejected', 'changed'].includes(receipt.status)) return { status: receipt.status as 'conflict' | 'rejected' | 'changed', revision: receipt.expected, workspace: publicWorkspace(record), message: receipt.message ?? 'Target integration did not pass.' };
      if (receipt.status === 'stale') return { status: 'stale', revision: await this.accepted(input.missionId, mission), workspace: publicWorkspace(record) };
      if (receipt.status === 'applying' || receipt.status === 'checking') throw new MissionWorkspaceError('drift', 'Target integration was interrupted; its attempt is retained and will not be reapplied or rechecked under the same identity.');
      return this.quiet(record.cwd, async (lease) => {
        await this.owned(record, mission);
        if (receipt!.status === 'prepared') {
          const before = await this.snapshot(record, lease);
          if (before.fingerprint !== record.fingerprint || before.contentHash !== receipt!.expected.contentHash || before.indexContentHash !== before.contentHash || await this.ignored(record.cwd)) throw new MissionWorkspaceError('drift', 'Target attempt changed before apply; no files were overwritten.');
          const patch = (await git(record.cwd, ['diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', receipt!.fromTree, observation.contentHash, '--'])).stdout;
          await save({ status: 'applying' });
          await lease.assertQuiescent();
          const applied = patch ? await git(record.cwd, ['apply', '--3way', '--index', '--whitespace=nowarn', '-'], { input: patch, allowFailure: true }) : { code: 0, stdout: '', stderr: '' };
          if (applied.code !== 0) {
            const note = (applied.stderr || applied.stdout).trim();
            await save({ status: 'conflict', message: note });
            return { status: 'conflict', revision: receipt!.expected, workspace: publicWorkspace(record), message: note };
          }
          const snapshot = await this.snapshot(record, lease);
          const next = revision(mission.baseline.revision.baseCommitSha, snapshot.contentHash);
          await this.pin(record, 'target-integrated', snapshot, lease);
          record = { ...record, accounted: snapshot, fingerprint: snapshot.fingerprint };
          await this.save(record);
          await save({ status: 'checking', result: next });
          let passed = false;
          let note = 'Required target integration checks did not pass.';
          try { passed = await input.check({ workspace: publicWorkspace(record), revision: next, observation }) === true; } catch (error) { note = message(error); }
          await lease.assertQuiescent();
          const after = await this.snapshot(record, lease);
          if (after.fingerprint !== snapshot.fingerprint || after.contentHash !== snapshot.contentHash) {
            const note = 'Target check workspace changed; evidence does not describe the resulting content.';
            await save({ status: 'changed', message: note });
            return { status: 'changed', revision: receipt!.expected, workspace: publicWorkspace(record), message: note };
          }
          if (!passed) {
            await save({ status: 'rejected', message: note });
            return { status: 'rejected', revision: receipt!.expected, workspace: publicWorkspace(record), message: note };
          }
          await save({ status: 'promoting' });
        }
        return this.queue(input.missionId, async (): Promise<IntegrationResult> => {
          const next = receipt!.result!;
          const snapshot = await this.snapshot(record, lease);
          if (!next || snapshot.contentHash !== next.contentHash || snapshot.fingerprint !== record.fingerprint) throw new MissionWorkspaceError('drift', 'Target check workspace changed before promotion.');
          await this.owned(record, mission);
          const observationObject = await gitText(record.cwd, ['rev-parse', this.ref(input.missionId, `observations/${observation.id}/receipt`)]);
          // One transaction binds content, exact integrated observation and operation receipt. Even
          // an empty tree delta has a unique receipt, and another process cannot split these refs.
          const transaction = `start\nupdate ${mission.acceptedRef} ${next.contentHash} ${receipt!.expected.contentHash}\nupdate ${this.ref(input.missionId, 'integrated-target')} ${observationObject} ${receipt!.previousObservationObject ?? '0'.repeat(observationObject.length)}\ncreate ${marker} ${next.contentHash}\nprepare\ncommit\n`;
          await lease.assertQuiescent();
          const result = await git(record.cwd, ['update-ref', '--stdin'], { input: transaction, allowFailure: true });
          if (result.code !== 0) {
            await save({ status: 'stale' });
            return { status: 'stale', revision: await this.accepted(input.missionId, mission), workspace: publicWorkspace(record) };
          }
          await save({ status: 'accepted' });
          return { status: 'accepted', revision: next, workspace: publicWorkspace(record) };
        });
      });
    }, 'integration');
  }

  /** Refresh only an accounted, unchanged, exclusively yielded workspace. No checkpoint commit. */
  async materializeAccepted(workspaceId: string, expectedFingerprint: string): Promise<MissionWorkspace> {
    const initial = await this.record(workspaceId);
    return this.queue(initial.missionId, async () => {
      let record = await this.record(workspaceId);
      const mission = await this.mission(record.missionId);
      return this.quiet(record.cwd, async (lease) => {
        await this.owned(record, mission);
        const current = await this.snapshot(record, lease);
        if (!record.accounted || expectedFingerprint !== record.fingerprint || current.fingerprint !== expectedFingerprint) throw new MissionWorkspaceError('drift', 'Workspace has unaccounted changes; capture/reconcile them before refreshing.');
        const next = await this.accepted(record.missionId, mission);
        await this.guardTreePaths(record.cwd, next.contentHash, current.contentHash);
        const { transition: _stale, ...ready } = record;
        // The durable target makes an interrupted multi-step checkout resumable (see settle()).
        await this.save({ ...ready, state: 'refreshing', transition: { from: current, to: next } });
        try {
          await lease.assertQuiescent();
          await this.replaceAccounted(ready, current, next.contentHash, lease);
        } catch (error) {
          await this.restoreUnchanged(ready, current, next.contentHash, lease);
          throw error;
        }
        record = { ...ready, baseRevision: next };
        const after = await this.snapshot(record, lease);
        if (after.contentHash !== next.contentHash) throw new MissionWorkspaceError('drift', 'Materialized content does not match the accepted tree.');
        await this.pin(record, `refresh-${randomUUID()}`, after, lease);
        record = { ...record, state: 'ready', accounted: after, fingerprint: after.fingerprint };
        await this.save(record);
        return publicWorkspace(record);
      });
    });
  }

  /** Explicit only. Captured overlays can be removed; ignored/uncaptured bytes and conflicts stay. */
  async cleanup(workspaceId: string): Promise<WorkspaceCleanupResult> {
    let initial: WorkspaceRecord;
    try { initial = await this.record(workspaceId); } catch (error) { return { removed: false, reason: 'not_owned', message: message(error) }; }
    return this.queue(initial.missionId, async () => {
      try {
        let record = await this.record(workspaceId);
        const mission = await this.mission(record.missionId);
        const { transition: _transition, ...base } = record;
        if ((record.state === 'removing' || record.state === 'removed') && !(await maybeStat(record.cwd))) {
          // `worktree remove` already happened; only its acknowledgment was lost. Nothing is
          // deleted here, and a registration Git still holds is left for explicit repair.
          await noLinks(await this.storage(), record.cwd);
          if ((await this.worktrees(mission)).some((entry) => entry.some((field) => field.startsWith('worktree ') && equalPath(field.slice(9), record.cwd)))) return { removed: false, reason: 'git_refused', message: 'Git still registers the missing workspace; retained for reconciliation.' };
          if (record.state !== 'removed') await this.save({ ...base, state: 'removed' });
          return { removed: true };
        }
        return await this.quiet(record.cwd, async (lease): Promise<WorkspaceCleanupResult> => {
          // Finish an interrupted refresh/removal of our own before deciding what can be removed.
          if (record.state === 'refreshing' || record.state === 'removing') record = await this.settle(record, mission, lease);
          await this.owned(record, mission);
          await this.retireHostDependencies(record);
          const ignored = (await git(record.cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout;
          if (ignored) return { removed: false, reason: 'uncaptured', message: 'Ignored files are not captured; move or remove them explicitly before cleanup.' };
          const current = await this.snapshot(record, lease);
          if (!record.accounted || current.fingerprint !== record.accounted.fingerprint) return { removed: false, reason: 'uncaptured', message: 'Workspace changed since its last capture; nothing was removed.' };
          // Preserve both staged and effective content before making Git's ordinary (non-force)
          // remove possible. This is an explicit disposal of exactly the already-retained state.
          await this.pin(record, `cleanup-${randomUUID()}`, current, lease);
          const { transition: _stale, ...ready } = record;
          const removing: WorkspaceRecord = { ...ready, state: 'removing', transition: { from: current, to: mission.baseline.revision } };
          await this.save(removing);
          try {
            await lease.assertQuiescent();
            await this.replaceAccounted(ready, current, mission.baseline.revision.contentHash, lease);
          } catch (error) {
            await this.restoreUnchanged(ready, current, mission.baseline.revision.contentHash, lease);
            throw error;
          }
          await lease.assertQuiescent();
          // Git's non-force removal still discards ignored files. Check again after normalization,
          // not just before capture, so build output appearing during cleanup is never swept away.
          if ((await git(record.cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout) {
            // The pinned content is already normalized away; record that settled state honestly.
            await this.settle(removing, mission, lease);
            return { removed: false, reason: 'uncaptured', message: 'Ignored files appeared during cleanup; workspace retained for reconciliation.' };
          }
          await lease.assertQuiescent();
          await git(mission.baseline.sourceRoot, ['worktree', 'remove', record.cwd], { filterCwd: record.cwd });
          const { transition: _done, ...removed } = removing;
          await this.save({ ...removed, state: 'removed' });
          return { removed: true };
        });
      } catch (error) {
        return { removed: false, reason: error instanceof MissionWorkspaceError && error.code === 'busy' ? 'busy' : error instanceof MissionWorkspaceError && ['not_owned', 'unsafe'].includes(error.code) ? 'not_owned' : 'git_refused', message: message(error) };
      }
    });
  }

  private async status(cwd: string): Promise<string> {
    return (await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none'])).stdout;
  }

  private async quiet<T>(cwd: string, run: (lease: WorkspaceQuiescenceLease) => Promise<T>): Promise<T> {
    const lease = await this.options.quiescence.acquire(cwd);
    if (!lease) throw new MissionWorkspaceError('busy', 'Workspace is still running or its writer is uncertain.');
    const held = { lease, active: true };
    const leases = new Map(this.leases.getStore());
    leases.set(cwd, held);
    try {
      await lease.assertQuiescent();
      return await this.leases.run(leases, () => run(lease));
    } finally { held.active = false; await lease.release(); }
  }

  private async storage(sourceRoot?: string): Promise<string> {
    // Resolve the nearest existing parent before mkdir, so a configured junction cannot cause us
    // to write app metadata into the original checkout even for a not-yet-existing storage root.
    let existing = path.resolve(this.options.root);
    const tail: string[] = [];
    while (!(await maybeStat(existing))) { tail.unshift(path.basename(existing)); existing = path.dirname(existing); }
    const root = path.join(await fs.realpath(existing), ...tail);
    if (sourceRoot && (contains(sourceRoot, root) || contains(root, sourceRoot))) throw new MissionWorkspaceError('unsafe', 'Mission storage must be separate from the original checkout.');
    if (this.root && !equalPath(root, this.root)) throw new MissionWorkspaceError('unsafe', 'Mission storage location changed.');
    await fs.mkdir(root, { recursive: true });
    this.root = root;
    return root;
  }

  private file(kind: 'missions' | 'workspaces' | 'candidates' | 'captures' | 'candidate-integrations' | 'target-observations' | 'target-observation-intents' | 'target-integrations', id: string): string {
    return path.join(this.root ?? path.resolve(this.options.root), kind, `${identifier(id)}.json`);
  }

  /** A path can be spelled from the configured root before storage() pinned its canonical form
   * (8.3 short names, a junctioned/relocated profile, case). Rebase exactly that configured
   * spelling onto the canonical root; components below it are then link-checked as usual. */
  private async anchor(file: string): Promise<string> {
    const root = await this.storage();
    if (contains(root, file)) return file;
    const configured = path.resolve(this.options.root);
    if (!contains(configured, file)) throw new MissionWorkspaceError('unsafe', 'Path is outside its owned root.');
    return path.join(root, path.relative(configured, file));
  }

  private async json<T>(file: string): Promise<T> {
    file = await this.anchor(file);
    await noLinks(this.root!, file);
    await this.portableIdentity(file);
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  }

  /** Replace a mutable receipt/record in place (atomic rename), never through a link. */
  private async writeOwned(file: string, value: unknown): Promise<void> {
    file = await this.anchor(file);
    await noLinks(this.root!, file);
    await writeJson(file, value);
  }

  private async portableIdentity(file: string): Promise<void> {
    const dir = path.dirname(file);
    if (!(await maybeStat(dir))) return;
    const name = path.basename(file);
    if ((await fs.readdir(dir)).some((entry) => entry !== name && entry.toLowerCase() === name.toLowerCase())) throw new MissionWorkspaceError('unsafe', 'Case-aliased storage identifiers are not portable.');
  }

  private async immutable(file: string, value: unknown): Promise<void> {
    file = await this.anchor(file);
    await noLinks(this.root!, file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await this.portableIdentity(file);
    // Publish a complete fsynced file without replacing a competing intent. An interrupted write
    // leaves only an unreferenced temp file, never a torn manifest that looks like a receipt.
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
      await fs.link(temp, file);
    } finally { await fs.rm(temp, { force: true }); }
  }

  private async save(record: WorkspaceRecord): Promise<void> {
    await this.writeOwned(this.file('workspaces', record.id), record);
  }

  private async mission(id: string): Promise<MissionRecord> {
    const record = await this.json<MissionRecord>(this.file('missions', id));
    const compact = `refs/vocs-missions/${hash(`${this.root!}\0${identifier(id)}`).slice(0, 32)}`;
    const legacy = `refs/vocs-missions/${hash(this.root!).slice(0, 20)}/${id}`;
    if (record.version !== 1 || ![`${compact}/accepted`, `${legacy}/accepted`].includes(record.acceptedRef)) throw new MissionWorkspaceError('storage', 'Mission workspace metadata is invalid.');
    this.refNamespaces.set(id, record.acceptedRef.slice(0, -'/accepted'.length));
    await this.storage(record.baseline.sourceRoot);
    return record;
  }

  private async record(id: string): Promise<WorkspaceRecord> {
    const record = await this.json<WorkspaceRecord>(this.file('workspaces', id));
    if (record.version !== 1 || record.id !== id || !equalPath(record.cwd, path.join(this.root!, 'worktrees', identifier(id)))) throw new MissionWorkspaceError('not_owned', 'Workspace is not positively owned by this store.');
    return record;
  }

  private async directory(cwd: string): Promise<WorkspaceRecord> {
    await this.storage();
    // Do not realpath an arbitrary input into an owned path: a junction/short-name alias must
    // not turn a caller-controlled directory into authority to run checks or delivery there.
    if (!path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..') || !equalPath(path.dirname(cwd), path.join(this.root!, 'worktrees'))) throw new MissionWorkspaceError('not_owned', 'Expected an exact Mission-owned workspace directory.');
    const record = await this.record(path.basename(cwd));
    if (!equalPath(record.cwd, cwd) || !equalPath(await fs.realpath(cwd), record.cwd)) throw new MissionWorkspaceError('not_owned', 'Workspace path is not its registered directory.');
    await this.owned(record, await this.mission(record.missionId));
    return record;
  }

  private async records(): Promise<WorkspaceRecord[]> {
    const root = await this.storage();
    const dir = path.join(root, 'workspaces');
    await noLinks(root, dir);
    if (!(await maybeStat(dir))) return [];
    const files = await fs.readdir(dir);
    return Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => this.record(file.slice(0, -5))));
  }

  private async queue<T>(missionId: string, run: () => Promise<T>, lane = 'mutation'): Promise<T> {
    identifier(missionId);
    await this.storage();
    // Integration checks hold their worktree lease, not the mutation queue: their callback can
    // request fresh verification/worker workspaces from this same Mission without self-deadlock.
    return serialized(`${process.platform === 'win32' ? this.root!.toLowerCase() : this.root}\0${missionId.toLowerCase()}\0${lane}`, run);
  }

  private ref(missionId: string, suffix: string): string {
    const namespace = this.refNamespaces.get(identifier(missionId)) ?? `refs/vocs-missions/${hash(`${this.root!}\0${missionId}`).slice(0, 32)}`;
    // Nested request/workspace IDs can exceed Windows' loose-ref path limit. Hash their logical
    // identity together, not the content: tree and index remain distinct immutable retention refs.
    if (suffix.startsWith('retained/')) suffix = `retained/${hash(suffix.slice('retained/'.length)).slice(0, 32)}`;
    return `${namespace}/${suffix}`;
  }

  private async ensureMission(id: string, baseline: MissionBaseline): Promise<MissionRecord> {
    const file = this.file('missions', id);
    if (await maybeStat(file)) {
      const stored = await this.mission(id);
      if (!equalPath(stored.baseline.sourceRoot, baseline.sourceRoot) || !sameRevision(stored.baseline.revision, baseline.revision)) throw new MissionWorkspaceError('drift', 'Mission baseline is already fixed.');
      return this.initializeAccepted(id, stored);
    }
    const fresh = await this.probeBaseline(baseline.sourceCwd);
    if (!fresh.ok) throw new MissionWorkspaceError(fresh.reason === 'busy' ? 'busy' : 'drift', fresh.message);
    if (!sameRevision(fresh.baseline.revision, baseline.revision) || !equalPath(fresh.baseline.sourceRoot, baseline.sourceRoot) || !equalPath(fresh.baseline.gitCommonDir, baseline.gitCommonDir)) throw new MissionWorkspaceError('drift', 'Source baseline changed before provisioning.');
    const record: MissionRecord = { version: 1, baseline: fresh.baseline, acceptedRef: this.ref(id, 'accepted') };
    await this.immutable(file, record);
    return this.initializeAccepted(id, record);
  }

  private async repository(mission: MissionRecord): Promise<void> {
    const common = await fs.realpath(await gitText(mission.baseline.sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    if (!equalPath(common, mission.baseline.gitCommonDir)) throw new MissionWorkspaceError('not_owned', 'Mission source repository identity changed.');
    if (await gitText(mission.baseline.sourceRoot, ['rev-parse', `${objectId(mission.baseline.revision.baseCommitSha)}^{tree}`]) !== mission.baseline.revision.contentHash) throw new MissionWorkspaceError('storage', 'Retained baseline no longer identifies its original commit tree.');
  }

  private async initializeAccepted(id: string, mission: MissionRecord): Promise<MissionRecord> {
    if (mission.initialized) return mission;
    return this.quiet(mission.baseline.sourceRoot, async (lease) => {
      await this.repository(mission);
      const current = await git(mission.baseline.sourceRoot, ['rev-parse', '--verify', '--quiet', mission.acceptedRef], { allowFailure: true });
      if (current.code !== 0) {
        if (current.code !== 1 || (await this.records()).some((record) => record.missionId === id)) throw new MissionWorkspaceError('drift', 'Missing accepted ref is ambiguous; Mission work is retained.');
        await safeTree(mission.baseline.sourceRoot, mission.baseline.revision.contentHash);
        await lease.assertQuiescent();
        await git(mission.baseline.sourceRoot, ['update-ref', mission.acceptedRef, mission.baseline.revision.contentHash, '0'.repeat(mission.baseline.revision.contentHash.length)]);
      } else {
        await safeTree(mission.baseline.sourceRoot, current.stdout.trim());
      }
      const initialized: MissionRecord = { ...mission, initialized: true };
      await this.writeOwned(this.file('missions', id), initialized);
      return initialized;
    });
  }

  private async candidates(missionId: string): Promise<WorkspaceCandidate[]> {
    const root = await this.storage();
    const dir = path.join(root, 'candidates');
    await noLinks(root, dir);
    if (!(await maybeStat(dir))) return [];
    const candidates: WorkspaceCandidate[] = [];
    for (const file of (await fs.readdir(dir)).filter((file) => file.endsWith('.json'))) {
      const candidate = await this.json<WorkspaceCandidate>(this.file('candidates', file.slice(0, -5)));
      if (candidate.missionId === missionId) candidates.push(await this.validateCandidate(candidate, file.slice(0, -5)));
    }
    return candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private async authorizeRevision(id: string, mission: MissionRecord, requested: CodeRevision): Promise<void> {
    if (requested.baseCommitSha !== mission.baseline.revision.baseCommitSha) throw new MissionWorkspaceError('not_owned', 'Revision belongs to another Mission baseline.');
    if (sameRevision(requested, mission.baseline.revision) || sameRevision(requested, await this.accepted(id, mission))) return;
    if ((await this.candidates(id)).some((candidate) => sameRevision(candidate.revision, requested))) return;
    if ((await this.records()).some((record) => record.missionId === id && record.integration && (sameRevision(record.integration.expected, requested) || (record.integration.status === 'accepted' && record.integration.result && sameRevision(record.integration.result, requested))))) return;
    const root = await this.storage();
    const targets = path.join(root, 'target-integrations');
    await noLinks(root, targets);
    if (await maybeStat(targets)) for (const file of (await fs.readdir(targets)).filter((entry) => entry.endsWith('.json'))) {
      const receipt = await this.json<TargetIntegrationReceipt>(this.file('target-integrations', file.slice(0, -5)));
      if (receipt.missionId === id && receipt.result && ['checking', 'promoting', 'accepted'].includes(receipt.status) && sameRevision(receipt.result, requested)) return;
    }
    throw new MissionWorkspaceError('not_owned', 'Revision is not an accepted tree or a host-captured candidate for this Mission.');
  }

  private async accepted(_id: string, mission: MissionRecord): Promise<CodeRevision> {
    await this.repository(mission);
    const tree = await gitText(mission.baseline.sourceRoot, ['rev-parse', '--verify', mission.acceptedRef]);
    await safeTree(mission.baseline.sourceRoot, tree);
    return revision(mission.baseline.revision.baseCommitSha, tree);
  }

  private async owned(record: WorkspaceRecord, mission: MissionRecord): Promise<void> {
    if (record.state !== 'ready') throw new MissionWorkspaceError('not_owned', `Workspace needs reconciliation (${record.state}); no mutation is safe.`);
    await this.gitOwnership(record, mission);
  }

  private async worktrees(mission: MissionRecord): Promise<string[][]> {
    return (await git(mission.baseline.sourceRoot, ['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0\0').filter(Boolean).map((entry) => entry.split('\0').filter(Boolean));
  }

  /** Also usable before the worktree-add acknowledgment has stored its administrative path. */
  private async gitOwnership(record: WorkspaceRecord, mission: MissionRecord): Promise<string> {
    await this.storage(mission.baseline.sourceRoot);
    await noLinks(this.root!, record.cwd);
    const dotGit = path.join(record.cwd, '.git');
    await noLinks(record.cwd, dotGit);
    if (!(await maybeStat(dotGit))?.isFile() || equalPath(record.cwd, mission.baseline.sourceRoot)) throw new MissionWorkspaceError('not_owned', 'Expected the owned linked worktree, never the original checkout.');
    // Inspect a recorded administration path before asking Git to follow it. A substituted
    // junction can redirect commondir/config resolution even when the working directory is safe.
    if (record.gitDir) await noLinks(mission.baseline.gitCommonDir, record.gitDir);
    const gitDir = await fs.realpath(await gitText(record.cwd, ['rev-parse', '--absolute-git-dir']));
    const commonDir = await fs.realpath(await gitText(record.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const top = await fs.realpath(await gitText(record.cwd, ['rev-parse', '--show-toplevel']));
    const branch = await gitText(record.cwd, ['symbolic-ref', 'HEAD']);
    const head = await gitText(record.cwd, ['rev-parse', 'HEAD^{commit}']);
    if ((record.gitDir && !equalPath(gitDir, record.gitDir)) || !equalPath(top, record.cwd) || !equalPath(commonDir, mission.baseline.gitCommonDir) || !contains(path.join(commonDir, 'worktrees'), gitDir) || branch !== `refs/heads/${record.branch}` || head !== record.baseRevision.baseCommitSha || head !== mission.baseline.revision.baseCommitSha) throw new MissionWorkspaceError('not_owned', 'Workspace Git ownership or HEAD changed; reconcile instead of resetting it.');
    await noLinks(commonDir, path.join(gitDir, 'gitdir'));
    if (!equalPath((await fs.readFile(path.join(gitDir, 'gitdir'), 'utf8')).trim(), dotGit)) throw new MissionWorkspaceError('not_owned', 'Worktree administrative backlink changed.');
    const registrations = (await this.worktrees(mission)).filter((entry) => entry.some((field) => field.startsWith('worktree ') && equalPath(field.slice(9), record.cwd)));
    if (registrations.length !== 1 || !registrations[0].includes(`HEAD ${head}`) || !registrations[0].includes(`branch ${branch}`)) throw new MissionWorkspaceError('not_owned', 'Git no longer registers this owned worktree and branch.');
    return gitDir;
  }

  private async ignored(cwd: string): Promise<boolean> {
    return !!(await git(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout;
  }

  /** Conventional verification runs `npm ci` inside the isolated tree, leaving an ignored
   * top-level node_modules. That is host-owned scratch, not captured content, so verification and
   * integration-attempt workspaces retire it before an ignored-content check; every other role
   * keeps refusing. A link/junction, tracked content or a non-ignored path stays untouched. */
  private async retireHostDependencies(record: Pick<WorkspaceRecord, 'cwd' | 'role'>): Promise<void> {
    if (record.role !== 'verification' && record.role !== 'integration-attempt') return;
    const modules = path.join(record.cwd, 'node_modules');
    const stat = await fs.lstat(modules).catch(() => undefined);
    if (!stat) return;
    const probe = await git(record.cwd, ['check-ignore', '-q', '--', 'node_modules/.package-lock.json'], { allowFailure: true });
    if (probe.code !== 0) return;
    if (stat.isSymbolicLink()) throw new MissionWorkspaceError('unsafe', 'A linked node_modules cannot be retired; remove the link before cleaning this workspace.');
    if (!stat.isDirectory()) return;
    if ((await git(record.cwd, ['ls-files', '-z', '--', 'node_modules'])).stdout) return;
    await noLinks(record.cwd, modules);
    await fs.rm(modules, { recursive: true, force: true });
  }

  private async recover(record: WorkspaceRecord, mission: MissionRecord): Promise<WorkspaceRecord> {
    if (record.state === 'ready') { await this.owned(record, mission); return record; }
    if (record.state === 'refreshing' || record.state === 'removing') return this.quiet(record.cwd, (lease) => this.settle(record, mission, lease));
    if (record.state !== 'provisioning') throw new MissionWorkspaceError('not_owned', `Workspace retained for reconciliation (${record.state}); no automatic reset is safe.`);
    return this.quiet(record.cwd, async (lease) => {
      await this.repository(mission);
      await safeTree(mission.baseline.sourceRoot, record.baseRevision.contentHash);
      await noLinks(this.root!, record.cwd);
      if (!(await maybeStat(record.cwd))) {
        const registrations = await this.worktrees(mission);
        const branch = await git(mission.baseline.sourceRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`], { allowFailure: true });
        if (record.gitDir || branch.code !== 1 || registrations.some((entry) => entry.includes(`branch refs/heads/${record.branch}`) || entry.some((field) => field.startsWith('worktree ') && equalPath(field.slice(9), record.cwd)))) throw new MissionWorkspaceError('not_owned', 'Incomplete provisioning has an existing branch or registration; retained without reprovisioning.');
        await fs.mkdir(path.dirname(record.cwd), { recursive: true });
        await lease.assertQuiescent();
        await git(mission.baseline.sourceRoot, ['worktree', 'add', '--no-checkout', '-b', record.branch, record.cwd, objectId(record.baseRevision.baseCommitSha)]);
      }
      const gitDir = await this.gitOwnership(record, mission);
      record = { ...record, gitDir };
      await this.save(record);
      // Only a positively owned, entirely empty no-checkout worktree can be initialized. Partial
      // checkouts, edited bytes, ignored files and changed indexes are never reset to the intent.
      const files = await fs.readdir(record.cwd);
      const staged = (await git(record.cwd, ['ls-files', '--stage', '-z'])).stdout;
      if (files.every((file) => file === '.git') && !staged) {
        await lease.assertQuiescent();
        await git(record.cwd, ['read-tree', '-m', '-u', record.baseRevision.contentHash]);
      }
      if (await this.ignored(record.cwd)) throw new MissionWorkspaceError('drift', 'Uncaptured ignored content blocks provision recovery.');
      const snapshot = await this.snapshot(record, lease);
      if (snapshot.contentHash !== record.baseRevision.contentHash || snapshot.indexContentHash !== record.baseRevision.contentHash) throw new MissionWorkspaceError('drift', 'Provisioned workspace content differs from its intent; retained without resetting it.');
      await this.pin(record, 'initial', snapshot, lease);
      record = { ...record, state: 'ready', accounted: snapshot, fingerprint: snapshot.fingerprint };
      await this.save(record);
      return record;
    });
  }

  /** Finish this store's own interrupted refresh/removal checkout (a Windows file lock, another
   * tool's index.lock or a timeout must not strand the workspace). The source snapshot is pinned
   * and the target is a baseline/accepted tree, so completing it discards nothing. Every path in
   * the effective bytes and the index must still hold a version that transition explains; any
   * other byte is an unexplained writer and stays retained. Idempotent once settled. */
  private async settle(record: WorkspaceRecord, mission: MissionRecord, lease: WorkspaceQuiescenceLease): Promise<WorkspaceRecord> {
    if (record.state !== 'refreshing' && record.state !== 'removing') throw new MissionWorkspaceError('not_owned', `Workspace retained for reconciliation (${record.state}); no automatic reset is safe.`);
    await this.repository(mission);
    await this.gitOwnership(record, mission);
    const from = record.transition?.from ?? record.accounted;
    // Older intents did not record their target: removal always targets the baseline, and a
    // refresh can only be completed toward the current accepted tree (still path-verified).
    const to = record.transition?.to ?? (record.state === 'removing' ? mission.baseline.revision : await this.accepted(record.missionId, mission));
    if (!from) throw new MissionWorkspaceError('not_owned', `Workspace retained for reconciliation (${record.state}); it has no accounted snapshot to resume from.`);
    await this.authorizeRevision(record.missionId, mission, to);
    for (const tree of new Set([from.contentHash, from.indexContentHash, to.contentHash])) await safeTree(record.cwd, tree);
    const now = await this.snapshot(record, lease);
    const unexplained = await this.unexplained(record.cwd, now.contentHash, [from.contentHash, to.contentHash])
      ?? await this.unexplained(record.cwd, now.indexContentHash, [from.contentHash, from.indexContentHash, to.contentHash]);
    if (unexplained !== undefined) throw new MissionWorkspaceError('drift', `Interrupted ${record.state === 'removing' ? 'removal' : 'refresh'} left content its transition cannot explain (${unexplained}); retained without resetting it.`);
    if (now.contentHash !== to.contentHash || now.indexContentHash !== to.contentHash) {
      await lease.assertQuiescent();
      await this.replaceAccounted(record, now, to.contentHash, lease);
    }
    const after = await this.snapshot(record, lease);
    if (after.contentHash !== to.contentHash || after.indexContentHash !== to.contentHash) throw new MissionWorkspaceError('drift', 'Resumed checkout does not match its recorded target; retained for reconciliation.');
    const { transition: _transition, ...rest } = record;
    const settled: WorkspaceRecord = { ...rest, baseRevision: revision(to.baseCommitSha, to.contentHash), state: 'ready', accounted: after, fingerprint: after.fingerprint };
    await this.pin(settled, `settled-${randomUUID()}`, after, lease);
    await this.save(settled);
    return settled;
  }

  /** A failed checkout that provably changed nothing returns to its ready record at once, so an
   * ordinary retry works without a restart; anything else keeps its transition for settle(). */
  private async restoreUnchanged(ready: WorkspaceRecord, before: Snapshot, target: string, lease: WorkspaceQuiescenceLease): Promise<void> {
    try {
      await lease.assertQuiescent();
      // Fingerprints cover tracked and untracked bytes; a new target-only path could be ignored.
      await this.guardTreePaths(ready.cwd, target, before.contentHash);
      if (await this.fingerprint(ready.cwd) !== before.fingerprint) return;
      await lease.assertQuiescent();
      await this.save(ready);
    } catch { /* Retained in its transition state for settle(). */ }
  }

  /** First path of `tree` whose exact mode/blob matches none of `allowed`, if any. */
  private async unexplained(cwd: string, tree: string, allowed: string[]): Promise<string | undefined> {
    let remaining: Set<string> | undefined;
    for (const candidate of new Set(allowed)) {
      const differs = new Set((await this.changes(cwd, candidate, tree)).map((change) => change.path));
      remaining = remaining ? new Set([...remaining].filter((file) => differs.has(file))) : differs;
      if (!remaining.size) return undefined;
    }
    return remaining ? [...remaining].sort()[0] : undefined;
  }

  private async createWorkspace(id: string, mission: MissionRecord, role: MissionWorkspaceRole, base: CodeRevision, attemptId?: string, workspaceId = `w_${randomUUID()}`, operationId?: string): Promise<WorkspaceRecord> {
    identifier(workspaceId);
    await this.repository(mission);
    await safeTree(mission.baseline.sourceRoot, base.contentHash);
    const root = await this.storage();
    const cwd = path.join(root, 'worktrees', workspaceId);
    await noLinks(root, cwd);
    if (await maybeStat(cwd)) throw new MissionWorkspaceError('not_owned', 'Preallocated workspace path already exists; it was not adopted.');
    const branches = (await git(mission.baseline.sourceRoot, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).stdout.split(/\r?\n/).filter(Boolean).map((ref) => ref.slice('refs/heads/'.length).toLowerCase());
    const leaf = `${slugify(id)}-${role}-${randomUUID()}`;
    // A pre-existing branch named "mission" owns the entire namespace. Use a flat name rather
    // than creating mission/foo and failing (or ever replacing someone else's branch). Loose
    // refs are files, so on case-insensitive filesystems "Mission" claims the namespace too.
    const branch = `${branches.includes('mission') ? 'mission-' : 'mission/'}${leaf}`;
    const lower = branch.toLowerCase();
    if (branches.some((name) => name === lower || name.startsWith(`${lower}/`) || lower.startsWith(`${name}/`))) throw new MissionWorkspaceError('git', 'Mission branch namespace collision; no existing ref was changed.');
    const record: WorkspaceRecord = { version: 1, id: workspaceId, missionId: id, role, ...(attemptId ? { attemptId } : {}), ...(operationId ? { operationId } : {}), cwd, branch, baseRevision: base, fingerprint: '', gitDir: '', state: 'provisioning' };
    await this.immutable(this.file('workspaces', workspaceId), record);
    return this.recover(record, mission);
  }

  private async checkIndexFlags(cwd: string): Promise<void> {
    const entries = (await git(cwd, ['ls-files', '-v', '-z'])).stdout.split('\0').filter(Boolean);
    if (entries.some((entry) => entry[0] === 'S' || /[a-z]/.test(entry[0]))) throw new MissionWorkspaceError('unsafe', 'Sparse/assume-unchanged indexes can hide source edits; remove those flags outside Mission before execution.');
  }

  private async fingerprint(cwd: string): Promise<string> {
    await this.checkIndexFlags(cwd);
    const staged = (await git(cwd, ['ls-files', '--stage', '-z'])).stdout;
    for (const entry of staged.split('\0').filter(Boolean)) {
      if (!/^(100644|100755) [0-9a-f]+ 0\t/.test(entry)) throw new MissionWorkspaceError('unsafe', 'Unmerged entries, submodules, and symlinks require reconciliation.');
    }
    const files = [...new Set((await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean))].sort();
    const digest = createHash('sha256').update(await gitText(cwd, ['rev-parse', 'HEAD'])).update('\0').update(staged);
    const spellings = new Map<string, string>();
    for (const file of files) {
      gitPath(file, spellings);
      const absolute = path.join(cwd, file);
      await noLinks(cwd, absolute);
      const stat = await maybeStat(absolute);
      digest.update(JSON.stringify([file, stat?.isFile() ? stat.mode & 0o111 : null]));
      if (!stat) { digest.update('deleted\0'); continue; }
      if (!stat.isFile()) throw new MissionWorkspaceError('unsafe', `Nested repositories or non-regular files cannot be captured: ${file}`);
      const content = createHash('sha256');
      for await (const chunk of createReadStream(absolute)) content.update(chunk);
      digest.update(content.digest()).update('\0');
    }
    return digest.digest('hex');
  }

  private async snapshot(record: Pick<WorkspaceRecord, 'cwd' | 'gitDir'>, lease: WorkspaceQuiescenceLease): Promise<Snapshot> {
    await lease.assertQuiescent();
    const cwd = record.cwd;
    const before = await this.fingerprint(cwd);
    const root = await this.storage();
    const scratchRoot = path.join(root, 'scratch');
    await noLinks(root, scratchRoot);
    await fs.mkdir(scratchRoot, { recursive: true });
    const scratch = await fs.mkdtemp(path.join(scratchRoot, 'index-'));
    const index = path.join(scratch, 'index');
    try {
      const realIndex = await gitText(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
      await noLinks(record.gitDir, realIndex);
      await fs.copyFile(realIndex, index);
      await lease.assertQuiescent();
      const indexContentHash = await gitText(cwd, ['write-tree'], { index });
      const staged = (await git(cwd, ['ls-files', '--stage', '-z'], { index })).stdout;
      // Copying the real index preserves a stat cache that can falsely call changed bytes clean
      // (e.g. same size/mtime with core.trustctime=false). Rebuild entries with ZERO stat data so
      // add must read their bytes. Index-info also keeps ignored intent-to-add paths tracked;
      // reading only indexContentHash would lose them because write-tree omits intent-to-add.
      const effectiveIndex = path.join(scratch, 'effective');
      await lease.assertQuiescent();
      await git(cwd, ['read-tree', '--empty'], { index: effectiveIndex });
      await lease.assertQuiescent();
      if (staged) await git(cwd, ['update-index', '-z', '--index-info'], { index: effectiveIndex, input: staged });
      await lease.assertQuiescent();
      await git(cwd, ['add', '--all', '--', '.'], { index: effectiveIndex });
      await lease.assertQuiescent();
      const contentHash = await gitText(cwd, ['write-tree'], { index: effectiveIndex });
      await safeTree(cwd, contentHash);
      await safeTree(cwd, indexContentHash);
      await lease.assertQuiescent();
      if (before !== await this.fingerprint(cwd)) throw new MissionWorkspaceError('drift', 'Workspace changed during capture; no candidate was accepted.');
      return { contentHash, indexContentHash, fingerprint: before };
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  }

  private async pin(record: WorkspaceRecord, label: string, snapshot: Snapshot, lease: WorkspaceQuiescenceLease): Promise<void> {
    const ref = this.ref(record.missionId, `retained/${record.id}/${label}`);
    await lease.assertQuiescent();
    await git(record.cwd, ['update-ref', `${ref}/tree`, snapshot.contentHash]);
    await lease.assertQuiescent();
    await git(record.cwd, ['update-ref', `${ref}/index`, snapshot.indexContentHash]);
  }

  private async changes(cwd: string, from: string, to: string): Promise<CandidateChange[]> {
    const fields = (await git(cwd, ['diff-tree', '-r', '--raw', '-z', '--no-abbrev', '--no-renames', objectId(from), objectId(to)])).stdout.split('\0').filter(Boolean);
    const changes: CandidateChange[] = [];
    for (let i = 0; i < fields.length; i += 2) {
      const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])$/.exec(fields[i]);
      if (!match || !fields[i + 1]) throw new MissionWorkspaceError('git', 'Invalid tree-delta output.');
      gitPath(fields[i + 1]);
      changes.push({ path: fields[i + 1], status: match[5], oldMode: match[1], newMode: match[2], oldObjectSha: match[3], newObjectSha: match[4] });
    }
    return changes;
  }

  private async guardTreePaths(cwd: string, tree: string, from: string): Promise<void> {
    await safeTree(cwd, tree);
    const previous = new Set((await git(cwd, ['ls-tree', '-rz', '--name-only', objectId(from)])).stdout.split('\0').filter(Boolean));
    const files = (await git(cwd, ['ls-tree', '-rz', '--name-only', tree])).stdout.split('\0').filter(Boolean);
    for (const file of files) {
      const absolute = path.join(cwd, file);
      await noLinks(cwd, absolute);
      if (!previous.has(file) && await maybeStat(absolute)) throw new MissionWorkspaceError('drift', `Uncaptured path obstructs the accepted tree: ${file}`);
    }
  }

  private async replaceAccounted(record: WorkspaceRecord, current: Snapshot, tree: string, lease: WorkspaceQuiescenceLease): Promise<void> {
    await this.guardTreePaths(record.cwd, tree, current.contentHash);
    if (await this.fingerprint(record.cwd) !== current.fingerprint) throw new MissionWorkspaceError('drift', 'Workspace changed immediately before refresh; nothing was overwritten.');
    // Normalize only the index to its already-retained effective snapshot. The two-tree merge
    // then protects untracked obstructions and refuses unexpected local edits; never --reset/-f.
    await lease.assertQuiescent();
    await git(record.cwd, ['read-tree', current.contentHash]);
    // read-tree replaced cached stat data. Refresh verifies the retained bytes against that
    // index before the guarded two-tree checkout; otherwise Git reports every entry as stale.
    await lease.assertQuiescent();
    await git(record.cwd, ['update-index', '--refresh']);
    await lease.assertQuiescent();
    await git(record.cwd, ['read-tree', '-m', '-u', current.contentHash, objectId(tree)]);
  }
}
