import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gitRoot } from './git';
import { runCapture, which, type CaptureResult } from './runtime';

export type HousekeepWorktree =
  | { kind: 'none' }
  | { kind: 'missing' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'clean'; root: string; cwd: string; branch: string; head: string };

class WorktreeCheckError extends Error {}

function requireCheck(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new WorktreeCheckError(reason);
}

function absolutePath(value: string): string {
  const win = process.platform === 'win32';
  const parts = value.split(win ? /[\\/]/ : '/');
  requireCheck(path.isAbsolute(value) && !value.includes('\0') && !parts.some((part) => part === '.' || part === '..'),
    'The worktree path is not an unambiguous absolute path.');
  if (win) {
    requireCheck(/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+)/i.test(value)
      && !parts.slice(/^[a-z]:/i.test(value) ? 1 : 2).some((part) => /[.: ]$|:/.test(part)),
    'The worktree path is not an unambiguous Windows path.');
    // Git may change the spelling of the drive letter. Do not fold pathname components.
    return path.resolve(value).replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  }
  return path.resolve(value);
}

// A same-volume rename preserves the directory identity; path and branch alone do not.
async function directoryAt(dir: string): Promise<string | null> {
  const st = await fs.lstat(dir, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!st) return null;
  requireCheck(st.isDirectory() && !st.isSymbolicLink() && absolutePath(await fs.realpath(dir)) === dir,
    'The worktree path or a parent is not a canonical directory (it may be a symlink or junction).');
  requireCheck(st.ino !== 0n, 'The worktree directory does not have a verifiable filesystem identity.');
  return `${st.dev}:${st.ino}`;
}

async function managedDirectory(root: string, cwd: string): Promise<string | null> {
  const app = path.join(root, '.vocs-code');
  const base = path.join(app, 'worktrees');
  requireCheck(path.dirname(cwd) === base, 'The checkout is not directly under .vocs-code/worktrees.');
  requireCheck(await directoryAt(root), 'The project Git root is missing.');
  // Inspect each parent before walking through it. ENOENT is the only evidence of absence.
  return await directoryAt(app) && await directoryAt(base) && await directoryAt(cwd);
}

function runGit(cwd: string, args: string[], timeoutMs = 20_000, input?: string): Promise<CaptureResult> {
  // Do not let Git's launch environment select a different repository, worktree, or index.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return runCapture(which('git') ?? 'git', [
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.ignoreStat=false',
    '-c', 'core.trustctime=true', '-c', 'core.checkStat=default',
    '-c', 'status.showUntrackedFiles=all', ...args,
  ], {
    cwd, timeoutMs, input,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
  });
}

function checkedOutput(result: CaptureResult, operation: string): string {
  requireCheck(result.code === 0 && !result.timedOut && !result.truncated && !result.stderr && !result.stdout.includes('\uFFFD'),
    `Could not verify ${operation}.`);
  return result.stdout;
}

async function gitOutput(cwd: string, args: string[], operation: string, input?: string): Promise<string> {
  return checkedOutput(await runGit(cwd, args, undefined, input), operation);
}

async function registrationsAt(root: string, ...paths: string[]): Promise<(string[] | undefined)[]> {
  const reason = 'The Git worktree list is not usable.';
  const out = await gitOutput(root, ['worktree', 'list', '--porcelain', '-z'], 'Git worktree registrations');
  requireCheck(out.endsWith('\0\0'), reason);
  const found = new Map<string, string[]>();
  for (const record of out.slice(0, -2).split('\0\0')) {
    const [location, ...fields] = record.split('\0');
    requireCheck(location.startsWith('worktree ') && fields.length && !fields.some((field) => field.startsWith('worktree ')), reason);
    const listed = absolutePath(location.slice('worktree '.length));
    if (paths.includes(listed)) {
      requireCheck(!found.has(listed), 'Git has duplicate registrations for the worktree path.');
      found.set(listed, fields);
    } else if (process.platform === 'win32' && paths.some((cwd) => listed.toLowerCase() === cwd.toLowerCase())) {
      // Casing may be significant (per-directory on Windows); never treat this as an exact
      // registration or as proof that the requested path is unregistered.
      throw new WorktreeCheckError('The Git worktree registration has ambiguous path casing.');
    }
  }
  return paths.map((cwd) => found.get(cwd));
}

