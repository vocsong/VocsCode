/**
 * Shared usage, spend, tool-rollup, and day-bucket types.
 * Keep this file free of Node/Electron/DOM imports.
 */
import type { HarnessId } from './harness-types';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  turns: number;
  contextWindow?: number;
  /** Tokens currently in the context window, when the harness reports it. */
  contextTokens?: number;
}

/** The numeric usage counters shared by day buckets and their per-dimension slices. */
export interface UsageCounters {
  /** Estimated tokens of newly submitted user text, counted once; never part of billed totals. */
  userInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  turns: number;
  /** Cumulative completed-turn wall time in ms. */
  durationMs: number;
  /** Completed tool calls recorded. */
  toolCalls: number;
  /**
   * Output tokens and wall time of completed turns that reported both, paired so that
   * `speedTokens / speedMs` is a true average output speed (tokens per ms).
   */
  speedTokens: number;
  speedMs: number;
}

/** Usage attributed to one harness, model or project within a day, plus the sessions that produced it. */
export interface UsageSlice extends UsageCounters {
  label: string;
  sessions: string[];
}

/** Per-dimension attribution of one day's usage; the bounded ranges of the dashboard are built from it. */
export interface UsageDayDimensions {
  /** Set when the slices were estimated from session totals for a day recorded before slice tracking. */
  estimated?: boolean;
  harness: Record<string, UsageSlice>;
  /** Keyed `provider/model`, attributed to the model active when the usage was reported. */
  model: Record<string, UsageSlice>;
  /** Keyed `harness|provider/model`, attributed to both when the usage was reported. */
  harnessModel: Record<string, UsageSlice>;
  project: Record<string, UsageSlice>;
  tool: Record<string, ToolUsage>;
  /** Per-tool call counts keyed by model (`provider/model`), attributed to the model active when the call ran. */
  modelTool: Record<string, Record<string, ToolUsage>>;
  /** Live per-tool outcomes keyed by harness; absent in legacy days and never estimated. */
  harnessTool?: Record<string, Record<string, ToolUsage>>;
  /** Per-tool call counts keyed `harness|provider/model`, attributed to both when the call ran. */
  harnessModelTool: Record<string, Record<string, ToolUsage>>;
  file: Record<string, FileUsage>;
}

/** Aggregated usage for one UTC day, as accumulated by the analytics store. */
export interface UsageDay extends UsageCounters {
  /** Absent on days recorded before per-dimension tracking existed: their usage is in the totals only. */
  by?: UsageDayDimensions;
}

/** Output tokens and wall time of the turns that reported both; `tokens / ms * 1000` is tok/s. */
export interface UsageSpeed {
  tokens: number;
  ms: number;
}

/** Tool-call rollup per tool name. */
export interface ToolUsage {
  calls: number;
  errors: number;
  declined: number;
  durationMs: number;
}

export interface ToolUsageRow extends ToolUsage {
  name: string;
}

/** Tool-call rollup for one tool under one model. */
export interface ModelToolRow extends ToolUsage {
  /** `provider/model` of the session that made the call. */
  key: string;
  /** The model's qualified name (`provider/model`), or a harness id where the caller counts those. */
  label: string;
  /** Tool name. */
  name: string;
}

/** Tool-call rollup for one tool under one known session harness. */
export interface HarnessToolRow extends ToolUsage {
  /** Harness id, not a model or a tool alias. */
  key: string;
  label: string;
  name: string;
}

/** Tool-call rollup for one tool under one harness and model. */
export interface HarnessModelToolRow extends ModelToolRow {
  /** The harness the call ran in. */
  harness: string;
}

/** File-change counts by change kind, aggregated across tool calls. */
export interface FileUsage {
  adds: number;
  updates: number;
  deletes: number;
  renames: number;
}

export interface FileUsageRow extends FileUsage {
  path: string;
  total: number;
}

/** Per-session usage snapshot; kept in the analytics store even after the session is deleted. */
export interface UsageSessionRecord {
  id: string;
  title: string;
  harness: HarnessId;
  provider?: string;
  model?: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  usage: UsageTotals;
  /** Completed tool calls recorded for this session. */
  toolCalls: number;
  /** Cumulative completed-turn wall time in ms; absent in records written before it was tracked. */
  durationMs?: number;
  /** Output speed sample for this session; absent in records written before speed was tracked. */
  speed?: UsageSpeed;
}

/** Usage rollup for one dimension (harness, model, project). */
export interface UsageBucket {
  key: string;
  label: string;
  usage: UsageTotals;
  toolCalls: number;
  /** Cumulative completed-turn wall time in ms, so `durationMs / turns` is the average turn. */
  durationMs: number;
  sessions: number;
  speed: UsageSpeed;
}

/** Effective per-model pricing rates, blended from measured usage. */
export interface ModelRateRow {
  /** The model's qualified name (`provider/model`), which is also its label. */
  key: string;
  label: string;
  /** Effective blended cost per 1,000,000 tokens (input + output + cache), or undefined when no tokens were measured. */
  usdPerMTok?: number;
  /** Effective cost per model call (one turn), or undefined when no turns were measured. */
  usdPerCall?: number;
  /** All-time spend attributed to the model. */
  costUsd: number;
  /** All-time tokens (input + output + cache) attributed to the model. */
  tokens: number;
  /** All-time model calls (turns) attributed to the model. */
  calls: number;
}

export interface AnalyticsDayPoint {
  date: string;
  usage: UsageDay;
}
