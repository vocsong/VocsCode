/** Isolated git worktree creation, confinement, removal, restore, and checkout provenance. */
import fsCallback, { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_BRANCH_PREFIX, branchSlug, normalizeBranchPrefix } from '../../shared/branch-prefix';
import type { GitWorktreeInfo } from '../../shared/types';
import { exists } from '../util/fs';
import { failure, git, gitRoot, logGit, pathKey, within } from './exec';

export const slugify = branchSlug;

export async function gitWorktrees(cwd: string): Promise<{ current: string; worktrees: GitWorktreeInfo[] }> {
  const current = path.resolve(cwd);
  const r = await git(cwd, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return { current, worktrees: [] };
  const worktrees: GitWorktreeInfo[] = [];
  let entry: GitWorktreeInfo | null = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (entry) worktrees.push(entry);
      // Git may print POSIX-style separators; normalize so comparisons with session cwd match.
      entry = { path: path.resolve(line.slice('worktree '.length).trim()), detached: false };
    } else if (entry && line.startsWith('branch ')) {
      entry.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      entry!.detached = true;
    }
  }
  if (entry) worktrees.push(entry);
  return { current, worktrees };
}

/** Best-effort local ignore. Never create Git metadata or follow a linked exclude file. */
export async function excludeVocsCodeDir(root: string, signal?: AbortSignal): Promise<void> {
  const { O_RDWR, O_APPEND, O_NOFOLLOW } = fsCallback.constants;
  try {
    const info = path.join(await fs.realpath(root), '.git', 'info');
    if (pathKey(await fs.realpath(info)) !== pathKey(info)) return;
    const exclude = path.join(info, 'exclude');
    const before = await fs.lstat(exclude, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 1024n * 1024n) return;
    // No O_CREAT: even if the parent changed, opening an absent file has no side effects.
    // Windows doesn't expose O_NOFOLLOW; compare the handle to the no-follow stat before I/O.
    const file = await fs.open(exclude, O_RDWR | O_APPEND | (O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n) return;
      if (pathKey(await fs.realpath(info)) !== pathKey(info)) return;
      const bytes = Buffer.alloc(Number(before.size));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const cur = bytes.toString('utf8', 0, bytesRead);
      if (!cur.split(/\r?\n/).some((line) => line === '.vocs-code/' || line === '/.vocs-code/')) {
        signal?.throwIfAborted();
        await file.appendFile(`${cur.endsWith('\n') || !cur ? '' : '\n'}.vocs-code/\n`);
      }
    } finally {
      await file.close();
    }
  } catch {
    /* Not a regular checkout, no local exclude, canceled, or inaccessible. */
  }
}

/**
 * The repository root a worktree for `projectRoot` is created under, or null when there is no
 * repository. Throws unless that root IS `confine` and every write `git worktree add` makes stays
 * inside it: the worktree folder (no existing `.vocs-code` link out), the new branch and Git's
 * worktree bookkeeping (no git directory elsewhere, as in a linked worktree or submodule).
 */
export async function confinedWorktreeRoot(projectRoot: string, confine: string): Promise<string | null> {
  const root = await gitRoot(projectRoot);
  if (!root) return null;
  const real = await fs.realpath(root);
  if (pathKey(real) !== pathKey(await fs.realpath(confine))) throw new Error('The worktree would be created outside this project.');
  const dirs = await git(real, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  const gitDirs = dirs.code === 0 && !dirs.truncated ? dirs.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (gitDirs.length !== 2) throw new Error('Could not resolve the repository git directory.');
  for (const dir of gitDirs) if (!within(real, await fs.realpath(dir))) throw new Error('The repository keeps its git directory outside this project.');
  for (const dir of [path.join(real, '.vocs-code'), path.join(real, '.vocs-code', 'worktrees')]) {
    const stat = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) break;
    if (!stat.isDirectory() || stat.isSymbolicLink() || pathKey(await fs.realpath(dir)) !== pathKey(dir)) throw new Error('The worktree folder links outside this project.');
  }
  return real;
}

/**
 * Creates an isolated worktree under <root>/.vocs-code/worktrees/<slug> on a new branch
 * `<branchPrefix>/<slug>` (`vocscode/` by default), at `startPoint` when given. With `confineTo`,
 * every write stays inside that folder (see confinedWorktreeRoot), checked again after creating
 * the parent folders; a worktree that resolves elsewhere anyway is removed with its branch.
 */
