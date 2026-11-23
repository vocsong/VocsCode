// A stdio MCP server whose tool names come from the environment, used by tests/native-mcp.test.ts
// to stand in for a built-in server (gitnexus, cua-driver) without starting the real one. Each tool
// in FAKE_TOOLS (comma-separated) answers `<name>:ran` and, when FAKE_MARKER_DIR is set, writes a
// file named after itself there, so a test can prove whether the tool actually executed.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'named-tools-fixture', version: '1.0.0' });

for (const name of (process.env.FAKE_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  server.registerTool(name, { description: `Fixture tool ${name}` }, async () => {
    if (process.env.FAKE_MARKER_DIR) await fs.writeFile(path.join(process.env.FAKE_MARKER_DIR, name), 'ran');
    return { content: [{ type: 'text', text: `${name}:ran` }] };
  });
}

await server.connect(new StdioServerTransport());
