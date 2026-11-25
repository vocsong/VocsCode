/** Codex app-server protocol item normalization, streaming delta buffers, and child subagent thread tracking. */
import type { FileChange, OngoingItem, SessionEvent, TranscriptItem } from '../../shared/types';
import { truncate } from '../util/async';

export type FileChangeThreadItem = {
  type: 'fileChange';
  id: string;
  changes: { path: string; kind: { type: 'add' | 'delete' | 'update'; move_path?: string | null }; diff: string }[];
  status: 'inProgress' | 'completed' | 'failed' | 'declined';
};

export type ThreadItem =
  | { type: 'userMessage'; id: string }
  | { type: 'agentMessage'; id: string; text: string; phase: string | null }
  | { type: 'plan'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      status: 'inProgress' | 'completed' | 'failed' | 'declined';
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | FileChangeThreadItem
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: string; arguments: unknown; result: { content: unknown[]; structuredContent: unknown } | null; error: { message: string } | null; durationMs: number | null }
  | { type: 'dynamicToolCall'; id: string; tool: string; arguments: unknown; status: string; contentItems: unknown[] | null; success: boolean | null }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: 'contextCompaction'; id: string }
  | { type: 'subAgentActivity'; id: string; [k: string]: unknown }
  | { type: 'collabAgentToolCall'; id: string; tool: string; [k: string]: unknown }
  | { type: string; id: string; [k: string]: unknown };

export function mapCodexFileChanges(item: FileChangeThreadItem): FileChange[] {
  return item.changes.map((c) => ({
    path: c.path,
    kind: c.kind.type === 'update' && c.kind.move_path ? 'rename' : c.kind.type,
    diff: c.diff,
    oldPath: c.kind.type === 'update' ? c.kind.move_path ?? undefined : undefined
  }));
}

/** Tracks live child subagent threads observed on the shared Codex app-server connection. */
export class CodexChildThreadTracker {
  private childThreads = new Map<string, { threadId: string; label: string; startedAt: number }>();
  /** Most recent parent-thread subagent tool label, used to name child threads that carry no title. */
  private lastSubagentLabel: string | undefined;

  constructor(private readonly emit: (event: SessionEvent) => void) {}

  noteSubagentLabel(label: string): void {
    this.lastSubagentLabel = label;
  }

  onChildTurnStarted(threadId: string | undefined): void {
    if (!threadId || this.childThreads.has(threadId)) return;
    this.childThreads.set(threadId, {
      threadId,
      label: this.lastSubagentLabel || 'Codex subagent',
      startedAt: Date.now()
    });
    this.emitThreads();
  }

  onChildThreadEnded(threadId: string | undefined): void {
    if (threadId && this.childThreads.delete(threadId)) this.emitThreads();
  }

  clear(): void {
    if (!this.childThreads.size) return;
    this.childThreads.clear();
    this.lastSubagentLabel = undefined;
    this.emit({ type: 'ongoing', source: 'threads', items: [] });
  }

  private emitThreads(): void {
    const items: OngoingItem[] = [...this.childThreads.values()].map((t) => ({
      id: `thread:${t.threadId}`,
      kind: 'subagent',
      label: t.label,
      agent: 'Subagent',
      startedAt: t.startedAt,
      canStop: false
    }));
    this.emit({ type: 'ongoing', source: 'threads', items });
  }
}

/** Owns live Codex transcript items, applying streaming deltas and emitting shallow snapshots. */
export class CodexItemTracker {
  private items = new Map<string, TranscriptItem>();

  constructor(
    private readonly deps: {
      emit: (event: SessionEvent) => void;
      activeModel: () => string | undefined;
      onFileChanges: (item: FileChangeThreadItem) => FileChange[];
      onSubagentLabel: (label: string) => void;
    }
  ) {}

