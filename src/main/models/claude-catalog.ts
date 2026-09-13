/**
 * Claude Code speaks the Anthropic API, so only anthropic-kind providers can host it. The built-in
 * Anthropic provider supplies the native catalog; any added gateway (GLM, Kimi, a LiteLLM proxy, …)
 * contributes its own models, and the adapter then pins the session's endpoint to the provider the
 * chosen model came from.
 */
import type { AppSettings, ModelInfo } from '../../shared/types';
import { isAnthropicGateway } from '../../shared/providers';
import { ANTHROPIC_STATIC_MODELS } from './static-models';

/** The built-in catalog: the Anthropic provider's cached list, or the static one when it has none. */
export function claudeNativeModels(settings: AppSettings): ModelInfo[] {
  const provider = settings.providers.find((p) => p.id === 'anthropic');
  const models = provider?.enabled !== false && provider?.models.length ? provider.models : ANTHROPIC_STATIC_MODELS;
  return models.map((m) => ({ ...m, provider: 'anthropic' }));
}

/** One configured gateway's models; empty when it is not an enabled Anthropic-compatible endpoint. */
export function claudeProviderModels(settings: AppSettings, providerId: string): ModelInfo[] {
  const provider = settings.providers.find((p) => p.id === providerId);
  if (!provider || !provider.enabled || !isAnthropicGateway(provider)) return [];
  return provider.models.map((m) => ({ ...m, provider: provider.id }));
}

/** Every usable gateway's models, appended to the native catalog without duplicates. */
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
