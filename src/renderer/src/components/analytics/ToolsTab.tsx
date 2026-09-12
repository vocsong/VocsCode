/** Tools & files: call volume and reliability per tool, and the files the agents touched most. */
import React, { useState } from 'react';
import type { AnalyticsSummary, ModelToolRow } from '../../../../shared/types';
import { Button } from '../ui';
import { BarList, ChartCard, ColumnChart, DataTable, Legend, Meter, Segmented, seriesTable, StackedBar } from './charts';
import { delta, FILE_KINDS, fmtCompact, fmtMs, fmtPct, plural, SPLITS, splitSeries, type Scope, type Split } from './model';
import { Footnotes, KpiGrid, StatTile } from './tiles';

/** Error-rate cell tone: red past the red flag, amber past the amber one, plain below. */
function rateTone(rate: number): string | undefined {
  if (rate > 0.15) return 'var(--red)';
  if (rate > 0.05) return 'var(--amber)';
  return undefined;
}

interface RateCell {
  calls: number;
  errors: number;
}

/** Groups the per-model tool rows into a matrix: one row per tool, one column per model. */
function errorRateTable(modelTools: ModelToolRow[]): { columns: { label: string; numeric?: boolean }[]; rows: React.ReactNode[][] } | null {
  const models = new Map<string, RateCell & { label: string }>();
  for (const r of modelTools) {
    const m = models.get(r.key) ?? { label: r.label || r.key, calls: 0, errors: 0 };
    m.calls += r.calls;
    m.errors += r.errors;
    models.set(r.key, m);
  }
  if (models.size === 0) return null;
  // Top models by call volume, the rest folded into one column so the table stays readable.
  const ranked = [...models.entries()].sort((a, b) => b[1].calls - a[1].calls || a[1].label.localeCompare(b[1].label));
  const cols = [...ranked.slice(0, 6).map(([key, m]) => ({ key, label: m.label }))];
  if (ranked.length > 6) cols.push({ key: '__other', label: `Other (${ranked.length - 6})` });
  const perModel = new Map<string, Map<string, ModelToolRow>>();
  for (const r of modelTools) {
    if (!cols.some((c) => c.key === r.key)) continue;
    const m = perModel.get(r.key) ?? new Map<string, ModelToolRow>();
    m.set(r.name, r);
    perModel.set(r.key, m);
  }
  const totals = new Map<string, RateCell>();
  for (const r of modelTools) {
    const t = totals.get(r.name) ?? { calls: 0, errors: 0 };
    t.calls += r.calls;
    t.errors += r.errors;
    totals.set(r.name, t);
  }
  const names = [...totals.entries()].sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0])).map(([n]) => n);
  const cell = (r: ModelToolRow | undefined) => {
    if (!r || !(r.calls > 0)) return { text: '—', tone: undefined, title: 'No calls' };
    const rate = r.errors / r.calls;
    return { text: `(${r.errors}/${r.calls}) ${fmtPct(rate)}`, tone: rateTone(rate), title: `${plural(r.errors, 'error')} in ${plural(r.calls, 'call')}` };
  };
  return {
    columns: [{ label: 'Tool' }, ...cols.map((c) => ({ label: c.label, numeric: true }))],
    rows: names.map((name) => [
      <span key={name} className="mono" title={name}>
        {name || '(unnamed)'}
      </span>,
      ...cols.map((c) => {
        const { text, tone, title } = cell(perModel.get(c.key)?.get(name));
        return (
          <span key={c.key} title={title} style={tone ? { color: tone } : undefined}>
            {text}
          </span>
        );
      })
    ])
  };
}

