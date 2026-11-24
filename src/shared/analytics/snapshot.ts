/**
 * The analytics snapshot a desktop uploads for the code.vocs.io dashboard (docs/WEB-DASHBOARD.md).
 *
 * Built by an allowlist projection: only the fields named here leave the machine. Projects are
 * reduced to their folder name, per-file paths and replay receipts are never copied, and path-like
 * text in reliability rows and signatures is cut to its last segment. The snapshot is split into
 * parts (one per month of days and of sessions, plus tools and reports) so each stays under the
 * relay's value cap and an upload only resends what changed.
 *
 * Keep this file free of Node/Electron/DOM imports.
 */
import type { ToolUsage, UsageCounters, UsageDay, UsageDayDimensions, UsageSessionRecord, UsageSlice, UsageTotals } from '../usage-types';
import type { CodeOutputReport } from './code-output';
import type { ReliabilityReport, ReliabilityRow } from './reliability';
import { addCounters, addToolUsage, COUNTER_FIELDS, emptyCounters, emptySlice, emptyToolUsage } from '../usage-rollup';
import { ANALYTICS_SNAPSHOT_SCHEMA, type AnalyticsSnapshotManifest, type AnalyticsSnapshotMeta } from './snapshot-wire';

export { ANALYTICS_SNAPSHOT_SCHEMA, SNAPSHOT_PART_ID, type AnalyticsSnapshotManifest, type AnalyticsSnapshotMeta, type SnapshotPartRef } from './snapshot-wire';

/** The dashboard's ranges in days (0 = all time); reports are precomputed for each. */
export const SNAPSHOT_RANGES = [7, 30, 90, 0] as const;
export type SnapshotRange = (typeof SNAPSHOT_RANGES)[number];

export interface SnapshotReports {
  reliability: ReliabilityReport;
  codeOutput: CodeOutputReport;
}

export interface SnapshotToolMaps {
  tools: Record<string, ToolUsage>;
  modelTools: Record<string, Record<string, ToolUsage>>;
  harnessTools: Record<string, Record<string, ToolUsage>>;
  harnessModelTools: Record<string, Record<string, ToolUsage>>;
}

/** What the desktop's analytics store hands the projection; nothing else is read. */
export interface AnalyticsSnapshotSource extends SnapshotToolMaps {
  days: Record<string, UsageDay>;
  sessions: UsageSessionRecord[];
  /** Keyed by range (`'7'`, `'30'`, `'90'`, `'0'`). */
  reports: Record<string, SnapshotReports>;
}

/**
 * One computer's uploaded analytics. `sessions[].projectRoot` and the `by.project` keys hold the
 * project's folder name, never a path; `by.file` is always empty.
 */
export interface AnalyticsSnapshot extends AnalyticsSnapshotMeta, AnalyticsSnapshotSource {
  schemaVersion: number;
}

/** The last segment of a path in either separator style: `G:\Work\Vocs-Code\` → `Vocs-Code`. */
export function projectFolderName(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || root;
}

/**
 * Cuts every path-like field of an `a | b | c` signature (or of a single value) to its last
 * segment. A field with a slash or backslash is taken whole, so `C:\Program Files\x.exe` → `x.exe`.
 */
export function redactPaths(text: string): string {
  return text
    .split(' | ')
    .map((part) => (/[\\/]/.test(part) ? projectFolderName(part) : part))
    .join(' | ');
}

function counters(from: Partial<UsageCounters>): UsageCounters {
  const out = emptyCounters();
  for (const f of COUNTER_FIELDS) {
    const v = from[f];
    if (typeof v === 'number' && Number.isFinite(v)) out[f] = v;
  }
  return out;
}

function totals(from: UsageTotals): UsageTotals {
  return { inputTokens: from.inputTokens ?? 0, outputTokens: from.outputTokens ?? 0, cacheReadTokens: from.cacheReadTokens ?? 0, cacheWriteTokens: from.cacheWriteTokens ?? 0, reasoningTokens: from.reasoningTokens ?? 0, costUsd: from.costUsd ?? 0, turns: from.turns ?? 0 };
}

function toolUsage(from: ToolUsage): ToolUsage {
  return { calls: from.calls ?? 0, errors: from.errors ?? 0, declined: from.declined ?? 0, durationMs: from.durationMs ?? 0 };
}

