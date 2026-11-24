/**
 * The usage half of an analytics summary, built from day buckets, session records and tool maps.
 * Shared by the desktop's analytics store and the web dashboard, which summarizes snapshots
 * uploaded by several computers. Keep this file free of Node/Electron/DOM imports.
 */
import type {
  AnalyticsDayPoint,
  FileUsage,
  FileUsageRow,
  HarnessModelToolRow,
  ModelRateRow,
  ModelToolRow,
  ToolUsage,
  ToolUsageRow,
  UsageBucket,
  UsageCounters,
  UsageDay,
  UsageSessionRecord,
  UsageSpeed,
  UsageTotals
} from '../usage-types';
import type { AnalyticsSummary } from './summary';
import { modelKeyLabel } from '../model-names';
import { addCounters, addToolUsage, emptyCounters, emptyToolUsage, harnessModelKey, harnessModelToolUsageRows, harnessToolUsageRows, modelToolUsageRows, toolUsageRows } from '../usage-rollup';

/** The usage half of a summary; the desktop adds the reports built from its execution log. */
export type UsageSummary = Omit<AnalyticsSummary, 'reliability' | 'codeOutput'>;

const EMPTY_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

export function emptySpeed(): UsageSpeed {
  return { tokens: 0, ms: 0 };
}

export function addSpeed(into: UsageSpeed, from: UsageSpeed | undefined): void {
  if (!from) return;
  into.tokens += from.tokens;
  into.ms += from.ms;
}

/** UTC calendar day for a timestamp, e.g. '2025-06-07'. */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function addTotals(into: UsageTotals, from: UsageTotals): void {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  into.reasoningTokens += from.reasoningTokens;
  into.costUsd += from.costUsd;
  into.turns += from.turns;
}

