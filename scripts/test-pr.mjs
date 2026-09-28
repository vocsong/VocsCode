#!/usr/bin/env node
/** Run the reviewed fast PR suite and require each listed file to execute without skips. */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = JSON.parse(readFileSync(path.join(root, 'scripts/pr-test-files.json'), 'utf8'));
const report = process.env.VOCS_CODE_TEST_REPORT ?? path.join(os.tmpdir(), `vocs-pr-tests-${process.pid}.json`);
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const run = spawnSync(process.execPath, [vitest, 'run', ...files, '--reporter=default', '--reporter=json', `--outputFile=${report}`], { cwd: root, stdio: 'inherit' });
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status ?? 1);
const checked = spawnSync(process.execPath, [path.join(root, 'scripts', 'test-report-check.mjs'), report, ...files], { cwd: root, stdio: 'inherit' });
if (checked.error) throw checked.error;
process.exit(checked.status ?? 1);
