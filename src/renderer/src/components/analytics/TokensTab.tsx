/** Provider token usage and cache hit rates, alongside a separate estimate of submitted user text. */
import React, { useState } from 'react';
import type { AnalyticsSummary, UsageBucket } from '../../../../shared/types';
import { totalTokens } from '../../../../shared/usage-rollup';
import { fmtTokens, harnessShort } from '../../format';
import { Button } from '../ui';
import { ChartCard, ColumnChart, Legend, Meter, Segmented, seriesTable, StackedBar } from './charts';
import { cacheHitRate, delta, entityColor, fmtPct, harnessColor, harnessIndex, harnessModelBuckets, harnessModelLabel, harnessModelPair, METRICS, promptTokens, SPLITS, splitSeries, TOKEN_KINDS, tokenKindSeries, type Scope, type Split } from './model';
import { Footnotes, KpiGrid, StatTile } from './tiles';

/** Rate buckets of one entity, in the order the caller ranked them, keeping what has a rate to show. */
function rated(buckets: UsageBucket[]): { bucket: UsageBucket; rate: number; prompt: number }[] {
  return buckets.flatMap((bucket) => {
    const rate = cacheHitRate(bucket.usage);
    return rate === null ? [] : [{ bucket, rate, prompt: promptTokens(bucket.usage) }];
  });
}

/** One meter per rated entity; `sub` always shows the numerator and denominator behind the rate. */
function RateMeters({ rows, label, color, empty }: { rows: { bucket: UsageBucket; rate: number; prompt: number }[]; label: (bucket: UsageBucket) => string; color: (bucket: UsageBucket) => string; empty: string }) {
  if (rows.length === 0) return <div className="chart-empty">{empty}</div>;
  return (
    <div className="meterlist">
      {rows.map(({ bucket, rate, prompt }) => (
        <Meter key={bucket.key} value={rate} label={label(bucket)} color={color(bucket)} sub={`${fmtTokens(bucket.usage.cacheReadTokens)} of ${fmtTokens(prompt)} prompt tokens`} title={bucket.key} />
      ))}
    </div>
  );
}

export function TokensTab({ scope, summary }: { scope: Scope; summary: AnalyticsSummary }) {
  const [split, setSplit] = useState<Split>('model');
  const [allPairs, setAllPairs] = useState(false);
  const t = scope.totals;
  const p = scope.previous;
  const total = totalTokens(t);
  const dates = scope.days.map((d) => d.date);
  const kinds = tokenKindSeries(scope.days);
  const userInput = scope.days.map((d) => d.usage.userInputTokens ?? 0);
  const userInputSeries = [{ key: 'userInputTokens', label: 'User input (est.)', values: userInput, color: 'var(--accent)' }];
  const bySplit = splitSeries(scope, split, 'tokens');
  const rate = cacheHitRate(t);
  const share = (n: number) => (total > 0 ? `${fmtPct(n / total)} of tokens` : undefined);
  const spark = (key: (typeof TOKEN_KINDS)[number]['key']) => scope.days.map((d) => d.usage[key]);
  const kindLegend = TOKEN_KINDS.map((k) => ({ key: k.key, label: k.label, color: k.color }));
  /** Harnesses in slot order that counted prompt tokens; the rest have no rate to show. */
  const harnessRates = rated([...scope.byHarness].sort((a, b) => harnessIndex(a.key) - harnessIndex(b.key)));
  /** Models in spend order that counted prompt tokens; the rest have no rate to show. */
  const modelRates = rated(scope.byModel).slice(0, 8);
  /** The controlled comparison: one pair per row, grouped by harness, spend order within each. */
  const pairRates = rated(harnessModelBuckets(scope));
  const shownPairs = allPairs ? pairRates : pairRates.slice(0, 12);
  return (
    <>
      <KpiGrid caption={scope.previousLabel ? `Change is against the ${scope.previousLabel}.` : undefined}>
        <StatTile label="Total tokens" value={fmtTokens(total)} delta={delta(total, p ? totalTokens(p) : undefined)} spark={scope.days.map((d) => totalTokens(d.usage))} sub="provider input + output + cache" />
        <StatTile label="User input (est.)" value={fmtTokens(t.userInputTokens)} delta={delta(t.userInputTokens ?? 0, p?.userInputTokens)} spark={userInput} sub="counted once · separate from provider totals" />
        <StatTile label="Input" value={fmtTokens(t.inputTokens)} delta={delta(t.inputTokens, p?.inputTokens)} spark={spark('inputTokens')} sub="provider-reported uncached context" title="Provider-reported uncached context, not just typed text." />
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

      <div className="agrid agrid-2">
        <ChartCard title="Cache hit rate by harness" subtitle={`Share of each harness's prompt tokens served from cache · ${scope.label}`}>
          <RateMeters rows={harnessRates} label={(b) => harnessShort(b.key)} color={(b) => harnessColor(b.key)} empty="No harness usage recorded yet." />
        </ChartCard>
        <ChartCard title="Cache hit rate by model" subtitle={`Share of each model's prompt tokens served from cache · ${scope.label}`}>
          <RateMeters rows={modelRates} label={(b) => b.label} color={(b) => entityColor(scope, 'model', b.key)} empty="No model usage recorded yet." />
        </ChartCard>
      </div>

      <ChartCard
        title="Cache hit rate by harness × model"
        subtitle={`One pair per row, the controlled comparison · ${scope.label}`}
        actions={pairRates.length > 12 ? <Button variant="ghost" size="sm" onClick={() => setAllPairs((v) => !v)}>{allPairs ? 'Show top 12' : `Show all ${pairRates.length}`}</Button> : undefined}
        wide
      >
        <RateMeters rows={shownPairs} label={(b) => harnessModelLabel(b.key)} color={(b) => harnessColor(harnessModelPair(b.key).harness)} empty="No harness × model usage recorded yet." />
        {pairRates.length > 0 && <p className="muted small">Recorded since update; older days a harness split across several models have no pair to show. The pair is the controlled comparison: a harness across its own models, or two harnesses on the same one.</p>}
      </ChartCard>

      <ChartCard title="User input per day (est.)" subtitle={`Ordinary-session message text, counted once · ${scope.label} · UTC days`} table={seriesTable(dates, userInputSeries, fmtTokens)} wide>
        <ColumnChart dates={dates} series={userInputSeries} format={fmtTokens} integer ariaLabel="User input per day (est.)" emptyText="No ordinary-session message text tracked in this range yet." />
      </ChartCard>

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
      <Footnotes scope={scope} summary={summary} extra={[
        'Input is provider-reported uncached context, not just typed text.',
        'User input (est.) tracks ordinary-session message text: original submitted text is counted once, including pasted text. It excludes attachments, system/context content, tool output and automated prompts (including automatic goal prompts).',
        'Mission mailbox input, goal configuration fields and subagent-panel steering are not tracked. This rough estimate uses one token per four Unicode characters, not model-specific billing, and is separate from provider token totals and mixes.',
        'User input tracking starts with this update; legacy unmarked messages are not reconstructed.'
      ]} />
    </>
  );
}
