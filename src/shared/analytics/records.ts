/**
 * Stored shapes of the execution log: one record per finished tool call and one per agent turn.
 * Raw facts and derived classification sit side by side but never mix, so a rule change can rewrite
 * `derived` from `facts` without touching what was observed.
 */
import type { ExecutionDerived, ExecutionFacts } from './classify';

export type IngestKind = 'live' | 'backfill';

/** How much of the execution log is kept: newest records first, never older than the day limit. */
export const EXECUTION_RETENTION = { maxRecords: 50_000, maxDays: 90 };

export interface ExecutionRecord {
  /** ANALYTICS_SCHEMA_VERSION at write time. */
  v: number;
  /** `${sessionId}:${toolItemId}`, unique per call across restarts. */
  id: string;
  sessionId: string;
  /** Start of the call (the transcript item's timestamp). */
  ts: number;
  /** When the terminal state was recorded. */
  endTs: number;
  harness: string;
  harnessVersion?: string;
  /** `provider/model` that generated the call, when known. */
  model?: string;
  /** The session's active model when the generating model differs (a subagent's call). */
  parentModel?: string;
  role: 'parent' | 'subagent';
  projectRoot: string;
  /** `platform-release`, e.g. `win32-10.0.26200`. */
  os: string;
  arch?: string;
  /** Turn index within the session, counting user messages; 0 before the first known one. */
  turn: number;
  ingest: IngestKind;
  facts: ExecutionFacts;
  derived: ExecutionDerived;
  /**
   * Lines the call added to files, from its own diffs; 0 when it wrote nothing. Absent when a file
   * change arrived without a diff, so the call counts as unmeasured rather than as having written
   * nothing — see `addedLinesOf`. Not set on delegated-run summaries, which are not executions.
   */
  addedLines?: number;
  /**
   * For a pi subagent completion, the number of internal tool calls it reported. Such records are
   * summaries, not executions: excluded from execution rates and shown as delegated volume.
   */
  weight?: number;
}

/** What one finished turn cost, as the harness reported it. */
export interface TurnUsageFacts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/**
 * Tokens a turn's facts add up to — the denominator of every per-token rate. Reasoning tokens are
 * not added: they are billed inside output. A turn that reported only a cost adds up to zero and has
 * nothing to divide by, so a rate over tokens must skip it rather than count it as a free turn.
 */
export function usageTokens(u: TurnUsageFacts): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

export interface TurnRecord {
  v: number;
  /** `${sessionId}:turn:${n}` */
  id: string;
  sessionId: string;
  turn: number;
  harness: string;
  model?: string;
  projectRoot: string;
  startTs: number;
  endTs?: number;
  /** `open` while no terminal turn item has been seen (including a session that died mid-turn). */
  status: 'completed' | 'failed' | 'interrupted' | 'open';
  ingest: IngestKind;
  /**
   * Token facts of the completed turn: what it cost, and the counters behind it when the harness
   * reported them. Absent when the harness reported neither (ACP agents report no tokens) or on
   * records written before they were stored, so a turn without them is unmeasured and stays out of
   * every per-turn rate rather than counting as a free turn. A turn whose cost is known but whose
   * counters are not is stored too, with zeros — see `usageTokens`.
   */
  usage?: TurnUsageFacts;
}

/** Whether a record is a real tool execution rather than a delegated-run summary. */
export function isExecution(r: ExecutionRecord): boolean {
  return r.weight === undefined;
}

/** `provider/model` key of a model reference, matching the usage slices. */
export function modelKeyOf(ref: { provider?: string; model?: string } | undefined): string | undefined {
  if (!ref?.model) return undefined;
  return `${ref.provider ?? ''}/${ref.model}`;
}
