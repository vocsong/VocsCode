#!/usr/bin/env node
/** Run the opt-in, offline Knowledge benchmarks and retain their numeric results. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVitestBin } from './vitest-bin.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node scripts/benchmark-knowledge.mjs [--history-only]\nFull run requires npm run build and a staged Graphify runtime. Results are written to a new temp directory.');
  process.exit(0);
}
const historyOnly = args.length === 1 && args[0] === '--history-only';
if (args.length && !historyOnly) {
  console.error('Usage: node scripts/benchmark-knowledge.mjs [--history-only]');
  process.exit(2);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'vocs-knowledge-benchmark-'));
const results = [
  ['tests/knowledge-benchmark-history.integration.test.ts', 'VOCS_CODE_KNOWLEDGE_HISTORY_OUT', 'history.json'],
  ...historyOnly ? [] : [['tests/knowledge-benchmark.integration.test.ts', 'VOCS_CODE_KNOWLEDGE_DESKTOP_OUT', 'desktop.json']]
];
const env = { ...process.env, VOCS_CODE_KNOWLEDGE_BENCH: '1' };
for (const [, key, file] of results) env[key] = path.join(dir, file);
console.log(`Knowledge benchmark reports: ${dir}`);
const child = spawnSync(process.execPath, [resolveVitestBin(import.meta.url), 'run', '--no-file-parallelism', '--no-cache', ...results.map(([test]) => test)], {
  env, cwd: root, stdio: 'inherit', windowsHide: true
});
if (child.error) throw child.error;
if (child.status !== 0) process.exit(child.status ?? 1);
// A passing but skipped/empty suite must not produce a successful run.
for (const [, , file] of results) {
  JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  console.log(path.join(dir, file));
}
