/** Working-tree git status, diffs, revert, staging, range evidence, and commit helpers. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GitFileStatus, GitSummary } from '../../shared/types';
import { isOutsideWorkspace } from '../harness/permissions';
import { makeFileChange } from '../util/file-changes';
import { failure, git, gitRoot, readCapped, timedOut } from './exec';

/** A large diff deserves more headroom than status probes; a timeout still surfaces instead of truncating. */
const DIFF_TIMEOUT_MS = 60_000;
/** Cap the bytes read into the main process just to count untracked lines or synthesize a diff. */
const MAX_UNTRACKED_COUNT_BYTES = 512 * 1024;
const MAX_UNTRACKED_DIFF_BYTES = 500_000;
const MAX_SINGLE_FILE_DIFF_BYTES = 2_000_000;
/** A PR reflection reads a bounded patch, not the whole change; the commits carry the rest. */
const MAX_PR_DIFF_CHARS = 12_000;

const diffTimeoutMessage = (): string => 'git diff timed out — the changes are too large to render here. Use the terminal for the full diff.';

/**
 * Lines in a file's text the way `git diff --numstat` counts them: the final newline ends the last
 * line rather than starting another, so an untracked file reads the same as once it is added.
 */
function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export async function gitSummary(cwd: string): Promise<GitSummary> {
  const root = await gitRoot(cwd);
  if (!root) return { isRepo: false, files: [] };
  const [branch, status, numstat, upstream] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames']),
    git(cwd, ['diff', '--numstat', 'HEAD']),
    git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
  ]);
  const base = { isRepo: true as const, root, branch: branch.code === 0 ? branch.stdout.trim() || undefined : undefined };
  // A partial status list is not usable: report the failure instead of rendering a subset of files.
  if (status.code !== 0) {
    return { ...base, files: [], error: timedOut(status) ? 'git status timed out — the change list could not be loaded. Refresh to retry.' : `git status failed: ${failure(status)}` };
  }
  const counts = new Map<string, { additions: number; deletions: number }>();
  // On unborn branches numstat exits non-zero with no output, which is benign; only a timeout means bad counts.
  if (!timedOut(numstat)) {
    for (const line of numstat.stdout.split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (m) counts.set(m[3].trim(), { additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) });
    }
  }
  const files: GitFileStatus[] = [];
  for (const raw of status.stdout.split('\n')) {
    if (!raw.trim()) continue;
    const x = raw[0];
    const y = raw[1];
    let p = raw.slice(3).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    const code = (y !== ' ' ? y : x) as GitFileStatus['status'];
    const st: GitFileStatus['status'] = code === '?' ? '?' : (['M', 'A', 'D', 'R', 'U', 'C', 'T'].includes(code) ? code : 'M') as GitFileStatus['status'];
    const c = counts.get(p);
    let additions = c?.additions;
    if (st === '?' && additions === undefined) {
      const content = await readCapped(path.join(root, p), MAX_UNTRACKED_COUNT_BYTES);
      if (content !== undefined) additions = lineCount(content);
    }
    files.push({ path: p, status: st, staged: x !== ' ' && x !== '?', additions, deletions: c?.deletions });
  }
  let ahead: number | undefined;
  let behind: number | undefined;
  if (upstream.code === 0) {
    const m = upstream.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) {
      ahead = Number(m[1]);
      behind = Number(m[2]);
    }
  }
  const error = timedOut(numstat) ? 'Line counts are unavailable: git diff --numstat timed out.' : undefined;
  return { ...base, files, ahead, behind, ...(error ? { error } : {}) };
}

