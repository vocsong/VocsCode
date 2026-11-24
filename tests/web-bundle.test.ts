/** What the web dashboard bundle must and must not contain (docs/WEB-DASHBOARD.md §6): no inline
 *  script, no eval, no desktop-only code (xterm, Electron, the enrollment secret), only hashed
 *  /dashboard/assets references, and a size budget. Built into a temp directory so the test never
 *  disturbs the served assets. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
let out = '';
let html = '';
/** Entry script and stylesheets named by index.html. */
let js = '';
let css = '';
/** Chunks loaded on demand, by file name. */
let lazy = new Map<string, string>();

function readAsset(url: string): Buffer {
  const file = /^\/dashboard\/assets\/([\w-]+-[\w-]{8}\.(?:js|css|woff2|svg))$/.exec(url)?.[1];
  if (!file) throw new Error(`not a hashed dashboard asset: ${url}`);
  return readFileSync(path.join(out, 'assets', file));
}

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
  html = readFileSync(path.join(out, 'index.html'), 'utf8');
  // Read what index.html actually loads, not whichever chunk the platform lists first.
  const entry = /<script[^>]*\ssrc="([^"]+\.js)"/.exec(html)?.[1];
  if (!entry) throw new Error('index.html names no entry script');
  js = readAsset(entry).toString('utf8');
  const stylesheets = [...html.matchAll(/<link\b(?=[^>]*\srel="stylesheet")[^>]*\shref="([^"]+)"/gi)];
  if (stylesheets.length === 0) throw new Error('index.html names no stylesheet');
  css = stylesheets.map(([, href]) => readAsset(href).toString('utf8')).join('\n');
  lazy = new Map(files.filter((f) => f.endsWith('.js') && f !== path.posix.basename(entry)).map((f) => [f, readFileSync(path.join(assets, f), 'utf8')]));
});

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

describe('web bundle', () => {
  it('references only hashed /dashboard/assets files and ships no inline script', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toContain('<style');
    for (const [, , url] of html.matchAll(/\s(?:src|href)\s*=\s*(['"])([^'"]+)\1/gi)) readAsset(url);
  });

  it('bundles Inter and Geist Mono as same-origin WOFF2, with no boot stylesheet imports', () => {
    expect(css).not.toMatch(/@import\b/i);
    const families = [];
    for (const [, face] of css.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
      const family = /\bfont-family\s*:\s*([^;}]+)/i.exec(face)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
      const urls = [...face.matchAll(/\burl\(\s*(['"]?)([^'")]+)\1\s*\)/gi)].map((match) => match[2].trim());
      expect(urls.length, `${family} font sources`).toBeGreaterThan(0);
      expect(face, `${family} must load the bundled file, not an installed font`).not.toMatch(/\blocal\s*\(/i);
      for (const url of urls) {
        expect(url).toMatch(/\.woff2$/);
        expect(readAsset(url).subarray(0, 4).toString('ascii'), url).toBe('wOF2');
      }
      families.push(family);
    }
    expect(families).toEqual(expect.arrayContaining(['Inter', 'Geist Mono']));
  });

  it('declares a hashed SVG Code favicon', () => {
    const href = /<link\b(?=[^>]*\srel="icon")[^>]*\shref="([^"]+)"/i.exec(html)?.[1];
    if (!href) throw new Error('index.html names no favicon');
    expect(href).toMatch(/\/code-[\w-]{8}\.svg$/);
    expect(readAsset(href).toString('utf8')).toMatch(/<svg(?:\s|>)/i);
  });

  it('contains no desktop-only or dynamic-eval code', () => {
    for (const [name, code] of [['entry', `${js}\n${css}`] as const, ...lazy]) {
      expect(code, name).not.toMatch(/\beval\s*\(/);
      expect(code, name).not.toContain('new Function');
      expect(code, name).not.toContain('ENROLL');
      expect(code, name).not.toContain('electron');
    }
    // CSS may carry inert `.xterm` selectors from the shared stylesheet; no script carries terminal
    // code, nor the retired remote client's relay socket and browser pairing.
    for (const [name, code] of [['entry', js] as const, ...lazy]) {
      expect(code.toLowerCase(), name).not.toContain('xterm');
      expect(code, name).not.toMatch(/\/v1\/ws\/|pair\/claim|pair-request/);
    }
  });

  it('stays inside the size budget', () => {
    const jsKb = gzipSync(js).length / 1024;
    const cssKb = gzipSync(css).length / 1024;
    // Budget: ~180 KB JS (hard fail above 220) and ~35 KB CSS; report the actuals on failure.
    expect(jsKb, `web JS gzip ${jsKb.toFixed(1)} KB`).toBeLessThan(220);
    expect(cssKb, `web CSS gzip ${cssKb.toFixed(1)} KB`).toBeLessThan(35);
    // On-demand chunks have their own budget, so nothing can quietly grow without bound.
    const lazyKb = gzipSync([...lazy.values()].join('\n')).length / 1024;
    expect(lazyKb, `web on-demand JS gzip ${lazyKb.toFixed(1)} KB`).toBeLessThan(80);
  });

  it('declares the shell script as the Vite module entry', () => {
    // A build tool change that stops emitting the module script would leave a blank page.
    expect(html).toContain('<script type="module"');
  });
});
