// The app's own MCP client over HTTP and SSE, against real loopback servers. Offline: every
// server here is a node:http listener on 127.0.0.1. Two listeners give two distinct origins, so
// the tests can check that a client stays on the origin it was configured with.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { connectServer, inspectServer, originBoundFetch } from '../src/main/mcp/client';
import type { McpServerDef } from '../src/shared/types';
import { PiMcpConnection } from '../resources/pi/mcp-client';

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

interface Fixture { origin: string; seen: Seen[]; server: Server }

const servers: Server[] = [];

async function listen(handler: Handler): Promise<Fixture> {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    handler(req, res, body);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const TOOLS = [{ name: 'echo', description: 'Says it back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }];

/** One JSON-RPC answer for the handful of methods the client sends; undefined for notifications. */
function answer(body: string): unknown {
  const message = JSON.parse(body) as { id?: number; method?: string; params?: { arguments?: { text?: string } } };
  if (message.id === undefined) return undefined;
  if (message.method === 'initialize') {
    return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1.0.0' } } };
  }
  if (message.method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } };
  if (message.method === 'tools/call') return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `echo:${message.params?.arguments?.text ?? ''}` }] } };
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
}

/** A minimal streamable-HTTP MCP server: JSON responses to POSTs, no standalone GET stream. */
function streamableHandler(): Handler {
  return (req, res, body) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const reply = answer(body);
    if (reply === undefined) { res.writeHead(202).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
  };
}

/** A minimal legacy SSE MCP server: GET opens the stream, POSTs to the announced endpoint. */
function sseHandler(): Handler {
  let stream: ServerResponse | undefined;
  return (req, res, body) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('event: endpoint\ndata: /messages\n\n');
      stream = res;
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/messages')) {
      res.writeHead(202).end();
      const reply = answer(body);
      if (reply !== undefined) stream?.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      return;
    }
    res.writeHead(404).end();
  };
}

const HEADERS = { 'X-API-Key': 'fixture-key' };
const TRANSPORTS = [
  { transport: 'http' as const, path: '/mcp', handler: streamableHandler },
  { transport: 'sse' as const, path: '/sse', handler: sseHandler }
];
const REDIRECTS = [301, 302, 303, 307, 308];

function def(transport: 'http' | 'sse', url: string): McpServerDef {
  return { id: 'remote', transport, url, headers: { ...HEADERS } };
}

describe.each(TRANSPORTS)('$transport MCP client on its configured origin', ({ transport, path, handler }) => {
  it('connects, lists and calls tools with the configured headers', async () => {
    const server = await listen(handler());
    const conn = await connectServer(def(transport, `${server.origin}${path}`), { timeoutMs: 5_000 });
    try {
      expect(conn.tools.map((t) => t.name)).toEqual(['echo']);
      const result = await conn.call('echo', { text: 'hi' });
      expect(result).toMatchObject({ isError: false, output: 'echo:hi' });
    } finally {
      await conn.close();
    }
    const bodies = server.seen.filter((r) => r.body).map((r) => (JSON.parse(r.body) as { method: string }).method);
    expect(bodies).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(server.seen.every((r) => r.headers['x-api-key'] === 'fixture-key')).toBe(true);
  }, 30_000);

  it('inspects a server with the configured headers', async () => {
    const server = await listen(handler());
    const result = await inspectServer(def(transport, `${server.origin}${path}`), { timeoutMs: 5_000 });
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, serverInfo: { name: 'http-fixture', version: '1.0.0' }, tools: [{ name: 'echo', description: 'Says it back' }] });
    expect(server.seen.length).toBeGreaterThan(0);
    expect(server.seen.every((r) => r.headers['x-api-key'] === 'fixture-key')).toBe(true);
  }, 30_000);

  describe.each(REDIRECTS)('when the configured URL answers %i', (status) => {
    async function redirecting() {
      const other = await listen(handler());
      const configured = await listen((_req, res) => { res.writeHead(status, { Location: `${other.origin}${path}` }).end(); });
      expect(other.origin).not.toBe(configured.origin);
      return { other, configured, def: def(transport, `${configured.origin}${path}`) };
    }

    it('connectServer fails and sends nothing to the other origin', async () => {
      const { other, configured, def: server } = await redirecting();
      let conn: Awaited<ReturnType<typeof connectServer>> | undefined;
      let failure: unknown;
      try { conn = await connectServer(server, { timeoutMs: 5_000 }); } catch (e) { failure = e; } finally { await conn?.close(); }
      expect(other.seen).toEqual([]);
      expect(conn).toBeUndefined();
      expect(String(failure)).toMatch(/redirect/i);
      expect(configured.seen.length).toBeGreaterThan(0);
      expect(configured.seen[0].headers['x-api-key']).toBe('fixture-key');
    }, 30_000);

    it('inspectServer fails and sends nothing to the other origin', async () => {
      const { other, configured, def: server } = await redirecting();
      const result = await inspectServer(server, { timeoutMs: 5_000 });
      expect(other.seen).toEqual([]);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/redirect/i);
      expect(result.tools).toEqual([]);
      expect(configured.seen.length).toBeGreaterThan(0);
    }, 30_000);
  });
});

