/**
 * Mission mode's git: the Lead's and Builders' worktrees, landing a Builder's branch on the Lead's,
 * junction-safe cleanup, the Lead's read-only views of a Builder's work, and the one push + PR at
 * the end. Expected git failures come back as `{ ok: false, error }` (an actionable sentence for the
 * model or the user), never as a throw. Nothing here force-pushes or merges a PR.
 */
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { branchSlug } from '../../shared/branch-prefix';
import { createWorktree, gh, gitCreatePr, gitFolderBranch, gitRoot, removeWorktree } from '../git';
import { runCapture, which } from '../runtime';

export type GitOk<T extends object = object> = { ok: true } & T;
export interface GitFail {
  ok: false;
  error: string;
}
export type GitResult<T extends object = object> = GitOk<T> | GitFail;
/** `unavailable`: no `origin` remote or no signed-in `gh`, so the mission finishes on a local branch. */
export interface PrFail extends GitFail {
  unavailable?: true;
}
export type PrResult<T extends object = object> = GitOk<T> | PrFail;

/** Every mission branch starts with this: `mission/<slug>` for the Lead, `mission/<slug>-b<n>` for Builders. */
export const MISSION_BRANCH_PREFIX = 'mission';

const MAX_VIEW_CHARS = 60_000;
const LOCAL_TIMEOUT_MS = 20_000;
const MERGE_TIMEOUT_MS = 45_000;
const PUSH_TIMEOUT_MS = 120_000;

type Run = { code: number | null; stdout: string; stderr: string; timedOut?: boolean; truncated?: boolean };

const fail = (error: string): GitFail => ({ ok: false, error });
const unavailable = (error: string): PrFail => ({ ok: false, error, unavailable: true });
const firstLine = (r: Run, fallback: string): string => ((r.stderr || r.stdout).trim().split('\n')[0] || fallback).slice(0, 400);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Variables that would point git at another repository, index or config than the folder's own. */
const REPO_LOCATION_VARS = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|EXTERNAL_DIFF|DIFF_OPTS|PAGER)$/i;

/** Local operations: no inherited GIT_* at all, no prompts, no optional locks. */
function localEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

/** Pushes keep the user's transport settings (GIT_SSH_COMMAND, GIT_ASKPASS, proxies) but not repo overrides. */
function remoteEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!REPO_LOCATION_VARS.test(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: '0' };
}

/**
 * One git call. Repository config cannot run a program through fsmonitor, the pager or colors, and
 * pathspecs are literal, so a Builder-controlled file name or config cannot widen a read.
 */
async function git(cwd: string, args: string[], opts: { timeoutMs?: number; remote?: boolean } = {}): Promise<Run> {
  return runCapture(which('git') ?? 'git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], {
    cwd,
    timeoutMs: opts.timeoutMs ?? LOCAL_TIMEOUT_MS,
    env: opts.remote ? remoteEnv() : localEnv()
  });
}

const ok = (r: Run): boolean => r.code === 0 && !r.timedOut && !r.truncated;

/** Branch names this module hands to git; never an option, never a range. */
const validBranch = (b: string): boolean => /^[\w][\w./-]*$/.test(b) && !b.includes('..') && !b.endsWith('.lock') && !b.endsWith('/') && !b.endsWith('.');
/** A revision to diff or log from: a branch name or a commit id. */
const validRev = (r: string): boolean => validBranch(r) || /^[0-9a-f]{7,64}$/i.test(r);

async function revParse(cwd: string, rev: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const sha = r.stdout.trim();
  return ok(r) && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
}

