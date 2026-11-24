/** @vitest-environment jsdom */
/** URL handling for the web dashboard (src/web/router.ts): the Connect-with-Vocs hash a desktop
 *  opens must be readable once and scrubbed, since it should not stay in the browser's history. */
import { beforeEach, describe, expect, it } from 'vitest';
import { connectHashFromUrl, scrubParams } from '../src/web/router';

const HASH64 = 'a'.repeat(64);

beforeEach(() => {
  window.history.replaceState(null, '', '/dashboard/');
});

describe('connect parameter', () => {
  it('reads exactly one valid connect hash', () => {
    expect(connectHashFromUrl(`?connect=${HASH64}`)).toBe(HASH64);
    // Ambiguous or malformed values are ignored, never half-used.
    expect(connectHashFromUrl(`?connect=${HASH64}&connect=${HASH64}`)).toBeNull();
    expect(connectHashFromUrl('?connect=nope')).toBeNull();
    expect(connectHashFromUrl('')).toBeNull();
  });

  it('scrubs only the named parameters, keeping the rest of the URL', () => {
    window.history.replaceState(null, '', `/dashboard/?connect=${HASH64}&code=ABCD2345&keep=1#top`);
    scrubParams(['connect', 'code']);
    expect(window.location.pathname).toBe('/dashboard/');
    expect(window.location.search).toBe('?keep=1');
    expect(window.location.hash).toBe('#top');
  });

  it('leaves the URL alone when there is nothing to scrub', () => {
    window.history.replaceState(null, '', '/dashboard/?keep=1');
    const before = window.history.length;
    scrubParams(['connect']);
    expect(window.location.search).toBe('?keep=1');
    expect(window.history.length).toBe(before);
  });
});
