/** Activity: turns, agent time and output speed over the range, plus a calendar of busy days. */
import React, { useState } from 'react';
import type { AnalyticsSummary } from '../../../../shared/types';
import { speedTps } from '../../../../shared/usage-rollup';
import { harnessShort } from '../Sidebar';
import { BarList, ChartCard, ColumnChart, Heatmap, LineChart, Segmented, seriesTable } from './charts';
import { delta, fmtCompact, fmtMs, fmtTps, METRICS, plural, speedSeries, SPLITS, splitSeries, type Scope, type Split } from './model';
import { Footnotes, KpiGrid, StatTile } from './tiles';

export function ActivityTab({ scope, summary }: { scope: Scope; summary: AnalyticsSummary }) {
  const [split, setSplit] = useState<Split>('none');
  const t = scope.totals;
  const p = scope.previous;
  const dates = scope.days.map((d) => d.date);
  const turns = splitSeries(scope, split, 'turns');
  const time = splitSeries(scope, split, 'duration');
  const speed = speedSeries(scope, split);
  const tps = speedTps(t);
  const avgTurn = t.turns > 0 ? t.durationMs / t.turns : 0;
  const prevAvgTurn = p && p.turns > 0 ? p.durationMs / p.turns : undefined;
  const speedRows = (buckets: Scope['byModel'], label: (key: string, l: string) => string) =>
    buckets
      .map((b) => ({ key: b.key, label: label(b.key, b.label), value: speedTps(b.speed) ?? 0, sub: `${plural(b.usage.turns, 'turn')}`, title: b.key }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);
  return (
    <>
      <KpiGrid caption={scope.previousLabel ? `Change is against the ${scope.previousLabel}.` : undefined}>
        <StatTile label="Turns" value={fmtCompact(t.turns)} delta={delta(t.turns, p?.turns)} spark={scope.days.map((d) => d.usage.turns)} sub={`${plural(scope.sessionCount, 'session')}`} />
        <StatTile label="Agent time" value={fmtMs(t.durationMs)} delta={delta(t.durationMs, p?.durationMs)} spark={scope.days.map((d) => d.usage.durationMs)} sub="completed-turn wall time" />
        <StatTile label="Avg turn" value={fmtMs(avgTurn)} delta={delta(avgTurn, prevAvgTurn)} sub="wall time per completed turn" />
        <StatTile label="Output speed" value={fmtTps(tps)} delta={delta(tps ?? 0, p ? (speedTps(p) ?? undefined) : undefined)} upIsGood sub="tok/s incl. tool time" title="Output tokens per second of turn wall time, over completed turns that reported both" />
        <StatTile label="Active days" value={fmtCompact(scope.activeDays)} sub={dates.length ? `of ${plural(dates.length, 'day')}` : undefined} />
        <StatTile label="Tool calls / turn" value={t.turns > 0 ? (t.toolCalls / t.turns).toFixed(1) : '—'} delta={delta(t.turns > 0 ? t.toolCalls / t.turns : 0, p && p.turns > 0 ? p.toolCalls / p.turns : undefined)} sub={`${fmtCompact(t.toolCalls)} calls`} />
      </KpiGrid>

      <div className="toolbar">
        <span className="muted small">Split by</span>
        <Segmented value={split} options={SPLITS} onChange={setSplit} ariaLabel="Split activity by" />
      </div>

      <ChartCard title="Turns per day" subtitle={split === 'none' ? scope.label : `By ${split} · ${scope.label}`} table={seriesTable(dates, turns, fmtCompact)} wide>
        <ColumnChart dates={dates} series={turns} format={fmtCompact} ariaLabel="Turns per day" integer />
      </ChartCard>

      <ChartCard title="Output speed per day" subtitle="Output tokens per second of turn wall time, including tool execution · gaps are days without a sample" table={seriesTable(dates, speed, fmtTps)} wide>
        <LineChart dates={dates} series={speed} format={fmtTps} axis={(v) => fmtCompact(v)} ariaLabel="Output speed per day" area={split === 'none'} />
      </ChartCard>

      <ChartCard title="Agent time per day" subtitle={split === 'none' ? scope.label : `By ${split} · ${scope.label}`} table={seriesTable(dates, time, fmtMs)} wide>
        <ColumnChart dates={dates} series={time} format={fmtMs} axis={METRICS.duration.axis} ariaLabel="Agent time per day" />
      </ChartCard>

      {dates.length > 7 && (
        <ChartCard title="Activity calendar" subtitle="Turns per day · darker is busier" wide>
          <Heatmap dates={dates} values={scope.days.map((d) => d.usage.turns)} format={(v) => plural(v, 'turn')} ariaLabel="Turns per day calendar" />
        </ChartCard>
      )}

      <div className="agrid">
        <ChartCard title="Speed by model" subtitle="Average over sampled turns">
          <BarList rows={speedRows(scope.byModel, (_k, l) => l)} format={fmtTps} share={false} emptyText="No speed samples yet." />
        </ChartCard>
        <ChartCard title="Speed by harness" subtitle="Average over sampled turns">
          <BarList rows={speedRows(scope.byHarness, (k) => harnessShort(k))} format={fmtTps} share={false} emptyText="No speed samples yet." />
        </ChartCard>
      </div>
      <Footnotes scope={scope} summary={summary} extra={['Speed samples pair a completed turn’s output tokens with its wall time; harnesses that report no token counts (ACP agents) contribute turns but no speed.']} />
    </>
  );
}
