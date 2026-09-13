/** Tokens: the mix of input, output and cache, the cache hit rate, and how each model uses tokens. */
import React, { useState } from 'react';
import type { AnalyticsSummary } from '../../../../shared/types';
import { totalTokens } from '../../../../shared/usage-rollup';
import { fmtTokens } from '../../format';
import { ChartCard, ColumnChart, Legend, Meter, Segmented, seriesTable, StackedBar } from './charts';
import { cacheHitRate, delta, fmtPct, METRICS, SPLITS, splitSeries, TOKEN_KINDS, tokenKindSeries, type Scope, type Split } from './model';
import { Footnotes, KpiGrid, StatTile } from './tiles';

export function TokensTab({ scope, summary }: { scope: Scope; summary: AnalyticsSummary }) {
  const [split, setSplit] = useState<Split>('model');
  const t = scope.totals;
  const p = scope.previous;
  const total = totalTokens(t);
  const dates = scope.days.map((d) => d.date);
  const kinds = tokenKindSeries(scope.days);
  const bySplit = splitSeries(scope, split, 'tokens');
  const rate = cacheHitRate(t);
  const share = (n: number) => (total > 0 ? `${fmtPct(n / total)} of tokens` : undefined);
  const spark = (key: (typeof TOKEN_KINDS)[number]['key']) => scope.days.map((d) => d.usage[key]);
  const kindLegend = TOKEN_KINDS.map((k) => ({ key: k.key, label: k.label, color: k.color }));
  return (
    <>
      <KpiGrid caption={scope.previousLabel ? `Change is against the ${scope.previousLabel}.` : undefined}>
        <StatTile label="Total tokens" value={fmtTokens(total)} delta={delta(total, p ? totalTokens(p) : undefined)} spark={scope.days.map((d) => totalTokens(d.usage))} sub="input + output + cache" />
        <StatTile label="Input" value={fmtTokens(t.inputTokens)} delta={delta(t.inputTokens, p?.inputTokens)} spark={spark('inputTokens')} sub={share(t.inputTokens)} />
        <StatTile label="Output" value={fmtTokens(t.outputTokens)} delta={delta(t.outputTokens, p?.outputTokens)} spark={spark('outputTokens')} sub={share(t.outputTokens)} />
        <StatTile label="Cache read" value={fmtTokens(t.cacheReadTokens)} delta={delta(t.cacheReadTokens, p?.cacheReadTokens)} spark={spark('cacheReadTokens')} sub={share(t.cacheReadTokens)} />
        <StatTile label="Cache write" value={fmtTokens(t.cacheWriteTokens)} delta={delta(t.cacheWriteTokens, p?.cacheWriteTokens)} spark={spark('cacheWriteTokens')} sub={share(t.cacheWriteTokens)} />
        {t.reasoningTokens > 0 && <StatTile label="Reasoning" value={fmtTokens(t.reasoningTokens)} delta={delta(t.reasoningTokens, p?.reasoningTokens)} sub="counted inside output" />}
      </KpiGrid>

      <div className="agrid agrid-meter">
        <ChartCard title="Cache hit rate" subtitle="Share of prompt tokens the provider served from its cache">
          <Meter value={rate} label="Cache read ÷ (input + cache read + cache write)" sub={rate === null ? 'No prompt tokens counted yet.' : `${fmtTokens(t.cacheReadTokens)} of ${fmtTokens(t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens)} prompt tokens`} />
        </ChartCard>
        <ChartCard title="Output share" subtitle="Output tokens as a share of everything the model processed">
          <Meter value={total > 0 ? t.outputTokens / total : null} label="Output ÷ total" sub={total > 0 ? `${fmtTokens(t.outputTokens)} of ${fmtTokens(total)} tokens` : 'No tokens counted yet.'} />
        </ChartCard>
      </div>

      <ChartCard title="Tokens per day by kind" subtitle="Click a legend entry to hide a kind — cache reads usually dwarf the rest" table={seriesTable(dates, kinds, fmtTokens)} wide>
        <ColumnChart dates={dates} series={kinds} format={fmtTokens} axis={METRICS.tokens.axis} ariaLabel="Tokens per day by kind" />
      </ChartCard>

      <ChartCard
        title="Tokens per day"
        subtitle={split === 'none' ? scope.label : `By ${split} · ${scope.label}`}
        actions={<Segmented value={split} options={SPLITS} onChange={setSplit} ariaLabel="Split tokens by" />}
        table={seriesTable(dates, bySplit, fmtTokens)}
        wide
      >
        <ColumnChart dates={dates} series={bySplit} format={fmtTokens} axis={METRICS.tokens.axis} ariaLabel="Tokens per day" />
      </ChartCard>

      <ChartCard title="Token mix by model" subtitle={`Input, output and cache per model · ${scope.label}`} wide>
        {scope.byModel.length === 0 ? (
          <div className="chart-empty">No model usage recorded yet.</div>
        ) : (
          <>
            <Legend items={kindLegend} />
            <div className="mixrows">
              {scope.byModel.slice(0, 8).map((b) => (
                <div key={b.key} className="mixrow" title={b.key}>
                  <span className="mixrow-label">{b.label}</span>
                  <StackedBar segments={TOKEN_KINDS.map((k) => ({ key: k.key, label: k.label, value: b.usage[k.key], color: k.color }))} format={fmtTokens} legend={false} title={`${b.label} token mix`} />
                  <span className="mixrow-value">{fmtTokens(totalTokens(b.usage))}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </ChartCard>
      <Footnotes scope={scope} summary={summary} />
    </>
  );
}
