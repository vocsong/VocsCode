import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { EffortLevel, ImageAttachment, ProviderConfig } from '../../../shared/types';
import type { NativeToolDef } from './tools';

/** Provider-neutral conversation history for the native harness. */
export type NativeMessage =
  | { role: 'user'; text: string; images?: ImageAttachment[] }
  | {
      role: 'assistant';
      text: string;
      reasoning?: string;
      toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
      /** Raw Anthropic content blocks (thinking blocks carry signatures the API requires on tool-use continuations). */
      anthropicContent?: unknown[];
      /** Model that produced anthropicContent; blocks are only replayed to the same model. */
      anthropicModel?: string;
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface StepResult {
  text: string;
  reasoning: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  usage: StepUsage;
  stopReason: string;
  /** Provider-native assistant content to replay verbatim (Anthropic thinking signatures). */
  rawContent?: unknown[];
}

export interface StepParams {
  provider: ProviderConfig;
  apiKey: string | undefined;
  model: string;
  system: string;
  history: NativeMessage[];
  tools: NativeToolDef[];
  effort?: EffortLevel;
  signal: AbortSignal;
  onText: (delta: string) => void;
  onReasoning: (delta: string) => void;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw || '{}') as Record<string, unknown>;
    } catch {
      // Distinguishable marker so executeTool can fail the call instead of running it with empty args.
      return { __parseError: raw };
    }
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* Anthropic Messages API                                             */
/* ------------------------------------------------------------------ */

function supportsAdaptiveThinking(model: string): boolean {
  return /claude-(opus-4-[6-9]|opus-5|sonnet-4-6|sonnet-5|fable|mythos)/.test(model);
}

function toAnthropicMessages(history: NativeMessage[], model: string): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pendingResults: Anthropic.ToolResultBlockParam[] = [];
  const flushResults = () => {
    if (pendingResults.length) {
      out.push({ role: 'user', content: pendingResults });
      pendingResults = [];
    }
  };
  for (const m of history) {
    if (m.role === 'tool') {
      pendingResults.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '(no output)', is_error: m.isError || undefined });
      continue;
    }
    flushResults();
    if (m.role === 'user') {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const img of m.images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType as 'image/png', data: img.data } });
      content.push({ type: 'text', text: m.text || '(empty)' });
      out.push({ role: 'user', content });
    } else {
      let content: Anthropic.ContentBlockParam[];
      if (m.anthropicContent?.length) {
        // Replay the provider's own blocks so thinking signatures stay valid; drop thinking
        // blocks when the model changed (signatures are model-specific).
        const sameModel = !m.anthropicModel || m.anthropicModel === model;
        content = (m.anthropicContent as Anthropic.ContentBlockParam[]).filter((b) => sameModel || (b.type !== 'thinking' && b.type !== 'redacted_thinking'));
      } else {
        content = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const tc of m.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      if (!content.length) content.push({ type: 'text', text: '(empty)' });
      out.push({ role: 'assistant', content });
    }
  }
  flushResults();
  return out;
}

