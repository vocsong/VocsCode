/**
 * Claude Code speaks the Anthropic API. Anthropic's own endpoint supplies the native catalog; every
 * other Claude-capable provider (an anthropic-kind gateway such as GLM or LiteLLM, or a vendor that
 * publishes its own Anthropic route such as OpenRouter or DeepSeek) contributes its models, and the
 * adapter pins the session's endpoint to the provider the chosen model came from.
 */
import type { AppSettings, ModelInfo } from '../../shared/types';
import { isClaudeCapableProvider } from '../../shared/providers';
import { ANTHROPIC_STATIC_MODELS } from './static-models';

/** The built-in catalog: the Anthropic provider's cached list, or the static one when it has none. */
export function claudeNativeModels(settings: AppSettings): ModelInfo[] {
  const provider = settings.providers.find((p) => p.id === 'anthropic');
  const models = provider?.enabled !== false && provider?.models.length ? provider.models : ANTHROPIC_STATIC_MODELS;
  return models.map((m) => ({ ...m, provider: 'anthropic' }));
}

/** One other Claude-capable provider's models; empty when it is disabled or cannot host Claude Code. */
export function claudeProviderModels(settings: AppSettings, providerId: string): ModelInfo[] {
  const provider = settings.providers.find((p) => p.id === providerId);
  if (!provider || !provider.enabled || provider.id === 'anthropic' || !isClaudeCapableProvider(provider)) return [];
  return provider.models.map((m) => ({ ...m, provider: provider.id }));
}

/** Every usable provider's models, appended to the native catalog without duplicates. */
export function mergeClaudeCatalog(native: ModelInfo[], settings: AppSettings): ModelInfo[] {
  const seen = new Set(native.map((m) => `${m.provider}/${m.id}`));
  const extra: ModelInfo[] = [];
  for (const provider of settings.providers) {
    for (const model of claudeProviderModels(settings, provider.id)) {
      const key = `${model.provider}/${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      extra.push(model);
    }
  }
  return [...native, ...extra];
}
