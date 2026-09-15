/**
 * Subagent run records, read back from `<sessionDir>/subagents/<runId>.jsonl`.
 *
 * The writer is the pi extension (`resources/pi/subagent-runs.ts`) and it cannot import from here —
 * it is copied into the packaged app and loaded by pi. This module is the app's side of the same
 * format, and `tests/subagent-runs.test.ts` round-trips both so the two cannot drift silently.
 */

export type SubagentRunStatus = 'running' | 'completed' | 'error' | 'stopped' | 'interrupted';
export type SubagentRunMode = 'foreground' | 'background';

/**
 * What a harness's subagents support, so the panel and the main process agree on one answer.
 *
 * `runs` is "this harness records runs the panel can list". `control` is per-run stop/steer, which
 * only pi has: the Claude SDK can interrupt a whole turn but not one child. `agents` is editing the
 * project's own agent definitions, which is pi's `.pi/agents` layout.
 */
export interface SubagentSupport {
  runs: boolean;
  control: boolean;
  agents: boolean;
}

const SUPPORT: Record<string, SubagentSupport> = {
  pi: { runs: true, control: true, agents: true },
  claude: { runs: true, control: false, agents: false }
};

const NO_SUPPORT: SubagentSupport = { runs: false, control: false, agents: false };

export function subagentSupport(harness: string): SubagentSupport {
  return SUPPORT[harness] ?? NO_SUPPORT;
}

export interface SubagentRunMeta {
  runId: string;
  agent: string;
  description: string;
  mode: SubagentRunMode;
  provider?: string;
  model?: string;
  cwd: string;
  startedAt: number;
}

