/** Tools & files: call volume and reliability per tool, and the files the agents touched most. */
import React, { useState } from 'react';
import type { AnalyticsSummary, ModelToolRow } from '../../../../shared/types';
import { harnessShort } from '../../format';
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

interface ToolTotal extends RateCell {
  label: string;
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
  // Keep every model visible. The table scrolls horizontally when it outgrows the card.
  const cols = [...models.entries()]
    .sort((a, b) => b[1].calls - a[1].calls || a[1].label.localeCompare(b[1].label))
    .map(([key, m]) => ({ key, label: m.label }));
  // Defensively compare names case-insensitively too, so older/stubbed summaries cannot split
  // Bash/bash into separate rows.
  const perModel = new Map<string, Map<string, RateCell>>();
  const totals = new Map<string, ToolTotal>();
  for (const r of modelTools) {
    const nameKey = r.name.toLocaleLowerCase();
    const m = perModel.get(r.key) ?? new Map<string, RateCell>();
    const cell = m.get(nameKey) ?? { calls: 0, errors: 0 };
    cell.calls += r.calls;
    cell.errors += r.errors;
    m.set(nameKey, cell);
    perModel.set(r.key, m);
    const t = totals.get(nameKey) ?? { label: r.name, calls: 0, errors: 0 };
    // Prefer an all-lowercase spelling when one harness supplies it.
    if (r.name === nameKey) t.label = r.name;
    t.calls += r.calls;
    t.errors += r.errors;
    totals.set(nameKey, t);
  }
  const tools = [...totals.entries()].sort((a, b) => b[1].calls - a[1].calls || a[1].label.localeCompare(b[1].label));
  const cell = (r: RateCell | undefined) => {
    if (!r || !(r.calls > 0)) return { text: '—', tone: undefined, title: 'No calls' };
    const rate = r.errors / r.calls;
    return { text: `(${r.errors}/${r.calls}) ${fmtPct(rate)}`, tone: rateTone(rate), title: `${plural(r.errors, 'error')} in ${plural(r.calls, 'call')}` };
  };
  return {
    columns: [{ label: 'Tool' }, ...cols.map((c) => ({ label: c.label, numeric: true }))],
    rows: tools.map(([nameKey, tool]) => [
      <span key={nameKey} className="mono" title={tool.label}>
        {tool.label || '(unnamed)'}
      </span>,
      ...cols.map((c) => {
        const { text, tone, title } = cell(perModel.get(c.key)?.get(nameKey));
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
      <ChartCard title="Harness/tool reliability" subtitle={`${scope.label} · ${dates[0]} – ${dates[dates.length - 1]}`}>
        <p className="muted small">Recorded since update; historical calls are not backfilled. Compare harnesses only with the same model and workload.</p>
        <p className="muted small">Error rate = errors ÷ executed calls (calls − declined). No executed calls shows —. Tool names are grouped by casing, not aliases.</p>
        {scope.harnessTools.length === 0 ? (
          <div className="chart-empty">No per-harness tool calls recorded in this range.</div>
        ) : (
          <DataTable
            ariaLabel="Harness/tool reliability"
            compact
            table={{
              columns: [{ label: 'Harness' }, { label: 'Tool' }, { label: 'Calls', numeric: true }, { label: 'Errors', numeric: true }, { label: 'Declined', numeric: true }, { label: 'Error rate', numeric: true }],
              rows: scope.harnessTools.map((r) => {
                const executed = r.calls - r.declined;
                const rate = executed > 0 ? r.errors / executed : null;
                return [
                  harnessShort(r.key),
                  <span className="mono" title={r.name}>{r.name || '(unnamed)'}</span>,
                  String(r.calls),
                  String(r.errors),
                  String(r.declined),
                  <span title={`${r.errors} errors / ${executed} executed calls`} style={rate === null ? undefined : { color: rateTone(rate) }}>{fmtPct(rate)}</span>
                ];
              })
            }}
          />
        )}
      </ChartCard>
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
