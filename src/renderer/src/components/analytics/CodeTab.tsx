/**
 * Code output: how much code the agent wrote per token it spent. The unit is the turn, because a
 * harness reports what a turn cost and its own calls say what the turn wrote — a turn that answered a
 * question without touching a file counts nowhere, so the rate is code per token *of turns that wrote
 * code*, not per token of everything. Everything left out is listed under "What was measured".
 */
import React from 'react';
import type { AnalyticsSummary } from '../../../../shared/types';
import type { CodeOutputReport, CodeOutputRow, CodeTrendPoint } from '../../../../shared/analytics/code-output';
import { harnessShort } from '../../format';
import { Badge } from '../ui';
import { BarList, ChartCard, ColumnChart, DataTable, LineChart, seriesTable, type TableSpec } from './charts';
import { fmtCompact, fmtDay, fmtPct, fmtUnit, type ChartSeries, type Scope } from './model';
import { Footnotes, Hero, KpiGrid, StatTile } from './tiles';

/** Sample-size note beside a rate that rests on too few turns to lean on. */
const CONFIDENCE_NOTE: Record<CodeOutputRow['confidence'], string | undefined> = { insufficient: 'n<3', very_low: 'n<10', low: 'n<30', ok: undefined };

/** The headline rate: `412 lines / M tokens`. */
function fmtLinesPerM(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (v >= 10_000) return `${fmtCompact(v)} lines / M tokens`;
  if (v >= 100) return `${Math.round(v)} lines / M tokens`;
  return `${v.toFixed(v < 1 ? 2 : 1)} lines / M tokens`;
}

/** The rate alone, for axis ticks. */
function fmtLinesPerMAxis(v: number): string {
  if (!(v > 0)) return '0';
  return v >= 1000 ? `${fmtCompact(v)}` : `${Math.round(v)}`;
}

/** `$0.42` per 1000 lines, with the cents that cheap models need. */
function fmtPerKLine(v: number | null): string {
  return v === null ? '—' : `${fmtUnit(v)} / 1k lines`;
}

function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

function pctText(v: number | null): string {
  return v === null ? '—' : fmtPct(v);
}

function rateSeries(points: CodeTrendPoint[]): ChartSeries[] {
  return [{ key: 'linesPerMTokens', label: 'Lines per M tokens', values: points.map((p) => p.linesPerMTokens), color: 'var(--accent)' }];
}

function linesSeries(points: CodeTrendPoint[]): ChartSeries[] {
  return [{ key: 'lines', label: 'Lines written', values: points.map((p) => p.lines), color: 'var(--chart-2)' }];
}

type Column = { label: string; cell: (r: CodeOutputRow) => React.ReactNode; numeric?: boolean };

const COL_TURNS: Column = { label: 'Turns with code', numeric: true, cell: (r) => fmtCompact(r.turns) };
const COL_LINES: Column = { label: 'Lines written', numeric: true, cell: (r) => fmtCompact(r.lines) };
const COL_TOKENS: Column = { label: 'Tokens', numeric: true, cell: (r) => fmtCompact(r.tokens) };
const COL_RATE: Column = {
  label: 'Lines / M tokens',
  numeric: true,
  cell: (r) => (
    <span title={r.linesPerMTokens === null ? 'No tokens reported, nothing to divide by' : `${fmtCompact(r.lines)} lines over ${fmtCompact(r.tokens)} tokens`}>{r.linesPerMTokens === null ? '—' : fmtCompact(r.linesPerMTokens)}</span>
  )
};
const COL_COST: Column = {
  label: '$ / 1k lines',
  numeric: true,
  cell: (r) => <span title={r.costMeasured ? undefined : 'No counted turn reported a cost, so this cannot be computed'}>{fmtPerKLine(r.costPerKLine)}</span>
};
const COL_DELEGATED: Column = {
  label: 'Written by subagents',
  numeric: true,
  cell: (r) => (
    <span title={`${fmtCompact(r.delegatedLines)} of ${fmtCompact(r.lines)} lines came from subagent calls; their tokens are the session's and cannot be separated, so they stay in the rate`}>
      {pctText(share(r.delegatedLines, r.lines))}
    </span>
  )
};
const COL_SAMPLE: Column = {
  label: 'Sample',
  cell: (r) => {
    const note = CONFIDENCE_NOTE[r.confidence];
    return note ? <Badge tone="amber" title={`${r.turns} turns with code: treat differences as unproven`}>{note}</Badge> : <Badge tone="neutral">ok</Badge>;
  }
};

const COLUMNS: Column[] = [COL_TURNS, COL_LINES, COL_TOKENS, COL_RATE, COL_COST, COL_DELEGATED, COL_SAMPLE];

function table(rows: CodeOutputRow[], header: string, label: (r: CodeOutputRow) => React.ReactNode = (r) => r.label): TableSpec {
  return {
    columns: [{ label: header }, ...COLUMNS.map((c) => ({ label: c.label, numeric: c.numeric }))],
    rows: rows.map((r) => [
      <span key="label" className="mono" title={r.key}>
        {label(r)}
      </span>,
      ...COLUMNS.map((c, i) => <React.Fragment key={i}>{c.cell(r)}</React.Fragment>)
    ])
  };
}