export async function createWorktree(projectRoot: string, slug: string, opts: { startPoint?: string; branchPrefix?: string; confineTo?: string } = {}): Promise<{ path: string; branch: string }> {
  const { startPoint, confineTo } = opts;
  const prefix = opts.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  if (normalizeBranchPrefix(prefix) !== prefix) throw new Error(`Invalid branch prefix: ${prefix}`);
  const root = confineTo ? await confinedWorktreeRoot(projectRoot, confineTo) : await gitRoot(projectRoot);
  if (!root) throw new Error('Worktrees require a git repository.');
  const base = path.join(root, '.vocs-code', 'worktrees');
  await fs.mkdir(base, { recursive: true });
  if (confineTo && (await confinedWorktreeRoot(root, confineTo)) !== root) throw new Error('The worktree would be created outside this project.');
  await excludeVocsCodeDir(root);
  // Pick a name whose directory AND branch are both free (a removed worktree leaves its branch behind).
  const branchExists = async (b: string) => (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])).code === 0;
  let name = slug;
  let i = 1;
  while ((await exists(path.join(base, name))) || (await branchExists(`${prefix}/${name}`))) name = `${slug}-${++i}`;
  const wtPath = path.join(base, name);
  const branch = `${prefix}/${name}`;
  const r = await git(root, ['worktree', 'add', '-b', branch, wtPath, ...(startPoint ? [startPoint] : [])], 60_000);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);
  if (confineTo && !within(root, await fs.realpath(wtPath))) {
    const removed = await git(root, ['worktree', 'remove', '--force', wtPath]);
    const deleted = await git(root, ['branch', '-D', branch]);
    if (removed.code !== 0 || deleted.code !== 0) logGit('warn', `Could not fully remove an unconfined worktree ${wtPath} (${branch}): ${failure(removed.code !== 0 ? removed : deleted)}`);
    throw new Error('The worktree was created outside this project and has been removed.');
  }
  return { path: wtPath, branch };
}

