/**
 * The canonical name of a model: `provider/model`. Shared by main and renderer so a model reads the
 * same in a picker row, a session header, an analytics legend and an override key.
 *
 * The model half is the provider's own id, which for an aggregator already carries the vendor, so an
 * OpenRouter model names its full route: `openrouter/deepseek/deepseek-flash`.
 */
import type { ModelRef } from './types';

/** Analytics-only unknown identity: no invented provider, displayed as `(unknown)` by modelKeyLabel. */
export const UNKNOWN_MODEL_KEY = '/(unknown)';

export function modelName(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** The canonical name of a stored selection, or undefined when the session has no explicit model. */
export function modelRefName(ref: ModelRef | undefined): string | undefined {
  return ref ? modelName(ref.provider, ref.model) : undefined;
}

/**
 * The name a stored model slice displays, read from the key it is filed under. Slices are keyed
 * `provider/model`, so history recorded before the provider was tracked (`/model`) keeps the bare
 * id instead of gaining a leading slash, and a slice stored under an older, unqualified label
 * still reads the same as every other surface.
 */
export function modelKeyLabel(key: string): string {
  return key.startsWith('/') ? key.slice(1) : key;
}

/**
 * Reads a name typed into the picker back into a ref, so a name it displayed can be pasted back in.
 * The leading segment is the provider only when it names one the app knows: an aggregator's id is
 * itself slashed (`z-ai/glm-4.6`), and splitting that would invent a provider called `z-ai`.
 */
export function parseTypedModel(typed: string, knownProviders: readonly string[], fallbackProvider: string): ModelRef {
  const i = typed.indexOf('/');
  if (i > 0) {
    const head = typed.slice(0, i);
    if (knownProviders.includes(head)) return { provider: head, model: typed.slice(i + 1) };
  }
  return { provider: fallbackProvider, model: typed };
}
