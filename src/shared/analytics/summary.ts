/**
 * Shared AnalyticsSummary composite type combining usage rollups, reliability, and code output.
 * Keep this file free of Node/Electron/DOM imports.
 */
import type {
  AnalyticsDayPoint,
  FileUsageRow,
  HarnessModelToolRow,
  HarnessToolRow,
  ModelRateRow,
  ModelToolRow,
  ToolUsage,
  ToolUsageRow,
  UsageBucket,
  UsageCounters,
  UsageSessionRecord,
  UsageSpeed,
  UsageTotals
} from '../usage-types';
import type { CodeOutputReport } from './code-output';
import type { ReliabilityReport } from './reliability';

export interface AnalyticsSummary {
  /** All-time totals across every recorded session, including deleted ones. */
  totals: UsageTotals;
  /** All-time output speed sample (completed turns that reported tokens and duration). */
  speed: UsageSpeed;
  /** UTC days, ascending, filtered to the requested range. */
  days: AnalyticsDayPoint[];
  /** Totals of the window of equal length just before the requested range; absent for all time. */
  previous?: UsageCounters;
  byHarness: UsageBucket[];
  byModel: UsageBucket[];
  /** Keyed `harness|provider/model`; all time this attributes each session to its last model. */
  byHarnessModel: UsageBucket[];
  byProject: UsageBucket[];
  /** Effective $/M tokens and $/call per model, sorted by spend. */
  modelRates: ModelRateRow[];
  /** All-time tool-call totals and per-tool/per-file breakdowns, sorted by volume. */
  toolTotals: ToolUsage;
  tools: ToolUsageRow[];
  /** Per-tool call counts per model, sorted by volume. */
  modelTools: ModelToolRow[];
  /** Live per-tool outcomes per harness, recorded since this dimension was introduced. */
  harnessTools: HarnessToolRow[];
  /** Per-tool call counts per harness and model, sorted by volume. */
  harnessModelTools: HarnessModelToolRow[];
  files: FileUsageRow[];
  /** Sessions sorted by spend, highest first. */
  sessions: UsageSessionRecord[];
  sessionCount: number;
  activeDays: number;
  firstDay?: string;
  /** Semantic outcome analytics over the retained execution log, for the requested range. */
  reliability: ReliabilityReport;
  /** Lines written per token spent, over the same execution log and range. */
  codeOutput: CodeOutputReport;
}
