/** Authenticated session-scoped MCP transport. It never exposes user IPC or user-only actions. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { missionMutationPayloadSchema, type MissionActor, type MissionMutation } from './state';
import type { ResolvedServer } from '../mcp/effective';

const OPERATIONS = {
  mission_read: ['Read applicable Mission state and current revisions. Workers receive only their assigned context.', 'read'],
  mission_plan_update: ['Update the versioned plan/task contracts. Payload is a plan.update mutation; optional checks append required criterion-bound verification gates, never replace earlier checks. Stale revisions are refused.', 'lead'],
  mission_question_ask: ['Ask one consequential question, retaining earlier answers. Payload: {question:{id,text,purpose?}}. purpose defaults to clarification (unapproved interactive planning only); authorization or blocker is for genuinely missing human approval/input, including during autonomous execution. Routine autonomous ambiguity is not a questionnaire. Asking or answering grants no execution, permission, preset or goal authority.', 'lead'],
  mission_execution_propose: ['Present the ready plan to the user, then ask Proceed with execution? This does NOT authorize execution. Payload: {proposal:{id,specificationRevision,planRevision,assistantMessageId?,requestedAt?}}. The host binds your latest actual assistant message and records time; omit internal IDs you cannot observe. An explicitly supplied message ID must match that current message.', 'lead'],
  mission_profile_upsert: ['Create/revise a dynamically generated specialist profile from approved tiers. Payload: {profile}.', 'lead'],
  mission_phase_set: ['Advance the Mission phase within current authorization and required gates. Payload: {phase}; never grants execution approval.', 'lead'],
  mission_task_claim: ['Claim direct implementation as the fixed principal engineer. Payload: {taskId}.', 'lead'],
  mission_task_delegate: ['Dispatch a task with its generated profile and whole approved preset. Payload: {taskId,presetId,reason}. No silent fallback.', 'lead'],
  mission_report: ['Submit an assigned structured task result, progress, blocker or partial result. Payload: {result}. Prose or a claimed test pass is not acceptance.', 'participant'],
  mission_decision_request: ['Send an evidence-backed decision request to the principal engineer. Payload: {decision:{id,question,evidenceIds,affectedTaskIds,proposedResolution?}}.', 'participant'],
  mission_decision_resolve: ['Resolve a decision with evidence and affected task references. Payload: {decisionId,resolution,rationale,evidenceIds,affectedTaskIds}.', 'lead'],
  mission_context_read: ['Retrieve authorized retained source/artifacts by opaque reference, never a path. Use {ref,listImages:true} to discover retained attachments and {ref,imageIndex} to view one as an image; otherwise {ref,offset?,limit?} reads bounded text.', 'read'],
  mission_verification_request: ['Request a configured, approved check on exact captured content. Payload: {checkId,candidateId?}. Returns a durable operation, not a fabricated pass. Duplicate pending checks are refused. Repeated identical failures pause at the configured attempt bound; before retrying unchanged input the lead must resolve an evidence-bound decision recording a diagnosis/changed approach. User approval denial pauses immediately; no automatic re-prompt.', 'participant'],
  mission_review_submit: ['Assigned independent reviewer submits evidence-backed findings against exact candidate/criteria. Payload: {review}.', 'participant'],
  mission_integration_request: ['Request serialized integration against exact accepted content: {candidateId,expectedContentHash} for a candidate, or {target:"approved",expectedContentHash} to fetch/integrate an initially divergent or advanced approved delivery branch. No caller-supplied branch, URL or SHA is accepted. Yield and finish the turn; new combined content needs current checks and independent review.', 'lead'],
  mission_task_accept: ['Accept a settled task only after its candidate, criteria, checks and review are satisfied. Payload: {taskId,attemptId}.', 'lead'],
  mission_task_diagnose: ['After repeated failed attempts, record an evidence-based changed approach before retrying. Payload: {taskId,afterAttempt,approach}.', 'lead'],
  mission_task_cancel: ['Cancel a task with an explicit reason; canceling never silently satisfies its required outcome. Payload: {taskId,reason}.', 'lead'],
  mission_finding_resolve: ['Resolve a review finding through a fix or evidenced rejection. Payload: {reviewId,findingId,resolution}.', 'lead'],
  mission_yield: ['End this turn and wait for named events without polling. Payload: {events:string[]}. Capacity releases only after actual tools/turn settle.', 'participant'],
  mission_finish_request: ['Ask the host to evaluate final evidence, quiescence and actual project-policy delivery. Tokens or a quiet lead never complete a Mission.', 'lead'],
} as const;

export type MissionToolName = keyof typeof OPERATIONS;
export type MissionToolActor = Exclude<MissionActor, { kind: 'host' } | { kind: 'user' }>;
export interface MissionToolBinding {
  missionId: string;
  actor: MissionToolActor;
  /** Host-only capability attenuation to one completed-conversation question. */
  questionId?: string;
}
export interface MissionToolRequest {
  expectedRevision?: number;
  idempotencyKey?: string;
  payload: Record<string, unknown>;
}

