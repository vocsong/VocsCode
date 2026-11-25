import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const scripts = path.resolve(import.meta.dirname, '../scripts');

it('uses the branch diff for fallback, but still sees local toolchain edits', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'vocs-test-changed-'));
  const file = (...parts: string[]) => path.join(cwd, ...parts);
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=.git/no-hooks', ...args,
  ], { cwd, stdio: 'pipe' });
  const invoke = (...args: string[]) => spawnSync(process.execPath, [file('scripts/test-changed.mjs'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, VOCS_CODE_TEST_BASE: 'develop' }, timeout: 10_000,
  });
  const selected = (...args: string[]) => {
    const result = invoke(...args);
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
  };

  try {
    git('init', '-b', 'develop');
    writeFileSync(file('package-lock.json'), '{}');
    git('add', 'package-lock.json');
    git('commit', '-m', 'Shared base');
    git('branch', 'feature');
    writeFileSync(file('package-lock.json'), '{"upstream":true}');
    git('commit', '-am', 'Upstream-only lockfile change');
    git('switch', 'feature');
    writeFileSync(file('feature.ts'), 'export const feature = true;');
    git('add', 'feature.ts');
    git('commit', '-m', 'Branch source change');

    mkdirSync(file('scripts'));
    for (const script of ['test-changed.mjs', 'test-changed-scope.mjs', 'vitest-bin.mjs']) {
      copyFileSync(path.join(scripts, script), file('scripts', script));
    }
    // Observe the invocation without loading the real repo's hundreds of tests.
    mkdirSync(file('node_modules/vitest'), { recursive: true });
    writeFileSync(file('node_modules/vitest/package.json'), JSON.stringify({ name: 'vitest', bin: { vitest: 'vitest.mjs' } }));
    writeFileSync(file('node_modules/vitest/vitest.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
    writeFileSync(file('.gitignore'), 'node_modules/\n');

    const affected = ['--changed', git('rev-parse', 'develop').toString().trim(), '--passWithNoTests'];
    const excludeLive = ['--exclude', 'tests/smoke.remote-live.test.ts'];
    expect(selected()).toEqual(['run', ...affected, ...excludeLive]);
    expect(selected('--list', '--json')).toEqual(['list', '--filesOnly', ...affected, ...excludeLive, '--json']);

    writeFileSync(file('package-lock.json'), '{"local":true}');
    git('add', 'package-lock.json');
    // Leave the working tree identical to the index so only the cached diff sees the edit.
    expect(git('ls-files', '--modified', '--', 'package-lock.json').toString()).toBe('');
    expect(selected()).toEqual(['run', ...excludeLive]);
    git('restore', '--source=HEAD', '--staged', '--worktree', '--', 'package-lock.json');

    writeFileSync(file('vitest.config.ts'), 'export default {};'); // Untracked config is also global.
    expect(selected('--list')).toEqual(['list', '--filesOnly', ...excludeLive]);
    rmSync(file('vitest.config.ts'));

    git('mv', 'package-lock.json', 'renamed-lock.json');
    git('commit', '-m', 'Remove the lockfile from its expected path');
    expect(selected()).toEqual(['run', ...excludeLive]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('resolves vitest from a parent node_modules directory when the worktree has none', () => {
  const outer = mkdtempSync(path.join(tmpdir(), 'vocs-test-changed-parent-'));
  const worktree = path.join(outer, 'worktree');
  const file = (...parts: string[]) => path.join(worktree, ...parts);
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=.git/no-hooks', ...args,
  ], { cwd: worktree, stdio: 'pipe' });

  try {
    mkdirSync(path.join(outer, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(
      path.join(outer, 'node_modules', 'vitest', 'package.json'),
      JSON.stringify({ name: 'vitest', bin: { vitest: 'custom-bin.mjs' } })
    );
    writeFileSync(
      path.join(outer, 'node_modules', 'vitest', 'custom-bin.mjs'),
      'console.log(JSON.stringify({ resolved: "parent", args: process.argv.slice(2) }));'
    );

    mkdirSync(file('scripts'), { recursive: true });
    for (const script of ['test-changed.mjs', 'test-changed-scope.mjs', 'vitest-bin.mjs']) {
      copyFileSync(path.join(scripts, script), file('scripts', script));
    }
    git('init', '-b', 'develop');
    writeFileSync(file('src.ts'), 'export const a = 1;');
    git('add', 'src.ts');
    git('commit', '-m', 'Base');

    const run = spawnSync(process.execPath, [file('scripts/test-changed.mjs'), '--list'], {
      cwd: worktree,
      encoding: 'utf8',
      env: { ...process.env, VOCS_CODE_TEST_BASE: 'develop' },
      timeout: 10_000,
    });
    expect(run.status, run.error?.message ?? run.stderr).toBe(0);
    const parsed = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(parsed.resolved).toBe('parent');
    expect(parsed.args[0]).toBe('list');
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});
