#!/usr/bin/env node
/** The develop-tier local test run: offline tests reachable from the diff against origin/develop. */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fullRunReason } from './test-changed-scope.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseRef = process.env.VOCS_CODE_TEST_BASE || 'origin/develop';
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

function git(...args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    console.error(run.stderr.trim() || `git ${args.join(' ')} failed`);
    process.exit(run.status ?? 1);
  }
  return run.stdout;
}

const base = git('rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`).trim();
// Match Vitest's branch diff, staged changes and working-tree edits. Comparing directly to the
// base tip would also count upstream-only changes. Include both sides of renames for fallback.
const changed = [...new Set([
  git('diff', '--no-renames', '--name-only', '-z', `${base}...HEAD`, '--'),
  git('diff', '--cached', '--no-renames', '--name-only', '-z', '--'),
  git('ls-files', '--others', '--modified', '--exclude-standard', '-z'),
].join('').split('\0').filter(Boolean))];
const reason = fullRunReason(changed);
const scope = reason ? [] : ['--changed', base, '--passWithNoTests'];
const args = process.argv.slice(2);
const listOnly = args[0] === '--list';
const command = listOnly ? ['list', '--filesOnly'] : ['run'];
if (listOnly) args.shift();
const action = listOnly ? 'listing' : 'running';
const log = listOnly ? console.error : console.log;
log(reason
  ? `${reason} changed on this branch or worktree: ${action} the full offline suite.`
  : `${changed.length} file(s) changed against ${baseRef}: ${action} affected offline test files.`);
const run = spawnSync(process.execPath, [vitest, ...command, ...scope, '--exclude', 'tests/smoke.remote-live.test.ts', ...args], { cwd: root, stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
