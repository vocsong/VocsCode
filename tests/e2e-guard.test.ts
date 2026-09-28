/** Guard the CLI resolution and reject JSON reports that don't prove every named suite passed. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateE2eReport } from '../scripts/e2e-guard-report.mjs';

const root = path.resolve(import.meta.dirname, '..');
const first = 'tests/e2e.first.test.ts';
const second = 'tests/e2e.second.test.ts';

function report(...files: { name: string; statuses: string[] }[]): string {
  return JSON.stringify({ testResults: files.map(({ name, statuses }) => ({
    name: path.resolve(root, name),
    assertionResults: statuses.map((status, i) => ({ status, fullName: `test ${i}` }))
  })) });
}

/** Loaded in a child process so the guard's own module boundary is exercised, not a copy of it. */
function resolveGuardVitestBin(): string {
  const helper = pathToFileURL(path.join(root, 'scripts', 'vitest-bin.mjs')).href;
  const script = `import { resolveVitestBin } from ${JSON.stringify(helper)}; process.stdout.write(resolveVitestBin());`;
  return execFileSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' }).trim();
}

describe('e2e guard', () => {
  it('resolves a vitest CLI entry point that Node can run', () => {
    const bin = resolveGuardVitestBin();

    expect(existsSync(bin)).toBe(true);
    // Spawning it is the real check: a path that exists but is not vitest's CLI fails here.
    expect(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })).toMatch(/^vitest\/\d+\.\d+\.\d+/);
  });

  it('accepts passed assertions in every requested file', () => {
    const result = validateE2eReport(report({ name: first, statuses: ['passed'] }, { name: second, statuses: ['passed', 'passed'] }), [first, second], 0, root);
    expect(result).toEqual({ passed: 3, failed: 0, skipped: 0, problems: [] });
  });

  it('rejects a failed assertion even if another assertion passed', () => {
    const result = validateE2eReport(report({ name: first, statuses: ['passed', 'failed'] }), [first], 0, root);
    expect(result).toMatchObject({ passed: 1, failed: 1 });
    expect(result.problems).toContain('1 test(s) failed');
  });

  it.each(['skipped', 'todo', 'pending'])('rejects %s assertions even alongside a pass', (status) => {
    const result = validateE2eReport(report({ name: first, statuses: ['passed', status] }), [first], 0, root);
    expect(result.skipped).toBe(1);
    expect(result.problems).toContain(`skipped: ${path.resolve(root, first)} > test 1`);
  });

  it('rejects a missing JSON report', () => {
    const result = validateE2eReport(undefined, [first], 0, root);
    expect(result.problems).toContain('no JSON report');
  });

  it.each(['', '{}', '{"testResults":[]}'])('rejects an empty report (%j)', (json) => {
    const result = validateE2eReport(json, [first], 0, root);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems).toContain(`no passed tests: ${first}`);
  });

  it('rejects a collected file with no assertions', () => {
    const result = validateE2eReport(report({ name: first, statuses: [] }), [first], 0, root);
    expect(result.problems).toContain(`no tests collected: ${first}`);
    expect(result.problems).toContain(`no passed tests: ${first}`);
  });

  it('rejects a requested file that was not collected', () => {
    const result = validateE2eReport(report({ name: first, statuses: ['passed'] }), [first, second], 0, root);
    expect(result.problems).toContain(`no tests collected: ${second}`);
  });

  it('requires a passed assertion in each requested file, not merely collection', () => {
    const result = validateE2eReport(report({ name: first, statuses: ['passed'] }, { name: second, statuses: ['pending'] }), [first, second], 0, root);
    expect(result.problems).toContain(`no passed tests: ${second}`);
    expect(result.problems).toContain(`skipped: ${path.resolve(root, second)} > test 0`);
  });

  it('rejects a nonzero child exit even if the report claims every assertion passed', () => {
    const result = validateE2eReport(report({ name: first, statuses: ['passed'] }), [first], 2, root);
    expect(result.problems).toContain('vitest exited with status 2');
  });
});
