/**
 * Reliability: what the raw error counts actually were. Every rate shows its numerator and
 * denominator with a sample-size note, failures are split from informational non-zero exits,
 * incidents and recovery are measured, and each failure signature drills down to real executions.
 */
import React, { useEffect, useState } from 'react';
import type { AnalyticsSummary } from '../../../../shared/types';
import type { ExecutionRecord } from '../../../../shared/analytics/records';
import type { Rate, RegressionFlag, ReliabilityReport, ReliabilityRow, SignatureRow, TrendPoint } from '../../../../shared/analytics/reliability';
import { CATEGORY_LABEL, OPERATION_LABEL, OUTCOME_LABEL, SOURCE_LABEL, type ErrorSource, type LogicalOperation, type OutcomeClass } from '../../../../shared/analytics/taxonomy';
import { invoke } from '../../api';
import { harnessShort, relTime } from '../../format';
import { Badge, Button } from '../ui';
import { BarList, ChartCard, ColumnChart, DataTable, LineChart, StackedBar, type TableSpec } from './charts';
import { fmtCompact, fmtDay, fmtMs, fmtPct, HARNESS_ORDER, harnessColor, plural, type ChartSeries, type Scope } from './model';
import { Footnotes, KpiGrid, StatTile } from './tiles';
import { useAnalyticsEnv } from './env';

/** Sample-size note shown beside a rate when it is too small to lean on; never colour alone. */
const CONFIDENCE_NOTE: Record<Rate['confidence'], string | undefined> = { insufficient: 'n<20', very_low: 'n<50', low: 'n<100', ok: undefined };

function ci(r: Rate): string {
  return r.lo === null || r.hi === null ? '' : `95% CI ${fmtPct(r.lo)}–${fmtPct(r.hi)}`;
}

/** `4.8% (3/62)` with the interval and sample note in the title; `—` when nothing was measured. */
function rateText(r: Rate): string {
  if (r.rate === null) return '—';
  return `${fmtPct(r.rate)} (${fmtCompact(r.n)}/${fmtCompact(r.d)})`;
}

function RateCell({ r }: { r: Rate }) {
  const note = CONFIDENCE_NOTE[r.confidence];
  return (
    <span title={r.rate === null ? 'Nothing measured' : `${r.n} of ${r.d} · ${ci(r)}${note ? ` · sample ${note}` : ''}`} className={r.rate !== null && note ? 'muted' : undefined}>
      {rateText(r)}
      {r.rate !== null && note && <span className="small muted"> {note}</span>}
    </span>
  );
}

function rateNode(r: Rate, key: string) {
  return <RateCell key={key} r={r} />;
}

const OUTCOME_COLORS: Record<OutcomeClass, string> = {
  success: 'var(--chart-3)',
  informational: 'var(--chart-1)',
  diagnostic: 'var(--chart-4)',
  failure: 'var(--red)',
  control: 'var(--chart-other)',
  unknown: 'var(--chart-unattributed)'
};

const OUTCOME_ORDER: OutcomeClass[] = ['failure', 'informational', 'diagnostic', 'unknown', 'control', 'success'];

function outcomeSegments(row: ReliabilityRow, withSuccess: boolean) {
  return OUTCOME_ORDER.filter((o) => withSuccess || o !== 'success').map((o) => ({ key: o, label: OUTCOME_LABEL[o], value: row.counts[o], color: OUTCOME_COLORS[o] }));
}

type Column = { label: string; cell: (row: ReliabilityRow) => React.ReactNode; numeric?: boolean };

