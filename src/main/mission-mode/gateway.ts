/**
 * The Mission gateway: the one door a mission session's Mission tools go through.
 *
 * Every supported harness spawns `resources/mcp/vocs-mission.mjs`, a dependency-free stdio MCP
 * server that is only a thin client: `tools/list` posts to `/list` and `tools/call` to `/call` here,
 * carrying the session's bearer capability. The token binds the session id and, at attachment, its
 * mission and role. Every request re-reads the session's live identity (`deps.identity`): a session
 * that left its mission, changed role or moved to another mission is refused and its token dropped.
 * A token only lists and accepts its own role's tools, so a Builder can never start a Builder.
 *
 * Structural copy of the memory gateway (`src/main/intelligence/gateway.ts`): loopback only, no
 * browser traffic (any Origin or `sec-fetch-site`, a Host other than the bound address), bounded
 * bodies, tokens held only as digests and never logged or echoed. Like that gateway it is no
 * boundary against a process already running as the user; it keeps each agent's coordination tools
 * inside the mission and role its session was given. No Electron imports.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { MissionTool } from '../../shared/mission-mode';
import type { MissionGatewayAttachment, MissionGatewayPort, MissionSessionIdentity, MissionToolHandler, MissionToolResult } from './contracts';
import { isMissionToolFor, missionToolSchemas, validateMissionToolArgs } from './tools';

const MAX_REQUEST_BYTES = 1_000_000;
/** A diff or log can be large; the model gets the head and a note rather than an unbounded reply. */
const MAX_RESULT_CHARS = 200_000;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

export interface MissionGatewayDeps {
  /** The session's live Mission identity, or null once it is not (or no longer) in a live mission. */
  identity(sessionId: string): MissionSessionIdentity | null;
  /** Runs every authorized, validated call (MissionService). */
  handler: MissionToolHandler;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

interface Capability {
  nonce: Buffer;
  digest: string;
  sessionId: string;
  identity: MissionSessionIdentity;
}

type ToolResultPayload = { content: { type: 'text'; text: string }[]; isError?: true };

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const sameIdentity = (a: MissionSessionIdentity, b: MissionSessionIdentity): boolean => a.missionId === b.missionId && a.role === b.role;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toolResult(result: MissionToolResult): ToolResultPayload {
  const raw = typeof result?.text === 'string' ? result.text : '';
  const text = raw.length > MAX_RESULT_CHARS ? `${raw.slice(0, MAX_RESULT_CHARS)}\n… (${raw.length - MAX_RESULT_CHARS} more characters omitted)` : raw;
  return { content: [{ type: 'text', text }], ...(result?.isError ? { isError: true as const } : {}) };
}

function errorResult(text: string): ToolResultPayload {
  return { content: [{ type: 'text', text }], isError: true };
}

export class MissionGateway implements MissionGatewayPort {
  private server?: Server;
  private starting?: Promise<void>;
  /** `http://127.0.0.1:<port>`; the client posts to `/list` and `/call` under it. */
  private endpoint?: string;
  private readonly signingKey = randomBytes(32);
  private readonly capabilities = new Map<string, Capability>();
  private readonly issued = new Map<string, Capability>();
  private readonly sockets = new Set<Socket>();

  constructor(private readonly deps: MissionGatewayDeps) {}

