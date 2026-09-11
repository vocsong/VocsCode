/** Codex exec SDK adapter. It cannot ask for approval, so the sandbox mode is the only boundary; prefer the app-server adapter for interactive work. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Codex, type ModelReasoningEffort, type SandboxMode, type Thread, type ThreadEvent, type ThreadItem, type UserInput as CodexInput } from '@openai/codex-sdk';
import type { EffortLevel, ModelInfo, ModelRef, PermissionMode, TranscriptItem, UsageTotals, UserInput } from '../../shared/types';
import { errorMessage, shortId, truncate } from '../util/async';
import type { HarnessAdapter, HarnessContext } from './types';
import { CODEX_STATIC_MODELS } from '../models/static-models';

function sandboxFor(mode: PermissionMode): SandboxMode {
  switch (mode) {
    case 'plan':
      return 'read-only';
    case 'full-auto':
      return 'danger-full-access';
    default:
      return 'workspace-write';
  }
}

function effortFor(e: EffortLevel | undefined): ModelReasoningEffort | undefined {
  return e as ModelReasoningEffort | undefined;
}

/**
 * Codex through the official SDK (codex exec). Non-interactive: there are no approvals,
 * the sandbox mode is the safety boundary. Queue-only (one turn at a time).
 */
export class CodexExecAdapter implements HarnessAdapter {
  readonly id = 'codex-exec' as const;
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private _busy = false;
  private abort: AbortController | null = null;
  private model: string | undefined;
  private effort: EffortLevel | undefined;
  private items = new Map<string, TranscriptItem>();
  private totals: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

  constructor(private readonly ctx: HarnessContext) {}

  get busy(): boolean {
    return this._busy;
  }

  async start(): Promise<void> {
    const meta = this.ctx.session();
    // The SDK spawns codexPathOverride directly, which fails with EINVAL for npm .cmd shims on
    // Windows; in that case let the SDK use its own bundled @openai/codex binary.
    const bin = this.ctx.runtime.resolve('codex');
    const override = bin && !/[.](cmd|bat)$/i.test(bin.path) ? bin.path : undefined;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    const key = await this.ctx.getApiKey('openai');
    if (key && !env.CODEX_API_KEY && !env.OPENAI_API_KEY) env.OPENAI_API_KEY = key;
    this.codex = new Codex({ codexPathOverride: override, env });
    this.model = meta.config.model?.model;
    this.effort = this.ctx.effort();
    this.totals = { ...meta.usage };
    this.ensureThread();
    this.ctx.emit({ type: 'status', status: 'idle' });
  }

  private ensureThread(): Thread {
    if (this.thread) return this.thread;
    const meta = this.ctx.session();
    const opts = {
      model: this.model,
      workingDirectory: meta.cwd,
      skipGitRepoCheck: true,
      sandboxMode: sandboxFor(this.ctx.permissionMode()),
      approvalPolicy: 'never' as const,
      modelReasoningEffort: effortFor(this.effort)
    };
    this.thread = meta.harnessRef.codexThreadId ? this.codex!.resumeThread(meta.harnessRef.codexThreadId, opts) : this.codex!.startThread(opts);
    return this.thread;
  }
  async send(input: UserInput): Promise<void> {
    if (!this.codex) await this.start();
    if (this._busy) throw new Error('Codex exec runs one turn at a time; wait for the current turn to finish.');
    let thread = this.ensureThread();
    const parts: CodexInput[] = [];
    if (input.text) parts.push({ type: 'text', text: input.text });
    for (const img of input.images ?? []) {
      const ext = img.mimeType.split('/')[1] ?? 'png';
      const file = path.join(this.ctx.sessionDir, 'images', `${shortId('img_')}.${ext}`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.from(img.data, 'base64'));
      parts.push({ type: 'local_image', path: file });
    }
    this._busy = true;
    this.abort = new AbortController();
    const startedAt = Date.now();
    this.ctx.emit({ type: 'status', status: 'running' });
    void (async () => {
      try {
        try {
          await this.streamTurn(thread, parts, startedAt);
        } catch (e) {
          if (this.abort?.signal.aborted || thread !== this.thread || !this.ctx.session().harnessRef.codexThreadId) throw e;
          // A refused/stale resume must not leave the broken thread cached: drop it (and the
          // stored thread id) and retry once with a fresh thread.
          this.thread = null;
          this.ctx.updateRef({ codexThreadId: undefined });
          this.ctx.log('warn', `codex resume failed (${errorMessage(e)}); retrying with a new thread.`);
          thread = this.ensureThread();
          await this.streamTurn(thread, parts, startedAt);
        }
      } catch (e) {
        const aborted = this.abort?.signal.aborted;
        this.ctx.emit({ type: 'item.upsert', item: { id: shortId('turn_'), kind: 'turn', ts: Date.now(), status: aborted ? 'interrupted' : 'failed', durationMs: Date.now() - startedAt, error: aborted ? undefined : errorMessage(e) } });
      } finally {
        this._busy = false;
        this.abort = null;
        this.ctx.emit({ type: 'status', status: 'idle' });
      }
    })();
  }

