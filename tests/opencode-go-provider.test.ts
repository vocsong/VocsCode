/**
 * OpenCode Go is the OpenCode team's $10/month plan over the Zen gateway: an OpenAI-wire endpoint
 * (`/zen/go/v1`) that also publishes an Anthropic-format route, so Codex, Claude Code, pi and the
 * native loop can each run it. These offline tests pin the pieces a harness reads: the built-in
 * provider row and its key env var, the bundled catalog with pricing and context windows, and the
 * seams that decide which harnesses are offered the models.
 */
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/main/settings';
import { listHarnessModels } from '../src/main/harness/registry';
import { findContextWindow, findPricing, OPENCODE_GO_STATIC_MODELS } from '../src/main/models/static-models';
import { mergePiCatalog } from '../src/main/models/pi-catalog';
import { isClaudeGatewayProvider, isOpenAiWireProvider, anthropicBaseUrlFor } from '../src/shared/providers';
import { PI_ENV_KEYS } from '../src/main/harness/pi';
import type { AppSettings, ProviderConfig } from '../src/shared/types';

const provider = (): ProviderConfig => {
  const found = defaultSettings().providers.find((p) => p.id === 'opencode-go');
  if (!found) throw new Error('OpenCode Go is not a built-in provider');
  return found;
};

/** The built-in row with the subscription turned on, the way a subscriber's settings look. */
function enabledSettings(): AppSettings {
  const base = defaultSettings();
  return { ...base, providers: base.providers.map((p) => (p.id === 'opencode-go' ? { ...p, enabled: true, hasApiKey: true } : p)) };
}

describe('OpenCode Go provider row', () => {
  it('ships as a disabled built-in pointing at the Zen Go route', () => {
    const p = provider();
    expect(p).toMatchObject({
      id: 'opencode-go',
      kind: 'opencode-go',
      name: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      envKey: 'OPENCODE_API_KEY',
      builtin: true,
      enabled: false
    });
  });

  it('is an OpenAI-wire provider with a published Anthropic route', () => {
    expect(isOpenAiWireProvider({ kind: 'opencode-go' })).toBe(true);
    expect(anthropicBaseUrlFor({ kind: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1' })).toBe('https://opencode.ai/zen/go');
    expect(isClaudeGatewayProvider({ kind: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1' })).toBe(true);
  });

  it('hands pi the key under the env var pi expects for this provider', () => {
    expect(PI_ENV_KEYS['opencode-go']).toBe('OPENCODE_API_KEY');
  });
});

describe('OpenCode Go bundled catalog', () => {
  it('prices and sizes the plan\u2019s models offline', () => {
    expect(findPricing('opencode-go', 'kimi-k2.6')).toEqual({ input: 0.95, output: 4, cacheRead: 0.16 });
    expect(findContextWindow('opencode-go', 'kimi-k2.6')).toBe(262_144);
    expect(OPENCODE_GO_STATIC_MODELS.map((m) => m.id)).toContain('glm-5.3');
    expect(OPENCODE_GO_STATIC_MODELS.map((m) => m.id)).toContain('deepseek-v4-pro');
    expect(OPENCODE_GO_STATIC_MODELS.every((m) => m.provider === 'opencode-go' && !!m.pricing && !!m.contextWindow)).toBe(true);
  });

  it('marks only the vision models as image-capable', () => {
    const byId = new Map(OPENCODE_GO_STATIC_MODELS.map((m) => [m.id, m]));
    expect(byId.get('deepseek-v4-flash-vision-exp')?.supportsImages).toBe(true);
    expect(byId.get('glm-5.3')?.supportsImages).toBe(false);
  });
});

describe('OpenCode Go harness catalogs', () => {
  const list = (harness: 'native' | 'codex') =>
    listHarnessModels({ harness, settings: enabledSettings(), runtime: { resolve: () => null } as never, getApiKey: async () => undefined });

  it('offers its models to the native loop', async () => {
    const { models } = await list('native');
    expect(models.some((m) => m.provider === 'opencode-go' && m.id === 'kimi-k2.6')).toBe(true);
  });

  it('offers its models to Codex, which registers the endpoint per session', async () => {
    const { models } = await list('codex');
    expect(models.some((m) => m.provider === 'opencode-go' && m.id === 'deepseek-v4-pro')).toBe(true);
  });

  it('keeps the catalog hidden while the provider is off', async () => {
    const settings = defaultSettings();
    const { models } = await listHarnessModels({ harness: 'native', settings, runtime: { resolve: () => null } as never, getApiKey: async () => undefined });
    expect(models.some((m) => m.provider === 'opencode-go')).toBe(false);
  });
});

/**
 * pi's registry is a snapshot and can lag the plan; the app's bundled catalog is the fallback so a
 * model pi has not listed yet is still selectable on the pi harness. pi only accepts a model under
 * a provider it already resolves, and only models the app ships, so those are the two guards.
 */
describe('OpenCode Go on the pi harness', () => {
  it('fills in a plan model pi\u2019s registry has not caught up with', () => {
    // pi's snapshot in use stops at DeepSeek V4 Pro; the app already ships V4.1 Flash.
    const native = [{ id: 'deepseek-v4-pro', provider: 'opencode-go', displayName: 'DeepSeek V4 Pro (New)' }];
    const merged = mergePiCatalog(native, enabledSettings());
    expect(merged.some((m) => m.provider === 'opencode-go' && m.id === 'deepseek-v4.1-flash')).toBe(true);
    // The union is exactly the bundled catalog: every plan model is listed once.
    expect(merged.filter((m) => m.provider === 'opencode-go')).toHaveLength(OPENCODE_GO_STATIC_MODELS.length);
    expect(merged.some((m) => m.id === 'deepseek-v4-pro' && m.displayName === 'DeepSeek V4 Pro (New)')).toBe(true);
  });

  it('keeps pi\u2019s own entry when both sides list the same model', () => {
    const own = OPENCODE_GO_STATIC_MODELS.find((m) => m.id === 'deepseek-v4.1-flash')!;
    const merged = mergePiCatalog([{ ...own, displayName: 'pi\u2019s label' }], enabledSettings());
    expect(merged.filter((m) => m.id === 'deepseek-v4.1-flash')).toHaveLength(1);
    expect(merged.find((m) => m.id === 'deepseek-v4.1-flash')?.displayName).toBe('pi\u2019s label');
  });

  it('does not offer a provider pi cannot resolve', () => {
    const merged = mergePiCatalog([{ id: 'llama3.1:8b', provider: 'ollama', displayName: 'Llama 3.1 8B' }], enabledSettings());
    expect(merged.some((m) => m.provider === 'opencode-go')).toBe(false);
  });

  it('does not offer a provider the app has turned off', () => {
    const native = [{ id: 'deepseek-v4-pro', provider: 'opencode-go', displayName: 'DeepSeek V4 Pro (New)' }];
    expect(mergePiCatalog(native, defaultSettings())).toHaveLength(1);
  });
});
