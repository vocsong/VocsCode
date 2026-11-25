/** Guided git repository initialization, identity configuration, remote wiring, push, and GitHub repo creation. */
import path from 'node:path';
import type { GitSetupStatus } from '../../shared/types';
import { runCapture } from '../runtime';
import { gh, ghBin, git, gitRoot, type PrResult } from './exec';

/** Accepts an http(s)/git/ssh URL or scp-like `git@host:path`. Option-looking strings are rejected so a remote cannot inject git flags. */
export function isRemoteUrl(url: string): boolean {
  const u = url.trim();
  if (!u || /[\s"'`\\]/.test(u)) return false;
  if (/^(?:https?|git|ssh):\/\/[^\s/]+/i.test(u)) return true;
  return /^[\w.-]+@[\w.-]+:[^\s]+$/.test(u);
}

/** Whether gh can act on the user's behalf; one-click repository creation and credential setup need auth. */
async function ghAuthStatus(): Promise<GitSetupStatus['gh']> {
  const bin = ghBin();
  if (!bin) return { installed: false, authenticated: false };
  const r = await runCapture(bin, ['auth', 'status'], { timeoutMs: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const account = `${r.stdout}\n${r.stderr}`.match(/Logged in to [^\s]+ (?:account|as) ([^\s(]+)/i)?.[1];
  return { installed: true, authenticated: r.code === 0, ...(account ? { account } : {}) };
}

/** Guided-setup state: what the folder already has and what is left before it can be pushed. */
export async function gitSetupStatus(cwd: string): Promise<GitSetupStatus> {
  const ghState = await ghAuthStatus();
  const root = await gitRoot(cwd);
  if (!root) return { isRepo: false, hasCommits: false, pushed: false, published: false, identity: {}, gh: ghState };
  const [branch, head, remote, nameCfg, emailCfg, commonDir, remotes] = await Promise.all([
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(cwd, ['remote', 'get-url', 'origin']),
    git(cwd, ['config', '--get', 'user.name']),
    git(cwd, ['config', '--get', 'user.email']),
    git(cwd, ['rev-parse', '--git-common-dir']),
    git(cwd, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes'])
  ]);
  const branchName = branch.stdout.trim() || undefined;
  const hasCommits = head.code === 0;
  const remoteUrl = remote.code === 0 ? remote.stdout.trim() || undefined : undefined;
  const name = nameCfg.code === 0 ? nameCfg.stdout.trim() || undefined : undefined;
  const email = emailCfg.code === 0 ? emailCfg.stdout.trim() || undefined : undefined;
  // A linked worktree's common dir is the main repo's .git; dismissing the guide there must stick for every worktree.
  const mainRoot = commonDir.code === 0 && commonDir.stdout.trim() ? path.dirname(path.resolve(cwd, commonDir.stdout.trim())) : undefined;
  const published = remotes.code === 0 && remotes.stdout.trim().length > 0;
  let pushed = false;
  if (branchName && hasCommits && remoteUrl) {
    pushed = (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branchName}`])).code === 0;
  }
  return {
    isRepo: true,
    root,
    ...(mainRoot ? { mainRoot } : {}),
    ...(branchName ? { branch: branchName } : {}),
    hasCommits,
    ...(remoteUrl ? { remote: remoteUrl } : {}),
    pushed,
    published,
    identity: { ...(name ? { name } : {}), ...(email ? { email } : {}) },
    gh: ghState
  };
}

/** A value safe to pass to `git config <key> <value>`: non-empty, single-line, never option-looking. */
const validConfigValue = (v: string): boolean => v.length > 0 && !/[\r\n\0]/.test(v) && !v.startsWith('-');

/** Sets the git author identity on this repository (or the machine), so the first commit can be created. */
export async function gitSetIdentity(cwd: string, name: string, email: string, global: boolean): Promise<{ ok: boolean; error?: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, error: 'Initialize git first.' };
  const n = name.trim();
  const e = email.trim();
  if (!validConfigValue(n)) return { ok: false, error: 'Enter your name (one line, no leading dash).' };
  if (!/^[^\s@]+@[^\s@]+$/.test(e) || !validConfigValue(e)) return { ok: false, error: 'Enter an email address like you@example.com.' };
  const scope = global ? '--global' : '--local';
  const entries: [string, string][] = [
    ['user.name', n],
    ['user.email', e]
  ];
  for (const [key, value] of entries) {
    const r = await git(root, ['config', scope, key, value]);
    if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() || `git config ${key} failed` };
  }
  return { ok: true };
}

/** The signed-in GitHub account's name and email (a noreply address when the profile email is private). */
export async function gitGithubIdentity(cwd: string): Promise<{ ok: boolean; login?: string; name?: string; email?: string; error?: string }> {
  if (!ghBin()) return { ok: false, error: 'GitHub CLI (gh) is not installed.' };
  const auth = await ghAuthStatus();
  if (!auth.authenticated) return { ok: false, error: 'Sign in to GitHub first — run `gh auth login`.' };
  const r = await gh(cwd, ['api', 'user'], 20_000);
  if (r.truncated) return { ok: false, error: 'GitHub profile response was truncated.' };
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() || 'Could not read your GitHub profile.' };
  try {
    const u = JSON.parse(r.stdout) as { login?: string; name?: string | null; email?: string | null; id?: number };
    const login = u.login?.trim() || undefined;
    const name = u.name?.trim() || login;
    let email = u.email?.trim() || undefined;
    // GitHub hides the profile email when it is private; the ID-based noreply address is what GitHub
    // itself suggests, and commits authored with it are attributed to the account.
    if (!email && login && u.id) email = `${u.id}+${login}@users.noreply.github.com`;
    return { ok: true, ...(login ? { login } : {}), ...(name ? { name } : {}), ...(email ? { email } : {}) };
  } catch {
    return { ok: false, error: 'GitHub returned something that is not JSON.' };
  }
}

/** `git init` on the default branch `main`, with a fallback for git builds that predate `-b`. */
export async function gitInit(cwd: string): Promise<{ ok: boolean; error?: string }> {
  const existing = await gitRoot(cwd);
  if (existing) return { ok: false, error: `Already inside the repository at ${existing}` };
  const r = await git(cwd, ['init', '-b', 'main']);
  if (r.code === 0) return { ok: true };
  const fallback = await git(cwd, ['init']);
  if (fallback.code !== 0) return { ok: false, error: (fallback.stderr || fallback.stdout).trim() || 'git init failed' };
  await git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { ok: true };
}

/** First commit in a fresh repository; an empty folder gets an empty commit so it can be pushed. */
export async function gitInitialCommit(cwd: string, message: string): Promise<{ ok: boolean; output: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, output: 'Not a git repository' };
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code === 0) return { ok: false, output: 'This repository already has commits.' };
  await git(cwd, ['add', '-A']);
  const staged = await git(cwd, ['diff', '--cached', '--name-only']);
  const empty = staged.stdout.trim() ? [] : ['--allow-empty'];
  const r = await git(cwd, ['commit', ...empty, '-m', message.trim() || 'Initial commit']);
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() || (r.code === 0 ? 'Created the initial commit.' : 'git commit failed') };
}

/** Points `origin` at the pasted repository URL, replacing an existing origin. */
export async function gitSetRemote(cwd: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, error: 'Initialize git first.' };
  if (!isRemoteUrl(url)) return { ok: false, error: 'Enter a repository URL like https://github.com/you/project.git or git@github.com:you/project.git.' };
  const clean = url.trim();
  const existing = await git(cwd, ['remote', 'get-url', 'origin']);
  const r = existing.code === 0 ? await git(cwd, ['remote', 'set-url', 'origin', clean]) : await git(cwd, ['remote', 'add', 'origin', clean]);
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() || 'Could not set the origin remote.' };
}

/** Pushes the current branch to origin and records it as the upstream; credentials are never prompted for. */
export async function gitPush(cwd: string): Promise<{ ok: boolean; output: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, output: 'Not a git repository' };
  const branch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  if (!branch) return { ok: false, output: 'Detached HEAD — check out a branch first.' };
  if ((await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) return { ok: false, output: 'Nothing to push yet — create the first commit.' };
  if ((await git(cwd, ['remote', 'get-url', 'origin'])).code !== 0) return { ok: false, output: 'No origin remote yet — connect a GitHub repository first.' };
  const r = await git(cwd, ['push', '-u', 'origin', branch], 120_000);
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() || (r.code === 0 ? `Pushed ${branch} to origin.` : 'git push failed') };
}

/** Creates a GitHub repository for this folder through gh, adds origin and pushes the first branch. */
export async function gitCreateGitHubRepo(cwd: string, name: string, isPrivate: boolean): Promise<PrResult> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, output: 'Initialize git first.' };
  if (!ghBin()) return { ok: false, output: 'GitHub CLI (gh) is not installed — install it, or create the repository on github.com and paste its URL.' };
  const clean = name.trim();
  if (!/^[A-Za-z0-9][\w.-]*$/.test(clean)) return { ok: false, output: 'Repository names may use letters, numbers, dot, dash and underscore.' };
  const auth = await ghAuthStatus();
  if (!auth.authenticated) return { ok: false, output: 'Not signed in to GitHub — run `gh auth login`, then try again.' };
  if ((await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) return { ok: false, output: 'Create the first commit before publishing.' };
  if ((await git(cwd, ['remote', 'get-url', 'origin'])).code === 0) return { ok: false, output: 'origin is already configured — use Push to publish this repository.' };
  const r = await gh(root, ['repo', 'create', clean, isPrivate ? '--private' : '--public', '--source', root, '--remote', 'origin', '--push'], 180_000);
  const out = (r.stdout + r.stderr).trim();
  if (r.truncated) return { ok: false, output: 'gh repo create response was truncated' };
  if (r.code !== 0) return { ok: false, output: out || 'gh repo create failed' };
  return { ok: true, url: out.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/.]+/)?.[0], output: out };
}
