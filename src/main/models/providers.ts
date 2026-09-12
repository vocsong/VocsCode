import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ModelInfo, ProviderConfig } from '../../shared/types';
import { errorMessage } from '../util/async';
import { cursorModelToInfo } from '../harness/cursor';
import { STATIC_MODELS_BY_PROVIDER, findPricing } from './static-models';

/** Stored key first, then the provider's env var. */
export async function resolveProviderApiKey(provider: ProviderConfig, getSecret: (id: string) => Promise<string | undefined>): Promise<string | undefined> {
  const stored = await getSecret(provider.id);
  if (stored) return stored;
  if (provider.envKey && process.env[provider.envKey]) return process.env[provider.envKey];
  return undefined;
}

// Note: "-instruct" models are chat-capable on most OpenAI-compatible hosts, so they stay listed.
const NON_CHAT = /(embed|embedding|whisper|tts|dall-e|image|moderation|realtime|transcribe|audio|rerank|search-preview|babbage|davinci|guard)/i;

/** Common non-standard fields returned by OpenAI-compatible model catalogs. */
function compatibleContextWindow(model: unknown): number | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const record = model as Record<string, unknown>;
  for (const key of ['context_window', 'context_length', 'max_context_length', 'max_model_len']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

export function fallbackModels(provider: ProviderConfig): ModelInfo[] {
  return (STATIC_MODELS_BY_PROVIDER[provider.id] ?? []).map((m) => ({ ...m, provider: provider.id }));
}

export async function fetchProviderModels(provider: ProviderConfig, apiKey: string | undefined): Promise<ModelInfo[]> {
  if (provider.kind === 'cursor') {
    // Not an API endpoint: models live in the Cursor harness picker, and the key is checked there.
    if (!apiKey) throw new Error('No Cursor API key stored. Add one under this provider or set CURSOR_API_KEY.');
    const { Cursor } = await import('@cursor/sdk');
    const models = await Cursor.models.list({ apiKey });
    return models.map((m) => ({ ...cursorModelToInfo(m), provider: provider.id }));
  }
  if (provider.kind === 'anthropic') {
    const client = new Anthropic({ apiKey, baseURL: provider.baseUrl, defaultHeaders: provider.headers });
    const out: ModelInfo[] = [];
    for await (const m of client.models.list({ limit: 100 })) {
      const mm = m as { id: string; display_name?: string; max_input_tokens?: number; max_tokens?: number };
      out.push({
        id: mm.id,
        provider: provider.id,
        displayName: mm.display_name ?? mm.id,
        contextWindow: mm.max_input_tokens,
        maxOutputTokens: mm.max_tokens,
        supportsImages: true,
        supportsReasoning: /claude-(opus|sonnet|fable|mythos|haiku)-(4|5)/.test(mm.id),
        supportedEfforts: /claude-(opus-4-[6-9]|opus-5|sonnet-4-6|sonnet-5|fable|mythos)/.test(mm.id) ? ['low', 'medium', 'high', 'xhigh', 'max'] : undefined,
        pricing: findPricing('anthropic', mm.id)
      });
    }
    return mergeWithStatic(out, provider);
  }
  if (provider.kind === 'openrouter') {
    const res = await fetch(`${(provider.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    });
    if (!res.ok) throw new Error(`OpenRouter /models failed: ${res.status}`);
    const json = (await res.json()) as { data: { id: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string; input_cache_read?: string }; architecture?: { input_modalities?: string[] }; supported_parameters?: string[] }[] };
    return json.data
      .filter((m) => !NON_CHAT.test(m.id))
      .map((m) => ({
        id: m.id,
        provider: provider.id,
        displayName: m.name ?? m.id,
        contextWindow: m.context_length,
        supportsImages: (m.architecture?.input_modalities ?? []).includes('image'),
        supportsReasoning: (m.supported_parameters ?? []).includes('reasoning'),
        pricing: m.pricing ? { input: Number(m.pricing.prompt ?? 0) * 1_000_000, output: Number(m.pricing.completion ?? 0) * 1_000_000, cacheRead: m.pricing.input_cache_read ? Number(m.pricing.input_cache_read) * 1_000_000 : undefined } : undefined
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  // Generic OpenAI-compatible /models
  const client = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: provider.baseUrl, defaultHeaders: provider.headers, maxRetries: 1 });
  const out: ModelInfo[] = [];
  const page = await client.models.list();
  for await (const m of page) {
    if (NON_CHAT.test(m.id)) continue;
    out.push({ id: m.id, provider: provider.id, displayName: m.id, contextWindow: compatibleContextWindow(m), supportsImages: /gpt-4o|gpt-4\.1|gpt-5|vision|llava|gemini|pixtral|vl/i.test(m.id), supportsReasoning: /^(o\d|gpt-5)|reason|r1|thinking|deepseek/i.test(m.id), pricing: findPricing(provider.id, m.id) });
  }
  return mergeWithStatic(out.sort((a, b) => a.id.localeCompare(b.id)), provider);
}

function mergeWithStatic(live: ModelInfo[], provider: ProviderConfig): ModelInfo[] {
  const stat = fallbackModels(provider);
  const map = new Map<string, ModelInfo>();
  for (const m of stat) map.set(m.id, m);
  for (const m of live) {
    const s = map.get(m.id);
    map.set(m.id, s ? { ...s, ...m, displayName: s.displayName || m.displayName, pricing: m.pricing ?? s.pricing, contextWindow: m.contextWindow ?? s.contextWindow, supportedEfforts: m.supportedEfforts ?? s.supportedEfforts } : m);
  }
  // Static defaults first (they carry pricing), then everything else alphabetically.
  const ids = new Set(stat.map((s) => s.id));
  return [...stat.filter((s) => map.has(s.id)).map((s) => map.get(s.id)!), ...[...map.values()].filter((m) => !ids.has(m.id))];
}

export async function testProvider(provider: ProviderConfig, apiKey: string | undefined): Promise<{ ok: boolean; detail: string }> {
  try {
    const models = await fetchProviderModels(provider, apiKey);
    return { ok: true, detail: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.` };
  } catch (e) {
    return { ok: false, detail: errorMessage(e) };
  }
}
