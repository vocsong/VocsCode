import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ModelRef, ProviderConfig } from '../shared/types';
import { selectBackgroundModel } from './agents/model';
import { STATIC_MODELS_BY_PROVIDER } from './models/static-models';
import { resolveProviderApiKey } from './models/providers';
import { isAnthropicProvider } from './harness/native/drivers';
import { errorMessage } from './util/async';
import { sanitizeBranchNameReply } from '../shared/branch-prefix';

/** Sidebar rows stay short: a title is cut to this many words, and never runs past 60 chars. */
const PLACEHOLDER_WORDS = 6;
/** A model asked for 6 words often writes 7 or 8. Cutting those mid-phrase is worse than keeping them. */
const LLM_TITLE_WORDS = 8;
const TITLE_CHARS = 60;

/**
 * Cuts a single line to `words` words and 60 chars, marking the cut with an ellipsis. The mark is
 * the point: an unmarked cut reads as a title someone wrote badly, rather than as the stand-in it is.
 */
function clampTitle(line: string, words: number): string {
  const parts = line.split(/\s+/).filter(Boolean);
  const kept = parts.slice(0, words).join(' ');
  if (parts.length <= words && kept.length <= TITLE_CHARS) return kept;
  // The ellipsis counts against the 60 chars, so the row cannot grow by marking the cut.
  return `${kept.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
}

/** Placeholder title from the first prompt line, shown until the title model names the session. */
export function titleFromPrompt(text: string): string {
  const line = text.trim().split('\n')[0].trim();
  return clampTitle(line, PLACEHOLDER_WORDS);
}

/** Chat-template control tokens (`<|im_start|>`, DeepSeek's `<｜DSML｜tool_calls>` with U+FF5C bars)
 *  leak into a reply as content when a provider fails to parse them out. They are never a title. */
const CONTROL_TOKEN_RE = /<\||\uFF5C/;

/**
 * Strips quoting/preamble from a raw model reply and clamps it to the sidebar's length. Rejects an
 * empty reply and leaked control-token markup, so a glitched reply leaves the placeholder in place.
 */
export function sanitizeLlmTitle(raw: string): string | null {
  const line = raw
    .trim()
    .split('\n')[0]
    .replace(/^(session|chat)?\s*(title|name)\s*:\s*/i, '')
    .replace(/^[\s"'`#*]+|[\s"'`*.,!]+$/g, '')
    .trim();
  if (!line || CONTROL_TOKEN_RE.test(line)) return null;
  return clampTitle(line, LLM_TITLE_WORDS) || null;
}

const TITLE_SYSTEM = [
  'You name coding sessions for a sidebar.',
  'Reply with a title of at most 6 words describing the task in the user message.',
  'Plain text only: no quotes, no punctuation at the end, no explanation.'
].join(' ');

/** How long we wait for the title model before falling back to the truncated prompt. */
const TITLE_TIMEOUT_MS = 30_000;

/** How much of the opening prompt we show the title model. */
const PROMPT_SAMPLE_CHARS = 800;

/**
 * Budget for a plain completion. A thinking model spends the same budget on its chain of thought
 * first, so 200 tokens left one writing `Investigate alerts and` before the cap stopped it: give
 * every reasoning-capable model room to think and still finish the title.
 */
const TITLE_MAX_TOKENS = 200;
const TITLE_MAX_COMPLETION_TOKENS = 1024;
const TITLE_REASONING_MAX_TOKENS = 2048;

/** Same family check the native driver uses: these reject max_tokens in favor of max_completion_tokens. */
function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model);
}

/**
 * Whether the model thinks before it answers. The o-series/gpt-5 names are the wire-level special
 * case; everything else is whatever the provider's own catalog says (DeepSeek's models all do).
 */
function thinksBeforeAnswering(provider: ProviderConfig, model: string): boolean {
  if (isReasoningModel(model)) return true;
  const catalog = provider.models.length ? provider.models : STATIC_MODELS_BY_PROVIDER[provider.id] ?? [];
  return !!catalog.find((m) => m.id === model)?.supportsReasoning;
}

/**
 * A reply cut off by the token budget is a fragment, not a title — the sidebar showed one for days.
 * Treat it as a failure so the placeholder stays and the next message can try again.
 */
function isTruncated(reason: string | null | undefined): boolean {
  return reason === 'length' || reason === 'max_tokens';
}

/**
 * One background-model completion of `system` over the opening prompt: the configured utility
 * model first (then the session's own provider when given), so chores use a cheap model when
 * possible. Never throws; returns null when no provider is usable, the call fails or times out,
 * or the reply was cut off by the token budget — a fragment is not an answer. The caller logs the
 * outcome once, with the reply's stop reason when the wire reports one.
 */
