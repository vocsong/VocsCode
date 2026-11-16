/**
 * Scope proxy for the shared GitNexus MCP server (`resources/mcp/gitnexus-scope.mjs`).
 *
 * These are the policy boundaries a session depends on: the allow-list matcher,
 * the `group_*`/`list_repos` filtering, and the stdio loop's decision to forward
 * or refuse. The HTTP tests drive `UpstreamClient` against a hand-rolled
 * Streamable-HTTP MCP server so session capture and 404 re-initialization are
 * proven, not assumed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

interface AllowEntry {
  name: string;
  path: string;
}

interface FakeUpstream {
  initialize: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
}

interface ScopeApi {
  parseAllow(raw: unknown): AllowEntry[];
  repoAllowed(repo: unknown, allow: AllowEntry[]): boolean;
  resourceAllowed(uri: unknown, allow: AllowEntry[]): boolean;
  filterTools(tools: unknown): Array<{ name: string }>;
  filterListReposText(text: string, allow: AllowEntry[]): string;
  parseSseJson(text: string): unknown;
  UpstreamClient: new (options: { url: string; fetch?: typeof fetch; headers?: Record<string, string> }) => {
    sessionId: string | null;
    initialize(): Promise<unknown>;
    request(method: string, params?: unknown): Promise<unknown>;
  };
  runScopeProxy(options: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    upstream: FakeUpstream;
    env: Record<string, string | undefined>;
  }): Promise<void>;
}

const proxyUrl = pathToFileURL(path.resolve('resources/mcp/gitnexus-scope.mjs')).href;
const scope = (await import(/* @vite-ignore */ proxyUrl)) as unknown as ScopeApi;

const ALLOW: AllowEntry[] = [
  { name: 'Millie', path: 'D:\\Millie' },
  { name: 'Shared', path: '/srv/shared' }
];

function request(id: number, method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params };
}

function fakeUpstream(): FakeUpstream {
  const calls: FakeUpstream['calls'] = [];
  const upstream: FakeUpstream = {
    initialize: vi.fn(async () => ({ protocolVersion: '2025-06-18' })),
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'tools/list') {
        return { tools: [{ name: 'query' }, { name: 'group_list' }, { name: 'list_repos' }, { name: 'group_query' }] };
      }
      if (method === 'tools/call') {
        return { content: [{ type: 'text', text: `ran ${String(params.name)}` }] };
      }
      if (method === 'resources/list') {
        return {
          resources: [
            { uri: 'gitnexus://repo/Millie/context', name: 'Millie context' },
            { uri: 'gitnexus://repo/Other/context', name: 'Other context' },
            { uri: 'gitnexus://repos', name: 'All Indexed Repositories' }
          ]
        };
      }
      if (method === 'resources/read') return { contents: [{ uri: String(params.uri), text: 'content' }] };
      return {};
    }),
    calls
  };
  return upstream;
}

async function drive(messages: Array<Record<string, unknown>>, upstream: FakeUpstream, env: Record<string, string | undefined> = {}): Promise<Array<Record<string, any>>> {
  const input = Readable.from(messages.map((message) => `${JSON.stringify(message)}\n`));
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  await scope.runScopeProxy({ input, output, upstream, env });
  output.end();
  await finished(output);
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, any>);
}

const ENV = { VOCS_GITNEXUS_PRIMARY: 'D:\\Millie', VOCS_GITNEXUS_ALLOW: JSON.stringify(ALLOW) };

describe('repoAllowed', () => {
  it('matches an allow-listed repo by name or by path', () => {
    expect(scope.repoAllowed('Millie', ALLOW)).toBe(true);
    expect(scope.repoAllowed('D:\\Millie', ALLOW)).toBe(true);
    expect(scope.repoAllowed('d:/millie/', ALLOW)).toBe(true);
    expect(scope.repoAllowed('/srv/shared', ALLOW)).toBe(true);
  });

  it('rejects a repo outside the allow-list, including partial names', () => {
    expect(scope.repoAllowed('Other', ALLOW)).toBe(false);
    expect(scope.repoAllowed('Mill', ALLOW)).toBe(false);
    expect(scope.repoAllowed('D:\\Other', ALLOW)).toBe(false);
    expect(scope.repoAllowed('Millie', [])).toBe(false);
  });

  it('treats an absent repo as valid (it is defaulted to the primary repo)', () => {
    expect(scope.repoAllowed(undefined, ALLOW)).toBe(true);
    expect(scope.repoAllowed(undefined, [])).toBe(true);
    expect(scope.repoAllowed('', ALLOW)).toBe(true);
    expect(scope.repoAllowed(null, ALLOW)).toBe(true);
  });
});

