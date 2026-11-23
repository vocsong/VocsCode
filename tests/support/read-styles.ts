/**
 * Reads a CSS entry file and recursively expands relative `@import` directives so
 * static stylesheet tests stay decoupled from how `styles.css` is split into partials.
 */
import fs from 'node:fs';
import path from 'node:path';

const IMPORT_RE = /^@import\s+['"]([^'"]+)['"][^;]*;\s*$/gm;

export function readCssBundle(entryRelPath = 'src/renderer/src/styles.css'): string {
  const entry = path.resolve(process.cwd(), entryRelPath);
  const readOne = (filePath: string, seen: Set<string>): string => {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return '';
    seen.add(resolved);
    const content = fs.readFileSync(resolved, 'utf8');
    return content.replace(IMPORT_RE, (full, specifier: string) => {
      if (!specifier.startsWith('.')) return full;
      return readOne(path.resolve(path.dirname(resolved), specifier), seen);
    });
  };
  return readOne(entry, new Set());
}