/** true / false, or null when git could not answer (missing commit, timeout). */
async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean | null> {
  const r = await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (r.timedOut) return null;
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

// ---------------------------------------------------------------------------------------------
// State of one checkout

export interface StatusEntry {
  /** Porcelain v1 XY code, e.g. ` M`, `??`, `R `. */
  code: string;
  path: string;
}

/** `git status --porcelain` of one worktree, untracked files included. */
export async function statusPorcelain(cwd: string): Promise<GitResult<{ clean: boolean; entries: StatusEntry[] }>> {
  const r = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!ok(r)) return fail(r.timedOut ? 'git status timed out.' : `git status failed: ${firstLine(r, 'not a git repository')}`);
  const entries: StatusEntry[] = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    entries.push({ code, path: token.slice(3) });
    // A rename or copy is followed by its original path.
    if (code[0] === 'R' || code[0] === 'C') i++;
  }
  return { ok: true, clean: entries.length === 0, entries };
}

/** The commit this folder has checked out and its branch (absent when detached). */
export async function currentHead(cwd: string): Promise<GitResult<{ sha: string; branch?: string }>> {
  const sha = await revParse(cwd, 'HEAD');
  if (!sha) return fail('This folder has no commit checked out.');
  const b = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = ok(b) ? b.stdout.trim() : '';
  return { ok: true, sha, ...(branch ? { branch } : {}) };
}

/** The best common ancestor of two revisions: where a Builder's own changes start. */
export async function mergeBase(cwd: string, a: string, b: string): Promise<GitResult<{ sha: string }>> {
  if (!validRev(a) || !validRev(b)) return fail('Invalid revision.');
  const r = await git(cwd, ['merge-base', a, b]);
  const sha = r.stdout.trim();
  return ok(r) && /^[0-9a-f]{40,64}$/i.test(sha) ? { ok: true, sha } : fail(`No common ancestor of ${a} and ${b}.`);
}

// ---------------------------------------------------------------------------------------------
// Worktrees

export interface LeadWorktree {
  path: string;
  branch: string;
  /** False when the mission reuses the session's own worktree: the mission never deletes it. */
  owned: boolean;
  startSha: string;
  /** The branch the PR goes into: the project checkout's branch when the mission started. */
  baseBranch?: string;
  /** The project checkout had uncommitted changes, which the Lead's worktree does not carry. */
  uncommittedAtStart: boolean;
}

/**
 * The Lead's worktree. With `reuse` (the session already runs in a worktree on its own branch),
 * that worktree is the Lead's and stays the session's. Otherwise a new `mission/<slug>` worktree
 * starts at the project's HEAD commit; uncommitted changes stay behind in the project checkout.
 */
export async function ensureLeadWorktree(projectRoot: string, slug: string, reuse?: { cwd: string; branch: string }): Promise<GitResult<LeadWorktree>> {
  const root = await gitRoot(projectRoot);
  if (!root) return fail('This folder is not a git repository.');
  const base = await gitFolderBranch(root);
  const baseBranch = base.branch && !base.detached ? base.branch : undefined;
  if (reuse) {
    const head = await currentHead(reuse.cwd);
    if (!head.ok) return fail(`The session's worktree has no commit checked out: ${reuse.cwd}`);
    if (head.branch !== reuse.branch) return fail(`The session's worktree is not on its branch ${reuse.branch}; check that branch out again, then start the mission.`);
    const status = await statusPorcelain(reuse.cwd);
    if (!status.ok) return status;
    return { ok: true, path: reuse.cwd, branch: reuse.branch, owned: false, startSha: head.sha, ...(baseBranch && baseBranch !== reuse.branch ? { baseBranch } : {}), uncommittedAtStart: !status.clean };
  }
  const startSha = await revParse(root, 'HEAD');
  if (!startSha) return fail('The project has no commits yet. Make the first commit, then start the mission.');
  const status = await statusPorcelain(root);
  if (!status.ok) return status;
  try {
    const wt = await createWorktree(root, branchSlug(slug) || 'mission', { branchPrefix: MISSION_BRANCH_PREFIX, startPoint: startSha });
    return { ok: true, path: wt.path, branch: wt.branch, owned: true, startSha, ...(baseBranch ? { baseBranch } : {}), uncommittedAtStart: !status.clean };
  } catch (e) {
    return fail(`Could not create the mission worktree: ${errorText(e)}`);
  }
}

