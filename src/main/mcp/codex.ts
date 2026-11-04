import { runCapture } from '../runtime';
import { isValidServerId } from './file';

/** Reads effective Codex config without starting servers; only ids leave this boundary. */
export async function readCodexMcpServerIds(command: string, cwd: string): Promise<string[]> {
  try {
    const result = await runCapture(command, ['mcp', 'list', '--json'], { cwd, timeoutMs: 5_000 });
    if (result.code !== 0 || result.truncated || result.timedOut) return [];
    const servers: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(servers)) return [];
    const ids = new Set<string>();
    for (const server of servers) {
      if (!server || typeof server !== 'object' || Array.isArray(server)) continue;
      const { name, transport } = server;
      if (typeof name !== 'string' || !isValidServerId(name) || !transport || typeof transport !== 'object' || Array.isArray(transport)) continue;
      const valid = transport.type === 'stdio'
        ? typeof transport.command === 'string' && !!transport.command.trim()
        : transport.type === 'streamable_http' && typeof transport.url === 'string' && !!transport.url.trim();
      if (valid) ids.add(name);
    }
    return [...ids];
  } catch {
    // Probe errors may contain native credentials. Neither output nor errors reach logs or argv.
    return [];
  }
}
