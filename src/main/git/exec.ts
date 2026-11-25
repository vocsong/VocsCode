/** Shared git/gh subprocess runners, path helpers, and logging for `src/main/git/*`. */
import fsCallback, { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log';
import { runCapture, which, type CaptureResult } from '../runtime';

export const gitBin = () => which('git') ?? 'git';
export const ghBin = () => which('gh');

export const BASE_BRANCHES = ['develop', 'master', 'main'];
export const BRANCH_NAME_RE = /^[\w][\w./-]*$/;
export const GH_REQUIRED = 'GitHub CLI (gh) is required — install it and run `gh auth login`.';

/** Module-level on purpose: these helpers are plain functions called from many places, and the log is one. */
let gitLog: Logger = () => undefined;

/** Routes git/gh diagnostics (timeouts, non-zero exits) into the main log. Off until the host calls it. */
export function setGitLog(log: Logger): void {
  gitLog = log;
}

export function logGit(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  gitLog(level, message);
}

export type GitRun = { code: number | null; stdout: string; stderr: string; timedOut?: boolean; truncated?: boolean };
export type PrResult = { ok: boolean; url?: string; output?: string };

/** runCapture marks a killed process with timedOut; legacy fakes only carry the stderr marker. */
export const timedOut = (r: GitRun): boolean => r.timedOut === true || (r.code === null && /timed out after \d+ms/.test(r.stderr));

export const failure = (r: GitRun): string => (r.stderr || r.stdout).trim() || `git exited with ${r.code ?? 'no status'}`;

/** Enough of the argv to identify the command; commit messages and long refspecs are cut. */
export function describeArgs(args: string[]): string {
  const s = args.join(' ');
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** Reads a file only when it is small enough; a multi-GB artifact is never buffered just to be sized. */
export async function readCapped(file: string, maxBytes: number): Promise<string | undefined> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > maxBytes) return undefined;
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

export async function git(cwd: string, args: string[], timeoutMs = 20_000): Promise<GitRun> {
  const r = await runCapture(gitBin(), args, { cwd, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  // Probes fail routinely (no repo, unborn branch, no upstream), so a non-zero exit is debug; a
  // timeout means the panel showed a partial or empty result and deserves a visible line.
  if (timedOut(r)) gitLog('warn', `git ${describeArgs(args)} in ${cwd} timed out after ${timeoutMs}ms`);
  else if (r.code !== 0) gitLog('debug', `git ${describeArgs(args)} in ${cwd} exited ${r.code ?? 'null'}: ${failure(r).split('\n')[0].slice(0, 300)}`);
  return r;
}

/** Runs the GitHub CLI; `input` is written to its stdin (for `--body-file -`). */
export async function gh(cwd: string | undefined, args: string[], timeoutMs = 120_000, input?: string): Promise<CaptureResult> {
  const r = await runCapture(ghBin() ?? 'gh', args, { cwd, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...(input !== undefined ? { input } : {}) });
  // gh talks to GitHub: a timeout or a non-zero exit here is the reason a PR badge or list is missing.
  const location = cwd ? ` in ${cwd}` : '';
  if (timedOut(r)) gitLog('warn', `gh ${describeArgs(args)}${location} timed out after ${timeoutMs}ms`);
  else if (r.code !== 0) gitLog('debug', `gh ${describeArgs(args)}${location} exited ${r.code ?? 'null'}: ${failure(r).split('\n')[0].slice(0, 300)}`);
  return r;
}

export async function gitRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (r.code !== 0 || r.truncated) return null;
  return r.stdout.trim().replace(/\//g, path.sep);
}

/** Reads HEAD in this exact folder, including unborn branches and linked worktrees. */
export async function gitFolderBranch(cwd: string): Promise<{ branch?: string; detached?: boolean }> {
  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.code === 0 && branch.stdout.trim()) return { branch: branch.stdout.trim() };
  const head = await git(cwd, ['rev-parse', '--verify', '--short', 'HEAD']);
  return head.code === 0 ? { branch: head.stdout.trim(), detached: true } : {};
}

export const pathKey = (value: string): string => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));

export const within = (root: string, target: string): boolean => {
  const relative = path.relative(pathKey(root), pathKey(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** A directory's real long path for comparison: links resolved, 8.3 short names expanded, case folded on Windows. */
export async function canonicalDir(dir: string): Promise<string> {
  const resolved = path.resolve(dir);
  const real = await new Promise<string>((resolve) => fsCallback.realpath.native(resolved, (error, out) => resolve(error ? resolved : out)));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}
