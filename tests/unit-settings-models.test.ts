import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { codexModelToInfo } from '../src/main/harness/codex-app-server';
import { openaiStep } from '../src/main/harness/native/drivers';
import { piModelToInfo } from '../src/main/harness/pi';
import { fetchProviderModels } from '../src/main/models/providers';
import { estimateCostUsd, findContextWindow, findPricing } from '../src/main/models/static-models';
import { defaultSettings, normalizeSettings } from '../src/main/settings';
import { HARNESSES } from '../src/shared/harness-meta';
import { applyModelOverrides, modelOverrideKey, parseModelOverrideKey, pruneModelOverrides } from '../src/shared/model-overrides';
import type { AppSettings, EffortLevel, ModelInfo, ProviderConfig } from '../src/shared/types';

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

describe('settings normalization', () => {
  it('keeps builtin providers and merges stored overrides', () => {
    const d = defaultSettings();
    const s = normalizeSettings({ theme: 'dark', providers: [{ ...d.providers[0], hasApiKey: true, models: [{ id: 'm', provider: 'anthropic', displayName: 'M' }] }, { id: 'custom', kind: 'openai-compatible', name: 'C', hasApiKey: false, models: [], enabled: true }] });
    expect(s.theme).toBe('dark');
    expect(s.providers.find((p) => p.id === 'anthropic')?.hasApiKey).toBe(true);
    expect(s.providers.find((p) => p.id === 'anthropic')?.models).toHaveLength(1);
    expect(s.providers.filter((p) => p.builtin).length).toBe(d.providers.length);
    expect(s.providers.find((p) => p.id === 'custom')?.builtin).toBe(false);
    expect(s.acpAgents.length).toBe(d.acpAgents.length);
  });
  it('defaults the welcome guide and new sessions to Pi, keeping an explicit choice', () => {
    expect(defaultSettings().defaultHarness).toBe('pi');
    expect(normalizeSettings({ theme: 'dark' }).defaultHarness).toBe('pi');
    expect(normalizeSettings({ defaultHarness: 'claude' }).defaultHarness).toBe('claude');
  });
  it('keeps well-formed per-folder new-session defaults and drops malformed ones', () => {
    expect(defaultSettings().folderSessionDefaults).toEqual({});
    const stored = {
      'G:/a': { harness: 'claude', permissionMode: 'plan', effort: 'high', useWorktree: true, branchPrefix: 'feat/', acpAgent: 'dsh', modelByHarness: { claude: { provider: 'anthropic', model: 'claude-opus-5' } } },
      'G:/b': { harness: 'nope', permissionMode: 'yolo', effort: 'ultra', useWorktree: 'yes', branchPrefix: 'bad..prefix', acpAgent: '  ' },
      'G:/c': 'not an object'
    };
    const s = normalizeSettings({ folderSessionDefaults: stored as never });
    expect(s.folderSessionDefaults).toEqual({
      'G:/a': {
        harness: 'claude',
        permissionMode: 'plan',
        effort: 'high',
        useWorktree: true,
        branchPrefix: 'feat',
        acpAgent: 'dsh',
        modelByHarness: { claude: { provider: 'anthropic', model: 'claude-opus-5' } }
      }
    });
  });
  it('keeps saved custom branch prefixes in their stored form and drops malformed, duplicate and built-in ones', () => {
    expect(defaultSettings().customBranchPrefixes).toEqual([]);
    const s = normalizeSettings({ customBranchPrefixes: ['bug/', ' team/feat ', 'bug', 'feat', 'vocscode/', 'a b', 'x..y', 'rel.lock', '/', 3] as never });
    expect(s.customBranchPrefixes).toEqual(['bug', 'team/feat']);
    expect(normalizeSettings({ customBranchPrefixes: Array.from({ length: 30 }, (_, i) => `p${i}`) }).customBranchPrefixes).toHaveLength(20);
    expect(normalizeSettings({ customBranchPrefixes: 'bug' as never }).customBranchPrefixes).toEqual([]);
  });
  it('drops the retired app-wide worktree default so it cannot override a folder', () => {
    const s = normalizeSettings({ defaultUseWorktree: true } as never);
    expect('defaultUseWorktree' in s).toBe(false);
    expect(s.folderSessionDefaults).toEqual({});
  });
  it('keeps a well-formed utility model and drops malformed ones', () => {
    expect(normalizeSettings({ utilityModel: { provider: 'deepseek', model: 'deepseek-chat' } }).utilityModel).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(normalizeSettings({}).utilityModel).toBeUndefined();
    expect(normalizeSettings({ utilityModel: { provider: 3, model: 'x' } as never }).utilityModel).toBeUndefined();
  });
  it('drops an effort level the app no longer models', () => {
    expect(normalizeSettings({ defaultEffort: 'high' }).defaultEffort).toBe('high');
    expect(normalizeSettings({ defaultEffort: 'ultra' as never }).defaultEffort).toBeUndefined();
  });
});

