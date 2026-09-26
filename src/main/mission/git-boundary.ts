/** Mission Git process defaults and remote admission. Never persist or echo rejected endpoints. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCapture, which, type CaptureResult } from '../runtime';

/** Keep the user's ordinary identity/configuration, but never inherit repository/index routing,
 * injected Git configuration, helpers, or prompt settings from the desktop's launch environment. */
export function missionGitEnvironment(index?: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    (!key.toUpperCase().startsWith('GIT_') || /^GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)$/i.test(key))
    && !/^(?:GCM_INTERACTIVE|SSH_ASKPASS|SSH_ASKPASS_REQUIRE)$/i.test(key)));
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ASKPASS: '', GCM_INTERACTIVE: 'never', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
    GIT_SSH_COMMAND: 'ssh -oBatchMode=yes', GIT_SSH_VARIANT: 'ssh', GIT_ALLOW_PROTOCOL: 'file:https:ssh',
    ...(index ? { GIT_INDEX_FILE: index } : {}) };
}

/** Explicit --repo supplies both repository and host. Preserve ordinary credential storage,
 * but never allow launch-environment routing to redirect a GitHub delivery operation. */
export function missionGitHubEnvironment(): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(missionGitEnvironment()).filter(([key]) => !/^GH_(?:REPO|HOST|HTTP_UNIX_SOCKET)$/i.test(key))), GH_PROMPT_DISABLED: '1' };
}

export function missionGitArgs(args: string[]): string[] {
  return ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false',
    '-c', 'core.askPass=', '-c', 'credential.interactive=false',
    // Owned worktrees sit deep under %APPDATA% (~140 of MAX_PATH's 260 characters before the
    // first repository path), so ordinary project trees would otherwise fail to materialize.
    ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []), ...args];
}

export class MissionGitFilterError extends Error {
  constructor() {
    super('Cannot safely disable configured Git filters for Mission. Content operations require a complete supported filter configuration.');
    this.name = 'MissionGitFilterError';
  }
}

// Only object/ref/config plumbing that cannot convert working-tree bytes bypasses discovery. In
// particular, even status and write-tree can run clean/process filters while reading an index.
const FILTER_FREE_COMMANDS = new Set(['config', 'rev-parse', 'symbolic-ref', 'show-ref', 'for-each-ref', 'ls-tree', 'update-ref', 'commit-tree']);

/** Git has no wildcard switch for disabling content filters. Enumerate the effective keys
 * (including global/local/worktree and conditional includes) in the exact conversion cwd.
 * Never cache them: branches, worktree config and filter attributes can change between calls.
 * Read names only, so executable values never become diagnostics or another process's argv. */
