/** Static guard for the served web dashboard (docs/WEB-DASHBOARD.md §6): it lives at `/dashboard`
 *  on the landing origin, so its assets are absolute `/dashboard/` paths, it talks only to its own
 *  origin, and the retired `/app` path redirects there with its query intact. These are the things
 *  only a build or a deployment config can get wrong; the behavior itself is covered by
 *  tests/web-dashboard.test.tsx and the real-browser suite. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { legacyAppRedirect } from '../relay/src/legacy-app';
import { connectLink } from '../src/shared/pairing';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) => readFile(path.join(root, relative), 'utf8');

describe('web dashboard layout (/dashboard on the landing origin)', () => {
  it('ships no inline script or style, and asks for the modules the build emits', async () => {
    const html = await read('src/web/index.html');
    expect(html).toContain('<script type="module" src="/main.tsx"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toContain('<style');
    expect(html).toContain('viewport-fit=cover');
  });

  it('builds under /dashboard into the relay assets, for the oldest supported phone browser', async () => {
    const config = await read('vite.config.web.ts');
    expect(config).toContain("base: '/dashboard/'");
    expect(config).toContain("outDir: resolve('relay/public/dashboard')");
    expect(config).toContain("'safari16'");
  });

  it('ships a restrictive same-origin CSP, no-store for the shell and immutable hashed assets', async () => {
    const headers = await read('relay/public/_headers');
    expect(headers).toMatch(/\/dashboard\/\*\s+Content-Security-Policy:/);
    expect(headers).toContain("default-src 'none'");
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain("connect-src 'self';");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toMatch(/\/dashboard\/\*[\s\S]*Cache-Control:\s*no-store/i);
    expect(headers).toMatch(/\/dashboard\/assets\/\*[\s\S]*!\s*Cache-Control[\s\S]*max-age=31536000, immutable/);
    expect(headers).not.toMatch(/unsafe-inline|unsafe-eval|wss:/);
  });

  it('calls only same-origin owner routes, never a relay URL or a stored credential', async () => {
    const api = await read('src/web/owner-api.ts');
    expect(api).toContain("credentials: 'same-origin'");
    expect(api).not.toMatch(/https?:\/\/|relay[Uu]rl|localStorage|indexedDB|authorization/);
    const sources = (await Promise.all(['src/web/main.tsx', 'src/web/shell/DashboardApp.tsx', 'src/web/screens/ConnectScreen.tsx'].map(read))).join('\n');
    expect(sources).not.toMatch(/web-client|RelayClient|pairWithHost/);
  });

  it('builds the dashboard in npm and the deploy workflow, never from a checked-in bundle', async () => {
    const pkg = JSON.parse(await read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build:web']).toBe('vite build --config vite.config.web.ts');
    expect(pkg.scripts.build).toContain('npm run build:web');
    const workflow = await read('.github/workflows/deploy-relay.yml');
    expect(workflow).toContain('npm run build:web');
    expect(workflow).toContain('test -f relay/public/dashboard/index.html');
    expect(await read('.gitignore')).toContain('relay/public/dashboard/');
  });
});

describe('the retired /app path', () => {
  it('redirects to /dashboard, keeping the Connect with Vocs query a released desktop opens', () => {
    const hash = 'b'.repeat(64);
    const res = legacyAppRedirect(new URL(`https://code.vocs.io/app?connect=${hash}`))!;
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`/dashboard/?connect=${hash}`);
    expect(legacyAppRedirect(new URL('https://code.vocs.io/app/'))!.headers.get('location')).toBe('/dashboard/');
    expect(legacyAppRedirect(new URL('https://code.vocs.io/app/assets/x.js'))!.headers.get('location')).toBe('/dashboard/assets/x.js');
    expect(legacyAppRedirect(new URL('https://code.vocs.io/application'))).toBeNull();
    expect(legacyAppRedirect(new URL('https://code.vocs.io/v1/me'))).toBeNull();
  });

  it('runs the Worker before static files on /app, so a stale build left there is never served', async () => {
    const config = await read('relay/wrangler.jsonc');
    expect(config).toMatch(/"run_worker_first":\s*\["\/app",\s*"\/app\/\*"\]/);
  });

  it('has new desktops open /dashboard directly', () => {
    expect(connectLink('https://code.vocs.io', 'c'.repeat(64))).toBe(`https://code.vocs.io/dashboard?connect=${'c'.repeat(64)}`);
  });
});
