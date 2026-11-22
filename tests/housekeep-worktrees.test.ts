import { execFileSync } from 'node:child_process';
import { lstatSync, promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectHousekeepWorktree, removeHousekeepWorktree, type HousekeepWorktree } from '../src/main/housekeep-worktrees';
import * as runtime from '../src/main/runtime';

type Clean = Extract<HousekeepWorktree, { kind: 'clean' }>;
const branch = 'feature/keep-session'; // Custom prefixes need not be vocscode/.
const capture = runtime.runCapture;
let scratch: string, root: string, cwd: string;

function git(dir: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args], {
    cwd: dir, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'empty.config') },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
}

function addWorktree(dir = cwd, name = branch): void {
  git(root, 'worktree', 'add', '-b', name, dir);
}

const inspect = (override: Partial<{ projectRoot: string; cwd: string; branch: string }> = {}) =>
  inspectHousekeepWorktree({ projectRoot: root, cwd, branch, ...override });
const registrations = () => git(root, 'worktree', 'list', '--porcelain', '-z').split('\0');
const record = (dir = cwd) => `worktree ${dir.split(path.sep).join('/')}`;
const allowRemoval = () => {};
const trashPayload = () => path.join(scratch, 'mock-trash');
const trashToScratch = () => vi.fn((dir: string) => fs.rename(dir, trashPayload()));
const mutation = (args: string[]) => {
  const start = args.indexOf('worktree');
  return start < 0 || args[start + 1] === 'list' ? undefined : args.slice(start);
};
const mutations = (calls: Parameters<typeof capture>[]) => calls.flatMap(([, args]) => {
  const cmd = mutation(args);
  return cmd ? [cmd] : [];
});

async function clean(): Promise<Clean> {
  const target = await inspect();
  if (target.kind !== 'clean') throw new Error(`Expected a clean fixture: ${JSON.stringify(target)}`);
  return target;
}

