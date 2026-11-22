import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_BRANCH_PREFIX } from '../shared/branch-prefix';
import type { HousekeepInventory, HousekeepInventoryRow } from '../shared/housekeep';
import type { SessionMeta } from '../shared/types';
import { runCapture, which } from './runtime';

const MAX_PROJECTS = 64;
const MAX_SESSIONS = 4096;
const MAX_ENTRIES_PER_DIRECTORY = 512;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_GIT_ENTRIES = 8192;
const MAX_ROWS = 500;
const SCAN_MS = 30_000;
// Vocs Desk used .vocs-desk/worktrees and harness/ before the Vocs Code rename.
// Vendor paths here are repo-relative only; never crawl home folders or other profiles.
const WORKTREE_CONTAINERS = ['.vocs-code', '.vocs-desk', '.claude', '.codex'];
const APP_BRANCH_PREFIXES = [DEFAULT_BRANCH_PREFIX, 'harness'];
const LOCAL_BRANCH = 'refs/heads/';

type InventorySession = Pick<SessionMeta, 'title' | 'archived' | 'cwd' | 'worktreeBranch' | 'config'>;
type SessionClaim = { title: string; archived: boolean; cwd: string; branch?: string; project: string };
type Registration = { location: string; branch?: string; locked: boolean; prunable: boolean; bare: boolean };
type FolderPresence = 'directory' | 'absent' | 'unverified';

