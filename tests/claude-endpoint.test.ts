/** Claude Code can run any Anthropic-compatible endpoint, so the harness must (a) offer the models
 *  of every anthropic-kind provider, (b) wire the selected model's endpoint and key into the
 *  subprocess, and (c) use a bearer token for a gateway. Regression coverage for "Claude Code on
 *  other models". */
import type { AppSettings, ModelRef, ProviderConfig, SessionEvent, SessionMeta } from '../src/shared/types';
import type { HarnessContext } from '../src/main/harness/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { queryMock, setModelMock } = vi.hoisted(() => ({ queryMock: vi.fn(), setModelMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { ClaudeAdapter, claudeProviderEnv, claudeProviderFor } from '../src/main/harness/claude';

const ANTHROPIC: ProviderConfig = { id: 'anthropic', kind: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', hasApiKey: false, models: [], enabled: true };
const GATEWAY: ProviderConfig = { id: 'zai', kind: 'anthropic', name: 'Z.AI (GLM)', baseUrl: 'https://api.z.ai/api/anthropic', hasApiKey: false, models: [], enabled: true };
const OPENROUTER: ProviderConfig = { id: 'openrouter', kind: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', hasApiKey: false, models: [], enabled: true };
const DEEPSEEK: ProviderConfig = { id: 'deepseek', kind: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', hasApiKey: false, models: [], enabled: true };
const OPENAI: ProviderConfig = { id: 'openai', kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', hasApiKey: false, models: [], enabled: true };

function settings(opts: { useProviderKey?: boolean; providers?: ProviderConfig[] } = {}): AppSettings {
  return {
    claude: { runtime: 'auto', useProviderKey: opts.useProviderKey ?? false, settingSources: [] },
    providers: opts.providers ?? [ANTHROPIC]
  } as unknown as AppSettings;
}

function metaFor(model: ModelRef | undefined): SessionMeta {
  return {
    id: 's1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'claude', projectRoot: '.', permissionMode: 'ask', model },
    cwd: '.',
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  };
}

function stubCtx(s: AppSettings, model: ModelRef | undefined, apiKey: string | undefined, events: SessionEvent[] = []): HarnessContext {
  return {
    sessionId: 's1',
    session: () => metaFor(model),
    settings: () => s,
    runtime: { resolve: () => undefined },
    sessionDir: '.',
    permissionMode: () => 'ask' as const,
    effort: () => undefined,
    getApiKey: async () => apiKey,
    mcpServers: async () => [],
    emit: (e: SessionEvent) => events.push(e),
    requestApproval: async () => ({ optionId: 'deny' }) as never,
    updateRef: () => {},
    updateMeta: () => {},
    log: () => {},
    readJson: async () => null,
    writeJson: async () => {}
  } as unknown as HarnessContext;
}

/** Starts once against an empty message stream and captures the env handed to the SDK. */
async function envFor(s: AppSettings, model: ModelRef | undefined, apiKey: string | undefined): Promise<Record<string, string | undefined>> {
  queryMock.mockReset();
  setModelMock.mockReset();
  queryMock.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, setModel: setModelMock, close: vi.fn(), interrupt: vi.fn() });
  await new ClaudeAdapter(stubCtx(s, model, apiKey)).start();
  return (queryMock.mock.calls[0][0] as { options: { env: Record<string, string | undefined> } }).options.env;
}

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

describe('Claude provider resolution', () => {
  it('uses the provider the model came from', () => {
    expect(claudeProviderFor(settings({ providers: [ANTHROPIC, GATEWAY] }), { provider: 'zai', model: 'glm-4.6' })?.id).toBe('zai');
    expect(claudeProviderFor(settings({ providers: [ANTHROPIC, OPENROUTER] }), { provider: 'openrouter', model: 'z-ai/glm-4.6' })?.id).toBe('openrouter');
  });

  it('falls back to the built-in Anthropic provider for an unknown or absent provider', () => {
    expect(claudeProviderFor(settings({ providers: [ANTHROPIC, GATEWAY] }), undefined)?.id).toBe('anthropic');
    expect(claudeProviderFor(settings({ providers: [ANTHROPIC, GATEWAY] }), { provider: 'openai', model: 'gpt-x' })?.id).toBe('anthropic');
  });

  it('never resolves to a provider that cannot host Claude Code', () => {
    expect(claudeProviderFor(settings({ providers: [OPENAI] }), { provider: 'openai', model: 'gpt-x' })).toBeUndefined();
  });
});

describe('Claude endpoint env', () => {
  it('leaves the login untouched on the default endpoint when the opt-in is off', () => {
    expect(claudeProviderEnv(settings(), ANTHROPIC, 'sk-ant')).toEqual({});
  });

  it('passes the stored key as x-api-key for Anthropic\u2019s own endpoint when the opt-in is on', () => {
    expect(claudeProviderEnv(settings({ useProviderKey: true }), ANTHROPIC, 'sk-ant')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant' });
  });

  it('wires a gateway with a bearer token and drops the inherited x-api-key', () => {
    expect(claudeProviderEnv(settings(), GATEWAY, 'sk-gateway')).toEqual({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-gateway'
    });
  });

  it('still retargets a gateway with no stored key, clearing an inherited x-api-key', () => {
    expect(claudeProviderEnv(settings(), GATEWAY, undefined)).toEqual({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic'
    });
  });

  it('routes a mapped vendor to its own Anthropic endpoint with a bearer token', () => {
    expect(claudeProviderEnv(settings(), OPENROUTER, 'sk-or')).toEqual({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-or'
    });
    expect(claudeProviderEnv(settings(), DEEPSEEK, 'sk-ds').ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
  });

  it('leaves a provider with no Anthropic route alone', () => {
    expect(claudeProviderEnv(settings(), OPENAI, 'sk-openai')).toEqual({});
  });

  it('normalizes a trailing slash and does nothing without a provider', () => {
    expect(claudeProviderEnv(settings(), { ...GATEWAY, baseUrl: 'https://openrouter.ai/api/anthropic/' }, 'k').ANTHROPIC_BASE_URL).toBe(
      'https://openrouter.ai/api/anthropic'
    );
    expect(claudeProviderEnv(settings(), undefined, 'k')).toEqual({});
  });

  it('hands the selected gateway model\u2019s endpoint and key to the Claude Code process', async () => {
    process.env.ANTHROPIC_API_KEY = 'inherited-real-key';
    const env = await envFor(settings({ providers: [ANTHROPIC, GATEWAY] }), { provider: 'zai', model: 'glm-4.6' }, 'sk-gateway');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-gateway');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('keeps the inherited login for a model on the default endpoint with the opt-in off', async () => {
    process.env.ANTHROPIC_API_KEY = 'inherited-real-key';
    const env = await envFor(settings({ providers: [ANTHROPIC, GATEWAY] }), { provider: 'anthropic', model: 'claude-sonnet-5' }, 'sk-ant');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('inherited-real-key');
  });
});

describe('Claude endpoint is fixed for the process', () => {
  it('refuses a mid-session switch to a model from another provider', async () => {
    queryMock.mockReset();
    queryMock.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, setModel: setModelMock, close: vi.fn(), interrupt: vi.fn() });
    const adapter = new ClaudeAdapter(stubCtx(settings({ providers: [ANTHROPIC, GATEWAY] }), { provider: 'zai', model: 'glm-4.6' }, 'sk-gateway'));
    await adapter.start();
    await expect(adapter.setModel({ provider: 'anthropic', model: 'claude-sonnet-5' })).rejects.toThrow(/runs on the zai endpoint/);
    expect(setModelMock).not.toHaveBeenCalled();
    await adapter.setModel({ provider: 'zai', model: 'glm-4.5' });
    expect(setModelMock).toHaveBeenCalledWith('glm-4.5');
  });
});

describe('Claude model reporting', () => {
  /** handle() is private; drive it directly with SDK-shaped messages. */
  const feed = (adapter: ClaudeAdapter, msg: Record<string, unknown>): void => {
    (adapter as unknown as { handle: (m: unknown, q: unknown) => void }).handle(msg as never, queryMock.mock.results[0]?.value);
  };

  it('keeps the settings catalog for a gateway instead of the SDK Anthropic list', async () => {
    const supportedModels = vi.fn().mockResolvedValue([{ value: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' }]);
    queryMock.mockReset();
    queryMock.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, supportedModels, close: vi.fn(), interrupt: vi.fn() });
    const events: SessionEvent[] = [];
    const adapter = new ClaudeAdapter(stubCtx(settings({ providers: [ANTHROPIC, GATEWAY] }), { provider: 'zai', model: 'glm-4.6' }, 'sk-gateway', events));
    await adapter.start();
    feed(adapter, { type: 'system', subtype: 'init', session_id: 'sdk1', model: 'glm-4.6' });
    await new Promise((r) => setTimeout(r, 0));
    expect(supportedModels).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'models')).toBe(false);
  });

  it('still reports the SDK catalog on Anthropic\u2019s own endpoint', async () => {
    const supportedModels = vi.fn().mockResolvedValue([{ value: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' }]);
    queryMock.mockReset();
    queryMock.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, supportedModels, close: vi.fn(), interrupt: vi.fn() });
    const events: SessionEvent[] = [];
    const adapter = new ClaudeAdapter(stubCtx(settings(), { provider: 'anthropic', model: 'claude-sonnet-5' }, 'sk-ant', events));
    await adapter.start();
    feed(adapter, { type: 'system', subtype: 'init', session_id: 'sdk1', model: 'claude-sonnet-5' });
    await new Promise((r) => setTimeout(r, 0));
    expect(events.find((e) => e.type === 'models')).toMatchObject({ models: [expect.objectContaining({ id: 'claude-sonnet-5', provider: 'anthropic' })] });
  });
});