  /** Opens the loopback listener once; later calls share it. A failure leaves the gateway unavailable. */
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.endpoint) return;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        // Neither handler exception details nor inbound headers or tool data belong in app logs.
        this.deps.log('debug', 'mission: gateway request failed');
        this.reject(req, res, 500, 'The Mission gateway request failed.');
      });
    });
    server.requestTimeout = 120_000;
    server.headersTimeout = 10_000;
    this.server = server;
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    const starting = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        this.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    }).catch(() => {
      this.server = undefined;
      server.close();
      this.deps.log('warn', 'mission: could not start the loopback gateway; the Mission tools are unavailable');
    }).finally(() => {
      this.starting = undefined;
    });
    this.starting = starting;
    await starting;
  }

  /**
   * This session's capability, or null when it is not in a live mission or the listener is not up.
   * A null attachment is an authorization or availability failure: the session gets no Mission tools.
   * Re-attaching with an unchanged identity hands back the same token, so a restarted runtime and
   * the one it replaced agree.
   */
  attach(sessionId: string): MissionGatewayAttachment | null {
    const identity = this.currentIdentity(sessionId);
    if (!identity) {
      this.revoke(sessionId);
      return null;
    }
    if (!this.endpoint) return null;
    const previous = this.issued.get(sessionId);
    if (previous && sameIdentity(previous.identity, identity)) return { url: this.endpoint, token: this.tokenFor(previous.nonce) };
    if (previous) this.drop(previous);
    const nonce = randomBytes(32);
    const token = this.tokenFor(nonce);
    const cap: Capability = { nonce, digest: digest(token), sessionId, identity };
    this.capabilities.set(cap.digest, cap);
    this.issued.set(sessionId, cap);
    return { url: this.endpoint, token };
  }

  /**
   * `attach`, starting the listener first when the session is in a live mission — the gateway opens
   * on the first mission session, never for an ordinary one.
   */
  async ensureAttachment(sessionId: string): Promise<MissionGatewayAttachment | null> {
    if (!this.currentIdentity(sessionId)) {
      this.revoke(sessionId);
      return null;
    }
    await this.start();
    return this.attach(sessionId);
  }

  revoke(sessionId: string): void {
    const cap = this.issued.get(sessionId);
    if (cap) this.drop(cap);
  }

  revokeAll(): void {
    for (const cap of [...this.issued.values()]) this.drop(cap);
  }

  state(): { listening: boolean; sessions: number } {
    return { listening: !!this.endpoint, sessions: this.issued.size };
  }

  async close(): Promise<void> {
    if (this.starting) await this.starting;
    this.revokeAll();
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Reproduce the bearer for a re-resolved launch definition without storing it in either map. */
  private tokenFor(nonce: Buffer): string {
    return createHmac('sha256', this.signingKey).update(nonce).digest('base64url');
  }

  private drop(cap: Capability): void {
    this.capabilities.delete(cap.digest);
    if (this.issued.get(cap.sessionId) === cap) this.issued.delete(cap.sessionId);
  }

  private currentIdentity(sessionId: string): MissionSessionIdentity | null {
    let identity: MissionSessionIdentity | null;
    try {
      identity = this.deps.identity(sessionId);
    } catch {
      return null;
    }
    if (!identity || typeof identity.missionId !== 'string' || !identity.missionId || (identity.role !== 'lead' && identity.role !== 'builder')) return null;
    return { missionId: identity.missionId, role: identity.role };
  }

  /** The live check every request (and every result) passes: the token is current and its session still holds that identity. */
  private authorize(cap: Capability): { identity: MissionSessionIdentity } | { status: number; error: string } {
    if (this.capabilities.get(cap.digest) !== cap) return { status: 401, error: 'Unauthorized' };
    const current = this.currentIdentity(cap.sessionId);
    if (!current || !sameIdentity(cap.identity, current)) {
      this.drop(cap);
      return { status: 403, error: 'This session may no longer use the Mission tools' };
    }
    return { identity: current };
  }

  private json(res: ServerResponse, status: number, value: unknown, token?: string): void {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(token ? body.replaceAll(token, '<redacted>') : body);
  }

  private reject(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
    if (res.destroyed || res.writableEnded) return;
    res.setHeader('Connection', 'close');
    this.json(res, status, { error });
    req.resume();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Reject browser traffic (even an empty Origin), duplicate auth/routing headers and host aliases.
    const host = this.endpoint ? new URL(this.endpoint).host : '';
    const headers = req.headersDistinct;
    const route = req.url === '/list' ? 'list' : req.url === '/call' ? 'call' : undefined;
    if (!host || headers.host?.length !== 1 || headers.host[0] !== host || headers.origin || headers['sec-fetch-site'] || !route) return this.reject(req, res, 403, 'Forbidden');
    const token = headers.authorization?.length === 1 ? BEARER.exec(headers.authorization[0])?.[1] : undefined;
    const cap = token ? this.capabilities.get(digest(token)) : undefined;
    if (!cap || !token) return this.reject(req, res, 401, 'Unauthorized');
    if (req.method !== 'POST') return this.reject(req, res, 405, 'Expected POST');
    if (headers['content-type']?.length !== 1 || !JSON_CONTENT_TYPE.test(headers['content-type'][0])) return this.reject(req, res, 415, 'Expected application/json');
    const accepted = this.authorize(cap);
    if ('status' in accepted) return this.reject(req, res, accepted.status, accepted.error);
    if (Number(req.headers['content-length']) > MAX_REQUEST_BYTES) return this.reject(req, res, 413, 'Request too large');
    const chunks: Buffer[] = [];
    let bytes = 0;
    // Do not destroy the socket via the iterator on overflow: the bounded failure must reach the client.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const data = chunk as Buffer;
      bytes += data.length;
      if (bytes > MAX_REQUEST_BYTES) return this.reject(req, res, 413, 'Request too large');
      chunks.push(data);
    }
    if (res.destroyed) return;
    const grant = this.authorize(cap); // Streaming the body can outlive the grant.
    if ('status' in grant) return this.reject(req, res, grant.status, grant.error);
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      return this.reject(req, res, 400, 'Invalid JSON');
    }
    const { role, missionId } = grant.identity;

    if (route === 'list') {
      if (!isObject(message) || Object.keys(message).length) return this.reject(req, res, 400, 'Expected an empty object');
      return this.json(res, 200, { tools: missionToolSchemas(role) });
    }

    if (!isObject(message) || Object.keys(message).length !== 2 || typeof message.tool !== 'string' || !isObject(message.arguments)) return this.reject(req, res, 400, 'Expected a tool and an arguments object');
    const { tool, arguments: raw } = message;
    // A token only reaches its own role's tools; the other role's are as unknown as a made-up name.
    if (!isMissionToolFor(role, tool)) return this.json(res, 200, { result: errorResult(`Unknown Mission tool for a ${role === 'lead' ? 'Lead' : 'Builder'}.`) });
    if (JSON.stringify(raw).includes(token)) return this.reject(req, res, 400, 'A credential cannot be used as tool data');
    const valid = validateMissionToolArgs(tool, raw);
    if (!valid.ok) return this.json(res, 200, { result: errorResult(valid.error) });

    let result: ToolResultPayload;
    try {
      result = toolResult(await this.deps.handler.call({ sessionId: cap.sessionId, missionId, role, tool: tool as MissionTool, args: valid.args }));
    } catch {
      this.deps.log('warn', `mission: ${tool} failed for ${cap.sessionId}`);
      result = errorResult('The Mission tool could not complete the call.');
    }
    if (res.destroyed) return;
    // The session may have left the mission while the call ran: its answer is no longer its to see.
    const live = this.authorize(cap);
    if ('status' in live) return this.reject(req, res, live.status, live.error);
    this.json(res, 200, { result }, token);
  }
}