describe('resourceAllowed', () => {
  it('allows repo-scoped URIs only for allow-listed repos', () => {
    expect(scope.resourceAllowed('gitnexus://repo/Millie/context', ALLOW)).toBe(true);
    expect(scope.resourceAllowed('gitnexus://repo/Shared/processes', ALLOW)).toBe(true);
    expect(scope.resourceAllowed('gitnexus://repo/Other/context', ALLOW)).toBe(false);
  });

  it('keeps resources that do not reference a repo', () => {
    expect(scope.resourceAllowed('gitnexus://repos', ALLOW)).toBe(true);
    expect(scope.resourceAllowed('gitnexus://setup', ALLOW)).toBe(true);
    expect(scope.resourceAllowed(undefined, ALLOW)).toBe(true);
    expect(scope.resourceAllowed('gitnexus://repo/Other/context', [])).toBe(false);
  });
});

describe('filterTools', () => {
  it('drops group_* tools and keeps list_repos and friends', () => {
    const tools = [{ name: 'query' }, { name: 'group_list' }, { name: 'list_repos' }, { name: 'group_query' }, { name: 'group_status' }];
    expect(scope.filterTools(tools).map((tool) => tool.name)).toEqual(['query', 'list_repos']);
  });

  it('returns nothing for a malformed tools payload', () => {
    expect(scope.filterTools(undefined)).toEqual([]);
    expect(scope.filterTools({ tools: [] })).toEqual([]);
  });
});

describe('filterListReposText', () => {
  it('filters the JSON payload GitNexus returns, keeping the appended hint', () => {
    const payload =
      JSON.stringify(
        [
          { name: 'Millie', path: 'D:\\Millie', indexedAt: '2026-08-17T14:23:09.443Z', stats: { files: 219, nodes: 3114, processes: 220 } },
          { name: 'Other', path: 'D:\\Other', indexedAt: '2026-01-01T00:00:00.000Z', stats: { files: 3, nodes: 10, processes: 1 } }
        ],
        null,
        2
      ) + '\n\n---\n**Next:** READ gitnexus://repo/{name}/context for any repo above.';
    const filtered = scope.filterListReposText(payload, ALLOW);
    expect(filtered).toContain('Millie');
    expect(filtered).not.toContain('Other');
    expect(filtered).toContain('**Next:**');
  });

  it('filters a human-readable name/Path/stats payload', () => {
    const text = [
      'Indexed repositories:',
      '',
      '  Millie — 3114 symbols, 5827 relationships, 220 flows',
      '    Path: D:\\Millie',
      '    Indexed: 2026-08-17T14:23:09.443Z',
      '  Other — 10 symbols, 20 relationships, 3 flows',
      '    Path: D:\\Other',
      '    Indexed: 2026-01-01T00:00:00.000Z',
      ''
    ].join('\n');
    const filtered = scope.filterListReposText(text, ALLOW);
    expect(filtered).toContain('Millie');
    expect(filtered).not.toContain('Other');
    expect(filtered).toContain('Indexed repositories:');
  });

  it('filters the YAML shape used by gitnexus://repos', () => {
    const yaml = ['repos:', '  - name: "Millie"', '    path: "D:\\\\Millie"', '    files: 219', '  - name: "Other"', '    path: "D:\\\\Other"', '    files: 3', ''].join('\n');
    const filtered = scope.filterListReposText(yaml, ALLOW);
    expect(filtered).toContain('Millie');
    expect(filtered).not.toContain('Other');
  });

  it('never widens access when it cannot parse the payload', () => {
    const text = 'Some opaque blob mentioning gitnexus://repo/Other/context and nothing else.';
    const filtered = scope.filterListReposText(text, ALLOW);
    expect(filtered).not.toContain('Other');
    expect(filtered).toContain('repos: []');
  });
});

