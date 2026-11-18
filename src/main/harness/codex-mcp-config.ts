import type { CodexMcpConfig } from '../mcp/effective';
import { withTimeout } from '../util/async';
import { JsonRpcStdioClient } from './jsonrpc';
import { spawnTool } from './spawn';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ask Codex for the merged config for this cwd; do not launch a thread or enumerate MCP tools. */
export async function getCodexMcpServers(rpc: JsonRpcStdioClient, cwd: string): Promise<unknown> {
  try {
    const { config } = await withTimeout(rpc.request<{ config: unknown }>('config/read', { cwd }), 10_000, 'codex config/read');
    if (!isRecord(config)) throw new Error('unexpected config response');
    return config.mcp_servers ?? {};
  } catch {
    // Native config errors may quote lines from the user's config, including secrets.
    throw new Error('Could not read Codex MCP configuration. Check that the selected Codex runtime can load its config.toml.');
  }
}

/** Exec has no config API of its own; use the same binary for one read-only app-server request. */
export async function readCodexMcpServers(bin: string, cwd: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  // Like the SDK, inherit the desktop process's launch directory (including relative CODEX_HOME).
  // The session directory is passed separately to config/read, like the SDK's --cd argument.
  const rpc = new JsonRpcStdioClient(spawnTool(bin, ['app-server'], { env }));
  try {
    await withTimeout(rpc.request('initialize', { clientInfo: { name: 'vocs-code', version: '0.1.0' } }), 10_000, 'codex initialize');
    rpc.notify('initialized');
    return await getCodexMcpServers(rpc, cwd);
  } finally {
    await rpc.close();
  }
}

export async function applyCodexMcpSuppression(
  config: CodexMcpConfig['config'], owned: readonly string[], read: () => Promise<unknown>
): Promise<void> {
  const suppressed = owned.filter((id) => !Object.hasOwn(config, id));
  if (!suppressed.length) return;
  const inherited = await read();
  if (!isRecord(inherited)) throw new Error('Unexpected Codex MCP configuration.');
  for (const id of suppressed) {
    const entry = Object.hasOwn(inherited, id) ? inherited[id] : undefined;
    // Codex validates disabled entries too. Supply a stdio transport if there is no native one;
    // do not add a command over a native URL because Codex deep-merges the two transports.
    config[id] = isRecord(entry) && (typeof entry.url === 'string' || typeof entry.command === 'string')
      ? { enabled: false }
      : { enabled: false, command: '' };
  }
}
