import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

/** Deliberately opt-in E2E tiers. Every new e2e file needs either the no-key CI gate or a reason here. */
const excluded: Record<string, string> = {
  'e2e.approval.test.ts': 'live provider approval',
  'e2e.electron.test.ts': 'live provider session',
  'e2e.pi-tools.test.ts': 'installed Pi offline runtime',
  'e2e.update.test.ts': 'packaged app and staged update feed',
  'e2e.vesta.test.ts': 'installed Pi offline runtime',
};

describe('E2E suite inventory', () => {
  it('classifies every suite as no-key CI or an explicitly opt-in tier', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const ci = [...pkg.scripts['test:e2e:ci'].matchAll(/tests\/(e2e\.[\w-]+\.test\.ts)\b/g)].map((match) => match[1]!);
    const files = readdirSync(path.join(root, 'tests')).filter((name) => /^e2e\.[\w-]+\.test\.ts$/.test(name));
    expect(new Set(ci).size, 'the CI command must not repeat a suite').toBe(ci.length);
    expect(ci.every((name) => !Object.hasOwn(excluded, name)), 'a no-key suite must not also be classified as opt-in').toBe(true);
    expect(Object.values(excluded).every(Boolean), 'opt-in suites need a reason').toBe(true);
    expect([...ci, ...Object.keys(excluded)].sort()).toEqual(files.sort());
  });
});
