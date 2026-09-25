import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A jsdom test runs its modules through Vite's browser resolution, which externalizes Node builtins.
// On Windows such a module then fails to load (`No such built-in module: node:`) and the whole file
// reports zero tests, while Linux and macOS load it fine — so CI, which runs `npm test` on Linux
// only, never notices. Walk each jsdom test's static relative imports and keep builtins out.

const testsDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Runtime import specifiers; type-only imports are erased and never load. */
function runtimeImports(source: string): string[] {
  const specs: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*(?:from\s+)?['"]([^'"]+)['"]/gm;
  for (const [, , typeOnly, clause, spec] of source.matchAll(re)) {
    if (typeOnly) continue;
    const named = clause.match(/^\{([^}]*)\}$/);
    if (named && named[1].split(',').every((s) => !s.trim() || /^type\s/.test(s.trim()))) continue;
    specs.push(spec);
  }
  return specs;
}

function resolveRelative(from: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(from), spec);
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find(
    (p) => existsSync(p) && /\.tsx?$/.test(p)
  );
}

/** Each builtin a module graph loads, with the chain of files that pulls it in. */
function builtinChains(entry: string, mocked: Set<string>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeImports(readFileSync(file, 'utf8'))) {
      if (builtins.has(spec)) found.push([...chain.map((p) => path.relative(testsDir, p)), spec].join(' -> '));
      if (!spec.startsWith('.')) continue;
      const next = resolveRelative(file, spec);
      if (next && !mocked.has(next)) walk(next, [...chain, next]);
    }
  };
  walk(entry, [entry]);
  return found;
}

const jsdomTests = readdirSync(testsDir)
  .filter((f) => /\.test\.tsx?$/.test(f))
  .map((f) => path.join(testsDir, f))
  .filter((f) => /@vitest-environment\s+jsdom/.test(readFileSync(f, 'utf8')));

describe('jsdom tests', () => {
  it('finds the jsdom test files', () => {
    expect(jsdomTests.length).toBeGreaterThan(0);
  });

  it.each(jsdomTests.map((f) => [path.basename(f), f]))('%s loads no Node builtin', (_name, file) => {
    const source = readFileSync(file, 'utf8');
    // A module replaced by a vi.mock factory is never loaded, so its imports do not count.
    const mocked = new Set(
      [...source.matchAll(/vi\.mock\(\s*['"](\.[^'"]+)['"]\s*,/g)]
        .map(([, spec]) => resolveRelative(file, spec))
        .filter((p): p is string => !!p)
    );
    // The test file itself may use Node (e.g. to read a fixture); only the modules it imports count.
    const chains = runtimeImports(source)
      .filter((spec) => spec.startsWith('.'))
      .map((spec) => resolveRelative(file, spec))
      .filter((p): p is string => !!p && !mocked.has(p))
      .flatMap((p) => builtinChains(p, mocked));
    expect(chains).toEqual([]);
  });
});