function harnessModelLabel(r: CodeOutputRow): string {
  const i = r.key.indexOf('|');
  return i === -1 ? r.label : `${harnessShort(r.key.slice(0, i))} · ${r.key.slice(i + 1).replace(/^\//, '')}`;
}

/** What the rates were computed over and what they had to leave out; nothing here is silent. */
function coverageNotes(report: CodeOutputReport): string[] {
  const c = report.coverage;
  const notes: string[] = [];
  notes.push(
    `Counted ${fmtCompact(c.countedTurns)} of ${fmtCompact(c.turns)} turns in this range: the ones that wrote at least one line and reported what they spent. ${fmtCompact(c.lines)} lines over ${fmtCompact(c.tokens)} tokens.`
  );
  if (c.noCodeTurns > 0) notes.push(`${fmtCompact(c.noCodeTurns)} turns wrote nothing (questions, reads, answers); their ${fmtCompact(c.noCodeTokens)} tokens are left out of every rate, because a turn with no code has nothing to measure it against.`);
  if (c.unmeasuredTurns > 0) notes.push(`${fmtCompact(c.unmeasuredTurns)} turns wrote ${fmtCompact(c.unmeasuredLines)} lines but reported no token counters, so their lines are left out too — an unmeasured turn is never treated as a free one.`);
  if (c.unknownLineTurns > 0) notes.push(`${fmtCompact(c.unknownLineTurns)} turns changed files without a diff (Cursor reports none), so what they wrote is unknown rather than zero; their lines are missing from the numerator.`);
  if (c.unattachedCalls > 0) notes.push(`${fmtCompact(c.unattachedCalls)} calls ran before their session's first recorded user message and belong to no turn; ${fmtCompact(c.unattachedLines)} of their lines are not counted.`);
  return notes;
}

