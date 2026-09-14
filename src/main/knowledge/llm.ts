/**
 * Background completions for knowledge jobs: the same provider plumbing session titles use, with a
 * bigger budget and JSON-shaped replies. Never throws — a failed call returns null and the job
 * reports it, because a wiki that fails to generate must not break a session or a git action.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AppSettings } from '../../shared/types';
import { selectBackgroundModel } from '../agents/model';
import { resolveProviderApiKey } from '../models/providers';
import { isAnthropicProvider } from '../harness/native/drivers';
import { errorMessage } from '../util/async';

export interface KnowledgeCompletionRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface KnowledgeCompleter {
  /** Null when no provider is usable or the call failed. */
  complete(req: KnowledgeCompletionRequest): Promise<string | null>;
  /** `provider/model`, for logs and the job status line. */
  label(): string | null;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 8000;
/** A thinking model can burn an entire budget before emitting content; one retry at this budget. */
const RETRY_MAX_TOKENS = 32_000;

/** Reasoning models (o-series, gpt-5) reject `max_tokens` and need room to think first. */
function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model);
}

/** The OpenAI wire puts a thinking model's chain of thought beside the answer. */
interface OpenAiMessage {
  content?: string | null;
  reasoning_content?: string | null;
}

export function createKnowledgeCompleter(deps: {
  settings: () => AppSettings;
  getSecret: (providerId: string) => Promise<string | undefined>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}): KnowledgeCompleter {
  const picked = () => selectBackgroundModel(deps.settings().providers, deps.settings().utilityModel);
  return {
    label(): string | null {
      const choice = picked();
      return choice ? `${choice.provider.id}/${choice.model}` : null;
    },
    async complete(req: KnowledgeCompletionRequest): Promise<string | null> {
      const choice = picked();
      if (!choice) {
        deps.log('debug', 'knowledge: no usable provider for a background completion');
        return null;
      }
      const { provider, model } = choice;
      const apiKey = await resolveProviderApiKey(provider, deps.getSecret);
      const timeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let budget = req.maxTokens ?? DEFAULT_MAX_TOKENS;
      // A thinking model may spend the entire budget before writing any content. Retrying once with
      // a bigger budget and an explicit "answer only" instruction is cheaper than explaining to a
      // user why nothing appeared.
      let system = req.system;
      for (let attempt = 1; attempt <= 2; attempt++) {
        deps.log('debug', `knowledge: asking ${provider.id}/${model} (attempt ${attempt}, max ${budget})`);
        const outcome = await attemptOnce({ provider, model, apiKey, system, prompt: req.prompt, budget, timeout });
        if (outcome.text && outcome.text.trim()) return outcome.text;
        deps.log(
          'warn',
          `knowledge: ${provider.id}/${model} returned no text (attempt ${attempt}, finish_reason=${outcome.finishReason ?? 'unknown'}, ${outcome.note ?? 'empty content'})`
        );
        if (attempt === 1 && budget < RETRY_MAX_TOKENS) {
          budget = Math.max(budget * 2, 16_000);
          system = `${req.system}\n\nReply with the JSON object only. Do not include analysis or explanation.`;
          continue;
        }
        if (outcome.error) deps.log('warn', `knowledge: background completion failed: ${outcome.error}`);
        return null;
      }
      return null;
    }
  };
}

interface AttemptResult {
  text: string | null;
  finishReason?: string;
  /** Why the attempt came back empty, e.g. `content empty, 9,812 chars of reasoning`. */
  note?: string;
  error?: string;
}

/** One provider call; never throws, so the retry loop can be a plain for-loop. */
async function attemptOnce(opts: {
  provider: AppSettings['providers'][number];
  model: string;
  apiKey: string | undefined;
  system: string;
  prompt: string;
  budget: number;
  timeout: number;
}): Promise<AttemptResult> {
  const { provider, model, apiKey, system, prompt, budget, timeout } = opts;
  try {
    if (isAnthropicProvider(provider)) {
      const client = new Anthropic({ apiKey, baseURL: provider.baseUrl, maxRetries: 1, defaultHeaders: provider.headers });
      const msg = await client.messages.create(
        { model, max_tokens: budget, system, messages: [{ role: 'user', content: prompt }] },
        { signal: AbortSignal.timeout(timeout) }
      );
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      const thinking = msg.content.filter((b) => b.type !== 'text').length;
      return { text, finishReason: msg.stop_reason ?? undefined, ...(text.trim() ? {} : { note: thinking ? `${thinking} non-text block(s) only` : 'empty content' }) };
    }
    const client = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: provider.baseUrl, maxRetries: 1, defaultHeaders: provider.headers });
    const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = isReasoningModel(model)
      ? { model, max_completion_tokens: budget, reasoning_effort: 'low', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }
      : { model, max_tokens: budget, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
    const res = await client.chat.completions.create(body, { signal: AbortSignal.timeout(timeout) });
    const choice = res.choices[0];
    const message = (choice?.message ?? {}) as OpenAiMessage;
    const text = message.content ?? '';
    const reasoning = message.reasoning_content ?? '';
    return {
      text,
      finishReason: choice?.finish_reason ?? undefined,
      ...(text.trim() ? {} : { note: reasoning ? `${reasoning.length} chars of reasoning, no content` : 'empty content' })
    };
  } catch (e) {
    return { text: null, error: errorMessage(e) };
  }
}

/** Pulls the first JSON object out of a reply, tolerating ```json fences and surrounding prose. */
export function parseJsonReply<T = unknown>(text: string | null): T | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fence ? fence[1] : text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * Recovers the complete entries of an array from a truncated reply. A model asked for a page list
 * regularly runs out of budget mid-array; the whole reply then fails to parse and every page it
 * had already written is lost. Dropping the incomplete tail keeps them.
 */
export function salvageArrayEntries<T = unknown>(text: string | null, key: string): T[] {
  if (!text) return [];
  const source = text.replace(/```[a-z]*/gi, '');
  const keyAt = source.search(new RegExp(`"${key}"\\s*:\\s*\\[`));
  if (keyAt < 0) return [];
  const start = source.indexOf('[', keyAt);
  const out: T[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try {
          out.push(JSON.parse(source.slice(objectStart, i + 1)) as T);
        } catch {
          /* an entry that is itself malformed is skipped, not fatal */
        }
        objectStart = -1;
      }
      continue;
    }
    if (ch === ']' && depth === 0) break;
  }
  return out;
}
