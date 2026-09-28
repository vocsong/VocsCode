#!/usr/bin/env node
/** The develop-tier local test run: offline tests reachable from the diff against origin/develop. */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fullRunReason } from './test-changed-scope.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.VOCS_CODE_TEST_BASE || 'origin/develop';
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

function git(...args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    console.error(run.stderr.trim() || `git ${args.join(' ')} failed`);
    process.exit(run.status ?? 1);
  }
  return run.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

// The same set vitest --changed sees: the working tree against the base, plus untracked files.
const changed = [...git('diff', '--name-only', base), ...git('ls-files', '--others', '--exclude-standard')];
const reason = fullRunReason(changed);
const scope = reason ? [] : ['--changed', base, '--passWithNoTests'];
console.log(reason
  ? `${reason} changed since ${base}: running the full offline suite.`
  : `${changed.length} file(s) changed since ${base}: running the offline tests that import them.`);
const run = spawnSync(process.execPath, [vitest, 'run', ...scope, '--exclude', 'tests/smoke.remote-live.test.ts', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
