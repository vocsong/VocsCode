import type { ModelInfo, UsageTotals } from '../../shared/types';

/** Offline fallbacks with pricing (USD per 1M tokens). Live lists override these when available. */

export const ANTHROPIC_STATIC_MODELS: ModelInfo[] = [
  m('anthropic', 'claude-opus-5', 'Claude Opus 5', 1_000_000, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, true),
  m('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', 1_000_000, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }),
  m('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', 1_000_000, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }),
  m('anthropic', 'claude-fable-5', 'Claude Fable 5', 1_000_000, { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }),
  m('anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', 1_000_000, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }),
  m('anthropic', 'claude-opus-4-7', 'Claude Opus 4.7', 1_000_000, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }),
  m('anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', 1_000_000, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }),
  m('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 1_000_000, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }),
  m('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', 200_000, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 })
];

export const OPENAI_STATIC_MODELS: ModelInfo[] = [
  m('openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', 272_000, { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 }, true),
  m('openai', 'gpt-5.6-sol', 'GPT-5.6 Sol', 272_000, { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }),
  m('openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', 272_000, { input: 5, output: 30, cacheRead: 0.5 }),
  m('openai', 'gpt-5.5', 'GPT-5.5', 272_000, { input: 5, output: 30, cacheRead: 0.5 }),
  m('openai', 'gpt-5.4', 'GPT-5.4', 272_000, { input: 2.5, output: 15, cacheRead: 0.25 }),
  m('openai', 'gpt-5.4-mini', 'GPT-5.4 mini', 272_000, { input: 0.75, output: 4.5, cacheRead: 0.075 }),
  m('openai', 'gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', 128_000, { input: 1.75, output: 14, cacheRead: 0.175 })
];

/** Codex catalog (same slugs as OpenAI; Codex may expose more via model/list). */
export const CODEX_STATIC_MODELS: ModelInfo[] = OPENAI_STATIC_MODELS.map((x) => ({ ...x, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }));

/**
 * Cursor offline fallback. The live catalog comes from Cursor.models.list(); 'auto' is the
 * always-valid selection (Cursor routes to the best model per request).
 */
export const CURSOR_STATIC_MODELS: ModelInfo[] = [
  { id: 'auto', provider: 'cursor', displayName: 'Auto', description: 'Cursor picks the best model for each request.', isDefault: true, supportsImages: true }
];

export const DEEPSEEK_STATIC_MODELS: ModelInfo[] = [
  m('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 1_000_000, { input: 0.435, output: 0.87, cacheRead: 0.003625 }, true),
  m('deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash', 1_000_000, { input: 0.14, output: 0.28, cacheRead: 0.0028 }),
  { ...m('deepseek', 'deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision (exp)', 1_000_000, { input: 0.14, output: 0.28, cacheRead: 0.0028 }), supportsImages: true }
];

export const STATIC_MODELS_BY_PROVIDER: Record<string, ModelInfo[]> = {
  anthropic: ANTHROPIC_STATIC_MODELS,
  openai: OPENAI_STATIC_MODELS,
  deepseek: DEEPSEEK_STATIC_MODELS
};

function m(provider: string, id: string, displayName: string, contextWindow: number, pricing: ModelInfo['pricing'], isDefault = false): ModelInfo {
  return {
    id,
    provider,
    displayName,
    contextWindow,
    pricing,
    isDefault,
    supportsImages: provider !== 'deepseek',
    supportsReasoning: true,
    supportedEfforts: provider === 'anthropic' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['minimal', 'low', 'medium', 'high', 'xhigh'],
    maxOutputTokens: provider === 'anthropic' ? 128_000 : undefined
  };
}

export function findPricing(provider: string, model: string, extra: ModelInfo[] = []): ModelInfo['pricing'] | undefined {
  const pool = [...extra, ...(STATIC_MODELS_BY_PROVIDER[provider] ?? []), ...OPENAI_STATIC_MODELS, ...ANTHROPIC_STATIC_MODELS, ...DEEPSEEK_STATIC_MODELS];
  const exact = pool.find((x) => x.id === model && x.pricing);
  if (exact) return exact.pricing;
  // OpenRouter-style ids (vendor/model) or dated snapshots. A prefix only counts when the live
  // id continues with a separator: 'gpt-5.4-2025-08-07' matches 'gpt-5.4', but a short live id
  // like 'gpt-5' must not be priced with a longer catalog entry such as 'gpt-5.6-luna'.
  const bare = model.split('/').pop() ?? model;
  const bareExact = pool.find((x) => x.id === bare && x.pricing);
  if (bareExact) return bareExact.pricing;
  const fuzzy = pool.find((x) => {
    if (!x.pricing) return false;
    if (!bare.startsWith(x.id) || bare.length <= x.id.length) return false;
    return /^[-._/]$/.test(bare[x.id.length] ?? '');
  });
  return fuzzy?.pricing;
}

export function estimateCostUsd(
  pricing: ModelInfo['pricing'] | undefined,
  usage: Pick<UsageTotals, 'inputTokens' | 'outputTokens'> & Partial<Pick<UsageTotals, 'cacheReadTokens' | 'cacheWriteTokens'>>
): number {
  if (!pricing) return 0;
  const perTok = (perM: number | undefined) => (perM ?? 0) / 1_000_000;
  return (
    usage.inputTokens * perTok(pricing.input) +
    usage.outputTokens * perTok(pricing.output) +
    (usage.cacheReadTokens ?? 0) * perTok(pricing.cacheRead ?? pricing.input * 0.1) +
    (usage.cacheWriteTokens ?? 0) * perTok(pricing.cacheWrite ?? pricing.input * 1.25)
  );
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };
}
