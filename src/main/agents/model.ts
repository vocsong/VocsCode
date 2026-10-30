/** Selects providers for background completions (titles, branch names and knowledge jobs). */
import { randomUUID } from 'node:crypto';
import type { ModelRef, ProviderConfig } from '../../shared/types';
import { STATIC_MODELS_BY_PROVIDER } from '../models/static-models';

export interface BackgroundModel {
  provider: ProviderConfig;
  model: string;
}

/** One routing id per background task; callers with a real session supply its stable id. */
export function backgroundHeaders(provider: ProviderConfig, sessionId?: string): Record<string, string> | undefined {
  if (provider.kind !== 'opencode-go') return provider.headers;
  return { ...provider.headers, 'x-opencode-client': 'vocs-code', 'x-opencode-session': sessionId ?? randomUUID() };
}

/** Providers that can actually answer: a stored key, an env key, or a local runtime that needs neither. */
export function usableProviders(providers: ProviderConfig[]): ProviderConfig[] {
  return providers.filter((p) => p.enabled && (p.hasApiKey || (p.envKey && process.env[p.envKey]) || p.kind === 'ollama' || p.kind === 'lmstudio'));
}

export function defaultModelFor(p: ProviderConfig): string | null {
  const models = p.models.length ? p.models : STATIC_MODELS_BY_PROVIDER[p.id] ?? [];
  return (models.find((m) => m.isDefault) ?? models[0])?.id ?? null;
}

/**
 * Resolves the first preference whose provider is usable, falling back to any usable
 * provider's default model. Returns null when nothing is configured, so callers can
 * degrade instead of throwing.
 */
export function selectBackgroundModel(providers: ProviderConfig[], ...preferred: (ModelRef | undefined)[]): BackgroundModel | null {
  const usable = usableProviders(providers);
  for (const ref of preferred) {
    if (!ref) continue;
    const p = usable.find((x) => x.id === ref.provider);
    if (p) return { provider: p, model: ref.model };
  }
  for (const p of usable) {
    const model = defaultModelFor(p);
    if (model) return { provider: p, model };
  }
  return null;
}
