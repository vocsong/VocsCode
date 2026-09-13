/**
 * Resolves the vitest CLI entry point the e2e guard spawns.
 *
 * vitest 4 dropped the `vitest/vitest.mjs` subpath export — the file is still the package's `bin`
 * target, it is just no longer reachable through `exports` — so read the manifest and follow its
 * `bin` field instead of hard-coding a path a major bump can move.
 *
 * Resolved through Node so a git worktree that borrows the parent checkout's node_modules works too.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export function resolveVitestBin(from = import.meta.url) {
  const manifest = createRequire(from).resolve('vitest/package.json');
  const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin?.vitest;
  if (!bin) throw new Error('vitest does not declare a `vitest` bin entry');
  return path.join(path.dirname(manifest), bin);
}