function toolMap(from: Record<string, ToolUsage> | undefined): Record<string, ToolUsage> {
  const out: Record<string, ToolUsage> = {};
  for (const [name, usage] of Object.entries(from ?? {})) out[name] = toolUsage(usage);
  return out;
}

function nestedToolMap(from: Record<string, Record<string, ToolUsage>> | undefined): Record<string, Record<string, ToolUsage>> {
  const out: Record<string, Record<string, ToolUsage>> = {};
  for (const [owner, perTool] of Object.entries(from ?? {})) out[owner] = toolMap(perTool);
  return out;
}

function sliceMap(from: Record<string, UsageSlice> | undefined, rekey: (key: string) => string = (k) => k, relabel?: (label: string) => string): Record<string, UsageSlice> {
  const out: Record<string, UsageSlice> = {};
  for (const [key, slice] of Object.entries(from ?? {})) {
    const k = rekey(key);
    const target = (out[k] ??= emptySlice(relabel ? relabel(slice.label) : slice.label));
    addCounters(target, counters(slice));
    for (const id of slice.sessions ?? []) if (!target.sessions.includes(id)) target.sessions.push(id);
  }
  return out;
}

function projectDimensions(by: UsageDayDimensions): UsageDayDimensions {
  const out: UsageDayDimensions = {
    harness: sliceMap(by.harness),
    model: sliceMap(by.model),
    harnessModel: sliceMap(by.harnessModel),
    // Two roots with one folder name on the same computer become one project, as they will across computers.
    project: sliceMap(by.project, projectFolderName, projectFolderName),
    tool: toolMap(by.tool),
    modelTool: nestedToolMap(by.modelTool),
    harnessModelTool: nestedToolMap(by.harnessModelTool),
    file: {}
  };
  if (by.harnessTool) out.harnessTool = nestedToolMap(by.harnessTool);
  if (by.estimated) out.estimated = true;
  return out;
}

function projectDay(day: UsageDay): UsageDay {
  const out: UsageDay = counters(day);
  if (day.by) out.by = projectDimensions(day.by);
  return out;
}

function projectSession(s: UsageSessionRecord): UsageSessionRecord {
  const out: UsageSessionRecord = {
    id: s.id,
    title: s.title,
    harness: s.harness,
    projectRoot: projectFolderName(s.projectRoot),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    usage: totals(s.usage),
    toolCalls: s.toolCalls ?? 0
  };
  if (s.provider) out.provider = s.provider;
  if (s.model) out.model = s.model;
  if (s.durationMs !== undefined) out.durationMs = s.durationMs;
  if (s.speed) out.speed = { tokens: s.speed.tokens, ms: s.speed.ms };
  return out;
}

function redactRows(rows: ReliabilityRow[], name: (text: string) => string): ReliabilityRow[] {
  return rows.map((r) => ({ ...r, key: name(r.key), label: name(r.label) }));
}

function projectReliability(report: ReliabilityReport): ReliabilityReport {
  const copy = JSON.parse(JSON.stringify(report)) as ReliabilityReport;
  copy.byProject = redactRows(copy.byProject, projectFolderName);
  copy.byExecutable = redactRows(copy.byExecutable, redactPaths);
  // Example execution ids only resolve against the desktop's own log.
  copy.signatures = copy.signatures.map((s) => ({ ...s, signature: redactPaths(s.signature), examples: [] }));
  return copy;
}

function projectReports(reports: Record<string, SnapshotReports>): Record<string, SnapshotReports> {
  const out: Record<string, SnapshotReports> = {};
  for (const range of SNAPSHOT_RANGES) {
    const r = reports[String(range)];
    if (!r) continue;
    out[String(range)] = { reliability: projectReliability(r.reliability), codeOutput: JSON.parse(JSON.stringify(r.codeOutput)) as CodeOutputReport };
  }
  return out;
}