describe('the HTTP fetch MCP transports use', () => {
  it('refuses a URL on another origin before sending anything', async () => {
    const configured = await listen(streamableHandler());
    const other = await listen(streamableHandler());
    const guarded = originBoundFetch(new URL(`${configured.origin}/mcp`));
    await expect(guarded(`${other.origin}/mcp`, { method: 'POST', headers: { ...HEADERS }, body: '{}' })).rejects.toThrow(/refused/);
    expect(other.seen).toEqual([]);
    expect(configured.seen).toEqual([]);
  });

  it('keeps redirects manual even when the caller asks to follow them', async () => {
    const other = await listen(streamableHandler());
    const configured = await listen((_req, res) => { res.writeHead(307, { Location: `${other.origin}/mcp` }).end(); });
    const guarded = originBoundFetch(new URL(`${configured.origin}/mcp`));
    await expect(guarded(`${configured.origin}/mcp`, { method: 'GET', redirect: 'follow', headers: { ...HEADERS } })).rejects.toThrow(/redirected \(HTTP 307\)/);
    expect(configured.seen).toHaveLength(1);
    expect(other.seen).toEqual([]);
  });
});

describe('MCP URLs that are not http or https', () => {
  it.each(['file:///srv/mcp', 'data:text/plain,mcp', 'ftp://127.0.0.1/mcp'])('refuses %s for both transports and the Pi bridge', async (url) => {
    for (const transport of ['http', 'sse'] as const) {
      const result = await inspectServer(def(transport, url), { timeoutMs: 5_000 });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/must use http or https/);
      await expect(connectServer(def(transport, url), { timeoutMs: 5_000 })).rejects.toThrow(/must use http or https/);
    }
    await expect(PiMcpConnection.connect({ id: 'p', transport: 'http', url, headers: { ...HEADERS } })).rejects.toThrow(/must use http or https/);
  }, 30_000);

  it('does not let two opaque origins match each other', async () => {
    const guarded = (() => { try { return originBoundFetch(new URL('file:///srv/mcp')); } catch (e) { return e as Error; } })();
    expect(guarded).toBeInstanceOf(Error);
    expect(String(guarded)).toMatch(/must use http or https/);
    const configured = await listen(streamableHandler());
    const bound = originBoundFetch(new URL(`${configured.origin}/mcp`));
    await expect(bound('data:text/plain,mcp')).rejects.toThrow(/refused/);
  });
});