async function gitDirectories(cwd: string): Promise<[top: string, admin: string, common: string]> {
  const out = await gitOutput(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], 'the checkout Git directories');
  const dirs = out.replace(/\r?\n$/, '').split(/\r?\n/);
  requireCheck(dirs.length === 3, 'Git did not identify one checkout and its repository.');
  return [absolutePath(dirs[0]), absolutePath(dirs[1]), absolutePath(dirs[2])];
}

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const pendingGitOperation = new Set(['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_START', 'sequencer', 'index.lock']);

async function adminAt(common: string, admin: string, cwd: string): Promise<string> {
  const admins = path.join(common, 'worktrees');
  const reason = 'The checkout is not bound to the project worktree registration.';
  requireCheck(path.dirname(admin) === admins && await directoryAt(common) && await directoryAt(admins), reason);
  const identity = await directoryAt(admin);
  requireCheck(identity, reason);
  // A swapped .git file can point to a different worktree of even the same repo and branch.
  const backlink = path.join(admin, 'gitdir');
  const st = await fs.lstat(backlink);
  requireCheck(st.isFile() && st.size <= 64 * 1024, 'The Git worktree backlink is not usable.');
  const linkTarget = (await fs.readFile(backlink, 'utf8')).replace(/\r?\n$/, '');
  requireCheck(linkTarget && !linkTarget.includes('\uFFFD') && absolutePath(path.resolve(admin, linkTarget)) === path.join(cwd, '.git'),
    'The Git worktree backlink does not identify this checkout.');
  return identity;
}

interface CheckoutAdmin { admin: string; adminId: string }

async function checkoutAdmin(common: string, cwd: string): Promise<CheckoutAdmin> {
  requireCheck((await fs.lstat(path.join(cwd, '.git'))).isFile(), 'The checkout is not a linked Git worktree.');
  const [top, admin, checkoutCommon] = await gitDirectories(cwd);
  requireCheck(top === cwd && checkoutCommon === common, 'The checkout is not bound to the project worktree registration.');
  return { admin, adminId: await adminAt(common, admin, cwd) };
}

async function checkoutHead(root: string, common: string, cwd: string, branch: string, entry: string[]): Promise<CheckoutAdmin & { head: string }> {
  const ref = `refs/heads/${branch}`;
  requireCheck(!entry.some((field) => /^locked(?: |$)/.test(field)), 'The worktree is locked.');
  requireCheck(!entry.includes('detached'), 'The worktree has a detached HEAD.');
  const head = entry[0].startsWith('HEAD ') ? entry[0].slice(5) : '';
  requireCheck(entry.length === 2 && oid.test(head) && entry[1] === `branch ${ref}`,
    'The worktree registration is stale or does not match the session branch.');

  const identity = await checkoutAdmin(common, cwd);
  requireCheck(!(await fs.readdir(identity.admin)).some(name => pendingGitOperation.has(name)),
    'The worktree has an in-progress Git operation or locked index.');
  const [symbolic, actualHead, retained] = await Promise.all([
    gitOutput(cwd, ['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'], 'the worktree HEAD branch'),
    gitOutput(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 'the worktree HEAD commit'),
    gitOutput(root, ['show-ref', '--verify', '--hash', ref], 'the retained local branch'),
  ]);
  requireCheck(symbolic.replace(/\r?\n$/, '') === ref && actualHead.replace(/\r?\n$/, '') === head && retained.replace(/\r?\n$/, '') === head,
    'The registered worktree HEAD does not match the retained local branch.');
  return { ...identity, head };
}

