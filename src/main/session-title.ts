import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ProviderConfig } from '../shared/types';
import { STATIC_MODELS_BY_PROVIDER } from './models/static-models';
import { resolveProviderApiKey } from './models/providers';
import { isAnthropicProvider } from './harness/native/drivers';

/** Placeholder title from the first prompt line: at most 6 words and 60 chars so sidebar rows stay short. */
export function titleFromPrompt(text: string): string {
  const line = text.trim().split('\n')[0].trim();
  const words = line.split(/\s+/);
  return words.slice(0, 6).join(' ').slice(0, 60) || line.slice(0, 60);
}

/** Strips quoting/preamble from a raw model reply and clamps it to the same 6-word cap. */
export function sanitizeLlmTitle(raw: string): string | null {
  const line = raw
    .trim()
    .split('\n')[0]
    .replace(/^[\s"'`#]+|[\s"'`]+$/g, '')
    .replace(/\.+$/, '')
    .trim();
  if (!line) return null;
  return titleFromPrompt(line) || null;
}

const TITLE_SYSTEM = [
  'You name coding sessions for a sidebar.',
  'Reply with a title of at most 6 words describing the task in the user message.',
  'Plain text only: no quotes, no punctuation at the end, no explanation.'
].join(' ');

/** How long we wait for the title model before falling back to the truncated prompt. */
const TITLE_TIMEOUT_MS = 15_000;

/** How much of the opening prompt we show the title model. */
const PROMPT_SAMPLE_CHARS = 800;

/**
 * One-shot LLM call that names a session from its opening prompt. Never throws:
 * returns null when no provider is usable or the call fails, leaving the
 * truncated-prompt placeholder in place.
 */
export async function generateSessionTitle(
  prompt: string,
  providers: ProviderConfig[],
  getSecret: (providerId: string) => Promise<string | undefined>
): Promise<string | null> {
  const usable = providers.filter((p) => p.enabled && (p.hasApiKey || (p.envKey && process.env[p.envKey]) || p.kind === 'ollama' || p.kind === 'lmstudio'));
  const provider = usable.find((p) => modelFor(p));
  if (!provider) return null;
  const model = modelFor(provider)!;
  const apiKey = await resolveProviderApiKey(provider, getSecret);
  const sample = prompt.trim().slice(0, PROMPT_SAMPLE_CHARS);
  try {
    if (isAnthropicProvider(provider)) {
      const client = new Anthropic({ apiKey, baseURL: provider.baseUrl, maxRetries: 1, defaultHeaders: provider.headers });
      const msg = await client.messages.create(
        { model, max_tokens: 32, system: TITLE_SYSTEM, messages: [{ role: 'user', content: sample }] },
        { signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) }
      );
      return sanitizeLlmTitle(msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' '));
    }
    const client = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: provider.baseUrl, maxRetries: 1, defaultHeaders: provider.headers });
    const res = await client.chat.completions.create(
      { model, max_tokens: 32, messages: [{ role: 'system', content: TITLE_SYSTEM }, { role: 'user', content: sample }] },
      { signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) }
    );
    return sanitizeLlmTitle(res.choices[0]?.message?.content ?? '');
  } catch {
    return null;
  }
}

function modelFor(p: ProviderConfig): string | null {
  const models = p.models.length ? p.models : STATIC_MODELS_BY_PROVIDER[p.id] ?? [];
  return (models.find((m) => m.isDefault) ?? models[0])?.id ?? null;
}