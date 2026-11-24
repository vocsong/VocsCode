/** Runs the shipped stdio server and the real loopback listener. Only service data is faked. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type OutgoingHttpHeaders, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATEWAY_TOKEN_ENV, GATEWAY_URL_ENV, IntelligenceGateway, callIntelligenceTool, type GatewaySession, type IntelligenceGatewayDeps, type ToolResult } from '../src/main/intelligence/gateway';
import { MemoryStore } from '../src/main/intelligence/memory-store';
import { ProjectRegistry } from '../src/main/intelligence/registry';
import { IntelligenceService } from '../src/main/intelligence/service';
import { KnowledgeService } from '../src/main/knowledge/service';
import { withKnowledgeWriteLock } from '../resources/mcp/knowledge-write.mjs';
import type { AppSettings } from '../src/shared/types';

const cleanup: (() => Promise<unknown>)[] = [];
const waitOpts = { timeout: 5_000, interval: 10 };
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}
function error(message: string): ToolResult {
  return { ...ok(message), isError: true };
}
function latch() {
  let open!: () => void;
  const done = new Promise<void>((resolve) => { open = resolve; });
  return { open, done };
}

async function tmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs gateway '));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function session(id = 's1', extra: Partial<GatewaySession> = {}): GatewaySession {
  const projectRoot = path.resolve('fixture', id);
  return { sessionId: id, projectRoot, cwd: projectRoot, actions: ['read', 'record'], ...extra };
}

async function fixture(first = session(), call: IntelligenceGatewayDeps['call'] = async (context, name, args) => ok({ sessionId: context.sessionId, name, args })) {
  const sessions = new Map([[first.sessionId, first]]);
  const live = { enabled: true, now: Date.now() };
  const lookup = vi.fn((id: string) => sessions.get(id) ?? null);
  const dispatch = vi.fn(call);
  const log = vi.fn<IntelligenceGatewayDeps['log']>();
  const gateway = new IntelligenceGateway({ enabled: () => live.enabled, now: () => live.now, session: lookup, call: dispatch, log });
  await gateway.start();
  cleanup.push(() => gateway.close());
  const attach = (id = first.sessionId) => {
    const a = gateway.attach(id);
    if (!a) throw new Error('Fixture gateway did not issue an attachment');
    return a;
  };
  return { gateway, dispatch, log, lookup, live, sessions, attach, config: attach() };
}

type Attachment = { url: string; token: string };
const wire = (tool: string, args: Record<string, unknown> = {}) => JSON.stringify({ tool, arguments: args });
const statusCall = wire('knowledge_status');
function openRequest(config: Attachment, opts: { method?: string; path?: string; headers?: OutgoingHttpHeaders } = {}) {
  let req!: ReturnType<typeof request>;
  const response = new Promise<{ status: number; headers: IncomingHttpHeaders; text: string; json: { error?: string; result?: ToolResult } }>((resolve, reject) => {
    req = request(config.url, {
      method: opts.method ?? 'POST', ...(opts.path ? { path: opts.path } : {}), agent: false, signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}`, ...opts.headers }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, headers: res.headers, text, json: JSON.parse(text) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
  return { req, response };
}
async function post(config: Attachment, body = statusCall, opts?: Parameters<typeof openRequest>[1]) {
  const { req, response } = openRequest(config, opts);
  req.end(body);
  return response;
}

interface Reply {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}
const gatewayEnv = ({ url, token }: Attachment) => ({ [GATEWAY_URL_ENV]: url, [GATEWAY_TOKEN_ENV]: token });

async function spawnMemory(env: NodeJS.ProcessEnv, cwd: string) {
  // Replicate extraResources/mcp layout (including its sibling import) outside the source checkout.
  const resourceDir = path.join(await tmp(), 'resources', 'mcp');
  await fs.mkdir(resourceDir, { recursive: true });
  const sourceDir = process.env.VOCS_CODE_PACKAGED_MCP_DIR ?? path.resolve('resources', 'mcp');
  await Promise.all(['vocs-memory.mjs', 'knowledge-write.mjs'].map((name) => fs.copyFile(path.join(sourceDir, name), path.join(resourceDir, name))));
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^VOCS_MEMORY_/i.test(key)));
  const child = spawn(process.execPath, [path.join(resourceDir, 'vocs-memory.mjs')], { cwd, env: { ...childEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const replies: Reply[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => replies.push(JSON.parse(line) as Reply));
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
  });
  let nextId = 0;
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const begin = (method: string, params?: unknown) => { const id = ++nextId; send({ id, method, params }); return id; };
  const rpc = async (method: string, params?: unknown) => {
    const id = begin(method, params);
    return vi.waitFor(() => {
      const reply = replies.find((r) => r.id === id);
      if (!reply) throw new Error(`No stdio response to ${method}`);
      expect(reply.jsonrpc).toBe('2.0');
      return reply;
    }, waitOpts);
  };
  const tool = async (name: string, args?: Record<string, unknown>) => {
    const reply = await rpc('tools/call', { name, arguments: args });
    expect(reply.error).toBeUndefined();
    return reply.result as ToolResult;
  };
  return { rpc, tool, begin, send, replies, exit, end: () => child.stdin.end(), output: () => stdout + stderr };
}

async function loopback(listener: RequestListener) {
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const close = async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanup.push(close);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/call`, close };
}

const proposal = { title: 'Bounded writes', claim: 'A write belongs to its project.', body: 'Always resolve the project on the host.' };
const wideDenied = error('This session is not allowed to search collection memory.');
const gatewayDenied = error('The intelligence gateway denied this call. Restart the session to renew its authorization.');
const gatewayDown = error('The intelligence gateway is unavailable. Restart the session to reconnect.');

function core(knowledge: KnowledgeService) {
  const intelligence: Parameters<typeof callIntelligenceTool>[0]['intelligence'] = {
    historySearch: async (_ctx, query, opts) => ({ available: true, sessions: 1, results: [{ sessionId: 'older', session: 'A previous session', kind: 'user', at: null, snippet: `${query}:${opts?.limit}:${opts?.strict}` }] }),
    search: async (_ctx, req) => ({ query: req.query, intent: 'general', scope: { projectId: 'project', projectName: 'Project', collections: [] }, results: [], conflicts: [], missing: [] }),
    trace: async () => ({ source: 'none', nodes: [], edges: [], note: 'No relation.' }),
    compile: async (ctx, req) => ({ text: `# ${req.query}\n${ctx.sessionId} @ ${req.budgetTokens} tokens`, scope: { projectId: 'project', projectName: 'Project', collections: [] }, query: req.query, intent: 'general', sections: [], missing: [], conflicts: [], budgetTokens: 500, usedTokens: 10, truncated: false }),
    recall: async () => ({ records: [], history: [], note: 'No matches.' }),
    record: async () => ({ stored: 'memory', id: 'mem_a1', state: 'candidate', authority: 'candidate', note: 'Episode captured.' }),
    requestPromotion: async () => { throw new Error('Promotion was not granted'); },
    forget: async () => { throw new Error('Forget was not granted'); }
  };
  return { intelligence, knowledge };
}

function knowledgeForTests() {
  return new KnowledgeService({ log: () => {}, settings: () => ({}) as AppSettings });
}

describe('authenticated intelligence gateway', () => {
  it('rejects unauthenticated, browser-origin and malformed HTTP calls before dispatch', async () => {
    const { config, dispatch, log } = await fixture();
    const cases: [number, Parameters<typeof openRequest>[1], string?][] = [
      [401, { headers: { Authorization: '' } }],
      [401, { headers: { Authorization: `Bearer ${'A'.repeat(43)}` } }],
      [401, { headers: { Authorization: [`Bearer ${config.token}`, `Bearer ${config.token}`] } }],
      [403, { headers: { Host: 'localhost' } }],
      [403, { headers: { Origin: '' } }],
      [403, { headers: { 'Sec-Fetch-Site': 'same-origin' } }],
      [403, { path: '/call?x=y' }],
      [405, { method: 'GET' }, ''],
      [415, { headers: { 'Content-Type': 'application/jsonp' } }],
      [400, {}, '{'],
      [400, {}, 'null'],
      [400, {}, '["knowledge_status"]'],
      [400, {}, JSON.stringify({ tool: 'knowledge_status', arguments: {}, projectRoot: 'other' })],
      [400, {}, '{"tool":"knowledge_status","arguments":[]}'],
      [400, {}, wire('knowledge_search', { query: config.token })]
    ];
    for (const [status, opts, body] of cases) {
      const reply = await post(config, body, opts);
      expect(reply.status).toBe(status);
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
      expect(reply.text.includes(config.token)).toBe(false);
    }
    const oversized = 'x'.repeat(1_000_001);
    expect((await post(config, oversized, { headers: { 'Content-Length': oversized.length } })).status).toBe(413);
    const streamed = openRequest(config);
    streamed.req.write(oversized);
    streamed.req.end();
    expect((await streamed.response).status).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect((await post(config, statusCall, { headers: { 'Content-Type': 'application/json; charset=UTF-8' } })).json).toEqual({ result: ok({ sessionId: 's1', name: 'knowledge_status', args: {} }) });
  });

  it('requires advertised tools, exact argument schemas and an attenuated live grant', async () => {
    const bound = session('s1', { branch: 'work', allowCollections: true });
    const { gateway, config, sessions, attach, dispatch } = await fixture(bound);
    expect(gateway.attach('missing')).toBeNull();
    expect(attach().token === config.token).toBe(true);
    sessions.set('s2', session('s2', { actions: ['read'] }));
    const second = attach('s2');
    expect(second.token === config.token).toBe(false);
    expect((await post(second)).json).toEqual({ result: ok({ sessionId: 's2', name: 'knowledge_status', args: {} }) });
    expect(dispatch.mock.calls[0][0]).toEqual({ ...session('s2', { actions: ['read'] }), allowCollections: false, restricted: false });
    expect((await post(second, wire('knowledge_propose', proposal))).json.result).toEqual(error('This session is not allowed to record through the memory tools.'));
    sessions.get('s2')!.actions.push('record');
    sessions.get('s2')!.allowCollections = true;
    expect((await post(second, wire('knowledge_propose', proposal))).json.result).toEqual(error('This session is not allowed to record through the memory tools.'));
    expect((await post(second, wire('intelligence_search', { query: 'find it', scope: 'collection' }))).json.result).toEqual(wideDenied);
    for (const name of ['constructor', '__proto__', 'unknown']) expect((await post(config, wire(name))).json.result).toEqual(error('Unknown memory tool.'));
    const invalid = [
      wire('intelligence_search', { query: 'find it', projectId: 'another-project' }),
      wire('intelligence_search', { query: 'find it', scope: 'personal' }),
      wire('intelligence_search', { query: 'find it', sources: [] }),
      wire('intelligence_search', { query: 'find it', sources: ['unknown'] }),
      wire('knowledge_search', { query: 'find it', limit: '10' }),
      wire('knowledge_status', { sessionId: 's2' }),
      wire('knowledge_propose', { ...proposal, page_id: 'branches/not-this-branch/concept/hidden' }),
      wire('knowledge_propose', { ...proposal, sources: [{ type: 'commit', ref: 'HEAD', verified: true }] })
    ];
    for (const body of invalid) expect((await post(config, body)).json.result?.content[0].text).toMatch(/^Invalid arguments/);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const q = { query: 'find it', scope: 'collection' };
    expect((await post(config, wire('intelligence_search', q))).json.result).toEqual(ok({ sessionId: 's1', name: 'intelligence_search', args: q }));
    bound.allowCollections = false;
    bound.actions.splice(1);
    bound.restricted = true;
    expect((await post(config, wire('intelligence_search', q))).json.result).toEqual(wideDenied);
    expect((await post(config, wire('knowledge_propose', proposal))).json.result).toEqual(error('This session is not allowed to record through the memory tools.'));
    expect((await post(config, wire('session_history_search', { query: 'past attempt' }))).json.result).toEqual(error('This session is not allowed to search session history.'));
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('does not let revoked, expired, archived or moved sessions reuse an attachment', async () => {
    const original = session();
    const { gateway, config, live, lookup, sessions, dispatch, attach } = await fixture(original);
    // Hold an authenticated body in flight, then change the setting before its last chunk.
    lookup.mockClear();
    const pending = openRequest(config);
    pending.req.write('{"tool":');
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1), waitOpts);
    live.enabled = false;
    pending.req.end('"knowledge_status","arguments":{}}');
    expect((await pending.response).json).toEqual({ error: 'The intelligence gateway is switched off' });
    expect(gateway.attach('s1')).toBeNull();
    live.enabled = true;
    expect((await post(config)).status).toBe(401);

    let active = attach();
    live.now += 24 * 60 * 60 * 1_000;
    expect((await post(active)).status).toBe(401);
    const fresh = attach();
    expect(fresh.token === active.token).toBe(false);
    active = fresh;
    sessions.set('s1', { ...original, cwd: path.join(original.cwd, 'new-checkout'), branch: 'new-branch' });
    expect((await post(active)).status).toBe(403);
    sessions.set('s1', original);
    expect((await post(active)).status).toBe(401);
    active = attach();
    sessions.delete('s1');
    expect((await post(active)).status).toBe(403);
    sessions.set('s1', original);
    expect((await post(active)).status).toBe(401);
    active = attach();
    gateway.revoke('s1');
    expect((await post(active)).status).toBe(401);
    active = attach();
    await gateway.close();
    await gateway.start();
    expect((await post({ ...active, url: attach().url })).status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('aborts an in-flight grant on revocation and suppresses a late result even if the service ignores it', async () => {
    const release = latch();
    const { config, gateway, dispatch } = await fixture(session(), async () => { await release.done; return ok('late authorized-only data'); });
    const pending = post(config);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1), waitOpts);
    const signal = dispatch.mock.calls[0][3];
    expect(signal.aborted).toBe(false);
    gateway.revoke('s1');
    expect(signal.aborted).toBe(true);
    release.open();
    expect((await pending).json).toEqual({ error: 'Unauthorized' });
  });
});

describe('packaged vocs-memory MCP over stdio', () => {
  it('records a cited review-only draft behind the existing record grant, never a current page', async () => {
    const projectRoot = await tmp();
    const scope = { projectRoot, cwd: projectRoot };
    await fs.writeFile(path.join(projectRoot, 'retry.test.ts'), '// The fixture covers one initialization.');
    const log = () => undefined;
    const settings = () => ({}) as AppSettings;
    const knowledge = new KnowledgeService({ log, settings });
    const data = await tmp();
    const memory = new MemoryStore(data, { log });
    const registry = new ProjectRegistry(data, { log, facts: async () => ({}) });
    const intelligence = new IntelligenceService({ memory, registry, knowledge, log, settings, sessions: () => [] });
    const f = await fixture(session('s1', scope), (s, name, args, signal) => callIntelligenceTool({ knowledge, intelligence }, s, name, args, signal));
    const client = await spawnMemory(gatewayEnv(f.config), projectRoot);
    const branchArgs = { title: 'Retry initialization fence', claim: 'The retry initialization fence must not increment a second time.', body: 'Keep the initialization single-shot; the regression test documents the ordering.', kind: 'testing', draft: true, sources: [{ type: 'file', ref: 'retry.test.ts' }] };
    const send = (patch: Record<string, unknown> = {}) => client.tool('knowledge_record', { ...branchArgs, ...patch });
    await expect(send({ draft: 'yes' })).resolves.toMatchObject({ isError: true });
    await expect(send({ sources: [{ type: 'transcript', ref: 's1#a1' }] })).resolves.toMatchObject({ isError: true });
    await expect(send({ sources: [...branchArgs.sources, { type: 'transcript', ref: 's1#a1' }] })).resolves.toMatchObject({ isError: true });
    await expect(send({ sources: [{ type: 'file', ref: 'missing/retry.test.ts' }] })).resolves.toMatchObject({ isError: true });
    await expect(send({ sources: [{ type: 'file', ref: '../retry.test.ts' }] })).resolves.toMatchObject({ isError: true });
    await expect(send({ body: 'Do not store authorization: Bearer not-a-real-token-1234 in diagnostics.' })).resolves.toMatchObject({ isError: true });
    await expect(send({ page_id: 'concept/existing' })).resolves.toMatchObject({ isError: true });
    expect((await knowledge.view(scope)).proposals).toEqual([]);

    const result = JSON.parse((await send()).content[0].text);
    expect(result).toMatchObject({ stored: 'wiki', state: 'draft', authority: 'candidate', id: expect.any(String) });
    expect((await knowledge.view(scope)).proposals).toMatchObject([{ id: result.id, status: 'draft', claim: branchArgs.claim }]);
    await expect(client.tool('knowledge_read', { page: result.id })).resolves.toMatchObject({ isError: true });
    await expect(knowledge.digest(scope)).resolves.toBeNull();
    await expect(knowledge.publish(scope, [result.id])).resolves.toMatchObject({ written: [] });

    f.gateway.restrictToRead('s1');
    await expect(send({ claim: 'A Plan session cannot draft a second lesson.' })).resolves.toEqual(error('This session is not allowed to record through the memory tools.'));
    expect((await knowledge.view(scope)).proposals).toHaveLength(1);
  });

  it('lists compatible tools and returns exact gateway results with only gateway env and no wiki', async () => {
    const projectRoot = await tmp();
    const knowledge = knowledgeForTests();
    const services = core(knowledge);
    const scope = { projectRoot, cwd: projectRoot };
    const f = await fixture(session('s1', scope), (s, name, args, signal) => callIntelligenceTool(services, s, name, args, signal));
    const client = await spawnMemory(gatewayEnv(f.config), projectRoot);
    expect((await client.rpc('initialize', { protocolVersion: '2024-11-05' })).result).toMatchObject({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'vocs-memory' } });
    client.send({ method: 'notifications/initialized' });
    const { tools } = (await client.rpc('tools/list')).result as { tools: { name: string; annotations: Record<string, boolean>; inputSchema: { additionalProperties: boolean } }[] };
    expect(tools.map((t) => t.name)).toEqual(['knowledge_search', 'knowledge_read', 'knowledge_related', 'knowledge_propose', 'knowledge_status', 'session_history_search', 'intelligence_search', 'intelligence_trace', 'context_compile', 'memory_recall', 'knowledge_record', 'knowledge_promote', 'memory_forget']);
    expect(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)).toEqual(['knowledge_propose', 'knowledge_record', 'knowledge_promote', 'memory_forget']);
    expect(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name)).toEqual(['knowledge_propose', 'knowledge_record', 'memory_forget']);
    expect(tools.every((t) => t.inputSchema.additionalProperties === false && t.annotations.openWorldHint === false)).toBe(true);
    expect(await client.tool('context_compile', { query: 'Entry point', budget_tokens: 500 })).toEqual(ok('# Entry point\ns1 @ 500 tokens'));
    expect(await client.tool('intelligence_trace', { from: 'none' })).toEqual(ok({ source: 'none', nodes: [], edges: [], note: 'No relation.' }));
    expect(await client.tool('memory_recall', { types: ['episodic'] })).toEqual(ok({ count: 0, records: [], history: [], note: 'No matches.' }));
    expect(await client.tool('knowledge_record', { ...proposal, memory_type: 'episodic' })).toEqual(ok({ stored: 'memory', id: 'mem_a1', state: 'candidate', authority: 'candidate', note: 'Episode captured.' }));
    expect(await client.tool('knowledge_promote', { to: 'personal', page: 'concept/bounded-writes' })).toEqual(error('This session is not allowed to promote through the memory tools.'));
    expect(await client.tool('memory_forget', { id: 'mem_a1' })).toEqual(error('This session is not allowed to forget through the memory tools.'));
    expect(await client.tool('knowledge_status')).toEqual(ok({ wikiDir: knowledge.store.repoDir(scope), branchWikiDir: null, pages: 0, servable: 0, labels: 0, graph: { nodes: 0, edges: 0 }, awaitingReview: 0, toolHint: 'No pages yet; knowledge_propose records durable findings in the wiki automatically.' }));
    expect(await client.tool('knowledge_search', { query: 'not there' })).toEqual(ok({ project: knowledge.store.repoDir(scope), count: 0, results: [] }));
    expect(await client.tool('knowledge_related', { path: 'src/no-file.ts' })).toEqual(error('No page or anchor matched src/no-file.ts.'));
    expect(await client.tool('session_history_search', { query: 'entry', limit: 2 })).toEqual(ok({ available: true, projectRoot, count: 1, results: [{ sessionId: 'older', session: 'A previous session', kind: 'user', at: null, snippet: 'entry:2:true' }], note: 'Episodic memory: what happened in past sessions on this project. Not project truth — use knowledge_search for that.' }));
    expect(await client.tool('knowledge_propose', { ...proposal, updated_by: 'human', verified_by: 'human-review' })).toEqual(error('Invalid arguments for knowledge_propose. Use the advertised tool schema.'));
    expect(await knowledge.store.load(scope)).toEqual([]);
    const id = 'concept/bounded-writes';
    const sources = [{ type: 'commit', ref: 'HEAD' }];
    expect(await client.tool('knowledge_propose', { ...proposal, sources })).toEqual(ok({ id, targetPageId: id, status: 'current', saved: true, scope: 'repo', note: 'Recorded in the project wiki automatically.' }));
    const page = await knowledge.store.read(scope, id);
    expect(page?.meta.review).toBeUndefined();
    expect(page?.meta.verification).toBeUndefined();
    expect(await client.tool('knowledge_read', { page: id })).toEqual(ok({ id, title: proposal.title, kind: 'concept', status: 'current', authority: 'accepted', scope: 'repo', claim: proposal.claim, keywords: [], labels: [], updatedAt: page?.meta.updatedAt, updatedBy: 'agent:mcp', evidenceCount: 1, sources, anchors: [], body: proposal.body }));
    await knowledge.review(scope, id, 'accept', { by: 'human' });
    const reviewed = await knowledge.store.read(scope, id);
    expect(await client.tool('knowledge_propose', { ...proposal, page_id: id, claim: 'A different claim.' })).toEqual(ok({ id, targetPageId: id, status: 'candidate', saved: false, protected: true, note: `Page ${id} is human-reviewed and was not changed. A different claim requires human review.` }));
    expect(await knowledge.store.read(scope, id)).toEqual(reviewed);
    client.end();
    await expect(client.exit).resolves.toEqual([0, null]);
    expect(client.output().includes(f.config.token)).toBe(false);
  });

  it('never falls back to disk on gateway denial or outage; a separately launched legacy server still reads the wiki', async () => {
    const projectRoot = await tmp();
    const knowledge = knowledgeForTests();
    const scope = { projectRoot, cwd: projectRoot };
    await knowledge.propose(scope, proposal, 'agent:fixture');
    const wiki = knowledge.store.repoDir(scope);
    const id = 'concept/bounded-writes';
    const f = await fixture(session('s1', { ...scope, actions: ['read'] }));
    const legacy = await spawnMemory({ VOCS_MEMORY_ROOT: wiki }, projectRoot);
    const list = await legacy.rpc('tools/list');
    expect((list.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['knowledge_search', 'knowledge_read', 'knowledge_related', 'knowledge_propose', 'knowledge_status', 'session_history_search']);
    expect(JSON.parse((await legacy.tool('knowledge_read', { page: id })).content[0].text).body).toBe(proposal.body);
    const fakedDiskConfig = { VOCS_MEMORY_ROOT: wiki, ...gatewayEnv(f.config) };
    const required = await spawnMemory(fakedDiskConfig, projectRoot);
    expect(await required.tool('knowledge_propose', proposal)).toEqual(error('This session is not allowed to record through the memory tools.'));
    f.gateway.revoke('s1');
    expect(await required.tool('knowledge_read', { page: id })).toEqual(gatewayDenied);
    expect(await required.tool('knowledge_propose', proposal)).toEqual(gatewayDenied);
    await f.gateway.close();
    expect(await required.tool('knowledge_read', { page: id })).toEqual(gatewayDown);
    expect(await required.tool('knowledge_propose', proposal)).toEqual(gatewayDown);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect((await knowledge.store.read(scope, id))?.meta.evidenceCount).toBe(1);
    expect(required.output().includes(f.config.token)).toBe(false);
  });

  it.each(['wiki root', 'nested directory'])('does not follow a linked %s in standalone mode', async (location) => {
    const projectRoot = await tmp();
    const outside = await tmp();
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const linkTarget = location === 'wiki root' ? wiki : path.join(wiki, 'concept');
    await fs.mkdir(path.dirname(linkTarget), { recursive: true });
    await fs.symlink(outside, linkTarget, process.platform === 'win32' ? 'junction' : 'dir');
    const client = await spawnMemory({ VOCS_MEMORY_ROOT: wiki, VOCS_MEMORY_PROJECT_ROOT: projectRoot }, projectRoot);
    expect(await client.tool('knowledge_propose', proposal)).toEqual(error('Refusing to write through a linked wiki path.'));
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('uses the exact branch name rather than treating a legacy branch directory as a grant', async () => {
    const projectRoot = await tmp();
    const scope = { projectRoot, cwd: projectRoot, branch: 'topic/working' };
    const knowledge = knowledgeForTests();
    const id = 'concept/branch-note';
    await knowledge.propose(scope, { ...proposal, pageId: id, scope: 'branch' }, 'agent:fixture');
    const wiki = knowledge.store.repoDir(scope);
    const branchRoot = knowledge.store.branchDir(scope)!;
    const env = { VOCS_MEMORY_ROOT: wiki, VOCS_MEMORY_PROJECT_ROOT: projectRoot, VOCS_MEMORY_BRANCH_ROOT: branchRoot };
    const expected = await spawnMemory({ ...env, VOCS_MEMORY_BRANCH: scope.branch }, projectRoot);
    expect(JSON.parse((await expected.tool('knowledge_read', { page: id })).content[0].text).body).toBe(proposal.body);
    const different = await spawnMemory({ ...env, VOCS_MEMORY_BRANCH: 'topic-working' }, projectRoot);
    expect(await different.tool('knowledge_read', { page: id })).toEqual(error(`No knowledge page "${id}". Use knowledge_search first.`));
    expect(await different.tool('knowledge_propose', { ...proposal, page_id: id, body: 'wrong branch' })).toEqual(error(`Cannot update invalid or out-of-scope knowledge page "${id}".`));
    expect((await knowledge.store.read(scope, id))?.body).toBe(proposal.body);
  });

  it('fails startup on partial, empty and non-loopback gateway configuration without exposing credentials', async () => {
    const projectRoot = await tmp();
    const wiki = path.join(projectRoot, 'any-wiki');
    const { config } = await fixture();
    for (const env of [
      { [GATEWAY_URL_ENV]: config.url },
      { [GATEWAY_TOKEN_ENV]: config.token },
      { [GATEWAY_URL_ENV]: '', [GATEWAY_TOKEN_ENV]: '' },
      { ...gatewayEnv(config), [GATEWAY_TOKEN_ENV]: 'a bad token' },
      { ...gatewayEnv(config), [GATEWAY_URL_ENV]: config.url.replace('127.0.0.1', 'localhost') },
      { ...gatewayEnv(config), [GATEWAY_URL_ENV]: `${config.url}?secret=${config.token}` }
    ]) {
      const client = await spawnMemory({ VOCS_MEMORY_ROOT: wiki, ...env }, projectRoot);
      await expect(client.exit).resolves.toEqual([1, null]);
      expect(client.output()).toMatch(/Invalid intelligence gateway configuration/);
      expect(client.output().includes(config.token)).toBe(false);
    }
  });

  it('does not forward authorization on redirects, trust malformed replies, or echo errors and secrets', async () => {
    const projectRoot = await tmp();
    const f = await fixture(session(), async (_s, tool) => {
      if (tool === 'knowledge_search') throw new Error(`unsafe exception ${f.config.token}`);
      return ok(`echo ${f.config.token}`);
    });
    const client = await spawnMemory(gatewayEnv(f.config), projectRoot);
    expect(await client.tool('knowledge_search', { query: 'valid' })).toEqual(error('The intelligence gateway could not complete the tool call.'));
    expect(await client.tool('knowledge_status')).toEqual(ok('echo <redacted>'));
    expect(client.output().includes(f.config.token)).toBe(false);
    expect(JSON.stringify(f.log.mock.calls).includes(f.config.token)).toBe(false);
    const hits = vi.fn();
    const destination = await loopback((req, res) => { hits(req.headers.authorization); res.end(); });
    let mode: 'redirect' | 'malformed' | 'echo' = 'redirect';
    const responder = await loopback((_req, res) => {
      if (mode === 'redirect') res.writeHead(307, { Location: destination.url }).end();
      else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result: mode === 'echo' ? ok(`echo ${f.config.token}`) : { content: [{ type: 'image', data: f.config.token }] } }));
    });
    const proxy = await spawnMemory(gatewayEnv({ url: responder.url, token: f.config.token }), projectRoot);
    expect(await proxy.tool('knowledge_status')).toEqual(gatewayDown);
    expect(hits).not.toHaveBeenCalled();
    mode = 'malformed';
    expect(await proxy.tool('knowledge_status')).toEqual(gatewayDown);
    mode = 'echo';
    expect(await proxy.tool('knowledge_status')).toEqual(ok('echo <redacted>'));
    expect(proxy.output().includes(f.config.token)).toBe(false);
  });

  it('cancels an already dispatched request and EOF disconnect without replying or leaving a queued wiki write', async () => {
    const projectRoot = await tmp();
    const scope = { projectRoot, cwd: projectRoot };
    const services = core(knowledgeForTests());
    const release = latch();
    const locked = latch();
    const lock = withKnowledgeWriteLock(services.knowledge.store.repoDir(scope), async () => { locked.open(); await release.done; });
    cleanup.push(async () => { release.open(); await lock; });
    await locked.done;
    const finished = latch();
    const f = await fixture(session('s1', scope), async (session, name, args, signal) => {
      try { return await callIntelligenceTool(services, session, name, args, signal); }
      finally { if (name === 'knowledge_propose') finished.open(); }
    });
    const client = await spawnMemory(gatewayEnv(f.config), projectRoot);
    try {
      client.send({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: proposal } }); // No request id: must not run.
      const id = client.begin('tools/call', { name: 'knowledge_propose', arguments: proposal });
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1), waitOpts);
      const signal = f.dispatch.mock.calls[0][3];
      client.send({ method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled by host' } });
      await vi.waitFor(() => expect(signal.aborted).toBe(true), waitOpts);
      release.open();
      await finished.done;
      expect((await client.rpc('ping')).result).toEqual({});
      expect(client.replies.some((msg) => msg.id === id)).toBe(false);
      expect(await services.knowledge.store.load(scope)).toEqual([]);
      expect(f.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      release.open();
      await lock;
    }
    const backend = latch();
    const eof = await fixture(session('s2'), async () => { await backend.done; return ok('late data'); });
    const next = await spawnMemory(gatewayEnv(eof.config), projectRoot);
    next.begin('tools/call', { name: 'knowledge_status' });
    try {
      await vi.waitFor(() => expect(eof.dispatch).toHaveBeenCalledTimes(1), waitOpts);
      next.end();
      await vi.waitFor(() => expect(eof.dispatch.mock.calls[0][3].aborted).toBe(true), waitOpts);
      await expect(next.exit).resolves.toEqual([0, null]);
      expect(next.replies).toEqual([]);
    } finally { backend.open(); }
  });
});