beforeEach(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-housekeep-')));
  root = path.join(scratch, 'repo');
  cwd = path.join(root, '.vocs-code', 'worktrees', 'checkout with spaces');
  await fs.mkdir(path.join(root, 'tracked'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'core.attributesFile', path.join(scratch, 'empty.attributes'));
  await fs.writeFile(path.join(root, 'tracked', 'file.txt'), 'original\n');
  await fs.writeFile(path.join(root, '.gitignore'), '*.ignored\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Housekeep Fixture', '-c', 'user.email=housekeep@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('inspectHousekeepWorktree', () => {
  it('returns none without a branch and missing only for an absent, unregistered managed path', async () => {
    const spy = vi.spyOn(runtime, 'runCapture');
    expect(await inspectHousekeepWorktree({ projectRoot: '', cwd: '' })).toEqual({ kind: 'none' });
    expect(spy).not.toHaveBeenCalled();
    expect(await inspect()).toEqual({ kind: 'missing' });
    addWorktree();
    await fs.rename(cwd, path.join(scratch, 'moved'));
    const before = registrations();
    expect(before).toContain(record());
    expect(await inspect()).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('still registered') });
    expect(registrations()).toEqual(before);
  });

  it('uses the enclosing Git root and exact NUL-delimited path and branch', async () => {
    addWorktree();
    // A different entry containing a line that looks like a porcelain field is still one path.
    const other = process.platform === 'win32' ? 'other tree' : 'other\nbranch refs';
    addWorktree(path.join(path.dirname(cwd), other), 'feature/other');
    expect(await inspect({ projectRoot: path.join(root, 'tracked') })).toEqual({
      kind: 'clean', root, cwd, branch, head: git(cwd, 'rev-parse', 'HEAD').trim(),
    });
  });

  it('rejects registered locations outside or deeper than the managed directory', async () => {
    const prefixSibling = path.join(root, '.vocs-code', 'worktrees-other', 'candidate');
    const tooDeep = path.join(path.dirname(cwd), 'extra', 'candidate');
    addWorktree(prefixSibling);
    addWorktree(tooDeep, 'feature/deep');
    expect(await inspect({ cwd: prefixSibling })).toMatchObject({ kind: 'blocked' });
    expect(await inspect({ cwd: tooDeep, branch: 'feature/deep' })).toMatchObject({ kind: 'blocked' });
    expect(await inspect({ cwd: root, branch: 'main' })).toMatchObject({ kind: 'blocked' });
  });

  it('does not mistake a same-name registration elsewhere for a managed worktree', async () => {
    const other = path.join(scratch, 'elsewhere', path.basename(cwd));
    addWorktree(other);
    expect(await inspect()).toEqual({ kind: 'missing' });
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, 'foreign.txt'), 'keep me');
    expect(await inspect()).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('not a registered worktree') });
    expect(registrations()).toContain(record(other));
  });

  it.each(['.vocs-code', 'worktrees', 'checkout'] as const)('rejects a symlink/junction in %s after an earlier clean check', async (level) => {
    addWorktree();
    const target = await clean();
    const redirected = level === 'checkout' ? cwd : level === 'worktrees' ? path.dirname(cwd) : path.join(root, '.vocs-code');
    const moved = path.join(scratch, 'redirected');
    await fs.rename(redirected, moved);
    await fs.symlink(moved, redirected, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await inspect()).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('symlink or junction') });
    await expect(removeHousekeepWorktree(target, allowRemoval, trashToScratch())).rejects.toThrow(/symlink or junction/);
    expect(await fs.readFile(path.join(cwd, 'tracked', 'file.txt'), 'utf8')).toBe('original\n');
    expect(registrations()).toContain(record());
  });

  it('rejects a dangling checkout link rather than claiming it is missing', async () => {
    await fs.mkdir(path.dirname(cwd), { recursive: true });
    const absent = path.join(scratch, 'absent');
    await fs.mkdir(absent);
    await fs.symlink(absent, cwd, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.rmdir(absent);
    expect(await inspect()).toMatchObject({ kind: 'blocked' });
  });

  it('rejects a locked, detached, or mismatched checkout and a branch which is no longer retained', async () => {
    addWorktree();
    // main and this worktree branch point at the same commit; identity still matters.
    expect(await inspect({ branch: 'main' })).toMatchObject({ kind: 'blocked' });
    git(root, 'worktree', 'lock', '--reason', 'fixture in use', cwd);
    expect(await inspect()).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('locked') });
    git(root, 'worktree', 'unlock', cwd);
    git(cwd, 'switch', '--detach');
    expect(await inspect()).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('detached') });
    git(cwd, 'switch', branch);
    git(root, 'update-ref', '-d', `refs/heads/${branch}`);
    expect(await inspect()).toMatchObject({ kind: 'blocked' });
  });

  it('keeps a clean checkout if a Git operation begins after inspection', async () => {
    addWorktree();
    const target = await clean();
    const admin = git(cwd, 'rev-parse', '--absolute-git-dir').trim();
    await fs.writeFile(path.join(admin, 'MERGE_HEAD'), `${target.head}\n`);
    expect(await inspect()).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('in-progress Git operation') });
    await expect(removeHousekeepWorktree(target, allowRemoval, trashToScratch())).rejects.toThrow('in-progress Git operation');
    expect(registrations()).toContain(record());
  });

  it('rejects a foreign repository replacing a registered checkout even with the same HEAD and branch', async () => {
    addWorktree();
    const target = await clean();
    await fs.rename(cwd, path.join(scratch, 'original'));
    git(scratch, 'clone', '--branch', branch, root, cwd);
    expect(registrations()).toContain(record());
    expect(git(cwd, 'rev-parse', 'HEAD').trim()).toBe(target.head);
    expect(await inspect()).toMatchObject({ kind: 'blocked' });
    await expect(removeHousekeepWorktree(target, allowRemoval, trashToScratch())).rejects.toThrow();
    expect(await fs.readFile(path.join(cwd, 'tracked', 'file.txt'), 'utf8')).toBe('original\n');
  });

  it('verifies the backlink instead of trusting a matching branch and commit in another worktree', async () => {
    addWorktree();
    const other = path.join(scratch, 'other');
    git(root, 'worktree', 'add', '--force', other, branch);
    await fs.copyFile(path.join(other, '.git'), path.join(cwd, '.git'));
    expect(await inspect()).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('backlink') });
  });

  it.each(['modified', 'staged', 'untracked', 'ignored', 'assume-unchanged', 'skip-worktree', 'nested Git data', 'filter'] as const)(
    'rejects %s even when normal status configuration is less strict', async (kind) => {
      addWorktree();
      const tracked = path.join(cwd, 'tracked', 'file.txt');
      git(root, 'config', 'status.showUntrackedFiles', 'no');
      if (kind === 'untracked' || kind === 'ignored') {
        await fs.writeFile(path.join(cwd, kind === 'ignored' ? 'build.ignored' : 'draft.txt'), 'do not remove');
      } else if (kind === 'nested Git data') {
        await fs.mkdir(path.join(cwd, 'tracked', '.git'));
        await fs.writeFile(path.join(cwd, 'tracked', '.git', 'keep'), 'not reported by status');
      } else if (kind === 'filter') {
        await fs.writeFile(path.join(root, '.git', 'info', 'attributes'), 'tracked/file.txt filter=custom\n');
      } else {
        if (kind === 'assume-unchanged' || kind === 'skip-worktree') git(cwd, 'update-index', `--${kind}`, 'tracked/file.txt');
        await fs.writeFile(tracked, 'modified\n');
        if (kind === 'staged') git(cwd, 'add', 'tracked/file.txt');
      }
      expect(await inspect()).toMatchObject({ kind: 'blocked' });
      expect(registrations()).toContain(record());
    },
  );

  it.each([
    { code: null, stdout: '', stderr: '', timedOut: true },
    { code: 0, stdout: '', stderr: '', truncated: true },
    { code: 0, stdout: '', stderr: 'warning: directory could not be read' },
  ])('never treats uncertain Git status as clean: %o', async (result) => {
    addWorktree();
    vi.spyOn(runtime, 'runCapture').mockImplementation((file, args, options) =>
      args.includes('status') ? Promise.resolve(result) : capture(file, args, options));
    expect(await inspect()).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('worktree is clean') });
  });

  it('blocks when an inherited Git environment redirects root discovery', async () => {
    addWorktree();
    vi.stubEnv('GIT_WORK_TREE', cwd);
    vi.stubEnv('GIT_DIR', path.join(root, '.git'));
    expect(await inspect()).toMatchObject({ kind: 'blocked' });
  });
});

