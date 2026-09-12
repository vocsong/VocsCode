/** Spend: the hero figure, daily and cumulative spend, breakdowns by model/harness/project, and model rates. */
import React, { useState } from 'react';
import type { AnalyticsSummary } from '../../../../shared/types';
import { totalTokens } from '../../../../shared/usage-rollup';
import { basename, fmtCost, fmtTokens } from '../../format';
import { harnessShort } from '../Sidebar';
import { BarList, ChartCard, ColumnChart, DataTable, LineChart, Segmented, seriesTable } from './charts';
import { cumulative, delta, fmtCompact, fmtUnit, METRICS, plural, SPLITS, splitSeries, type Scope, type Split } from './model';
import { Footnotes, Hero } from './tiles';

export function SpendTab({ scope, summary }: { scope: Scope; summary: AnalyticsSummary }) {
  const [split, setSplit] = useState<Split>('model');
  const t = scope.totals;
  const dates = scope.days.map((d) => d.date);
  const daily = splitSeries(scope, split, 'cost');
  const cum = [{ key: 'cum', label: 'Cumulative spend', values: cumulative(scope.days.map((d) => d.usage.costUsd)), color: 'var(--accent)' }];
  const perTurn = t.turns ? fmtCost(t.costUsd / t.turns) : '—';
  const perSession = scope.sessionCount ? fmtCost(t.costUsd / scope.sessionCount) : '—';
  const perDay = scope.activeDays ? fmtCost(t.costUsd / scope.activeDays) : '—';
  return (
    <>
      <div className="hero-row-wrap">
        <Hero value={fmtCost(t.costUsd)} label={`Spend · ${scope.label}`} delta={delta(t.costUsd, scope.previous?.costUsd)} deltaLabel={scope.previousLabel ? `vs ${scope.previousLabel}` : undefined} sub={`${perTurn} per turn · ${perSession} per session · ${perDay} per active day`} />
        <div className="toolbar">
          <span className="muted small">Split by</span>
          <Segmented value={split} options={SPLITS} onChange={setSplit} ariaLabel="Split spend by" />
        </div>
      </div>

      <ChartCard title="Spend per day" subtitle={split === 'none' ? scope.label : `By ${split} · ${scope.label}`} table={seriesTable(dates, daily, fmtCost)} wide>
        <ColumnChart dates={dates} series={daily} format={fmtCost} axis={METRICS.cost.axis} ariaLabel="Spend per day" />
      </ChartCard>

      <ChartCard title="Cumulative spend" subtitle={`Running total · ${scope.label}`} table={seriesTable(dates, cum, fmtCost)} wide>
        <LineChart dates={dates} series={cum} format={fmtCost} axis={METRICS.cost.axis} ariaLabel="Cumulative spend" area height={170} />
      </ChartCard>

      <div className="agrid">
        <ChartCard title="By model" subtitle={scope.label}>
          <BarList rows={scope.byModel.map((b) => ({ key: b.key, label: b.label, value: b.usage.costUsd, sub: `${fmtTokens(totalTokens(b.usage))} tokens · ${plural(b.usage.turns, 'turn')} · ${plural(b.sessions, 'session')}`, title: b.key }))} format={fmtCost} />
        </ChartCard>
        <ChartCard title="By harness" subtitle={scope.label}>
          <BarList rows={scope.byHarness.map((b) => ({ key: b.key, label: harnessShort(b.key), value: b.usage.costUsd, sub: `${plural(b.usage.turns, 'turn')} · ${plural(b.sessions, 'session')}` }))} format={fmtCost} />
        </ChartCard>
        <ChartCard title="By project" subtitle={scope.label}>
          <BarList rows={scope.byProject.map((b) => ({ key: b.key, label: basename(b.label), value: b.usage.costUsd, sub: `${plural(b.usage.turns, 'turn')} · ${plural(b.sessions, 'session')}`, title: b.key }))} format={fmtCost} />
        </ChartCard>
      </div>

      <ChartCard title="Effective model rates" subtitle="All time · $/M tokens blends input, output and cache · one call is one model turn" wide>
        {summary.modelRates.length === 0 ? (
          <div className="chart-empty">No model usage recorded yet.</div>
        ) : (
          <DataTable
            table={{
              columns: [{ label: 'Model' }, { label: '$ / M tokens', numeric: true }, { label: '$ / call', numeric: true }, { label: 'Calls', numeric: true }, { label: 'Tokens', numeric: true }, { label: 'Spend', numeric: true }],
              rows: summary.modelRates.map((r) => [
                <span key="m" className="mono" title={r.key}>
                  {r.label}
                </span>,
                r.usdPerMTok != null ? fmtUnit(r.usdPerMTok) : '—',
                r.usdPerCall != null ? fmtUnit(r.usdPerCall) : '—',
                fmtCompact(r.calls),
                fmtTokens(r.tokens),
                fmtCost(r.costUsd)
              ])
            }}
          />
        )}
      </ChartCard>
      <Footnotes scope={scope} summary={summary} />
    </>
  );
}
