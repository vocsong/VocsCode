/**
 * Points pi's MCP bridge at a written config whose servers answer from memory. Nothing is spawned
 * and no tool executes: `connect` is replaced, so a test sees exactly what the bridge would
 * register, and which of those tools it trusts as reads, for the definitions it was handed.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { PiMcpConnection, type PiMcpServerConfig, type PiMcpTool } from '../../resources/pi/mcp-client';
import { closeMcpBridge } from '../../resources/pi/vocs-code-mcp';

export interface StubbedBridge {
  /** Server ids the bridge actually connected to, in order. */
  connected: string[];
  /** Tool calls that reached a server; a classification test expects none. */
  calls: string[];
  restore(): Promise<void>;
}

/** Every server lists `tools`; the second argument decides each tool's read-only annotation. */
export async function stubPiMcpBridge(servers: object[], tools: (serverId: string) => PiMcpTool[]): Promise<StubbedBridge> {
  closeMcpBridge();
  const dir = await mkdtemp(path.join(tmpdir(), 'vocs-pi-mcp-stub-'));
  const file = path.join(dir, 'mcp.json');
  await writeFile(file, JSON.stringify({ servers }), 'utf8');
  const prior = process.env.VOCS_CODE_MCP_CONFIG;
  process.env.VOCS_CODE_MCP_CONFIG = file;
  const connected: string[] = [];
  const calls: string[] = [];
  const spy = vi.spyOn(PiMcpConnection, 'connect').mockImplementation(async (cfg: PiMcpServerConfig) => {
    connected.push(cfg.id);
    return {
      listTools: async () => tools(cfg.id),
      callTool: async (name: string) => {
        calls.push(`${cfg.id}:${name}`);
        return { content: [{ type: 'text' as const, text: 'stub' }] };
      },
      close: () => undefined
    } as unknown as PiMcpConnection;
  });
  return {
    connected,
    calls,
    async restore() {
      closeMcpBridge();
      spy.mockRestore();
      if (prior === undefined) delete process.env.VOCS_CODE_MCP_CONFIG;
      else process.env.VOCS_CODE_MCP_CONFIG = prior;
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** A tool list with one annotated read and one ordinary tool, the shape the memory server has. */
export function annotatedTools(): PiMcpTool[] {
  return [
    { name: 'knowledge_search', description: 'Searches', inputSchema: { type: 'object', properties: {} }, readOnly: true },
    { name: 'knowledge_propose', description: 'Writes', inputSchema: { type: 'object', properties: {} }, readOnly: false }
  ];
}
