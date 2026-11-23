/** Per-call cancellation through real stdio/HTTP transports and the shared Pi extension. */
import { getEventListeners } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiMcpConnection, type PiMcpServerConfig } from '../resources/pi/mcp-client';
import { closeMcpBridge, registerMcpTools, type McpBridgeTool } from '../resources/pi/vocs-code-mcp';

interface Rpc {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown>; requestId?: number };
}

const stdioScript = `
  const readline = require('node:readline');
  const calls = [], cancellations = [], held = [];
  const reply = (id, result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result, error }) + '\\n');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'notifications/cancelled') { cancellations.push(request.params); return; }
    if (request.id === undefined) return;
    if (request.method === 'initialize') { reply(request.id, { protocolVersion: '2024-11-05', capabilities: {} }); return; }
    if (request.method === 'tools/list') { reply(request.id, { tools: ['work', 'probe'].map(name => ({ name, inputSchema: { type: 'object' } })) }); return; }
    calls.push({ id: request.id, ...request.params });
    if (request.params.name === 'probe') {
      if (request.params.arguments.release) for (const id of held.splice(0)) reply(id, { content: [{ type: 'text', text: 'late' }] });
      reply(request.id, { content: [{ type: 'text', text: JSON.stringify({ calls, cancellations }) }] });
    } else if (request.params.arguments.fail) reply(request.id, undefined, { code: -32602, message: 'fixture failure' });
    else if (request.params.arguments.hold) held.push(request.id);
    else reply(request.id, { content: [{ type: 'text', text: 'done' }] });
  });
`;

function stdioConfig(): PiMcpServerConfig {
  return { id: 'cancel-fixture', transport: 'stdio', command: process.execPath, args: ['-e', stdioScript], timeoutMs: 60_000 };
}

