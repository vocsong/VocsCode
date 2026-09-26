/** What the web bundle must and must not contain (docs/REMOTE-ACCESS.md §4): no inline script, no
 *  eval, no desktop-only code (xterm, Electron, the enrollment secret), only hashed /app/assets
 *  references, and a size budget. Built into a temp directory so the test never disturbs the
 *  served assets. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
let out = '';
let js = '';
let css = '';

beforeAll(() => {
  out = mkdtempSync(path.join(os.tmpdir(), 'vocs-web-bundle-'));
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.web.ts', '--outDir', out],
    { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } }
  );
  if (result.status !== 0) throw new Error(`vite build failed (${result.status}):\n${result.stderr || result.stdout}`);
  const assets = path.join(out, 'assets');
  const files = readdirSync(assets);
  js = readFileSync(path.join(assets, files.find((f) => f.endsWith('.js'))!), 'utf8');
  css = readFileSync(path.join(assets, files.find((f) => f.endsWith('.css'))!), 'utf8');
});

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

describe('web bundle', () => {
  it('references only hashed /app/assets files and ships no inline script', () => {
    const html = readFileSync(path.join(out, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toContain('<style');
    for (const reference of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      expect(reference[1]).toMatch(/^\/app\/assets\/[A-Za-z0-9_-]+\.(?:js|css)$/);
    }
  });

  it('contains no desktop-only or dynamic-eval code', () => {
    const bundle = `${js}\n${css}`;
    expect(bundle).not.toMatch(/\beval\s*\(/);
    expect(bundle).not.toContain('new Function');
    expect(bundle).not.toContain('ENROLL');
    // CSS may carry inert `.xterm` selectors from the shared stylesheet; the terminal library
    // itself, and anything Electron, must not be in the JavaScript.
    expect(js.toLowerCase()).not.toContain('xterm');
    expect(js).not.toContain('electron');
  });

  it('stays inside the size budget', () => {
    const jsKb = gzipSync(js).length / 1024;
    const cssKb = gzipSync(css).length / 1024;
    // Budget: ~180 KB JS (hard fail above 220) and ~35 KB CSS; report the actuals on failure.
    expect(jsKb, `web JS gzip ${jsKb.toFixed(1)} KB`).toBeLessThan(220);
    expect(cssKb, `web CSS gzip ${cssKb.toFixed(1)} KB`).toBeLessThan(35);
  });

  it('declares the shell script as the Vite module entry', () => {
    // A build tool change that stops emitting the module script would leave a blank page.
    expect(readFileSync(path.join(out, 'index.html'), 'utf8')).toContain('<script type="module"');
  });
});
