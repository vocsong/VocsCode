/** Pure ACP event/item translation helpers: commands, tool hints/diffs, prompt blocks, and stop-reason mapping. */
import type { HarnessCommand } from '../../shared/harness-commands';
import type { FileChange, TranscriptItem, UserInput } from '../../shared/types';
import { truncate } from '../util/async';
import { makeFileChange } from '../util/file-changes';
import type { TurnUsage } from '../util/turn-usage';

/** An ACP `available_commands_update` list as harness commands. v1 sends `input: { hint }`; the v2 draft adds a `type`. */
export function acpHarnessCommands(raw: unknown): HarnessCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c): HarnessCommand[] => {
    if (!c || typeof c !== 'object' || typeof (c as { name?: unknown }).name !== 'string') return [];
    const { name, description, input } = c as { name: string; description?: unknown; input?: { hint?: unknown } | null };
    return [{ name, description: typeof description === 'string' ? description : undefined, argumentHint: typeof input?.hint === 'string' ? input.hint : undefined, kind: 'command' }];
  });
}

export function acpToolHint(kind: string | null | undefined): Extract<TranscriptItem, { kind: 'tool' }>['hint'] {
  switch (kind) {
    case 'read':
      return 'read';
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    case 'execute':
      return 'execute';
    case 'search':
      return 'search';
    case 'fetch':
      return 'fetch';
    case 'think':
      return 'think';
    default:
      return 'other';
  }
}

export function acpChangesFromContent(cwd: string, content: unknown[] | undefined): FileChange[] | undefined {
  if (!content) return undefined;
  const out: FileChange[] = [];
  for (const c of content as { type: string; path?: string; oldText?: string | null; newText?: string }[]) {
    if (c.type === 'diff' && c.path) {
      out.push(makeFileChange(cwd, c.path, c.oldText || null, c.newText ?? '', { addWhenEmpty: true }));
    }
  }
  return out.length ? out : undefined;
}

export interface AcpToolCallUpdate {
  toolCallId: string;
  name?: string | null;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  content?: unknown[] | null;
  locations?: { path: string }[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: Record<string, unknown> | null;
}

export function applyAcpToolUpdate(
  cwd: string,
  item: Extract<TranscriptItem, { kind: 'tool' }>,
  t: AcpToolCallUpdate
): void {
  if (t.title) item.title = t.title;
  if (t.kind) {
    item.name = t.kind;
    item.hint = acpToolHint(t.kind);
  }
  if (t.rawInput !== undefined) {
    item.input = t.rawInput;
    const raw = t.rawInput as Record<string, unknown>;
    if (typeof raw?.command === 'string') item.summary = raw.command;
  }
  if (t.status) item.status = t.status === 'completed' ? 'done' : t.status === 'failed' || t.status === 'cancelled' ? 'error' : 'running';
  const changes = acpChangesFromContent(cwd, t.content ?? undefined);
  if (changes) item.changes = changes;
  const textOut = (t.content ?? [])
    .map((c) => {
      const cc = c as { type: string; content?: { type: string; text?: string } };
      return cc.type === 'content' && cc.content?.type === 'text' ? cc.content.text ?? '' : '';
    })
    .filter(Boolean)
    .join('\n');
  if (textOut) item.output = truncate(textOut, 40_000);
  else if (t.rawOutput !== undefined && item.status !== 'running' && !item.output) {
    item.output = truncate(typeof t.rawOutput === 'string' ? t.rawOutput : JSON.stringify(t.rawOutput, null, 2), 40_000);
  }
  if (!item.changes && t.locations?.length && item.hint === 'edit') {
    item.changes = t.locations.map((l) => ({ path: l.path, kind: 'update' as const }));
  }
}

export function buildAcpPromptBlocks(
  input: UserInput,
  promptCaps: { image?: boolean },
  warn: (message: string) => void
): unknown[] {
  const blocks: unknown[] = [];
  if (input.text) blocks.push({ type: 'text', text: input.text });
  for (const img of input.images ?? []) {
    if (promptCaps.image) blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    else warn('This ACP agent does not accept images; the attachment was dropped.');
  }
  return blocks;
}

/**
 * Token usage from a `session/prompt` response (ACP's unstable `PromptResponse.usage`) in the app's
 * shape, or undefined when the agent reported none. The block covers this turn alone, summed over
 * every model request in it — Antigravity sends it here and nowhere else (its `usage_update` carries
 * only the context size). Input excludes cache reads and output already includes thought tokens,
 * which is what `UsageTotals` expects.
 */
export function acpTurnUsage(raw: unknown): TurnUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const usage: TurnUsage = {
    inputTokens: count(u.inputTokens),
    outputTokens: count(u.outputTokens),
    cacheReadTokens: count(u.cachedReadTokens),
    cacheWriteTokens: count(u.cachedWriteTokens),
    reasoningTokens: count(u.thoughtTokens)
  };
  return Object.values(usage).some((v) => v !== undefined) ? usage : undefined;
}

export function mapAcpStopReason(stop: string | undefined): {
  status: Extract<TranscriptItem, { kind: 'turn' }>['status'];
  error?: string;
} {
  return {
    status: stop === 'cancelled' ? 'interrupted' : stop === 'refusal' ? 'failed' : 'completed',
    error: stop === 'refusal' ? 'The agent refused the request.' : stop === 'max_tokens' || stop === 'max_turn_requests' ? `Stopped: ${stop}` : undefined
  };
}