describe('3xx answers that are not redirects', () => {
  it('reports a 304 as an HTTP error, not a redirect', async () => {
    const configured = await listen((_req, res) => { res.writeHead(304).end(); });
    const result = await inspectServer(def('http', `${configured.origin}/mcp`), { timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    // The SDK's own non-OK error, not the redirect refusal.
    expect(result.error).toMatch(/Error POSTing to endpoint/);
    expect(result.error).not.toMatch(/redirect/i);
  }, 30_000);

  it('passes a 304 and a 300 without Location through, and treats a 300 with Location as a redirect', async () => {
    const other = await listen(streamableHandler());
    const answers: Array<[number, Record<string, string>]> = [[304, {}], [300, {}], [300, { Location: `${other.origin}/mcp` }]];
    const configured = await listen((_req, res) => { const [status, headers] = answers.shift()!; res.writeHead(status, headers).end(); });
    const bound = originBoundFetch(new URL(`${configured.origin}/mcp`));
    expect((await bound(`${configured.origin}/mcp`)).status).toBe(304);
    expect((await bound(`${configured.origin}/mcp`)).status).toBe(300);
    await expect(bound(`${configured.origin}/mcp`)).rejects.toThrow(/redirected \(HTTP 300\)/);
    expect(other.seen).toEqual([]);
  });
});

describe('an SSE endpoint announced off the configured origin', () => {
  // The SDK refuses these itself today; the guard has to hold if that ever changes.
  const variants: Array<[string, (other: string, configured: string) => string]> = [
    ['another port', (other) => `${other}/messages`],
    ['a protocol-relative URL', (other) => `${other.replace(/^http:/, '')}/messages`],
    ['another scheme', (_other, configured) => `${configured.replace(/^http:/, 'https:')}/messages`],
    ['another host', (other) => `${other.replace('127.0.0.1', 'localhost')}/messages`]
  ];

  it.each(variants)('sends nothing to %s', async (_name, announce) => {
    const other = await listen(sseHandler());
    let endpoint = '';
    const configured = await listen((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`event: endpoint\ndata: ${endpoint}\n\n`);
        return;
      }
      res.writeHead(404).end();
    });
    endpoint = announce(other.origin, configured.origin);
    const result = await inspectServer(def('sse', `${configured.origin}/sse`), { timeoutMs: 5_000 });
    expect(other.seen).toEqual([]);
    expect(result.ok).toBe(false);
    expect(configured.seen.map((r) => r.method)).toEqual(['GET']);
  }, 30_000);
});

describe('Pi bridge HTTP client', () => {
  it('connects, lists and calls tools with the configured headers', async () => {
    const server = await listen(streamableHandler());
    const conn = await PiMcpConnection.connect({ id: 'p', transport: 'http', url: `${server.origin}/mcp`, headers: { ...HEADERS } });
    try {
      expect((await conn.listTools()).map((t) => t.name)).toEqual(['echo']);
      expect(await conn.callTool('echo', { text: 'hi' })).toMatchObject({ content: [{ type: 'text', text: 'echo:hi' }] });
    } finally {
      conn.close();
    }
    expect(server.seen.length).toBeGreaterThan(0);
    expect(server.seen.every((r) => r.headers['x-api-key'] === 'fixture-key')).toBe(true);
  }, 30_000);

  it.each(REDIRECTS)('fails on a %i and sends nothing to the other origin', async (status) => {
    const other = await listen(streamableHandler());
    const configured = await listen((_req, res) => { res.writeHead(status, { Location: `${other.origin}/mcp` }).end(); });
    let conn: PiMcpConnection | undefined;
    let failure: unknown;
    try { conn = await PiMcpConnection.connect({ id: 'p', transport: 'http', url: `${configured.origin}/mcp`, headers: { ...HEADERS }, timeoutMs: 5_000 }); } catch (e) { failure = e; } finally { conn?.close(); }
    // Notifications are fire-and-forget, so give a stray one time to land before counting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(other.seen).toEqual([]);
    expect(conn).toBeUndefined();
    expect(String(failure)).toMatch(/redirect/i);
    expect(configured.seen[0]?.headers['x-api-key']).toBe('fixture-key');
  }, 30_000);
});