const COL_CALLS: Column = { label: 'Executed', numeric: true, cell: (r) => fmtCompact(r.counts.executed) };
const COL_RAW: Column = { label: 'Raw error status', numeric: true, cell: (r) => rateNode(r.rates.rawErrorStatus, 'raw') };
const COL_UNEXPECTED: Column = { label: 'Unexpected failures', numeric: true, cell: (r) => rateNode(r.rates.unexpectedFailure, 'unexpected') };
const COL_INFO: Column = { label: 'Informational', numeric: true, cell: (r) => rateNode(r.rates.informational, 'info') };
const COL_DIAG: Column = { label: 'Diagnostic', numeric: true, cell: (r) => rateNode(r.rates.diagnostic, 'diag') };
const COL_UNKNOWN: Column = { label: 'Unknown', numeric: true, cell: (r) => rateNode(r.rates.unknown, 'unknown') };
const COL_INCIDENTS: Column = { label: 'Incidents', numeric: true, cell: (r) => rateNode(r.rates.incident, 'inc') };
const COL_RECOVERY: Column = { label: 'Recovered', numeric: true, cell: (r) => rateNode(r.rates.recovery, 'rec') };
const COL_UNRECOVERED: Column = { label: 'Unrecovered', numeric: true, cell: (r) => rateNode(r.rates.unrecovered, 'unrec') };
const COL_MODEL_SRC: Column = { label: 'Model-attributed', numeric: true, cell: (r) => rateNode(r.rates.modelFailure, 'model') };
const COL_HARNESS_SRC: Column = { label: 'Harness-attributed', numeric: true, cell: (r) => rateNode(r.rates.harnessFailure, 'harness') };
const COL_ENV_SRC: Column = { label: 'Environment', numeric: true, cell: (r) => rateNode(r.rates.environmentFailure, 'env') };
const COL_TURNS: Column = { label: 'Turns completed', numeric: true, cell: (r) => rateNode(r.rates.turnCompleted, 'turns') };
const COL_SAMPLE: Column = {
  label: 'Sample',
  cell: (r) => {
    const c = r.rates.unexpectedFailure.confidence;
    const note = CONFIDENCE_NOTE[c];
    return note ? <Badge tone="amber" title={`${r.counts.executed} executed calls: treat differences as unproven`}>{note}</Badge> : <Badge tone="neutral">ok</Badge>;
  }
};

const GROUP_COLUMNS: Column[] = [COL_CALLS, COL_RAW, COL_UNEXPECTED, COL_INFO, COL_DIAG, COL_UNKNOWN, COL_INCIDENTS, COL_RECOVERY, COL_UNRECOVERED, COL_TURNS, COL_SAMPLE];
const SHELL_COLUMNS: Column[] = [COL_CALLS, COL_RAW, COL_UNEXPECTED, COL_INFO, COL_DIAG, COL_UNKNOWN, COL_MODEL_SRC, COL_HARNESS_SRC, COL_ENV_SRC, COL_SAMPLE];
const TOOL_COLUMNS: Column[] = [COL_CALLS, COL_RAW, COL_UNEXPECTED, COL_INFO, COL_DIAG, COL_UNKNOWN, COL_INCIDENTS, COL_RECOVERY, COL_SAMPLE];

function table(rows: ReliabilityRow[], header: string, columns: Column[], label: (r: ReliabilityRow) => React.ReactNode = (r) => r.label, limit?: number): TableSpec {
  const shown = limit ? rows.slice(0, limit) : rows;
  return {
    columns: [{ label: header }, ...columns.map((c) => ({ label: c.label, numeric: c.numeric }))],
    rows: shown.map((r) => [
      <span key="label" className="mono" title={r.key}>
        {label(r)}
      </span>,
      ...columns.map((c, i) => <React.Fragment key={i}>{c.cell(r)}</React.Fragment>)
    ])
  };
}

function harnessModelLabel(r: ReliabilityRow): string {
  const i = r.key.indexOf('|');
  return i === -1 ? r.label : `${harnessShort(r.key.slice(0, i))} · ${r.key.slice(i + 1).replace(/^\//, '')}`;
}

function trendSeries(points: TrendPoint[], key: keyof TrendPoint, label: string, color: string): ChartSeries {
  return { key: String(key), label, values: points.map((p) => (typeof p[key] === 'number' ? (p[key] as number) : 0)), color };
}

