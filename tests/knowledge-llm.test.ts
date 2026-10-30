import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createKnowledgeCompleter } from '../src/main/knowledge/llm';
import { defaultSettings } from '../src/main/settings';
import type { ProviderConfig } from '../src/shared/types';

describe('knowledge utility model requests', () => {
  it('routes standalone OpenCode Go attempts with one id per completion, preserving configured headers', async () => {
    const seen: IncomingMessage['headers'][] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (!req.headers['x-opencode-session'] || req.headers['x-opencode-client'] !== 'vocs-code') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'Request is missing x-opencode-session and cannot be routed efficiently' } }));
          return;
        }
        // An empty first answer makes knowledge retry. Both attempts belong to the same job.
        res.end(JSON.stringify({ choices: [{ message: { content: seen.length === 1 ? '' : '{"pages":[]}' }, finish_reason: 'stop' }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const provider: ProviderConfig = { id: 'go', kind: 'opencode-go', name: 'Go', enabled: true, hasApiKey: true, baseUrl: url, headers: { 'x-custom': 'kept' }, models: [] };
      const settings = { ...defaultSettings(), providers: [provider], utilityModel: { provider: 'go', model: 'go-model' } };
      const completer = createKnowledgeCompleter({ settings: () => settings, getSecret: async () => 'sk-go', log: () => undefined });
      expect(await completer.complete({ system: 'Reply in JSON', prompt: 'Summarize' })).toBe('{"pages":[]}');
      expect(seen).toHaveLength(2);
      expect(seen[0]['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
      expect(seen[1]['x-opencode-session']).toBe(seen[0]['x-opencode-session']);
      expect(await completer.complete({ system: 'Reply in JSON', prompt: 'Another job' })).toBe('{"pages":[]}');
      expect(seen).toHaveLength(3);
      expect(seen[2]['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
      expect(seen[2]['x-opencode-session']).not.toBe(seen[0]['x-opencode-session']);
      for (const headers of seen) {
        expect(headers['x-opencode-client']).toBe('vocs-code');
        expect(headers['x-custom']).toBe('kept');
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not add gateway headers to other knowledge providers', async () => {
    const seen: IncomingMessage['headers'][] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: '{"pages":[]}' }, finish_reason: 'stop' }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const provider: ProviderConfig = { id: 'other', kind: 'openai-compatible', name: 'Other', enabled: true, hasApiKey: true, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers: { 'x-custom': 'kept' }, models: [] };
      const settings = { ...defaultSettings(), providers: [provider], utilityModel: { provider: 'other', model: 'other-model' } };
      const completer = createKnowledgeCompleter({ settings: () => settings, getSecret: async () => 'sk-other', log: () => undefined });
      expect(await completer.complete({ system: 'Reply in JSON', prompt: 'Summarize' })).toBe('{"pages":[]}');
      expect(seen).toHaveLength(1);
      expect(seen[0]['x-custom']).toBe('kept');
      expect(seen[0]['x-opencode-session']).toBeUndefined();
      expect(seen[0]['x-opencode-client']).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