export function ToolsTab({ scope, summary }: { scope: Scope; summary: AnalyticsSummary }) {
  const [split, setSplit] = useState<Split>('none');
  const [allFiles, setAllFiles] = useState(false);
  const t = scope.totals;
  const p = scope.previous;
  const tt = scope.toolTotals;
  const dates = scope.days.map((d) => d.date);
  const calls = splitSeries(scope, split, 'toolCalls');
  const errorRate = tt.calls > 0 ? tt.errors / tt.calls : null;
  // Most harnesses report no tool timing, so the average is over the calls of tools that do.
  const timedCalls = scope.tools.filter((x) => x.durationMs > 0).reduce((a, x) => a + x.calls, 0);
  const timed = timedCalls > 0;
  const files = allFiles ? scope.files : scope.files.slice(0, 15);
  const kindLegend = FILE_KINDS.map((k) => ({ key: k.key, label: k.label, color: k.color }));
  const toolSub = (x: Scope['tools'][number]) => {
    const parts: string[] = [];
    if (x.errors) parts.push(plural(x.errors, 'error'));
    if (x.declined) parts.push(`${x.declined} declined`);
    if (x.durationMs > 0) parts.push(`avg ${fmtMs(x.durationMs / Math.max(1, x.calls))}`);
    return parts.join(' · ') || undefined;
  };
  return (
    <>
      <KpiGrid caption={scope.previousLabel ? `Change is against the ${scope.previousLabel}.` : undefined}>
        <StatTile label="Tool calls" value={fmtCompact(t.toolCalls)} delta={delta(t.toolCalls, p?.toolCalls)} spark={scope.days.map((d) => d.usage.toolCalls)} sub={t.turns ? `${(t.toolCalls / t.turns).toFixed(1)} per turn` : undefined} />
        <StatTile label="Errors" value={fmtCompact(tt.errors)} sub={errorRate !== null ? `${fmtPct(errorRate)} of calls` : undefined} />
        <StatTile label="Declined" value={fmtCompact(tt.declined)} sub="approvals you refused" />
        <StatTile label="Distinct tools" value={fmtCompact(scope.tools.length)} sub={scope.tools[0] ? `${scope.tools[0].name || '(unnamed)'} is the busiest` : undefined} />
        <StatTile label="Files touched" value={fmtCompact(scope.files.length)} sub={scope.files.length ? `${plural(scope.files.reduce((a, f) => a + f.total, 0), 'change')}` : undefined} />
        {timed && <StatTile label="Avg tool time" value={fmtMs(tt.durationMs / timedCalls)} sub={`over ${plural(timedCalls, 'timed call')}`} />}
      </KpiGrid>

      <div className="agrid agrid-meter">
        <ChartCard title="Error rate" subtitle="Calls that ended in an error">
          <Meter value={errorRate} label="Errors ÷ calls" tone={errorRate !== null && errorRate > 0.15 ? 'red' : errorRate !== null && errorRate > 0.05 ? 'amber' : 'accent'} sub={errorRate === null ? 'No tool calls recorded yet.' : `${plural(tt.errors, 'error')} in ${plural(tt.calls, 'call')}`} />
        </ChartCard>
        <ChartCard title="Tool calls per day" subtitle={split === 'none' ? scope.label : `By ${split} · ${scope.label}`} actions={<Segmented value={split} options={SPLITS} onChange={setSplit} ariaLabel="Split tool calls by" />} table={seriesTable(dates, calls, fmtCompact)} className="acard-span2">
          <ColumnChart dates={dates} series={calls} format={fmtCompact} ariaLabel="Tool calls per day" height={180} integer />
        </ChartCard>
      </div>

      <div className="agrid agrid-2">
        <ChartCard title="Calls by tool" subtitle="Names are the harness’s own, so Bash and bash are different tools">
          <BarList rows={scope.tools.map((x) => ({ key: x.name, label: x.name || '(unnamed)', value: x.calls, sub: toolSub(x) }))} format={fmtCompact} limit={10} emptyText="No tool calls recorded yet." />
        </ChartCard>
        <ChartCard title="Files changed" subtitle={`Most edited first · ${scope.label}`}>
          {scope.files.length === 0 ? (
            <div className="chart-empty">No file changes recorded yet.</div>
          ) : (
            <>
              <Legend items={kindLegend} />
              <div className="mixrows">
                {files.map((f) => (
                  <div key={f.path} className="mixrow" title={f.path}>
                    <span className="mixrow-label mono">{f.path}</span>
                    <StackedBar segments={FILE_KINDS.map((k) => ({ key: k.key, label: k.label, value: f[k.key], color: k.color }))} format={fmtCompact} legend={false} height={8} title={`${f.path} changes`} />
                    <span className="mixrow-value">{f.total}×</span>
                  </div>
                ))}
              </div>
              {scope.files.length > 15 && (
                <Button variant="ghost" size="sm" onClick={() => setAllFiles((v) => !v)}>
                  {allFiles ? 'Show fewer' : `Show all ${scope.files.length}`}
                </Button>
              )}
            </>
          )}
        </ChartCard>
      </div>
      <ChartCard title="Error rate by model" subtitle={`Errors ÷ calls for each tool, by the model that made it · ${scope.label}`}>
        {scope.modelTools.length === 0 ? (
          <div className="chart-empty">No per-model tool calls recorded yet — filled by new tool calls.</div>
        ) : (
          <DataTable table={errorRateTable(scope.modelTools)!} compact />
        )}
      </ChartCard>
      <Footnotes scope={scope} summary={summary} />
    </>
  );
}
