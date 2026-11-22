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
    for (const script of ['test-changed.mjs', 'test-changed-scope.mjs']) {
      copyFileSync(path.join(scripts, script), file('scripts', script));
    }
    // Observe the invocation without loading the real repo's hundreds of tests.
    mkdirSync(file('node_modules/vitest'), { recursive: true });
    writeFileSync(file('node_modules/vitest/vitest.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
    writeFileSync(file('.gitignore'), 'node_modules/\n');

    const affected = ['--changed', git('rev-parse', 'develop').toString().trim(), '--passWithNoTests'];
    const excludeLive = ['--exclude', 'tests/smoke.remote-live.test.ts'];
    expect(selected()).toEqual(['run', ...affected, ...excludeLive]);
    expect(selected('--list', '--json')).toEqual(['list', '--filesOnly', ...affected, ...excludeLive, '--json']);

    writeFileSync(file('package-lock.json'), '{"local":true}');
    git('add', 'package-lock.json');
    writeFileSync(file('package-lock.json'), '{}'); // Staged, even if the working copy reverted it.
    expect(selected()).toEqual(['run', ...excludeLive]);
    git('reset', '--', 'package-lock.json');

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
