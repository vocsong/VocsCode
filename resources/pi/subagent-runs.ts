/**
 * Subagent run records.
 *
 * One JSONL file per run under `<sessionDir>/subagents/<runId>.jsonl`, appended by the extension
 * and read back by the desktop app after a restart. The file is the durable record; live updates
 * travel separately as `VCODE_SUBAGENT::` notifications, so a crash can never lose the run's
 * transcript — only the tail of a run that was still streaming.
 *
 * No pi SDK imports, no writes outside the given directory, and no thrown errors: a failed append
 * degrades to a live-only run rather than breaking the parent's turn.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

export type RunStatus = 'running' | 'completed' | 'error' | 'stopped' | 'interrupted';
export type RunMode = 'foreground' | 'background';

export interface RunMeta {
  runId: string;
  agent: string;
  description: string;
  mode: RunMode;
  provider?: string;
  model?: string;
  /** Explicit per-call effort, if requested. The effective SDK level is recorded separately. */
  requestedThinkingLevel?: string;
  thinkingLevel?: string;
  cwd: string;
  startedAt: number;
}

/** One model call inside the run: the per-call analytics row. */
export interface RunCall {
  index: number;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  durationMs: number;
  stopReason?: string;
  toolsInvoked: string[];
}

export interface RunTotals {
  turns: number;
  toolUses: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface RunItem {
  id: string;
  ts: number;
  kind: 'assistant' | 'tool' | 'info';
  /** Tool name for `kind: 'tool'`. */
  name?: string;
  summary?: string;
  status?: 'running' | 'done' | 'error' | 'declined';
  text?: string;
  output?: string;
  /** Tool call input, for rendering. */
  input?: Record<string, unknown>;
}

export type RunRecord =
  | ({ t: 'run' } & RunMeta)
  | { t: 'item'; item: RunItem }
  | { t: 'call'; call: RunCall }
  | { t: 'end'; status: RunStatus; totals: RunTotals; endedAt: number; error?: string };

export function emptyTotals(now = 0): RunTotals {
  return { turns: 0, toolUses: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, durationMs: 0 };
}

/** The loose shape pi hands an extension for a finished message. */
export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: { total?: number } & Record<string, unknown>;
}

export function emptyCall(index: number): RunCall {
  return { index, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, durationMs: 0, toolsInvoked: [] };
}

/** Fold a pi `Usage` object into a call row and the run's running totals, in place. */
export function addUsage(call: RunCall, totals: RunTotals, usage: UsageLike | undefined, durationMs: number): void {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  call.inputTokens += n(usage?.input);
  call.outputTokens += n(usage?.output);
  call.cacheReadTokens += n(usage?.cacheRead);
  call.cacheWriteTokens += n(usage?.cacheWrite);
  call.reasoningTokens += n(usage?.reasoning);
  call.costUsd += n(usage?.cost?.total);
  call.durationMs += durationMs;
  totals.inputTokens += n(usage?.input);
  totals.outputTokens += n(usage?.output);
  totals.cacheReadTokens += n(usage?.cacheRead);
  totals.cacheWriteTokens += n(usage?.cacheWrite);
  totals.reasoningTokens += n(usage?.reasoning);
  totals.costUsd += n(usage?.cost?.total);
  totals.durationMs += durationMs;
}

/** Caps that keep one runaway run from filling the disk: kept in sync with the app's reader. */
export const LIMITS = {
  /** Characters kept from one item's text/output field. */
  itemChars: 20_000,
  /** Items recorded per run; beyond it, only a truncation marker is appended. */
  itemsPerRun: 600,
  /** Model-call rows per run. */
  callsPerRun: 500,
} as const;

function clip(value: string | undefined, limit: number = LIMITS.itemChars): string | undefined {
  if (typeof value !== 'string') return value;
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

/**
 * Append-only writer for one session's run files. All writes are best-effort and serialized per
 * run, so a slow disk cannot reorder records and a failure cannot break the parent's turn.
 */
export class RunStore {
  private readonly dir: string;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly items = new Map<string, number>();
  private readonly calls = new Map<string, number>();
  private ready: Promise<void> | null = null;
  private warned = false;

  constructor(dir: string, private readonly onError?: (message: string) => void) {
    this.dir = dir;
  }

  fileFor(runId: string): string {
    return path.join(this.dir, `${runId}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    this.ready ??= fs.mkdir(this.dir, { recursive: true }).then(() => undefined);
    await this.ready;
  }

  async start(meta: RunMeta): Promise<void> {
    await this.append(meta.runId, { t: 'run', ...meta });
  }

  async item(runId: string, item: RunItem): Promise<void> {
    const count = (this.items.get(runId) ?? 0) + 1;
    this.items.set(runId, count);
    if (count > LIMITS.itemsPerRun) {
      if (count === LIMITS.itemsPerRun + 1) await this.append(runId, { t: 'item', item: { id: `${runId}-truncated`, ts: item.ts, kind: 'info', summary: `Transcript truncated after ${LIMITS.itemsPerRun} items.`, status: 'done' } });
      return;
    }
    await this.append(runId, {
      t: 'item',
      item: { ...item, text: clip(item.text), output: clip(item.output), summary: clip(item.summary, 2_000) },
    });
  }

  async call(runId: string, call: RunCall): Promise<void> {
    const count = (this.calls.get(runId) ?? 0) + 1;
    this.calls.set(runId, count);
    if (count > LIMITS.callsPerRun) return;
    await this.append(runId, { t: 'call', call: { ...call, toolsInvoked: [...call.toolsInvoked] } });
  }

  async end(runId: string, status: RunStatus, totals: RunTotals, error?: string): Promise<void> {
    await this.append(runId, { t: 'end', status, totals: { ...totals }, endedAt: Date.now(), ...(error ? { error } : {}) });
    await this.chains.get(runId)?.catch(() => undefined);
    this.chains.delete(runId);
    this.items.delete(runId);
    this.calls.delete(runId);
  }

  /** Test/teardown hook: wait for every queued append to hit the disk. */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()].map((chain) => chain.catch(() => undefined)));
    await this.ready?.catch(() => undefined);
  }

  private append(runId: string, record: RunRecord): Promise<void> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await this.ensureDir();
        await fs.appendFile(this.fileFor(runId), `${JSON.stringify(record)}\n`, 'utf8');
      })
      .catch((error: unknown) => {
        // Best-effort by design: subagent activity must never break the parent's turn. Warn once.
        if (!this.warned) {
          this.warned = true;
          this.onError?.(`subagent run store write failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    this.chains.set(runId, next);
    return next;
  }
}