describe('parseSseJson', () => {
  it('extracts the JSON-RPC message from an SSE body', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect(scope.parseSseJson(body)).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('returns undefined for a body without data', () => {
    expect(scope.parseSseJson('event: ping\n\n')).toBeUndefined();
    expect(scope.parseSseJson('')).toBeUndefined();
  });
});

describe('runScopeProxy policy', () => {
  it('answers initialize locally after opening the upstream session', async () => {
    const upstream = fakeUpstream();
    const out = await drive([request(1, 'initialize', { protocolVersion: '2025-06-18' })], upstream, ENV);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
    expect(out[0].result.serverInfo.name).toBe('vocs-code-gitnexus-scope');
    expect(out[0].result.capabilities.tools).toEqual({});
    expect(upstream.initialize).toHaveBeenCalledTimes(1);
  });

  it('drops group_* tools from tools/list', async () => {
    const upstream = fakeUpstream();
    const out = await drive([request(1, 'initialize'), request(2, 'tools/list')], upstream, ENV);
    const list = out.find((message) => message.id === 2);
    expect(list?.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['query', 'list_repos']);
  });

  it('pins an absent repo to the session primary and forwards', async () => {
    const upstream = fakeUpstream();
    await drive([request(1, 'initialize'), request(2, 'tools/call', { name: 'context', arguments: { name: 'Order' } })], upstream, ENV);
    const call = upstream.calls.find((entry) => entry.method === 'tools/call');
    expect(call?.params.arguments).toMatchObject({ name: 'Order', repo: 'D:\\Millie' });
  });

  it('forwards an explicitly allow-listed repo unchanged', async () => {
    const upstream = fakeUpstream();
    await drive([request(1, 'initialize'), request(2, 'tools/call', { name: 'query', arguments: { query: 'auth', repo: 'Shared' } })], upstream, ENV);
    const call = upstream.calls.find((entry) => entry.method === 'tools/call');
    expect(call?.params.arguments).toEqual({ query: 'auth', repo: 'Shared' });
  });

  it('rejects a repo outside the allow-list without forwarding', async () => {
    const upstream = fakeUpstream();
    const out = await drive([request(1, 'initialize'), request(2, 'tools/call', { name: 'query', arguments: { query: 'auth', repo: 'Other' } })], upstream, ENV);
    const denied = out.find((message) => message.id === 2);
    expect(denied?.result.isError).toBe(true);
    expect(upstream.calls.some((entry) => entry.method === 'tools/call')).toBe(false);
  });

  it('rejects a group_* call without forwarding', async () => {
    const upstream = fakeUpstream();
    const out = await drive([request(1, 'initialize'), request(2, 'tools/call', { name: 'group_query', arguments: { query: 'x' } })], upstream, ENV);
    const denied = out.find((message) => message.id === 2);
    expect(denied?.result.isError).toBe(true);
    expect(denied?.result.content[0].text).toContain('Group tools are unavailable');
    expect(upstream.calls.some((entry) => entry.method === 'tools/call')).toBe(false);
  });

  it('filters list_repos results through the allow-list', async () => {
    const upstream = fakeUpstream();
    upstream.request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      upstream.calls.push({ method, params });
      if (method === 'tools/call') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify([{ name: 'Millie', path: 'D:\\Millie' }, { name: 'Other', path: 'D:\\Other' }])
            }
          ]
        };
      }
      return {};
    }) as unknown as FakeUpstream['request'];
    const out = await drive([request(1, 'initialize'), request(2, 'tools/call', { name: 'list_repos', arguments: {} })], upstream, ENV);
    const text = out.find((message) => message.id === 2)?.result.content[0].text as string;
    expect(text).toContain('Millie');
    expect(text).not.toContain('Other');
  });

  it('filters non-repo resources and rejects repo resources outside scope', async () => {
    const upstream = fakeUpstream();
    const out = await drive(
      [
        request(1, 'initialize'),
        request(2, 'resources/list'),
        request(3, 'resources/read', { uri: 'gitnexus://repo/Other/context' })
      ],
      upstream,
      ENV
    );
    const list = out.find((message) => message.id === 2);
    expect(list?.result.resources.map((resource: { uri: string }) => resource.uri)).toEqual(['gitnexus://repo/Millie/context', 'gitnexus://repos']);
    const denied = out.find((message) => message.id === 3);
    expect(denied?.error?.code).toBe(-32002);
    expect(upstream.calls.some((entry) => entry.method === 'resources/read')).toBe(false);
  });

  it('reports parse errors instead of crashing', async () => {
    const upstream = fakeUpstream();
    const input = Readable.from(['{ not json\n']);
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    await scope.runScopeProxy({ input, output, upstream, env: ENV });
    output.end();
    await finished(output);
    const message = JSON.parse(chunks.join('').trim());
    expect(message.error.code).toBe(-32700);
  });
});

