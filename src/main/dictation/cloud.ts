/**
 * Cloud transcription: OpenRouter's JSON endpoint, or the OpenAI multipart upload that OpenAI, Groq
 * and any OpenAI-compatible speech server (a local one included) accept. The key is sent only to
 * the provider's own base URL and never appears in an error. No Electron imports.
 */
import type { ProviderConfig } from '../../shared/types';
import { cloudSttFor } from '../../shared/dictation';

/** A dictation clip is seconds long; a provider that has not answered in a minute is not going to. */
const CLOUD_TIMEOUT_MS = 60_000;

export interface CloudTranscribeRequest {
  provider: ProviderConfig;
  apiKey?: string;
  model: string;
  wav: Buffer;
  language?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function baseUrlOf(provider: ProviderConfig): string {
  const base = (provider.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error(`${provider.name} has no base URL. Set one under Settings → Providers & keys.`);
  return base;
}

function headersFor(provider: ProviderConfig, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { ...(provider.headers ?? {}) };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

/** The provider's own error text when it sends one (`{ error: { message } }` or `{ error }`), else the status. */
async function failure(res: Response, name: string): Promise<Error> {
  let detail = '';
  try {
    const body = (await res.text()).slice(0, 2000);
    try {
      const json = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
      const message = typeof json.error === 'string' ? json.error : typeof json.error?.message === 'string' ? json.error.message : typeof json.message === 'string' ? json.message : '';
      detail = message || body;
    } catch {
      detail = body;
    }
  } catch {
    /* no body */
  }
  const hint = res.status === 401 || res.status === 403 ? ' Check the API key under Settings → Providers & keys.' : '';
  return new Error(`${name} transcription failed (${res.status})${detail ? `: ${detail.trim().slice(0, 300)}` : ''}.${hint}`);
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(CLOUD_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function transcribeCloud(req: CloudTranscribeRequest): Promise<string> {
  const { provider } = req;
  const kind = cloudSttFor(provider.kind);
  if (!kind) throw new Error(`${provider.name} has no transcription endpoint. Pick OpenRouter, OpenAI, Groq or an OpenAI-compatible provider under Settings → Voice.`);
  if (!req.model) throw new Error(`Choose a transcription model for ${provider.name} under Settings → Voice.`);
  const url = `${baseUrlOf(provider)}/audio/transcriptions`;
  const headers = headersFor(provider, req.apiKey);
  const fetchImpl = req.fetchImpl ?? fetch;
  let res: Response;
  try {
    if (kind.protocol === 'openrouter') {
      headers['content-type'] = 'application/json';
      const body = JSON.stringify({ model: req.model, input_audio: { data: req.wav.toString('base64'), format: 'wav' }, ...(req.language ? { language: req.language } : {}) });
      res = await fetchImpl(url, { method: 'POST', headers, body, signal: withTimeout(req.signal) });
    } else {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(req.wav)], { type: 'audio/wav' }), 'dictation.wav');
      form.append('model', req.model);
      form.append('response_format', 'json');
      if (req.language) form.append('language', req.language);
      res = await fetchImpl(url, { method: 'POST', headers, body: form, signal: withTimeout(req.signal) });
    }
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'TimeoutError') throw new Error(`${provider.name} did not answer within ${CLOUD_TIMEOUT_MS / 1000} s.`);
    if (name === 'AbortError') throw new Error('Transcription cancelled.');
    throw new Error(`Could not reach ${provider.name}: ${(e as Error)?.message ?? String(e)}`);
  }
  if (!res.ok) throw await failure(res, provider.name);
  const json = (await res.json().catch(() => null)) as { text?: unknown } | null;
  if (!json || typeof json.text !== 'string') throw new Error(`${provider.name} answered without a transcript.`);
  return json.text;
}

/** The provider's transcription models: OpenRouter's live catalog, else the built-in suggestions. */
export async function listCloudModels(provider: ProviderConfig, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<{ id: string; label: string }[]> {
  const kind = cloudSttFor(provider.kind);
  if (!kind) return [];
  if (kind.protocol !== 'openrouter') return [...kind.models];
  const res = await fetchImpl(`${baseUrlOf(provider)}/models?output_modalities=transcription`, { headers: headersFor(provider, apiKey), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw await failure(res, provider.name);
  const json = (await res.json()) as { data?: { id?: unknown; name?: unknown }[] };
  const live = (json.data ?? [])
    .filter((m): m is { id: string; name?: unknown } => typeof m.id === 'string' && !!m.id)
    .map((m) => ({ id: m.id, label: typeof m.name === 'string' && m.name ? m.name : m.id }));
  return live.length ? live : [...kind.models];
}