function nulRecords(out: string, reason: string): string[] {
  if (!out) return [];
  requireCheck(out.endsWith('\0'), reason);
  return out.slice(0, -1).split('\0');
}

async function requireClean(cwd: string, branch: string, head: string): Promise<void> {
  // Git status can hide assume-unchanged / skip-worktree entries, and does not prove that
  // a submodule contains no ignored data. Do not trust such indexes for unattended removal.
  const indexReason = 'The worktree index cannot be safely checked (hidden entries, conflicts, or submodules).';
  const tracked = new Set<string>();
  const index = await gitOutput(cwd, ['ls-files', '-v', '--stage', '-z'], 'the worktree index');
  for (const entry of nulRecords(index, indexReason)) {
    const match = /^H (?:100644|100755|120000) ([0-9a-f]+) 0\t(.+)$/s.exec(entry);
    requireCheck(match && oid.test(match[1]) && !tracked.has(match[2]), indexReason);
    tracked.add(match[2]);
  }
  // A clean/process filter may run code and hide differences in the bytes being deleted.
  if (tracked.size) {
    const reason = 'The worktree uses Git filters or its attributes could not be verified.';
    const attrs = nulRecords(await gitOutput(cwd, ['check-attr', '-z', '--stdin', '--all'], 'Git filter attributes',
      `${[...tracked].join('\0')}\0`), reason);
    requireCheck(attrs.length % 3 === 0, reason);
    for (let i = 0; i < attrs.length; i += 3) {
      requireCheck(tracked.has(attrs[i]) && attrs[i + 1] && attrs[i + 1] !== 'filter', reason);
    }
  }
  const status = await gitOutput(cwd, ['status', '--porcelain=v2', '-z', '--branch', '--no-ahead-behind',
    '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'], 'that the worktree is clean');
  const [currentHead, currentBranch, ...changes] = nulRecords(status, 'Git did not return a complete status.');
  requireCheck(currentHead === `# branch.oid ${head}` && currentBranch === `# branch.head ${branch}`,
    'The worktree HEAD changed while checking its status.');
  requireCheck(changes.every((line) => /^# branch\.(?:upstream|ab) /.test(line)),
    'The worktree has modified, untracked, or ignored files.');

  // Also check what Git never reports, such as a nested .git directory under tracked files.
  // Do not traverse links; only the root's verified .git control file is exempt.
  const pending = [''];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of await fs.readdir(path.join(cwd, dir), { withFileTypes: true })) {
      if (!dir && entry.name === '.git' && entry.isFile()) continue;
      const file = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push(file);
      else requireCheck((entry.isFile() || (process.platform !== 'win32' && entry.isSymbolicLink())) && tracked.delete(file),
        'The worktree contains an untracked or unsupported filesystem entry.');
    }
  }
  requireCheck(!tracked.size, 'Not all tracked files were found in the worktree.');
}

type WorktreeInput = { projectRoot: string; cwd: string; branch?: string };
type CleanWorktree = Extract<HousekeepWorktree, { kind: 'clean' }>;
type OwnedWorktree = CleanWorktree & CheckoutAdmin & { common: string; checkoutId: string };

