// Stdio probe shared by the Pi and Claude credential-boundary tests. Never echoes the token.
import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'memory-probe', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'Memory probe instructions' });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: 'probe',
  description: 'Proves the gateway handoff without echoing the credential',
  inputSchema: {
    type: 'object',
    properties: { terms: { type: 'array', items: { type: 'string', minLength: 1 } }, scope: { enum: ['project', 'branch'] } },
    required: ['terms'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true }
}] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const token = process.env.VOCS_MEMORY_GATEWAY_TOKEN;
  const structuredContent = {
    gateway: process.env.VOCS_MEMORY_GATEWAY_URL ?? null,
    digest: token ? createHash('sha256').update(token).digest('hex') : null,
    inheritedEnvelope: Boolean(process.env.VOCS_CODE_MCP_EPHEMERAL),
    input: params.arguments
  };
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
});
await server.connect(new StdioServerTransport());
