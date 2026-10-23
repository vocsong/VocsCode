/**
 * `.worktreeinclude`: a worktree is a fresh checkout, so the gitignored files a project needs to
 * run (`.env`, local config) were missing from every worktree the app created, and a dev server
 * started there failed or ran without its config. The project root's `.worktreeinclude` names
 * them in .gitignore syntax, and every path that creates a worktree (new session, existing
 * branch, fork, unarchive) copies the gitignored matches over — never tracked files, never over a
 * file the checkout already has, never through a symlink the branch committed, and never out of a
 * directory ignored as a whole (`node_modules/`) that a bare-name pattern does not reach.
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorktree, removeWorktree, restoreWorktree, worktreeAddForBranch } from '../src/main/git';
import { isIncluded, parseWorktreeInclude } from '../src/main/worktree-include';

let tmpRoot = '';
let counter = 0;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-wtinclude-'));
});
afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

async function write(root: string, rel: string, body = rel): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), body);
}

const read = (root: string, rel: string): Promise<string | null> => fs.readFile(path.join(root, rel), 'utf8').catch(() => null);

/** A repository with one commit holding `tracked` (path → body), plus the untracked `files`. */
async function repo(tracked: Record<string, string>, files: string[]): Promise<string> {
  const dir = path.join(tmpRoot, `repo${++counter}`);
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '--initial-branch=main', '.');
  for (const [rel, body] of Object.entries(tracked)) await write(dir, rel, body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  for (const rel of files) await write(dir, rel, `main:${rel}`);
  return dir;
}

describe('.worktreeinclude patterns', () => {
  const match = (text: string, rel: string, isDir = false) => isIncluded(parseWorktreeInclude(text), rel, isDir);

  it('follows .gitignore rules', () => {
    expect(match('.env', '.env')).toBe(true);
    expect(match('.env', 'apps/web/.env')).toBe(true);
    expect(match('/.env', 'apps/web/.env')).toBe(false);
    expect(match('.env*', '.env.local')).toBe(true);
    expect(match('config/secrets.json', 'config/secrets.json')).toBe(true);
    expect(match('config/secrets.json', 'x/config/secrets.json')).toBe(false);
    expect(match('*.json', 'a/b.json')).toBe(true);
    expect(match('config/*.json', 'config/a/b.json')).toBe(false);
    expect(match('config/**/*.json', 'config/a/b/c.json')).toBe(true);
    expect(match('config/**/*.json', 'config/c.json')).toBe(true);
    expect(match('local/', 'local', false)).toBe(false);
    expect(match('local/', 'local/key.pem')).toBe(true);
    expect(match('cert-[ab].pem', 'cert-a.pem')).toBe(true);
    expect(match('cert-[!ab].pem', 'cert-a.pem')).toBe(false);
    expect(match('cert-?.pem', 'cert-c.pem')).toBe(true);
    expect(match('# .env\n\n', '.env')).toBe(false);
    expect(match('\\#notes', '#notes')).toBe(true);
    expect(match('.env*\n!.env.example', '.env.example')).toBe(false);
    expect(match('.env*\n!.env.example', '.env.production')).toBe(true);
    // As in .gitignore, a matched directory takes everything in it.
    expect(match('local/\n!local/keep', 'local/keep')).toBe(true);
  });
});