const key = (absolute: string): string => {
  const normalized = path.normalize(absolute);
  // On Windows, ambiguity should preserve a possible session link, not assert that no link exists.
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const absolute = (value: string): boolean => path.isAbsolute(value) && !value.includes('\0') && !value.includes('\uFFFD');
const isMissing = (cause: unknown): boolean => (cause as NodeJS.ErrnoException).code === 'ENOENT';
const inDirectory = (base: string, target: string): boolean => {
  const relative = path.relative(key(base), key(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function readGit(cwd: string, args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  // No status, checkout, fetch, prune, or maintenance. Never run Git in a discovered remnant.
  return runCapture(which('git') ?? 'git', args, {
    cwd, timeoutMs: 5_000,
    env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }
  });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await readGit(cwd, args);
  if (result.code !== 0 || result.timedOut || result.truncated || result.stderr || result.stdout.includes('\uFFFD')) throw new Error('Incomplete Git output');
  return result.stdout;
}

function localBranch(ref: string): string {
  if (!ref.startsWith(LOCAL_BRANCH) || ref.length === LOCAL_BRANCH.length) throw new Error('Not a local branch ref');
  return ref.slice(LOCAL_BRANCH.length);
}

async function gitRegistrations(cwd: string): Promise<Registration[]> {
  const output = await gitOutput(cwd, ['worktree', 'list', '--porcelain', '-z']);
  if (!output.endsWith('\0\0')) throw new Error('Incomplete Git registrations');
  const records = output.slice(0, -2).split('\0\0', MAX_GIT_ENTRIES + 1);
  if (records.length > MAX_GIT_ENTRIES) throw new Error('Worktree registration limit exceeded');
  const seen = new Set<string>();
  return records.map(record => {
    const [first, ...fields] = record.split('\0');
    const location = first.slice('worktree '.length);
    if (!first.startsWith('worktree ') || !absolute(location) || !fields.length || fields.some(field => field.startsWith('worktree '))) {
      throw new Error('Unusable Git registration');
    }
    const branch = fields.find(field => field.startsWith('branch '));
    const bare = fields.includes('bare');
    if (!bare && !fields.some(field => /^HEAD (?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(field))) throw new Error('No Git worktree HEAD');
    if (seen.has(key(location))) throw new Error('Ambiguous Git worktree registrations');
    seen.add(key(location));
    return {
      location: path.normalize(location), branch: branch === undefined ? undefined : localBranch(branch.slice('branch '.length)), bare,
      locked: fields.some(field => /^locked(?: |$)/.test(field)), prunable: fields.some(field => /^prunable(?: |$)/.test(field))
    };
  });
}

/** ENOENT is absence; a link, different spelling, or any error isn't. Don't descend through links. */
async function readPlainDirectory(location: string): Promise<FolderPresence> {
  try {
    const stat = await fs.lstat(location);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unverified';
    return key(await fs.realpath(location)) === key(location) ? 'directory' : 'unverified';
  } catch (cause) {
    return isMissing(cause) ? 'absent' : 'unverified';
  }
}

async function mapBatched<T, U>(items: T[], read: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  for (let i = 0; i < items.length; i += 4) results.push(...await Promise.all(items.slice(i, i + 4).map(read)));
  return results;
}

function describeSessions(claims: SessionClaim[]): HousekeepInventoryRow['sessions'] {
  return claims.slice(0, 5).map(({ title, archived }) => ({ title: title.slice(0, 160), archived }));
}

/** Inventory only: bounded filesystem metadata plus local Git lists for the current desktop profile. */
export async function scanHousekeepInventory(folders: readonly string[], sessions: readonly InventorySession[]): Promise<HousekeepInventory> {
  const result: HousekeepInventory = { repositories: 0, rows: [], warnings: [], limited: false };
  const deadline = Date.now() + SCAN_MS;
  let visited = 0;
  const mayContinue = () => {
    if (Date.now() < deadline && result.rows.length < MAX_ROWS && visited <= MAX_DIRECTORY_ENTRIES) return true;
    result.limited = true;
    return false;
  };
  const warn = (text: string) => {
    if (result.warnings.length < MAX_PROJECTS) result.warnings.push(text);
    else result.limited = true;
  };
  const add = (row: HousekeepInventoryRow) => {
    if (result.rows.length < MAX_ROWS) result.rows.push(row);
    else result.limited = true;
  };
  if (sessions.length > MAX_SESSIONS) result.limited = true;
  const claims = sessions.slice(0, MAX_SESSIONS).map((session): SessionClaim => ({
    title: session.title, archived: session.archived === true, cwd: session.cwd,
    branch: session.worktreeBranch, project: session.config.projectRoot
  }));
  const projects = [...new Map([...folders, ...claims.map(claim => claim.project)]
    .filter(absolute).map(project => [key(project), project])).values()];
  if (projects.length > MAX_PROJECTS) result.limited = true;

  const discovered = await mapBatched(projects.slice(0, MAX_PROJECTS), async project => {
    if (!mayContinue()) return null;
    try {
      const cwd = await fs.realpath(project);
      if (!mayContinue()) return null;
      const git = await readGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (git.code === 128 && !git.timedOut && !git.truncated && git.stderr.startsWith('fatal: not a git repository')) return null;
      const common = git.stdout.replace(/\r?\n$/, '');
      if (git.code !== 0 || git.timedOut || git.truncated || git.stderr || !absolute(common)) throw new Error('Missing Git root');
      return { project, cwd, common: key(await fs.realpath(common)) };
    } catch {
      warn(`Could not check project: ${project}`);
      return null;
    }
  });
  const repositories = new Map<string, { cwd: string; projects: Set<string>; knownDirectories: Set<string> }>();
  for (const project of discovered) {
    if (!project) continue;
    const existing = repositories.get(project.common) ?? { cwd: project.cwd, projects: new Set<string>(), knownDirectories: new Set<string>() };
    existing.projects.add(key(project.project));
    existing.knownDirectories.add(project.cwd);
    repositories.set(project.common, existing);
  }
  if (!repositories.size) return result;

  // Match checkout paths (including subdirectories and live aliases), not just branch names.
  const claimPaths = [...new Set(claims.map(claim => claim.cwd).filter(absolute))];
  let missedAlias = false;
  const canonicalPaths = new Map(await mapBatched(claimPaths, async cwd => {
    if (!mayContinue()) return [cwd, cwd] as const;
    const resolved = await fs.realpath(cwd).catch(cause => { if (!isMissing(cause)) missedAlias = true; return cwd; });
    return [cwd, resolved] as const;
  }));
  if (missedAlias) warn('Some session paths could not be resolved; their recorded paths are shown as evidence only.');
  const claimsByPath = new Map<string, Set<SessionClaim>>();
  for (const claim of claims) {
    if (!absolute(claim.cwd)) continue;
    for (const spelling of [claim.cwd, canonicalPaths.get(claim.cwd) ?? claim.cwd]) {
      let current = key(spelling);
      while (true) {
        let owners = claimsByPath.get(current);
        if (!owners) claimsByPath.set(current, owners = new Set());
        owners.add(claim);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }
  const sessionsAt = (location: string): SessionClaim[] => [...(claimsByPath.get(key(location)) ?? [])];

  for (const repo of repositories.values()) {
    if (!mayContinue()) break;
    let registrations: Registration[];
    try { registrations = await gitRegistrations(repo.cwd); }
    catch { warn(`Could not read Git worktrees for: ${repo.cwd}`); continue; }
    const [primary, ...linked] = registrations;
    const projectRoot = primary.location;
    result.repositories++;
    const registered = new Set(registrations.map(registration => key(registration.location)));
    const claimsByBranch = new Map<string, SessionClaim[]>();
    for (const claim of claims) {
      if (!claim.branch || !repo.projects.has(key(claim.project))) continue;
      const owners = claimsByBranch.get(claim.branch) ?? [];
      owners.push(claim);
      claimsByBranch.set(claim.branch, owners);
    }
    const scanned = new Set<string>();
    const uncertain = new Set<string>();
    const uncheckedContainers = new Set<string>();
    const present = new Set<string>();
    const knownRoots = new Set(primary.bare ? [] : [projectRoot]);
    const deepestFirst = [...linked].sort((a, b) => b.location.length - a.location.length);
    for (const location of repo.knownDirectories) {
      const worktree = deepestFirst.find(entry => inDirectory(entry.location, location));
      if (worktree) knownRoots.add(worktree.location);
    }
    for (const checkoutRoot of knownRoots) {
      if (!mayContinue()) break;
      if (await readPlainDirectory(checkoutRoot) !== 'directory') {
        warn(`Project checkout is not an accessible, direct directory: ${checkoutRoot}`);
      } else {
        for (const name of WORKTREE_CONTAINERS) {
          if (!mayContinue()) break;
          const parent = path.join(checkoutRoot, name);
          const container = path.join(parent, 'worktrees');
          const parentState = await readPlainDirectory(parent);
          const state = parentState === 'directory' ? await readPlainDirectory(container) : parentState;
          if (state === 'unverified') {
            uncheckedContainers.add(key(container));
            warn(`Skipped an unreadable or linked worktree directory: ${container}`);
            continue;
          }
          if (state === 'absent') { scanned.add(key(container)); continue; }
          try {
            let count = 0;
            let complete = true;
            for await (const entry of await fs.opendir(container)) {
              visited++;
              if (++count > MAX_ENTRIES_PER_DIRECTORY || !mayContinue()) { result.limited = true; complete = false; break; }
              const location = path.join(container, entry.name);
              if (!entry.isDirectory() && !entry.isSymbolicLink() && !registered.has(key(location))) continue;
              const state = await readPlainDirectory(location);
              if (state === 'absent') continue;
              present.add(key(location));
              if (state === 'unverified') uncertain.add(key(location));
              if (registered.has(key(location))) continue;
              const holdingStagedCheckout = name === '.vocs-code' && entry.name.startsWith('.housekeep-') && linked.some(wt => inDirectory(location, wt.location));
              add({ projectRoot, location, kind: state === 'unverified' || holdingStagedCheckout ? 'unverified-path' : 'unregistered-folder', sessions: describeSessions(sessionsAt(location)) });
            }
            if (complete) scanned.add(key(container));
          } catch { warn(`Could not finish reading worktree folders in: ${container}`); }
        }
      }
    }

    for (const registration of linked) {
      if (!mayContinue()) break;
      const { location, branch, locked, prunable } = registration;
      const refs = sessionsAt(location);
      const matched = [...new Set([...refs, ...(branch ? claimsByBranch.get(branch) ?? [] : [])])];
      const parent = key(path.dirname(location));
      const kind = uncertain.has(key(location)) || uncheckedContainers.has(parent) ? 'unverified-path'
        : (prunable || scanned.has(parent) && !present.has(key(location))) ? 'stale-registration'
        : matched.some(claim => !claim.archived) ? undefined
        : matched.length ? 'archived-worktree' : 'unlinked-worktree';
      if (kind) add({ projectRoot, location, kind, branch, ...(locked ? { locked } : {}), sessions: describeSessions(matched) });
    }

    if (!mayContinue()) break;
    try {
      const output = await gitOutput(repo.cwd, ['for-each-ref', '--format=%(refname)', LOCAL_BRANCH]);
      const checkedOut = new Set(registrations.flatMap(entry => entry.branch ? [entry.branch] : []));
      const refs = output.split(/\r?\n/, MAX_GIT_ENTRIES + 1).filter(Boolean);
      if (refs.length > MAX_GIT_ENTRIES) result.limited = true;
      for (const line of refs.slice(0, MAX_GIT_ENTRIES)) {
        if (!mayContinue()) break;
        const branch = localBranch(line);
        if (checkedOut.has(branch)) continue;
        const matched = claimsByBranch.get(branch) ?? [];
        if (matched.some(claim => !claim.archived)) continue;
        // Generic feat/fix/custom prefixes aren't evidence. An exact recorded branch or the
        // app's current/legacy naming convention is a hint, never proof of ownership or merge.
        if (!matched.length && !APP_BRANCH_PREFIXES.some(prefix => branch.startsWith(`${prefix}/`))) continue;
        add({ projectRoot, location: branch, kind: matched.length ? 'retained-branch' : 'unlinked-branch', sessions: describeSessions(matched) });
      }
    } catch { warn(`Could not read all local branches for: ${projectRoot}`); }
  }
  result.rows.sort((a, b) => a.projectRoot.localeCompare(b.projectRoot) || a.kind.localeCompare(b.kind) || a.location.localeCompare(b.location));
  return result;
}