interface MockMcp {
  url: string;
  state: { initCount: number; did404: boolean };
  close(): Promise<void>;
}

async function startMockMcp(options: { force404Once?: boolean } = {}): Promise<MockMcp> {
  const sessions = new Set<string>();
  const state = { initCount: 0, did404: false };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body: any = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
      const sse = (status: number, payload: unknown, sid?: string): void => {
        if (sid) res.setHeader('mcp-session-id', sid);
        res.statusCode = status;
        if (payload === null) {
          res.end();
          return;
        }
        res.setHeader('content-type', 'text/event-stream');
        res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      if (body?.method === 'initialize') {
        state.initCount += 1;
        const sid = `sess-${state.initCount}`;
        sessions.add(sid);
        sse(200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } }, sid);
        return;
      }
      const sid = req.headers['mcp-session-id'] as string | undefined;
      if (!sid || !sessions.has(sid)) {
        sse(404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
        return;
      }
      if (body?.id === undefined) {
        // notifications/initialized has no id and needs no response
        res.statusCode = 202;
        res.end();
        return;
      }
      if (options.force404Once && !state.did404) {
        state.did404 = true;
        sessions.delete(sid);
        sse(404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
        return;
      }
      sse(200, { jsonrpc: '2.0', id: body.id, result: { method: body.method } }, sid);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/api/mcp`,
    state,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

describe('UpstreamClient over Streamable HTTP', () => {
  let server: MockMcp | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('captures the session id on initialize and replays it on later calls', async () => {
    server = await startMockMcp();
    const client = new scope.UpstreamClient({ url: server.url });
    await client.initialize();
    expect(client.sessionId).toBe('sess-1');
    const result = await client.request('tools/list', {});
    expect(result).toEqual({ method: 'tools/list' });
    expect(server.state.initCount).toBe(1);
  });

  it('re-initializes once and retries when the upstream session expired (404)', async () => {
    server = await startMockMcp({ force404Once: true });
    const client = new scope.UpstreamClient({ url: server.url });
    await client.initialize();
    const result = await client.request('tools/list', {});
    expect(result).toEqual({ method: 'tools/list' });
    expect(server.state.initCount).toBe(2);
  });
});

describe('UpstreamClient redirects', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function listen(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it.each([301, 302, 303, 307, 308])('fails on a %i and sends nothing to the other origin', async (status) => {
    const seen: Array<{ method?: string; key?: string | string[] }> = [];
    const other = await listen((req, res) => { seen.push({ method: req.method, key: req.headers['x-api-key'] }); req.resume(); res.writeHead(404).end(); });
    const configured = await listen((req, res) => { req.resume(); res.writeHead(status, { Location: `${other}/api/mcp` }).end(); });
    expect(other).not.toBe(configured);
    const client = new scope.UpstreamClient({ url: `${configured}/api/mcp`, headers: { 'X-API-Key': 'fixture-key' } });
    const outcome: unknown = await client.initialize().then(() => 'resolved', (error: unknown) => error);
    expect(seen).toEqual([]);
    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toMatch(/redirect/i);
  });
});
