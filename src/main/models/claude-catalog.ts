/**
 * Claude Code speaks the Anthropic API. Anthropic's own endpoint supplies the native catalog; every
 * other Claude-capable provider (an anthropic-kind gateway such as GLM or LiteLLM, or a vendor that
 * publishes its own Anthropic route such as OpenRouter or DeepSeek) contributes its models, and the
 * adapter pins the session's endpoint to the provider the chosen model came from.
 */
import type { ModelInfo as ClaudeSdkModelInfo } from '@anthropic-ai/claude-agent-sdk';
import type { AppSettings, EffortLevel, ModelInfo } from '../../shared/types';
import { isClaudeCapableProvider } from '../../shared/providers';
import { ANTHROPIC_STATIC_MODELS, findContextWindow } from './static-models';

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

/** Keep the first row for each selectable provider/id, preserving order and metadata.
 *  Run after alias-to-explicit mapping: different SDK rows, the recommended `default` among them,
 *  can resolve to the same selection. Context variants and identical model ids on different
 *  providers remain distinct. */
export function dedupeClaudeModels(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = JSON.stringify([model.provider, model.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The runtime's live Anthropic rows, then the saved catalog's rows it did not list. Discovery adds to
 * the catalog rather than replacing it: a login's short list must not take away a model the saved or
 * static catalog still offers. A saved row is dropped when a live row is the same model, a dated
 * snapshot included (`claude-haiku-4-5-20251001` covers `claude-haiku-4-5`); a context variant stays
 * its own selection. Only the runtime's recommendation is kept, so the saved rows lose their flag.
 */
export function withSavedClaudeModels(live: ModelInfo[], saved: ModelInfo[]): ModelInfo[] {
  const undated = (id: string) => id.replace(/-\d{8}(?=\[\d+m\]$|$)/i, '');
  const listed = new Set(live.map((m) => JSON.stringify([m.provider, undated(m.id)])));
  const rest = saved.filter((m) => !listed.has(JSON.stringify([m.provider, undated(m.id)])));
  return [...live, ...rest.map((m) => ({ ...m, isDefault: false }))];
}

/** Every usable provider's models, appended to the native catalog without duplicates. */
export function mergeClaudeCatalog(native: ModelInfo[], settings: AppSettings): ModelInfo[] {
  return dedupeClaudeModels([...native, ...settings.providers.flatMap((provider) => claudeProviderModels(settings, provider.id))]);
}

/**
 * The SDK's model rows as a selectable catalog. The recommended row leads, so deduplication keeps
 * it (and its flag) over the explicit row for the same model. A `default` the runtime does not
 * resolve has no version to pin, so it is left out rather than offered as a moving alias.
 * `opusplan` (Opus Plan Mode) is not offered: it is a behaviour, not a model, and its resolved id is
 * the execution model, so a pinned row would label a plain Sonnet session "Opus Plan Mode".
 */
export function claudeSdkCatalog(models: ClaudeSdkModelInfo[]): ModelInfo[] {
  // Claude Code sends the effort fields only for a model that takes effort, never `supportsEffort:
  // false`. A row without them has no effort, but only from a runtime that reports them on some
  // row: one that never does (an older install) leaves every model's effort unknown.
  const reportsEffort = models.some((m) => m.supportsEffort === true);
  const rows = models.map((m) => claudeModelToInfo(m, reportsEffort)).filter((m, i) => m.id !== 'default' && models[i].value !== 'opusplan');
  return dedupeClaudeModels([...rows.filter((m) => m.isDefault), ...rows.filter((m) => !m.isDefault)]);
}

/** `reportsEffort`: the runtime reports effort support, so a row without it takes no effort. */
export function claudeModelToInfo(m: ClaudeSdkModelInfo, reportsEffort = false): ModelInfo {
  // Every row, the recommended `default` included, is listed under the canonical wire id it
  // resolves to. A remembered selection is then a version pin: it survives Claude renaming an alias
  // such as `sonnet`, and a later start or resume never follows a changed recommendation.
  const id = m.resolvedModel || m.value;
  const recommended = m.value === 'default' && id !== 'default';
  const name = m.description?.split(' · ')[0]?.trim() || (recommended ? id : m.displayName || m.value);
  const supportsEffort = m.supportsEffort === true;
  return {
    id,
    provider: 'anthropic',
    displayName: recommended ? `${name} (recommended)` : name,
    description: m.description,
    contextWindow: findContextWindow('anthropic', id),
    supportsImages: true,
    supportsReasoning: supportsEffort || m.supportsAdaptiveThinking === true,
    supportedEfforts: claudeEfforts(m, reportsEffort),
    isDefault: recommended
  };
}

/** A row's effort levels: `[]` for a model that takes none, `undefined` while that is unknown. */
function claudeEfforts(m: ClaudeSdkModelInfo, reportsEffort: boolean): EffortLevel[] | undefined {
  if (m.supportsEffort === true) return m.supportedEffortLevels?.length ? [...m.supportedEffortLevels] : undefined;
  return m.supportsEffort === false || reportsEffort ? [] : undefined;
}
