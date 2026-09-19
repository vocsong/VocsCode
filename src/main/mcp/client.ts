/**
 * The app's own MCP client. In P0 it backs "Test connection" on both UI surfaces; the native
 * loop will reuse it to merge MCP tools into its tool set (docs/MCP.md §6). The SDK is imported
 * lazily so nothing is loaded until a user actually probes a server. No Electron imports.
 */
import type { McpInspectResult, McpServerDef } from '../../shared/types';
import { errorMessage } from '../util/async';

const CLIENT_INFO = { name: 'vocs-code', version: '0.1.0' };
const DEFAULT_TIMEOUT_MS = 20_000;

export interface InspectOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Extra environment for a stdio server, on top of the inherited one. */
  env?: NodeJS.ProcessEnv;
}

interface McpTransportLike {
  close(): Promise<void>;
}

/** One tool as the SDK reports it, narrowed to what a harness needs. */
export interface ConnectedMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  readOnly?: boolean;
}

export interface McpCallResult {
  output: string;
  isError: boolean;
  /** Image content blocks (base64), as a computer-use server returns screenshots. */
  images: McpImage[];
  /** The raw structuredContent, when the server sent one. */
  structured?: unknown;
}

/** One image content block from an MCP tool result. */
export interface McpImage {
  mimeType: string;
  /** Base64, without a data-URL prefix. */
  data: string;
}

/** A live connection: list once at connect, call many times, close when the session ends. */
export interface ConnectedMcpServer {
  serverId: string;
  tools: ConnectedMcpTool[];
  call(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpCallResult>;
  close(): Promise<void>;
}

async function buildTransport(def: McpServerDef, opts: InspectOptions): Promise<McpTransportLike> {
  if (def.transport === 'stdio') {
    if (!def.command) throw new Error('No command configured');
    const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const base: Record<string, string> = { ...getDefaultEnvironment() };
    for (const [k, v] of Object.entries(opts.env ?? {})) if (v !== undefined) base[k] = v;
    for (const [k, v] of Object.entries(def.env ?? {})) base[k] = v;
    return new StdioClientTransport({ command: def.command, args: def.args ?? [], env: base, cwd: opts.cwd, stderr: 'pipe' });
  }
  if (!def.url) throw new Error('No URL configured');
  const url = new URL(def.url);
  const requestInit = def.headers && Object.keys(def.headers).length ? { headers: { ...def.headers } } : undefined;
  if (def.transport === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    return new SSEClientTransport(url, { requestInit });
  }
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  return new StreamableHTTPClientTransport(url, { requestInit });
}

/**
 * Connects to a server and keeps the connection: the native loop is the app's MCP client, so it
 * needs the live session rather than a one-shot probe. The definition must already have its
 * `${VAR}` references resolved and its command normalized.
 */
export async function connectServer(def: McpServerDef, opts: InspectOptions = {}): Promise<ConnectedMcpServer> {
  const timeoutMs = opts.timeoutMs ?? def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const transport = await buildTransport(def, opts);
  try {
    await client.connect(transport as never, { timeout: timeoutMs });
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    const tools: ConnectedMcpTool[] = (listed.tools ?? []).map((t) => ({
      name: t.name,
      ...(typeof t.description === 'string' ? { description: t.description } : {}),
      ...(t.inputSchema ? { inputSchema: t.inputSchema as unknown } : {}),
      // Only the app's own servers are trusted to declare a tool read-only (see native/mcp-tools.ts).
      ...(t.annotations?.readOnlyHint === true ? { readOnly: true } : {})
    }));
    return {
      serverId: def.id,
      tools,
      async call(name, args, callOpts = {}) {
        const raw = (await client.callTool(
          { name, arguments: args },
          undefined,
          { timeout: callOpts.timeoutMs ?? timeoutMs, ...(callOpts.signal ? { signal: callOpts.signal } : {}) }
        )) as { content?: unknown; isError?: unknown; structuredContent?: unknown };
        const content = Array.isArray(raw.content) ? raw.content : [];
        const text = content
          .filter((part): part is { type: 'text'; text: string } => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text')
          .map((part) => part.text)
          .join('\n');
        const images: McpImage[] = content
          .filter((part): part is { type: 'image'; data: string; mimeType: string } => {
            if (!part || typeof part !== 'object') return false;
            const p = part as { type?: unknown; data?: unknown; mimeType?: unknown };
            return p.type === 'image' && typeof p.data === 'string' && typeof p.mimeType === 'string';
          })
          .map((part) => ({ mimeType: part.mimeType, data: part.data }));
        return {
          output: text || JSON.stringify(raw.content ?? raw),
          isError: raw.isError === true,
          images,
          ...(raw.structuredContent !== undefined ? { structured: raw.structuredContent } : {})
        };
      },
      async close() {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }
    };
  } catch (e) {
    await transport.close().catch(() => undefined);
    throw e;
  }
}

/**
 * Connects to a server, lists its tools and disconnects. Harness-independent, so it validates a
 * server that only Codex would ever run. The definition must already have its `${VAR}`
 * references resolved and its command normalized.
 */
export async function inspectServer(def: McpServerDef, opts: InspectOptions = {}): Promise<McpInspectResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const probe = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = await buildTransport(def, opts);
    try {
      await probe.connect(transport as never, { timeout: timeoutMs });
      const info = probe.getServerVersion();
      const listed = await probe.listTools(undefined, { timeout: timeoutMs });
      const tools = (listed.tools ?? []).map((t) => ({ name: t.name, description: typeof t.description === 'string' ? t.description : undefined }));
      return { ok: true, serverInfo: info ? { name: String(info.name), version: info.version ? String(info.version) : undefined } : undefined, tools, durationMs: Date.now() - started };
    } finally {
      // A stdio server that failed mid-handshake still has a live child process.
      await probe.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e), tools: [], durationMs: Date.now() - started };
  }
}