/** Per-day unexpected-failure rate of each harness; days with no executions are gaps. */
function harnessRateSeries(report: ReliabilityReport): ChartSeries[] {
  return HARNESS_ORDER.filter((h) => report.trendByHarness[h])
    .concat(Object.keys(report.trendByHarness).filter((h) => !HARNESS_ORDER.includes(h)))
    .map((h) => ({ key: h, label: harnessShort(h), color: harnessColor(h), values: report.trendByHarness[h].map((p) => (p.executed > 0 ? p.failure / p.executed : null)) }));
}

function Regressions({ flags }: { flags: RegressionFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <div className="callout warn" role="status">
      <strong>Possible regressions.</strong> Unexpected-failure rate over the last 7 days against the 28 days before, both with at least 50 executions and non-overlapping intervals:
      <ul>
        {flags.map((f) => (
          <li key={f.scope}>
            <span className="mono">{f.label}</span>: {rateText(f.baseline)} → {rateText(f.recent)} ({f.delta > 0 ? '+' : ''}
            {(f.delta * 100).toFixed(1)} pp)
          </li>
        ))}
      </ul>
    </div>
  );
}

function SignatureRows({ signatures, selected, onSelect }: { signatures: SignatureRow[]; selected?: string; onSelect: (s: string) => void }) {
  const spec: TableSpec = {
    columns: [{ label: 'Signature' }, { label: 'Outcome' }, { label: 'Source' }, { label: 'Count', numeric: true }, { label: 'Sessions', numeric: true }, { label: 'Harnesses' }, { label: 'Models', numeric: true }, { label: 'First seen' }, { label: 'Last seen' }, { label: 'Recovered', numeric: true }],
    rows: signatures.map((s) => [
      <button key="sig" type="button" className={`link-btn mono ${selected === s.signature ? 'active' : ''}`} onClick={() => onSelect(s.signature)} title={s.signature} aria-pressed={selected === s.signature}>
        {s.signature}
      </button>,
      <span key="o" title={CATEGORY_LABEL[s.category]}>
        {OUTCOME_LABEL[s.outcome]}
      </span>,
      <span key="s">{SOURCE_LABEL[s.source]}</span>,
      <span key="c">{fmtCompact(s.count)}</span>,
      <span key="n">{fmtCompact(s.sessions)}</span>,
      <span key="h">{s.harnesses.map(harnessShort).join(', ')}</span>,
      <span key="m" title={s.models.join('\n')}>
        {s.models.length}
      </span>,
      <span key="f">{fmtDay(new Date(s.firstSeen).toISOString().slice(0, 10))}</span>,
      <span key="l">{fmtDay(new Date(s.lastSeen).toISOString().slice(0, 10))}</span>,
      <span key="r">{s.incidents ? rateText({ n: s.recovered, d: s.incidents, rate: s.recovered / s.incidents, lo: null, hi: null, confidence: 'ok' }) : '—'}</span>
    ])
  };
  return <DataTable ariaLabel="Failure signatures" table={spec} compact />;
}