export interface MissionToolHost {
  /** Called for initialize, listing and every tool call; security revocation is live. */
  validate(binding: MissionToolBinding): Promise<void> | void;
  invoke(binding: MissionToolBinding, name: MissionToolName, request: MissionToolRequest): Promise<unknown>;
}

interface Capability { binding: MissionToolBinding; }
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const READS = new Set<MissionToolName>(['mission_read', 'mission_context_read']);
const MAX_REQUEST_BYTES = 1_048_576;

const MUTATIONS: Partial<Record<MissionToolName, MissionMutation['kind']>> = {
  mission_plan_update: 'plan.update', mission_question_ask: 'question.ask', mission_execution_propose: 'execution.propose', mission_profile_upsert: 'profile.upsert',
  mission_report: 'result.report', mission_decision_request: 'decision.request', mission_decision_resolve: 'decision.resolve', mission_review_submit: 'review.submit',
  mission_task_accept: 'task.accept', mission_task_diagnose: 'task.diagnose', mission_finding_resolve: 'finding.resolve', mission_phase_set: 'phase.set', mission_task_cancel: 'task.cancel',
};
const string = { type: 'string', minLength: 1 };
function payloadSchema(name: MissionToolName): Record<string, unknown> {
  const mutation = MUTATIONS[name];
  if (mutation) {
    const schema = missionMutationPayloadSchema(mutation);
    delete schema.$schema;
    return schema;
  }
  const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
  switch (name) {
    case 'mission_read': return object({});
    case 'mission_task_claim': return object({ taskId: string });
    case 'mission_task_delegate': return object({ taskId: string, presetId: string, reason: string, candidateId: string }, ['taskId', 'presetId', 'reason']);
    case 'mission_context_read': return object({ ref: string, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 64_000 }, imageIndex: { type: 'integer', minimum: 0 }, listImages: { type: 'boolean' } }, ['ref']);
    case 'mission_verification_request': return object({ checkId: string, candidateId: string }, ['checkId']);
    case 'mission_integration_request': return { anyOf: [object({ candidateId: string, expectedContentHash: string }), object({ target: { type: 'string', const: 'approved' }, expectedContentHash: string })] };
    case 'mission_yield': return object({ events: { type: 'array', items: string, minItems: 1, maxItems: 100 } });
    case 'mission_finish_request': return object({ commitMessage: string, report: { ...string, description: 'Optional lead narrative only. The host automatically records the final outcome, checks and delivery identifiers from genuine receipts, even when this is omitted. Prose cannot supply evidence or declare completion.' } }, []);
    default: throw new Error(`Mission tool has no documented payload contract: ${name}`);
  }
}