describe('custom status label settings', () => {
  it('normalizes user-added labels: trims, dedupes case-insensitively, drops junk, caps at 24 chars', () => {
    const stored = { customLabels: ['  Wip ', 'wip', 42, '', 'x'.repeat(40), 'ok'] } as unknown as Partial<AppSettings>;
    expect(normalizeSettings(stored).customLabels).toEqual(['Wip', 'x'.repeat(24), 'ok']);
  });

  it('falls back to an empty list for wrong-shaped values', () => {
    expect(normalizeSettings({ customLabels: 'nope' } as unknown as Partial<AppSettings>).customLabels).toEqual([]);
    expect(normalizeSettings(undefined).customLabels).toEqual([]);
  });
});

describe('pricing', () => {
  it('finds pricing and estimates cost', () => {
    const p = findPricing('anthropic', 'claude-opus-5');
    expect(p?.input).toBe(5);
    expect(estimateCostUsd(p, { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(5);
    expect(findPricing('openrouter', 'openai/gpt-5.4')?.input).toBe(2.5);
  });

  it('prices a runtime id by the model it names, not by a shorter older entry', () => {
    // The rates Claude Code states in its own rows: Opus 5.5 $4/$20, Sonnet 5 $2/$10, Fable 5.1
    // $10/$50. Opus 5 is $5/$25, so borrowing its row is a wrong number, not a stale one.
    expect(findPricing('anthropic', 'claude-opus-5-5[1m]')).toMatchObject({ input: 4, output: 20 });
    expect(findPricing('anthropic', 'claude-sonnet-5[1m]')).toMatchObject({ input: 2, output: 10 });
    expect(findPricing('anthropic', 'claude-fable-5-1[1m]')?.cacheRead).toBe(0.25);
    // A provider row for the same model must not borrow Opus 5's rate either.
    expect(findPricing('openrouter', 'anthropic/claude-opus-5-5')?.input).toBe(4);
  });

  it('reads the window a context marker names, and the base model without one', () => {
    expect(findContextWindow('anthropic', 'claude-opus-5-5[1m]')).toBe(1_000_000);
    expect(findContextWindow('anthropic', 'claude-sonnet-5[1m]')).toBe(1_000_000);
    expect(findContextWindow('anthropic', 'claude-fable-5-1[1m]')).toBe(1_000_000);
    expect(findContextWindow('anthropic', 'claude-opus-5-5')).toBe(1_000_000);
  });
});

describe('model mapping', () => {
  it('maps pi models', () => {
    const m = piModelToInfo({ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', reasoning: true, input: ['text'], contextWindow: 1_000_000, cost: { input: 0.435, output: 0.87 }, thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' } });
    expect(m.supportedEfforts).toEqual(['high', 'max']);
    expect(m.supportsImages).toBe(false);
    expect(m.pricing?.output).toBe(0.87);
  });
  it('keeps pi levels missing from thinkingLevelMap', () => {
    // openai-codex ships holes for the standard levels: only `null` hides one.
    const m = piModelToInfo({ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai-codex', reasoning: true, input: ['text', 'image'], contextWindow: 272_000, thinkingLevelMap: { xhigh: 'xhigh', max: 'max', minimal: 'low' } });
    expect(m.supportedEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
  it('drops pi off and explicitly hidden levels', () => {
    const m = piModelToInfo({ id: 'x', name: 'X', provider: 'openai', reasoning: true, thinkingLevelMap: { off: 'none', minimal: null, low: 'low', xhigh: null, max: 'max' } });
    expect(m.supportedEfforts).toEqual(['low', 'medium', 'high', 'max']);
  });
  it('leaves the effort list open when pi reports no thinkingLevelMap', () => {
    const m = piModelToInfo({ id: 'x', name: 'X', provider: 'openrouter', reasoning: true });
    expect(m.supportedEfforts).toBeUndefined();
  });
  it('maps codex models', () => {
    const m = codexModelToInfo({ id: 'x', model: 'gpt-5.5', displayName: 'GPT-5.5', description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'high', inputModalities: ['text', 'image'], isDefault: true });
    expect(m.id).toBe('gpt-5.5');
    expect(m.supportsImages).toBe(true);
    expect(m.pricing?.input).toBe(5);
    expect(m.supportedEfforts).toEqual(['high']);
    expect(m.defaultEffort).toBe('high');
  });
  it('drops codex effort levels the app cannot express', () => {
    // Codex 0.153 advertises `ultra` on the 5.6/6 family; the shared effort state only knows minimal..max.
    const m = codexModelToInfo({ id: 'x', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }, { reasoningEffort: 'ultra', description: '' }], defaultReasoningEffort: 'ultra', inputModalities: ['text'], isDefault: false });
    expect(m.supportedEfforts).toEqual(['low', 'high']);
    expect(m.defaultEffort).toBeUndefined();
  });
});

describe('Anthropic model catalog without a key', () => {
  it('explains the subscription path instead of the SDK auth error, and sends no request', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    let requests = 0;
    const server = await listenOnce((_req, res) => {
      requests++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [], has_more: false }));
    });
    try {
      const provider: ProviderConfig = { id: 'anthropic', kind: 'anthropic', name: 'Anthropic', baseUrl: server.url, envKey: 'ANTHROPIC_API_KEY', hasApiKey: false, models: [], enabled: true };
      const error = await fetchProviderModels(provider, undefined).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('No API key stored and ANTHROPIC_API_KEY is not set');
      expect((error as Error).message).toContain('add its id under Models');
      expect(requests).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      await server.close();
    }
  });
});

describe('OpenRouter reasoning effort', () => {
  it('reads the exact levels and default from the OpenRouter catalog', async () => {
    const server = await listenOnce((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [
        {
          id: 'deepseek/deepseek-v4.1-flash',
          name: 'DeepSeek: DeepSeek V4.1 Flash',
          context_length: 1_048_576,
          supported_parameters: ['reasoning', 'reasoning_effort'],
          reasoning: { supported_efforts: ['max', 'high', 'low', 'none'], default_effort: 'high' }
        },
        { id: 'vendor/plain-chat', name: 'Plain Chat', supported_parameters: ['temperature'] }
      ] }));
    });
    try {
      const provider: ProviderConfig = { id: 'openrouter', kind: 'openrouter', name: 'OpenRouter', baseUrl: server.url, hasApiKey: false, models: [], enabled: true };
      const models = await fetchProviderModels(provider, undefined);
      const deepseek = models.find((m) => m.id === 'deepseek/deepseek-v4.1-flash');
      // `none` is not an app level, so it is dropped; the rest survive in catalog order.
      expect(deepseek?.supportedEfforts).toEqual(['max', 'high', 'low']);
      expect(deepseek?.defaultEffort).toBe('high');
      const plain = models.find((m) => m.id === 'vendor/plain-chat');
      expect(plain?.supportedEfforts).toBeUndefined();
      expect(plain?.defaultEffort).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  async function sendOpenRouterStep(model: string, effort: EffortLevel, supportedEfforts: EffortLevel[]): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    const server = await listenOnce((_req, res, raw) => {
      body = JSON.parse(raw ?? '{}') as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ content: 'hi' }, null));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const provider: ProviderConfig = {
        id: 'openrouter',
        kind: 'openrouter',
        name: 'OpenRouter',
        baseUrl: server.url,
        hasApiKey: true,
        models: [{ id: model, provider: 'openrouter', displayName: model, supportedEfforts }],
        enabled: true
      };
      await openaiStep({
        provider,
        apiKey: 'sk-test',
        model,
        system: '',
        history: [],
        tools: [],
        effort,
        signal: AbortSignal.timeout(5_000),
        onText: () => undefined,
        onReasoning: () => undefined
      });
      return body;
    } finally {
      await server.close();
    }
  }

  it('forwards max to an OpenRouter DeepSeek model instead of clamping it to high', async () => {
    const body = await sendOpenRouterStep('deepseek/deepseek-v4.1-flash', 'max', ['max', 'high', 'low']);
    expect(body.reasoning_effort).toBe('max');
  });

  it('omits reasoning_effort for an OpenRouter model that does not advertise it', async () => {
    const body = await sendOpenRouterStep('vendor/plain-chat', 'high', []);
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe('DeepSeek reasoning effort', () => {
  /** Captures the reasoning_effort the native loop puts on the wire for one DeepSeek step. */
  async function sendDeepSeekStep(effort: EffortLevel): Promise<Record<string, unknown>> {
    const model = 'deepseek-flash';
    let body: Record<string, unknown> = {};
    const server = await listenOnce((_req, res, raw) => {
      body = JSON.parse(raw ?? '{}') as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ content: 'hi' }, null));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const provider: ProviderConfig = { id: 'deepseek', kind: 'deepseek', name: 'DeepSeek', baseUrl: server.url, hasApiKey: true, models: [], enabled: true };
      await openaiStep({
        provider,
        apiKey: 'sk-test',
        model,
        system: '',
        history: [],
        tools: [],
        effort,
        signal: AbortSignal.timeout(5_000),
        onText: () => undefined,
        onReasoning: () => undefined
      });
      return body;
    } finally {
      await server.close();
    }
  }

  it('forwards max to DeepSeek instead of folding it into high', async () => {
    // DeepSeek serves three tiers — low/high/max, the scalar efforts 50/75/100 — so folding max
    // into high made the top tier unreachable from the app.
    expect((await sendDeepSeekStep('max')).reasoning_effort).toBe('max');
  });

  it('folds only the levels DeepSeek has no tier for', async () => {
    expect((await sendDeepSeekStep('minimal')).reasoning_effort).toBe('low');
    expect((await sendDeepSeekStep('xhigh')).reasoning_effort).toBe('high');
    expect((await sendDeepSeekStep('high')).reasoning_effort).toBe('high');
    expect((await sendDeepSeekStep('low')).reasoning_effort).toBe('low');
  });
});