/** The folder part of a Lead branch that Builder branches extend: `mission/x` → `x`. */
function leadName(leadBranch: string): string {
  const name = leadBranch.startsWith(`${MISSION_BRANCH_PREFIX}/`) ? leadBranch.slice(MISSION_BRANCH_PREFIX.length + 1) : leadBranch.split('/').pop() ?? '';
  return branchSlug(name.replace(/\//g, '-'));
}

/**
 * A Builder's own worktree on `mission/<slug>-b<n>`, starting at the Lead branch's tip. A leftover
 * branch or folder of that name (an earlier run, the old Mission feature) is never reused: the
 * next free name is taken instead.
 */
export async function createBuilderWorktree(projectRoot: string, leadBranch: string, index: number): Promise<GitResult<{ path: string; branch: string; startSha: string }>> {
  if (!validBranch(leadBranch)) return fail('Invalid Lead branch.');
  if (!Number.isInteger(index) || index < 1) return fail('Invalid Builder number.');
  const root = await gitRoot(projectRoot);
  if (!root) return fail('This folder is not a git repository.');
  const startSha = await revParse(root, `refs/heads/${leadBranch}`);
  if (!startSha) return fail(`The Lead branch ${leadBranch} does not exist.`);
  try {
    const wt = await createWorktree(root, `${leadName(leadBranch)}-b${index}`, { branchPrefix: MISSION_BRANCH_PREFIX, startPoint: startSha });
    return { ok: true, path: wt.path, branch: wt.branch, startSha };
  } catch (e) {
    return fail(`Could not create the Builder's worktree: ${errorText(e)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Landing a Builder's branch on the Lead's

export interface LandInput {
  missionId: string;
  leadWorktree: string;
  leadBranch: string;
  builderWorktree: string;
  builderBranch: string;
}

export type LandResult = GitResult<{ sha: string; commits: number; alreadyLanded: boolean }>;

const landQueues = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier land of the same mission has settled: one merge at a time. */
async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // The stored tail never rejects, so the next land always runs.
  const previous = landQueues.get(key) ?? Promise.resolve();
  const run = previous.then(() => fn());
  const tail = run.then(() => undefined, () => undefined);
  landQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (landQueues.get(key) === tail) landQueues.delete(key);
  }
}

/**
 * Fast-forwards the Lead branch to the Builder's tip, inside the Lead's worktree, one land per
 * mission at a time. Every check runs again under the lock, so a second Builder whose branch no
 * longer contains the Lead's tip is told to merge again rather than racing the first.
 */
export function landOnLead(input: LandInput): Promise<LandResult> {
  return serialized(input.missionId, () => land(input).catch((e: unknown) => fail(`Landing failed: ${errorText(e)}. Nothing was landed.`)));
}

async function land(input: LandInput): Promise<LandResult> {
  const { leadWorktree, leadBranch, builderWorktree, builderBranch } = input;
  if (!validBranch(leadBranch) || !validBranch(builderBranch)) return fail('Invalid branch name.');

  const builderStatus = await statusPorcelain(builderWorktree);
  if (!builderStatus.ok) return builderStatus;
  if (!builderStatus.clean) {
    return fail(`Your worktree has uncommitted changes (${builderStatus.entries.length} ${builderStatus.entries.length === 1 ? 'path' : 'paths'}). Commit them, then call land_on_lead again.`);
  }
  const builderHead = await currentHead(builderWorktree);
  if (!builderHead.ok) return builderHead;
  if (builderHead.branch !== builderBranch) return fail(`Your worktree is not on your branch ${builderBranch}. Check it out again, then call land_on_lead again.`);

  const leadHead = await currentHead(leadWorktree);
  if (!leadHead.ok) return leadHead;
  if (leadHead.branch !== leadBranch) return fail(`The Lead's worktree is not on ${leadBranch}, so nothing can land. Tell the Lead.`);
  const leadStatus = await statusPorcelain(leadWorktree);
  if (!leadStatus.ok) return leadStatus;
  if (!leadStatus.clean) {
    return fail(`The Lead's worktree has uncommitted changes (a Builder sharing it may still be working), so nothing was landed. Call land_on_lead again once it is clean, or tell the Lead.`);
  }

  const leadTip = leadHead.sha;
  const builderTip = builderHead.sha;
  const landed = leadTip === builderTip || (await isAncestor(leadWorktree, builderTip, leadTip));
  if (landed === null) return fail('git could not compare the two branches. Nothing was landed.');
  if (landed) return { ok: true, sha: leadTip, commits: 0, alreadyLanded: true };
  const contains = await isAncestor(builderWorktree, leadTip, builderTip);
  if (contains === null) return fail('git could not compare the two branches. Nothing was landed.');
  if (!contains) {
    return fail(`The Lead branch ${leadBranch} has moved since you last merged it. Run \`git merge ${leadBranch}\` in your worktree, resolve any conflicts, rerun the tests, commit, then call land_on_lead again.`);
  }
  const count = await git(leadWorktree, ['rev-list', '--count', `${leadTip}..${builderTip}`]);
  const commits = ok(count) ? Number(count.stdout.trim()) || 0 : 0;

  // Another git command in the shared worktree may hold index.lock for a moment.
  let merge: Run = { code: null, stdout: '', stderr: '' };
  for (let attempt = 0; attempt < 3; attempt++) {
    merge = await git(leadWorktree, ['merge', '--ff-only', '--no-edit', builderTip], { timeoutMs: MERGE_TIMEOUT_MS });
    if (ok(merge) || !/index\.lock/.test(merge.stderr)) break;
    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }
  if (!ok(merge)) {
    if (/index\.lock/.test(merge.stderr)) return fail('Another git command is running in the Lead worktree (index.lock). Nothing was landed; call land_on_lead again in a moment.');
    return fail(`The fast-forward failed: ${merge.timedOut ? 'git timed out' : firstLine(merge, 'git merge failed')}. Check the Lead worktree before trying again.`);
  }
  const after = await revParse(leadWorktree, 'HEAD');
  if (after !== builderTip) return fail('The Lead branch did not end at your commit. Tell the Lead.');
  return { ok: true, sha: builderTip, commits, alreadyLanded: false };
}

/** True when everything on `builderRef` is already on `leadRef`. */
export async function isLanded(cwd: string, leadRef: string, builderRef: string): Promise<GitResult<{ landed: boolean }>> {
  if (!validRev(leadRef) || !validRev(builderRef)) return fail('Invalid revision.');
  const lead = await revParse(cwd, leadRef);
  const builder = await revParse(cwd, builderRef);
  if (!lead || !builder) return fail(`${!lead ? leadRef : builderRef} does not exist.`);
  if (lead === builder) return { ok: true, landed: true };
  const landed = await isAncestor(cwd, builder, lead);
  return landed === null ? fail('git could not compare the two branches.') : { ok: true, landed };
}

// ---------------------------------------------------------------------------------------------
// Cleanup

export interface CleanupInput {
  projectRoot: string;
  /** The worktree folder; must sit under the project's `.vocs-code/worktrees/`. */
  path: string;
  /** Its branch, deleted only once its work is safe elsewhere. */
  branch?: string;
  /** Branches that make the work safe once they contain the branch's tip (the Lead's, the base). */
  mergedInto?: string[];
}

export type CleanupResult = GitResult<{
  removed: boolean;
  /** Links removed (without following them) before git removed the folder. */
  unlinked: string[];
  branch?: { name: string; deleted: boolean; note?: string };
}>;

const LINK_WALK_DEPTH = 3;
const LINK_WALK_MAX_ENTRIES = 200_000;

const pathKey = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const isWithin = (root: string, target: string): boolean => {
  const rel = path.relative(pathKey(root), pathKey(target));
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/**
 * Removes every symlink and junction within LINK_WALK_DEPTH levels of `dir` without following it,
 * so deleting the folder can never reach a linked target (a junctioned node_modules). Null when the
 * folder holds too many entries to check.
 */
async function unlinkLinks(dir: string): Promise<string[] | null> {
  const unlinked: string[] = [];
  let seen = 0;
  let level = [dir];
  for (let depth = 0; depth < LINK_WALK_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const current of level) {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (++seen > LINK_WALK_MAX_ENTRIES) return null;
        if (depth === 0 && entry.name === '.git') continue;
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            await fs.unlink(full);
          } catch {
            // A Windows directory junction or symlink that unlink refuses is removed as a directory entry.
            await fs.rmdir(full);
          }
          unlinked.push(full);
        } else if (entry.isDirectory()) next.push(full);
      }
    }
    level = next;
  }
  return unlinked;
}

/**
 * Deletes a mission worktree: links first (never followed), then `git worktree remove --force`,
 * then its branch when the work is merged into one of `mergedInto` or sits on the remote at the
 * same tip. Unmerged work keeps its branch, and the result says so.
 */
export async function cleanupWorktree(input: CleanupInput): Promise<CleanupResult> {
  const root = await gitRoot(input.projectRoot);
  if (!root) return fail('This folder is not a git repository.');
  const container = path.join(root, '.vocs-code', 'worktrees');
  if (!isWithin(container, input.path)) return fail(`Refusing to remove ${input.path}: it is not one of the project's worktrees.`);
  if (input.branch !== undefined && !validBranch(input.branch)) return fail('Invalid branch name.');

  let unlinked: string[] = [];
  let removed = false;
  const stat = await fs.lstat(input.path).catch(() => null);
  if (stat?.isSymbolicLink()) return fail(`Refusing to remove ${input.path}: the worktree folder is itself a link.`);
  if (stat) {
    try {
      const links = await unlinkLinks(input.path);
      if (!links) return fail(`The worktree ${input.path} holds too many files to check for links safely, so it was kept.`);
      unlinked = links;
    } catch (e) {
      return fail(`Could not unlink a link in ${input.path} (${errorText(e)}), so the worktree was kept and nothing it links to was touched.`);
    }
  }
  const tip = input.branch ? await revParse(root, `refs/heads/${input.branch}`) : null;
  try {
    await removeWorktree(root, input.path, { force: true });
    removed = true;
  } catch (e) {
    return fail(`Could not remove the worktree ${input.path}: ${errorText(e)}`);
  }
  if (!input.branch || !tip) return { ok: true, removed, unlinked };

  const name = input.branch;
  let safe = false;
  for (const ref of input.mergedInto ?? []) {
    if (!validBranch(ref) || ref === name) continue;
    const refTip = await revParse(root, `refs/heads/${ref}`);
    if (refTip && (refTip === tip || (await isAncestor(root, tip, refTip)))) {
      safe = true;
      break;
    }
  }
  if (!safe) safe = (await revParse(root, `refs/remotes/origin/${name}`)) === tip;
  if (!safe) {
    const into = (input.mergedInto ?? []).filter((b) => b !== name);
    return { ok: true, removed, unlinked, branch: { name, deleted: false, note: `Branch ${name} has commits that are not merged${into.length ? ` into ${into.join(' or ')}` : ''}, so it was kept.` } };
  }
  const del = await git(root, ['branch', '-D', name]);
  if (!ok(del)) return { ok: true, removed, unlinked, branch: { name, deleted: false, note: `Could not delete branch ${name}: ${firstLine(del, 'git branch failed')}` } };
  return { ok: true, removed, unlinked, branch: { name, deleted: true } };
}

// ---------------------------------------------------------------------------------------------
// The Lead's read-only views

export interface ViewText {
  text: string;
  truncated: boolean;
}

function capText(text: string, max: number, hint: string): ViewText {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n… [cut at ${max} characters; ${hint}]`, truncated: true };
}

/**
 * The Builder's changes from `from` (its start commit, or the merge base with the Lead branch) to
 * `to`, or to its working tree when `to` is omitted; untracked files are listed by name. No external
 * diff driver or textconv filter runs.
 */
export async function builderDiff(cwd: string, opts: { from: string; to?: string; stat?: boolean; maxChars?: number }): Promise<GitResult<ViewText & { untracked: string[] }>> {
  if (!validRev(opts.from) || (opts.to !== undefined && !validRev(opts.to))) return fail('Invalid revision.');
  const max = opts.maxChars ?? MAX_VIEW_CHARS;
  const r = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', opts.stat ? '--stat' : '--patch', opts.from, ...(opts.to ? [opts.to] : []), '--']);
  if (r.timedOut) return fail('git diff timed out; ask for stat: true instead.');
  if (r.code !== 0) return fail(`git diff failed: ${firstLine(r, 'unknown error')}`);
  let untracked: string[] = [];
  if (!opts.to) {
    const status = await statusPorcelain(cwd);
    if (status.ok) untracked = status.entries.filter((e) => e.code === '??').map((e) => e.path);
  }
  const body = r.stdout.trim() || '(no changes)';
  const extra = untracked.length ? `\n\nUntracked files (not in the diff):\n${untracked.slice(0, 200).map((p) => `  ${p}`).join('\n')}${untracked.length > 200 ? `\n  … ${untracked.length - 200} more` : ''}` : '';
  const view = capText(body + extra, max, 'ask for stat: true, or ask the Builder about specific files');
  return { ok: true, ...view, truncated: view.truncated || !!r.truncated, untracked };
}

/** The commits on `to` (default HEAD) since `from`, newest first. */
export async function builderLog(cwd: string, opts: { from: string; to?: string; max?: number; maxChars?: number }): Promise<GitResult<ViewText & { count: number }>> {
  if (!validRev(opts.from) || (opts.to !== undefined && !validRev(opts.to))) return fail('Invalid revision.');
  const limit = Math.max(1, Math.min(opts.max ?? 100, 500));
  const r = await git(cwd, ['log', '--no-ext-diff', '--no-textconv', '--no-color', `--max-count=${limit}`, '--format=%h %s (%an, %cr)', `${opts.from}..${opts.to ?? 'HEAD'}`, '--']);
  if (r.timedOut) return fail('git log timed out.');
  if (r.code !== 0) return fail(`git log failed: ${firstLine(r, 'unknown error')}`);
  const lines = r.stdout.split('\n').filter(Boolean);
  const view = capText(lines.join('\n') || '(no commits yet)', opts.maxChars ?? MAX_VIEW_CHARS, 'the oldest commits are not shown');
  return { ok: true, ...view, count: lines.length };
}

// ---------------------------------------------------------------------------------------------
// Push and PR: one plain push, a PR into the base branch, body edits on follow-ups

async function hasOrigin(cwd: string): Promise<boolean> {
  return ok(await git(cwd, ['remote', 'get-url', 'origin']));
}

const GH_MISSING = 'GitHub CLI (gh) is not installed, so no PR was opened; the work stays on the local branch.';
const ghSignedOut = (out: string): boolean => /gh auth login|not logged in|authentication required/i.test(out);
const PR_URL = /https:\/\/[^\s/"]+\/[^\s"]+\/pull\/\d+/;

/** `git push -u origin <branch>`: a plain push. A remote that moved is refused, never overwritten. */
export async function pushBranch(cwd: string, branch: string): Promise<PrResult<{ output: string }>> {
  if (!validBranch(branch)) return fail('Invalid branch name.');
  if (!(await hasOrigin(cwd))) return unavailable(`There is no origin remote, so nothing was pushed; the work stays on the local branch ${branch}.`);
  if (!(await revParse(cwd, `refs/heads/${branch}`))) return fail(`Branch ${branch} does not exist locally.`);
  const r = await git(cwd, ['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: PUSH_TIMEOUT_MS, remote: true });
  const output = `${r.stdout}${r.stderr}`.trim();
  if (ok(r)) return { ok: true, output: output || `Pushed ${branch} to origin.` };
  if (r.timedOut) return fail('git push timed out.');
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(output)) {
    return fail(`origin/${branch} has commits this branch does not, so nothing was pushed (Mission mode never force-pushes).`);
  }
  return fail(`git push failed: ${firstLine(r, 'unknown error')}`);
}

/**
 * Pushes `head` once and opens a PR into `base` with `body` as its description (through stdin).
 * A PR that already exists for the branch is returned with `existing`.
 */
export async function openPr(cwd: string, pr: { base: string; head: string; title: string; body: string }): Promise<PrResult<{ url?: string; existing?: true; output: string }>> {
  if (!validBranch(pr.base) || !validBranch(pr.head)) return fail('Invalid branch name.');
  if (!(await hasOrigin(cwd))) return unavailable(`There is no origin remote, so no PR was opened; the work stays on the local branch ${pr.head}.`);
  if (!which('gh')) return unavailable(GH_MISSING);
  const title = pr.title.replace(/\s+/g, ' ').trim().slice(0, 240) || pr.head;
  const r = await gitCreatePr(cwd, pr.base, pr.head, { title, body: pr.body });
  const output = r.output ?? '';
  if (r.ok) return { ok: true, output, ...(r.url ? { url: r.url } : {}) };
  const existing = /already exists/i.test(output) ? output.match(PR_URL)?.[0] : undefined;
  if (existing) return { ok: true, url: existing, existing: true, output };
  if (ghSignedOut(output)) return unavailable('gh is not signed in to GitHub, so no PR was opened; the work stays on the local branch. Run `gh auth login` to let the next finish open it.');
  return fail(output.split('\n')[0]?.slice(0, 400) || 'gh pr create failed');
}

const prArg = (pr: string): string | undefined => (/^\d+$/.test(pr) || PR_URL.test(pr) ? (pr.match(PR_URL)?.[0] ?? pr) : undefined);

/** Replaces the PR's description (stdin, so its length and quoting never reach the command line). */
export async function editPrBody(cwd: string, pr: string, body: string): Promise<PrResult<{ output: string }>> {
  const target = prArg(pr);
  if (!target) return fail('Invalid PR reference.');
  if (!which('gh')) return unavailable(GH_MISSING);
  const r = await gh(cwd, ['pr', 'edit', target, '--body-file', '-'], 60_000, body);
  const output = `${r.stdout}${r.stderr}`.trim();
  if (r.code === 0 && !r.truncated && !r.timedOut) return { ok: true, output };
  if (ghSignedOut(output)) return unavailable('gh is not signed in to GitHub, so the PR description was not updated.');
  return fail(`gh pr edit failed: ${output.split('\n')[0]?.slice(0, 400) || 'unknown error'}`);
}

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

/** The PR's state as GitHub reports it; merged and closed both end a mission. */
export async function prState(cwd: string, pr: string): Promise<PrResult<{ state: PrState; url: string }>> {
  const target = prArg(pr);
  if (!target) return fail('Invalid PR reference.');
  if (!which('gh')) return unavailable(GH_MISSING);
  const r = await gh(cwd, ['pr', 'view', target, '--json', 'number,state,url'], 15_000);
  if (r.code !== 0 || r.truncated || r.timedOut) return fail(`gh pr view failed: ${(r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 300) || 'unknown error'}`);
  try {
    const parsed = JSON.parse(r.stdout) as { state?: unknown; url?: unknown };
    if ((parsed.state === 'OPEN' || parsed.state === 'CLOSED' || parsed.state === 'MERGED') && typeof parsed.url === 'string') {
      return { ok: true, state: parsed.state, url: parsed.url };
    }
  } catch {
    /* fall through */
  }
  return fail('gh returned an unreadable PR state.');
}
