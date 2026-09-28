#!/usr/bin/env node
/** Summarize a Vitest JSON report; the original report remains available as a CI artifact. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [reportPath, label = 'tests', safeOutput] = process.argv.slice(2);
if (!reportPath) {
  console.error('usage: node scripts/test-metrics.mjs <vitest-report.json> [label] [safe-output.json]');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`${label}: report unavailable (${error.message})`);
  process.exit(1);
}

const files = report.testResults ?? [];
const tests = files.flatMap((file) => (file.assertionResults ?? []).map((test) => ({ ...test, file: path.basename(file.name) })));
const counts = Object.fromEntries(['passed', 'failed', 'pending', 'skipped', 'todo'].map((status) => [status, tests.filter((test) => test.status === status).length]));
const slowFiles = files.map((file) => ({ name: path.basename(file.name), ms: Math.max(0, (file.endTime ?? 0) - (file.startTime ?? 0)) }))
  .sort((a, b) => b.ms - a.ms).slice(0, 10);
const slowTests = tests.filter((test) => test.status === 'passed' && typeof test.duration === 'number')
  .sort((a, b) => b.duration - a.duration).slice(0, 10);
const lastEnd = Math.max(...files.map((file) => file.endTime ?? 0));
const observedWallMs = typeof report.startTime === 'number' && lastEnd >= report.startTime ? lastEnd - report.startTime : null;
console.log(`${label}: ${files.length} files; ${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ')}; observed wall ${observedWallMs === null ? 'n/a' : `${Math.round(observedWallMs)}ms`}`);
const skipped = tests.filter((test) => ['pending', 'skipped', 'todo'].includes(test.status));
if (skipped.length) console.log(`Skipped: ${skipped.map((test) => `${test.file} > ${test.title}`).join('; ')}`);
console.log(`Slowest files: ${slowFiles.map((file) => `${file.name} ${Math.round(file.ms)}ms`).join('; ')}`);
console.log(`Slowest tests: ${slowTests.map((test) => `${test.file} > ${test.title} ${Math.round(test.duration)}ms`).join('; ')}`);
if (safeOutput) {
  // The original Vitest JSON can include failure messages and credentials. Retain only timing,
  // status and test names in uploaded CI artifacts; never copy the raw report into artifacts.
  mkdirSync(path.dirname(safeOutput), { recursive: true });
  writeFileSync(safeOutput, JSON.stringify({ label, platform: process.platform, observedWallMs, counts,
    files: files.map((file) => ({ name: path.basename(file.name), durationMs: Math.max(0, (file.endTime ?? 0) - (file.startTime ?? 0)) })),
    tests: tests.map((test) => ({ file: test.file, name: test.title, status: test.status, durationMs: test.duration ?? null }))
  }, null, 2));
}
if (tests.length === 0 || counts.failed || report.success === false) process.exit(1);
