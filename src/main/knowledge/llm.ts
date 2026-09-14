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

/** Reasoning models (o-series, gpt-5) reject `max_tokens` and need room to think first. */
function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model);
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
      deps.log('debug', `knowledge: asking ${provider.id}/${model}`);
      const apiKey = await resolveProviderApiKey(provider, deps.getSecret);
      const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
      const timeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      try {
        if (isAnthropicProvider(provider)) {
          const client = new Anthropic({ apiKey, baseURL: provider.baseUrl, maxRetries: 1, defaultHeaders: provider.headers });
          const msg = await client.messages.create(
            { model, max_tokens: maxTokens, system: req.system, messages: [{ role: 'user', content: req.prompt }] },
            { signal: AbortSignal.timeout(timeout) }
          );
          return msg.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join('');
        }
        const client = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: provider.baseUrl, maxRetries: 1, defaultHeaders: provider.headers });
        const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = isReasoningModel(model)
          ? { model, max_completion_tokens: maxTokens, reasoning_effort: 'low', messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }] }
          : { model, max_tokens: maxTokens, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }] };
        const res = await client.chat.completions.create(body, { signal: AbortSignal.timeout(timeout) });
        return res.choices[0]?.message?.content ?? '';
      } catch (e) {
        deps.log('warn', `knowledge: background completion failed: ${errorMessage(e)}`);
        return null;
      }
    }
  };
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
