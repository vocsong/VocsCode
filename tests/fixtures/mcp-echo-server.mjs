// A minimal stdio MCP server used by tests/mcp-client.test.ts. It lives inside the repo so its
// bare imports resolve from the project's own node_modules, and it needs no network.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture', version: '9.9.9' });

server.registerTool('echo', { description: 'Says it back', inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text }]
}));

server.registerTool('probe', { description: 'Reads VOCS_TEST_VALUE from the environment' }, async () => ({
  content: [{ type: 'text', text: process.env.VOCS_TEST_VALUE ?? '' }]
}));

await server.connect(new StdioServerTransport());
