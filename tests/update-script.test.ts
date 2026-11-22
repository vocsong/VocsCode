import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('update script', () => {
  it('installs production and development dependencies before rebuilding', () => {
    expect(scripts.update).toBe(
      'git pull && npm install --include=dev && npm run build && npm start',
    );
  });

  it.each([
    { name: 'restores a missing Electron runtime', executable: '' },
    { name: 'preserves an explicit Electron executable', executable: process.execPath },
  ])('$name before preview', ({ executable }) => {
    const checkout = mkdtempSync(path.join(tmpdir(), 'vocs-code-start-'));
    try {
      const bin = path.join(checkout, 'node_modules', '.bin');
      const electron = path.join(checkout, 'node_modules', 'electron');
      const runtimeMarker = path.join(electron, 'path.txt');
      mkdirSync(bin, { recursive: true });
      mkdirSync(electron);
      writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ scripts }));
      writeFileSync(path.join(electron, 'index.js'), `
        require('node:fs').writeFileSync(${JSON.stringify(runtimeMarker)}, 'electron');
      `);
      writeFileSync(path.join(checkout, 'preview.cjs'), `
        const { existsSync } = require('node:fs');
        if (!process.env.ELECTRON_EXEC_PATH && !existsSync(${JSON.stringify(runtimeMarker)})) {
          throw new Error('Electron uninstall');
        }
        console.log('preview started');
      `);
      writeFileSync(path.join(bin, 'electron-vite.cmd'), '@node "%~dp0..\\..\\preview.cjs" %*\r\n');
      writeFileSync(
        path.join(bin, 'electron-vite'),
        '#!/bin/sh\nexec node "$(dirname "$0")/../../preview.cjs" "$@"\n',
        { mode: 0o755 },
      );

      const result = spawnSync('npm start', {
        cwd: checkout,
        shell: true,
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_EXEC_PATH: executable },
        timeout: 10_000,
      });

      expect(result.status, result.error?.message ?? result.stderr).toBe(0);
      expect(result.stdout).toContain('preview started');
      expect(existsSync(runtimeMarker)).toBe(!executable);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
