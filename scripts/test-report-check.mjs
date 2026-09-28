#!/usr/bin/env node
/** Fail if any explicitly requested offline integration file did not execute and pass. */
import { readFileSync } from 'node:fs';
import { validateE2eReport } from './e2e-guard-report.mjs';

const [reportPath, ...files] = process.argv.slice(2);
if (!reportPath || files.length === 0) {
  console.error('usage: node scripts/test-report-check.mjs <vitest-report.json> <test file> [...]');
  process.exit(2);
}
let report;
try {
  report = readFileSync(reportPath, 'utf8');
} catch {
  // A missing report is a failed run, not a green skip.
}
const result = validateE2eReport(report, files, 0);
if (result.problems.length) {
  for (const problem of result.problems) console.error(problem);
  process.exit(1);
}
console.log(`${result.passed} tests passed across ${files.length} requested files; no skips.`);
