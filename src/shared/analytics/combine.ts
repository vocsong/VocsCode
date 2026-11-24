/**
 * Combines several computers' analytics snapshots into the dashboard's "All computers" view, and
 * summarizes one computer on its own. Keep this file free of Node/Electron/DOM imports.
 *
 * Day buckets add up by date and their slices merge by key, so projects with one folder name merge
 * across computers. Session ids are only unique per machine, so they are prefixed with the host id.
 * Totals are taken per computer first (the summary takes the larger of session and day totals) and
 * then added; taking the larger of two merged sums would undercount. Reliability and code-output
 * reports carry rates and percentiles that cannot be summed, so they stay per computer.
 */
import type { ToolUsage, UsageDay, UsageDayDimensions, UsageSessionRecord, UsageSlice, UsageTotals } from '../usage-types';
import type { AnalyticsSummary } from './summary';
import { emptyCodeOutputReport } from './code-output';
import { emptyReliabilityReport } from './reliability';
import { addCounters, emptyCounters, emptyDimensions, emptySlice } from '../usage-rollup';
import { addToolMap, type AnalyticsSnapshot } from './snapshot';
import { addTotals, summarize, type UsageSummary } from './usage-summary';

export interface ComputerSnapshot {
  hostId: string;
  name: string;
  snapshot: AnalyticsSnapshot;
}

export interface ComputerAnalytics {
  hostId: string;
  name: string;
  summary: AnalyticsSummary;
}

export interface CombinedAnalytics {
  /** Every computer added together; reports stay per computer in `computers`. */
  summary: UsageSummary;
  computers: ComputerAnalytics[];
}

/** One computer's summary for a range, with the reports it precomputed for that range. */
export function summarizeSnapshot(snapshot: AnalyticsSnapshot, dayLimit: number, now: number): AnalyticsSummary {
  const usage = summarize(snapshot.sessions, snapshot.days, snapshot.tools, snapshot.modelTools, snapshot.harnessModelTools, {}, dayLimit, now, snapshot.harnessTools);
  const reports = snapshot.reports[String(dayLimit)];
  return { ...usage, reliability: reports?.reliability ?? emptyReliabilityReport(now, dayLimit), codeOutput: reports?.codeOutput ?? emptyCodeOutputReport(now, dayLimit) };
}

/** Session id as it appears in a combined view: `<hostId>:<sessionId>`. */
export function combinedSessionId(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

function mergeSlices(into: Record<string, UsageSlice>, from: Record<string, UsageSlice> | undefined, hostId: string): void {
  for (const [key, slice] of Object.entries(from ?? {})) {
    const target = (into[key] ??= emptySlice(slice.label));
    addCounters(target, slice);
    for (const id of slice.sessions ?? []) {
      const sid = combinedSessionId(hostId, id);
      if (!target.sessions.includes(sid)) target.sessions.push(sid);
    }
  }
}

function mergeNested(into: Record<string, Record<string, ToolUsage>>, from: Record<string, Record<string, ToolUsage>> | undefined): void {
  for (const [owner, perTool] of Object.entries(from ?? {})) addToolMap((into[owner] ??= {}), perTool);
}

function mergeDimensions(into: UsageDayDimensions, from: UsageDayDimensions, hostId: string): void {
  if (from.estimated) into.estimated = true;
  mergeSlices(into.harness, from.harness, hostId);
  mergeSlices(into.model, from.model, hostId);
  mergeSlices(into.harnessModel, from.harnessModel, hostId);
  mergeSlices(into.project, from.project, hostId);
  addToolMap(into.tool, from.tool ?? {});
  mergeNested(into.modelTool, from.modelTool);
  if (from.harnessTool) mergeNested((into.harnessTool ??= {}), from.harnessTool);
  mergeNested(into.harnessModelTool, from.harnessModelTool);
}

export function combineSnapshots(list: ComputerSnapshot[], dayLimit: number, now: number): CombinedAnalytics {
  const computers = list.map((c) => ({ hostId: c.hostId, name: c.name, summary: summarizeSnapshot(c.snapshot, dayLimit, now) }));

  const days: Record<string, UsageDay> = {};
  const sessions: UsageSessionRecord[] = [];
  const tools: Record<string, ToolUsage> = {};
  const modelTools: Record<string, Record<string, ToolUsage>> = {};
  const harnessTools: Record<string, Record<string, ToolUsage>> = {};
  const harnessModelTools: Record<string, Record<string, ToolUsage>> = {};
  for (const { hostId, snapshot } of list) {
    for (const [date, day] of Object.entries(snapshot.days)) {
      const target = (days[date] ??= emptyCounters());
      addCounters(target, day);
      if (day.by) mergeDimensions((target.by ??= emptyDimensions()), day.by, hostId);
    }
    for (const s of snapshot.sessions) sessions.push({ ...s, id: combinedSessionId(hostId, s.id) });
    addToolMap(tools, snapshot.tools);
    mergeNested(modelTools, snapshot.modelTools);
    mergeNested(harnessTools, snapshot.harnessTools);
    mergeNested(harnessModelTools, snapshot.harnessModelTools);
  }

  const summary = summarize(sessions, days, tools, modelTools, harnessModelTools, {}, dayLimit, now, harnessTools);
  const totals: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };
  for (const c of computers) addTotals(totals, c.summary.totals);
  summary.totals = totals;
  summary.toolTotals.calls = computers.reduce((acc, c) => acc + c.summary.toolTotals.calls, 0);
  return { summary, computers };
}
