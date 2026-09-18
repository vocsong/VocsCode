/**
 * Code-output efficiency: the lines an agent wrote per million tokens it spent, and what those lines
 * cost. The fun stat, and the one that says which harness and model turn spend into code.
 *
 * The turn is the unit, because it is the only place both halves exist: a harness reports what a turn
 * spent, and the lines are the ones that turn's file-changing calls added (see lines.ts). A turn
 * counts only when the agent actually wrote code — a turn spent answering a question wrote no line,
 * so its tokens belong to no rate here — and only when the harness reported what it spent, so an
 * unmeasured turn can never pass for a free one. Everything left out is counted in `coverage`.
 *
 * Tokens are the session's, so they cannot be split between the parent agent and its subagents; the
 * lines can, and `delegatedLines` reports that share rather than subtracting it. Pure and
 * deterministic: the same records always give the same report.
 */
import { isExecution, usageTokens, type ExecutionRecord, type TurnRecord, type TurnUsageFacts } from './records';
import { utcDayOf } from './reliability';

export type CodeConfidence = 'insufficient' | 'very_low' | 'low' | 'ok';

/** Counted turns a group needs before its rate is worth reading: below these it is one project's luck. */
export const CODE_SAMPLE_BANDS: { max: number; confidence: CodeConfidence }[] = [
  { max: 3, confidence: 'insufficient' },
  { max: 10, confidence: 'very_low' },
  { max: 30, confidence: 'low' }
];

export function codeConfidence(turns: number): CodeConfidence {
  for (const b of CODE_SAMPLE_BANDS) if (turns < b.max) return b.confidence;
  return 'ok';
}

export interface CodeOutputRow {
  key: string;
  label: string;
  /** Turns that wrote code and reported what they spent: the only turns behind every number below. */
  turns: number;
  sessions: number;
  /** Lines added across `turns`. */
  lines: number;
  /** Lines among `lines` written by subagent calls; parents' calls are the rest. */
  delegatedLines: number;
  /** Tokens `turns` spent — every counter, reasoning excluded because it is billed inside output. */
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Lines per million tokens: the headline. Null when the group has no counted turn. */
  linesPerMTokens: number | null;
  /** Dollars per 1000 lines written; null when nothing was written or no cost was ever reported. */
  costPerKLine: number | null;
  /** Whether any counted turn reported a cost at all — without it, `costPerKLine` claims nothing. */
  costMeasured: boolean;
  confidence: CodeConfidence;
}

export interface CodeTrendPoint {
  date: string;
  turns: number;
  lines: number;
  tokens: number;
  costUsd: number;
  /** Lines per million tokens that day; null on a day with no counted turn. */
  linesPerMTokens: number | null;
}

/** What the report saw and what it had to leave out; every turn lands in exactly one bucket. */
export interface CodeCoverage {
  rangeDays: number;
  /** In-range turns, whatever they did. */
  turns: number;
  /** Turns behind every rate: wrote code and reported spend. */
  countedTurns: number;
  /** Turns that reported spend without writing a line (questions, reads, answers). */
  noCodeTurns: number;
  noCodeTokens: number;
  /** Turns that wrote code but reported no spend, so there is nothing to divide their lines by. */
  unmeasuredTurns: number;
  unmeasuredLines: number;
  /** Turns whose file changes arrived without a diff, so what they wrote is unknown (Cursor's). */
  unknownLineTurns: number;
  unknownLineCalls: number;
  /** Execution calls the log holds outside any in-range turn (before the first user message). */
  unattachedCalls: number;
  unattachedLines: number;
  lines: number;
  tokens: number;
  costUsd: number;
  sessions: number;
  firstTs?: number;
  lastTs?: number;
  retention: { maxRecords: number; maxDays: number };
  /** True when the retained log starts after the requested range does. */
  truncated: boolean;
}

export interface CodeOutputReport {
  schemaVersion: number;
  coverage: CodeCoverage;
  overall: CodeOutputRow;
  byHarness: CodeOutputRow[];
  byModel: CodeOutputRow[];
  byHarnessModel: CodeOutputRow[];
  trend: CodeTrendPoint[];
}

export interface CodeOutputOptions {
  now: number;
  /** Days back from now to include; 0 = every retained record. */
  rangeDays: number;
  retention: { maxRecords: number; maxDays: number };
  /** Start of the retained log (before range filtering), for the truncation note. */
  retainedFirstTs?: number;
}

const DAY_MS = 86_400_000;

