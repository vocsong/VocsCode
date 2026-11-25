/** In-process SDK MCP bridges for token-bearing app stdio servers (memory, Mission) so tokens stay out of `--mcp-config` argv. */
import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerDef } from '../../shared/types';
import { MEMORY_GATEWAY_TOKEN_ENV, MEMORY_GATEWAY_URL_ENV, VOCS_MEMORY_SERVER_ID } from '../mcp/memory';
import { MISSION_GATEWAY_TOKEN_ENV, MISSION_GATEWAY_URL_ENV, VOCS_MISSION_SERVER_ID } from '../mcp/mission';

/**
 * The app's token-bearing stdio servers. The SDK flattens process MCP configs (stdio env included)
 * into `--mcp-config` argv, so these are run by this host and relayed to Claude in-process, where
 * Claude reports them with the source `sdk`.
 */
export const GATEWAY_BRIDGES = [
  { id: VOCS_MEMORY_SERVER_ID, urlEnv: MEMORY_GATEWAY_URL_ENV, tokenEnv: MEMORY_GATEWAY_TOKEN_ENV, label: 'memory', title: 'Memory' },
  { id: VOCS_MISSION_SERVER_ID, urlEnv: MISSION_GATEWAY_URL_ENV, tokenEnv: MISSION_GATEWAY_TOKEN_ENV, label: 'mission', title: 'Mission' }
] as const;

export type GatewayBridge = (typeof GATEWAY_BRIDGES)[number];

export function gatewayBridgeFor(def: McpServerDef): GatewayBridge | undefined {
  return GATEWAY_BRIDGES.find((kind) => def.id === kind.id && (def.env?.[kind.urlEnv] !== undefined || def.env?.[kind.tokenEnv] !== undefined));
}

export const GATEWAY_ENV_NAMES = new Set<string>([
  ...GATEWAY_BRIDGES.flatMap((kind) => [kind.urlEnv, kind.tokenEnv]),
  'VOCS_CODE_MCP_EPHEMERAL'
]);

/** Tracks opened in-process MCP gateway bridges for a single Claude adapter lifecycle. */
export class ClaudeGatewayBridges {
  private closers: (() => Promise<void>)[] = [];

  get hasOpen(): boolean {
    return this.closers.length > 0;
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.closers.splice(0).map((close) => close()));
  }

  /** Run an app-owned, token-bearing stdio child (memory, Mission) from the SDK host, not from Claude Code. */
  async open(def: McpServerDef, kind: GatewayBridge, cwd: string, signal: AbortSignal): Promise<McpSdkServerConfigWithInstance | undefined> {
    if (def.builtin !== kind.id || def.transport !== 'stdio' || !def.command
      || !def.env?.[kind.urlEnv] || !def.env?.[kind.tokenEnv]) return;
    let close: (() => Promise<void>) | undefined;
    try {
      const [{ Client }, { StdioClientTransport }, { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/stdio.js'),
        import('@modelcontextprotocol/sdk/types.js')
      ]);
      signal.throwIfAborted();
      const client = new Client({ name: 'vocs-code', version: '0.1.0' });
      // Ignore child stderr: a failed handshake can otherwise surface snippets of launch secrets.
      const transport = new StdioClientTransport({ command: def.command, args: def.args, env: def.env, cwd, stderr: 'ignore' });
      let closing: Promise<void> | undefined;
      const closer = () => closing ??= client.close().catch(() => undefined);
      close = closer;
      this.closers.push(closer);
      await client.connect(transport, { signal, timeout: 10_000 });
      const timeout = def.timeoutMs && def.timeoutMs >= 1000 ? def.timeoutMs : undefined;
      const bridge = createSdkMcpServer({
        name: kind.id,
        version: client.getServerVersion()?.version,
        instructions: client.getInstructions(),
        timeout
      });
      // Relay the tool protocol directly: reconstructing via sdkTool() would change the stdio
      // server's JSON Schemas, annotations and returned content.
      bridge.instance.server.registerCapabilities({ tools: {} });
      bridge.instance.server.setRequestHandler(ListToolsRequestSchema, async ({ params }, { signal: reqSignal }) => {
        try { return await client.listTools(params, { signal: reqSignal, timeout: 10_000 }); }
        catch { throw new McpError(ErrorCode.InternalError, `${kind.title} gateway MCP tool discovery failed.`); }
      });
      bridge.instance.server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal: reqSignal }) => {
        // The gateway can take up to 90 seconds before local fallback starts.
        try { return await client.callTool(params, undefined, { signal: reqSignal, timeout: timeout ?? 120_000 }); }
        catch { throw new McpError(ErrorCode.InternalError, `${kind.title} gateway MCP request failed.`); }
      });
      return bridge;
    } catch {
      if (close) {
        this.closers = this.closers.filter((entry) => entry !== close);
        await close();
      }
      // No inline fallback and no error detail from the credential-bearing child.
      return undefined;
    }
  }
}
