import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fullRunReason } from '../scripts/test-changed-scope.mjs';

const root = path.resolve(import.meta.dirname, '..');
const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const prFiles = JSON.parse(readFileSync(path.join(root, 'scripts/pr-test-files.json'), 'utf8')) as string[];
const releaseCondition = /github\.event_name == 'workflow_dispatch' \|\|\s*\(github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'\) \|\|\s*\(github\.event_name == 'pull_request' && github\.base_ref == 'master'\)/;

function job(name: string) {
  const start = workflow.indexOf(`  ${name}:\n`);
  expect(start, `CI job ${name} exists`).toBeGreaterThanOrEqual(0);
  const body = workflow.slice(start + name.length + 4);
  const next = body.search(/^  [\w-]+:\n/m);
  return body.slice(0, next < 0 ? undefined : next);
}

describe('CI tier boundaries', () => {
  it('keeps the develop gate on typecheck, build, and a bounded allowlist with no-skip evidence', () => {
    const gate = job('gate');
    expect(gate).toContain('npm run typecheck');
    expect(gate).toContain('npm run test:pr');
    expect(readFileSync(path.join(root, 'scripts/test-pr.mjs'), 'utf8')).toContain('test-report-check.mjs');
    expect(gate).toContain('npm run build');
    expect(prFiles.length).toBeGreaterThanOrEqual(10);
    expect(new Set(prFiles).size).toBe(prFiles.length);
    expect(prFiles.every((file) => file.startsWith('tests/') && !file.startsWith('tests/e2e.'))).toBe(true);
    expect(prFiles.every((file) => existsSync(path.join(root, file)))).toBe(true);
    expect(prFiles).toEqual(expect.arrayContaining([
      'tests/review-fixes.test.ts', 'tests/session-resume.test.ts', 'tests/mission-store.test.ts',
      'tests/relay-core.test.ts', 'tests/qr.test.ts', 'tests/web-transport.test.ts'
    ]));
    expect(gate).toMatch(releaseCondition);
    expect(gate).toContain('name: Full offline suite');
  });

  it.each(['e2e', 'windows-offline'])('runs full-tier job %s only for release-to-master or manual validation', (name) => {
    expect(job(name)).toMatch(releaseCondition);
  });

  it('keeps the full offline and no-provider E2E suites in their release-only jobs', () => {
    expect(job('gate')).toContain('npm test --');
    expect(job('e2e')).toContain('npm run test:e2e:ci');
    expect(job('windows-offline')).toContain('tests/mission-receipt-recovery.test.ts');
  });
});

describe('develop-tier local test scope', () => {
  it('is the command the verification bar names', () => {
    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['test:changed']).toBe('node scripts/test-changed.mjs');
    const script = readFileSync(path.join(root, 'scripts/test-changed.mjs'), 'utf8');
    expect(script).toContain("'--changed', base");
    expect(script).toContain('tests/smoke.remote-live.test.ts');
    expect(readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain('`npm run test:changed`');
  });

  it('follows the import graph for source, test and docs edits', () => {
    expect(fullRunReason(['src/main/session-manager.ts', 'tests/qr.test.ts', 'docs/TESTING.md', 'AGENTS.md'])).toBeUndefined();
    expect(fullRunReason(['src/renderer/src/package.json', 'scripts/tsconfig-notes.md'])).toBeUndefined();
  });

  it.each([
    'package.json', 'package-lock.json', 'tsconfig.test.json', 'relay/tsconfig.json',
    'vitest.config.ts', 'vitest.relay.config.ts', 'vite.config.web.ts', 'electron.vite.config.ts'
  ])('runs the whole offline suite when %s changes, which no test imports', (file) => {
    expect(fullRunReason(['src/shared/qr.ts', file])).toBe(file);
    expect(fullRunReason([file.replace(/\//g, '\\')])).toBe(file);
  });
});