export async function gitDiff(cwd: string, file?: string, staged = false): Promise<{ diff: string; error?: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { diff: '' };
  if (file) {
    if (isOutsideWorkspace(root, file, path)) return { diff: 'Path outside workspace' };
    const abs = path.join(root, file);
    const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', file]);
    if (timedOut(tracked)) return { diff: '', error: `git timed out while checking ${file}.` };
    if (tracked.truncated) return { diff: '', error: `git output was truncated while checking ${file}.` };
    if (tracked.code !== 0) {
      // Untracked: synthesize an add diff, size-checked before reading.
      const content = await readCapped(abs, MAX_SINGLE_FILE_DIFF_BYTES);
      if (content === undefined) return { diff: '', error: `Binary or very large file: ${file}` };
      return { diff: makeFileChange(root, file, null, content, { oldFileName: '/dev/null' }).diff ?? '' };
    }
    const r = await git(cwd, ['diff', ...(staged ? ['--cached'] : ['HEAD']), '--', file], DIFF_TIMEOUT_MS);
    if (timedOut(r)) return { diff: '', error: diffTimeoutMessage() };
    if (r.truncated) return { diff: '', error: `Diff output was truncated; narrow the change or select a smaller file: ${file}` };
    return { diff: r.stdout };
  }
  const r = await git(cwd, ['diff', ...(staged ? ['--cached'] : ['HEAD'])], DIFF_TIMEOUT_MS);
  if (timedOut(r)) return { diff: '', error: diffTimeoutMessage() };
  if (r.truncated) return { diff: '', error: 'Diff output was truncated; select a file or narrow the change.' };
  const maxDiffBytes = 2_000_000;
  const maxUntrackedFiles = 200;
  const budgetError = 'Combined diff limit reached — select an individual file to view the remaining changes.';
  let out = r.stdout;
  let outputBytes = Buffer.byteLength(out, 'utf8');
  // Never slice a tracked patch to make it fit the aggregate preview.
  if (outputBytes > maxDiffBytes) return { diff: '', error: budgetError };
  let candidates = 0;
  // Bound both total patch bytes and file reads, not just each untracked file's size.
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  if (timedOut(untracked)) return { diff: out, error: 'The untracked-file list timed out — new files may be missing from this diff.' };
  if (untracked.truncated) return { diff: out, error: 'The untracked-file list was truncated — new files may be missing from this diff.' };
  for (const f of untracked.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (candidates++ >= maxUntrackedFiles || outputBytes >= maxDiffBytes) return { diff: out, error: budgetError };
    const content = await readCapped(path.join(root, f), MAX_UNTRACKED_DIFF_BYTES);
    if (content === undefined) continue;
    const patch = makeFileChange(root, f, null, content, { oldFileName: '/dev/null' }).diff ?? '';
    const patchBytes = Buffer.byteLength(patch, 'utf8');
    if (outputBytes + patchBytes > maxDiffBytes) return { diff: out, error: budgetError };
    out += patch;
    outputBytes += patchBytes;
  }
  return { diff: out };
}

export async function gitRevertFile(cwd: string, file: string): Promise<{ ok: boolean; error?: string }> {
  const root = await gitRoot(cwd);
  if (!root) return { ok: false, error: 'Not a git repository' };
  if (isOutsideWorkspace(root, file, path)) return { ok: false, error: 'Path outside workspace' };
  const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', file]);
  if (tracked.code !== 0) {
    try {
      await fs.rm(path.join(root, file), { force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  const r = await git(cwd, ['checkout', 'HEAD', '--', file]);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr || r.stdout };
}

export async function gitStageAll(cwd: string): Promise<{ ok: boolean; error?: string }> {
  const r = await git(cwd, ['add', '-A']);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr };
}

/** Commits and a bounded patch between `base` and `head` (or HEAD), for a PR reflection. */
export async function gitRangeEvidence(cwd: string, base: string, head?: string): Promise<{ commits: string[]; diff: string }> {
  if (!(await gitRoot(cwd))) return { commits: [], diff: '' };
  const range = head ? `${base}...${head}` : `${base}...HEAD`;
  const log = await git(cwd, ['log', '--oneline', '-n', '40', range]);
  const patch = await git(cwd, ['diff', '-U1', range], DIFF_TIMEOUT_MS);
  const commits = log.code === 0 && !log.truncated ? log.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
  const text = patch.stdout ?? '';
  return { commits, diff: text.length > MAX_PR_DIFF_CHARS ? `${text.slice(0, MAX_PR_DIFF_CHARS)}\n…(truncated)` : text };
}

export async function gitCommit(cwd: string, message: string): Promise<{ ok: boolean; output: string }> {
  await git(cwd, ['add', '-A']);
  const r = await git(cwd, ['commit', '-m', message]);
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}