/** One in-range turn with the lines its calls added. */
interface TurnFacts {
  turn: TurnRecord;
  /** Undefined when a file change arrived without a diff: what the turn wrote cannot be read. */
  lines: number | undefined;
  delegatedLines: number;
  tokens: number;
  usage?: TurnUsageFacts;
}

interface Group {
  key: string;
  label: string;
  turns: number;
  sessions: Set<string>;
  lines: number;
  delegatedLines: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costMeasured: boolean;
}

function emptyGroup(key: string, label: string): Group {
  return { key, label, turns: 0, sessions: new Set(), lines: 0, delegatedLines: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costMeasured: false };
}

function rowOf(g: Group): CodeOutputRow {
  const costPerKLine = g.costMeasured && g.lines > 0 ? (g.costUsd / g.lines) * 1000 : null;
  return {
    key: g.key,
    label: g.label,
    turns: g.turns,
    sessions: g.sessions.size,
    lines: g.lines,
    delegatedLines: g.delegatedLines,
    tokens: g.tokens,
    inputTokens: g.inputTokens,
    outputTokens: g.outputTokens,
    cacheReadTokens: g.cacheReadTokens,
    cacheWriteTokens: g.cacheWriteTokens,
    costUsd: g.costUsd,
    linesPerMTokens: g.tokens > 0 && g.turns > 0 ? (g.lines / g.tokens) * 1_000_000 : null,
    costPerKLine,
    costMeasured: g.costMeasured,
    confidence: codeConfidence(g.turns)
  };
}

/** Adds one counted turn to a group; the caller has already decided it belongs there. */
function addTurn(g: Group, f: TurnFacts): void {
  g.turns += 1;
  g.sessions.add(f.turn.sessionId);
  g.lines += f.lines ?? 0;
  g.delegatedLines += f.delegatedLines;
  g.tokens += f.tokens;
  const u = f.usage;
  if (!u) return;
  g.inputTokens += u.inputTokens;
  g.outputTokens += u.outputTokens;
  g.cacheReadTokens += u.cacheReadTokens;
  g.cacheWriteTokens += u.cacheWriteTokens;
  if (u.costUsd > 0) g.costMeasured = true;
  g.costUsd += u.costUsd;
}

/** Pairs the in-range turns with the lines their own calls added. */
function factsOf(turns: TurnRecord[], records: ExecutionRecord[]): { facts: TurnFacts[]; unattachedCalls: number; unattachedLines: number } {
  const byTurnId = new Map<string, TurnFacts>();
  const facts: TurnFacts[] = [];
  for (const turn of turns) {
    const f: TurnFacts = { turn, lines: 0, delegatedLines: 0, tokens: turn.usage ? usageTokens(turn.usage) : 0, usage: turn.usage };
    facts.push(f);
    byTurnId.set(turn.id, f);
  }
  let unattachedCalls = 0;
  let unattachedLines = 0;
  for (const r of records) {
    // Delegated-run summaries carry a call count, not lines: they are volume, not executions.
    if (!isExecution(r)) continue;
    const f = byTurnId.get(`${r.sessionId}:turn:${r.turn}`);
    if (!f) {
      unattachedCalls += 1;
      if (r.addedLines !== undefined) unattachedLines += r.addedLines;
      continue;
    }
    if (r.addedLines === undefined) f.lines = undefined;
    else if (f.lines !== undefined) f.lines += r.addedLines;
    if (r.role === 'subagent') f.delegatedLines += r.addedLines ?? 0;
  }
  return { facts, unattachedCalls, unattachedLines };
}