async function filterOverrides(file: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string[]> {
  const result = await runCapture(file, missionGitArgs(['config', '--null', '--name-only', '--includes', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$']), { cwd, env, timeoutMs });
  if (result.truncated || result.timedOut || ![0, 1].includes(result.code ?? -1) || (result.code === 1 ? result.stdout !== '' : !result.stdout.endsWith('\0'))) throw new MissionGitFilterError();
  const drivers = new Set<string>();
  for (const key of result.code === 1 ? [] : result.stdout.slice(0, -1).split('\0')) {
    // A subsection containing '=' cannot be expressed unambiguously with git -c. Refuse
    // nonportable/undecodable names too rather than disabling a different driver by accident.
    const match = /^filter\.([A-Za-z0-9._/-]+)\.(?:clean|smudge|process|required)$/.exec(key);
    if (!match) throw new MissionGitFilterError();
    drivers.add(match[1]);
  }
  return [...drivers].flatMap((driver) => ['-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.smudge=`, '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`]);
}

export async function runMissionGit(cwd: string, args: string[], options: { index?: string; input?: string; timeoutMs?: number; filterCwd?: string } = {}): Promise<CaptureResult> {
  // A checkout inside worktree-add would resolve branch-conditional configuration in a cwd
  // that does not exist at discovery time. Provision without checkout, then read-tree there.
  if (args[0] === 'worktree') {
    if (args[1] === 'add' && (!args.includes('--no-checkout') || args.includes('--checkout'))) throw new MissionGitFilterError();
    if (args[1] === 'remove' && !options.filterCwd) throw new MissionGitFilterError();
  }
  const file = which('git') ?? 'git', env = missionGitEnvironment(options.index), timeoutMs = options.timeoutMs ?? 60_000;
  const filterFree = FILTER_FREE_COMMANDS.has(args[0]) || args[0] === 'cat-file' && ['-t', 'blob'].includes(args[1]);
  const overrides = filterFree ? [] : await filterOverrides(file, options.filterCwd ?? cwd, env, timeoutMs);
  return runCapture(file, missionGitArgs([...overrides, ...args]), { cwd, env, input: options.input, timeoutMs });
}

type GitProbe = (args: string[]) => Promise<CaptureResult>;
const endpointError = () => new Error('Unsupported Mission remote endpoint. Use an absolute local repository path or a standard HTTPS/SSH URL without inline credentials, query tokens or custom remote helpers.');
const relativeEndpointError = () => new Error('Relative Mission remote endpoints are unsupported. Configure a fully qualified absolute local repository path in the original source checkout before approval.');

/** Relative filesystem URLs are deliberately unsupported: their meaning changes between the
 * source and owned worktrees. A user must configure an absolute endpoint before approving it. */
export function missionRemoteUrl(value: string): string {
  if (!value || value !== value.trim() || /[\x00-\x1f\x7f?#]/.test(value) || value.startsWith('-')) throw endpointError();
  if (path.isAbsolute(value)) {
    // Windows root-relative paths (\\repo or /repo) change meaning across drive-letter worktrees.
    if (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value)) throw relativeEndpointError();
    return value;
  }
  if (process.platform === 'win32' && /^[A-Za-z]:/.test(value)) throw relativeEndpointError();
  if (/\s/.test(value)) throw endpointError();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw endpointError(); }
    if (url.password || url.search || url.hash) throw endpointError();
    if (url.protocol === 'https:') {
      if (url.username || /@/.test(value.slice(value.indexOf('://') + 3).split('/')[0]) || !url.hostname || value.includes('\\')) throw endpointError();
      return value;
    }
    if (url.protocol === 'ssh:') {
      if (!/^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9a-fA-F:.]+\])$/.test(url.hostname) || (url.username && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(url.username)) || value.includes('\\')) throw endpointError();
      return value;
    }
    if (url.protocol === 'file:' && !url.username) {
      try { const file = fileURLToPath(url); if (path.isAbsolute(file)) return file; } catch { /* Refuse platform-ambiguous file URLs. */ }
    }
    throw endpointError();
  }
  // scp-like SSH permits an ordinary account name, not password/token userinfo or a helper.
  if (/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9a-fA-F:]+\]):[^:\\].*$/.test(value) && !value.includes('::')) return value;
  if (!value.includes(':')) throw relativeEndpointError();
  throw endpointError();
}

export interface MissionGitHubTarget { host: string; owner: string; name: string; repository: string; }

/** A PR authority can only come from the admitted clone endpoint itself, not gh defaults,
 * a caller-supplied repository, or a local→host mapping. Support GitHub.com/Enterprise's
 * HOST/OWNER/REPO shape on standard HTTPS/SSH ports; refuse paths we cannot bind exactly. */
export function missionGitHubTarget(endpoint: string): MissionGitHubTarget {
  const unsupported = () => new Error('Unsupported Mission GitHub delivery endpoint. PR delivery requires a standard HTTPS/SSH HOST/OWNER/REPO endpoint; local repositories, alternate ports and other path layouts cannot establish GitHub authority.');
  if (missionRemoteUrl(endpoint) !== endpoint) throw unsupported();
  const match = /^https:\/\/([^/:]+)(?::443)?\/([^/]+)\/([^/]+)\/?$/i.exec(endpoint)
    ?? /^ssh:\/\/(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?([^/:]+)(?::22)?\/([^/]+)\/([^/]+)\/?$/i.exec(endpoint)
    ?? /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?([A-Za-z0-9][A-Za-z0-9.-]*):([^/]+)\/([^/]+)\/?$/.exec(endpoint);
  if (!match) throw unsupported();
  const host = match[1].toLowerCase(), owner = match[2], name = match[3].replace(/\.git$/i, '');
  if (host.length > 253 || !host.includes('.') || host.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw unsupported();
  return { host, owner, name, repository: `${host}/${owner}/${name}` };
}

/** get-url expands insteadOf once; passing its result back to Git can otherwise expand it a
 * second time (or use pushInsteadOf) and contact a different endpoint than the user approved. */
export async function assertMissionRemoteRouting(cwd: string, endpoint: string, run: GitProbe = (args) => runMissionGit(cwd, args)): Promise<void> {
  if (missionRemoteUrl(endpoint) !== endpoint) throw endpointError();
  const result = await run(['config', '--null', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$']);
  if (result.timedOut || result.truncated || (result.code !== 0 && result.code !== 1)) throw new Error('Cannot verify Mission remote endpoint routing. Check Git URL rewrite configuration before retrying.');
  for (const entry of result.stdout.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\n');
    if (separator < 0) throw new Error('Cannot verify Mission remote endpoint rewrite configuration.');
    if (endpoint.startsWith(entry.slice(separator + 1))) throw new Error('Git URL rewrites would redirect the approved Mission endpoint. Configure a stable absolute/HTTPS/SSH endpoint without another matching rewrite before approval.');
  }
}

/** Only local configuration probes occur here. Rejected output never enters errors or argv. */
export async function readMissionRemoteEndpoint(cwd: string, remote: string, run: GitProbe = (args) => runMissionGit(cwd, args)): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(remote) || remote.includes('..')) throw new Error('Invalid Mission remote name.');
  const read = async (push: boolean): Promise<string> => {
    const result = await run(['remote', 'get-url', ...(push ? ['--push'] : []), '--all', remote]);
    if (result.code !== 0 || result.truncated || result.timedOut) throw new Error('Cannot read the approved Mission remote endpoint. Configure one fetch/push URL in the original source checkout.');
    const urls = result.stdout.replace(/\r?\n$/, '').split(/\r?\n/);
    if (urls.length !== 1) throw new Error('An approved Mission remote needs one unambiguous fetch/push endpoint.');
    return missionRemoteUrl(urls[0]);
  };
  const fetch = await read(false), push = await read(true);
  if (fetch !== push) throw new Error('An approved Mission remote needs the same fetch/push endpoint.');
  await assertMissionRemoteRouting(cwd, fetch, run);
  return fetch;
}

/** Config and network diagnostics may echo a raw/replaced credential-bearing URL. */
export function sensitiveGitDiagnostic(args: string[]): boolean {
  return ['config', 'remote', 'ls-remote', 'fetch', 'push'].includes(args[0]);
}
