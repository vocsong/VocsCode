/** Static guard for the served web app (docs/REMOTE-ACCESS.md §4): it lives at `/app` on the
 *  landing origin, so its assets are absolute `/app/` paths and it never asks the user for a relay
 *  URL — the base is the page's own origin, with `?relay=` as the development override. These are
 *  the things only a build or a deployment config can get wrong; the behavior itself is covered by
 *  tests/web-shell.test.tsx, tests/web-transport.test.ts and the real-browser suite. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) => readFile(path.join(root, relative), 'utf8');

describe('web app layout (/app on the landing origin)', () => {
  it('ships no inline script or style, and asks for the modules the build emits', async () => {
    const html = await read('src/web/index.html');
    expect(html).toContain('<script type="module" src="/main.tsx"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toContain('<style');
    // The phone viewport: safe areas and a keyboard that resizes the content instead of panning.
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('interactive-widget=resizes-content');
  });

  it('builds under /app into the relay assets, for the oldest supported phone browser', async () => {
    const config = await read('vite.config.web.ts');
    expect(config).toContain("base: '/app/'");
    expect(config).toContain("outDir: resolve('relay/public/app')");
    expect(config).toContain("'safari16'");
  });

  it('ships a restrictive CSP, no-store for the shell and immutable hashed assets', async () => {
    const headers = await read('relay/public/_headers');
    expect(headers).toMatch(/\/app\/\*\s+Content-Security-Policy:/);
    expect(headers).toContain("default-src 'none'");
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toMatch(/\/app\/\*[\s\S]*Cache-Control:\s*no-store/i);
    // Hashed files can be cached forever; the ! line detaches the no-store rule above.
    expect(headers).toMatch(/\/app\/assets\/\*[\s\S]*!\s*Cache-Control[\s\S]*max-age=31536000, immutable/);
    expect(headers).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it('never asks the visitor for a relay URL', async () => {
    const sources = (
      await Promise.all(['src/web/screens/PairScreen.tsx', 'src/web/screens/ConnectScreen.tsx'].map(read))
    ).join('\n');
    expect(sources).toContain('relayBaseFor(window.location.origin');
    expect(sources).not.toMatch(/relay[Uu]rl|id="relay"|name="relay"/);
    // The only knob is the documented development override.
    expect(sources).toContain("get('relay')");
  });

  it('builds the web app in npm and the deploy workflow, never from a checked-in bundle', async () => {
    const pkg = JSON.parse(await read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build:web']).toBe('vite build --config vite.config.web.ts');
    expect(pkg.scripts.build).toContain('npm run build:web');
    expect(pkg.scripts['relay:page']).toBeUndefined();
    expect(pkg.scripts['typecheck:page']).toBeUndefined();

    const workflow = await read('.github/workflows/deploy-relay.yml');
    expect(workflow).toContain('npm run build:web');
    expect(workflow).toContain('test -f relay/public/app/index.html');
    expect(workflow).not.toContain('relay:page');

    expect(await read('.gitignore')).toContain('relay/public/app/');
  });
});
