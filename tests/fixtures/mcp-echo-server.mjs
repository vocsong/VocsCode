// A minimal stdio MCP server used by tests/mcp-client.test.ts. It lives inside the repo so its
// bare imports resolve from the project's own node_modules, and it needs no network.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture', version: '9.9.9' });

// The stamp is what makes a live smoke assertion unforgeable: a model that only claims to have
// called the tool cannot produce it, because it appears nowhere in the prompt.
export const STAMP = 'VOCSMCP9137';

server.registerTool('echo', { description: 'Says it back, stamped', inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text: `${text}:${STAMP}` }]
}));

server.registerTool('probe', { description: 'Reads VOCS_TEST_VALUE from the environment' }, async () => ({
  content: [{ type: 'text', text: process.env.VOCS_TEST_VALUE ?? '' }]
}));

await server.connect(new StdioServerTransport());
