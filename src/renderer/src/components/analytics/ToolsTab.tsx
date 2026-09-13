/** Tools & files: call volume and reliability per tool, and the files the agents touched most. */
import React, { useState } from 'react';
import type { AnalyticsSummary, HarnessModelToolRow, ModelToolRow } from '../../../../shared/types';
import { harnessShort } from '../../format';
import { Button } from '../ui';
import { BarList, ChartCard, ColumnChart, DataTable, Legend, Meter, Segmented, seriesTable, StackedBar, type TableSpec } from './charts';
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

function rateCell(cell: RateCell | undefined): { text: string; tone?: string; title: string } {
  if (!cell || !(cell.calls > 0)) return { text: '—', tone: undefined, title: 'No calls' };
  const rate = cell.errors / cell.calls;
  return { text: `(${cell.errors}/${cell.calls}) ${fmtPct(rate)}`, tone: rateTone(rate), title: `${plural(cell.errors, 'error')} in ${plural(cell.calls, 'call')}` };
}

/**
 * Groups the per-model tool rows into a matrix: one row per model, one column per tool. Models grow
 * with every provider added, so they take the rows and the table gets taller instead of wider.
 */
function errorRateTable(modelTools: ModelToolRow[]): TableSpec | null {
  const models = new Map<string, { label: string; calls: number; errors: number; tools: Map<string, RateCell> }>();
  const tools = new Map<string, { label: string; calls: number }>();
  for (const r of modelTools) {
    const nameKey = r.name.toLocaleLowerCase();
    const m = models.get(r.key) ?? { label: r.label || r.key, calls: 0, errors: 0, tools: new Map() };
    const cell = m.tools.get(nameKey) ?? { calls: 0, errors: 0 };
    cell.calls += r.calls;
    cell.errors += r.errors;
    m.tools.set(nameKey, cell);
    m.calls += r.calls;
    m.errors += r.errors;
    models.set(r.key, m);
    const t = tools.get(nameKey) ?? { label: r.name, calls: 0 };
    // Prefer an all-lowercase spelling when one harness supplies it.
    if (r.name === nameKey) t.label = r.name;
    t.calls += r.calls;
    tools.set(nameKey, t);
  }
  if (models.size === 0) return null;
  const rows = [...models.entries()].sort((a, b) => b[1].calls - a[1].calls || a[1].label.localeCompare(b[1].label));
  const cols = [...tools.entries()].sort((a, b) => b[1].calls - a[1].calls || a[1].label.localeCompare(b[1].label));
  return {
    columns: [{ label: 'Model' }, ...cols.map(([, t]) => ({ label: t.label, numeric: true }))],
    rows: rows.map(([key, m]) => [
      <span key={key} className="mono" title={m.label}>
        {m.label || key}
      </span>,
      ...cols.map(([nameKey]) => {
        const { text, tone, title } = rateCell(m.tools.get(nameKey));
        return (
          <span key={nameKey} title={title} style={tone ? { color: tone } : undefined}>
            {text}
          </span>
        );
      })
    ])
  };
}

/** One row per harness and model pair, worst error rate first; the tooltip breaks it down by tool. */
function harnessModelRateTable(rows: HarnessModelToolRow[]): TableSpec | null {
  interface Combo extends RateCell {
    harness: string;
    label: string;
    tools: string[];
  }
  const combos = new Map<string, Combo>();
  for (const r of rows) {
    const comboKey = `${r.harness}|${r.key}`;
    const c = combos.get(comboKey) ?? { harness: r.harness, label: r.label || r.key, calls: 0, errors: 0, tools: [] };
    c.calls += r.calls;
    c.errors += r.errors;
    if (r.calls > 0) c.tools.push(`${r.name} ${r.errors}/${r.calls}`);
    combos.set(comboKey, c);
  }
  if (combos.size === 0) return null;
  const rate = (c: RateCell) => (c.calls > 0 ? c.errors / c.calls : -1);
  const sorted = [...combos.entries()].sort((a, b) => rate(b[1]) - rate(a[1]) || b[1].calls - a[1].calls || a[1].label.localeCompare(b[1].label));
  return {
    columns: [{ label: 'Harness · model' }, { label: 'Calls', numeric: true }, { label: 'Errors', numeric: true }, { label: 'Error rate', numeric: true }],
    rows: sorted.map(([comboKey, c]) => {
      const ratio = c.calls > 0 ? c.errors / c.calls : null;
      const tone = ratio === null ? undefined : rateTone(ratio);
      return [
        <span key={comboKey} className="mono" title={`${harnessShort(c.harness)} · ${c.label}`}>
          {harnessShort(c.harness)} · {c.label}
        </span>,
        fmtCompact(c.calls),
        fmtCompact(c.errors),
        <span key="rate" title={c.tools.join(' · ') || 'No calls'} style={tone ? { color: tone } : undefined}>
          {fmtPct(ratio)}
        </span>
      ];
    })
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
        <ChartCard title="Calls by tool" subtitle="Equivalent names from different harnesses are combined">
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
      <ChartCard title="Error rate by harness + model" subtitle={`Errors ÷ calls across every tool, worst rate first · ${scope.label}`}>
        {scope.harnessModelTools.length === 0 ? (
          <div className="chart-empty">No per-harness tool calls recorded yet — filled by new tool calls.</div>
        ) : (
          <DataTable table={harnessModelRateTable(scope.harnessModelTools)!} compact />
        )}
      </ChartCard>
      <Footnotes scope={scope} summary={summary} />
    </>
  );
}