/** The commit this exact folder has checked out, or null when there is none (missing folder, unborn branch). */
async function gitHeadCommit(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** The tip of one local branch in this repository, or null when the branch is gone. */
async function gitBranchHead(root: string, branch: string): Promise<string | null> {
  const r = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Creates the worktree a fork runs in: a new branch starting at the source checkout's HEAD, so
 * committed work carries over. A source whose folder is already gone (an archived session) still
 * has its kept branch to start from; with neither, the repository's own HEAD stands in. The new
 * branch takes the source session's prefix. Returns null when the project has no repository at all.
 */
export async function createForkWorktree(projectRoot: string, slug: string, source: { cwd: string; branch: string; branchPrefix?: string }): Promise<{ path: string; branch: string } | null> {
  const root = await gitRoot(projectRoot);
  if (!root) return null;
  const start = (await gitHeadCommit(source.cwd)) ?? (await gitBranchHead(root, source.branch)) ?? undefined;
  return createWorktree(root, slug, { startPoint: start, branchPrefix: source.branchPrefix });
}

/** Creates a worktree under .vocs-code/worktrees for an EXISTING branch (new-session-on-branch flow). */
export async function worktreeAddForBranch(projectRoot: string, branch: string): Promise<{ path: string; branch: string }> {
  const root = await gitRoot(projectRoot);
  if (!root) throw new Error('Worktrees require a git repository.');
  const base = path.join(root, '.vocs-code', 'worktrees');
  await fs.mkdir(base, { recursive: true });
  await excludeVocsCodeDir(root);
  const name = slugify(branch.replace(/\//g, '-'));
  let wtPath = path.join(base, name);
  let i = 1;
  while (await exists(wtPath)) wtPath = path.join(base, `${name}-${++i}`);
  const r = await git(root, ['worktree', 'add', wtPath, branch], 60_000);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);
  return { path: wtPath, branch };
}

/** Thrown when a non-force worktree removal hits uncommitted changes; callers offer a force retry. */
export class WorktreeDirtyError extends Error {
  constructor(wtPath: string) {
    super(`The worktree has modified or untracked files: ${wtPath}`);
    this.name = 'WorktreeDirtyError';
  }
}

export async function removeWorktree(projectRoot: string, wtPath: string, opts: { force?: boolean } = {}): Promise<void> {
  const root = await gitRoot(projectRoot);
  if (!root) return;
  // A folder deleted outside the app has nothing to protect; prune the stale registration instead of failing.
  if (!(await exists(wtPath))) {
    await git(root, ['worktree', 'prune']);
    return;
  }
  const force = opts.force ?? true;
  // Without --force git refuses a worktree holding uncommitted changes; callers decide whether to surface that.
  const r = await git(root, force ? ['worktree', 'remove', '--force', wtPath] : ['worktree', 'remove', wtPath], 60_000);
  if (r.code !== 0) {
    // A stale or foreign folder (registration pruned, .git link deleted, path drift, plain directory)
    // cannot be removed as a worktree, and archive must not block on it: drop the registration and the
    // folder directly. A folder that IS a worktree of this repo keeps its real error (dirty tree, ...).
    const probe = await git(wtPath, ['rev-parse', '--git-common-dir']);
    const eq = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const commonDir = probe.code === 0 ? path.resolve(probe.stdout.trim()) : '';
    const ours = eq(commonDir, path.resolve(root)) || eq(commonDir, path.resolve(root, '.git'));
    if (probe.code === 0 && ours) {
      if (/contains modified or untracked files/.test(`${r.stderr}${r.stdout}`)) throw new WorktreeDirtyError(wtPath);
      throw new Error(`git worktree remove failed: ${r.stderr || r.stdout}`);
    }
    await git(root, ['worktree', 'prune']);
    await fs.rm(wtPath, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  await git(root, ['worktree', 'prune']);
}

/** Re-creates a worktree at `wtPath` for an existing branch (used when an archived session is unarchived). */
export async function restoreWorktree(projectRoot: string, wtPath: string, branch: string): Promise<void> {
  const root = await gitRoot(projectRoot);
  if (!root) return;
  const branchExists = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  if (!branchExists) throw new Error(`Branch ${branch} no longer exists.`);
  if (await exists(wtPath)) return;
  // The folder may have been deleted externally, leaving a registration that blocks `worktree add`.
  await git(root, ['worktree', 'prune']);
  const r = await git(root, ['worktree', 'add', wtPath, branch], 60_000);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);
}

export async function worktreeInfo(cwd: string): Promise<{ branch?: string; mainRoot?: string } | null> {
  const r = await git(cwd, ['rev-parse', '--git-common-dir']);
  if (r.code !== 0) return null;
  const common = r.stdout.trim();
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  return { branch, mainRoot: path.dirname(path.resolve(cwd, common)) };
}

/**
 * Provenance for the exact checkout. Origin and root commit are hints, not permission to link
 * projects. A Git common directory is identity evidence only for a registered worktree, not for an
 * arbitrary folder containing a `.git` pointer or a directory below the checkout root.
 */
export async function gitIdentityFacts(cwd: string): Promise<{ origin?: string; rootCommit?: string; head?: string; commonDir?: string }> {
  const real = await fs.realpath(cwd).catch(() => null);
  const root = real ? await gitRoot(real) : null;
  if (!real || !root || pathKey(real) !== pathKey(root)) return {};
  const out: { origin?: string; rootCommit?: string; head?: string; commonDir?: string } = {};
  const [remote, head, common, registered] = await Promise.all([
    git(real, ['config', '--get', 'remote.origin.url']),
    gitHeadCommit(real),
    git(real, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git(real, ['worktree', 'list', '--porcelain', '-z'])
  ]);
  if (remote.code === 0 && !remote.truncated && remote.stdout.trim()) out.origin = remote.stdout.trim();
  if (head && /^[0-9a-f]{40,64}$/i.test(head)) out.head = head;
  const dir = common.stdout.trim();
  if (common.code === 0 && !common.truncated && path.isAbsolute(dir) && registered.code === 0 && !registered.truncated && registered.stdout.split('\0').some(
    (field) => field.startsWith('worktree ') && pathKey(field.slice(9)) === pathKey(real)
  )) {
    const canonical = await fs.realpath(dir).catch(() => null);
    if (canonical) out.commonDir = canonical;
  }
  if (out.head) {
    // A shallow clone's oldest commit is only its graft boundary, which differs per clone.
    const shallow = await git(cwd, ['rev-parse', '--is-shallow-repository']);
    if (shallow.code === 0 && shallow.stdout.trim() === 'false') {
      const roots = await git(cwd, ['rev-list', '--max-parents=0', 'HEAD']);
      const first = roots.code === 0 && !roots.truncated ? roots.stdout.trim().split('\n').filter(Boolean).sort()[0] : undefined;
      if (first && /^[0-9a-f]{40,64}$/i.test(first)) out.rootCommit = first;
    }
  }
  return out;
}

/** The full SHA a revision names in this repository, or null when it does not name a commit. */
export async function gitResolveCommit(cwd: string, revision: string): Promise<string | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(revision)) return null;
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
}