export function buildAnalyticsSnapshot(source: AnalyticsSnapshotSource, meta: AnalyticsSnapshotMeta): AnalyticsSnapshot {
  const days: Record<string, UsageDay> = {};
  for (const [date, day] of Object.entries(source.days)) days[date] = projectDay(day);
  return {
    schemaVersion: ANALYTICS_SNAPSHOT_SCHEMA,
    generatedAt: meta.generatedAt,
    appVersion: meta.appVersion,
    platform: meta.platform,
    days,
    sessions: source.sessions.map(projectSession),
    tools: toolMap(source.tools),
    modelTools: nestedToolMap(source.modelTools),
    harnessTools: nestedToolMap(source.harnessTools),
    harnessModelTools: nestedToolMap(source.harnessModelTools),
    reports: projectReports(source.reports)
  };
}

// ---------------------------------------------------------------------------------------------
// Parts

export interface SnapshotPart {
  id: string;
  json: string;
}

function monthOf(ts: number): string {
  return new Date(Number.isFinite(ts) ? ts : 0).toISOString().slice(0, 7);
}

/** Splits a snapshot into its parts, in a stable order with stable JSON so unchanged parts hash the same. */
export function partitionSnapshot(snapshot: AnalyticsSnapshot): SnapshotPart[] {
  const dayMonths = new Map<string, Record<string, UsageDay>>();
  for (const date of Object.keys(snapshot.days).sort()) {
    const month = date.slice(0, 7);
    const bucket = dayMonths.get(month) ?? {};
    bucket[date] = snapshot.days[date];
    dayMonths.set(month, bucket);
  }
  const sessionMonths = new Map<string, UsageSessionRecord[]>();
  for (const s of [...snapshot.sessions].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    const month = monthOf(s.createdAt);
    const bucket = sessionMonths.get(month) ?? [];
    bucket.push(s);
    sessionMonths.set(month, bucket);
  }
  const parts: SnapshotPart[] = [];
  for (const [month, days] of [...dayMonths].sort(([a], [b]) => a.localeCompare(b))) parts.push({ id: `days.${month}`, json: JSON.stringify(days) });
  for (const [month, sessions] of [...sessionMonths].sort(([a], [b]) => a.localeCompare(b))) parts.push({ id: `sessions.${month}`, json: JSON.stringify(sessions) });
  const tools: SnapshotToolMaps = { tools: snapshot.tools, modelTools: snapshot.modelTools, harnessTools: snapshot.harnessTools, harnessModelTools: snapshot.harnessModelTools };
  parts.push({ id: 'tools', json: JSON.stringify(tools) });
  parts.push({ id: 'reports', json: JSON.stringify(snapshot.reports) });
  return parts;
}

export class SnapshotAssemblyError extends Error {}

/** Reassembles a snapshot from its manifest and the JSON text of every part it lists. */
export function assembleSnapshot(manifest: AnalyticsSnapshotManifest, parts: ReadonlyMap<string, string>): AnalyticsSnapshot {
  if (manifest.schemaVersion !== ANALYTICS_SNAPSHOT_SCHEMA) throw new SnapshotAssemblyError(`unsupported snapshot schema ${manifest.schemaVersion}`);
  const snapshot: AnalyticsSnapshot = {
    schemaVersion: manifest.schemaVersion,
    generatedAt: manifest.generatedAt,
    appVersion: manifest.appVersion,
    platform: manifest.platform,
    days: {},
    sessions: [],
    tools: {},
    modelTools: {},
    harnessTools: {},
    harnessModelTools: {},
    reports: {}
  };
  for (const ref of manifest.parts) {
    const json = parts.get(ref.id);
    if (json === undefined) throw new SnapshotAssemblyError(`missing part ${ref.id}`);
    const value: unknown = JSON.parse(json);
    if (ref.id.startsWith('days.')) Object.assign(snapshot.days, value as Record<string, UsageDay>);
    else if (ref.id.startsWith('sessions.')) snapshot.sessions.push(...(value as UsageSessionRecord[]));
    else if (ref.id === 'tools') Object.assign(snapshot, value as SnapshotToolMaps);
    else if (ref.id === 'reports') snapshot.reports = value as Record<string, SnapshotReports>;
    else throw new SnapshotAssemblyError(`unknown part ${ref.id}`);
  }
  return snapshot;
}

/** Adds one tool map into another; used when combining computers. */
export function addToolMap(into: Record<string, ToolUsage>, from: Record<string, ToolUsage>): void {
  for (const [name, usage] of Object.entries(from)) addToolUsage((into[name] ??= emptyToolUsage()), usage);
}
