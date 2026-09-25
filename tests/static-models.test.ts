import { describe, expect, it } from 'vitest';
import { findContextWindow, findPricing } from '../src/main/models/static-models';
import type { ModelInfo } from '../src/shared/types';

const provider = 'gateway';
const base = 'anthropic/claude-sonnet-5';
const variant = `${base}[1m]`;
const baseRow: ModelInfo = { provider, id: base, displayName: 'Base', contextWindow: 200_000, pricing: { input: 2, output: 10 } };
const variantRow: ModelInfo = { provider, id: variant, displayName: 'Variant', contextWindow: 900_000, pricing: { input: 3, output: 15, cacheRead: 0.4, cacheWrite: 4 } };

describe('exact context-variant metadata', () => {
  it('keeps the full provider ID pricing before considering its base model', () => {
    expect(findPricing(provider, variant, [baseRow, variantRow])).toEqual(variantRow.pricing);
  });

  it('keeps the full provider ID window even when it differs from the marker', () => {
    expect(findContextWindow(provider, variant, [baseRow, variantRow])).toBe(900_000);
  });

  it('does not take a same-ID cached row from another provider', () => {
    const other = { ...variantRow, provider: 'other', contextWindow: 2_000_000, pricing: { input: 99, output: 99 } };
    expect(findPricing(provider, variant, [other, baseRow, variantRow])).toEqual(variantRow.pricing);
    expect(findContextWindow(provider, variant, [other, baseRow, variantRow])).toBe(900_000);
    expect(findPricing(provider, variant, [other, baseRow])).toEqual(baseRow.pricing);
    expect(findContextWindow(provider, variant, [other, baseRow])).toBe(1_000_000);
  });

  it.each([undefined, 0, -1, NaN, Infinity])('falls back independently when exact metadata is missing or invalid (%s)', (contextWindow) => {
    const incomplete = { ...variantRow, contextWindow, pricing: undefined };
    expect(findPricing(provider, variant, [baseRow, incomplete])).toEqual(baseRow.pricing);
    expect(findContextWindow(provider, variant, [baseRow, incomplete])).toBe(1_000_000);
    expect(findPricing(provider, variant, [{ ...incomplete, pricing: variantRow.pricing }, baseRow])).toEqual(variantRow.pricing);
  });

  it('retains marker, vendor-prefix and snapshot fallback when no exact row exists', () => {
    expect(findPricing('openrouter', 'anthropic/claude-sonnet-5[1m]')).toMatchObject({ input: 2, output: 10 });
    expect(findPricing('anthropic', 'claude-haiku-4-5-20251001[1m]')).toMatchObject({ input: 1, output: 5 });
    expect(findContextWindow('anthropic', 'claude-haiku-4-5-20251001[1m]')).toBe(1_000_000);
    expect(findContextWindow(provider, 'unknown-model[1m]')).toBe(1_000_000);
    expect(findPricing(provider, 'unknown-model[1m]')).toBeUndefined();
  });
});
