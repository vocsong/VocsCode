/** The Claude picker must list models from every enabled Anthropic-compatible provider, not only the
 *  built-in Anthropic one; that is what makes a gateway's models selectable for Claude Code. */
import type { AppSettings, ProviderConfig } from '../src/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { listHarnessModels } from '../src/main/harness/registry';
import { ANTHROPIC_STATIC_MODELS } from '../src/main/models/static-models';

const provider = (over: Partial<ProviderConfig>): ProviderConfig => ({
  id: 'x',
  kind: 'anthropic',
  name: 'x',
  hasApiKey: false,
  models: [],
  enabled: true,
  ...over
});

type SettingSources = AppSettings['claude']['settingSources'];

function settings(providers: ProviderConfig[], settingSources: SettingSources = []): AppSettings {
  return { claude: { runtime: 'auto', useProviderKey: false, settingSources }, providers } as unknown as AppSettings;
}

const missingRuntime = { resolve: () => null } as never;
const list = (providers: ProviderConfig[], runtime = missingRuntime, settingSources: SettingSources = []) =>
  listHarnessModels({ harness: 'claude', settings: settings(providers, settingSources), runtime, getApiKey: async () => undefined });

describe('Claude model catalog', () => {
  beforeEach(() => queryMock.mockReset());
  it('lists the built-in Anthropic catalog when nothing else is configured', async () => {
    const r = await list([provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' })]);
    expect(r.models.map((m) => m.id)).toEqual(ANTHROPIC_STATIC_MODELS.map((m) => m.id));
    expect(r.models.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  it('asks the installed Claude runtime for the login-backed catalog before a session exists', async () => {
    const close = vi.fn();
    const supportedModels = vi.fn().mockResolvedValue([
      {
        value: 'default',
        resolvedModel: 'claude-opus-5-5[1m]',
        displayName: 'Default (recommended)',
        description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
      },
      {
        value: 'opus[1m]',
        resolvedModel: 'claude-opus-5-5[1m]',
        displayName: 'Opus (1M context)',
        description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
      },
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        displayName: 'Sonnet',
        description: 'Sonnet 5 · Efficient for routine tasks',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'max']
      },
      // Claude Code's shape for a model without effort: the fields are absent, never `false`.
      {
        value: 'haiku',
        resolvedModel: 'claude-haiku-4-5-20251001',
        displayName: 'Haiku',
        description: 'Haiku 4.5 · Fastest for quick answers'
      }
    ]);
    queryMock.mockReturnValue({ supportedModels, close });
    const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;

    const r = await list(
      [
        provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' }),
        provider({ id: 'zai', name: 'Z.AI', models: [{ id: 'glm-4.6', provider: 'zai', displayName: 'GLM-4.6' }] })
      ],
      runtime
    );

    expect(r.error).toBeUndefined();
    // Claude's recommendation is offered as the model it resolves to, merged with the explicit row
    // for that model, so choosing it (or starting without touching the picker) saves a version.
    expect(r.models.slice(0, 3)).toEqual([
      expect.objectContaining({ id: 'claude-opus-5-5[1m]', displayName: 'Opus 5.5 with 1M context (recommended)', isDefault: true }),
      expect.objectContaining({ id: 'claude-sonnet-5', displayName: 'Sonnet 5', supportedEfforts: ['low', 'high', 'max'], isDefault: false }),
      // Other rows report effort, so Haiku's missing fields mean it takes none, not "unknown".
      expect.objectContaining({ id: 'claude-haiku-4-5-20251001', supportsReasoning: false, supportedEfforts: [], isDefault: false })
    ]);
    expect(r.models.at(-1)).toEqual(expect.objectContaining({ id: 'glm-4.6', provider: 'zai' }));
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.objectContaining({ [Symbol.asyncIterator]: expect.any(Function) }),
        options: expect.objectContaining({
          cwd: process.cwd(),
          pathToClaudeCodeExecutable: '/bin/claude',
          permissionMode: 'plan',
          settingSources: [],
          settings: { disableAllHooks: true },
          strictMcpConfig: true,
          persistSession: false
        })
      })
    );
    expect(supportedModels).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('reads the user settings sessions read, so the list matches the endpoint and model they configure', async () => {
    // ~/.claude/settings.json can point Claude Code at Bedrock, Vertex or a gateway, set an
    // apiKeyHelper or pick a model; a probe that skips it lists another endpoint's models.
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockResolvedValue([
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5' }
    ]), close: vi.fn() });
    const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;
    const anthropic = provider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com' });

    await list([anthropic], runtime, ['user', 'project', 'local']);
    await list([anthropic], runtime, ['project', 'local']);

    // Project and local settings would resolve against this app's own cwd, not a project, and the
    // user's hooks and MCP servers have no business in a model probe.
    expect(queryMock.mock.calls.map(([arg]) => arg.options)).toEqual([
      expect.objectContaining({ settingSources: ['user'], settings: { disableAllHooks: true }, strictMcpConfig: true }),
      expect.objectContaining({ settingSources: [], settings: { disableAllHooks: true }, strictMcpConfig: true })
    ]);
  });

  it('leaves effort unknown when the runtime reports it on no model', async () => {
    // An older Claude Code without the effort fields: a missing field cannot mean "none" there. A row
    // that says `supportsEffort: false` outright still takes none.
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockResolvedValue([
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5' },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5', supportsEffort: false }
    ]), close: vi.fn() });
    const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;

    const r = await list([provider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com' })], runtime);

    expect(r.error).toBeUndefined();
    expect(r.models.slice(0, 2).map((m) => [m.id, m.supportedEfforts])).toEqual([
      ['claude-opus-5-5', undefined],
      ['claude-haiku-4-5-20251001', []]
    ]);
  });

  it('lists each explicit model once when multiple SDK rows resolve to it, preserving order and provider variants', async () => {
    const close = vi.fn();
    const id = 'claude-opus-future';
    const row = (value: string, resolvedModel = id) => ({ value, resolvedModel, displayName: value, description: '', supportsEffort: true, supportedEffortLevels: ['high'] });
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockResolvedValue([
      row('default'), row('opus'), row(id), row('opus[1m]', `${id}[1m]`), row(`${id}[1m]`, `${id}[1m]`)
    ]), close });
    const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;
    const gatewayModel = { id, provider: 'gateway', displayName: 'Gateway Opus' };
    const saved = { id: 'claude-sonnet-saved', provider: 'anthropic', displayName: 'Saved Sonnet' };
    const r = await list([
      provider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com', models: [saved] }),
      provider({ id: 'gateway', models: [gatewayModel, gatewayModel] })
    ], runtime);

    expect(r.error).toBeUndefined();
    expect(r.models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      `anthropic/${id}`, `anthropic/${id}[1m]`, 'anthropic/claude-sonnet-saved', `gateway/${id}`
    ]);
    // First SDK occurrence wins deterministically; don't merge conflicting alias metadata.
    expect(r.models[0]).toMatchObject({ displayName: `${id} (recommended)`, isDefault: true, supportedEfforts: ['high'] });
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps the recommendation when the SDK lists the explicit row for that model first', async () => {
    const row = (value: string, resolvedModel: string, description: string) => ({ value, resolvedModel, displayName: value, description });
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockResolvedValue([
      row('opus', 'claude-opus-5-5', 'Opus 5.5'), row('sonnet', 'claude-sonnet-5', 'Sonnet 5'), row('default', 'claude-opus-5-5', 'Opus 5.5')
    ]), close: vi.fn() });
    const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;

    const r = await list([provider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com' })], runtime);

    expect(r.models.slice(0, 2).map((m) => [m.id, m.displayName, m.isDefault])).toEqual([
      ['claude-opus-5-5', 'Opus 5.5 (recommended)', true],
      ['claude-sonnet-5', 'Sonnet 5', false]
    ]);
  });

  it('does not offer Opus Plan Mode, even when the runtime lists opusplan before the model it resolves to', async () => {
    // Claude Code 0.3.280 lists opusplan only when the user's model setting is opusplan, and resolves
    // it to the execution model. Pinned, it would become a "Opus Plan Mode" row that runs plain Sonnet.
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockResolvedValue([
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      { value: 'opusplan', resolvedModel: 'claude-sonnet-5', displayName: 'Opus Plan Mode', description: 'Opus Plan Mode · Use Opus 5.5 in plan mode, Sonnet 5 otherwise' },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' }
    ]), close: vi.fn() });
    const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;

    const r = await list([provider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com' })], runtime, ['user']);

    expect(r.error).toBeUndefined();
    expect(r.models.slice(0, 2).map((m) => [m.id, m.displayName])).toEqual([
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-sonnet-5', 'Sonnet 5']
    ]);
    expect(r.models.filter((m) => /plan/i.test(`${m.id} ${m.displayName} ${m.description ?? ''}`))).toEqual([]);
  });

  it('drops a default the runtime does not resolve instead of offering the moving alias', async () => {
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockResolvedValue([
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' }
    ]), close: vi.fn() });
    const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;

    const r = await list([provider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com' })], runtime);

    // Nothing is flagged, so the dialog falls back to the first row: a concrete model either way.
    expect(r.error).toBeUndefined();
    expect(r.models.slice(0, 2).map((m) => [m.id, !!m.isDefault])).toEqual([
      ['claude-opus-5-5', false],
      ['claude-sonnet-5', false]
    ]);
    // The static catalog's own flag must not become a recommendation the runtime never made.
    expect(r.models.filter((m) => m.isDefault)).toEqual([]);
  });

  it('adds the static catalog after a login\u2019s live rows instead of replacing it', async () => {
    // Claude Code 0.3.280 logged out: four rows. Every other static model must stay selectable.
    const row = (value: string, resolvedModel: string, description: string) => ({ value, resolvedModel, displayName: value, description, supportsEffort: true, supportedEffortLevels: ['high'] });
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockResolvedValue([
      row('default', 'claude-opus-5-5[1m]', 'Opus 5.5 with 1M context'),
      row('fable', 'claude-fable-5-1', 'Fable 5.1'),
      row('sonnet', 'claude-sonnet-5', 'Sonnet 5'),
      row('haiku', 'claude-haiku-4-5-20251001', 'Haiku 4.5')
    ]), close: vi.fn() });
    const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;

    const r = await list([provider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com' })], runtime);

    expect(r.error).toBeUndefined();
    // Live rows lead with their runtime metadata; a static row the runtime already listed (the dated
    // Haiku snapshot included) is not repeated, and a context variant stays its own selection.
    expect(r.models.map((m) => [m.id, m.displayName, !!m.isDefault])).toEqual([
      ['claude-opus-5-5[1m]', 'Opus 5.5 with 1M context (recommended)', true],
      ['claude-fable-5-1', 'Fable 5.1', false],
      ['claude-sonnet-5', 'Sonnet 5', false],
      ['claude-haiku-4-5-20251001', 'Haiku 4.5', false],
      ['claude-opus-5-5', 'Claude Opus 5.5', false],
      ['claude-opus-5', 'Claude Opus 5', false],
      ['claude-fable-5', 'Claude Fable 5', false],
      ['claude-opus-4-8', 'Claude Opus 4.8', false],
      ['claude-opus-4-7', 'Claude Opus 4.7', false],
      ['claude-opus-4-6', 'Claude Opus 4.6', false],
      ['claude-sonnet-4-6', 'Claude Sonnet 4.6', false]
    ]);
    expect(r.models[1].supportedEfforts).toEqual(['high']);
  });

  it('adds the Anthropic provider\u2019s fetched catalog after the live rows', async () => {
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockResolvedValue([
      { value: 'default', resolvedModel: 'claude-sonnet-5', displayName: 'Default', description: 'Sonnet 5' }
    ]), close: vi.fn() });
    const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;
    const fetched = [
      { id: 'claude-sonnet-5', provider: 'anthropic', displayName: 'Fetched Sonnet 5', isDefault: true },
      { id: 'claude-opus-4-7', provider: 'anthropic', displayName: 'Fetched Opus 4.7' }
    ];

    const r = await list([provider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com', models: fetched })], runtime);

    expect(r.models.map((m) => [m.id, m.displayName, !!m.isDefault])).toEqual([
      ['claude-sonnet-5', 'Sonnet 5 (recommended)', true],
      ['claude-opus-4-7', 'Fetched Opus 4.7', false]
    ]);
  });

  it('removes duplicate native entries from the saved fallback catalog too', async () => {
    const model = { id: 'claude-opus-pinned', provider: 'anthropic', displayName: 'Pinned Opus' };
    const r = await list([provider({ id: 'anthropic', models: [model, { ...model, displayName: 'Duplicate' }] })]);
    expect(r.models).toEqual([model]);
    expect(r.error).toContain('runtime not found');
  });

  it('falls back to the saved catalog when live Claude discovery fails', async () => {
    const close = vi.fn();
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockRejectedValue(new Error('login expired')), close });
    const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;

    const r = await list([provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' })], runtime);

    expect(r.models.map((m) => m.id)).toEqual(ANTHROPIC_STATIC_MODELS.map((m) => m.id));
    expect(r.error).toContain('login expired');
    expect(close).toHaveBeenCalledOnce();
  });

  it('times out and closes a Claude model probe that never initializes', async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      queryMock.mockReturnValue({ supportedModels: vi.fn(() => new Promise(() => undefined)), close });
      const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;

      const pending = list([provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' })], runtime);
      await vi.advanceTimersByTimeAsync(20_000);
      const r = await pending;

      expect(r.models.map((m) => m.id)).toEqual(ANTHROPIC_STATIC_MODELS.map((m) => m.id));
      expect(r.error).toContain('timed out after 20000ms');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists an added Anthropic-compatible provider\u2019s models under its own provider id', async () => {
    const r = await list([
      provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' }),
      provider({
        id: 'zai',
        name: 'Z.AI (GLM)',
        baseUrl: 'https://api.z.ai/api/anthropic',
        models: [
          { id: 'glm-4.6', provider: 'zai', displayName: 'GLM-4.6' },
          { id: 'glm-4.5', provider: 'zai', displayName: 'GLM-4.5' }
        ]
      })
    ]);
    expect(r.models.find((m) => m.id === 'glm-4.6')).toMatchObject({ provider: 'zai', displayName: 'GLM-4.6' });
    expect(r.models.some((m) => m.id === 'claude-sonnet-5' && m.provider === 'anthropic')).toBe(true);
  });

  it('lists a vendor\u2019s own Anthropic-format catalog (OpenRouter, DeepSeek)', async () => {
    const r = await list([
      provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' }),
      provider({
        id: 'openrouter',
        kind: 'openrouter',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [{ id: 'z-ai/glm-4.6', provider: 'openrouter', displayName: 'GLM 4.6' }]
      }),
      provider({
        id: 'deepseek',
        kind: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        models: [{ id: 'deepseek-v4-pro', provider: 'deepseek', displayName: 'DeepSeek V4 Pro' }]
      })
    ]);
    expect(r.models.find((m) => m.id === 'z-ai/glm-4.6')?.provider).toBe('openrouter');
    expect(r.models.find((m) => m.id === 'deepseek-v4-pro')?.provider).toBe('deepseek');
  });

  it('ignores disabled providers and providers that cannot host Claude Code', async () => {
    const r = await list([
      provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' }),
      provider({ id: 'zai', name: 'Z.AI', enabled: false, models: [{ id: 'glm-4.6', provider: 'zai', displayName: 'GLM-4.6' }] }),
      provider({ id: 'openai', kind: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', provider: 'openai', displayName: 'GPT-5' }] })
    ]);
    expect(r.models.some((m) => m.id === 'glm-4.6')).toBe(false);
    expect(r.models.some((m) => m.id === 'gpt-5')).toBe(false);
  });
});
