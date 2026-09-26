import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissionToolBroker, missionToolDefinitions, type MissionToolBinding, type MissionToolHost } from '../src/main/mission/tools';

const brokers: MissionToolBroker[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});
const lead: MissionToolBinding = { missionId: 'mission-a', actor: { kind: 'lead', sessionId: 'lead-a', generation: 1 } };
const worker: MissionToolBinding = { missionId: 'mission-a', actor: { kind: 'worker', sessionId: 'worker-a', generation: 1, attemptId: 'attempt-a' } };
async function setup(binding = lead) {
  const validate = vi.fn(async () => undefined);
  const invoke = vi.fn<MissionToolHost['invoke']>(async (actor: MissionToolBinding, name: string) => ({ actor, operation: name }));
  const broker = new MissionToolBroker({ validate, invoke });
  brokers.push(broker);
  await Promise.all([broker.start(), broker.start()]);
  const server = broker.attach(binding);
  const rpc = (name: string, args: unknown, extra: Record<string, string> = {}) => fetch(server.def.url!, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...server.def.headers, ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return { broker, server, invoke, validate, rpc };
}

describe('scoped Mission MCP transport', () => {
  it('handshakes with the actual MCP client and binds operations to its host-created actor', async () => {
    const { server, invoke } = await setup();
    expect(server.secretHeaderKeys).toEqual(['Authorization']);
    const client = new Client({ name: 'mission-test', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.def.url!), { requestInit: { headers: server.def.headers } }));
    const listed = await client.listTools();
    expect(listed.tools.some((tool) => tool.name === 'mission_task_delegate')).toBe(true);
    expect(listed.tools.some((tool) => /authorize|replace_lead|pause|stop/.test(tool.name))).toBe(false);
    const result = await client.callTool({ name: 'mission_read', arguments: { payload: {} } });
    expect(result.isError).toBe(false);
    expect(invoke).toHaveBeenCalledWith(lead, 'mission_read', { payload: {} });
  });

  it('publishes the actual required plan/profile contracts rather than undocumented generic objects', async () => {
    const { server } = await setup();
    const client = new Client({ name: 'mission-schema-test', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.def.url!), { requestInit: { headers: server.def.headers } }));
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'mission_plan_update')?.inputSchema).toMatchObject({ properties: { payload: {
      additionalProperties: false, required: expect.arrayContaining(['expectedPlanRevision', 'plan']),
      properties: { plan: { required: expect.arrayContaining(['objective', 'criteria', 'assumptions']) } },
    } } });
    expect(tools.find((t) => t.name === 'mission_profile_upsert')?.inputSchema).toMatchObject({ properties: { payload: {
      required: ['profile'], properties: { profile: { required: expect.arrayContaining(['id', 'revision', 'tierId', 'sourceAccess']) } },
    } } });
    expect(JSON.stringify(tools.find((t) => t.name === 'mission_profile_upsert')?.inputSchema)).not.toContain('host.operation');
  });

  it('delivers retained attachments as real MCP images without duplicating base64 in text metadata', async () => {
    const { server, invoke } = await setup();
    const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'design.png' };
    invoke.mockResolvedValue({ kind: 'source_image', image });
    const client = new Client({ name: 'mission-image-test', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.def.url!), { requestInit: { headers: server.def.headers } }));
    const result = await client.callTool({ name: 'mission_context_read', arguments: { payload: { ref: 'source-blob', imageIndex: 0 } } });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ kind: 'source_image', mimeType: image.mimeType, name: image.name }) }, { type: 'image', mimeType: image.mimeType, data: image.data }]);
    expect(JSON.stringify(result.structuredContent)).not.toContain(image.data);
    expect(invoke).toHaveBeenCalledWith(lead, 'mission_context_read', { payload: { ref: 'source-blob', imageIndex: 0 } });
  });

  it('rejects worker lead-only calls even when the hidden operation name is supplied directly', async () => {
    const { rpc, invoke } = await setup(worker);
    expect(missionToolDefinitions('worker').some((tool) => tool.name === 'mission_task_delegate')).toBe(false);
    const response = await rpc('mission_task_delegate', { expectedRevision: 1, idempotencyKey: 'request', payload: { taskId: 'other' } });
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('principal engineer') } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['missionId', 'actor', 'sessionId', 'generation', 'authorization', 'sourceUserActionId'])('denies a model-supplied %s authority claim before dispatch', async (key) => {
    const { rpc, invoke } = await setup(worker);
    const response = await rpc('mission_report', { expectedRevision: 1, idempotencyKey: 'request', payload: { [key]: 'spoofed' } });
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('authority') } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requires idempotency and expected revision for mutations; read calls need neither', async () => {
    const { rpc, invoke } = await setup();
    expect(await (await rpc('mission_question_ask', { payload: {} })).json()).toMatchObject({ error: { message: expect.stringContaining('requires') } });
    expect(invoke).not.toHaveBeenCalled();
    expect(await (await rpc('mission_read', { payload: {} })).json()).toHaveProperty('result');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('revokes a stopped/replaced generation without affecting another session connection', async () => {
    const { broker, rpc, invoke, server } = await setup();
    const other = broker.attach({ missionId: 'other', actor: { kind: 'lead', sessionId: 'other-lead', generation: 1 } });
    broker.revoke('mission-a', 'lead-a');
    expect((await rpc('mission_read', { payload: {} })).status).toBe(401);
    expect(invoke).not.toHaveBeenCalled();
    const response = await fetch(other.def.url!, { method: 'POST', headers: { 'Content-Type': 'application/json', ...other.def.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    expect(response.status).toBe(200);
    expect((await response.json()).result.tools).not.toHaveLength(0);
    expect(server.def.headers).not.toEqual(other.def.headers);
  });

  it('rechecks live host authority and rejects browser-origin/dns-rebinding requests', async () => {
    const { rpc, invoke, validate, server } = await setup();
    expect((await rpc('mission_read', { payload: {} }, { Origin: 'http://localhost' })).status).toBe(403);
    // fetch normalizes Host to the URL, so use the actual HTTP wire boundary for rebinding.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(server.def.url!, { method: 'POST', headers: { Host: 'attacker.example', 'Content-Type': 'application/json', ...server.def.headers } }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });
    expect(status).toBe(403);
    validate.mockRejectedValueOnce(new Error('stale generation'));
    expect((await rpc('mission_read', { payload: {} })).status).toBe(403);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not expose unknown/user-only operations or a generic IPC invoke escape hatch', async () => {
    const { rpc, invoke } = await setup();
    for (const name of ['missions:create', 'mission_execution_authorize', 'sessions:send', 'constructor', '__proto__']) {
      expect(await (await rpc(name, { expectedRevision: 1, idempotencyKey: 'x', payload: {} })).json()).toMatchObject({ error: { message: 'Unknown Mission operation' } });
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});
