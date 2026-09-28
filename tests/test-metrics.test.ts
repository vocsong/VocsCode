import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../scripts/test-metrics.mjs');

describe('CI test metrics', () => {
  it('summarizes executed tests and their durations without treating a missing report as success', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vocs-test-metrics-'));
    try {
      const report = path.join(dir, 'report.json');
      expect(spawnSync(process.execPath, [script, report]).status).toBe(1);
      writeFileSync(report, JSON.stringify({ success: true, testResults: [] }));
      expect(spawnSync(process.execPath, [script, report]).status).toBe(1);
      writeFileSync(report, JSON.stringify({ success: true, testResults: [{ name: 'tests/a.test.ts', startTime: 1, endTime: 101, assertionResults: [{ status: 'passed', title: 'works', duration: 90, failureMessages: ['SECRET_DO_NOT_UPLOAD'] }] }] }));
      const safe = path.join(dir, 'safe.json');
      const result = spawnSync(process.execPath, [script, report, 'sample', safe], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('1 passed');
      expect(result.stdout).toContain('a.test.ts 100ms');
      expect(result.stdout).toContain('works 90ms');
      expect(readFileSync(safe, 'utf8')).not.toContain('SECRET_DO_NOT_UPLOAD');
      expect(JSON.parse(readFileSync(safe, 'utf8')).tests).toEqual([{ file: 'a.test.ts', name: 'works', status: 'passed', durationMs: 90 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
