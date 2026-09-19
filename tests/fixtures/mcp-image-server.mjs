// A minimal stdio MCP server that returns an image content block beside its text, used by
// tests/mcp-client.test.ts to prove the client keeps screenshots rather than lumping them into
// the text output. Kept separate from mcp-echo-server.mjs so its tool list stays untouched.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'image-fixture', version: '1.0.0' });

// A 1x1 PNG. The client only reads mimeType and data, so the bytes need only be valid base64.
export const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

server.registerTool('shot', { description: 'Returns text plus a tiny image' }, async () => ({
  content: [
    { type: 'text', text: 'captured' },
    { type: 'image', data: PIXEL_PNG, mimeType: 'image/png' }
  ]
}));

await server.connect(new StdioServerTransport());