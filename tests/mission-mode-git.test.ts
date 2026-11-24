/**
 * Mission mode git against real temp repositories: worktree names, landing Builders on the Lead
 * branch one at a time, junction-safe cleanup, and the one push + PR at the end through a fake
 * `gh` on PATH that records its arguments and the body it read from stdin.
 */
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  builderDiff, builderLog, cleanupWorktree, createBuilderWorktree, currentHead, editPrBody, ensureLeadWorktree,
  isLanded, landOnLead, openPr, prState, pushBranch, statusPorcelain
} from '../src/main/mission-mode/git-ops';
import { clearWhichCache } from '../src/main/runtime';

const isWin = process.platform === 'win32';
const PR_URL = 'https://github.com/acme/repo/pull/7';

const GH_SCRIPT = `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const at = args.indexOf('--body-file');
const stdin = at >= 0 && args[at + 1] === '-' ? readFileSync(0, 'utf8') : undefined;
appendFileSync(process.env.GH_LOG, JSON.stringify({ args, stdin }) + '\\n');
const url = ${JSON.stringify(PR_URL)};
if (args[0] === 'pr' && (args[1] === 'create' || args[1] === 'edit')) console.log(url);
else if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify({ number: 7, state: process.env.GH_STATE || 'OPEN', url }));
`;

let tmp: string;
let oldPath: string | undefined;
let oldLog: string | undefined;
let ghLog: string;

const run = (args: string[], cwd: string) =>
  new Promise<string>((resolve, reject) => execFile('git', args, { cwd }, (e, stdout, stderr) => (e ? reject(new Error(`${args.join(' ')}: ${stderr || e.message}`)) : resolve(String(stdout).trim()))));

async function commitFile(cwd: string, file: string, content: string, message = `add ${file}`): Promise<string> {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await fs.writeFile(path.join(cwd, file), content);
  await run(['add', '--', file], cwd);
  await run(['commit', '-qm', message], cwd);
  return run(['rev-parse', 'HEAD'], cwd);
}

let repoCount = 0;
/** A fresh project on `develop` with one commit, optionally pushed to a bare `origin`. */
async function makeRepo(withOrigin = true): Promise<{ project: string; origin?: string }> {
  const dir = path.join(tmp, `r${++repoCount}`);
  const project = path.join(dir, 'project');
  await fs.mkdir(project, { recursive: true });
  await run(['init', '-q'], project);
  await run(['checkout', '-qb', 'develop'], project);
  await run(['config', 'user.email', 'test@example.com'], project);
  await run(['config', 'user.name', 'Test'], project);
  await run(['config', 'core.autocrlf', 'false'], project);
  await commitFile(project, 'README.md', '# project\n', 'init');
  if (!withOrigin) return { project };
  const origin = path.join(dir, 'origin.git');
  await run(['init', '-q', '--bare', origin], dir);
  await run(['remote', 'add', 'origin', origin], project);
  await run(['push', '-q', 'origin', 'develop'], project);
  return { project, origin };
}

const ghCalls = async (): Promise<{ args: string[]; stdin?: string }[]> =>
  (await fs.readFile(ghLog, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-git-')));
  const bin = path.join(tmp, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'gh.mjs'), GH_SCRIPT);
  if (isWin) await fs.writeFile(path.join(bin, 'gh.cmd'), `@"${process.execPath}" "%~dp0gh.mjs" %*\r\n`);
  else {
    await fs.writeFile(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/gh.mjs" "$@"\n`);
    await fs.chmod(path.join(bin, 'gh'), 0o755);
  }
  ghLog = path.join(tmp, 'gh.log');
  await fs.writeFile(ghLog, '');
  oldPath = process.env.PATH;
  oldLog = process.env.GH_LOG;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  process.env.GH_LOG = ghLog;
  clearWhichCache();
});

