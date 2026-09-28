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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveVitestBin } from './vitest-bin.mjs';
import { validateE2eReport } from './e2e-guard-report.mjs';

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
  [resolveVitestBin(import.meta.url), 'run', '--reporter=default', '--reporter=json', `--outputFile=${report}`, ...files],
  { env, stdio: 'inherit' }
);

let reportText;
try {
  reportText = readFileSync(report, 'utf8');
} catch {
  // Missing reports (including a child that never started) are rejected by the validator.
} finally {
  rmSync(dir, { recursive: true, force: true });
}
// CI retains the same report that was validated; standalone runs keep the temp-only default.
if (process.env.VOCS_CODE_TEST_REPORT && reportText !== undefined) {
  mkdirSync(path.dirname(process.env.VOCS_CODE_TEST_REPORT), { recursive: true });
  writeFileSync(process.env.VOCS_CODE_TEST_REPORT, reportText);
}

const { passed, failed, skipped, problems } = validateE2eReport(reportText, files, run.status);
console.log(`\ne2e guard: ${passed} passed, ${failed} failed, ${skipped} skipped across ${files.length} suite(s).`);

if (problems.length > 0) {
  console.error('\ne2e guard: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nA skipped suite is not verification (AGENTS.md).');
  process.exit(1);
}

console.log('e2e guard: OK — every named suite actually ran.');
