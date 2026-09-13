/**
 * The e2e guard shells out to vitest's CLI to run the gated suites (and fails them if any suite
 * self-skips). vitest 4 no longer exports `vitest/vitest.mjs`, which used to be that entry point,
 * so this pins the guard's resolution to a CLI Node can actually execute — otherwise the whole e2e
 * tier dies before it launches anything.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

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
});