async function askBackgroundModel(
  label: string,
  system: string,
  prompt: string,
  providers: ProviderConfig[],
  getSecret: (providerId: string) => Promise<string | undefined>,
  preferred: ModelRef | undefined,
  log: ((level: 'debug' | 'info' | 'warn' | 'error', message: string) => void) | undefined,
  timeoutMs: number
): Promise<{ text: string; stopReason?: string } | null> {
  const picked = selectBackgroundModel(providers, preferred);
  if (!picked) {
    log?.('debug', `${label}: no usable provider, keeping placeholder`);
    return null;
  }
  const { provider, model } = picked;
  log?.('debug', `${label}: asking ${provider.id}/${model}`);
  const apiKey = await resolveProviderApiKey(provider, getSecret);
  const sample = prompt.trim().slice(0, PROMPT_SAMPLE_CHARS);
  try {
    const thinks = thinksBeforeAnswering(provider, model);
    if (isAnthropicProvider(provider)) {
      const client = new Anthropic({ apiKey, baseURL: provider.baseUrl, maxRetries: 1, defaultHeaders: provider.headers });
      const msg = await client.messages.create(
        { model, max_tokens: thinks ? TITLE_REASONING_MAX_TOKENS : TITLE_MAX_TOKENS, system, messages: [{ role: 'user', content: sample }] },
        { signal: AbortSignal.timeout(timeoutMs) }
      );
      if (isTruncated(msg.stop_reason)) {
        log?.('warn', `${label}: ${provider.id}/${model} ran out of tokens mid-reply, keeping placeholder`);
        return null;
      }
      return { text: msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' ') };
    }
    const client = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: provider.baseUrl, maxRetries: 1, defaultHeaders: provider.headers });
    // Reasoning models (o-series, gpt-5) reject max_tokens and spend the budget on thinking
    // before any text arrives, so they need max_completion_tokens and low effort. Other thinking
    // models (DeepSeek and friends) take max_tokens but need the same room.
    const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = isReasoningModel(model)
      ? { model, max_completion_tokens: TITLE_MAX_COMPLETION_TOKENS, reasoning_effort: 'low', messages: [{ role: 'system', content: system }, { role: 'user', content: sample }] }
      : { model, max_tokens: thinks ? TITLE_REASONING_MAX_TOKENS : TITLE_MAX_TOKENS, messages: [{ role: 'system', content: system }, { role: 'user', content: sample }] };
    const res = await client.chat.completions.create(body, { signal: AbortSignal.timeout(timeoutMs) });
    const choice = res.choices[0];
    if (isTruncated(choice?.finish_reason)) {
      log?.('warn', `${label}: ${provider.id}/${model} ran out of tokens mid-reply, keeping placeholder`);
      return null;
    }
    return { text: choice?.message?.content ?? '', stopReason: choice?.finish_reason ?? 'unknown' };
  } catch (e) {
    log?.('warn', `${label} failed, keeping placeholder: ${errorMessage(e)}`);
    return null;
  }
}

/**
 * One-shot LLM call that names a session from its opening prompt. Never throws:
 * returns null when no provider is usable or the call fails, leaving the
 * truncated-prompt placeholder in place.
 *
 * Prefers the configured utility model (or, failing that, the session's own
 * provider when given) so background chores use a cheap model when possible.
 */
export async function generateSessionTitle(
  prompt: string,
  providers: ProviderConfig[],
  getSecret: (providerId: string) => Promise<string | undefined>,
  preferred?: ModelRef,
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
): Promise<string | null> {
  const reply = await askBackgroundModel('session title', TITLE_SYSTEM, prompt, providers, getSecret, preferred, log, TITLE_TIMEOUT_MS);
  if (reply === null) return null;
  const title = sanitizeLlmTitle(reply.text);
  log?.('debug', `session title: ${title ? `got "${title}"` : `no usable reply${reply.stopReason ? ` (finish_reason ${reply.stopReason})` : ''}`}`);
  return title;
}

const BRANCH_SYSTEM = [
  'You name git branches for coding tasks.',
  'Reply with only the branch name: 2 to 5 lowercase English words joined by hyphens that capture the intent of the request in the user message, such as fix-login-redirect or add-dark-mode-toggle.',
  'No type prefix such as feat/ or fix/, no quotes, no explanation.'
].join(' ');

/**
 * The dialog waits on this while the user is still choosing, so it gives up much sooner than a
 * title, which arrives in the sidebar whenever it is ready.
 */
const BRANCH_TIMEOUT_MS = 10_000;

/**
 * A branch name for the intent of the opening prompt (`fix-login-redirect`), from the same
 * background model that titles sessions; the type prefix is the user's separate choice. Never
 * throws: null when no model is usable or its reply is not a name, so the caller keeps the
 * offline name (see branchNameFromText).
 */
export async function generateBranchName(
  prompt: string,
  providers: ProviderConfig[],
  getSecret: (providerId: string) => Promise<string | undefined>,
  preferred?: ModelRef,
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
): Promise<string | null> {
  const reply = await askBackgroundModel('branch name', BRANCH_SYSTEM, prompt, providers, getSecret, preferred, log, BRANCH_TIMEOUT_MS);
  if (reply === null) return null;
  const name = sanitizeBranchNameReply(reply.text);
  log?.('debug', `branch name: ${name ? `got "${name}"` : `no usable reply${reply.stopReason ? ` (finish_reason ${reply.stopReason})` : ''}`}`);
  return name;
}
