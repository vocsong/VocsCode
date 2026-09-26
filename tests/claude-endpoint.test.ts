/** Claude Code can run any Anthropic-compatible endpoint, so the harness must (a) offer the models
 *  of every anthropic-kind provider, (b) wire the selected model's endpoint and key into the
 *  subprocess, the pre-session model probe included, and (c) use a bearer token for a gateway.
 *  Regression coverage for "Claude Code on other models". */
import type { AppSettings, ModelRef, ProviderConfig, SessionEvent, SessionMeta } from '../src/shared/types';
import type { HarnessContext } from '../src/main/harness/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { queryMock, setModelMock } = vi.hoisted(() => ({ queryMock: vi.fn(), setModelMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { ClaudeAdapter, claudeProviderEnv, claudeProviderFor } from '../src/main/harness/claude';
import { listHarnessModels } from '../src/main/harness/registry';

const ANTHROPIC: ProviderConfig = { id: 'anthropic', kind: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', hasApiKey: false, models: [], enabled: true };
const GATEWAY: ProviderConfig = { id: 'zai', kind: 'anthropic', name: 'Z.AI (GLM)', baseUrl: 'https://api.z.ai/api/anthropic', hasApiKey: false, models: [], enabled: true };
const OPENROUTER: ProviderConfig = { id: 'openrouter', kind: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', hasApiKey: false, models: [], enabled: true };
const DEEPSEEK: ProviderConfig = { id: 'deepseek', kind: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', hasApiKey: false, models: [], enabled: true };
const OPENCODE_GO: ProviderConfig = { id: 'opencode-go', kind: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', hasApiKey: false, models: [], enabled: true };
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
    ownedMcpIds: () => [],
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
    expect(claudeProviderEnv(settings(), DEEPSEEK, 'sk-ds').ANTHROPIC_AUTH_TOKEN).toBe('sk-ds');
  });

  it('sends an OpenCode Go key as x-api-key, the header Zen\u2019s Anthropic route reads', () => {
    // A bearer token there is answered with `401 Missing API key`, so the key must not go in
    // ANTHROPIC_AUTH_TOKEN, and an inherited one must not survive either.
    const env = claudeProviderEnv(settings(), OPENCODE_GO, 'sk-go');
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-go', ANTHROPIC_BASE_URL: 'https://opencode.ai/zen/go' });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    const withoutKey = claudeProviderEnv(settings(), OPENCODE_GO, undefined);
    expect(withoutKey.ANTHROPIC_API_KEY).toBeUndefined();
    expect(withoutKey.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(withoutKey.ANTHROPIC_BASE_URL).toBe('https://opencode.ai/zen/go');
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

  it('hands an OpenCode Go session the key as x-api-key and no bearer token', async () => {
    process.env.ANTHROPIC_API_KEY = 'inherited-real-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'inherited-bearer';
    const env = await envFor(settings({ providers: [ANTHROPIC, OPENCODE_GO] }), { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, 'sk-go');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://opencode.ai/zen/go');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-go');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('keeps the inherited login for a model on the default endpoint with the opt-in off', async () => {
    process.env.ANTHROPIC_API_KEY = 'inherited-real-key';
    const env = await envFor(settings({ providers: [ANTHROPIC, GATEWAY] }), { provider: 'anthropic', model: 'claude-sonnet-5' }, 'sk-ant');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('inherited-real-key');
  });
});

describe('Claude model probe credentials', () => {
  // The built-in Anthropic provider as settings.ts ships it, and the same provider behind a proxy.
  const BUILTIN: ProviderConfig = { ...ANTHROPIC, envKey: 'ANTHROPIC_API_KEY' };
  const PROXY_URL = 'https://llm-proxy.corp.example/anthropic';
  const PROXIED: ProviderConfig = { ...BUILTIN, baseUrl: PROXY_URL };

  interface Case {
    name: string;
    provider: ProviderConfig;
    useProviderKey: boolean;
    /** Key in the app's secret store. */
    stored?: string;
    /** Key in the provider's env var. */
    fromEnv?: string;
    /** Endpoint and credential variables Claude Code must start with; anything absent is unset. */
    expected: Record<string, string>;
  }
  const cases: Case[] = [
    // Anthropic's own endpoint takes the stored key only with the opt-in; otherwise the login or an inherited key stays.
    { name: 'Anthropic endpoint, opt-in off, stored key', provider: BUILTIN, useProviderKey: false, stored: 'sk-stored', expected: {} },
    { name: 'Anthropic endpoint, opt-in off, env key', provider: BUILTIN, useProviderKey: false, fromEnv: 'sk-env', expected: { ANTHROPIC_API_KEY: 'sk-env' } },
    { name: 'Anthropic endpoint, opt-in on, stored key', provider: BUILTIN, useProviderKey: true, stored: 'sk-stored', expected: { ANTHROPIC_API_KEY: 'sk-stored' } },
    { name: 'Anthropic endpoint, opt-in on, env key', provider: BUILTIN, useProviderKey: true, fromEnv: 'sk-env', expected: { ANTHROPIC_API_KEY: 'sk-env' } },
    // A proxy gets the key as a bearer token whatever the opt-in says, and never the inherited x-api-key.
    { name: 'proxy, opt-in off, stored key', provider: PROXIED, useProviderKey: false, stored: 'sk-stored', expected: { ANTHROPIC_AUTH_TOKEN: 'sk-stored', ANTHROPIC_BASE_URL: PROXY_URL } },
    { name: 'proxy, opt-in off, env key', provider: PROXIED, useProviderKey: false, fromEnv: 'sk-env', expected: { ANTHROPIC_AUTH_TOKEN: 'sk-env', ANTHROPIC_BASE_URL: PROXY_URL } },
    { name: 'proxy, opt-in on, stored key', provider: PROXIED, useProviderKey: true, stored: 'sk-stored', expected: { ANTHROPIC_AUTH_TOKEN: 'sk-stored', ANTHROPIC_BASE_URL: PROXY_URL } },
    { name: 'proxy, opt-in on, env key', provider: PROXIED, useProviderKey: true, fromEnv: 'sk-env', expected: { ANTHROPIC_AUTH_TOKEN: 'sk-env', ANTHROPIC_BASE_URL: PROXY_URL } },
    { name: 'proxy, stored key over env key', provider: PROXIED, useProviderKey: false, stored: 'sk-stored', fromEnv: 'sk-env', expected: { ANTHROPIC_AUTH_TOKEN: 'sk-stored', ANTHROPIC_BASE_URL: PROXY_URL } }
  ];

  /** Runs the pre-session model probe once and captures the env handed to the SDK. */
  async function probeEnvFor(s: AppSettings, stored: string | undefined): Promise<Record<string, string | undefined>> {
    queryMock.mockReset();
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockResolvedValue([{ value: 'default', resolvedModel: 'claude-sonnet-5', displayName: 'Default (recommended)' }]), close: vi.fn() });
    const r = await listHarnessModels({
      harness: 'claude',
      settings: s,
      runtime: { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never,
      getApiKey: async (id) => (id === 'anthropic' ? stored : undefined)
    });
    expect(r.error).toBeUndefined();
    return (queryMock.mock.calls[0][0] as { options: { env: Record<string, string | undefined> } }).options.env;
  }

  const credentials = (env: Record<string, string | undefined>) => ({
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL
  });

  it.each(cases)('starts the probe with the credentials a session gets: $name', async ({ provider, useProviderKey, stored, fromEnv, expected }) => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    if (fromEnv) process.env.ANTHROPIC_API_KEY = fromEnv;
    else delete process.env.ANTHROPIC_API_KEY;
    const s = settings({ useProviderKey, providers: [provider] });
    expect(credentials(await envFor(s, { provider: 'anthropic', model: 'claude-sonnet-5' }, stored))).toEqual(expected);
    expect(credentials(await probeEnvFor(s, stored))).toEqual(expected);
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
  it('emits unique explicit model choices from SDK initialization without changing the pinned session model', async () => {
    const pinned = 'claude-opus-pinned';
    const next = 'claude-opus-future';
    const supportedModels = vi.fn().mockResolvedValue([
      { value: 'default', resolvedModel: next, displayName: 'Default' },
      { value: 'opus', resolvedModel: next, displayName: 'Opus' },
      { value: next, resolvedModel: next, displayName: 'Duplicate Opus' },
      { value: 'opus[1m]', resolvedModel: `${next}[1m]`, displayName: 'Opus 1M' }
    ]);
    const close = vi.fn();
    queryMock.mockReset();
    queryMock.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk1', model: pinned };
        yield { type: 'system', subtype: 'init', session_id: 'sdk1', model: pinned };
      },
      supportedModels, supportedCommands: vi.fn().mockResolvedValue([]), close, interrupt: vi.fn()
    });
    const events: SessionEvent[] = [];
    const adapter = new ClaudeAdapter(stubCtx(settings(), { provider: 'anthropic', model: pinned }, undefined, events));
    try {
      await adapter.start();
      await vi.waitFor(() => expect(events.some((e) => e.type === 'status' && e.status === 'stopped')).toBe(true));
      const catalogs = events.filter((e) => e.type === 'models');
      expect(catalogs).toHaveLength(1);
      // The in-session list offers the recommendation as its concrete model too, never the alias.
      expect(catalogs[0].models.map((m) => m.id)).toEqual([next, `${next}[1m]`]);
      expect(catalogs[0].models[0]).toMatchObject({ displayName: `${next} (recommended)`, isDefault: true });
      expect(queryMock.mock.calls[0][0].options.model).toBe(pinned);
      expect(supportedModels).toHaveBeenCalledOnce();
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
      expect(await adapter.listModels()).toEqual(catalogs[0].models);
    } finally {
      await adapter.dispose();
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('marks a model without effort in the in-session catalog', async () => {
    const haiku = 'claude-haiku-4-5-20251001';
    const supportedModels = vi.fn().mockResolvedValue([
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      // Claude Code's shape for a model without effort: the fields are absent, never `false`.
      { value: 'haiku', resolvedModel: haiku, displayName: 'Haiku' }
    ]);
    queryMock.mockReset();
    queryMock.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk1', model: haiku };
      },
      supportedModels, supportedCommands: vi.fn().mockResolvedValue([]), close: vi.fn(), interrupt: vi.fn()
    });
    const events: SessionEvent[] = [];
    const adapter = new ClaudeAdapter(stubCtx(settings(), { provider: 'anthropic', model: haiku }, undefined, events));
    try {
      await adapter.start();
      await vi.waitFor(() => expect(events.some((e) => e.type === 'models')).toBe(true));
      const catalogs = events.filter((e) => e.type === 'models');
      expect(catalogs).toHaveLength(1);
      expect(catalogs[0].models.map((m) => [m.id, m.supportedEfforts])).toEqual([
        ['claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max']],
        [haiku, []]
      ]);
    } finally {
      await adapter.dispose();
    }
  });

  /** handle() is private; drive it directly with SDK-shaped messages. */
  const feed = (adapter: ClaudeAdapter, msg: Record<string, unknown>): void => {
    (adapter as unknown as { handle: (m: unknown, q: unknown) => void }).handle(msg as never, queryMock.mock.results[0]?.value);
  };

  it('keeps the settings catalog for a gateway instead of the SDK Anthropic list', async () => {
    const supportedModels = vi.fn().mockResolvedValue([{ value: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' }]);
    queryMock.mockReset();
    queryMock.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, supportedModels, supportedCommands: vi.fn().mockResolvedValue([]), close: vi.fn(), interrupt: vi.fn() });
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
    queryMock.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, supportedModels, supportedCommands: vi.fn().mockResolvedValue([]), close: vi.fn(), interrupt: vi.fn() });
    const events: SessionEvent[] = [];
    const adapter = new ClaudeAdapter(stubCtx(settings(), { provider: 'anthropic', model: 'claude-sonnet-5' }, 'sk-ant', events));
    await adapter.start();
    feed(adapter, { type: 'system', subtype: 'init', session_id: 'sdk1', model: 'claude-sonnet-5' });
    await new Promise((r) => setTimeout(r, 0));
    expect(events.find((e) => e.type === 'models')).toMatchObject({ models: [expect.objectContaining({ id: 'claude-sonnet-5', provider: 'anthropic' })] });
  });
});