afterAll(async () => {
  process.env.PATH = oldPath;
  if (oldLog === undefined) delete process.env.GH_LOG;
  else process.env.GH_LOG = oldLog;
  clearWhichCache();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('mission worktrees', () => {
  it('names the Lead mission/<slug> and Builders mission/<slug>-b<n>, skipping leftover names', async () => {
    const { project } = await makeRepo(false);
    const head = await run(['rev-parse', 'HEAD'], project);
    // Uncommitted work in the project checkout stays there.
    await fs.writeFile(path.join(project, 'README.md'), '# local edit\n');
    const lead = await ensureLeadWorktree(project, 'Fix the widget');
    if (!lead.ok) throw new Error(lead.error);
    expect(lead).toMatchObject({ branch: 'mission/fix-the-widget', owned: true, startSha: head, baseBranch: 'develop', uncommittedAtStart: true });
    expect(path.relative(project, lead.path)).toBe(path.join('.vocs-code', 'worktrees', 'fix-the-widget'));
    expect(await fs.readFile(path.join(lead.path, 'README.md'), 'utf8')).toBe('# project\n');

    await run(['branch', 'mission/fix-the-widget-b2'], project);
    const b1 = await createBuilderWorktree(project, lead.branch, 1);
    const b2 = await createBuilderWorktree(project, lead.branch, 2);
    expect(b1).toMatchObject({ ok: true, branch: 'mission/fix-the-widget-b1', startSha: head });
    expect(b2).toMatchObject({ ok: true, branch: 'mission/fix-the-widget-b2-2' });
    expect(await createBuilderWorktree(project, 'mission/nope', 3)).toMatchObject({ ok: false, error: expect.stringContaining('does not exist') });

    // A session that already has its worktree keeps it; the mission does not own it.
    if (!b1.ok) throw new Error(b1.error);
    const reused = await ensureLeadWorktree(project, 'again', { cwd: b1.path, branch: b1.branch });
    expect(reused).toMatchObject({ ok: true, path: b1.path, branch: b1.branch, owned: false, uncommittedAtStart: false });
    expect(await ensureLeadWorktree(path.join(tmp, 'bin'), 'x')).toMatchObject({ ok: false });
  });
});

describe('landing on the Lead branch', () => {
  async function mission() {
    const { project } = await makeRepo(false);
    const lead = await ensureLeadWorktree(project, 'land');
    if (!lead.ok) throw new Error(lead.error);
    const b1 = await createBuilderWorktree(project, lead.branch, 1);
    const b2 = await createBuilderWorktree(project, lead.branch, 2);
    if (!b1.ok || !b2.ok) throw new Error('builder worktree');
    const input = (b: { path: string; branch: string }) => ({ missionId: `m${repoCount}`, leadWorktree: lead.path, leadBranch: lead.branch, builderWorktree: b.path, builderBranch: b.branch });
    return { project, lead, b1, b2, input };
  }

  it('lands one Builder at a time: of two concurrent lands, the second re-checks and is told to merge again', async () => {
    const { project, lead, b1, b2, input } = await mission();
    const tip1 = await commitFile(b1.path, 'one.txt', '1\n');
    const tip2 = await commitFile(b2.path, 'two.txt', '2\n');

    const [first, second] = await Promise.all([landOnLead(input(b1)), landOnLead(input(b2))]);
    expect(first).toEqual({ ok: true, sha: tip1, commits: 1, alreadyLanded: false });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error).toContain(`has moved since you last merged it. Run \`git merge ${lead.branch}\``);
    expect(await run(['rev-parse', 'HEAD'], lead.path)).toBe(tip1);

    // The second Builder merges the Lead branch, then lands on top of the first.
    await run(['merge', '-q', '--no-edit', lead.branch], b2.path);
    const merged = await run(['rev-parse', 'HEAD'], b2.path);
    expect(await landOnLead(input(b2))).toEqual({ ok: true, sha: merged, commits: 2, alreadyLanded: false });
    expect(await fs.readFile(path.join(lead.path, 'two.txt'), 'utf8')).toBe('2\n');
    expect(await isLanded(project, lead.branch, b1.branch)).toEqual({ ok: true, landed: true });
    expect(await isLanded(project, lead.branch, b2.branch)).toEqual({ ok: true, landed: true });
    expect(tip2).not.toBe(merged);
    // Nothing new: already landed, Lead unchanged.
    expect(await landOnLead(input(b1))).toEqual({ ok: true, sha: merged, commits: 0, alreadyLanded: true });
  });

  it('refuses while either tree is dirty and leaves the Lead branch where it was', async () => {
    const { lead, b1, input } = await mission();
    const before = await run(['rev-parse', 'HEAD'], lead.path);
    await commitFile(b1.path, 'one.txt', '1\n');
    expect(await isLanded(lead.path, lead.branch, b1.branch)).toEqual({ ok: true, landed: false });

    await fs.writeFile(path.join(b1.path, 'scratch.txt'), 'wip\n');
    const dirtyBuilder = await landOnLead(input(b1));
    expect(dirtyBuilder).toMatchObject({ ok: false, error: expect.stringContaining('Your worktree has uncommitted changes (1 path)') });
    await fs.rm(path.join(b1.path, 'scratch.txt'));

    await fs.writeFile(path.join(lead.path, 'README.md'), 'shared builder wip\n');
    expect(await landOnLead(input(b1))).toMatchObject({ ok: false, error: expect.stringContaining("The Lead's worktree has uncommitted changes") });
    expect(await run(['rev-parse', 'HEAD'], lead.path)).toBe(before);
    expect(await statusPorcelain(lead.path)).toEqual({ ok: true, clean: false, entries: [{ code: ' M', path: 'README.md' }] });
  });

  it("shows the Lead a Builder's diff and log read-only, untracked files listed by name", async () => {
    const { b1 } = await mission();
    expect(await currentHead(b1.path)).toEqual({ ok: true, sha: b1.startSha, branch: b1.branch });
    const start = b1.startSha;
    await commitFile(b1.path, 'src/feature.ts', 'export const x = 1;\n', 'Add the feature');
    await fs.writeFile(path.join(b1.path, 'notes.txt'), 'untracked\n');
    const diff = await builderDiff(b1.path, { from: start });
    expect(diff).toMatchObject({ ok: true, truncated: false, untracked: ['notes.txt'] });
    expect(diff.ok && diff.text).toContain('+export const x = 1;');
    expect(diff.ok && diff.text).toContain('Untracked files (not in the diff):\n  notes.txt');
    const stat = await builderDiff(b1.path, { from: start, stat: true, maxChars: 20 });
    expect(stat).toMatchObject({ ok: true, truncated: true });
    const log = await builderLog(b1.path, { from: start });
    expect(log).toMatchObject({ ok: true, count: 1 });
    expect(log.ok && log.text).toMatch(/^[0-9a-f]+ Add the feature \(Test, /);
    expect(await builderDiff(b1.path, { from: '--output=x' })).toEqual({ ok: false, error: 'Invalid revision.' });
  });
});

describe('cleanup', () => {
  it('unlinks junctioned node_modules before removing a merged worktree: the link targets survive', async () => {
    const { project } = await makeRepo(false);
    const lead = await ensureLeadWorktree(project, 'clean');
    if (!lead.ok) throw new Error(lead.error);
    const b = await createBuilderWorktree(project, lead.branch, 1);
    if (!b.ok) throw new Error(b.error);
    await commitFile(b.path, 'one.txt', '1\n');
    expect(await landOnLead({ missionId: 'clean', leadWorktree: lead.path, leadBranch: lead.branch, builderWorktree: b.path, builderBranch: b.branch })).toMatchObject({ ok: true });

    const target = path.join(tmp, `nm-target-${repoCount}`);
    const nested = path.join(tmp, `nm-nested-${repoCount}`);
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(target, 'keep.txt'), 'keep\n');
    await fs.writeFile(path.join(nested, 'keep.txt'), 'keep\n');
    await fs.symlink(target, path.join(b.path, 'node_modules'), isWin ? 'junction' : 'dir');
    await fs.mkdir(path.join(b.path, 'packages', 'a'), { recursive: true });
    await fs.symlink(nested, path.join(b.path, 'packages', 'a', 'node_modules'), isWin ? 'junction' : 'dir');

    const result = await cleanupWorktree({ projectRoot: project, path: b.path, branch: b.branch, mergedInto: [lead.branch, 'develop'] });
    expect(existsSync(path.join(target, 'keep.txt'))).toBe(true);
    expect(existsSync(path.join(nested, 'keep.txt'))).toBe(true);
    expect(result).toMatchObject({ ok: true, removed: true, branch: { name: b.branch, deleted: true } });
    expect(result.ok && [...result.unlinked].sort()).toEqual([path.join(b.path, 'node_modules'), path.join(b.path, 'packages', 'a', 'node_modules')].sort());
    expect(existsSync(b.path)).toBe(false);
    await expect(run(['rev-parse', '--verify', '--quiet', `refs/heads/${b.branch}`], project)).rejects.toThrow();
  });

  it('keeps an unmerged branch and says so; deletes one whose tip is on origin; refuses folders outside the worktrees', async () => {
    const { project } = await makeRepo(true);
    const lead = await ensureLeadWorktree(project, 'keep');
    if (!lead.ok) throw new Error(lead.error);
    const b1 = await createBuilderWorktree(project, lead.branch, 1);
    const b2 = await createBuilderWorktree(project, lead.branch, 2);
    if (!b1.ok || !b2.ok) throw new Error('builder worktree');
    const tip = await commitFile(b1.path, 'unmerged.txt', 'x\n');
    await commitFile(b2.path, 'pushed.txt', 'y\n');
    expect(await pushBranch(b2.path, b2.branch)).toMatchObject({ ok: true });

    const kept = await cleanupWorktree({ projectRoot: project, path: b1.path, branch: b1.branch, mergedInto: [lead.branch] });
    expect(kept).toMatchObject({ ok: true, removed: true, branch: { name: b1.branch, deleted: false, note: `Branch ${b1.branch} has commits that are not merged into ${lead.branch}, so it was kept.` } });
    expect(await run(['rev-parse', `refs/heads/${b1.branch}`], project)).toBe(tip);

    expect(await cleanupWorktree({ projectRoot: project, path: b2.path, branch: b2.branch, mergedInto: [lead.branch] })).toMatchObject({ ok: true, branch: { deleted: true } });
    expect(await cleanupWorktree({ projectRoot: project, path: project })).toMatchObject({ ok: false, error: expect.stringContaining("not one of the project's worktrees") });
    expect(existsSync(path.join(project, 'README.md'))).toBe(true);
  });
});

describe('push and PR', () => {
  it('opens the PR with one push and pr create carrying the report; a follow-up pushes and edits the body; never force-pushes', async () => {
    const { project, origin } = await makeRepo(true);
    const lead = await ensureLeadWorktree(project, 'ship');
    if (!lead.ok) throw new Error(lead.error);
    const tip = await commitFile(lead.path, 'feature.txt', 'v1\n');
    await fs.writeFile(ghLog, '');
    const body = '## Task\n- Ship the widget\n\n## Done\n- It ships\n';

    const opened = await openPr(lead.path, { base: 'develop', head: lead.branch, title: 'Ship the widget', body });
    expect(opened).toMatchObject({ ok: true, url: PR_URL });
    expect(await ghCalls()).toEqual([{ args: ['pr', 'create', '--base', 'develop', '--head', lead.branch, '--title', 'Ship the widget', '--body-file', '-'], stdin: body }]);
    expect(await run(['rev-parse', `refs/heads/${lead.branch}`], origin!)).toBe(tip);

    const tip2 = await commitFile(lead.path, 'feature.txt', 'v2\n', 'follow-up');
    expect(await pushBranch(lead.path, lead.branch)).toMatchObject({ ok: true });
    const body2 = `${body}\n## Notes\n- Follow-up landed\n`;
    expect(await editPrBody(lead.path, PR_URL, body2)).toMatchObject({ ok: true });
    expect((await ghCalls()).slice(1)).toEqual([{ args: ['pr', 'edit', PR_URL, '--body-file', '-'], stdin: body2 }]);
    expect(await run(['rev-parse', `refs/heads/${lead.branch}`], origin!)).toBe(tip2);

    // Someone else moved the remote branch: the push is refused and the remote keeps their commit.
    const clone = path.join(tmp, `clone-${repoCount}`);
    await run(['clone', '-q', '--branch', lead.branch, origin!, clone], tmp);
    await run(['config', 'user.email', 'other@example.com'], clone);
    await run(['config', 'user.name', 'Other'], clone);
    const theirs = await commitFile(clone, 'theirs.txt', 'theirs\n');
    await run(['push', '-q', 'origin', lead.branch], clone);
    await commitFile(lead.path, 'mine.txt', 'mine\n');
    const refused = await pushBranch(lead.path, lead.branch);
    expect(refused).toEqual({ ok: false, error: `origin/${lead.branch} has commits this branch does not, so nothing was pushed (Mission mode never force-pushes).` });
    expect(await run(['rev-parse', `refs/heads/${lead.branch}`], origin!)).toBe(theirs);
    expect((await ghCalls()).length).toBe(2);
  });

  it('reads the PR state, CLOSED included', async () => {
    const { project } = await makeRepo(true);
    process.env.GH_STATE = 'CLOSED';
    try {
      expect(await prState(project, PR_URL)).toEqual({ ok: true, state: 'CLOSED', url: PR_URL });
    } finally {
      delete process.env.GH_STATE;
    }
    expect(await prState(project, PR_URL)).toEqual({ ok: true, state: 'OPEN', url: PR_URL });
    expect(await prState(project, '--web')).toEqual({ ok: false, error: 'Invalid PR reference.' });
  });

  it('reports no remote as not available, without calling gh', async () => {
    const { project } = await makeRepo(false);
    const lead = await ensureLeadWorktree(project, 'local');
    if (!lead.ok) throw new Error(lead.error);
    await fs.writeFile(ghLog, '');
    expect(await pushBranch(lead.path, lead.branch)).toEqual({ ok: false, unavailable: true, error: `There is no origin remote, so nothing was pushed; the work stays on the local branch ${lead.branch}.` });
    expect(await openPr(lead.path, { base: 'develop', head: lead.branch, title: 't', body: 'b' })).toEqual({ ok: false, unavailable: true, error: `There is no origin remote, so no PR was opened; the work stays on the local branch ${lead.branch}.` });
    expect(await ghCalls()).toEqual([]);
  });
});