describe('removeHousekeepWorktree', () => {
  function commitOnBranch(): void {
    git(cwd, '-c', 'user.name=Housekeep Fixture', '-c', 'user.email=housekeep@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'New HEAD');
  }

  it('awaits guards at move and Trash, unregisters only the absent private path, and retains branches and siblings', async () => {
    addWorktree();
    commitOnBranch();
    git(cwd, 'branch', '--set-upstream-to=main');
    const sibling = path.join(path.dirname(cwd), 'stale');
    addWorktree(sibling, 'feature/stale');
    await fs.rename(sibling, path.join(scratch, 'stale-moved'));
    const target = await clean();
    const order: string[] = [];
    const calls = vi.spyOn(runtime, 'runCapture').mockImplementation((file, args, options) => {
      const cmd = mutation(args);
      if (cmd?.[1] === 'move') order.push('move');
      if (cmd?.[1] === 'remove') {
        order.push('unregister');
        // Non-force Git remove would still discard ignored contents if the checkout existed.
        expect(lstatSync(cmd[3], { throwIfNoEntry: false })).toBeUndefined();
        expect(lstatSync(path.dirname(cmd[3]), { throwIfNoEntry: false })).toBeUndefined();
      }
      return capture(file, args, options);
    });
    const guard = vi.fn(async () => {
      await Promise.resolve();
      const step = guard.mock.calls.length;
      order.push(`guard ${step}`);
      queueMicrotask(() => queueMicrotask(() => order.push(`after ${step}`)));
    });
    const trash = vi.fn(async (dir: string) => {
      order.push('trash');
      expect(path.dirname(path.dirname(dir))).toBe(path.dirname(cwd));
      expect(path.basename(dir)).toBe(path.basename(cwd));
      expect(registrations()).toContain(record(dir));
      expect(registrations()).not.toContain(record());
      await fs.rename(dir, trashPayload());
    });
    await removeHousekeepWorktree(target, guard, trash);
    expect(order).toEqual(['guard 1', 'move', 'after 1', 'guard 2', 'trash', 'after 2', 'unregister']);
    expect(trash).toHaveBeenCalledTimes(1);
    const [[staged]] = trash.mock.calls;
    expect(mutations(calls.mock.calls)).toEqual([
      ['worktree', 'move', '--', cwd, staged], ['worktree', 'remove', '--', staged],
    ]);
    expect(calls.mock.calls.filter(([, args]) => args.includes('status')).map(([, , opts]) => opts?.cwd)).toEqual([cwd, staged]);
    await expect(fs.readFile(path.join(trashPayload(), 'tracked', 'file.txt'), 'utf8')).resolves.toBe('original\n');
    await expect(fs.lstat(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(registrations()).not.toContain(record());
    expect(registrations()).not.toContain(record(staged));
    expect(registrations()).toContain(record(sibling));
    expect(git(root, 'show-ref', '--verify', '--hash', `refs/heads/${branch}`).trim()).toBe(target.head);
    expect(await inspect()).toEqual({ kind: 'missing' });
  });

  it.each(['new ignored data', 'modified data', 'advanced HEAD'] as const)('revalidates against %s before invoking the guard', async (change) => {
    addWorktree();
    const target = await clean();
    if (change === 'new ignored data') await fs.writeFile(path.join(cwd, 'new.ignored'), 'keep me');
    else if (change === 'modified data') await fs.writeFile(path.join(cwd, 'tracked', 'file.txt'), 'changed\n');
    else commitOnBranch();
    const guard = vi.fn();
    const trash = trashToScratch();
    const spy = vi.spyOn(runtime, 'runCapture');
    await expect(removeHousekeepWorktree(target, guard, trash)).rejects.toThrow();
    expect(guard).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    expect(mutations(spy.mock.calls)).toEqual([]);
    expect(registrations()).toContain(record());
    expect(await fs.readdir(path.dirname(cwd))).toEqual([path.basename(cwd)]);
  });

  it('blocks a HEAD change between registration and clean status', async () => {
    addWorktree();
    const target = await clean();
    const guard = vi.fn();
    vi.spyOn(runtime, 'runCapture').mockImplementation((file, args, options) => {
      if (args.includes('status')) commitOnBranch();
      return capture(file, args, options);
    });
    await expect(removeHousekeepWorktree(target, guard, trashToScratch())).rejects.toThrow(/HEAD changed/);
    expect(guard).not.toHaveBeenCalled();
    expect(registrations()).toContain(record());
  });

  it.each([1, 2])('honors an asynchronous refusal at guard %i after the fresh Git checks', async (refuseAt) => {
    addWorktree();
    const target = await clean();
    const spy = vi.spyOn(runtime, 'runCapture');
    const guard = vi.fn(async () => {
      await Promise.resolve();
      expect(spy.mock.calls.filter(([, args]) => args.includes('status'))).toHaveLength(guard.mock.calls.length);
      if (guard.mock.calls.length === refuseAt) throw new Error('terminal opened');
    });
    const trash = trashToScratch();
    await expect(removeHousekeepWorktree(target, guard, trash)).rejects.toThrow('terminal opened');
    expect(guard).toHaveBeenCalledTimes(refuseAt);
    expect(trash).not.toHaveBeenCalled();
    const commands = mutations(spy.mock.calls);
    if (refuseAt === 1) expect(commands).toEqual([]);
    else {
      const staged = commands[0][4];
      expect(commands).toEqual([['worktree', 'move', '--', cwd, staged], ['worktree', 'move', '--', staged, cwd]]);
    }
    expect(registrations()).toContain(record());
    expect(await fs.readdir(path.dirname(cwd))).toEqual([path.basename(cwd)]);
  });

  it.each(['late.txt', 'late.ignored'])('restores the worktree with %s created just before the move', async (name) => {
    addWorktree();
    git(root, 'config', 'status.showUntrackedFiles', 'no');
    const target = await clean();
    const trash = trashToScratch();
    const guard = vi.fn(() => writeFileSync(path.join(cwd, name), 'unsaved work'));
    const spy = vi.spyOn(runtime, 'runCapture');
    await expect(removeHousekeepWorktree(target, guard, trash)).rejects.toThrow(/modified, untracked, or ignored/);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(trash).not.toHaveBeenCalled();
    const commands = mutations(spy.mock.calls);
    const staged = commands[0][4];
    expect(commands).toEqual([['worktree', 'move', '--', cwd, staged], ['worktree', 'move', '--', staged, cwd]]);
    await expect(fs.readFile(path.join(cwd, name), 'utf8')).resolves.toBe('unsaved work');
    expect(registrations()).toContain(record());
    expect(registrations()).not.toContain(record(staged));
  });

  it('preserves an ignored file written after the staged inventory in the Trash payload', async () => {
    addWorktree();
    const target = await clean();
    const trash = vi.fn(async (dir: string) => {
      await fs.writeFile(path.join(dir, 'late.ignored'), 'keep me');
      await fs.rename(dir, trashPayload());
    });
    await removeHousekeepWorktree(target, allowRemoval, trash);
    await expect(fs.readFile(path.join(trashPayload(), 'late.ignored'), 'utf8')).resolves.toBe('keep me');
    expect(await inspect()).toEqual({ kind: 'missing' });
  });

  it('restores the exact checkout without force when Trash refuses', async () => {
    addWorktree();
    const target = await clean();
    const calls = vi.spyOn(runtime, 'runCapture');
    const trash = vi.fn(async (dir: string) => {
      await fs.writeFile(path.join(dir, 'late.ignored'), 'keep me');
      throw new Error('Trash refused');
    });
    await expect(removeHousekeepWorktree(target, allowRemoval, trash)).rejects.toThrow('Trash refused');
    const [[staged]] = trash.mock.calls;
    expect(mutations(calls.mock.calls)).toEqual([
      ['worktree', 'move', '--', cwd, staged], ['worktree', 'move', '--', staged, cwd],
    ]);
    await expect(fs.readFile(path.join(cwd, 'late.ignored'), 'utf8')).resolves.toBe('keep me');
    expect(registrations()).toContain(record());
    expect(registrations()).not.toContain(record(staged));
    await expect(fs.lstat(path.dirname(staged))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports the staged recovery path instead of overwriting an occupied original path', async () => {
    addWorktree();
    const target = await clean();
    const calls = vi.spyOn(runtime, 'runCapture');
    const trash = vi.fn(async (_dir: string) => {
      await fs.mkdir(cwd);
      await fs.writeFile(path.join(cwd, 'new.txt'), 'replacement');
      throw new Error('Trash refused');
    });
    await expect(removeHousekeepWorktree(target, allowRemoval, trash)).rejects.toThrow(/recovery is incomplete/);
    const [[staged]] = trash.mock.calls;
    expect(mutations(calls.mock.calls)).toEqual([['worktree', 'move', '--', cwd, staged]]);
    await expect(fs.readFile(path.join(cwd, 'new.txt'), 'utf8')).resolves.toBe('replacement');
    await expect(fs.readFile(path.join(staged, 'tracked', 'file.txt'), 'utf8')).resolves.toBe('original\n');
    expect(registrations()).toContain(record(staged));
  });

  it.each(['rejected', 'resolved'] as const)('never restores or unregisters a staged replacement when Trash %s after moving the payload', async (result) => {
    addWorktree();
    const target = await clean();
    const calls = vi.spyOn(runtime, 'runCapture');
    const trash = vi.fn(async (dir: string) => {
      await fs.rename(dir, trashPayload());
      await fs.mkdir(dir);
      // The replacement even has the right .git link, but is not the owned directory.
      await fs.copyFile(path.join(trashPayload(), '.git'), path.join(dir, '.git'));
      await fs.writeFile(path.join(dir, 'replacement.ignored'), 'keep replacement');
      if (result === 'rejected') throw new Error('Trash reported an error');
    });
    await expect(removeHousekeepWorktree(target, allowRemoval, trash)).rejects.toThrow(/incomplete.*system Trash/);
    const [[staged]] = trash.mock.calls;
    expect(mutations(calls.mock.calls)).toEqual([['worktree', 'move', '--', cwd, staged]]);
    await expect(fs.readFile(path.join(trashPayload(), 'tracked', 'file.txt'), 'utf8')).resolves.toBe('original\n');
    await expect(fs.readFile(path.join(staged, 'replacement.ignored'), 'utf8')).resolves.toBe('keep replacement');
    await expect(fs.lstat(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(registrations()).toContain(record(staged));
  });

  it.each(['untouched', 'fully moved', 'moved but not registered'] as const)('handles a failed Git move with the original %s', async (state) => {
    addWorktree();
    const target = await clean();
    const trash = trashToScratch();
    const calls = vi.spyOn(runtime, 'runCapture').mockImplementation(async (file, args, options) => {
      const cmd = mutation(args);
      if (cmd?.[1] !== 'move' || cmd[3] !== cwd) return capture(file, args, options);
      if (state === 'fully moved') expect((await capture(file, args, options)).code).toBe(0);
      else if (state === 'moved but not registered') await fs.rename(cwd, cmd[4]);
      return { code: 1, stdout: '', stderr: 'move failed' };
    });
    await expect(removeHousekeepWorktree(target, allowRemoval, trash)).rejects.toThrow(state === 'moved but not registered'
      ? /recovery is incomplete/ : /native Git worktree move/);
    expect(trash).not.toHaveBeenCalled();
    const commands = mutations(calls.mock.calls);
    const staged = commands[0][4];
    expect(commands).toEqual(state === 'fully moved'
      ? [['worktree', 'move', '--', cwd, staged], ['worktree', 'move', '--', staged, cwd]]
      : [['worktree', 'move', '--', cwd, staged]]);
    const at = state === 'moved but not registered' ? staged : cwd;
    await expect(fs.readFile(path.join(at, 'tracked', 'file.txt'), 'utf8')).resolves.toBe('original\n');
    expect(registrations()).toContain(record());
    expect(registrations()).not.toContain(record(staged));
  });

  it.each(['original directory', 'staged directory', 'staged registration', 'changed branch tip'] as const)(
    'does not claim success with a %s after Git unregistration', async (remaining) => {
      addWorktree();
      commitOnBranch();
      const target = await clean();
      const calls = vi.spyOn(runtime, 'runCapture').mockImplementation(async (file, args, options) => {
        const cmd = mutation(args);
        if (cmd?.[1] !== 'remove') return capture(file, args, options);
        if (remaining === 'staged registration') return { code: 0, stdout: '', stderr: '' };
        const result = await capture(file, args, options);
        expect(result.code).toBe(0);
        if (remaining === 'changed branch tip') git(root, 'update-ref', `refs/heads/${branch}`, 'HEAD');
        else {
          const dir = remaining === 'original directory' ? cwd : cmd[3];
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, 'replacement.txt'), 'keep me');
        }
        return result;
      });
      const trash = trashToScratch();
      await expect(removeHousekeepWorktree(target, allowRemoval, trash)).rejects.toThrow(/removal is incomplete/);
      const [[staged]] = trash.mock.calls;
      expect(mutations(calls.mock.calls)).toEqual([['worktree', 'move', '--', cwd, staged], ['worktree', 'remove', '--', staged]]);
      await expect(fs.readFile(path.join(trashPayload(), 'tracked', 'file.txt'), 'utf8')).resolves.toBe('original\n');
      if (remaining === 'staged registration') expect(registrations()).toContain(record(staged));
      else expect(registrations()).not.toContain(record(staged));
      if (remaining === 'original directory' || remaining === 'staged directory') {
        const dir = remaining === 'original directory' ? cwd : staged;
        await expect(fs.readFile(path.join(dir, 'replacement.txt'), 'utf8')).resolves.toBe('keep me');
      }
    },
  );
});