describe('OpenCode Go session headers', () => {
  /** Captures the headers the OpenAI client actually put on the wire for one step. */
  async function stepHeaders(over: Partial<ProviderConfig>, sessionId?: string): Promise<IncomingMessage['headers']> {
    let headers: IncomingMessage['headers'] = {};
    const server = await listenOnce((req, res) => {
      headers = req.headers;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'kimi-k2.6', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ content: 'hi' }, null));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const provider: ProviderConfig = { id: 'opencode-go', kind: 'opencode-go', name: 'OpenCode Go', baseUrl: server.url, hasApiKey: true, models: [], enabled: true, ...over };
      await openaiStep({
        provider,
        apiKey: 'sk-test',
        model: 'kimi-k2.6',
        system: '',
        history: [],
        tools: [],
        signal: AbortSignal.timeout(5_000),
        sessionId,
        onText: () => undefined,
        onReasoning: () => undefined
      });
      return headers;
    } finally {
      await server.close();
    }
  }

  it('identifies the client and the conversation, which OpenCode Go routes and caches by', async () => {
    const headers = await stepHeaders({}, 'sess-42');
    expect(headers['x-opencode-session']).toBe('sess-42');
    expect(headers['x-opencode-client']).toBe('vocs-code');
  });

  it('drops the session header instead of sending an empty one', async () => {
    const headers = await stepHeaders({});
    expect(headers['x-opencode-session']).toBeUndefined();
    expect(headers['x-opencode-client']).toBe('vocs-code');
  });

  it('leaves every other provider on exactly the headers it configured', async () => {
    const headers = await stepHeaders({ id: 'openrouter', kind: 'openrouter' }, 'sess-42');
    expect(headers['x-opencode-session']).toBeUndefined();
    expect(headers['x-opencode-client']).toBeUndefined();
  });
});

