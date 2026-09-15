/**
 * pi's picker lists only what pi's own registry knows, and that registry lags a provider's plan:
 * OpenCode Go shipped DeepSeek V4.1 Flash after the pi model snapshot in use, so the model was in
 * the app's catalog (and on the gateway) but pi never listed it. The app's bundled catalogs are
 * the models Vocs Code itself advertises, and every provider pi already lists is reachable through
 * `--provider`, so those models are merged into the pi picker here — the same seam Claude and
 * Codex already get.
 *
 * Two guards keep the merge honest. Only a provider pi already lists *and* the app has enabled is
 * extended: a chosen model starts the session as `--provider <id> --model <id>`, so a provider pi
 * cannot resolve must never be offered. And only the bundled (offline) catalogs merge, not a
 * provider's raw live `/models` feed — pi's registry stays authoritative for what pi can run, and
 * the merge only fills the gap for models the app already ships with pricing and context metadata.
 */
import type { AppSettings, ModelInfo } from '../../shared/types';
import { STATIC_MODELS_BY_PROVIDER } from './static-models';

/** One enabled, pi-reachable provider's bundled models; empty when either side does not have it. */
export function piProviderModels(providerId: string, reachable: ReadonlySet<string>, settings: AppSettings): ModelInfo[] {
  if (!reachable.has(providerId)) return [];
  const provider = settings.providers.find((p) => p.id === providerId);
  if (!provider?.enabled) return [];
  return (STATIC_MODELS_BY_PROVIDER[providerId] ?? []).map((m) => ({ ...m, provider: providerId }));
}

/** pi's own list plus the app's bundled catalogs for every enabled provider pi already lists. */
export function mergePiCatalog(native: ModelInfo[], settings: AppSettings): ModelInfo[] {
  const reachable = new Set(native.map((m) => m.provider));
  const seen = new Set(native.map((m) => `${m.provider}/${m.id}`));
  const extra: ModelInfo[] = [];
  for (const providerId of Object.keys(STATIC_MODELS_BY_PROVIDER)) {
    for (const model of piProviderModels(providerId, reachable, settings)) {
      const key = `${model.provider}/${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      extra.push(model);
    }
  }
  return [...native, ...extra];
}
