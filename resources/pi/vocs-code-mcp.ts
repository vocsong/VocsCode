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
import { PiMcpConnection, type PiMcpServerConfig, type PiMcpTool } from './mcp-client';

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
  // Without servers there is nothing to close, and registering the handler would imply otherwise.
  if (registered) pi.on('session_shutdown', () => closeMcpBridge());
}

/** The app's own memory server, mirroring VOCS_MEMORY_SERVER_ID in src/main/mcp/memory.ts. */
const MEMORY_SERVER = 'vocs_memory';

/**
 * State shared by every session in this pi process — the parent and each subagent child. A child is
 * an in-process agent session, so it registers the same tools over the same connections instead of
 * spawning its own copy of every server.
 */
let bridge: Promise<McpBridgeTool[]> | null = null;
let connections: PiMcpConnection[] = [];

async function connectBridge(): Promise<McpBridgeTool[]> {
  const configPath = process.env.VOCS_CODE_MCP_CONFIG;
  if (!configPath) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`[vocs-code-mcp] cannot read MCP config at ${configPath}: ${errorText(error)}`);
    return [];
  }

  const tools: McpBridgeTool[] = [];
  for (const cfg of parseMcpConfig(parsed)) {
    let connection: PiMcpConnection;
    try {
      connection = await PiMcpConnection.connect(cfg);
    } catch (error) {
      console.error(`[vocs-code-mcp] skipping MCP server "${cfg.id}": ${errorText(error)}`);
      continue;
    }
    connections.push(connection);

    let listed: PiMcpTool[];
    try {
      listed = await connection.listTools();
    } catch (error) {
      console.error(`[vocs-code-mcp] listing tools for MCP server "${cfg.id}" failed: ${errorText(error)}`);
      continue;
    }

    const serverId = sanitizeToolName(cfg.id);
    const guidelines = serverId === CODE_GRAPH_SERVER ? CODE_GRAPH_GUIDELINES : undefined;

    for (const tool of listed) {
      const description = tool.description ?? 'MCP tool ' + tool.name + ' from ' + cfg.id;
      tools.push({
        name: toolNameFor(cfg.id, tool.name),
        label: cfg.id + ': ' + tool.name,
        description,
        promptSnippet: promptSnippetFor(tool.description, tool.name),
        ...(guidelines ? { promptGuidelines: [...guidelines] } : {}),
        parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        readOnly: serverId === MEMORY_SERVER && tool.readOnly === true,
        async execute(_id, params) {
          const result = await connection.callTool(tool.name, params ?? {});
          if (result.isError) {
            const text = result.content.map((part) => part.text ?? '').filter(Boolean).join('\n') || 'MCP tool ' + tool.name + ' failed';
            throw new Error(text);
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
  if (!bridge) bridge = connectBridge();
  return bridge;
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
  for (const connection of connections) {
    try {
      connection.close();
    } catch {
      /* a connection that already exited is fine */
    }
  }
  connections = [];
  bridge = null;
}
