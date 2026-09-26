/**
 * Vocs Code MCP bridge extension for pi (loaded with `pi -e <this file>`).
 *
 * pi has no MCP support, so this extension reads a JSON config path from
 * VOCS_CODE_MCP_CONFIG, connects to each server with the dependency-free client in
 * ./mcp-client, and registers every MCP tool with pi as `mcp__<server>__<tool>`. A server
 * that fails to connect or list tools is skipped with a line on stderr (the app surfaces pi
 * stderr); the remaining servers still load.
 *
 * Config shape: { "servers": PiMcpServerConfig[] }
 */

import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { PiMcpConnection, type PiMcpServerConfig, type PiMcpTool } from './mcp-client';
import { isMissionCoordinationTool, MISSION_SERVER_ID } from './vocs-code-mission';

interface PiToolResult {
  content: { type: string; text?: string }[];
  details?: Record<string, unknown>;
}

interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  /** One line for pi's "Available tools" list. pi omits a custom tool from that list without one. */
  promptSnippet?: string;
  /** Bullets for pi's "Guidelines" list; pi dedupes identical text across tools. */
  promptGuidelines?: string[];
  parameters: object;
  execute(id: string, params: Record<string, unknown>): Promise<PiToolResult>;
}

interface PiLike {
  registerTool(def: PiToolDefinition): void;
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
}

export interface McpBridgeTool extends PiToolDefinition {
  /** The app's own memory server may mark a tool read-only; only that server is trusted for it. */
  readOnly: boolean;
  /** App-owned coordination mutates Mission records, NOT a read-only MCP annotation. */
  missionCoordination?: boolean;
}

/** A pi/OpenAI-safe name segment: lowercase, `[a-z0-9_]` only, no leading digit. */
export function sanitizeToolName(name: string): string {
  const mapped = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_');
  const body = mapped || '_';
  return /^[0-9]/.test(body) ? '_' + body : body;
}

export function toolNameFor(serverId: string, toolName: string): string {
  return 'mcp__' + sanitizeToolName(serverId) + '__' + sanitizeToolName(toolName);
}

/** Normalizes an untrusted parsed config, dropping anything missing its transport's required fields. */
export function parseMcpConfig(json: unknown): PiMcpServerConfig[] {
  if (!json || typeof json !== 'object') return [];
  const raw = (json as { servers?: unknown }).servers;
  if (!Array.isArray(raw)) return [];
  const servers: PiMcpServerConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
    const transport = item.transport;
    if (!id) continue;
    if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') continue;
    const command = typeof item.command === 'string' && item.command.trim() ? item.command : undefined;
    const url = typeof item.url === 'string' && item.url.trim() ? item.url : undefined;
    if (transport === 'stdio' && !command) continue;
    if (transport !== 'stdio' && !url) continue;
    const cfg: PiMcpServerConfig = { id, transport };
    if (command) cfg.command = command;
    if (url) cfg.url = url;
    const args = stringArray(item.args);
    if (args) cfg.args = args;
    const env = stringRecord(item.env);
    if (env) cfg.env = env;
    const headers = stringRecord(item.headers);
    if (headers) cfg.headers = headers;
    if (typeof item.timeoutMs === 'number' && Number.isFinite(item.timeoutMs) && item.timeoutMs > 0) cfg.timeoutMs = item.timeoutMs;
    servers.push(cfg);
  }
  return servers;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failed reply can follow a durable commit; never imply that retrying a mutation is effect-free. */
const MISSION_ERROR_RECOVERY = 'Re-read state with mission_read before retrying; the mutation may have committed. Reuse the same idempotencyKey only for the identical request; use a new key for corrected input after checking state. If reads fail, ask the host to restore access.';
const MISSION_ERROR_MAX = 1024;

/** Only called for the ephemeral, host-owned Mission server, never a name/annotation lookalike. */
function missionRequestFailure(detail: string | undefined, headers: Record<string, string> | undefined): Error {
  // The SDK decorates InvalidParams messages; the production broker sends the message directly.
  // Other SDK errors are not actionable validation/state diagnostics.
  const rpc = detail && /^MCP error (-?\d+):\s*/.exec(detail);
  if (rpc) detail = rpc[1] === '-32602' ? detail!.slice(rpc[0].length) : undefined;
  if (detail) {
    detail = stripVTControlCharacters(detail);
    // Redact BEFORE clipping: otherwise a token crossing the bound would leak its prefix.
    // A transport can mention the whole header OR just its bearer credential (even repeatedly).
    const secrets = Object.values(headers ?? {}).flatMap((value) => [value, value.trim(), value.replace(/^Bearer\s+/i, '').trim()])
      .filter(Boolean).sort((a, b) => b.length - a.length);
    for (const secret of secrets) detail = detail.split(secret).join('[redacted]');
    detail = detail.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]');
    // Do not relay header dumps or stack/cause tails, even inside an RPC error's message.
    detail = detail.split(/(?:\r?\n\s*(?:at\s|caused by:|\[cause\]:)|\b(?:headers|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=])/i, 1)[0]
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (detail.length > MISSION_ERROR_MAX) detail = detail.slice(0, MISSION_ERROR_MAX) + '…';
  }
  const message = detail ? `Mission coordination request failed: ${detail}` : 'Mission coordination request failed; the connection may have been revoked.';
  return new Error(`${message}\n${MISSION_ERROR_RECOVERY}`);
}

