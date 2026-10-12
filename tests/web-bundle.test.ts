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
/** The entry chunk index.html loads: everything a visitor downloads before opening anything. */
let js = '';
let css = '';
/** Chunks loaded on demand (today: the terminal view and its headless parser), by file name. */
let lazy = new Map<string, string>();

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
  // The entry is the script index.html names, not whichever chunk the platform lists first
  // (Linux sorts `TerminalView-*` ahead of `index-*`; Windows does not).
  const entry = /<script[^>]*\bsrc="\/app\/assets\/([^"]+\.js)"/.exec(readFileSync(path.join(out, 'index.html'), 'utf8'))?.[1];
  if (!entry) throw new Error('index.html names no entry script');
  js = readFileSync(path.join(assets, entry), 'utf8');
  css = readFileSync(path.join(assets, files.find((f) => f.endsWith('.css'))!), 'utf8');
  lazy = new Map(files.filter((f) => f.endsWith('.js') && f !== entry).map((f) => [f, readFileSync(path.join(assets, f), 'utf8')]));
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
    for (const [name, code] of [['entry', `${js}\n${css}`] as const, ...lazy]) {
      expect(code, name).not.toMatch(/\beval\s*\(/);
      expect(code, name).not.toContain('new Function');
      expect(code, name).not.toContain('ENROLL');
      expect(code, name).not.toContain('electron');
    }
    // CSS may carry inert `.xterm` selectors from the shared stylesheet. The entry a visitor loads
    // carries no terminal code at all: the remote terminal's headless parser arrives only when a
    // terminal is opened (P3.5), and the desktop's DOM renderer and addons never ship.
    expect(js.toLowerCase()).not.toContain('xterm');
    for (const [name, code] of lazy) {
      if (code.toLowerCase().includes('xterm')) expect(name, 'only the terminal view and its parser may carry xterm').toMatch(/^(TerminalView|xterm-headless)-/);
      expect(code, name).not.toMatch(/addon-webgl|addon-fit|WebglAddon|xterm-screen/);
    }
  });

  it('stays inside the size budget', () => {
    const jsKb = gzipSync(js).length / 1024;
    const cssKb = gzipSync(css).length / 1024;
    // Budget: ~180 KB JS (hard fail above 220) and ~35 KB CSS; report the actuals on failure.
    expect(jsKb, `web JS gzip ${jsKb.toFixed(1)} KB`).toBeLessThan(220);
    expect(cssKb, `web CSS gzip ${cssKb.toFixed(1)} KB`).toBeLessThan(35);
    // On-demand chunks have their own budget, so the terminal cannot quietly grow without bound.
    const lazyKb = gzipSync([...lazy.values()].join('\n')).length / 1024;
    expect(lazyKb, `web on-demand JS gzip ${lazyKb.toFixed(1)} KB`).toBeLessThan(80);
  });

  it('declares the shell script as the Vite module entry', () => {
    // A build tool change that stops emitting the module script would leave a blank page.
    expect(readFileSync(path.join(out, 'index.html'), 'utf8')).toContain('<script type="module"');
  });
});