export function CodeTab({ scope, summary }: { scope: Scope; summary: AnalyticsSummary }) {
  const report = summary.codeOutput;
  const o = report.overall;
  const c = report.coverage;
  const dates = report.trend.map((p) => p.date);
  const sinceDay = c.firstTs ? new Date(c.firstTs).toISOString().slice(0, 10) : undefined;

  const notes = [
    sinceDay ? `Measured over turns since ${fmtDay(sinceDay)} ${sinceDay.slice(0, 4)}, from the execution log, which keeps at most ${fmtCompact(c.retention.maxRecords)} records or ${c.retention.maxDays} days.` : 'No turns have been recorded in the execution log yet.',
    ...coverageNotes(report),
    'Lines are the added lines of each call’s own diff, so an edit counts its rewritten lines and a deletion counts none. Code written by a shell command (sed, a generator) or a formatter’s reflow is invisible to this count, and reformatting inflates it.',
    'A turn’s lines are all of them, parent and subagent together — the tokens are the session’s and cannot be split the same way, so the delegated share is shown beside the rate rather than subtracted from it.',
    c.truncated ? 'The retained log starts after the selected range does, so older days are missing here.' : undefined,
    'Compare harnesses with the same model and workload, and models within the same harness; fewer than 30 turns with code is not enough to decide anything.'
  ].filter((n): n is string => !!n);

  return (
    <>
      <Hero
        value={fmtLinesPerM(o.linesPerMTokens)}
        label="Code written per token spent"
        sub={
          c.countedTurns === 0 ? (
            'No turn in this range both wrote code and reported its token counts.'
          ) : (
            <>
              {fmtCompact(o.lines)} lines across {fmtCompact(o.turns)} turns that changed files, over {fmtCompact(o.tokens)} tokens ({fmtCompact(o.costUsd)}); {fmtCompact(o.sessions)} sessions.
            </>
          )
        }
      />

      <KpiGrid caption="Everything below is computed over turns that wrote at least one line and reported what they spent. Hover any figure for the numbers behind it.">
        <StatTile label="Lines written" value={fmtCompact(o.lines)} sub={`${fmtCompact(o.turns)} turns with code · ${fmtCompact(c.turns)} turns in range`} title="Added lines across every counted turn's file changes" />
        <StatTile label="Tokens behind them" value={fmtCompact(o.tokens)} sub={`${fmtCompact(o.outputTokens)} output · ${fmtCompact(o.cacheReadTokens)} cache read`} title="Input + output + cache read + cache write over the counted turns" />
        <StatTile label="Cost per 1k lines" value={fmtPerKLine(o.costPerKLine)} sub={o.costMeasured ? undefined : 'no counted turn reported a cost'} title="Dollars per 1000 added lines; needs a harness that reports cost" />
        <StatTile
          label="Written by subagents"
          value={pctText(share(o.delegatedLines, o.lines))}
          sub={`${fmtCompact(o.delegatedLines)} of ${fmtCompact(o.lines)} lines`}
          title="Share of the lines that came from subagent calls. Their tokens are inside the session totals, so this is a breakout, not a subtraction"
        />
        <StatTile label="Turns excluded" value={fmtCompact(c.turns - c.countedTurns)} sub={`${fmtCompact(c.noCodeTurns)} wrote no code · ${fmtCompact(c.unmeasuredTurns)} reported no tokens`} title="Turns that could not enter the rate, and why" />
        <StatTile label="Unmeasurable turns" value={fmtCompact(c.unknownLineTurns)} sub="file changes arrived without a diff" title="Cursor reports no inline diff, so its turns have no line count at all" />
      </KpiGrid>

      <div className="agrid agrid-2">
        <ChartCard
          title="Code per token, day by day"
          subtitle="Lines per million tokens over the turns that wrote code; a day with no counted turn is a gap"
          table={seriesTable(dates, rateSeries(report.trend), (v) => (v === null ? '—' : fmtCompact(v)))}
        >
          <LineChart dates={dates} series={rateSeries(report.trend)} format={(v) => `${fmtCompact(v)}/M`} axis={fmtLinesPerMAxis} ariaLabel="Lines per million tokens per day" emptyText="No counted turns in this range yet." height={180} />
        </ChartCard>
        <ChartCard title="Lines written per day" subtitle="Added lines across counted turns" table={seriesTable(dates, linesSeries(report.trend), fmtCompact)}>
          <ColumnChart dates={dates} series={linesSeries(report.trend)} format={fmtCompact} integer ariaLabel="Lines written per day" emptyText="No counted turns in this range yet." height={180} />
        </ChartCard>
      </div>

      <ChartCard title="Which models turn tokens into code" subtitle="Counted turns only; the same model under two harnesses appears as two rows below" >
        <BarList
          rows={report.byHarnessModel.slice(0, 10).map((r) => ({ key: r.key, label: harnessModelLabel(r), value: r.linesPerMTokens ?? 0, sub: `${fmtCompact(r.lines)} lines · ${fmtCompact(r.tokens)} tokens · ${fmtCompact(r.turns)} turns`, title: `${fmtCompact(r.lines)} lines over ${fmtCompact(r.tokens)} tokens` }))}
          format={(v) => `${fmtCompact(v)} lines/M`}
          emptyText="No counted turns in this range yet."
        />
        <p className="muted small">
          A bar is lines per million tokens; longer is more code per token spent. Watched alone it rewards writing more, so read it beside the cost column and the sample badge in the tables.
        </p>
      </ChartCard>

      <ChartCard title="By harness" subtitle="Same model and workload only; see the harness × model table">
        {report.byHarness.length === 0 ? <div className="chart-empty">Nothing recorded.</div> : <DataTable ariaLabel="Code output by harness" table={table(report.byHarness, 'Harness', (r) => harnessShort(r.key))} compact />}
      </ChartCard>
      <ChartCard title="By model" subtitle="Same harness and workload only; see the harness × model table">
        {report.byModel.length === 0 ? <div className="chart-empty">Nothing recorded.</div> : <DataTable ariaLabel="Code output by model" table={table(report.byModel, 'Model')} compact />}
      </ChartCard>
      <ChartCard title="By harness × model" subtitle="The controlled comparison: one row per pair, sample size beside each">
        {report.byHarnessModel.length === 0 ? <div className="chart-empty">Nothing recorded.</div> : <DataTable ariaLabel="Code output by harness and model" table={table(report.byHarnessModel, 'Harness · model', harnessModelLabel)} compact />}
      </ChartCard>

      <ChartCard title="What was measured" subtitle="Every turn in range lands in exactly one of these lines">
        <DataTable
          ariaLabel="Code output coverage"
          compact
          table={{
            columns: [{ label: 'Bucket' }, { label: 'Turns', numeric: true }, { label: 'Lines', numeric: true }, { label: 'Tokens', numeric: true }, { label: 'In the rate' }],
            rows: [
              { key: 'counted', label: 'Wrote code and reported tokens', turns: c.countedTurns, lines: c.lines, tokens: c.tokens, inRate: true },
              { key: 'nocode', label: 'Wrote no code (question, read, answer)', turns: c.noCodeTurns, lines: 0, tokens: c.noCodeTokens, inRate: false },
              { key: 'unmeasured', label: 'Wrote code, reported no tokens', turns: c.unmeasuredTurns, lines: c.unmeasuredLines, tokens: 0, inRate: false },
              { key: 'unknown', label: 'Changed files without a diff (Cursor)', turns: c.unknownLineTurns, lines: 0, tokens: 0, inRate: false },
              { key: 'unattached', label: 'Calls outside any recorded turn', turns: c.unattachedCalls, lines: c.unattachedLines, tokens: 0, inRate: false }
            ].map((b) => [
              <span key="b">{b.label}</span>,
              <span key="t">{fmtCompact(b.turns)}</span>,
              <span key="l">{fmtCompact(b.lines)}</span>,
              <span key="k">{b.tokens > 0 ? fmtCompact(b.tokens) : '—'}</span>,
              <span key="r">{b.inRate ? <Badge tone="green">yes</Badge> : <Badge tone="neutral">no</Badge>}</span>
            ])
          }}
        />
      </ChartCard>

      <Footnotes scope={scope} summary={summary} extra={notes} />
    </>
  );
}