/** Longest snippet handed to pi: the listing is a pointer, not a replacement for the tool's own schema. */
const SNIPPET_MAX = 120;

/**
 * The built-in code-graph server, mirroring `MCP_BUILTIN_IDS` in `src/shared/types.ts`. pi loads this
 * file as a standalone resource, so it cannot import from `src/`.
 */
const CODE_GRAPH_SERVER = 'gitnexus';

/**
 * A nudge rather than a listing: without it the graph tools are visible to the model but nothing
 * suggests reaching for them over grep. Attached to every tool of the server, since pi dedupes.
 */
const CODE_GRAPH_GUIDELINES = [
  'Use the GitNexus code graph (mcp__gitnexus__*) to find symbols, call paths and processes before falling back to grep, find or read'
];

/**
 * One collapsed line for pi's "Available tools" list — pi drops a registered tool from that list
 * entirely when it has no snippet, which is how an injected MCP server ends up invisible in the prompt.
 */
export function promptSnippetFor(description: string | undefined, toolName: string): string {
  const oneLine = (description ?? '').replace(/\s+/g, ' ').trim() || 'MCP tool ' + toolName;
  if (oneLine.length <= SNIPPET_MAX) return oneLine;
  const clipped = oneLine.slice(0, SNIPPET_MAX);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > SNIPPET_MAX / 2 ? clipped.slice(0, lastSpace) : clipped).trimEnd() + '…';
}

export default async function vocsCodeMcp(pi: PiLike): Promise<void> {
  const registered = await registerMcpTools(pi);
  if (registered) {
    pi.on('session_start', (_event, ctx) => ctx.ui?.notify('VCODE_PI_READY::' + JSON.stringify({ version: 1, nonce: process.env.VOCS_CODE_PI_NONCE, capability: 'mcp', ready: true }), 'info'));
    pi.on('session_shutdown', () => closeMcpBridge());
  }
}

/** The app's own memory server, mirroring VOCS_MEMORY_SERVER_ID in src/main/mcp/memory.ts. */
const MEMORY_SERVER = 'vocs_memory';

/**
 * State shared by every session in this pi process — the parent and each subagent child. A child is
 * an in-process agent session, so it registers the same tools over the same connections instead of
 * spawning its own copy of every server.
 */
interface BridgeState { bridge: Promise<McpBridgeTool[]> | null; connections: PiMcpConnection[]; }
// Pi/Jiti gives separate extension entrypoints separate module caches. A process-wide cache is
// required after the one-use environment capability is consumed (and avoids duplicate servers).
const bridgeKey = Symbol.for('vocs-code.pi.mcp-bridge.v1');
const processState = globalThis as typeof globalThis & { [key: symbol]: BridgeState | undefined };
const state = processState[bridgeKey] ??= { bridge: null, connections: [] };

