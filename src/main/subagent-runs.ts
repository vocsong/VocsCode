/**
 * Subagent run records for harnesses the app runs in-process.
 *
 * One JSONL file per run under `<sessionDir>/<harness>/subagents/<runId>.jsonl`, appended as the run
 * progresses and read back by `src/main/subagents.ts`. The file is the durable record, which is what
 * lets the Subagents panel show a session's runs after a restart.
 *
 * This is the app-side twin of `resources/pi/subagent-runs.ts`, which the pi extension loads
 * standalone inside the packaged app and so cannot import from here. The two must write the same
 * format; `tests/subagents-store.test.ts` round-trips both through the reader to keep them in sync.
 * The variant types themselves are not duplicated — both sides use `src/shared/subagents.ts`.
 *
 * No writes outside the given directory and no thrown errors: a failed append degrades to a
 * live-only run rather than breaking the parent's turn.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { SubagentCall, SubagentItem, SubagentRunMeta, SubagentRunStatus, SubagentRunTotals } from '../shared/subagents';

type RunRecord =
  | ({ t: 'run' } & SubagentRunMeta)
  | { t: 'item'; item: SubagentItem }
  | { t: 'call'; call: SubagentCall }
  | { t: 'end'; status: SubagentRunStatus; totals: SubagentRunTotals; endedAt: number; error?: string };

/** Caps that keep one runaway run from filling the disk: kept in sync with the pi writer. */
export const LIMITS = {
  /** Characters kept from one item's text/output field. */
  itemChars: 20_000,
  /** Items recorded per run; beyond it, only a truncation marker is appended. */
  itemsPerRun: 600,
  /** Model-call rows per run. */
  callsPerRun: 500
} as const;

function clip(value: string | undefined, limit: number = LIMITS.itemChars): string | undefined {
  if (typeof value !== 'string') return value;
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

/**
 * Append-only writer for one session's run files. All writes are best-effort and serialized per run,
 * so a slow disk cannot reorder records and a failure cannot break the parent's turn.
 */
export class RunStore {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly items = new Map<string, number>();
  private readonly calls = new Map<string, number>();
  private ready: Promise<void> | null = null;
  private warned = false;

  constructor(private readonly dir: string, private readonly onError?: (message: string) => void) {}

  fileFor(runId: string): string {
    return path.join(this.dir, `${runId}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    this.ready ??= fs.mkdir(this.dir, { recursive: true }).then(() => undefined);
    await this.ready;
  }

  async start(meta: SubagentRunMeta): Promise<void> {
    await this.append(meta.runId, { t: 'run', ...meta });
  }

  async item(runId: string, item: SubagentItem): Promise<void> {
    const count = (this.items.get(runId) ?? 0) + 1;
    this.items.set(runId, count);
    if (count > LIMITS.itemsPerRun) {
      if (count === LIMITS.itemsPerRun + 1) {
        await this.append(runId, {
          t: 'item',
          item: { id: `${runId}-truncated`, ts: item.ts, kind: 'info', summary: `Transcript truncated after ${LIMITS.itemsPerRun} items.`, status: 'done' }
        });
      }
      return;
    }
    await this.append(runId, {
      t: 'item',
      item: { ...item, text: clip(item.text), output: clip(item.output), summary: clip(item.summary, 2_000) }
    });
  }

  async call(runId: string, call: SubagentCall): Promise<void> {
    const count = (this.calls.get(runId) ?? 0) + 1;
    this.calls.set(runId, count);
    if (count > LIMITS.callsPerRun) return;
    await this.append(runId, { t: 'call', call: { ...call, toolsInvoked: [...call.toolsInvoked] } });
  }

  async end(runId: string, status: SubagentRunStatus, totals: SubagentRunTotals, error?: string): Promise<void> {
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