describe('model capability overrides', () => {
  const models: ModelInfo[] = [
    { id: 'deepseek-v4.1-flash-expires-on-0910', provider: 'deepseek', displayName: 'DeepSeek V4.1 Flash', supportsImages: false },
    { id: 'claude-opus-5', provider: 'anthropic', displayName: 'Claude Opus 5', supportsImages: true }
  ];

  it('keys by provider and keeps slashes in the model id', () => {
    const key = modelOverrideKey('openrouter', 'openai/gpt-5.4');
    expect(key).toBe('openrouter/openai/gpt-5.4');
    expect(parseModelOverrideKey(key)).toEqual({ provider: 'openrouter', model: 'openai/gpt-5.4' });
  });

  it('applies only to the matching model and flags it as overridden', () => {
    const out = applyModelOverrides(models, { 'deepseek/deepseek-v4.1-flash-expires-on-0910': { supportsImages: true } });
    expect(out[0].supportsImages).toBe(true);
    expect(out[0].overridden).toBe(true);
    expect(out[1]).toBe(models[1]);
  });

  it('can also mark a model as text-only', () => {
    const out = applyModelOverrides(models, { 'anthropic/claude-opus-5': { supportsImages: false } });
    expect(out[1].supportsImages).toBe(false);
  });

  it('is a no-op without overrides, and ignores ones for other providers', () => {
    expect(applyModelOverrides(models, undefined)).toBe(models);
    expect(applyModelOverrides(models, {})).toBe(models);
    // Same model slug, different provider: must not match.
    expect(applyModelOverrides(models, { 'openrouter/claude-opus-5': { supportsImages: false } })[1].supportsImages).toBe(true);
  });

  it('prunes entries that no longer carry a value', () => {
    expect(pruneModelOverrides({ 'a/b': {}, 'c/d': { supportsImages: false } })).toEqual({ 'c/d': { supportsImages: false } });
  });

  it('survives a settings round-trip and drops empty entries', () => {
    expect(defaultSettings().modelOverrides).toEqual({});
    const s = normalizeSettings({ modelOverrides: { 'deepseek/x': { supportsImages: true }, 'deepseek/y': {} } });
    expect(s.modelOverrides).toEqual({ 'deepseek/x': { supportsImages: true } });
    // Settings written before this feature existed have no such key.
    expect(normalizeSettings({ theme: 'dark' }).modelOverrides).toEqual({});
  });

  it('lists Pi first in the harness pickers', () => {
    expect(HARNESSES.map((h) => h.id)).toEqual(['pi', 'claude', 'codex', 'codex-exec', 'cursor', 'antigravity', 'acp', 'native']);
  });

  it('marks pi as the only harness that strips images itself', () => {
    const dropping = HARNESSES.filter((h) => h.capabilities.dropsUnsupportedImages).map((h) => h.id);
    expect(dropping).toEqual(['pi']);
    // Every harness still accepts attachments from the composer.
    expect(HARNESSES.every((h) => h.capabilities.images)).toBe(true);
  });

  it('normalizes favoriteModels to valid model refs', () => {
    expect(defaultSettings().favoriteModels).toEqual([]);
    const s = normalizeSettings({
      favoriteModels: [
        { provider: 'openrouter', model: 'openai/gpt-4o' },
        { provider: 'openrouter' },
        'openrouter::junk'
      ] as never
    });
    expect(s.favoriteModels).toEqual([{ provider: 'openrouter', model: 'openai/gpt-4o' }]);
    // Settings written before this feature existed have no such key.
    expect(normalizeSettings({ theme: 'dark' }).favoriteModels).toEqual([]);
  });

  it('normalizes sidebar folders to non-empty path strings', () => {
    expect(defaultSettings().folders).toEqual([]);
    const s = normalizeSettings({ folders: ['G:/proj/a', '', 42, 'G:/proj/b'] as never });
    expect(s.folders).toEqual(['G:/proj/a', 'G:/proj/b']);
    // Settings written before this feature existed have no such key.
    expect(normalizeSettings({ theme: 'dark' }).folders).toEqual([]);
  });

  it('normalizes folder order and collapsed roots to non-empty path strings', () => {
    expect(defaultSettings().folderOrder).toEqual([]);
    expect(defaultSettings().collapsedFolders).toEqual([]);
    const s = normalizeSettings({
      folderOrder: ['G:/proj/b', '', 42, 'G:/proj/a'],
      collapsedFolders: ['G:/proj/a', 7, '']
    } as never);
    expect(s.folderOrder).toEqual(['G:/proj/b', 'G:/proj/a']);
    expect(s.collapsedFolders).toEqual(['G:/proj/a']);
    // Settings written before this feature existed have no such keys.
    expect(normalizeSettings({ theme: 'dark' }).folderOrder).toEqual([]);
    expect(normalizeSettings({ theme: 'dark' }).collapsedFolders).toEqual([]);
  });

  it('normalizes folder styles to hex colors and known-shape icon names', () => {
    expect(defaultSettings().folderStyles).toEqual({});
    const s = normalizeSettings({
      folderStyles: {
        'G:/proj/a': { color: '#5B9BF8', icon: 'bolt' },
        'G:/proj/b': { color: 'red', icon: 'DROP TABLE' },
        'G:/proj/c': { color: '#fff' },
        'G:/proj/d': { icon: 42 },
        'G:/proj/e': {},
        '': { color: '#5b9bf8' },
        'G:/proj/f': 'bogus'
      } as never
    });
    expect(s.folderStyles).toEqual({ 'G:/proj/a': { color: '#5B9BF8', icon: 'bolt' } });
    // Settings written before this feature existed have no such key.
    expect(normalizeSettings({ theme: 'dark' }).folderStyles).toEqual({});
  });
});