async function connectBridge(): Promise<McpBridgeTool[]> {
  const configPath = process.env.VOCS_CODE_MCP_CONFIG;
  // Consume before connecting ANY stdio server or shell tool: children must not inherit the token.
  const ephemeral = process.env.VOCS_CODE_MCP_EPHEMERAL;
  delete process.env.VOCS_CODE_MCP_EPHEMERAL;
  const managed = !!process.env.VOCS_CODE_MISSION_POLICY;
  // Only the host environment can attenuate a completed conversation to getters; MCP
  // annotations or a tool payload never select this scope. The Mission gate validates policy.
  const questionId: unknown = managed ? JSON.parse(process.env.VOCS_CODE_MISSION_POLICY!).questionId : undefined;
  const answerOnly = typeof questionId === 'string' && !!questionId;
  let servers: PiMcpServerConfig[] = [];
  if (configPath) {
    try { servers = parseMcpConfig(JSON.parse(readFileSync(configPath, 'utf8'))); }
    catch (error) {
      if (managed) throw new Error('Cannot read managed Mission MCP configuration.');
      console.error(`[vocs-code-mcp] cannot read MCP config at ${configPath}: ${errorText(error)}`);
    }
  }
  // Reserved identity cannot be supplied by a file or a sanitization collision.
  if (servers.some((cfg) => sanitizeToolName(cfg.id) === 'vocs_mission')) throw new Error('Mission MCP configuration must be ephemeral and host-owned.');
  if (managed) {
    let injected: PiMcpServerConfig[];
    try { injected = parseMcpConfig(JSON.parse(ephemeral ?? '')); }
    catch { throw new Error('Required ephemeral Mission MCP configuration is missing or invalid.'); }
    if (injected.length !== 1 || injected[0].id !== MISSION_SERVER_ID || injected[0].transport !== 'http' || !injected[0].headers?.Authorization) {
      throw new Error('Required ephemeral Mission MCP configuration is missing or invalid.');
    }
    servers = [...injected, ...servers];
  } else if (ephemeral) throw new Error('Ephemeral Mission MCP configuration requires a managed session.');

  const tools: McpBridgeTool[] = [];
  for (const cfg of servers) {
    const mission = managed && cfg.id === MISSION_SERVER_ID;
    let connection: PiMcpConnection;
    try {
      connection = await PiMcpConnection.connect(cfg);
    } catch (error) {
      if (mission) { closeMcpBridge(); throw new Error('Required Mission MCP handshake failed.'); }
      console.error(`[vocs-code-mcp] skipping MCP server "${cfg.id}": ${errorText(error)}`);
      continue;
    }
    state.connections.push(connection);

    let listed: PiMcpTool[];
    try {
      listed = await connection.listTools();
    } catch (error) {
      if (mission) { closeMcpBridge(); throw new Error('Required Mission MCP tool discovery failed.'); }
      console.error(`[vocs-code-mcp] listing tools for MCP server "${cfg.id}" failed: ${errorText(error)}`);
      continue;
    }
    if (mission && (!listed.some((tool) => tool.name === 'mission_read') || !listed.some((tool) => tool.name === (answerOnly ? 'mission_context_read' : 'mission_report'))
      || listed.some((tool) => !isMissionCoordinationTool(cfg.id, tool.name) || answerOnly && tool.name !== 'mission_read' && tool.name !== 'mission_context_read'))) {
      closeMcpBridge();
      throw new Error('Required Mission MCP surface is incompatible.');
    }

    const serverId = sanitizeToolName(cfg.id);
    const guidelines = serverId === CODE_GRAPH_SERVER ? CODE_GRAPH_GUIDELINES : undefined;

    for (const tool of listed) {
      const description = tool.description ?? 'MCP tool ' + tool.name + ' from ' + cfg.id;
      tools.push({
        // Managed coordination uses its own namespace, not the ordinary MCP approval category.
        // The Mission gate validates this exact broker-derived list; these are not read-only tools.
        name: mission ? tool.name : toolNameFor(cfg.id, tool.name),
        label: cfg.id + ': ' + tool.name,
        description,
        promptSnippet: promptSnippetFor(tool.description, tool.name),
        ...(guidelines ? { promptGuidelines: [...guidelines] } : {}),
        parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        readOnly: serverId === MEMORY_SERVER && tool.readOnly === true,
        ...(mission ? { missionCoordination: true } : {}),
        async execute(_id, params) {
          let result;
          try { result = await connection.callTool(tool.name, params ?? {}); }
          catch (error) {
            if (mission) {
              // mcp-client only uses this exact prefix for a JSON-RPC error reply to this call.
              // It currently drops the numeric code; transport/timeouts have different messages.
              const prefix = `MCP request "tools/call" to "${MISSION_SERVER_ID}" failed: `;
              const detail = error instanceof Error && error.message.startsWith(prefix) ? error.message.slice(prefix.length) : undefined;
              throw missionRequestFailure(detail, cfg.headers);
            }
            throw error;
          }
          if (result.isError) {
            const text = result.content.map((part) => part.text ?? '').filter(Boolean).join('\n') || 'MCP tool ' + tool.name + ' failed';
            throw mission ? missionRequestFailure(text, cfg.headers) : new Error(text);
          }
          return { content: result.content, details: { server: cfg.id, tool: tool.name } };
        }
      });
    }
  }
  return tools;
}

/** Connects once per pi process; later callers (children included) get the same tools. */
export function loadMcpBridge(): Promise<McpBridgeTool[]> {
  if (!state.bridge) state.bridge = connectBridge();
  return state.bridge;
}

/** Tool names for a child session's active-tool list. */
export async function mcpToolNames(): Promise<string[]> {
  return (await loadMcpBridge()).map((tool) => tool.name);
}

/** Names the gate may treat as reads even below full access (the app's own read-only tools). */
export async function mcpReadOnlyToolNames(): Promise<ReadonlySet<string>> {
  return new Set((await loadMcpBridge()).filter((tool) => tool.readOnly).map((tool) => tool.name));
}

/** Registers every MCP tool into one pi session (the parent, or a subagent child). */
export async function registerMcpTools(pi: PiLike): Promise<number> {
  const tools = await loadMcpBridge();
  for (const tool of tools) pi.registerTool(tool);
  return tools.length;
}

/** Closes the process-wide connections; the parent's shutdown handler is the one caller in practice. */
export function closeMcpBridge(): void {
  for (const connection of state.connections) {
    try {
      connection.close();
    } catch {
      /* a connection that already exited is fine */
    }
  }
  state.connections = [];
  state.bridge = null;
}
