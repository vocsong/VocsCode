import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertEndpointUrl, credentialFetch, endpointSocketUrl } from '../src/shared/endpoint-policy';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); }))); });
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no listener');
  return `http://127.0.0.1:${address.port}`;
}

describe('endpoint URL policy', () => {
  it.each(['https://provider.example/v1', 'https://192.168.1.2:8443/v1', 'http://localhost:8787', 'http://LOCALHOST/v1', 'http://127.0.0.1', 'http://127.255.12.34/v1', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://[::1]:8787', 'http://[0:0:0:0:0:0:0:1]/v1'])('allows %s', (url) => {
    expect(assertEndpointUrl(url)).toBeInstanceOf(URL);
  });
  it.each(['http://provider.example/v1', 'http://192.168.1.2', 'http://10.0.0.1', 'http://172.16.0.1', 'http://169.254.1.2', 'http://0.0.0.0', 'http://[::]', 'http://[::ffff:127.0.0.1]', 'http://[fd00::1]', 'http://localhost.example', 'http://fake-localhost', 'http://localhost.', 'http://127.0.0.1.example', 'http://127.0.0.1@evil.example', 'https://user:password@secure.example/?token=hidden', 'https://@secure.example', 'ftp://localhost', 'file:///etc/passwd', 'data:text/plain,private', '//localhost', 'localhost:8787', 'https:/secure.example', 'https://secure.example\\@evil.example', 'https://secure.example\n', 'not a url', ''])('refuses unsafe or malformed URL without reflecting input: %s', (url) => {
    expect(() => assertEndpointUrl(url)).toThrow(/HTTPS/);
    try { assertEndpointUrl(url); } catch (error) { expect(String(error)).not.toMatch(/password|hidden|evil\.example|secure\.example/); }
  });
  it.each(['wss://relay.example/ws', 'ws://localhost:8787/ws', 'ws://127.12.0.1/ws', 'ws://[::1]/ws'])('allows socket %s', (url) => { expect(assertEndpointUrl(url, 'ws')).toBeInstanceOf(URL); });
  it.each(['ws://relay.example/ws', 'ws://192.168.0.1/ws', 'ws://localhost.evil/ws', 'wss://user:password@relay.example/ws', 'https://relay.example/ws'])('refuses socket %s', (url) => { expect(() => assertEndpointUrl(url, 'ws')).toThrow(/WSS/); });
  it('converts only validated HTTP schemes for sockets', () => {
    expect(endpointSocketUrl('https://relay.example/path')).toBe('wss://relay.example/path');
    expect(endpointSocketUrl('http://[::1]:8787')).toBe('ws://[::1]:8787/');
    expect(() => endpointSocketUrl('http://192.168.0.1')).toThrow();
  });
});

describe('credential fetch boundary', () => {
  it('validates actual string, URL and Request targets before the transport sees secrets', async () => {
    const transport = vi.fn(async () => new Response('ok'));
    const guarded = credentialFetch(transport);
    for (const input of ['http://192.168.0.1/v1', new URL('http://192.168.0.1/v1'), new Request('http://192.168.0.1/v1', { headers: { authorization: 'Bearer private' } })]) {
      await expect(guarded(input, { headers: { 'x-api-key': 'private' } })).rejects.toThrow(/HTTPS/);
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it('forces redirect error on the actual request, overriding SDK and Request defaults', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response('', { status: 307, headers: { location: 'http://192.168.0.1/stolen' } }));
    const guarded = credentialFetch(transport);
    await expect(guarded(new Request('https://provider.example/v1', { redirect: 'follow' }), { redirect: 'follow', headers: { 'x-api-key': 'private' } })).rejects.toThrow(/redirects are not allowed/);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });
  it('does not forward a credential-bearing POST body or custom header to a redirect target over real local sockets', async () => {
    let targetRequests = 0, sourceRequests = 0;
    const target = await listen(createServer((_req, res) => { targetRequests++; res.end('stolen'); }));
    const source = await listen(createServer((req, res) => {
      sourceRequests++; expect(req.headers['x-api-key']).toBe('test-secret');
      req.resume(); res.writeHead(307, { location: `${target}/stolen` }); res.end();
    }));
    await expect(credentialFetch()(`${source}/v1`, { method: 'POST', headers: { 'x-api-key': 'test-secret' }, body: 'private prompt', redirect: 'follow' })).rejects.toThrow();
    expect(sourceRequests).toBe(1); expect(targetRequests).toBe(0);
  });
});