function trendOf(facts: TurnFacts[], startTs: number, endTs: number): CodeTrendPoint[] {
  const byDay = new Map<string, CodeTrendPoint>();
  const point = (date: string) => {
    const p = byDay.get(date) ?? { date, turns: 0, lines: 0, tokens: 0, costUsd: 0, linesPerMTokens: null };
    byDay.set(date, p);
    return p;
  };
  for (const f of facts) {
    if (!isCounted(f)) continue;
    const p = point(utcDayOf(f.turn.startTs));
    p.turns += 1;
    p.lines += f.lines ?? 0;
    p.tokens += f.tokens;
    p.costUsd += f.usage?.costUsd ?? 0;
  }
  const out: CodeTrendPoint[] = [];
  const first = Date.parse(`${utcDayOf(startTs)}T00:00:00Z`);
  const last = Date.parse(`${utcDayOf(endTs)}T00:00:00Z`);
  for (let t = first, i = 0; t <= last && i < 731; t += DAY_MS, i++) out.push(point(utcDayOf(t)));
  for (const p of out) p.linesPerMTokens = p.tokens > 0 ? (p.lines / p.tokens) * 1_000_000 : null;
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** A turn enters the rates only if it wrote something and we can say what it spent. */
function isCounted(f: TurnFacts): boolean {
  return f.lines !== undefined && f.lines > 0 && f.tokens > 0;
}

function sortRows(rows: CodeOutputRow[]): CodeOutputRow[] {
  return rows.sort((a, b) => b.lines - a.lines || b.turns - a.turns || a.label.localeCompare(b.label));
}

function groupRows(facts: TurnFacts[], keyOf: (t: TurnRecord) => { key: string; label: string } | null): CodeOutputRow[] {
  const groups = new Map<string, Group>();
  for (const f of facts) {
    if (!isCounted(f)) continue;
    const k = keyOf(f.turn);
    if (!k) continue;
    const g = groups.get(k.key) ?? emptyGroup(k.key, k.label);
    addTurn(g, f);
    groups.set(k.key, g);
  }
  return sortRows([...groups.values()].map(rowOf));
}

/** `provider/model` keys keep their bare id when the provider is unknown, as the other tables do. */
function modelLabel(key: string): string {
  return key.startsWith('/') ? key.slice(1) : key;
}

/** Builds the code-output report for the turns in range. */
export function codeOutputReport(all: ExecutionRecord[], allTurns: TurnRecord[], opts: CodeOutputOptions): CodeOutputReport {
  const start = opts.rangeDays > 0 ? opts.now - opts.rangeDays * DAY_MS : -Infinity;
  const turns = allTurns.filter((t) => t.startTs >= start);
  const records = all.filter((r) => r.ts >= start);
  const { facts, unattachedCalls, unattachedLines } = factsOf(turns, records);

  const overall = emptyGroup('all', 'All');
  const coverage: CodeCoverage = {
    rangeDays: opts.rangeDays,
    turns: turns.length,
    countedTurns: 0,
    noCodeTurns: 0,
    noCodeTokens: 0,
    unmeasuredTurns: 0,
    unmeasuredLines: 0,
    unknownLineTurns: 0,
    unknownLineCalls: 0,
    unattachedCalls,
    unattachedLines,
    lines: 0,
    tokens: 0,
    costUsd: 0,
    sessions: 0,
    retention: opts.retention,
    truncated: opts.retainedFirstTs !== undefined && opts.rangeDays > 0 && opts.retainedFirstTs > start && all.length >= opts.retention.maxRecords
  };
  const sessions = new Set<string>();
  for (const f of facts) {
    if (isCounted(f)) {
      coverage.countedTurns += 1;
      addTurn(overall, f);
      continue;
    }
    if (f.lines === undefined) coverage.unknownLineTurns += 1;
    else if (f.lines === 0) {
      coverage.noCodeTurns += 1;
      coverage.noCodeTokens += f.tokens;
    } else {
      coverage.unmeasuredTurns += 1;
      coverage.unmeasuredLines += f.lines;
    }
  }
  for (const r of records) if (isExecution(r)) sessions.add(r.sessionId);
  coverage.lines = overall.lines;
  coverage.tokens = overall.tokens;
  coverage.costUsd = overall.costUsd;
  coverage.sessions = sessions.size;

  const tsList = facts.map((f) => f.turn.startTs);
  coverage.firstTs = tsList.length ? Math.min(...tsList) : undefined;
  coverage.lastTs = tsList.length ? Math.max(...tsList) : undefined;

  const trendStart = opts.rangeDays > 0 ? start : (coverage.firstTs ?? opts.now);
  return {
    schemaVersion: 1,
    coverage,
    overall: rowOf(overall),
    byHarness: groupRows(facts, (t) => ({ key: t.harness, label: t.harness })),
    byModel: groupRows(facts, (t) => (t.model ? { key: t.model, label: modelLabel(t.model) } : null)),
    byHarnessModel: groupRows(facts, (t) => (t.model ? { key: `${t.harness}|${t.model}`, label: `${t.harness} · ${modelLabel(t.model)}` } : null)),
    trend: trendOf(facts, Math.min(trendStart, opts.now), opts.now)
  };
}

/** A report over nothing, for stubs and loading states. */
export function emptyCodeOutputReport(now = Date.now(), rangeDays = 30): CodeOutputReport {
  return codeOutputReport([], [], { now, rangeDays, retention: { maxRecords: 0, maxDays: 0 } });
}
