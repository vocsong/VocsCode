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

interface RateMatrixRow extends RateCell {
  name: string;
}

/** `(errors/calls) rate` in its tone, or a dash when there were no calls. */
function rateCellNode(cell: RateCell | undefined, key: string) {
  const { text, tone, title } = rateCell(cell);
  return (
    <span key={key} title={title} style={tone ? { color: tone } : undefined}>
      {text}
    </span>
  );
}

/**
 * Groups per-owner tool rows into a matrix: one row per owner (a model, or a harness and model), one
 * column per tool, plus a leading Total column that sums the row. Owners are sorted alphabetically
 * by label; case-insensitive tool names merge across harnesses. Cells read `(errors/calls) rate`.
 */
function rateMatrix<T extends RateMatrixRow>(rows: T[], rowHeader: string, owner: (r: T) => { key: string; label: string }): TableSpec | null {
  const owners = new Map<string, { label: string; calls: number; errors: number; tools: Map<string, RateCell> }>();
  const tools = new Map<string, { label: string; calls: number }>();
  for (const r of rows) {
    const { key, label } = owner(r);
    const nameKey = r.name.toLocaleLowerCase();
    const m = owners.get(key) ?? { label, calls: 0, errors: 0, tools: new Map() };
    const cell = m.tools.get(nameKey) ?? { calls: 0, errors: 0 };
    cell.calls += r.calls;
    cell.errors += r.errors;
    m.tools.set(nameKey, cell);
    m.calls += r.calls;
    m.errors += r.errors;
    owners.set(key, m);
    const t = tools.get(nameKey) ?? { label: r.name, calls: 0 };
    // Prefer an all-lowercase spelling when one harness supplies it.
    if (r.name === nameKey) t.label = r.name;
    t.calls += r.calls;
    tools.set(nameKey, t);
  }
  if (owners.size === 0) return null;
  const sortedRows = [...owners.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label) || b[1].calls - a[1].calls || a[0].localeCompare(b[0]));
  const cols = [...tools.entries()].sort((a, b) => b[1].calls - a[1].calls || a[1].label.localeCompare(b[1].label));
  return {
    columns: [{ label: rowHeader }, { label: 'Total', numeric: true }, ...cols.map(([, t]) => ({ label: t.label, numeric: true }))],
    rows: sortedRows.map(([key, m]) => [
      <span key={key} className="mono" title={m.label}>
        {m.label || key}
      </span>,
      rateCellNode(m, 'total'),
      ...cols.map(([nameKey]) => rateCellNode(m.tools.get(nameKey), nameKey))
    ])
  };
}

/** One row per model, one column per tool. */
function errorRateTable(modelTools: ModelToolRow[]): TableSpec | null {
  return rateMatrix(modelTools, 'Model', (r) => ({ key: r.key, label: r.label || r.key }));
}

/** The same matrix, one row per harness and model pair. */
function harnessModelRateTable(harnessModelTools: HarnessModelToolRow[]): TableSpec | null {
  return rateMatrix(harnessModelTools, 'Harness · model', (r) => ({ key: `${r.harness}|${r.key}`, label: `${harnessShort(r.harness)} · ${r.label || r.key}` }));
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
      <ChartCard title="Error rate by harness + model" subtitle={`Errors ÷ calls for each tool, by the harness and model that made it · ${scope.label}`}>
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
