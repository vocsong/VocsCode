/** Overview: the headline numbers with period deltas, spend per day by model, and the top breakdowns. */
import React from 'react';
import type { AnalyticsSummary } from '../../../../shared/types';
import { speedTps, totalTokens } from '../../../../shared/usage-rollup';
import { basename, fmtCost, fmtTokens } from '../../format';
import { BarList, ChartCard, ColumnChart, seriesTable } from './charts';
import { cacheHitRate, delta, fmtCompact, fmtPct, fmtTps, METRICS, plural, splitSeries, type Scope } from './model';
import { SessionList } from './SessionsTab';
import { Footnotes, KpiGrid, StatTile } from './tiles';

export function OverviewTab({ scope, summary }: { scope: Scope; summary: AnalyticsSummary }) {
  const t = scope.totals;
  const p = scope.previous;
  const days = scope.days;
  const spark = (of: (c: typeof t) => number) => days.map((d) => of(d.usage));
  const speed = speedTps(t);
  const spendSeries = splitSeries(scope, 'model', 'cost');
  const cacheRate = cacheHitRate(t);
  return (
    <>
      <KpiGrid caption={scope.previousLabel ? `Change is against the ${scope.previousLabel}.` : undefined}>
        <StatTile label="Spend" value={fmtCost(t.costUsd)} delta={delta(t.costUsd, p?.costUsd)} spark={spark((c) => c.costUsd)} sub={t.turns ? `${fmtCost(t.costUsd / t.turns)} per turn` : undefined} />
        <StatTile label="Turns" value={fmtCompact(t.turns)} delta={delta(t.turns, p?.turns)} spark={spark((c) => c.turns)} sub={`${plural(scope.sessionCount, 'session')}`} />
        <StatTile label="Tokens" value={fmtTokens(totalTokens(t))} delta={delta(totalTokens(t), p ? totalTokens(p) : undefined)} spark={spark((c) => totalTokens(c))} sub={cacheRate !== null ? `${fmtPct(cacheRate)} served from cache` : undefined} title="Input, output and cache tokens" />
        <StatTile label="Tool calls" value={fmtCompact(t.toolCalls)} delta={delta(t.toolCalls, p?.toolCalls)} spark={spark((c) => c.toolCalls)} sub={scope.toolTotals.errors ? `${plural(scope.toolTotals.errors, 'error')}` : undefined} />
        <StatTile label="Output speed" value={fmtTps(speed)} delta={delta(speed ?? 0, p ? (speedTps(p) ?? undefined) : undefined)} upIsGood sub="tok/s incl. tool time" title="Output tokens per second of turn wall time, over completed turns that reported both" />
        <StatTile label="Active days" value={fmtCompact(scope.activeDays)} sub={days.length ? `of ${plural(days.length, 'day')}` : undefined} />
      </KpiGrid>

      <ChartCard title="Spend per day" subtitle={`By model · ${scope.label}`} table={seriesTable(days.map((d) => d.date), spendSeries, fmtCost)} wide>
        <ColumnChart dates={days.map((d) => d.date)} series={spendSeries} format={fmtCost} axis={METRICS.cost.axis} ariaLabel="Spend per day by model" />
      </ChartCard>

      <div className="agrid">
        <ChartCard title="Spend by model" subtitle={scope.label}>
          <BarList rows={scope.byModel.map((b) => ({ key: b.key, label: b.label, value: b.usage.costUsd, sub: `${plural(b.sessions, 'session')} · ${plural(b.usage.turns, 'turn')}`, title: b.key }))} format={fmtCost} limit={5} />
        </ChartCard>
        <ChartCard title="Spend by project" subtitle={scope.label}>
          <BarList rows={scope.byProject.map((b) => ({ key: b.key, label: basename(b.label), value: b.usage.costUsd, sub: `${plural(b.sessions, 'session')} · ${fmtTokens(totalTokens(b.usage))} tokens`, title: b.key }))} format={fmtCost} limit={5} />
        </ChartCard>
        <ChartCard title="Top sessions" subtitle={`By spend · ${scope.label}`}>
          <SessionList sessions={scope.sessions.slice(0, 5)} compact />
        </ChartCard>
      </div>
      <Footnotes scope={scope} summary={summary} />
    </>
  );
}
