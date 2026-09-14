/**
 * MCP tools for the native loop. The native harness declares `mcp: 'client'` — the app is the MCP
 * client — so one connection per configured server is opened when the session starts and closed
 * when it disposes. Names follow the platform convention `mcp__<server>__<tool>`, the same shape
 * pi's bridge registers and the subagent gate classifies, so a tool is recognizable across
 * harnesses.
 *
 * A third-party server's tool can do anything, so it always asks below Full access (the same rule
 * pi's gate applies) and is hidden in plan mode. The app's own memory server is the one exception:
 * the app wrote its tools, and only the tools it marks read-only may run unprompted — which also
 * keeps knowledge_search usable while planning.
 */
import type { ResolvedServer } from '../../mcp/effective';
import { connectServer, type ConnectedMcpServer } from '../../mcp/client';
import { VOCS_MEMORY_SERVER_ID } from '../../mcp/memory';
import { errorMessage } from '../../util/async';
import type { NativeToolDef } from './tools';

export interface NativeMcpTool extends NativeToolDef {
  serverId: string;
  /** The tool's name on its own server, before the `mcp__server__` prefix. */
  toolName: string;
  call(args: Record<string, unknown>, signal?: AbortSignal): Promise<{ output: string; isError: boolean }>;
}

export interface NativeMcpFailure {
  serverId: string;
  error: string;
}

/** Same sanitization pi's bridge uses: lowercase, `[a-z0-9_]`, no leading underscore. */
function sanitizeToolName(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'tool';
}

export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${sanitizeToolName(serverId)}__${sanitizeToolName(toolName)}`;
}

/** How long one server may take to start and list its tools before it is skipped for this session. */
const CONNECT_TIMEOUT_MS = 15_000;

export class NativeMcpSession {
  private constructor(
    private readonly connections: ConnectedMcpServer[],
    readonly tools: NativeMcpTool[],
    readonly failures: NativeMcpFailure[]
  ) {}

  /** Servers that answered, in configuration order. */
  get servers(): string[] {
    return this.connections.map((c) => c.serverId);
  }

  /**
   * Connects to every server in parallel. A server that fails to start is reported, never fatal:
   * the session still runs with the rest of its tools.
   */
  static async connect(servers: ResolvedServer[], opts: { cwd: string; log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void }): Promise<NativeMcpSession> {
    const connections: ConnectedMcpServer[] = [];
    const tools: NativeMcpTool[] = [];
    const failures: NativeMcpFailure[] = [];
    type Outcome = { ok: true; connection: ConnectedMcpServer } | { ok: false; serverId: string; error: string };
    const started = await Promise.all(
      servers.map(async (server): Promise<Outcome> => {
        try {
          const connection = await connectServer(server.def, { cwd: opts.cwd, timeoutMs: Math.min(server.def.timeoutMs ?? CONNECT_TIMEOUT_MS, CONNECT_TIMEOUT_MS) });
          return { ok: true, connection };
        } catch (e) {
          return { ok: false, error: errorMessage(e), serverId: server.def.id };
        }
      })
    );
    for (const [index, result] of started.entries()) {
      const def = servers[index].def;
      if (!result.ok) {
        failures.push({ serverId: result.serverId, error: result.error });
        opts.log('warn', `native mcp: ${def.id} unavailable: ${result.error}`);
        continue;
      }
      connections.push(result.connection);
      for (const tool of result.connection.tools) {
        // Only the app's own memory server is trusted to declare a tool read-only.
        const readOnly = def.id === VOCS_MEMORY_SERVER_ID && tool.readOnly === true;
        const description = tool.description ? `${tool.description} (MCP server: ${def.id})` : `${def.id}: ${tool.name}`;
        tools.push({
          name: mcpToolName(def.id, tool.name),
          description,
          parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? (tool.inputSchema as Record<string, unknown>) : { type: 'object', properties: {} },
          mutating: !readOnly,
          isEdit: false,
          serverId: def.id,
          toolName: tool.name,
          call: (args, signal) => result.connection.call(tool.name, args, signal ? { signal } : {})
        });
      }
      opts.log('info', `native mcp: ${def.id} → ${result.connection.tools.length} tool(s)`);
    }
    return new NativeMcpSession(connections, tools, failures);
  }

  async close(): Promise<void> {
    await Promise.all(this.connections.map((c) => c.close().catch(() => undefined)));
  }
}