/** One model call: the unit of subagent analytics. */
export interface SubagentCall {
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

export interface SubagentRunTotals {
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

export interface SubagentItem {
  id: string;
  ts: number;
  kind: 'assistant' | 'tool' | 'info';
  name?: string;
  summary?: string;
  status?: 'running' | 'done' | 'error' | 'declined';
  text?: string;
  output?: string;
  input?: Record<string, unknown>;
}

export interface SubagentRun {
  meta: SubagentRunMeta;
  items: SubagentItem[];
  calls: SubagentCall[];
  status: SubagentRunStatus;
  totals: SubagentRunTotals;
  endedAt?: number;
  error?: string;
}

/** A run's listing row: enough to render the run list without its transcript. */
export interface SubagentRunSummary {
  runId: string;
  agent: string;
  description: string;
  mode: SubagentRunMode;
  status: SubagentRunStatus;
  provider?: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
  costUsd: number;
  turns: number;
  toolUses: number;
}

export function summarizeRun(run: SubagentRun): SubagentRunSummary {
  return {
    runId: run.meta.runId,
    agent: run.meta.agent,
    description: run.meta.description,
    mode: run.meta.mode,
    status: run.status,
    ...(run.meta.provider ? { provider: run.meta.provider } : {}),
    ...(run.meta.model ? { model: run.meta.model } : {}),
    startedAt: run.meta.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    costUsd: run.totals.costUsd,
    turns: run.totals.turns,
    toolUses: run.totals.toolUses
  };
}

export function emptyRunTotals(): SubagentRunTotals {
  return { turns: 0, toolUses: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, durationMs: 0 };
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parse one run file. Unknown or malformed lines are skipped: a run written by a newer extension
 * still renders as much as this app version understands. Returns null when the file has no run
 * header, which is how a partially written file is rejected.
 */
export function parseRunFile(text: string): SubagentRun | null {
  let run: SubagentRun | null = null;
  // Items arrive as append-only upserts (a running tool call, then its result), so the last
  // record for an id wins while the first appearance keeps its position.
  const items = new Map<string, SubagentItem>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.t === 'run' && typeof record.runId === 'string') {
      const meta: SubagentRunMeta = {
        runId: record.runId,
        agent: typeof record.agent === 'string' ? record.agent : 'general-purpose',
        description: typeof record.description === 'string' ? record.description : '',
        mode: record.mode === 'background' ? 'background' : 'foreground',
        ...(typeof record.provider === 'string' ? { provider: record.provider } : {}),
        ...(typeof record.model === 'string' ? { model: record.model } : {}),
        cwd: typeof record.cwd === 'string' ? record.cwd : '',
        startedAt: numberOr(record.startedAt)
      };
      // A writer may restate the header to correct a fact it only learned later (the Claude adapter
      // learns a subagent's own model from the child's first message). Only the meta is replaced:
      // the transcript and calls recorded in between still belong to this run.
      if (run) run.meta = meta;
      else run = { meta, items: [], calls: [], status: 'running', totals: emptyRunTotals() };
      continue;
    }
    if (!run) continue;
    if (record.t === 'item' && record.item && typeof record.item === 'object') {
      const item = record.item as Record<string, unknown>;
      if (typeof item.id === 'string' && (item.kind === 'assistant' || item.kind === 'tool' || item.kind === 'info')) {
        items.set(item.id, { ...item, id: item.id, ts: numberOr(item.ts), kind: item.kind } as SubagentItem);
      }
      continue;
    }
    if (record.t === 'call' && record.call && typeof record.call === 'object') {
      const call = record.call as Record<string, unknown>;
      run.calls.push({
        index: numberOr(call.index, run.calls.length),
        ...(typeof call.provider === 'string' ? { provider: call.provider } : {}),
        ...(typeof call.model === 'string' ? { model: call.model } : {}),
        inputTokens: numberOr(call.inputTokens),
        outputTokens: numberOr(call.outputTokens),
        cacheReadTokens: numberOr(call.cacheReadTokens),
        cacheWriteTokens: numberOr(call.cacheWriteTokens),
        reasoningTokens: numberOr(call.reasoningTokens),
        costUsd: numberOr(call.costUsd),
        durationMs: numberOr(call.durationMs),
        ...(typeof call.stopReason === 'string' ? { stopReason: call.stopReason } : {}),
        toolsInvoked: Array.isArray(call.toolsInvoked) ? call.toolsInvoked.filter((t): t is string => typeof t === 'string') : [],
      });
      continue;
    }
    if (record.t === 'end') {
      const totals = (record.totals ?? {}) as Record<string, unknown>;
      run.status = (['completed', 'error', 'stopped', 'interrupted'] as const).find((s) => s === record.status) ?? 'error';
      run.endedAt = numberOr(record.endedAt);
      if (typeof record.error === 'string') run.error = record.error;
      run.totals = {
        turns: numberOr(totals.turns),
        toolUses: numberOr(totals.toolUses),
        inputTokens: numberOr(totals.inputTokens),
        outputTokens: numberOr(totals.outputTokens),
        cacheReadTokens: numberOr(totals.cacheReadTokens),
        cacheWriteTokens: numberOr(totals.cacheWriteTokens),
        reasoningTokens: numberOr(totals.reasoningTokens),
        costUsd: numberOr(totals.costUsd),
        durationMs: numberOr(totals.durationMs),
      };
    }
  }
  if (run) run.items = [...items.values()];
  return run;
}

/** Spend per model across a set of runs, for analytics re-attribution and the panel footer. */
export function costsByModel(runs: readonly SubagentRun[]): { provider: string; model: string; costUsd: number; calls: number }[] {
  const byKey = new Map<string, { provider: string; model: string; costUsd: number; calls: number }>();
  for (const run of runs) {
    for (const call of run.calls) {
      const provider = call.provider ?? run.meta.provider ?? 'unknown';
      const model = call.model ?? run.meta.model ?? 'unknown';
      const key = `${provider}/${model}`;
      const row = byKey.get(key) ?? { provider, model, costUsd: 0, calls: 0 };
      row.costUsd += call.costUsd;
      row.calls += 1;
      byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((a, b) => b.costUsd - a.costUsd);
}