export function summarize(sessions: UsageSessionRecord[], dayMap: Record<string, UsageDay>, tools: Record<string, ToolUsage>, modelTools: Record<string, Record<string, ToolUsage>>, harnessModelTools: Record<string, Record<string, ToolUsage>>, files: Record<string, FileUsage>, dayLimit: number, now: number, harnessTools: Record<string, Record<string, ToolUsage>> = {}): UsageSummary {
  const seed = (): UsageTotals => ({ ...EMPTY_USAGE });
  const sessionTotals = sessions.reduce<UsageTotals>((acc, s) => {
    addTotals(acc, s.usage);
    return acc;
  }, seed());
  const dayTotals = Object.values(dayMap).reduce<UsageTotals>((acc, d) => {
    addTotals(acc, d);
    return acc;
  }, seed());
  // Day buckets never subtract (counter resets are clamped), while session records always carry the
  // latest cumulative totals; the larger of the two is the best estimate of all-time usage.
  const totals = {
    inputTokens: Math.max(sessionTotals.inputTokens, dayTotals.inputTokens),
    outputTokens: Math.max(sessionTotals.outputTokens, dayTotals.outputTokens),
    cacheReadTokens: Math.max(sessionTotals.cacheReadTokens, dayTotals.cacheReadTokens),
    cacheWriteTokens: Math.max(sessionTotals.cacheWriteTokens, dayTotals.cacheWriteTokens),
    reasoningTokens: Math.max(sessionTotals.reasoningTokens, dayTotals.reasoningTokens),
    costUsd: Math.max(sessionTotals.costUsd, dayTotals.costUsd),
    turns: Math.max(sessionTotals.turns, dayTotals.turns)
  };

  // The range is the last `dayLimit` calendar days including today: the days after the cutoff day.
  const cutoff = dayLimit > 0 ? dayKey(now - dayLimit * 86_400_000) : '';
  const days: AnalyticsDayPoint[] = Object.entries(dayMap)
    .filter(([date]) => !cutoff || date > cutoff)
    .map(([date, usage]) => ({ date, usage }))
    .sort((a, b) => a.date.localeCompare(b.date));
  // The window of equal length just before the range, so the dashboard can show period-over-period deltas.
  let previous: UsageCounters | undefined;
  if (dayLimit > 0) {
    const prevCutoff = dayKey(now - 2 * dayLimit * 86_400_000);
    previous = emptyCounters();
    for (const [date, usage] of Object.entries(dayMap)) if (date > prevCutoff && date <= cutoff) addCounters(previous, usage);
  }

  const rollup = (key: (s: UsageSessionRecord) => { key: string; label: string } | null): UsageBucket[] => {
    const map = new Map<string, UsageBucket>();
    for (const s of sessions) {
      const k = key(s);
      if (!k) continue;
      const b = map.get(k.key) ?? { key: k.key, label: k.label, usage: { ...EMPTY_USAGE }, toolCalls: 0, durationMs: 0, sessions: 0, speed: emptySpeed() };
      addTotals(b.usage, s.usage);
      b.toolCalls += s.toolCalls;
      b.durationMs += s.durationMs ?? 0;
      addSpeed(b.speed, s.speed);
      b.sessions += 1;
      map.set(k.key, b);
    }
    return [...map.values()].sort((a, b) => b.usage.costUsd - a.usage.costUsd || b.usage.turns - a.usage.turns);
  };

  const byHarness = rollup((s) => ({ key: s.harness, label: s.harness }));
  const byModel = rollup((s) => {
    if (!s.model) return null;
    const key = `${s.provider ?? ''}/${s.model}`;
    return { key, label: modelKeyLabel(key) };
  });
  const byHarnessModel = rollup((s) => {
    if (!s.model) return null;
    const key = `${s.provider ?? ''}/${s.model}`;
    return { key: harnessModelKey(s.harness, key), label: modelKeyLabel(key) };
  });
  const byProject = rollup((s) => ({ key: s.projectRoot, label: s.projectRoot }));
  // Effective rates per model: blended $/M tokens across input, output and cache, and $/call where
  // one call is one model turn. Rates stay undefined while the denominator was never measured.
  const modelRates: ModelRateRow[] = byModel.map((b) => {
    const tokens = b.usage.inputTokens + b.usage.outputTokens + b.usage.cacheReadTokens + b.usage.cacheWriteTokens;
    return {
      key: b.key,
      label: b.label,
      usdPerMTok: tokens > 0 ? (b.usage.costUsd / tokens) * 1_000_000 : undefined,
      usdPerCall: b.usage.turns > 0 ? b.usage.costUsd / b.usage.turns : undefined,
      costUsd: b.usage.costUsd,
      tokens,
      calls: b.usage.turns
    };
  });

  const toolRows: ToolUsageRow[] = toolUsageRows(tools);
  const modelToolRows: ModelToolRow[] = modelToolUsageRows(modelTools);
  const harnessModelToolRows: HarnessModelToolRow[] = harnessModelToolUsageRows(harnessModelTools);
  const toolTotals: ToolUsage = Object.values(tools).reduce<ToolUsage>((acc, t) => {
    addToolUsage(acc, t);
    return acc;
  }, emptyToolUsage());
  // Day buckets also count calls; keep all-time call totals consistent with the other totals.
  const dayToolCalls = Object.values(dayMap).reduce((acc, d) => acc + d.toolCalls, 0);
  const sessionToolCalls = sessions.reduce((acc, s) => acc + s.toolCalls, 0);
  toolTotals.calls = Math.max(toolTotals.calls, dayToolCalls, sessionToolCalls);

  const fileRows: FileUsageRow[] = Object.entries(files)
    .map(([path, f]) => ({ path, ...f, total: f.adds + f.updates + f.deletes + f.renames }))
    .filter((f) => f.total > 0)
    .sort((a, b) => b.total - a.total || a.path.localeCompare(b.path));

  const sortedSessions = [...sessions].sort((a, b) => b.usage.costUsd - a.usage.costUsd || b.usage.turns - a.usage.turns || b.updatedAt - a.updatedAt);
  const dayList = Object.keys(dayMap).sort();
  // Speed samples are add-only in both places; day buckets also cover sessions recorded before
  // per-session speed existed, so they are the all-time source.
  const speed = Object.values(dayMap).reduce<UsageSpeed>((acc, d) => {
    addSpeed(acc, { tokens: d.speedTokens, ms: d.speedMs });
    return acc;
  }, emptySpeed());

  return {
    totals,
    speed,
    days,
    previous,
    byHarness,
    byModel,
    byHarnessModel,
    byProject,
    modelRates,
    toolTotals,
    tools: toolRows,
    modelTools: modelToolRows,
    harnessTools: harnessToolUsageRows(harnessTools),
    harnessModelTools: harnessModelToolRows,
    files: fileRows,
    sessions: sortedSessions,
    sessionCount: sessions.length,
    activeDays: dayList.length,
    firstDay: dayList[0]
  };
}
