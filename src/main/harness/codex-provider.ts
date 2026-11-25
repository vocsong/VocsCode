/** Shared Codex provider routing, Fast-mode capability/tier helpers, and session image persistence. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fastModeSupport, type FastModeSupport } from '../../shared/fast-mode';
import { isCodexBuiltinProvider, isOpenAiWireProvider } from '../../shared/providers';
import type { AppSettings, FastModeStatus, HarnessId, ModelInfo, ModelRef, SessionMeta } from '../../shared/types';
import { shortId } from '../util/async';

export interface CodexCustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  envKey?: string;
  wireApi: 'chat' | 'responses';
}

export const CODEX_FAST_PRICING_UNAVAILABLE_MSG =
  'Fast-mode pricing is unavailable for this model/context. Reported spend excludes these requests; check the provider bill for the full cost.';

/**
 * The OpenAI-compatible provider this thread is pinned to. An explicit session override wins;
 * otherwise a model selected from one of the app's configured providers supplies one. Codex's
 * own `openai` provider needs no `model_providers` entry. Codex 0.153 only accepts the Responses
 * wire API, so every custom provider is registered as `responses`.
 */
export function resolveCodexProvider(meta: SessionMeta, settings: AppSettings): CodexCustomProvider | undefined {
  const explicit = meta.config.codexModelProvider;
  if (explicit) return { ...explicit, wireApi: explicit.wireApi ?? 'responses' };
  const id = (meta.config.model ?? meta.activeModel)?.provider;
  if (isCodexBuiltinProvider(id)) return undefined;
  const provider = settings.providers.find((p) => p.id === id && p.enabled && p.baseUrl && isOpenAiWireProvider(p));
  if (!provider?.baseUrl) return undefined;
  return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, envKey: provider.envKey, wireApi: 'responses' };
}

export function isCodexFastTier(tier: string | null | undefined): boolean {
  return tier === 'fast' || tier === 'priority';
}

export function isCodexFastUnavailableStderr(line: string): boolean {
  return /configured tier.*not advertised|fast.*(?:disabled|unavailable)|service.tier.*(?:ignored|unsupported)/i.test(line);
}

export function codexFastModeCapability(opts: {
  harness: HarnessId;
  hasCustomProvider: boolean;
  modelRef: ModelRef | undefined;
  models: readonly ModelInfo[];
  speedTiers: ReadonlyMap<string, string[]>;
  providers: AppSettings['providers'];
}): FastModeSupport {
  if (opts.hasCustomProvider) return { supported: false, reason: 'Fast mode is unavailable on custom Codex provider routes.' };
  const model = opts.modelRef?.model ?? opts.models.find((entry) => entry.isDefault)?.id;
  if (model && opts.speedTiers.size && !opts.models.some((entry) => entry.id === model)) {
    return { supported: false, reason: 'The selected model is not in this Codex runtime’s available model catalog.' };
  }
  const tiers = model ? opts.speedTiers.get(model) : undefined;
  if (tiers && !tiers.includes('fast') && !tiers.includes('priority')) {
    return { supported: false, reason: 'This Codex runtime does not advertise a Fast service tier for the selected model.' };
  }
  return fastModeSupport(opts.harness, opts.modelRef, opts.providers);
}

export function codexFastServiceTier(
  modelId: string | undefined,
  models: readonly ModelInfo[],
  speedTiers: ReadonlyMap<string, string[]>
): string {
  const model = modelId ?? models.find((entry) => entry.isDefault)?.id;
  return model && speedTiers.get(model)?.includes('priority') ? 'priority' : 'fast';
}

export function codexFastModeStatus(enabled: boolean, support: FastModeSupport): FastModeStatus {
  if (!enabled) return { state: 'off' };
  return support.supported ? { state: 'requested' } : { state: 'unavailable', detail: support.reason };
}

/** Writes one base64 user image into `<sessionDir>/images/` and returns the saved file path. */
export async function writeCodexSessionImage(
  sessionDir: string,
  img: { mimeType: string; data: string }
): Promise<string> {
  const ext = img.mimeType.split('/')[1] ?? 'png';
  const file = path.join(sessionDir, 'images', `${shortId('img_')}.${ext}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(img.data, 'base64'));
  return file;
}
