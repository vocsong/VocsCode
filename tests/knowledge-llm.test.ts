import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeCompleter } from '../src/main/knowledge/llm';
import { defaultSettings } from '../src/main/settings';
import type { AppSettings, ProviderConfig } from '../src/shared/types';

const utility = { provider: 'pinned', model: 'utility' };
const request = { system: 'Reply in JSON', prompt: 'Summarize', onlyUtilityModel: utility };

function provider(id: string): ProviderConfig {
  return { id, kind: 'openai-compatible', name: id, enabled: true, hasApiKey: true, baseUrl: `https://${id}.example/v1`, models: [{ id: 'default', provider: id, displayName: 'Default model' }] };
}

function fixtureSettings(): AppSettings {
  return { ...defaultSettings(), providers: [provider('fallback'), provider(utility.provider)], utilityModel: { ...utility } };
}

afterEach(() => vi.unstubAllGlobals());

describe('knowledge utility model requests', () => {
  it.each([
    { why: 'not explicitly selected', change: (s: AppSettings) => { s.utilityModel = undefined; } },
    { why: 'selected with another model', change: (s: AppSettings) => { s.utilityModel!.model = 'different'; } },
    { why: 'replaced by another provider', change: (s: AppSettings) => { s.utilityModel!.provider = 'fallback'; } },
    { why: 'disabled', change: (s: AppSettings) => { s.providers[1].enabled = false; } },
    { why: 'removed', change: (s: AppSettings) => { s.providers.pop(); } },
    { why: 'missing a compatible endpoint', change: (s: AppSettings) => { s.providers[1].baseUrl = undefined; } }
  ])('does not dispatch when the pinned utility is $why', async ({ change }) => {
    const settings = fixtureSettings();
    change(settings);
    const network = vi.fn();
    const getSecret = vi.fn(async () => 'unused-key');
    vi.stubGlobal('fetch', network);
    const completer = createKnowledgeCompleter({ settings: () => settings, getSecret, log: () => undefined });

    await expect(completer.complete(request)).resolves.toBeNull();
    expect(getSecret).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'missing credentials'])('does not dispatch after resolving credentials when the utility is %s', async (reason) => {
    const settings = fixtureSettings();
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const getSecret = vi.fn(async () => {
      if (reason === 'missing credentials') return undefined;
      settings.utilityModel = undefined;
      return 'formerly-selected-key';
    });
    const completer = createKnowledgeCompleter({ settings: () => settings, getSecret, log: () => undefined });

    await expect(completer.complete(request)).resolves.toBeNull();
    expect(getSecret).toHaveBeenCalledExactlyOnceWith(utility.provider);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['empty answer', 'rate limit'])('does not resend or fall back when selection changes after a %s', async (response) => {
    const settings = fixtureSettings();
    const network = vi.fn<typeof fetch>(async () => {
      settings.utilityModel = { provider: 'fallback', model: 'utility' };
      return response === 'empty answer'
        ? Response.json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] })
        : Response.json({ error: { message: 'Try again' } }, { status: 429, headers: { 'retry-after-ms': '1' } });
    });
    vi.stubGlobal('fetch', network);
    const completer = createKnowledgeCompleter({ settings: () => settings, getSecret: async () => 'pinned-key', log: () => undefined });

    await expect(completer.complete(request)).resolves.toBeNull();
    expect(network).toHaveBeenCalledTimes(1);
    const [url, init] = network.mock.calls[0];
    expect(String(url)).toBe('https://pinned.example/v1/chat/completions');
    expect(JSON.parse(String(init?.body)).model).toBe(utility.model);
  });

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
      expect(await completer.complete({ system: 'Reply in JSON', prompt: 'Summarize', onlyUtilityModel: settings.utilityModel })).toBe('{"pages":[]}');
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