export function missionToolDefinitions(role: MissionToolActor['kind'], answerOnly = false): Array<Record<string, unknown>> {
  return Object.entries(OPERATIONS).filter(([name, [, audience]]) => (!answerOnly || READS.has(name as MissionToolName)) && (audience !== 'lead' || role === 'lead')).map(([name, [description]]) => ({
    name, description,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        expectedRevision: { type: 'integer', minimum: 0 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
        payload: { ...payloadSchema(name as MissionToolName), description: 'Validated operation data. Actor, mission, session and attempt authority come from this connection, never from claims in this object.' },
      },
      required: READS.has(name as MissionToolName) ? ['payload'] : ['expectedRevision', 'idempotencyKey', 'payload'],
    },
    annotations: { readOnlyHint: READS.has(name as MissionToolName), destructiveHint: !READS.has(name as MissionToolName), idempotentHint: true, openWorldHint: false },
  }));
}

/** Secrets stay in memory and resolved transport headers, never in settings/transcripts/argv.
 * Adapters that persist MCP definitions MUST use an ephemeral environment bridge for this entry. */
export class MissionToolBroker {
  private server?: Server;
  private starting?: Promise<void>;
  private endpoint?: string;
  private readonly capabilities = new Map<string, Capability>();
  private readonly sockets = new Set<import('node:net').Socket>();

