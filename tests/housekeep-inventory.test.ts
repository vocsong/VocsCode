import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanHousekeepInventory } from '../src/main/housekeep-inventory';
import * as runtime from '../src/main/runtime';
import type { SessionMeta } from '../src/shared/types';

let scratch: string;
let root: string;
const run = runtime.runCapture;
const managed = (...parts: string[]) => path.join(root, '.vocs-code', 'worktrees', ...parts);
const session = (title: string, cwd: string, branch?: string, archived = false, projectRoot = root) => ({
  title, cwd, archived, worktreeBranch: branch, config: { projectRoot } as SessionMeta['config']
});

function git(...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'empty.config') }
  });
}

beforeEach(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-housekeep-inventory-')));
  root = path.join(scratch, 'project with spaces');
  await fs.mkdir(root);
  git('init', '-b', 'main');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Initial commit');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('read-only Housekeep inventory', () => {
  it('reports an archived remnant and retained branch that Git Worktrees cannot see, plus legacy folders and unlinked app branches', async () => {
    const remnant = managed('archive remainder');
    const legacy = path.join(root, '.vocs-desk', 'worktrees', 'legacy');
    const claude = path.join(root, '.claude', 'worktrees', '\u03bb old checkout');
    const codex = path.join(root, '.codex', 'worktrees', 'legacy');
    const nested = path.join(remnant, 'nested');
    await Promise.all([nested, legacy, claude, codex].map(location => fs.mkdir(location, { recursive: true })));
    const bytes = path.join(nested, 'draft.ignored');
    await fs.writeFile(bytes, 'Keep these bytes.');
    git('branch', 'feature/archived');
    git('branch', 'vocscode/unlinked');
    git('branch', 'harness/legacy');
    git('branch', 'fix/unrelated');
    // The archived session is the only app record for the entire project.
    const before = git('show-ref');
    const registrations = git('worktree', 'list', '--porcelain', '-z');
    const scan = vi.spyOn(runtime, 'runCapture');
    const report = await scanHousekeepInventory([], [session('Archived task', remnant, 'feature/archived', true)]);
    expect(report).toMatchObject({ repositories: 1, warnings: [], limited: false });
    expect(report.rows).toEqual(expect.arrayContaining([
      { projectRoot: root, kind: 'unregistered-folder', location: remnant, sessions: [{ title: 'Archived task', archived: true }] },
      { projectRoot: root, kind: 'retained-branch', location: 'feature/archived', sessions: [{ title: 'Archived task', archived: true }] },
      { projectRoot: root, kind: 'unlinked-branch', location: 'vocscode/unlinked', sessions: [] },
      { projectRoot: root, kind: 'unlinked-branch', location: 'harness/legacy', sessions: [] },
      { projectRoot: root, kind: 'unregistered-folder', location: legacy, sessions: [] },
      { projectRoot: root, kind: 'unregistered-folder', location: claude, sessions: [] },
      { projectRoot: root, kind: 'unregistered-folder', location: codex, sessions: [] }
    ]));
    expect(report.rows).toHaveLength(7);
    expect(scan.mock.calls.map(([, args]) => args[0])).toEqual(['rev-parse', 'worktree', 'for-each-ref']);
    expect(scan.mock.calls[1][1]).toEqual(['worktree', 'list', '--porcelain', '-z']);
    expect(git('show-ref')).toBe(before);
    expect(git('worktree', 'list', '--porcelain', '-z')).toBe(registrations);
    await expect(fs.readFile(bytes, 'utf8')).resolves.toBe('Keep these bytes.');
  });

  it('distinguishes stale, archived, live aliases and unlinked registered paths across the same repository', async () => {
    const stale = managed('stale');
    const live = managed('live');
    const archived = path.join(scratch, 'archived worktree');
    const independent = path.join(scratch, 'independent worktree');
    const outside = path.join(scratch, 'outside unregistered');
    const linkedRoot = path.join(scratch, 'registered-project-alias');
    const liveAlias = path.join(scratch, 'live-alias');
    await fs.mkdir(managed(), { recursive: true });
    for (const [branch, checkout] of [['vocscode/stale', stale], ['vocscode/live', live], ['custom/archived', archived], ['review/external', independent]]) {
      git('worktree', 'add', '-b', branch, checkout);
    }
    const linkedRemnant = path.join(independent, '.vocs-desk', 'worktrees', 'nested legacy remainder');
    await fs.mkdir(linkedRemnant, { recursive: true });
    await fs.mkdir(path.join(live, 'subdir'));
    await fs.mkdir(outside);
    await fs.symlink(independent, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(live, liveAlias, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.rename(stale, path.join(scratch, 'moved-away'));
    const report = await scanHousekeepInventory([root, linkedRoot], [
      session('Open through alias', path.join(liveAlias, 'subdir')),
      session('Archived checkout', archived, 'custom/archived', true, linkedRoot)
    ]);
    expect(report).toMatchObject({ repositories: 1, warnings: [], limited: false });
    expect(report.rows.map(({ location, kind }) => [location, kind])).toEqual([
      [archived, 'archived-worktree'], [stale, 'stale-registration'], [independent, 'unlinked-worktree'], [linkedRemnant, 'unregistered-folder']
    ]);
    expect(report.rows[0].sessions).toEqual([{ title: 'Archived checkout', archived: true }]);
    expect(git('worktree', 'list', '--porcelain')).toContain('prunable');
    await expect(fs.stat(path.join(scratch, 'moved-away'))).resolves.toBeDefined();
  });

  it('does not descend through a linked worktree container or report its target as stranded', async () => {
    const elsewhere = path.join(scratch, 'foreign');
    const alias = path.join(root, '.claude');
    await fs.mkdir(path.join(elsewhere, 'worktrees', 'never-visit'), { recursive: true });
    await fs.symlink(elsewhere, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedChild = managed('directory alias');
    await fs.mkdir(managed(), { recursive: true });
    await fs.symlink(elsewhere, linkedChild, process.platform === 'win32' ? 'junction' : 'dir');
    const report = await scanHousekeepInventory([root], []);
    expect(report.warnings).toEqual([expect.stringContaining(path.join(alias, 'worktrees'))]);
    expect(report.rows).toEqual([{ projectRoot: root, kind: 'unverified-path', location: linkedChild, sessions: [] }]);
  });

  it('stops scheduling Git reads at the scan deadline and marks the result incomplete', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const scan = vi.spyOn(runtime, 'runCapture').mockImplementation(async (...args) => {
      const result = await run(...args);
      clock.mockReturnValue(31_001);
      return result;
    });
    await expect(scanHousekeepInventory([root], [])).resolves.toEqual({ repositories: 0, rows: [], warnings: [], limited: true });
    expect(scan.mock.calls.map(([, args]) => args[0])).toEqual(['rev-parse']);
  });

  it.each([{ truncated: true }, { timedOut: true }, { code: 1 }])('reports incomplete Git registration reads instead of inventing orphan rows: %j', async incomplete => {
    await fs.mkdir(managed('registered-elsewhere'), { recursive: true });
    vi.spyOn(runtime, 'runCapture').mockImplementation((cmd, args, options) => args[0] === 'worktree'
      ? Promise.resolve({ code: 0, stdout: '', stderr: '', ...incomplete })
      : run(cmd, args, options));
    const report = await scanHousekeepInventory([root], []);
    expect(report.rows).toEqual([]);
    expect(report.repositories).toBe(0);
    expect(report.warnings).toEqual([expect.stringContaining('Could not read Git worktrees')]);
  });
});