  private async streamTurn(thread: Thread, parts: CodexInput[], startedAt: number): Promise<void> {
    const { events } = await thread.runStreamed(parts, { signal: this.abort!.signal });
    for await (const ev of events) this.handle(ev);
    if (thread.id) this.ctx.updateRef({ codexThreadId: thread.id });
  }

  private handle(ev: ThreadEvent): void {
    switch (ev.type) {
      case 'thread.started':
        this.ctx.updateRef({ codexThreadId: ev.thread_id });
        return;
      case 'turn.started':
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.upsertItem(ev.item, ev.type === 'item.completed');
        return;
      case 'turn.completed': {
        const u = ev.usage;
        this.totals.inputTokens += u.input_tokens;
        this.totals.outputTokens += u.output_tokens;
        this.totals.cacheReadTokens += u.cached_input_tokens;
        this.totals.cacheWriteTokens += u.cache_write_input_tokens;
        this.totals.reasoningTokens += u.reasoning_output_tokens;
        this.totals.turns += 1;
        this.ctx.emit({ type: 'usage', totals: { ...this.totals } });
        this.ctx.emit({ type: 'item.upsert', item: { id: shortId('turn_'), kind: 'turn', ts: Date.now(), status: 'completed', usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cached_input_tokens, reasoningTokens: u.reasoning_output_tokens } } });
        return;
      }
      case 'turn.failed':
        this.ctx.emit({ type: 'item.upsert', item: { id: shortId('turn_'), kind: 'turn', ts: Date.now(), status: 'failed', error: ev.error.message } });
        return;
      case 'error':
        this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'error', text: ev.message } });
        return;
    }
  }

  private upsertItem(item: ThreadItem, completed: boolean): void {
    const existing = this.items.get(item.id);
    const ts = existing?.ts ?? Date.now();
    let out: TranscriptItem | null = null;
    switch (item.type) {
      case 'agent_message':
        out = { id: item.id, kind: 'assistant', ts, text: item.text, streaming: !completed, model: this.model, phase: 'final' };
        break;
      case 'reasoning':
        out = { id: item.id, kind: 'assistant', ts, text: '', thinking: item.text, streaming: !completed, phase: 'commentary' };
        break;
      case 'command_execution':
        out = { id: item.id, kind: 'tool', ts, name: 'bash', hint: 'execute', summary: item.command, input: { command: item.command }, output: truncate(item.aggregated_output ?? '', 40_000), status: item.status === 'in_progress' ? 'running' : item.status === 'failed' ? 'error' : 'done', exitCode: item.exit_code ?? null };
        break;
      case 'file_change':
        out = { id: item.id, kind: 'tool', ts, name: 'apply_patch', hint: 'edit', summary: item.changes.map((c) => c.path).join(', '), status: item.status === 'failed' ? 'error' : 'done', changes: item.changes.map((c) => ({ path: c.path, kind: c.kind })) };
        break;
      case 'mcp_tool_call':
        out = { id: item.id, kind: 'tool', ts, name: `${item.server}.${item.tool}`, hint: 'mcp', input: item.arguments, summary: JSON.stringify(item.arguments).slice(0, 200), output: item.error ? item.error.message : item.result ? truncate(JSON.stringify(item.result.content ?? item.result.structured_content ?? '', null, 2), 40_000) : undefined, status: item.status === 'in_progress' ? 'running' : item.status === 'failed' ? 'error' : 'done' };
        break;
      case 'web_search':
        out = { id: item.id, kind: 'tool', ts, name: 'web_search', hint: 'fetch', summary: item.query, status: completed ? 'done' : 'running' };
        break;
      case 'todo_list':
        out = { id: item.id, kind: 'plan', ts, entries: item.items.map((t) => ({ content: t.text, status: t.completed ? 'completed' : 'pending' })) };
        break;
      case 'error':
        out = { id: item.id, kind: 'info', ts, level: 'error', text: item.message };
        break;
    }
    if (out) {
      this.items.set(item.id, out);
      this.ctx.emit({ type: 'item.upsert', item: out });
    }
  }

  async interrupt(): Promise<void> {
    this.abort?.abort();
  }

  async setModel(model: ModelRef): Promise<void> {
    this.model = model.model;
    this.thread = null; // rebuilt with the new model on the next turn (resumes the same thread id)
    this.ctx.updateMeta({ activeModel: model });
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.effort = effort;
    this.thread = null;
    this.ctx.updateMeta({ activeEffort: effort });
  }

  async setPermissionMode(): Promise<void> {
    this.thread = null;
  }

  async listModels(): Promise<ModelInfo[]> {
    return CODEX_STATIC_MODELS;
  }

  async dispose(): Promise<void> {
    this.abort?.abort();
    this.thread = null;
    this.codex = null;
  }
}
