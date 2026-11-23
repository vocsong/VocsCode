import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

/** The top-level `mac:` block of electron-builder.yml, one entry per line. */
function macSection(): string[] {
  const lines = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8').split(/\r?\n/);
  const start = lines.indexOf('mac:');
  expect(start, 'electron-builder.yml must have a top-level mac: section').toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

describe('macOS code signing', () => {
  it('ad-hoc signs the app so Gatekeeper offers Open Anyway instead of "damaged"', () => {
    // Without an identity electron-builder skips signing and ships Electron's leftover linker
    // signature, which fails codesign --verify; a quarantined download then reads as damaged.
    const mac = macSection();
    expect(mac).toContain('  identity: "-"');
    // Hardened runtime's library validation stops an ad-hoc signed Electron app launching.
    expect(mac).toContain('  hardenedRuntime: false');
  });
});