  /**
   * Keep the adapter's live item locally and emit a snapshot of it. The session manager owns the
   * emitted item and mutates it as deltas stream, so handing it this map's object would apply
   * every delta (reasoning text, command output) twice.
   */
  private upsert(item: TranscriptItem): void {
    this.items.set(item.id, item);
    this.deps.emit({ type: 'item.upsert', item: { ...item } });
  }

  upsertItem(item: ThreadItem, completed: boolean): void {
    const existing = this.items.get(item.id);
    const ts = existing?.ts ?? Date.now();
    let out: TranscriptItem | null = null;
    switch (item.type) {
      case 'userMessage':
      case 'hookPrompt':
      case 'sleep':
        return;
      case 'agentMessage': {
        const it = item as Extract<ThreadItem, { type: 'agentMessage' }>;
        const prev = existing && existing.kind === 'assistant' ? existing : undefined;
        const text = completed || !prev ? it.text : prev.text.length > it.text.length ? prev.text : it.text;
        out = { id: it.id, kind: 'assistant', ts, text, streaming: !completed, model: this.deps.activeModel(), phase: it.phase === 'commentary' ? 'commentary' : 'final', thinking: prev?.thinking };
        break;
      }
      case 'plan': {
        const it = item as Extract<ThreadItem, { type: 'plan' }>;
        out = { id: it.id, kind: 'assistant', ts, text: it.text, streaming: !completed, phase: 'plan' };
        break;
      }
      case 'reasoning': {
        const it = item as Extract<ThreadItem, { type: 'reasoning' }>;
        const prev = existing && existing.kind === 'assistant' ? existing.thinking ?? '' : '';
        const full = [...(it.summary ?? []), ...(it.content ?? [])].join('\n\n');
        out = { id: it.id, kind: 'assistant', ts, text: '', thinking: full.length >= prev.length ? full : prev, streaming: !completed, phase: 'commentary' };
        break;
      }
      case 'commandExecution': {
        const it = item as Extract<ThreadItem, { type: 'commandExecution' }>;
        const prevOut = existing && existing.kind === 'tool' ? existing.output ?? '' : '';
        out = {
          id: it.id,
          kind: 'tool',
          ts,
          name: 'shell',
          hint: 'execute',
          summary: it.command,
          input: { command: it.command, cwd: it.cwd },
          output: truncate((it.aggregatedOutput ?? '').length >= prevOut.length ? it.aggregatedOutput ?? '' : prevOut, 40_000),
          status: it.status === 'inProgress' ? 'running' : it.status === 'failed' ? 'error' : it.status === 'declined' ? 'declined' : 'done',
          exitCode: it.exitCode,
          durationMs: it.durationMs ?? undefined
        };
        break;
      }
      case 'fileChange': {
        const it = item as FileChangeThreadItem;
        const changes = this.deps.onFileChanges(it);
        out = {
          id: it.id,
          kind: 'tool',
          ts,
          name: 'apply_patch',
          hint: 'edit',
          summary: changes.map((c) => c.path).join(', '),
          changes,
          status: it.status === 'inProgress' ? 'running' : it.status === 'failed' ? 'error' : it.status === 'declined' ? 'declined' : 'done'
        };
        break;
      }
      case 'mcpToolCall': {
        const it = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
        out = {
          id: it.id,
          kind: 'tool',
          ts,
          name: `${it.server}.${it.tool}`,
          hint: 'mcp',
          input: it.arguments,
          summary: truncate(JSON.stringify(it.arguments ?? {}), 200, '…'),
          output: it.error ? it.error.message : it.result ? truncate(JSON.stringify(it.result.structuredContent ?? it.result.content ?? '', null, 2), 40_000) : undefined,
          status: it.status === 'inProgress' ? 'running' : it.status === 'failed' ? 'error' : 'done',
          durationMs: it.durationMs ?? undefined
        };
        break;
      }
      case 'dynamicToolCall': {
        const it = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
        out = {
          id: it.id,
          kind: 'tool',
          ts,
          name: it.tool,
          hint: 'other',
          input: it.arguments,
          summary: truncate(JSON.stringify(it.arguments ?? {}), 200, '…'),
          output: it.contentItems ? truncate(JSON.stringify(it.contentItems, null, 2), 40_000) : undefined,
          status: it.status === 'inProgress' ? 'running' : it.success === false ? 'error' : 'done'
        };
        break;
      }
      case 'webSearch': {
        const it = item as Extract<ThreadItem, { type: 'webSearch' }>;
        out = { id: it.id, kind: 'tool', ts, name: 'web_search', hint: 'fetch', summary: it.query ?? '', status: completed ? 'done' : 'running' };
        break;
      }
      case 'contextCompaction':
        out = { id: item.id, kind: 'info', ts, level: 'info', text: 'Codex compacted the conversation context.' };
        break;
      case 'subAgentActivity':
      case 'collabAgentToolCall': {
        const it = item as { id: string; tool?: string; prompt?: string; description?: string; [k: string]: unknown };
        const label = typeof it.description === 'string' && it.description.trim()
          ? it.description.trim()
          : typeof it.prompt === 'string' && it.prompt.trim()
            ? truncate(it.prompt.trim(), 80, '…')
            : typeof it.tool === 'string'
              ? `agent.${it.tool}`
              : 'Codex subagent';
        if (!completed) this.deps.onSubagentLabel(label);
        out = { id: it.id, kind: 'tool', ts, name: typeof it.tool === 'string' ? `agent.${it.tool}` : 'subagent', hint: 'agent', input: it, summary: label, status: completed ? 'done' : 'running' };
        break;
      }
      case 'enteredReviewMode':
        out = { id: item.id, kind: 'info', ts, level: 'info', text: 'Codex entered review mode.' };
        break;
      case 'exitedReviewMode':
        out = { id: item.id, kind: 'info', ts, level: 'info', text: 'Codex exited review mode.' };
        break;
      case 'imageGeneration':
      case 'imageView':
        out = { id: item.id, kind: 'info', ts, level: 'info', text: `${item.type} item (not rendered).` };
        break;
      default:
        out = { id: item.id, kind: 'info', ts, level: 'info', text: `${item.type}: ${truncate(JSON.stringify(item), 500, '…')}` };
    }
    if (out) this.upsert(out);
  }

