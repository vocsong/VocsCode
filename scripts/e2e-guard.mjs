/**
 * Runs the given e2e suites and fails if any of them was skipped.
 *
 * Every e2e suite self-skips unless its env var is set, so a plain `vitest run` reports them green
 * without having executed anything — AGENTS.md calls that out as "not verification". This wrapper
 * sets the gates, then reads vitest's JSON report and treats a skipped or uncollected test as a
 * failure, so an automated check cannot pass while the E2E layer is dark.
 *
 * Usage: node scripts/e2e-guard.mjs tests/e2e.vision.test.ts [...]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/e2e-guard.mjs <test file> [...]');
  process.exit(2);
}

const dir = mkdtempSync(path.join(tmpdir(), 'vocs-e2e-guard-'));
const report = path.join(dir, 'report.json');

// The gates the suites check. Only the files named on the command line are collected, so this
// cannot pull in a suite that needs provider credit.
const env = { ...process.env, VOCS_CODE_E2E_UI: '1', HARNESS_E2E: '1' };

const run = spawnSync(
  process.execPath,
  // Resolved through Node so a git worktree that borrows the parent checkout's node_modules works too.
  [createRequire(import.meta.url).resolve('vitest/vitest.mjs'), 'run', '--reporter=default', '--reporter=json', `--outputFile=${report}`, ...files],
  { env, stdio: 'inherit' }
);

let parsed;
try {
  parsed = JSON.parse(readFileSync(report, 'utf8'));
} catch (e) {
  console.error(`\ne2e guard: no JSON report at ${report} (${e.message}); treating the run as failed.`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });

const tests = (parsed.testResults ?? []).flatMap((f) => (f.assertionResults ?? []).map((t) => ({ ...t, file: f.name })));
const skipped = tests.filter((t) => t.status === 'pending' || t.status === 'skipped' || t.status === 'todo');
const failed = tests.filter((t) => t.status === 'failed');
const ran = tests.filter((t) => t.status === 'passed');

console.log(`\ne2e guard: ${ran.length} passed, ${failed.length} failed, ${skipped.length} skipped across ${files.length} suite(s).`);

const problems = [];
if (run.status !== 0 || failed.length > 0) problems.push(`${failed.length} test(s) failed`);
for (const t of skipped) problems.push(`skipped: ${t.file} > ${t.fullName ?? t.title}`);
// A suite that collected nothing is just as dark as one that skipped.
for (const file of files) {
  const abs = path.resolve(file);
  if (!tests.some((t) => path.resolve(t.file) === abs)) problems.push(`no tests collected: ${file}`);
}

if (problems.length > 0) {
  console.error('\ne2e guard: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nA skipped suite is not verification (AGENTS.md).');
  process.exit(1);
}

console.log('e2e guard: OK — every named suite actually ran.');
