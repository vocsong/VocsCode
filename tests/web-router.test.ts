/** @vitest-environment jsdom */
/** Hash routing and pairing-parameter handling for the web shell (src/web/router.ts). The pairing
 *  code and the Connect-with-GitHub hash must be readable once and scrubbed: neither is a
 *  credential the browser should keep in history. */
import { beforeEach, describe, expect, it } from 'vitest';
import { connectHashFromUrl, navigate, pairingCodeFromUrl, readRoute, routeHref, scrubParams } from '../src/web/router';

const HASH64 = 'a'.repeat(64);

beforeEach(() => {
  window.history.replaceState(null, '', '/app/');
});

describe('pairing parameters', () => {
  it('reads exactly one valid code or connect hash', () => {
    expect(pairingCodeFromUrl('?code=abcd2345')).toBe('ABCD2345');
    expect(pairingCodeFromUrl('?code=ABCD2345&relay=https%3A%2F%2Frelay.example')).toBe('ABCD2345');
    // Ambiguous or malformed values are ignored, never half-used.
    expect(pairingCodeFromUrl('?code=abcd2345&code=abcd2346')).toBeNull();
    expect(pairingCodeFromUrl('?code=short')).toBeNull();
    expect(pairingCodeFromUrl('')).toBeNull();
    expect(connectHashFromUrl(`?connect=${HASH64}`)).toBe(HASH64);
    expect(connectHashFromUrl(`?connect=${HASH64}&connect=${HASH64}`)).toBeNull();
    expect(connectHashFromUrl('?connect=nope')).toBeNull();
  });

  it('scrubs only the pairing parameters, keeping the relay override and the hash', () => {
    window.history.replaceState(null, '', '/app/?code=abcd2345&relay=https%3A%2F%2Frelay.example#/h/h1/s/s1');
    scrubParams(['code', 'connect']);
    expect(window.location.search).toBe('?relay=https%3A%2F%2Frelay.example');
    expect(window.location.hash).toBe('#/h/h1/s/s1');
    // A second call with nothing to remove leaves the URL alone.
    scrubParams(['code']);
    expect(window.location.search).toBe('?relay=https%3A%2F%2Frelay.example');
  });
});

describe('hash routes', () => {
  it('reads home, pair and session routes', () => {
    expect(readRoute()).toEqual({ name: 'home' });
    window.location.hash = '#/pair';
    expect(readRoute()).toEqual({ name: 'pair' });
    window.location.hash = '#/h/h_1/s/s_2';
    expect(readRoute()).toEqual({ name: 'session', host: 'h_1', session: 's_2' });
    // An unknown hash is home, never a blank screen.
    window.location.hash = '#/nonsense';
    expect(readRoute()).toEqual({ name: 'home' });
  });

  it('navigates and round-trips hrefs, encoding ids', () => {
    const route = { name: 'session', host: 'h/1', session: 's 2' } as const;
    expect(routeHref(route)).toBe('#/h/h%2F1/s/s%202');
    navigate(route);
    expect(readRoute()).toEqual(route);
    navigate({ name: 'home' });
    expect(window.location.hash).toBe('#/');
  });
});
