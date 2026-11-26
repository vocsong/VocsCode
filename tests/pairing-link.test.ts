/** Connect with Vocs links (src/shared/pairing.ts): the page that adds a computer lives on the relay's
 *  own origin, so the link must open the relay this desktop is connected to. The link used to be
 *  hard-coded to code.vocs.io, which broke every dev, preview and self-hosted relay. */
import { describe, expect, it } from 'vitest';
import { connectCheckCode, connectLink, DEFAULT_REMOTE_ORIGIN, remoteOrigin } from '../src/shared/pairing';

const HASH = 'ab'.repeat(32);

describe('Connect with Vocs links', () => {
  it('opens the dashboard on the relay this desktop is connected to', () => {
    expect(connectLink('https://code.vocs.io', HASH)).toBe(`https://code.vocs.io/dashboard?connect=${HASH}`);
    expect(connectLink('http://127.0.0.1:8787/', HASH)).toBe(`http://127.0.0.1:8787/dashboard?connect=${HASH}`);
    expect(connectLink('wss://relay.example.dev/v1/ws/host', HASH)).toBe(`https://relay.example.dev/dashboard?connect=${HASH}`);
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

  it('derives the same short check code on both sides, from the hash alone', () => {
    expect(connectCheckCode(HASH)).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    expect(connectCheckCode(HASH)).toBe(connectCheckCode(HASH));
    expect(connectCheckCode('cd'.repeat(32))).not.toBe(connectCheckCode(HASH));
  });
});
