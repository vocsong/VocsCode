/** The Claude picker must list models from every enabled Anthropic-compatible provider, not only the
 *  built-in Anthropic one; that is what makes a gateway's models selectable for Claude Code. */
import type { AppSettings, ProviderConfig } from '../src/shared/types';
import { describe, expect, it } from 'vitest';
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

function settings(providers: ProviderConfig[]): AppSettings {
  return { claude: { runtime: 'auto', useProviderKey: false, settingSources: [] }, providers } as unknown as AppSettings;
}

const list = (providers: ProviderConfig[]) =>
  listHarnessModels({ harness: 'claude', settings: settings(providers), runtime: {} as never, getApiKey: async () => undefined });

describe('Claude model catalog', () => {
  it('lists the built-in Anthropic catalog when nothing else is configured', async () => {
    const r = await list([provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' })]);
    expect(r.models.map((m) => m.id)).toEqual(ANTHROPIC_STATIC_MODELS.map((m) => m.id));
    expect(r.models.every((m) => m.provider === 'anthropic')).toBe(true);
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
