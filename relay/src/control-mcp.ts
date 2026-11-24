/** Stateless JSON MCP. One SDK server/transport per HTTP request: no session ids, SSE, replay
 *  store, cloud conversation state, arbitrary IPC, or account-wide mutable selected computer. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { CONTROL_HARNESSES, CONTROL_REQUIRED_SCOPE, CONTROL_VERSION, controlErrorCode, controlIdSchema, controlParams, type ControllerPrincipal, type ControlMethod } from '../../src/shared/control';
import type { RelayStore } from './core';
import type { HubSocket } from './hub';
import { FixedWindowLimiter } from './rate';
import { consumeControlNonce, ControlHttpError, controlHttpError, controlJson, readControlBytes, verifyControllerAssertion } from './control-auth';
import { ControlHostBridge } from './control-host';

export const CONTROL_MAX_HTTP = 16;
export const CONTROL_MAX_CONTROLLER_HTTP = 4;
const encoder = new TextEncoder();
const hostIdSchema = z.string().min(1).max(200).regex(/^h_[A-Za-z0-9_.-]+$/);
const rpcSchema = z.strictObject({
  jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number().int().safe()]).optional(),
  method: z.string().max(100), params: z.unknown().optional()
});
const toolCallSchema = z.strictObject({ name: z.string().max(100), arguments: z.unknown().optional(), _meta: z.record(z.string(), z.unknown()).optional() });
const methods = Object.keys(controlParams) as ControlMethod[];
export const CONTROL_TOOL_NAMES = ['computers_list', ...methods.map((method) => method.replaceAll('.', '_'))];
// Scope alone is not a read-only policy: it also authorizes windows.create in the legacy API.
const discoveryMethods = ['capabilities', 'projects.list', 'sessions.list', 'sessions.get'] as const;
const methodForTool = (allowed: readonly ControlMethod[]) => new Map(allowed.map((method) => [method.replaceAll('.', '_'), method]));
const fullTools = methodForTool(methods);
const discoveryTools = methodForTool(discoveryMethods);
const discoverySession = z.object({ id: controlIdSchema, title: z.string().transform((v) => v.slice(0, 160)),
  status: z.enum(['idle', 'starting', 'running', 'awaiting', 'error', 'stopped', 'pr', 'merged']), harness: z.enum(CONTROL_HARNESSES) });
const nextOffset = z.number().int().safe().nonnegative().nullable();
// Project/host selection is still desktop-owned. Rebuild the public discovery shape so adding
// a field to the old controller or its desktop replies cannot expose it through this preview.
const discoveryResults = {
  capabilities: z.object({ version: z.literal(CONTROL_VERSION), instanceId: z.string().uuid(),
    methods: z.array(z.string()).max(64).default([]).transform((list) => discoveryMethods.filter((m) => list.includes(m))) }),
  'projects.list': z.object({ items: z.array(z.object({ id: controlIdSchema, name: z.string().transform((v) => v.slice(0, 256)) })).max(100), nextOffset }),
  'sessions.list': z.object({ items: z.array(discoverySession).max(100), nextOffset }),
  'sessions.get': discoverySession
} satisfies Record<typeof discoveryMethods[number], z.ZodType>;
type Channel = 'internal' | 'discovery';
const toolSchema = (method: ControlMethod) => controlParams[method].extend({ hostId: hostIdSchema });
const rpcError = (id: string | number | undefined, code: number, message: string) => controlJson({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, 400);

export class ControlMcpGateway<S extends HubSocket> {
  private active = 0;
  private readonly controllers = new Map<string, number>();
  private readonly rate = new FixedWindowLimiter(Date.now, 1024);

  constructor(private readonly store: RelayStore, private readonly hosts: ControlHostBridge<S>) {}

  async handle(request: Request, accountId: string, secret: string | undefined, channel: Channel = 'internal'): Promise<Response> {
    const allowed = channel === 'discovery' ? discoveryTools : fullTools;
    let controllerId: string | undefined;
    const lifetime = new AbortController();
    const abort = () => lifetime.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    try {
      const body = await readControlBytes(request);
      const assertion = await verifyControllerAssertion(request, body, secret, channel);
      if (!assertion || assertion.principal.accountId !== accountId) throw new ControlHttpError(401, 'invalid_controller_assertion');
      const count = this.controllers.get(assertion.principal.controllerId) ?? 0;
      if (this.active >= CONTROL_MAX_HTTP || count >= CONTROL_MAX_CONTROLLER_HTTP ||
          !this.rate.hit('account', 240, 60_000) || !this.rate.hit(`controller:${assertion.principal.controllerId}`, 60, 60_000)) throw new ControlHttpError(429, 'busy');
      controllerId = assertion.principal.controllerId;
      this.active++;
      this.controllers.set(controllerId, count + 1);
      await consumeControlNonce(this.store, assertion);
      if (lifetime.signal.aborted || assertion.expiresAt <= Date.now()) throw new ControlHttpError(401, 'invalid_controller_assertion');
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)); } catch { return rpcError(undefined, -32700, 'invalid_request'); }
      const rpc = rpcSchema.safeParse(value);
      if (!rpc.success) return rpcError(undefined, -32600, 'invalid_request');
      const { method, id, params } = rpc.data;
      // Tool notifications cannot mutate hosts. Tasks, resources, prompts, batches, arbitrary
      // methods and resumability are deliberately absent from this first-release surface.
      if (!['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call'].includes(method)) return rpcError(id, -32601, 'method_not_found');
      if (method === 'notifications/initialized' ? id !== undefined : id === undefined) return rpcError(id, -32600, 'invalid_request');
      if (method === 'tools/call') {
        const call = toolCallSchema.safeParse(params);
        if (!call.success) return rpcError(id, -32602, 'invalid_request');
        const target = allowed.get(call.data.name);
        if (call.data.name !== 'computers_list' && !target) return rpcError(id, -32602, 'invalid_request');
        const schema = target ? toolSchema(target) : z.strictObject({});
        if (!schema.safeParse(call.data.arguments ?? {}).success) return rpcError(id, -32602, 'invalid_request');
        if (call.data.name === 'computers_list' && !this.rate.hit(`enumerate:${controllerId}`, 6, 60_000)) throw new ControlHttpError(429, 'busy');
      }
      return await this.serve(request, rpc.data, assertion.principal, lifetime.signal, allowed, channel);
    } catch (error) {
      return controlHttpError(error);
    } finally {
      abort();
      request.signal.removeEventListener('abort', abort);
      if (controllerId !== undefined) {
        this.active--;
        const remaining = (this.controllers.get(controllerId) ?? 1) - 1;
        if (remaining) this.controllers.set(controllerId, remaining);
        else this.controllers.delete(controllerId);
      }
    }
  }

  private async serve(request: Request, parsedBody: unknown, principal: ControllerPrincipal, signal: AbortSignal,
    allowed: ReadonlyMap<string, ControlMethod>, channel: Channel): Promise<Response> {
    const server = new McpServer({ name: channel === 'discovery' ? 'vocs-code-discovery' : 'vocs-control', version: '1.0.0' }, { capabilities: { tools: {} } });
    const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    // SDK errors never enter cloud logs. Only stable error codes leave this boundary.
    server.server.onerror = () => undefined;
    const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value ?? null) }] });
    const failure = (error: unknown) => ({ ...result({ error: controlErrorCode(error) }), isError: true });
    server.registerTool('computers_list', { description: 'List locally authorized, compatible online computers only.',
      inputSchema: z.strictObject({}), ...(channel === 'discovery' ? { annotations: readOnly } : {}) }, async () => {
      try { return result(await this.hosts.computers(principal, signal)); } catch (error) { return failure(error); }
    });
    for (const [name, method] of allowed) {
      server.registerTool(name, {
        description: `${method} on the explicitly named computer. Requires ${CONTROL_REQUIRED_SCOPE[method]} and local delegation.`,
        inputSchema: toolSchema(method), ...(channel === 'discovery' ? { annotations: readOnly } : {})
      }, async (args: z.infer<ReturnType<typeof toolSchema>>) => {
        const { hostId, ...params } = args;
        try {
          const reply = await this.hosts.call(principal, hostId, { method, params }, signal);
          if (!reply.ok) return { ...result({ error: reply.error ?? 'unknown' }), isError: true };
          if (channel !== 'discovery') return result(reply.result);
          const schema = discoveryResults[method as keyof typeof discoveryResults];
          const projected = schema?.safeParse(reply.result);
          return projected?.success ? result(projected.data) : { ...result({ error: 'unavailable' }), isError: true };
        } catch (error) { return failure(error); }
      });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      // Do not put the signed assertion, cookies or account authority in SDK requestInfo.
      const headers = new Headers();
      for (const name of ['accept', 'content-type', 'mcp-protocol-version']) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const sdkRequest = new Request('https://control.invalid/mcp', { method: 'POST', headers, body: encoder.encode('{}'), signal });
      const response = await transport.handleRequest(sdkRequest, { parsedBody });
      const bytes = await readControlBytes(response);
      const outputHeaders = new Headers(response.headers);
      outputHeaders.set('cache-control', 'no-store');
      return new Response(response.status === 202 ? null : bytes, { status: response.status, headers: outputHeaders });
    } finally {
      await server.close();
    }
  }
}