/** A hang must fail this assertion promptly, not wait for the client's normal sixty-second timer. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Cancellation did not settle within one second')), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function httpFixture(mode: 'headers' | 'body' = 'headers', mission = false) {
  const seen: Rpc[] = [];
  const held = new Map<number, ServerResponse>();
  const closed: number[] = [];
  const writeResult = (res: ServerResponse, id: number, text: string) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    if (mode === 'body' && res.headersSent) res.end(`data: ${body}\n\n`);
    else res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Rpc;
    seen.push(request);
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    if (request.method === 'tools/call') {
      if (request.params?.arguments?.hold) {
        held.set(request.id, res);
        res.on('close', () => closed.push(request.id!));
        if (mode === 'body') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: message\n');
        }
      } else writeResult(res, request.id, 'done');
      return;
    }
    const result = request.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cancel-fixture', version: '1' } }
      : { tools: (mission ? ['mission_report', 'mission_read'] : ['work', 'probe']).map((name) => ({ name, inputSchema: { type: 'object' } })) };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const def: PiMcpServerConfig = {
    id: mission ? 'vocs-mission' : 'cancel-fixture', transport: 'http',
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, timeoutMs: 60_000,
    ...(mission ? { headers: { Authorization: 'Bearer fixture-mission-capability' } } : {})
  };
  return {
    def, seen, held, closed,
    release(id: number) { writeResult(held.get(id)!, id, 'released'); },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

afterEach(() => {
  closeMcpBridge();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Pi MCP stdio cancellation', () => {
  it('never dispatches a call whose signal was already aborted', async () => {
    const connection = await PiMcpConnection.connect(stdioConfig());
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(bounded(connection.callTool('work', {}, controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
      const probe = await connection.callTool('probe', {});
      const observed = JSON.parse(probe.content[0].text!);
      expect(observed.calls.map((call: { name: string }) => call.name)).toEqual(['probe']);
      expect(observed.cancellations).toEqual([]);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally { connection.close(); }
  });

  it('cancels only its request, clears its listener/timer, notifies once and ignores the late response', async () => {
    const connection = await PiMcpConnection.connect(stdioConfig());
    const controller = new AbortController();
    const siblingController = new AbortController();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    let settlements = 0;
    try {
      const cancelled = connection.callTool('work', { hold: true }, controller.signal);
      const cancelledTimer = timers.mock.results[0].value;
      void cancelled.then(() => settlements++, () => settlements++);
      const sibling = connection.callTool('work', { hold: true }, siblingController.signal);
      void sibling.catch(() => {});
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
      controller.abort();
      await expect(bounded(cancelled)).rejects.toMatchObject({ name: 'AbortError' });
      expect(clear).toHaveBeenCalledWith(cancelledTimer);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(getEventListeners(siblingController.signal, 'abort')).toHaveLength(1);
      const probe = await connection.callTool('probe', { release: true });
      const observed = JSON.parse(probe.content[0].text!);
      const work = observed.calls.filter((call: { name: string }) => call.name === 'work');
      expect(work).toHaveLength(2);
      expect(observed.cancellations).toEqual([{ requestId: work[0].id, reason: expect.any(String) }]);
      await expect(sibling).resolves.toMatchObject({ content: [{ type: 'text', text: 'late' }], isError: false });
      expect(getEventListeners(siblingController.signal, 'abort')).toHaveLength(0);
      await expect(connection.callTool('work', {})).resolves.toMatchObject({ content: [{ type: 'text', text: 'done' }] });
      expect(settlements).toBe(1);
    } finally { connection.close(); }
  });

  it.each(['success', 'rpc-error', 'send-error', 'timeout', 'close'] as const)('cleans up the signal after %s without sending a spurious cancellation', async (outcome) => {
    const connection = await PiMcpConnection.connect(stdioConfig());
    const controller = new AbortController();
    try {
      // Fake only the request timer: stdio delivery still uses real OS events.
      if (outcome === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const args = outcome === 'send-error'
        ? { get invalid() { throw new Error('fixture serialization failed'); } }
        : { hold: outcome === 'timeout' || outcome === 'close', fail: outcome === 'rpc-error' };
      const call = connection.callTool('work', args, controller.signal);
      const assertion = outcome === 'success'
        ? expect(call).resolves.toMatchObject({ isError: false })
        : expect(call).rejects.toThrow(outcome === 'timeout' ? 'timed out' : outcome === 'close' ? 'closed' : outcome === 'send-error' ? 'fixture serialization failed' : 'fixture failure');
      if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(60_000);
      if (outcome === 'close') { await connection.callTool('probe', {}); connection.close(); }
      await assertion;
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      controller.abort();
      if (outcome !== 'close') {
        vi.useRealTimers();
        const probe = await connection.callTool('probe', {});
        expect(JSON.parse(probe.content[0].text!).cancellations).toEqual([]);
      }
    } finally { vi.useRealTimers(); connection.close(); }
  });
});

describe('Pi MCP HTTP cancellation', () => {
  it('never sends an already-aborted call', async () => {
    const fixture = await httpFixture();
    const connection = await PiMcpConnection.connect(fixture.def);
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(bounded(connection.callTool('work', {}, controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
      await connection.callTool('probe', {});
      expect(fixture.seen.filter((request) => request.method === 'tools/call').map((request) => request.params?.name)).toEqual(['probe']);
      expect(fixture.seen.filter((request) => request.method === 'notifications/cancelled')).toEqual([]);
    } finally { connection.close(); await fixture.close(); }
  });

  it.each(['headers', 'body'] as const)('aborts the cancelled fetch while awaiting %s, not its pending sibling or the shared connection', async (mode) => {
    const fixture = await httpFixture(mode);
    const connection = await PiMcpConnection.connect(fixture.def);
    const controller = new AbortController();
    try {
      const cancelled = connection.callTool('work', { hold: true, owner: 'cancelled' }, controller.signal);
      const sibling = connection.callTool('work', { hold: true, owner: 'sibling' });
      // Attach failure handlers immediately even if a pre-fix assertion fails and closes the fixture.
      void cancelled.catch(() => {});
      void sibling.catch(() => {});
      await vi.waitFor(() => expect(fixture.held.size).toBe(2));
      const calls = fixture.seen.filter((request) => request.method === 'tools/call');
      const cancelledId = calls.find((request) => request.params?.arguments?.owner === 'cancelled')!.id!;
      const siblingId = calls.find((request) => request.params?.arguments?.owner === 'sibling')!.id!;
      controller.abort();
      await expect(bounded(cancelled)).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => {
        expect(fixture.closed).toEqual([cancelledId]);
        expect(fixture.seen.filter((request) => request.method === 'notifications/cancelled')).toEqual([
          { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelledId, reason: expect.any(String) } }
        ]);
      });
      fixture.release(siblingId);
      await expect(bounded(sibling)).resolves.toMatchObject({ content: [{ type: 'text', text: 'released' }], isError: false });
      await expect(connection.callTool('probe', {})).resolves.toMatchObject({ content: [{ type: 'text', text: 'done' }] });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally { connection.close(); await fixture.close(); }
  });
});

describe('Pi bridge execute cancellation', () => {
  it.each([false, true])('propagates the third execute argument across shared sessions without wrapping abort as a Mission failure (managed=%s)', async (mission) => {
    const fixture = await httpFixture('headers', mission);
    const root = await mkdtemp(path.join(tmpdir(), 'vocs-pi-mcp-cancel-'));
    const config = path.join(root, 'mcp.json');
    if (mission) {
      vi.stubEnv('VOCS_CODE_MCP_CONFIG', '');
      vi.stubEnv('VOCS_CODE_MISSION_POLICY', JSON.stringify({ role: 'lead', sourceAccess: 'read_only', requestedTools: [] }));
      vi.stubEnv('VOCS_CODE_MCP_EPHEMERAL', JSON.stringify({ servers: [fixture.def] }));
    } else {
      await writeFile(config, JSON.stringify({ servers: [fixture.def] }));
      vi.stubEnv('VOCS_CODE_MCP_CONFIG', config);
    }
    const parent: McpBridgeTool[] = [], child: McpBridgeTool[] = [];
    const controller = new AbortController();
    try {
      await registerMcpTools({ registerTool: (tool) => parent.push(tool as McpBridgeTool), on() {} });
      await registerMcpTools({ registerTool: (tool) => child.push(tool as McpBridgeTool), on() {} });
      const name = mission ? 'mission_report' : 'mcp__cancel_fixture__work';
      const parentTool = parent.find((tool) => tool.name === name)!;
      const childTool = child.find((tool) => tool.name === name)!;
      expect(parentTool).toBe(childTool);
      const cancelled = parentTool.execute('parent', { hold: true, owner: 'parent' }, controller.signal);
      const sibling = childTool.execute('child', { hold: true, owner: 'child' }, new AbortController().signal);
      void cancelled.catch(() => {});
      void sibling.catch(() => {});
      await vi.waitFor(() => expect(fixture.held.size).toBe(2));
      controller.abort();
      await expect(bounded(cancelled)).rejects.toMatchObject({ name: 'AbortError' });
      const calls = fixture.seen.filter((request) => request.method === 'tools/call');
      fixture.release(calls.find((request) => request.params?.arguments?.owner === 'child')!.id!);
      await expect(bounded(sibling)).resolves.toMatchObject({ content: [{ type: 'text', text: 'released' }] });
      await expect(childTool.execute('already-aborted', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      await expect(childTool.execute('after-cancellation', {})).resolves.toMatchObject({ content: [{ type: 'text', text: 'done' }] });
      expect(fixture.seen.filter((request) => request.method === 'initialize')).toHaveLength(1);
      expect(fixture.seen.filter((request) => request.method === 'tools/call')).toHaveLength(3);
    } finally { closeMcpBridge(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
  });
});
