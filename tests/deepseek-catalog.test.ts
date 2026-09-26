/**
 * DeepSeek's models reach the app through more than one provider, and the providers do not agree on
 * what the flash model is called: DeepSeek's own API serves it as the bare `deepseek-flash`, while
 * OpenCode Go slugs the same model `deepseek-v4.1-flash`. The offline catalogs have to carry the id
 * each provider actually answers, or the model is selectable but resolves to nothing. These tests
 * pin what the bundled catalogs promise for it — the 1M context window the session context meter
 * and the percentage auto-compaction thresholds read, its pricing, and its image support.
 */
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/main/settings';
import { listHarnessModels } from '../src/main/harness/registry';
import { DEEPSEEK_STATIC_MODELS, OPENCODE_GO_STATIC_MODELS, estimateCostUsd, findContextWindow, findPricing } from '../src/main/models/static-models';
import { autoCompactionTokenThreshold, hasReachedAutoCompactionThreshold } from '../src/shared/compaction';
import type { ModelInfo } from '../src/shared/types';

/** DeepSeek V4.1 Flash's published per-1M-token rate, on both providers that ship it. */
const V4_1_FLASH_PRICING = { input: 0.15, output: 0.6, cacheRead: 0.003 };

const byId = (models: ModelInfo[], id: string): ModelInfo | undefined => models.find((m) => m.id === id);

describe('DeepSeek DeepSeek V4.1 Flash', () => {
  it("ships under the id DeepSeek's own API serves, at 1M with image input", () => {
    expect(byId(DEEPSEEK_STATIC_MODELS, 'deepseek-flash')).toMatchObject({
      provider: 'deepseek',
      displayName: 'DeepSeek V4.1 Flash',
      contextWindow: 1_000_000,
      supportsImages: true,
      pricing: V4_1_FLASH_PRICING
    });
  });

  it('resolves the context window and price a harness reads when the live list is stale', () => {
    // A harness resolves both by id against the bundled catalogs; an id that is missing here leaves
    // the model running with no window and no price rather than failing loudly.
    expect(findContextWindow('deepseek', 'deepseek-flash')).toBe(1_000_000);
    expect(findPricing('deepseek', 'deepseek-flash')).toEqual(V4_1_FLASH_PRICING);
  });

  it('lets a percentage auto-compaction threshold fire against its 1M window', () => {
    const contextWindow = findContextWindow('deepseek', 'deepseek-flash')!;
    expect(autoCompactionTokenThreshold('90%', { contextWindow })).toBe(900_000);
    expect(hasReachedAutoCompactionThreshold('90%', { contextTokens: 900_000, contextWindow })).toBe(true);
    expect(hasReachedAutoCompactionThreshold('90%', { contextTokens: 899_999, contextWindow })).toBe(false);
  });

  it('prices a turn at the published rate', () => {
    const cost = estimateCostUsd(findPricing('deepseek', 'deepseek-flash'), {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000
    });
    expect(cost).toBeCloseTo(0.753, 6);
  });

  it('offers the three tiers DeepSeek serves, so max is reachable and its aliases do not hide it', () => {
    // low/high/max are the scalar efforts 50/75/100. minimal and medium/xhigh are only aliases onto
    // them, so listing the aliases both hid `max` and made one tier look like three.
    for (const entry of DEEPSEEK_STATIC_MODELS) expect(entry.supportedEfforts).toEqual(['low', 'high', 'max']);
  });

  it('is offered on the DeepSeek provider by the harnesses that list bundled catalogs', async () => {
    const { models } = await listHarnessModels({
      harness: 'native',
      settings: defaultSettings(),
      runtime: { resolve: () => null } as never,
      getApiKey: async () => undefined
    });
    expect(models.find((m) => m.provider === 'deepseek' && m.id === 'deepseek-flash')).toMatchObject({
      contextWindow: 1_000_000,
      supportsImages: true,
      supportedEfforts: ['low', 'high', 'max']
    });
  });
});

describe('DeepSeek models across providers', () => {
  it('keeps the same flash model at 1M on the other provider that bundles it', () => {
    expect(byId(OPENCODE_GO_STATIC_MODELS, 'deepseek-v4.1-flash')).toMatchObject({
      contextWindow: 1_000_000,
      supportsImages: true,
      pricing: V4_1_FLASH_PRICING
    });
    expect(findContextWindow('opencode-go', 'deepseek-v4.1-flash')).toBe(1_000_000);
  });

  it('bundles every DeepSeek model as a 1M-context model with pricing', () => {
    const bundled = [...DEEPSEEK_STATIC_MODELS, ...OPENCODE_GO_STATIC_MODELS.filter((m) => m.id.startsWith('deepseek'))];
    expect(bundled).toHaveLength(8);
    expect(bundled.every((m) => m.contextWindow === 1_000_000 && !!m.pricing)).toBe(true);
  });
});