describe('copying gitignored files into a new worktree', () => {
  it('copies only gitignored matches, and never out of node_modules for a bare-name pattern', async () => {
    const root = await repo(
      {
        '.gitignore': 'node_modules/\n.env*\n!.env.example\nconf/local/\nvendor/\n*.log\n',
        '.worktreeinclude': '.env*\nconfig.json\nvendor/**/config.json\nconf/local/\nnotes.txt\n',
        '.env.example': 'tracked example',
        'packages/api/index.ts': 'tracked source'
      },
      [
        '.env',
        '.env.local',
        'packages/api/.env',
        'packages/api/node_modules/pkg/.env',
        // An untracked folder whose every file is ignored is listed by git as one entry.
        'scratch/web/.env',
        'scratch/web/node_modules/pkg/.env',
        'config.json',
        'notes.txt',
        'conf/local/key.json',
        'conf/local/deep/cert.pem',
        'node_modules/pkg/config.json',
        'node_modules/pkg/.env',
        'vendor/sdk/config.json',
        'vendor/sdk/other.json',
        'debug.log'
      ]
    );
    const wt = await createWorktree(root, 'feature');

    for (const rel of ['.env', '.env.local', 'packages/api/.env', 'scratch/web/.env', 'conf/local/key.json', 'conf/local/deep/cert.pem', 'vendor/sdk/config.json']) {
      expect(await read(wt.path, rel), rel).toBe(`main:${rel}`);
    }
    // config.json and notes.txt are untracked but not gitignored, so a pattern naming them is not enough;
    // a bare name never reaches into an ignored-as-a-whole node_modules/ or vendor/.
    const skipped = ['notes.txt', 'config.json', 'debug.log', 'node_modules/pkg/config.json', 'node_modules/pkg/.env', 'packages/api/node_modules/pkg/.env', 'scratch/web/node_modules/pkg/.env', 'vendor/sdk/other.json'];
    for (const rel of skipped) {
      expect(await read(wt.path, rel), rel).toBeNull();
    }
    expect(await read(wt.path, '.env.example')).toBe('tracked example');
    // The app's own folder (other worktrees, the wiki) never comes along.
    await expect(fs.stat(path.join(wt.path, '.vocs-code'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let a force-tracked file bypass the ignored-directory boundary', async () => {
    const root = await repo({ '.gitignore': 'node_modules/\n', '.worktreeinclude': '.env\n' }, ['node_modules/README', 'node_modules/.env']);
    git(root, 'add', '-f', 'node_modules/README');
    git(root, 'commit', '-m', 'track vendor readme');
    const bare = await createWorktree(root, 'bare');
    expect(await read(bare.path, 'node_modules/.env')).toBeNull();
    await write(root, '.worktreeinclude', 'node_modules/.env\n');
    const explicit = await createWorktree(root, 'explicit');
    expect(await read(explicit.path, 'node_modules/.env')).toBe('main:node_modules/.env');
  });

  it('honors exclusions and never copies the app folder, even when explicitly included', async () => {
    const root = await repo(
      { '.gitignore': '.env*\n', '.worktreeinclude': '.env*\n!.env.production\n.vocs-code/\n' },
      ['.env', '.env.production', '.vocs-code/wiki/private.md']
    );
    const wt = await createWorktree(root, 'excluded');
    expect(await read(wt.path, '.env')).toBe('main:.env');
    expect(await read(wt.path, '.env.production')).toBeNull();
    await expect(fs.lstat(path.join(wt.path, '.vocs-code'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('continues copying other files when a destination parent is a file', async () => {
    const root = await repo({ '.gitignore': 'config/\n.env\n', '.worktreeinclude': 'config/\n.env\n' }, []);
    git(root, 'checkout', '-b', 'file-parent');
    await write(root, 'config', 'branch file');
    git(root, 'add', 'config');
    git(root, 'commit', '-m', 'track file parent');
    git(root, 'checkout', 'main');
    await write(root, 'config/secret', 'do not overwrite branch file');
    await write(root, '.env', 'still copied');
    const wt = await createWorktree(root, 'partial', { startPoint: 'file-parent' });
    expect(await read(wt.path, 'config')).toBe('branch file');
    expect(await read(wt.path, '.env')).toBe('still copied');
  });

  it('copies nothing without a .worktreeinclude', async () => {
    const root = await repo({ '.gitignore': '.env\n' }, ['.env']);
    const wt = await createWorktree(root, 'plain');
    expect(await read(wt.path, '.env')).toBeNull();
  });

  it('keeps a file the checked-out branch already has', async () => {
    const root = await repo({ '.gitignore': '.env\n', '.worktreeinclude': '.env\n' }, []);
    git(root, 'checkout', '-b', 'tracks-env');
    await write(root, '.env', 'from the branch');
    git(root, 'add', '-f', '.env');
    git(root, 'commit', '-m', 'track .env');
    git(root, 'checkout', 'main');
    await write(root, '.env', 'from main');
    const wt = await createWorktree(root, 'tracked', { startPoint: 'tracks-env' });
    expect(await read(wt.path, '.env')).toBe('from the branch');
    expect(await read(root, '.env')).toBe('from main');
  });

  it.skipIf(process.platform === 'win32').each(['conf', 'conf\\local'])('never writes through a committed symlink named %s', async (dir) => {
    const outside = path.join(tmpRoot, `outside${++counter}`);
    await fs.mkdir(outside, { recursive: true });
    const pattern = dir.replace(/\\/g, '\\\\');
    const secret = `${dir}/key.json`;
    const root = await repo({ '.gitignore': `${pattern}/\n`, '.worktreeinclude': `${pattern}/\n` }, [secret]);
    git(root, 'checkout', '-b', 'evil');
    await fs.rm(path.join(root, dir), { recursive: true });
    await fs.symlink(outside, path.join(root, dir));
    git(root, 'add', dir);
    git(root, 'commit', '-m', 'conf is a link');
    git(root, 'checkout', 'main');
    await write(root, secret, 'secret');
    const wt = await createWorktree(root, 'evil-base', { startPoint: 'evil' });
    expect(await fs.readdir(outside)).toEqual([]);
    expect((await fs.lstat(path.join(wt.path, dir))).isSymbolicLink()).toBe(true);
  });

  it('copies on every creation path: an existing branch and an unarchived worktree', async () => {
    const root = await repo({ '.gitignore': '.env\n', '.worktreeinclude': '.env\n' }, ['.env']);
    git(root, 'branch', 'existing');
    const onBranch = await worktreeAddForBranch(root, 'existing');
    expect(await read(onBranch.path, '.env')).toBe('main:.env');

    const wt = await createWorktree(root, 'cycle');
    await removeWorktree(root, wt.path, { force: true });
    await write(root, '.env', 'rotated');
    await restoreWorktree(root, wt.path, wt.branch);
    expect(await read(wt.path, '.env')).toBe('rotated');
  });
});