async function inspectOwnedWorktree(input: WorktreeInput): Promise<Exclude<HousekeepWorktree, CleanWorktree> | OwnedWorktree> {
  const { branch } = input;
  if (!branch) return { kind: 'none' };
  try {
    const project = absolutePath(input.projectRoot);
    requireCheck(await directoryAt(project), 'The project directory is missing.');
    const discovered = await gitRoot(project);
    requireCheck(discovered, 'Could not find the project Git root.');
    const root = absolutePath(discovered);
    const cwd = absolutePath(input.cwd);
    const present = await managedDirectory(root, cwd);
    // gitRoot is discovery only; confirm from the original project using the bounded Git runner.
    const [top, , common] = await gitDirectories(project);
    requireCheck(top === root && await directoryAt(common), 'Could not confirm the project Git repository.');
    const [registered] = await registrationsAt(root, cwd);
    if (!present && !registered) return { kind: 'missing' };
    requireCheck(present, 'The worktree folder is missing but still registered with Git.');
    requireCheck(registered, 'The folder is not a registered worktree of this project.');
    const checked = await checkoutHead(root, common, cwd, branch, registered);
    await requireClean(cwd, branch, checked.head);
    requireCheck(await managedDirectory(root, cwd) === present, 'The worktree path changed while checking it.');
    return { kind: 'clean', root, cwd, branch, ...checked, common, checkoutId: present };
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof WorktreeCheckError ? error.message : 'Could not safely verify the Git worktree.' };
  }
}

export async function inspectHousekeepWorktree(input: WorktreeInput): Promise<HousekeepWorktree> {
  const result = await inspectOwnedWorktree(input);
  if (result.kind !== 'clean') return result;
  const { root, cwd, branch, head } = result;
  return { kind: 'clean', root, cwd, branch, head };
}

