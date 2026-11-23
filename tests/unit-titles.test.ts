import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { generateBranchName, generateSessionTitle, sanitizeLlmTitle, titleFromPrompt } from '../src/main/session-title';
import type { ProviderConfig } from '../src/shared/types';

/** Starts an HTTP server that answers every request via respond(); resolves once it is listening. */
function listenOnce(respond: (req: IncomingMessage, res: ServerResponse, body?: string) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body: string | undefined;
    req.on('data', (c: Buffer) => (body = (body ?? '') + c.toString()));
    req.on('end', () => respond(req, res, body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('auto session titles', () => {
  it('caps derived titles at 6 words and marks the cut', () => {
    // Unmarked, the row reads as a title someone wrote badly rather than as the stand-in it is.
    expect(titleFromPrompt('Fix the bug where the sidebar flickers when switching folders')).toBe('Fix the bug where the sidebar…');
  });

  it('keeps short prompts whole and only uses the first line', () => {
    expect(titleFromPrompt('Add dark mode')).toBe('Add dark mode');
    expect(titleFromPrompt('First line stays\nsecond line ignored')).toBe('First line stays');
    expect(titleFromPrompt('Six words exactly stay uncut here')).toBe('Six words exactly stay uncut here');
  });

  it('still enforces the 60 char cap on long words', () => {
    const title = titleFromPrompt('Supercalifragilisticexpialidocious antidisestablishmentarianism floccinaucinihilipilification');
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('LLM session titles', () => {
  const getSecret = async (id: string) => (id === 'fake' ? 'sk-test' : undefined);

  it('strips quotes and preamble from model replies', () => {
    // A model asked for 6 words regularly writes 7 or 8; chopping those to 6 was itself a source
    // of half-sentence titles, so the reply keeps its words up to the sidebar's own limit.
    expect(sanitizeLlmTitle('"Fix the sidebar flicker on folder switch"')).toBe('Fix the sidebar flicker on folder switch');
    expect(sanitizeLlmTitle('**Fix the sidebar flicker**')).toBe('Fix the sidebar flicker');
    expect(sanitizeLlmTitle('Title: Refactor auth module.')).toBe('Refactor auth module');
    expect(sanitizeLlmTitle('  \n\n  ')).toBeNull();
  });

  it('marks a reply that runs past the sidebar cap instead of ending it mid-word', () => {
    const title = sanitizeLlmTitle('Investigate alerts and warnings and errors and everything else reported today');
    expect(title).toBe('Investigate alerts and warnings and errors and everything…');
  });

  it('rejects leaked chat-template control tokens instead of titling with them', () => {
    // DeepSeek answers a title request with its DSML tool-call marker when the provider fails to
    // parse the call out; one arrived mangled (` calls>`) in a real session title.
    expect(sanitizeLlmTitle('<｜DSML｜tool_calls>')).toBeNull();
    expect(sanitizeLlmTitle('<｜DSML｜ calls>')).toBeNull();
    expect(sanitizeLlmTitle('<|im_start|>Fix the sidebar flicker')).toBeNull();
  });

  it('returns null when no enabled provider has a usable key', async () => {
    const providers = [{
      id: 'anthropic', kind: 'anthropic', name: 'Anthropic', enabled: true, hasApiKey: false, models: []
    }];
    const title = await generateSessionTitle('Fix the bug', providers as never, getSecret);
    expect(title).toBeNull();
  });

  it('ignores disabled providers', async () => {
    const providers = [{
      id: 'anthropic', kind: 'anthropic', name: 'Anthropic', enabled: false, hasApiKey: true, models: []
    }];
    const title = await generateSessionTitle('Fix the bug', providers as never, getSecret);
    expect(title).toBeNull();
  });

  it('falls back to the first usable provider when the preferred one is unusable', async () => {
    const unusable = { id: 'unused', kind: 'openai' as const, name: 'Unused', enabled: true, hasApiKey: false, models: [{ id: 'm1', name: 'M1', provider: 'unused' }] };
    const usable = { id: 'fallback', kind: 'ollama' as const, name: 'Fallback', enabled: true, hasApiKey: false, baseUrl: 'http://127.0.0.1:1', models: [] };
    // The fallback provider points at a closed port, so the call fails and the title stays null —
    // but reaching that failure proves the fallback provider was chosen over the unusable one.
    const title = await generateSessionTitle('Fix the bug', [unusable, usable] as never, getSecret, { provider: 'unused', model: 'm1' });
    expect(title).toBeNull();
  });

  it('names sessions end-to-end against an OpenAI-compatible endpoint, using the preferred provider', async () => {
    const seen: { auth?: string; body?: Record<string, unknown> } = {};
    const server = await listenOnce((req, res, body) => {
      seen.auth = req.headers.authorization;
      seen.body = JSON.parse(body ?? '{}') as Record<string, unknown>;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '"Fix the sidebar flicker"' }, finish_reason: 'stop' }] }));
    });
    try {
      const provider = { id: 'fake', kind: 'openai-compatible' as const, name: 'Fake', enabled: true, hasApiKey: true, baseUrl: server.url, models: [{ id: 'cheap-flash', name: 'Cheap Flash', provider: 'fake' }] };
      const title = await generateSessionTitle('Fix the bug', [provider] as never, getSecret, { provider: 'fake', model: 'cheap-flash' });
      expect(title).toBe('Fix the sidebar flicker');
      expect(seen.auth).toBe('Bearer sk-test');
      expect(seen.body?.model).toBe('cheap-flash');
      expect(seen.body?.max_tokens).toBe(200);
      expect(seen.body?.max_completion_tokens).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('names an OpenCode Go session when the gateway requires routing headers', async () => {
    const seen: IncomingMessage['headers'][] = [];
    const server = await listenOnce((req, res) => {
      seen.push(req.headers);
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-opencode-session'] !== 's_existing' || req.headers['x-opencode-client'] !== 'vocs-code') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'Request is missing x-opencode-session and cannot be routed efficiently' } }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: 'Fix utility routing' }, finish_reason: 'stop' }] }));
    });
    try {
      const provider: ProviderConfig = { id: 'go', kind: 'opencode-go', name: 'OpenCode Go', enabled: true, hasApiKey: true, baseUrl: server.url, headers: { 'x-custom': 'kept' }, models: [] };
      expect(await generateSessionTitle('Fix utility routing', [provider], async () => 'sk-go', { provider: 'go', model: 'go-model' }, undefined, 's_existing')).toBe('Fix utility routing');
      expect(seen).toHaveLength(1);
      expect(seen[0]['x-custom']).toBe('kept');
    } finally {
      await server.close();
    }
  });

  it('uses max_completion_tokens with low effort for reasoning models', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const server = await listenOnce((req, res, body) => {
      seen.body = JSON.parse(body ?? '{}') as Record<string, unknown>;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'Migrate auth to OAuth' }, finish_reason: 'stop' }] }));
    });
    try {
      const provider = { id: 'fake', kind: 'openai-compatible' as const, name: 'Fake', enabled: true, hasApiKey: true, baseUrl: server.url, models: [] };
      const title = await generateSessionTitle('Migrate the auth module', [provider] as never, getSecret, { provider: 'fake', model: 'gpt-5-mini' });
      expect(title).toBe('Migrate auth to OAuth');
      expect(seen.body?.max_tokens).toBeUndefined();
      expect(seen.body?.max_completion_tokens).toBe(1024);
      expect(seen.body?.reasoning_effort).toBe('low');
    } finally {
      await server.close();
    }
  });

  it('gives a thinking model room to think before it writes the title', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const server = await listenOnce((_req, res, body) => {
      seen.body = JSON.parse(body ?? '{}') as Record<string, unknown>;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'Investigate alert completeness' }, finish_reason: 'stop' }] }));
    });
    try {
      // A 200-token budget shared with a chain of thought is what left `Investigate alerts and`
      // in the sidebar; the catalog says this model thinks, so it gets the bigger budget.
      const models = [{ id: 'deepseek-flash', provider: 'fake', displayName: 'Flash', supportsReasoning: true }];
      const provider = { id: 'fake', kind: 'deepseek' as const, name: 'Fake', enabled: true, hasApiKey: true, baseUrl: server.url, models };
      const title = await generateSessionTitle('there are many warnings today', [provider] as never, getSecret, { provider: 'fake', model: 'deepseek-flash' });
      expect(title).toBe('Investigate alert completeness');
      expect(seen.body?.max_tokens).toBe(2048);
    } finally {
      await server.close();
    }
  });

  it('keeps the placeholder when the reply was cut off by the token budget', async () => {
    const server = await listenOnce((_req, res) => {
      res.setHeader('content-type', 'application/json');
      // A real reply from a thinking model that spent its budget: a fragment ending on a conjunction.
      res.end(JSON.stringify({ choices: [{ message: { content: 'Investigate alerts and' }, finish_reason: 'length' }] }));
    });
    try {
      const provider = { id: 'fake', kind: 'openai-compatible' as const, name: 'Fake', enabled: true, hasApiKey: true, baseUrl: server.url, models: [] };
      const title = await generateSessionTitle('there are many warnings today', [provider] as never, getSecret, { provider: 'fake', model: 'cheap-flash' });
      expect(title).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('keeps the placeholder when an Anthropic reply stopped at max_tokens', async () => {
    const server = await listenOnce((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x', stop_reason: 'max_tokens', stop_sequence: null,
        content: [{ type: 'text', text: 'Investigate alerts and' }], usage: { input_tokens: 1, output_tokens: 1 }
      }));
    });
    try {
      const provider = { id: 'fake', kind: 'anthropic' as const, name: 'Fake', enabled: true, hasApiKey: true, baseUrl: server.url, models: [] };
      const title = await generateSessionTitle('there are many warnings today', [provider] as never, getSecret, { provider: 'fake', model: 'claude-x' });
      expect(title).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('names a worktree branch for the intent of the prompt with the same background model', async () => {
    const seen: { body?: { model?: string; messages?: { role: string; content: string }[] } } = {};
    const server = await listenOnce((_req, res, body) => {
      seen.body = JSON.parse(body ?? '{}');
      res.setHeader('content-type', 'application/json');
      // The model adds a type prefix and quotes anyway; the user picks the prefix, so it is dropped.
      res.end(JSON.stringify({ choices: [{ message: { content: '"fix/oauth-callback-redirect"' }, finish_reason: 'stop' }] }));
    });
    try {
      const provider = { id: 'fake', kind: 'openai-compatible' as const, name: 'Fake', enabled: true, hasApiKey: true, baseUrl: server.url, models: [{ id: 'cheap-flash', name: 'Cheap Flash', provider: 'fake' }] };
      const prompt = 'Can you please look into why signing in with Google sends people back to the home page';
      const name = await generateBranchName(prompt, [provider] as never, getSecret, { provider: 'fake', model: 'cheap-flash' });
      expect(name).toBe('oauth-callback-redirect');
      expect(seen.body?.model).toBe('cheap-flash');
      expect(seen.body?.messages?.[0]).toMatchObject({ role: 'system' });
      expect(seen.body?.messages?.[0].content).toContain('git branches');
      expect(seen.body?.messages?.[1]).toEqual({ role: 'user', content: prompt });
    } finally {
      await server.close();
    }
  });

  it('names branches with a standalone OpenCode Go routing id, without changing other providers headers', async () => {
    const seen: IncomingMessage['headers'][] = [];
    const server = await listenOnce((req, res) => {
      seen.push(req.headers);
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-custom'] !== 'kept' || (req.headers['x-provider'] !== 'ordinary' &&
        (!req.headers['x-opencode-session'] || req.headers['x-opencode-client'] !== 'vocs-code'))) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'Request is missing x-opencode-session and cannot be routed efficiently' } }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: 'fix-utility-routing' }, finish_reason: 'stop' }] }));
    });
    try {
      const base: ProviderConfig = { id: 'go', kind: 'opencode-go', name: 'Go', enabled: true, hasApiKey: true, baseUrl: server.url, headers: { 'x-custom': 'kept' }, models: [] };
      expect(await generateBranchName('Fix utility routing', [base], async () => 'sk-go', { provider: 'go', model: 'go-model' })).toBe('fix-utility-routing');
      expect(await generateBranchName('Fix utility routing', [base], async () => 'sk-go', { provider: 'go', model: 'go-model' })).toBe('fix-utility-routing');
      const ordinary: ProviderConfig = { ...base, id: 'ordinary', kind: 'openai-compatible', headers: { 'x-custom': 'kept', 'x-provider': 'ordinary' } };
      expect(await generateBranchName('Fix utility routing', [ordinary], async () => 'sk-test', { provider: 'ordinary', model: 'other-model' })).toBe('fix-utility-routing');
      expect(seen).toHaveLength(3);
      expect(seen[0]['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
      expect(seen[1]['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
      expect(seen[1]['x-opencode-session']).not.toBe(seen[0]['x-opencode-session']);
      expect(seen[2]['x-opencode-session']).toBeUndefined();
      expect(seen[2]['x-opencode-client']).toBeUndefined();
      expect(seen[2]['x-provider']).toBe('ordinary');
    } finally {
      await server.close();
    }
  });

  it('returns no branch name when no model is usable or its reply was cut off', async () => {
    expect(await generateBranchName('Fix the bug', [], getSecret)).toBeNull();
    const server = await listenOnce((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'fix-the' }, finish_reason: 'length' }] }));
    });
    try {
      const provider = { id: 'fake', kind: 'openai-compatible' as const, name: 'Fake', enabled: true, hasApiKey: true, baseUrl: server.url, models: [] };
      expect(await generateBranchName('Fix the bug', [provider] as never, getSecret, { provider: 'fake', model: 'cheap-flash' })).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('returns null when the reply is leaked DeepSeek tool-call markup, keeping the placeholder', async () => {
    const seen: { model?: unknown } = {};
    const server = await listenOnce((_req, res, body) => {
      seen.model = (JSON.parse(body ?? '{}') as Record<string, unknown>).model;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '<｜DSML｜ calls>' }, finish_reason: 'stop' }] }));
    });
    try {
      const provider = { id: 'fake', kind: 'openai-compatible' as const, name: 'Fake', enabled: true, hasApiKey: true, baseUrl: server.url, models: [] };
      const title = await generateSessionTitle('Fix the bug', [provider] as never, getSecret, { provider: 'fake', model: 'cheap-flash' });
      // The call really reached the endpoint: null is the rejection, not an unusable provider.
      expect(seen.model).toBe('cheap-flash');
      expect(title).toBeNull();
    } finally {
      await server.close();
    }
  });
});
