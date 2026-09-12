/** Tools & files: call volume and reliability per tool, and the files the agents touched most. */
import React, { useState } from 'react';
import type { AnalyticsSummary } from '../../../../shared/types';
import { Button } from '../ui';
import { BarList, ChartCard, ColumnChart, Legend, Meter, Segmented, seriesTable, StackedBar } from './charts';
import { delta, FILE_KINDS, fmtCompact, fmtMs, fmtPct, plural, SPLITS, splitSeries, type Scope, type Split } from './model';
import { Footnotes, KpiGrid, StatTile } from './tiles';

export function ToolsTab({ scope, summary }: { scope: Scope; summary: AnalyticsSummary }) {
  const [split, setSplit] = useState<Split>('none');
  const [allFiles, setAllFiles] = useState(false);
  const t = scope.totals;
  const p = scope.previous;
  const tt = scope.toolTotals;
  const dates = scope.days.map((d) => d.date);
  const calls = splitSeries(scope, split, 'toolCalls');
  const errorRate = tt.calls > 0 ? tt.errors / tt.calls : null;
  const timed = scope.tools.some((x) => x.durationMs > 0);
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
        {timed && <StatTile label="Avg tool time" value={fmtMs(tt.durationMs / Math.max(1, tt.calls))} sub="over tools that report timing" />}
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
      <Footnotes scope={scope} summary={summary} />
    </>
  );
}
