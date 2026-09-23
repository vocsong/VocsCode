/** Layout guard for the served web app (docs/REMOTE-ACCESS.md §4): it lives at `/app` on the
 *  landing origin, so its assets are absolute `/app/` paths and it never asks the user for a
 *  relay URL — the base is the page's own origin, with `?relay=` as the dev override. Moving the
 *  page without moving its assets, or re-adding a relay field, breaks the deployed page silently
 *  in a way no other test would catch. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => { window: Window & typeof globalThis };
};

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) => readFile(path.join(root, relative), 'utf8');

describe('web app layout (/app on the landing origin)', () => {
  it('loads its stylesheet and bundle from /app', async () => {
    const html = await read('relay/public/app/index.html');
    expect(html).toContain('href="/app/styles.css"');
    expect(html).toContain('src="/app/app.js"');
    // The pre-move root-relative references must not come back.
    expect(html).not.toMatch(/(?:href|src)="\/(?:styles\.css|app\.js)"/);
  });

  it('ships a restrictive CSP on the relay static assets, not merely on the landing proxy', async () => {
    const headers = await read('relay/public/_headers');
    expect(headers).toMatch(/\/app\/\*\s+Content-Security-Policy:/);
    expect(headers).toContain("default-src 'none'");
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain("frame-ancestors 'none'");
    // app.js has an unversioned URL: caching old protocol code would fail reconnects after
    // a relay rollout, so both the page and its bundle must be revalidated on each visit.
    expect(headers).toMatch(/\/app\/\*[\s\S]*Cache-Control:\s*no-store/i);
    expect(headers).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it('never asks the visitor for a relay URL', async () => {
    const html = await read('relay/public/app/index.html');
    expect(html).not.toContain('id="relay"');
    const page = await read('relay/src/page.ts');
    expect(page).toContain('relayBaseFor(window.location.origin');
    expect(page).not.toContain("el('relay')");
  });

  it('opens a pairing link with its code prefilled, but waits for a human to submit the form', async () => {
    const dom = new JSDOM(await read('relay/public/app/index.html'), {
      url: 'https://code.vocs.io/app/?code=abcd2345&relay=https%3A%2F%2Frelay.example%2F#pair',
      runScripts: 'outside-only'
    });
    try {
      Object.assign(dom.window, { TextEncoder });
      Object.defineProperty(dom.window.crypto, 'subtle', { value: { generateKey: () => new Promise(() => {}) } });
      const fetchMock = vi.fn();
      dom.window.fetch = fetchMock;
      dom.window.eval(await read('relay/public/app/app.js'));

      const code = dom.window.document.querySelector<HTMLInputElement>('#code')!;
      expect(code.value).toBe('ABCD2345');
      expect(dom.window.document.querySelector('#screen-pair')?.hasAttribute('hidden')).toBe(false);
      expect(dom.window.document.querySelector('#screen-pairing')?.hasAttribute('hidden')).toBe(true);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/v1/me']);
      // Do not leave the short-lived code in the URL/history or disturb the relay override.
      expect(dom.window.location.href).toBe('https://code.vocs.io/app/?relay=https%3A%2F%2Frelay.example%2F#pair');

      dom.window.document.querySelector<HTMLFormElement>('#pair-form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      expect(dom.window.document.querySelector('#screen-pairing')?.hasAttribute('hidden')).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it('offers account sign-out on both screens only when the landing gate identifies a login', async () => {
    const dom = new JSDOM(await read('relay/public/app/index.html'), {
      url: 'https://code.vocs.io/app/', runScripts: 'outside-only'
    });
    try {
      Object.assign(dom.window, { TextEncoder });
      dom.window.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ login: 'vocs' }) })) as unknown as typeof fetch;
      dom.window.eval(await read('relay/public/app/app.js'));
      await vi.waitFor(() => expect([...dom.window.document.querySelectorAll<HTMLFormElement>('.account-signout')].every((form) => !form.hidden)).toBe(true));
      for (const form of dom.window.document.querySelectorAll<HTMLFormElement>('.account-signout')) {
        expect(form.method).toBe('post');
        expect(form.action).toBe('https://code.vocs.io/logout');
        expect(form.querySelector('.account-name')?.textContent).toBe('@vocs');
      }
      expect(dom.window.document.querySelector('#logout')?.textContent).toBe('Unpair browser');
    } finally {
      dom.window.close();
    }
  });

  it('ignores a malformed URL code without injecting markup or claiming it', async () => {
    const dom = new JSDOM(await read('relay/public/app/index.html'), {
      url: 'https://code.vocs.io/app/?code=%3Cimg%20src=x%20onerror=alert(1)%3E',
      runScripts: 'outside-only'
    });
    try {
      Object.assign(dom.window, { TextEncoder });
      const fetchMock = vi.fn();
      dom.window.fetch = fetchMock;
      dom.window.eval(await read('relay/public/app/app.js'));

      expect(dom.window.document.querySelector<HTMLInputElement>('#code')?.value).toBe('');
      expect(dom.window.document.querySelector('#pair-error')?.textContent).toMatch(/invalid code/i);
      expect(dom.window.document.querySelector('#screen-pair img')).toBeNull();
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/v1/me']);
      expect(dom.window.location.href).toBe('https://code.vocs.io/app/');
    } finally {
      dom.window.close();
    }
  });
});