/** Revalidate a clean checkout, then send its contents to Trash before unregistering it. */
export async function removeHousekeepWorktree(
  target: CleanWorktree, beforeRemove: () => void | Promise<void>, trashDirectory: (cwd: string) => Promise<void>,
): Promise<void> {
  const { root, cwd, branch, head } = target;
  const checkoutId = await managedDirectory(root, cwd);
  requireCheck(checkoutId, 'The worktree folder is missing.');
  // mkdtemp creates a private random sibling on the same volume. Git must never be
  // asked to remove the original location or a staging location that contains data.
  const parent = await fs.mkdtemp(path.join(path.dirname(cwd), '.housekeep-'));
  const staged = path.join(parent, path.basename(cwd));
  const parentId = await managedDirectory(root, parent);
  requireCheck(parentId, `Could not verify the temporary staging directory at "${parent}".`);
  const checkParent = async () => requireCheck(await managedDirectory(root, parent) === parentId,
    'The temporary staging directory changed.');
  const stagedDirectory = async () => {
    await checkParent();
    return directoryAt(staged);
  };
  const dropEmptyParent = async () => {
    await checkParent();
    await fs.rmdir(parent);
  };
  const move = (from: string, to: string) => runGit(root, ['worktree', 'move', '--', from, to], 60_000);
  const pair = () => registrationsAt(root, cwd, staged);
  const originalDirectory = () => managedDirectory(root, cwd);
  const matchesHead = (entry: string[]) => entry[0] === `HEAD ${head}` && entry[1] === `branch refs/heads/${branch}`;

  let owned: OwnedWorktree;
  try {
    const now = await inspectOwnedWorktree({ projectRoot: root, cwd, branch });
    requireCheck(now.kind === 'clean' && now.root === root && now.cwd === cwd && now.head === head && now.checkoutId === checkoutId,
      now.kind === 'blocked' ? now.reason : 'The worktree changed since it was inspected.');
    owned = now;
    const [originalEntry, stagedEntry] = await pair();
    requireCheck(originalEntry?.length === 2 && matchesHead(originalEntry) && !stagedEntry
      && !await stagedDirectory() && await originalDirectory() === checkoutId, 'A worktree registration or path changed before staging.');
  } catch (error) {
    await dropEmptyParent().catch(() => undefined);
    throw error;
  }

  const sameAdmin = (checked: CheckoutAdmin) => checked.admin === owned.admin && checked.adminId === owned.adminId;
  const originalIntact = async () => {
    const [entry, privateEntry] = await pair();
    return !!entry && !privateEntry && !await stagedDirectory() && await originalDirectory() === checkoutId
      && sameAdmin(await checkoutAdmin(owned.common, cwd));
  };
  const restore = async () => {
    if (await originalIntact()) return; // Git may have refused without changing anything.
    const [entry, privateEntry] = await pair();
    requireCheck(!entry && privateEntry && await stagedDirectory() === checkoutId
      && sameAdmin(await checkoutAdmin(owned.common, staged)), 'The staged folder is not the exact registered checkout.');
    requireCheck(!await originalDirectory() && await stagedDirectory() === checkoutId,
      'The original path is occupied or the staged checkout changed.');
    checkedOutput(await move(staged, cwd), 'restoring the checkout with Git');
    requireCheck(await originalIntact(), 'Git did not restore the checkout at its original path.');
  };

  let moveAttempted = false;
  let trash: 'not requested' | 'requested' | 'accepted' = 'not requested';
  try {
    await beforeRemove();
    moveAttempted = true;
    checkedOutput(await move(cwd, staged), 'native Git worktree move');
    const [entry, stagedEntry] = await pair();
    requireCheck(!entry && stagedEntry && !await originalDirectory() && await stagedDirectory() === checkoutId,
      'Git did not move the exact checkout to its staging path.');
    const checked = await checkoutHead(root, owned.common, staged, branch, stagedEntry);
    requireCheck(sameAdmin(checked) && checked.head === head, 'The staged worktree changed since it was inspected.');
    await requireClean(staged, branch, head);
    const [originalBeforeTrash, stagedBeforeTrash] = await pair();
    requireCheck(!originalBeforeTrash && stagedBeforeTrash?.length === 2 && matchesHead(stagedBeforeTrash)
      && !await originalDirectory() && await stagedDirectory() === checkoutId, 'The worktree changed while checking its staged contents.');
    await beforeRemove();
    trash = 'requested';
    await trashDirectory(staged);
    requireCheck(!await stagedDirectory(), 'Trash did not take the staged checkout.');
    trash = 'accepted';

    const [originalBeforeUnregister, stagedBeforeUnregister] = await pair();
    requireCheck(!originalBeforeUnregister && stagedBeforeUnregister && matchesHead(stagedBeforeUnregister)
      && (stagedBeforeUnregister.length === 2 || (stagedBeforeUnregister.length === 3 && /^prunable(?: |$)/.test(stagedBeforeUnregister[2])))
      && await adminAt(owned.common, owned.admin, staged) === owned.adminId && !await originalDirectory(),
    'The worktree registrations or original path changed after Trash.');
    // Removing the empty parent narrows the window for a late writer to recreate
    // the private checkout. rmdir refuses even a single unexpected entry.
    await dropEmptyParent();
    requireCheck(!await managedDirectory(root, parent), 'The staging path reappeared before Git unregistration.');
    checkedOutput(await runGit(root, ['worktree', 'remove', '--', staged], 60_000), 'Git worktree unregistration');

    const [[originalAfter, stagedAfter], retained] = await Promise.all([
      pair(), gitOutput(root, ['show-ref', '--verify', '--hash', `refs/heads/${branch}`], 'the retained local branch after removal'),
    ]);
    requireCheck(retained.trim() === head, 'The original branch tip could not be confirmed.');
    requireCheck(!originalAfter && !stagedAfter && !await originalDirectory() && !await managedDirectory(root, parent),
      'The original and staged paths and registrations were not all cleared.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (trash !== 'accepted') {
      try {
        if (moveAttempted) await restore();
      } catch (recoveryError) {
        const reason = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        throw new WorktreeCheckError(`${message} Housekeep recovery is incomplete: ${reason} Check "${cwd}" and "${staged}"${trash === 'requested' ? ' and system Trash' : ''}.`, { cause: error });
      }
      await dropEmptyParent().catch(() => undefined);
      throw error;
    }
    throw new WorktreeCheckError(`${message} Housekeep removal is incomplete. Check "${cwd}", the staged registration at "${staged}", and system Trash.`, { cause: error });
  }
}