  constructor(private readonly host: MissionToolHost) {}

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.endpoint) return;
    const server = createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    this.server = server;
    server.on('connection', (socket) => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    const starting = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        this.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
        resolve();
      });
    });
    this.starting = starting;
    try { await starting; }
    catch (error) { this.server = undefined; server.close(); throw error; }
    finally { if (this.starting === starting) this.starting = undefined; }
  }

  /** Bound by the service after durable dispatch intent, never from an IPC/tool argument. */
  attach(binding: MissionToolBinding): ResolvedServer {
    if (!this.endpoint) throw new Error('Mission tool broker is not running');
    const token = randomBytes(32).toString('base64url');
    this.capabilities.set(digest(token), { binding: structuredClone(binding) });
    return { def: { id: 'vocs-mission', transport: 'http', url: this.endpoint, headers: { Authorization: `Bearer ${token}` } }, missing: [], secretEnvKeys: [], secretHeaderKeys: ['Authorization'] };
  }

  revoke(missionId: string, sessionId?: string): void {
    for (const [key, entry] of this.capabilities) {
      if (entry.binding.missionId === missionId && (!sessionId || entry.binding.actor.sessionId === sessionId)) this.capabilities.delete(key);
    }
  }

  async close(): Promise<void> {
    await this.starting?.catch(() => undefined);
    this.capabilities.clear();
    const server = this.server;
    this.server = undefined; this.endpoint = undefined;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private json(res: ServerResponse, status: number, value?: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(value === undefined ? undefined : JSON.stringify(value));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // No browser/renderer-originated invocation or DNS-rebinding aliases, even with guessed URLs.
    const host = this.endpoint ? new URL(this.endpoint).host : '';
    if (req.headers.host !== host || req.headers.origin || req.url !== '/mcp') { this.json(res, 403, { error: 'Forbidden' }); return; }
    const header = req.headers.authorization ?? '';
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    const capability = match ? this.capabilities.get(digest(match[1])) : undefined;
    if (!capability) { this.json(res, 401, { error: 'Unauthorized Mission connection' }); return; }
    if (req.method === 'GET' || req.method === 'DELETE') { this.json(res, 405, { error: 'Stateless Mission MCP does not expose an event stream' }); return; }
    if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) { this.json(res, 415, { error: 'Expected JSON POST' }); return; }
    try { await this.host.validate(structuredClone(capability.binding)); }
    catch { this.json(res, 403, { error: 'Mission connection is no longer authorized' }); req.resume(); return; }
    let id: string | number | null = null;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const data = Buffer.from(chunk as Buffer);
        bytes += data.length;
        if (bytes > MAX_REQUEST_BYTES) { res.setHeader('Connection', 'close'); this.json(res, 413, { error: 'Mission request too large' }); req.resume(); return; }
        chunks.push(data);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw new Error('Invalid JSON-RPC request');
      if (message.id !== undefined && typeof message.id !== 'string' && typeof message.id !== 'number') throw new Error('Invalid request identity');
      id = (message.id ?? null) as string | number | null;
      if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') { this.json(res, 202); return; }
      let result: unknown;
      if (message.method === 'initialize') {
        result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'vocs-mission', version: '1' } };
      } else if (message.method === 'ping') {
        result = {};
      } else if (message.method === 'tools/list') {
        result = { tools: missionToolDefinitions(capability.binding.actor.kind, !!capability.binding.questionId) };
      } else if (message.method === 'tools/call') {
        const params = message.params;
        if (!isObject(params) || typeof params.name !== 'string' || !Object.hasOwn(OPERATIONS, params.name)) throw new Error('Unknown Mission operation');
        const name = params.name as MissionToolName;
        if (capability.binding.questionId && !READS.has(name)) throw new Error('Completed Mission questions are read-only; start a new Mission for implementation.');
        if (OPERATIONS[name][1] === 'lead' && capability.binding.actor.kind !== 'lead') throw new Error('This operation belongs to the principal engineer');
        const request = parseRequest(params.arguments, !READS.has(name));
        // Revalidate after reading an asynchronous body: stop/handover may have revoked it meanwhile.
        if (!match || this.capabilities.get(digest(match[1])) !== capability) throw new Error('Mission capability was revoked');
        await this.host.validate(structuredClone(capability.binding));
        const response = await this.host.invoke(structuredClone(capability.binding), name, request);
        if (name === 'mission_context_read' && isObject(response) && response.kind === 'source_image') {
          const image = response.image;
          if (!isObject(image) || typeof image.mimeType !== 'string' || !/^image\/(png|jpeg|gif|webp|bmp)$/i.test(image.mimeType)
            || typeof image.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || image.data.length > 24 * 1024 * 1024) throw new Error('Retained attachment is not a supported image or exceeds the explicit 24 MiB image transport limit. Its source bytes remain retained.');
          const metadata = { kind: response.kind, mimeType: image.mimeType, name: image.name };
          result = { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', mimeType: image.mimeType, data: image.data }], structuredContent: { result: metadata }, isError: false };
        } else result = { content: [{ type: 'text', text: JSON.stringify(response ?? null) }], structuredContent: { result: response ?? null }, isError: false };
      } else {
        this.json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return;
      }
      this.json(res, 200, { jsonrpc: '2.0', id, result });
    } catch (error) {
      // Schema/control errors, not inputs/tokens. The host must not interpolate secrets into errors.
      this.json(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: error instanceof Error ? error.message : 'Mission operation refused' } });
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseRequest(value: unknown, mutating: boolean): MissionToolRequest {
  if (!isObject(value) || Object.keys(value).some((key) => !['payload', 'expectedRevision', 'idempotencyKey'].includes(key)) || !isObject(value.payload)) throw new Error('Use payload, expectedRevision and idempotencyKey; actor identity is supplied by the host');
  if (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0)) throw new Error('Invalid expectedRevision');
  if (value.idempotencyKey !== undefined && (typeof value.idempotencyKey !== 'string' || !value.idempotencyKey.trim() || value.idempotencyKey.length > 200)) throw new Error('Invalid idempotencyKey');
  if (mutating && (value.expectedRevision === undefined || value.idempotencyKey === undefined)) throw new Error('Mutation requires expectedRevision and idempotencyKey');
  if (['actor', 'missionId', 'sessionId', 'generation', 'authorization', 'sourceUserActionId'].some((key) => Object.hasOwn(value.payload as object, key))) throw new Error('Model payload cannot select identity, generation or user authority');
  return structuredClone(value) as unknown as MissionToolRequest;
}
