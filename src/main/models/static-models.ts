import type { ModelInfo, ProviderConfig, UsageTotals } from '../../shared/types';

/** Offline fallbacks with pricing (USD per 1M tokens). Live lists override these when available. */

export const ANTHROPIC_STATIC_MODELS: ModelInfo[] = [
  // Rates without cache columns are the ones Claude Code states for the model and nothing more; the
  // estimator derives its cache defaults from the input rate. `claude-opus-5-5` is here because the
  // runtime offers it and no other table row covers it — a version newer than every entry is exactly
  // what a prefix match must not price with its neighbour's older rate.
  m('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', 1_000_000, { input: 4, output: 20 }),
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

/** Map a Cursor catalog entry to the app's ModelInfo. */
export function cursorModelToInfo(m: { id: string; displayName?: string; description?: string }): ModelInfo {
  return {
    id: m.id,
    provider: 'cursor',
    displayName: m.displayName ?? m.id,
    description: m.description,
    supportsImages: true,
    supportsReasoning: true
  };
}

/**
 * DeepSeek's own catalog. V4.1 Flash is served under the bare id `deepseek-flash` — DeepSeek's
 * `/models` answers that, not the OpenCode Go slug `deepseek-v4.1-flash` — and it takes image input,
 * so the text-only default `m()` gives a DeepSeek model is overridden. Without the entry the model
 * still reached the picker from the live list but resolved to no context window and no pricing,
 * which left its context meter blank and its percentage auto-compaction thresholds unable to fire.
 */
export const DEEPSEEK_STATIC_MODELS: ModelInfo[] = [
  m('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 1_000_000, { input: 0.435, output: 0.87, cacheRead: 0.003625 }, true),
  { ...m('deepseek', 'deepseek-flash', 'DeepSeek V4.1 Flash', 1_000_000, { input: 0.15, output: 0.6, cacheRead: 0.003 }), supportsImages: true },
  m('deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash', 1_000_000, { input: 0.15, output: 0.6, cacheRead: 0.003 }),
  { ...m('deepseek', 'deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision (exp)', 1_000_000, { input: 0.15, output: 0.6, cacheRead: 0.003 }), supportsImages: true }
];

/**
 * OpenCode Go's catalog: the low-cost plan's open coding models, used offline until
 * `/zen/go/v1/models` answers. Context windows come from models.dev; prices are the plan's
 * published per-1M-token rates (the off-peak rate for the DeepSeek models, which the plan bills
 * higher during weekday peak).
 */
export const OPENCODE_GO_STATIC_MODELS: ModelInfo[] = [
  go('grok-4.6', 'Grok 4.6', 500_000, { input: 2, output: 6, cacheRead: 0.5 }, { images: true }),
  go('gpt-5.6-luna', 'GPT-5.6 Luna', 1_050_000, { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 }, { images: true }),
  go('glm-5.3-flash', 'GLM-5.3-Flash', 1_000_000, { input: 0.15, output: 0.5, cacheRead: 0.03 }, { images: true }),
  go('glm-5.3', 'GLM-5.3', 1_000_000, { input: 1.4, output: 4.4, cacheRead: 0.26 }),
  go('glm-5.2', 'GLM-5.2', 1_000_000, { input: 1.4, output: 4.4, cacheRead: 0.26 }),
  go('glm-5.1', 'GLM-5.1', 202_752, { input: 1.4, output: 4.4, cacheRead: 0.26 }),
  go('kimi-k3', 'Kimi K3', 1_048_576, { input: 3, output: 15, cacheRead: 0.3 }, { images: true }),
  go('kimi-k2.7-code', 'Kimi K2.7 Code', 262_144, { input: 0.95, output: 4, cacheRead: 0.19 }, { images: true }),
  // pi's own default model for this provider.
  go('kimi-k2.6', 'Kimi K2.6', 262_144, { input: 0.95, output: 4, cacheRead: 0.16 }, { images: true, isDefault: true }),
  go('longcat-2.0', 'LongCat-2.0', 1_000_000, { input: 0.3, output: 1.2, cacheRead: 0.006 }),
  go('mimo-v2.5', 'MiMo V2.5', 1_000_000, { input: 0.14, output: 0.28, cacheRead: 0.0028 }, { images: true }),
  go('mimo-v2.5-pro', 'MiMo V2.5 Pro', 1_048_576, { input: 0.435, output: 0.87, cacheRead: 0.003625 }),
  go('minimax-m3', 'MiniMax M3', 1_000_000, { input: 0.3, output: 1.2, cacheRead: 0.06 }, { images: true }),
  go('minimax-m2.7', 'MiniMax M2.7', 204_800, { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 }),
  go('minimax-m2.5', 'MiniMax M2.5', 204_800, { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 }),
  go('muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', 1_048_576, { input: 0.1, output: 0.2, cacheRead: 0.002 }, { images: true }),
  go('muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor', 1_048_576, { input: 0.1, output: 0.2, cacheRead: 0.002 }, { images: true }),
  go('qwen3.8-max', 'Qwen3.8 Max', 1_000_000, { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 }, { images: true }),
  go('qwen3.8-flash', 'Qwen3.8 Flash', 1_000_000, { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.2 }, { images: true }),
  go('qwen3.7-max', 'Qwen3.7 Max', 1_000_000, { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 }),
  go('qwen3.7-plus', 'Qwen3.7 Plus', 1_000_000, { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 }, { images: true }),
  go('qwen3.6-plus', 'Qwen3.6 Plus', 1_000_000, { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 }, { images: true }),
  go('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 1_000_000, { input: 0.15, output: 0.6, cacheRead: 0.003 }, { images: true }),
  go('deepseek-v4-pro', 'DeepSeek V4 Pro', 1_000_000, { input: 0.66, output: 1.98, cacheRead: 0.022 }),
  go('deepseek-v4-flash', 'DeepSeek V4 Flash', 1_000_000, { input: 0.15, output: 0.6, cacheRead: 0.003 }),
  go('deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision Exp', 1_000_000, { input: 0.15, output: 0.6, cacheRead: 0.003 }, { images: true }),
  go('hy4-preview', 'Hy4 preview', 1_024_000, { input: 0.834, output: 2.501, cacheRead: 0.042 }),
  go('hy3', 'Hy3', 256_000, { input: 0.14, output: 0.58, cacheRead: 0.035 })
];

/** One OpenCode Go entry; the plan mixes text-only and vision models, so image input is per model. */
function go(id: string, displayName: string, contextWindow: number, pricing: ModelInfo['pricing'], opts: { images?: boolean; isDefault?: boolean } = {}): ModelInfo {
  return {
    id,
    provider: 'opencode-go',
    displayName,
    contextWindow,
    pricing,
    isDefault: opts.isDefault,
    supportsImages: !!opts.images,
    supportsReasoning: true,
    supportedEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh']
  };
}

export const STATIC_MODELS_BY_PROVIDER: Record<string, ModelInfo[]> = {
  anthropic: ANTHROPIC_STATIC_MODELS,
  openai: OPENAI_STATIC_MODELS,
  deepseek: DEEPSEEK_STATIC_MODELS,
  'opencode-go': OPENCODE_GO_STATIC_MODELS
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

/**
 * Fill sparse harness catalogs from the matching provider cache or the built-in catalog. Context
 * windows fall back to any provider; reasoning levels come from OpenRouter, whose live API advertises
 * the exact levels a model accepts and can be newer than a harness's bundled `thinkingLevelMap`.
 */
export function enrichModelsFromProviders(models: ModelInfo[], providers: ProviderConfig[]): ModelInfo[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const routers = new Set(providers.filter((p) => p.kind === 'openrouter').map((p) => p.id));
  return models.map((model) => {
    const provider = byId.get(model.provider);
    let enriched = model;
    if (!validContextWindow(enriched.contextWindow)) {
      const contextWindow = findContextWindow(enriched.provider, enriched.id, provider?.models);
      if (contextWindow) enriched = { ...enriched, contextWindow };
    }
    if (routers.has(enriched.provider)) {
      const live = provider?.models.find((m) => m.id === enriched.id);
      if (live?.supportedEfforts?.length) enriched = { ...enriched, supportedEfforts: live.supportedEfforts, defaultEffort: live.defaultEffort ?? enriched.defaultEffort };
    }
    return enriched;
  });
}

export function findContextWindow(provider: string, model: string, extra: ModelInfo[] = []): number | undefined {
  const pool = [...extra.filter((x) => x.provider === provider), ...(STATIC_MODELS_BY_PROVIDER[provider] ?? [])].filter((x) => validContextWindow(x.contextWindow));
  const fullExact = pool.find((x) => x.id === model);
  if (fullExact) return fullExact.contextWindow;
  const { base, markedWindow } = splitContextMarker(model);
  // Without an exact row, the marker outranks whatever the base model carries — and it is the
  // only thing known about the window of a model no table row covers yet.
  const atLeast = (value: number | undefined) => (markedWindow ? Math.max(value ?? 0, markedWindow) : value);
  const exact = pool.find((x) => x.id === base);
  if (exact) return atLeast(exact.contextWindow);
  const bare = base.split('/').pop() ?? base;
  const bareExact = pool.find((x) => x.id === bare);
  if (bareExact) return atLeast(bareExact.contextWindow);
  const fuzzy = pool
    .filter((x) => bare.startsWith(x.id) && isSnapshotSuffix(bare.slice(x.id.length)))
    .sort((a, b) => b.id.length - a.id.length)[0];
  return atLeast(fuzzy?.contextWindow);
}

function validContextWindow(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * A trailing context marker on a runtime model id, which Claude Code writes as the window in
 * millions of tokens (`[1m]`). When no exact metadata row exists, both lookups strip it to inherit
 * the base model's metadata; only the window cares what it said.
 */
function splitContextMarker(model: string): { base: string; markedWindow?: number } {
  const marker = /\[(\d+)m\]$/i.exec(model);
  if (!marker) return { base: model };
  return { base: model.slice(0, marker.index), markedWindow: Number(marker[1]) * 1_000_000 };
}

/** Context variants can differ from their base model; only dated/latest snapshots inherit it. */
function isSnapshotSuffix(suffix: string): boolean {
  return /^[-._/](?:latest|\d{8}|\d{4}(?:[-._]\d{2}){1,2})$/i.test(suffix);
}

/**
 * One provider's own cached catalog, for the pricing lookups here and in the repair helpers. Only
 * this list carries a model nobody else knows: a gateway's vendor-named id (OpenRouter's
 * `z-ai/glm-5.3-flash`) exists in the provider's cached models and in no bundled catalog, so a
 * lookup without it finds no price and the caller falls back to whatever the harness guessed.
 */
export function modelsForProvider(providers: ProviderConfig[], id: string | undefined): ModelInfo[] {
  return providers.find((p) => p.id === id)?.models ?? [];
}

export function findPricing(provider: string, model: string, extra: ModelInfo[] = []): ModelInfo['pricing'] | undefined {
  const pool = [...extra.filter((x) => x.provider === provider), ...(STATIC_MODELS_BY_PROVIDER[provider] ?? []), ...OPENAI_STATIC_MODELS, ...ANTHROPIC_STATIC_MODELS, ...DEEPSEEK_STATIC_MODELS];
  const fullExact = pool.find((x) => x.id === model && x.pricing);
  if (fullExact) return fullExact.pricing;
  // Only inherit the base model's rate when no full-ID row prices this context variant. Matching
  // the marker instead would drop `claude-sonnet-5[1m]` onto a shorter, older entry.
  const { base } = splitContextMarker(model);
  const exact = pool.find((x) => x.id === base && x.pricing);
  if (exact) return exact.pricing;
  // OpenRouter-style ids (vendor/model) or dated snapshots. A prefix only counts when the live
  // id continues with a separator: 'gpt-5.4-2025-08-07' matches 'gpt-5.4', but a short live id
  // like 'gpt-5' must not be priced with a longer catalog entry such as 'gpt-5.6-luna'.
  const bare = base.split('/').pop() ?? base;
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