  applyTextDelta(itemId: string, delta: string): void {
    const item = this.items.get(itemId);
    if (item && item.kind === 'assistant') {
      item.text += delta;
      this.deps.emit({ type: 'item.delta', id: itemId, textDelta: delta });
    }
  }

  applyReasoningDelta(itemId: string, delta: string): void {
    let item = this.items.get(itemId);
    if (!item) {
      item = { id: itemId, kind: 'assistant', ts: Date.now(), text: '', thinking: '', streaming: true, phase: 'commentary' };
      this.upsert(item);
    }
    if (item.kind === 'assistant') {
      item.thinking = (item.thinking ?? '') + delta;
      this.deps.emit({ type: 'item.delta', id: itemId, thinkingDelta: delta });
    }
  }

  applyReasoningSummaryPartAdded(itemId: string): void {
    const item = this.items.get(itemId);
    if (item && item.kind === 'assistant' && item.thinking) {
      item.thinking += '\n\n';
      this.deps.emit({ type: 'item.delta', id: itemId, thinkingDelta: '\n\n' });
    }
  }

  applyToolOutputDelta(itemId: string, delta: string): void {
    const item = this.items.get(itemId);
    if (item && item.kind === 'tool') {
      item.output = (item.output ?? '') + delta;
      this.deps.emit({ type: 'item.delta', id: itemId, outputDelta: delta });
    }
  }

  finishStreaming(): void {
    for (const item of this.items.values()) {
      if (item.kind === 'assistant' && item.streaming) this.deps.emit({ type: 'item.upsert', item: { ...item, streaming: false } });
    }
  }
}
