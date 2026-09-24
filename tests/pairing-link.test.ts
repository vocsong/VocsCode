/** Pairing links (src/shared/pairing.ts): the web page claims a code against the origin it was
 *  opened on, so a link to any origin other than this desktop's relay can never pair. The link
 *  used to be hard-coded to code.vocs.io, which broke every dev, preview and self-hosted relay. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_REMOTE_ORIGIN, PAIRING_CODE_PATTERN, pairingLink, remoteOrigin } from '../src/shared/pairing';

describe('pairing links', () => {
  it('opens the web client on the relay this desktop is connected to', () => {
    expect(pairingLink('https://code.vocs.io', 'ABCD2345')).toBe('https://code.vocs.io/app?code=ABCD2345');
    expect(pairingLink('http://127.0.0.1:8787/', 'ABCD2345')).toBe('http://127.0.0.1:8787/app?code=ABCD2345');
    expect(pairingLink('https://vocs-relay.vocs.workers.dev', 'ABCD2345')).toBe('https://vocs-relay.vocs.workers.dev/app?code=ABCD2345');
  });

  it('maps socket schemes to the page scheme and drops paths, credentials and queries', () => {
    expect(remoteOrigin('wss://relay.example.dev/v1/ws/host?device=x')).toBe('https://relay.example.dev');
    expect(remoteOrigin('ws://localhost:8787')).toBe('http://localhost:8787');
    expect(remoteOrigin('https://user:pass@relay.example.dev/path')).toBe('https://relay.example.dev');
  });

  it('falls back to the production origin for a missing or unusable relay URL', () => {
    for (const url of [undefined, '', '   ', 'not a url', 'ftp://relay.example', 'javascript:alert(1)']) {
      expect(remoteOrigin(url)).toBe(DEFAULT_REMOTE_ORIGIN);
    }
  });

  it('matches only the relay code alphabet', () => {
    expect(PAIRING_CODE_PATTERN.test('ABCD2345')).toBe(true);
    for (const code of ['abcd2345', 'ABCD234', 'ABCD23456', 'ABCD1345', 'ABCDO345', '<img src>']) expect(PAIRING_CODE_PATTERN.test(code)).toBe(false);
  });
});
