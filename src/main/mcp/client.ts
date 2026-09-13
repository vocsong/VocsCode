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
 * Connects to a server, lists its tools and disconnects. Harness-independent, so it validates a
 * server that only Codex would ever run. The definition must already have its `${VAR}`
 * references resolved and its command normalized.
 */
export async function inspectServer(def: McpServerDef, opts: InspectOptions = {}): Promise<McpInspectResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let transport: McpTransportLike | null = null;
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    transport = await buildTransport(def, opts);
    await client.connect(transport as never, { timeout: timeoutMs });
    const info = client.getServerVersion();
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    const tools = (listed.tools ?? []).map((t) => ({ name: t.name, description: typeof t.description === 'string' ? t.description : undefined }));
    await client.close();
    transport = null;
    return { ok: true, serverInfo: info ? { name: String(info.name), version: info.version ? String(info.version) : undefined } : undefined, tools, durationMs: Date.now() - started };
  } catch (e) {
    return { ok: false, error: errorMessage(e), tools: [], durationMs: Date.now() - started };
  } finally {
    // A stdio server that failed mid-handshake still has a live child process.
    await transport?.close().catch(() => undefined);
  }
}