function ExecutionList({ rows }: { rows: ExecutionRecord[] }) {
  if (rows.length === 0) return <div className="chart-empty">No retained executions for this signature in the selected range.</div>;
  return (
    <div className="exec-list">
      {rows.map((r) => (
        <div key={r.id} className="exec-row" data-testid="execution-row">
          <div className="row gap8 small muted">
            <span>{relTime(r.ts)}</span>
            <span>{harnessShort(r.harness)}</span>
            {r.model && <span className="mono">{r.model.replace(/^\//, '')}</span>}
            {r.role === 'subagent' && <Badge tone="purple">subagent</Badge>}
            <span>{r.facts.tool}</span>
            {typeof r.facts.exitCode === 'number' && <span>exit {r.facts.exitCode}{r.facts.exitCollapsed ? ' (wrapper)' : ''}</span>}
            <span title={`Classified by ${r.derived.method}, ${r.derived.confidence} confidence`}>
              {r.derived.category ? CATEGORY_LABEL[r.derived.category] : OUTCOME_LABEL[r.derived.outcome]} · {r.derived.confidence}
            </span>
            <span className="mono muted" title="Session id">
              {r.sessionId}
            </span>
          </div>
          {r.facts.preview && <pre className="exec-preview">{r.facts.preview}</pre>}
          {r.facts.excerpt && <pre className="exec-excerpt muted">{r.facts.excerpt}</pre>}
          {r.derived.note && <div className="small muted">{r.derived.note}</div>}
        </div>
      ))}
    </div>
  );
}

export function ReliabilityTab({ scope, summary }: { scope: Scope; summary: AnalyticsSummary }) {
  const { drillDown } = useAnalyticsEnv();
  const report = summary.reliability;
  const o = report.overall;
  const [signature, setSignature] = useState<string | undefined>();
  const [examples, setExamples] = useState<ExecutionRecord[]>([]);
  const [loadingExamples, setLoadingExamples] = useState(false);
  const [showAllSignatures, setShowAllSignatures] = useState(false);

  useEffect(() => {
    if (!signature || !drillDown) return;
    let cancelled = false;
    setLoadingExamples(true);
    void invoke('analytics:executions', { signature, days: scope.range, limit: 20 })
      .then((rows) => {
        if (!cancelled) setExamples(rows);
      })
      .catch(() => {
        if (!cancelled) setExamples([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingExamples(false);
      });
    return () => {
      cancelled = true;
    };
  }, [signature, scope.range, report.coverage.records, drillDown]);

  const dates = report.trend.map((p) => p.date);
  const outcomeTrend: ChartSeries[] = [
    trendSeries(report.trend, 'failure', OUTCOME_LABEL.failure, OUTCOME_COLORS.failure),
    trendSeries(report.trend, 'informational', OUTCOME_LABEL.informational, OUTCOME_COLORS.informational),
    trendSeries(report.trend, 'diagnostic', OUTCOME_LABEL.diagnostic, OUTCOME_COLORS.diagnostic),
    trendSeries(report.trend, 'unknown', OUTCOME_LABEL.unknown, OUTCOME_COLORS.unknown),
    trendSeries(report.trend, 'control', OUTCOME_LABEL.control, OUTCOME_COLORS.control)
  ];
  const harnessRates = harnessRateSeries(report);
  const signatures = showAllSignatures ? report.signatures : report.signatures.slice(0, 15);
  const sinceDay = report.coverage.firstTs ? new Date(report.coverage.firstTs).toISOString().slice(0, 10) : undefined;
  const failureShare = o.counts.rawErrorStatus > 0 ? o.counts.failure / o.counts.rawErrorStatus : null;
  const extraCallsPerIncident = o.incidents.incidents > 0 ? o.incidents.extraCalls / o.incidents.incidents : null;
  const extraMsPerIncident = o.incidents.incidents > 0 ? o.incidents.extraMs / o.incidents.incidents : null;

  const notes = [
    sinceDay ? `Semantic outcome classification covers ${plural(report.coverage.executions, 'execution')} retained since ${fmtDay(sinceDay)} ${sinceDay.slice(0, 4)} (classifier v${report.classifierVersion}); the log keeps at most ${fmtCompact(report.coverage.retention.maxRecords)} records or ${report.coverage.retention.maxDays} days.` : 'No executions have been recorded in the execution log yet.',
    report.coverage.backfilled > 0 ? `${plural(report.coverage.backfilled, 'execution')} were replayed from stored transcripts; ${plural(report.coverage.legacyUnclassified, 'record')} kept neither output nor exit code and stay "legacy, not classifiable".` : undefined,
    report.coverage.truncated ? 'The retained log starts after the selected range does, so older days are missing here but present in the usage totals.' : undefined,
    `Exit codes for shell calls came from the harness for ${fmtCompact(report.coverage.exitSources.harness ?? 0)}, from the tool's output text for ${fmtCompact(report.coverage.exitSources.output ?? 0)}, and were unavailable for ${fmtCompact(report.coverage.exitSources.none ?? 0)}. Codex on Windows reports its PowerShell wrapper's 0/1, not the program's code.`,
    'Rates are associations within this data, not causes. Compare models within the same harness and workload; compare harnesses with the same model and workload. Small samples are marked (n<20, n<50, n<100) and should not decide anything.'
  ].filter((n): n is string => !!n);

  return (
    <>
      <KpiGrid caption="Every rate is numerator ÷ denominator over executed calls (declined calls excluded). Hover for the 95% interval.">
        <StatTile label="Executed calls" value={fmtCompact(o.counts.executed)} sub={`${plural(o.counts.sessions, 'session')} · ${plural(o.counts.declined, 'declined call')} excluded`} title="Tool calls that ran, in the selected range" />
        <StatTile label="Raw error status" value={rateText(o.rates.rawErrorStatus)} sub="the legacy error rate: every call the harness flagged" title={ci(o.rates.rawErrorStatus)} />
        <StatTile label="Unexpected failures" value={rateText(o.rates.unexpectedFailure)} sub={failureShare !== null ? `${fmtPct(failureShare)} of raw errors were real failures` : undefined} title={ci(o.rates.unexpectedFailure)} />
        <StatTile label="Failure incidents" value={rateText(o.rates.incident)} sub={`${plural(o.incidents.attempts, 'failed call')} grouped into ${plural(o.incidents.incidents, 'incident')}`} title={ci(o.rates.incident)} />
        <StatTile label="Recovery" value={rateText(o.rates.recovery)} sub={o.incidents.incidents ? `${rateText(o.rates.immediateRecovery)} within 2 calls` : 'no incidents'} title={ci(o.rates.recovery)} />
        <StatTile label="Unrecovered failures" value={rateText(o.rates.unrecovered)} sub="incidents never resolved in their turn" title={ci(o.rates.unrecovered)} />
        <StatTile label="Turns completed" value={rateText(o.rates.turnCompleted)} sub={report.turns.withFailure ? `${rateText(o.rates.turnCompletedAfterFailure)} of turns with a failure still completed` : undefined} title="Turns the harness finished normally; not a judgement of the work's correctness" />
        <StatTile label="Harness failures" value={rateText(o.rates.harnessFailure)} sub={`model ${rateText(o.rates.modelFailure)} · environment ${rateText(o.rates.environmentFailure)}`} title="Unexpected failures attributed to the harness or its shell configuration" />
      </KpiGrid>

      <Regressions flags={report.regressions} />

      <div className="agrid agrid-2">
        <ChartCard title="Where the raw errors go" subtitle="Every non-success execution by semantic outcome">
          {o.counts.executed === 0 ? (
            <div className="chart-empty">No executions recorded in this range.</div>
          ) : (
            <>
              <StackedBar segments={outcomeSegments(o, false)} format={fmtCompact} title="Non-success executions by outcome" />
              <BarList rows={report.categories.map((c) => ({ key: c.category, label: CATEGORY_LABEL[c.category], value: c.count, sub: `${OUTCOME_LABEL[c.outcome]} · ${plural(c.sessions, 'session')}` }))} format={fmtCompact} limit={12} emptyText="No non-success executions." />
            </>
          )}
        </ChartCard>
        <ChartCard title="Who the failures are associated with" subtitle="Unexpected failures by attributed source; unrecovered incidents beside">
          <BarList rows={report.sources.map((s) => ({ key: s.source, label: SOURCE_LABEL[s.source], value: s.count, sub: `${plural(s.unrecovered, 'unrecovered incident')}` }))} format={fmtCompact} limit={8} emptyText="No unexpected failures." />
          <p className="muted small">"Ambiguous" means the evidence fits more than one party; "unknown" means the rules had nothing to go on. Neither is folded into the model.</p>
        </ChartCard>
      </div>

      <ChartCard title="By harness" subtitle="Compare harnesses only with the same model and workload; see the harness × model table">
        {report.byHarness.length === 0 ? <div className="chart-empty">Nothing recorded.</div> : <DataTable ariaLabel="Reliability by harness" table={table(report.byHarness, 'Harness', GROUP_COLUMNS, (r) => harnessShort(r.key))} compact />}
      </ChartCard>
      <ChartCard title="By model" subtitle="Compare models only within the same harness and workload; see the harness × model table">
        {report.byModel.length === 0 ? <div className="chart-empty">Nothing recorded.</div> : <DataTable ariaLabel="Reliability by model" table={table(report.byModel, 'Model', GROUP_COLUMNS, (r) => r.label)} compact />}
      </ChartCard>
      <ChartCard title="By harness × model" subtitle="The controlled comparison: one row per pair, sample size beside each">
        {report.byHarnessModel.length === 0 ? <div className="chart-empty">Nothing recorded.</div> : <DataTable ariaLabel="Reliability by harness and model" table={table(report.byHarnessModel, 'Harness · model', GROUP_COLUMNS, harnessModelLabel)} compact />}
      </ChartCard>
      {report.byHarnessVersion.length > 1 && (
        <ChartCard title="By harness version" subtitle="Versions as reported by each runtime when it was probed; unknown before this update">
          <DataTable ariaLabel="Reliability by harness version" table={table(report.byHarnessVersion, 'Harness · version', GROUP_COLUMNS, (r) => r.label)} compact />
        </ChartCard>
      )}

      <div className="agrid agrid-2">
        <ChartCard title="By physical tool" subtitle="What was literally invoked, aliases combined">
          <DataTable ariaLabel="Reliability by physical tool" table={table(report.byPhysicalTool, 'Tool', TOOL_COLUMNS)} compact />
        </ChartCard>
        <ChartCard title="By logical operation" subtitle="What the agent was trying to do, whichever tool it used">
          <DataTable ariaLabel="Reliability by operation" table={table(report.byOperation, 'Operation', TOOL_COLUMNS, (r) => OPERATION_LABEL[r.key as LogicalOperation] ?? r.label)} compact />
        </ChartCard>
      </div>

      <ChartCard title="Shell analysis" subtitle="Shell executions only · exit codes, dialects, executables and command shape">
        <div className="agrid agrid-2">
          <div>
            <h4 className="acard-sub">Harness × shell</h4>
            <DataTable ariaLabel="Shell reliability by harness and shell" table={table(report.byHarnessShell, 'Harness · shell', SHELL_COLUMNS, (r) => harnessModelLabel(r))} compact />
            <h4 className="acard-sub">Command shape</h4>
            <DataTable ariaLabel="Shell reliability by command complexity" table={table(report.byComplexity, 'Complexity', SHELL_COLUMNS)} compact />
            <DataTable ariaLabel="Shell reliability by shell idioms" table={table(report.byShellMismatch, 'Idioms', SHELL_COLUMNS)} compact />
          </div>
          <div>
            <h4 className="acard-sub">Exit code</h4>
            <DataTable ariaLabel="Shell reliability by exit code" table={table(report.byExitCode, 'Exit', [COL_CALLS, COL_UNEXPECTED, COL_INFO, COL_DIAG, COL_UNKNOWN], undefined, 12)} compact />
            <h4 className="acard-sub">Executable owning the exit</h4>
            <DataTable ariaLabel="Shell reliability by executable" table={table(report.byExecutable, 'Executable', SHELL_COLUMNS, undefined, 20)} compact />
          </div>
        </div>
      </ChartCard>

      <ChartCard title="Failure signatures" subtitle="Recurring failure patterns: surface | category | program [| detail]. Click one to inspect executions." actions={report.signatures.length > 15 ? <Button variant="ghost" size="sm" onClick={() => setShowAllSignatures((v) => !v)}>{showAllSignatures ? 'Show top 15' : `Show all ${report.signatures.length}`}</Button> : undefined}>
        {report.signatures.length === 0 ? (
          <div className="chart-empty">No non-success executions in this range.</div>
        ) : (
          <>
            <SignatureRows signatures={signatures} selected={signature} onSelect={(s) => setSignature(s === signature ? undefined : s)} />
            {signature && (
              <div className="exec-drilldown" data-testid="signature-drilldown">
                <div className="row gap8">
                  <strong className="mono">{signature}</strong>
                  <span className="muted small">{loadingExamples ? 'Loading…' : `${plural(examples.length, 'representative execution')}, most recent first`}</span>
                  <Button variant="ghost" size="sm" onClick={() => setSignature(undefined)}>
                    Close
                  </Button>
                </div>
                {!drillDown && <p className="muted small" data-testid="reliability-examples-local">Representative executions stay on the computer that ran them; open Analytics in Vocs Code there to see them.</p>}
                {drillDown && !loadingExamples && <ExecutionList rows={examples} />}
              </div>
            )}
          </>
        )}
      </ChartCard>

      <div className="agrid agrid-2">
        <ChartCard title="Recovery" subtitle="What a failure incident costs before it is resolved or abandoned">
          {o.incidents.incidents === 0 ? (
            <div className="chart-empty">No failure incidents in this range.</div>
          ) : (
            <DataTable
              ariaLabel="Recovery analysis"
              compact
              table={{
                columns: [{ label: 'Measure' }, { label: 'Value', numeric: true }],
                rows: [
                  ['Incidents', fmtCompact(o.incidents.incidents)],
                  ['Recovered', rateText(o.rates.recovery)],
                  ['Recovered within 2 calls', rateText(o.rates.immediateRecovery)],
                  ['Unrecovered', fmtCompact(o.incidents.unrecovered)],
                  ['Mean calls to recover', o.incidents.meanRecoveryCalls === null ? '—' : o.incidents.meanRecoveryCalls.toFixed(1)],
                  ['Median time to recover', o.incidents.medianRecoveryMs === null ? '—' : fmtMs(o.incidents.medianRecoveryMs)],
                  ['p95 time to recover', o.incidents.p95RecoveryMs === null ? '—' : fmtMs(o.incidents.p95RecoveryMs)],
                  ['Extra calls per incident', extraCallsPerIncident === null ? '—' : extraCallsPerIncident.toFixed(1)],
                  ['Extra wall time per incident', extraMsPerIncident === null ? '—' : fmtMs(extraMsPerIncident)],
                  ['Extra calls in total', fmtCompact(o.incidents.extraCalls)]
                ].map(([k, v]) => [<span key="k">{k}</span>, <span key="v">{v}</span>])
              }}
            />
          )}
        </ChartCard>
        <ChartCard title="Unrecovered incidents by source" subtitle="Which party's failures the agent could not get past">
          <BarList rows={Object.entries(o.incidents.unrecoveredBySource).map(([source, n]) => ({ key: source, label: SOURCE_LABEL[source as ErrorSource] ?? source, value: n, sub: `${o.incidents.bySource[source] ?? 0} incidents in total` }))} format={fmtCompact} limit={8} emptyText="Every incident recovered." />
          {report.turns.closed > 0 && (
            <p className="muted small">
              {plural(report.turns.closed, 'closed turn')}: {report.turns.completed} completed, {report.turns.failed} failed, {report.turns.interrupted} interrupted; {report.turns.withUnrecovered} carried an unrecovered incident and {report.turns.completedWithUnrecovered} of those still completed.
            </p>
          )}
        </ChartCard>
      </div>

      <ChartCard title="Non-success executions per day" subtitle={`By semantic outcome · ${scope.label}`} wide>
        <ColumnChart dates={dates} series={outcomeTrend} format={fmtCompact} ariaLabel="Non-success executions per day by outcome" integer height={180} />
      </ChartCard>
      <ChartCard title="Unexpected-failure rate per day" subtitle="One line per harness; a day without executions is a gap. Rates on small days swing widely." wide>
        <LineChart dates={dates} series={harnessRates} format={fmtPct} ariaLabel="Unexpected failure rate per day by harness" height={180} />
      </ChartCard>

      <Footnotes scope={scope} summary={summary} extra={notes} />
    </>
  );
}