export async function anthropicStep(p: StepParams): Promise<StepResult> {
  const client = new Anthropic({ apiKey: p.apiKey, baseURL: p.provider.baseUrl, maxRetries: 2, defaultHeaders: p.provider.headers });
  const tools: Anthropic.Tool[] = p.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema }));
  const adaptive = supportsAdaptiveThinking(p.model);
  const body: Anthropic.MessageCreateParamsStreaming = {
    model: p.model,
    max_tokens: adaptive ? 32_000 : 8192,
    system: [{ type: 'text', text: p.system, cache_control: { type: 'ephemeral' } }],
    messages: toAnthropicMessages(p.history, p.model),
    tools,
    stream: true
  };
  if (adaptive) {
    (body as unknown as Record<string, unknown>).thinking = { type: 'adaptive', display: 'summarized' };
    if (p.effort && p.effort !== 'minimal') (body as unknown as Record<string, unknown>).output_config = { effort: p.effort };
  }
  const stream = client.messages.stream(body, { signal: p.signal });
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta') {
      if (ev.delta.type === 'text_delta') p.onText(ev.delta.text);
      else if (ev.delta.type === 'thinking_delta') p.onReasoning(ev.delta.thinking);
    }
  }
  const msg = await stream.finalMessage();
  const result: StepResult = {
    text: '',
    reasoning: '',
    toolCalls: [],
    usage: {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      reasoningTokens: 0
    },
    stopReason: msg.stop_reason ?? 'end_turn',
    rawContent: msg.content as unknown[]
  };
  for (const block of msg.content) {
    if (block.type === 'text') result.text += block.text;
    else if (block.type === 'thinking') result.reasoning += block.thinking;
    else if (block.type === 'tool_use') result.toolCalls.push({ id: block.id, name: block.name, args: parseArgs(block.input) });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible Chat Completions                                 */
/* ------------------------------------------------------------------ */

function toOpenAIMessages(history: NativeMessage[], includeReasoning: boolean): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (const m of history) {
    if (m.role === 'user') {
      if (m.images?.length) {
        const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
        for (const img of m.images) parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
        parts.push({ type: 'text', text: m.text || '(see image)' });
        out.push({ role: 'user', content: parts });
      } else out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam & { reasoning_content?: string } = { role: 'assistant', content: m.text || null };
      if (m.toolCalls.length) msg.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }));
      if (includeReasoning && m.reasoning) msg.reasoning_content = m.reasoning;
      out.push(msg);
    } else out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content || '(no output)' });
  }
  return out;
}

export async function openaiStep(p: StepParams): Promise<StepResult> {
  const client = new OpenAI({ apiKey: p.apiKey || 'not-needed', baseURL: p.provider.baseUrl, maxRetries: 2, defaultHeaders: p.provider.headers });
  const isDeepSeek = p.provider.kind === 'deepseek' || /deepseek/i.test(p.model);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: p.system }, ...toOpenAIMessages(p.history, isDeepSeek)];
  const tools: OpenAI.Chat.ChatCompletionTool[] = p.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const body: OpenAI.Chat.ChatCompletionCreateParamsStreaming & Record<string, unknown> = {
    model: p.model,
    messages,
    tools,
    stream: true,
    stream_options: { include_usage: true }
  };
  // Only reasoning models accept reasoning_effort; gpt-4.x and most third-party models reject it.
  const reasoningCapable = /^(o\d|gpt-5)/.test(p.model);
  if (p.effort && reasoningCapable) body.reasoning_effort = p.effort === 'xhigh' || p.effort === 'max' ? 'high' : p.effort;
  if (isDeepSeek && p.effort) body.reasoning_effort = p.effort === 'xhigh' || p.effort === 'max' ? 'high' : p.effort === 'minimal' ? 'low' : p.effort;
  if (p.provider.kind === 'openrouter') body.usage = { include: true };

  const stream = await client.chat.completions.create(body, { signal: p.signal });
  const result: StepResult = { text: '', reasoning: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, stopReason: 'stop' };
  const partialCalls = new Map<number, { id: string; name: string; args: string }>();
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta as OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string; reasoning?: string };
      if (delta.content) {
        result.text += delta.content;
        p.onText(delta.content);
      }
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) {
        result.reasoning += reasoning;
        p.onReasoning(reasoning);
      }
      for (const tc of delta.tool_calls ?? []) {
        const cur = partialCalls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        partialCalls.set(tc.index, cur);
      }
      if (choice.finish_reason) result.stopReason = choice.finish_reason;
    }
    const usage = (chunk as { usage?: OpenAI.CompletionUsage & { prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number }; prompt_cache_hit_tokens?: number } }).usage;
    if (usage) {
      // OpenAI-style prompt_tokens already include cached tokens; report the uncached remainder as input
      // so cost estimation does not bill cached tokens twice.
      const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
      result.usage.inputTokens = Math.max(0, (usage.prompt_tokens ?? 0) - cached);
      result.usage.outputTokens = usage.completion_tokens ?? 0;
      result.usage.cacheReadTokens = cached;
      result.usage.reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
    }
  }
  for (const [i, c] of [...partialCalls.entries()].sort((a, b) => a[0] - b[0])) {
    result.toolCalls.push({ id: c.id || `call_${i}_${Date.now()}`, name: c.name, args: parseArgs(c.args) });
  }
  return result;
}

export function isAnthropicProvider(p: ProviderConfig): boolean {
  return p.kind === 'anthropic';
}
