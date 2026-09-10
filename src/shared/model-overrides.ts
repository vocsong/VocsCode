/**
 * User-supplied corrections to model capability metadata.
 *
 * Every harness reports `supportsImages` from a different source — Pi and Codex from their own
 * catalogs, OpenRouter from `architecture.input_modalities`, plain OpenAI-compatible endpoints
 * from a guess at the model name. Those sources go stale, and hand-written ones (e.g. a model
 * added by hand to `~/.pi/agent/models.json`) are often wrong from the start. An override lets
 * the user correct a single model without touching any of that.
 */
import type { ModelInfo, ModelOverride, ModelRef } from './types';

/** Overrides are keyed by `provider/model` so the same slug on two providers stays distinct. */
export function modelOverrideKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** Model ids may contain slashes (OpenRouter), so only the first one separates the provider. */
export function parseModelOverrideKey(key: string): ModelRef {
  const i = key.indexOf('/');
  return i < 0 ? { provider: '', model: key } : { provider: key.slice(0, i), model: key.slice(i + 1) };
}

export function findModelOverride(overrides: Record<string, ModelOverride> | undefined, ref: ModelRef | undefined): ModelOverride | undefined {
  if (!overrides || !ref) return undefined;
  return overrides[modelOverrideKey(ref.provider, ref.model)];
}

/** Returns a new list with overrides folded in. Fields left undefined on an override are ignored. */
export function applyModelOverrides(models: ModelInfo[], overrides: Record<string, ModelOverride> | undefined): ModelInfo[] {
  if (!overrides || !Object.keys(overrides).length) return models;
  return models.map((m) => {
    const o = overrides[modelOverrideKey(m.provider, m.id)];
    if (!o || o.supportsImages === undefined) return m;
    return { ...m, supportsImages: o.supportsImages, overridden: true };
  });
}

/** Drops empty entries so settings.json does not accumulate `{}` values as overrides are cleared. */
export function pruneModelOverrides(overrides: Record<string, ModelOverride> | undefined): Record<string, ModelOverride> {
  const out: Record<string, ModelOverride> = {};
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (v && v.supportsImages !== undefined) out[k] = { supportsImages: v.supportsImages };
  }
  return out;
}
