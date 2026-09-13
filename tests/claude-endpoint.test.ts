/** Claude Code can run any Anthropic-compatible endpoint; the adapter must hand the Anthropic
 *  provider's base URL and key to the subprocess, and switch a custom gateway from x-api-key to a
 *  bearer token. Regression coverage for "Claude Code harness on other models". */
import type { AppSettings, SessionMeta } from '../src/shared/types';
import type { HarnessContext } from '../src/main/harness/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { ClaudeAdapter, claudeProviderEnv } from '../src/main/harness/claude';

function settings(opts: { useProviderKey: boolean; baseUrl?: string }): AppSettings {
  return {
    claude: { runtime: 'auto', useProviderKey: opts.useProviderKey, settingSources: [] },
    providers: [{ id: 'anthropic', kind: 'anthropic', name: 'Anthropic', baseUrl: opts.baseUrl, hasApiKey: false, models: [], enabled: true }]
  } as unknown as AppSettings;
}

const meta: SessionMeta = {
  id: 's1',
  title: 't',
  createdAt: 0,
  updatedAt: 0,
  config: { harness: 'claude', projectRoot: '.', permissionMode: 'ask' },
  cwd: '.',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
};

function stubCtx(s: AppSettings, apiKey: string | undefined): HarnessContext {
  return {
    sessionId: 's1',
    session: () => meta,
    settings: () => s,
    runtime: { resolve: () => undefined },
    sessionDir: '.',
    permissionMode: () => 'ask' as const,
    effort: () => undefined,
    getApiKey: async () => apiKey,
    mcpServers: async () => [],
    emit: () => {},
    requestApproval: async () => ({ optionId: 'deny' }) as never,
    updateRef: () => {},
    updateMeta: () => {},
    log: () => {},
    readJson: async () => null,
    writeJson: async () => {}
  } as unknown as HarnessContext;
}

/** Captures the options the adapter passes to the SDK by starting once with an empty message stream. */
async function envFor(s: AppSettings, apiKey: string | undefined): Promise<Record<string, string | undefined>> {
  queryMock.mockReset();
  queryMock.mockReturnValue((async function* () {})());
  await new ClaudeAdapter(stubCtx(s, apiKey)).start();
  return (queryMock.mock.calls[0][0] as { options: { env: Record<string, string | undefined> } }).options.env;
}

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
});

describe('Claude Code endpoint env', () => {
  it('leaves the login untouched when the opt-in is off', () => {
    expect(claudeProviderEnv(settings({ useProviderKey: false, baseUrl: 'https://api.z.ai/api/anthropic' }), 'sk-gateway')).toEqual({});
  });

  it('passes the stored key as x-api-key for the default Anthropic endpoint', () => {
    expect(claudeProviderEnv(settings({ useProviderKey: true, baseUrl: 'https://api.anthropic.com' }), 'sk-ant')).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant'
    });
  });

  it('retargets a custom gateway with a bearer token and drops the inherited x-api-key', () => {
    expect(claudeProviderEnv(settings({ useProviderKey: true, baseUrl: 'https://api.z.ai/api/anthropic' }), 'sk-gateway')).toEqual({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-gateway'
    });
  });

  it('normalizes a trailing slash on the base URL', () => {
    expect(claudeProviderEnv(settings({ useProviderKey: true, baseUrl: 'https://openrouter.ai/api/anthropic/' }), 'k').ANTHROPIC_BASE_URL).toBe(
      'https://openrouter.ai/api/anthropic'
    );
  });

  it('does nothing when the opt-in is on but no key is stored', () => {
    expect(claudeProviderEnv(settings({ useProviderKey: true, baseUrl: 'https://api.z.ai/api/anthropic' }), undefined)).toEqual({});
  });

  it('falls back to the key alone when the Anthropic provider has no base URL', () => {
    expect(claudeProviderEnv(settings({ useProviderKey: true }), 'sk-ant')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant' });
  });

  it('hands the gateway URL and bearer token to the Claude Code process, clearing an inherited x-api-key', async () => {
    process.env.ANTHROPIC_API_KEY = 'inherited-real-key';
    const env = await envFor(settings({ useProviderKey: true, baseUrl: 'https://api.z.ai/api/anthropic' }), 'sk-gateway');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-gateway');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('keeps the default endpoint and inherited login when the opt-in is off', async () => {
    process.env.ANTHROPIC_API_KEY = 'inherited-real-key';
    const env = await envFor(settings({ useProviderKey: false, baseUrl: 'https://api.z.ai/api/anthropic' }), 'sk-gateway');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('inherited-real-key');
  });
});
