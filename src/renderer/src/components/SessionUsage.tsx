/**
 * The right panel's Usage page: a session-scoped dashboard over the live transcript. The top block
 * is always on (spend, headline counters, context and budget meters, token mix); the lower half
 * switches between turn activity, the tool mix and the failure log, which is what fills the panel.
 *
 * Charts reuse the analytics primitives so the colour system is the one already validated there:
 * categorical `--chart-N` in a fixed order for mixes, and the reserved status hues only for status.
 */
import React, { useMemo, useState } from 'react';
import type { SessionMeta, TranscriptItem } from '../../../shared/types';
import { fmtCost, fmtDuration, fmtRate, fmtTokens, relTime, speedOfTurns } from '../format';
import {
  cacheHitRate,
  failureCount,
  HINT_LABEL,
  sessionUsageStats,
  toolSuccessRate,
  turnSuccessRate,
  type ErrorEntry,
  type SessionUsageStats,
  type TurnPoint
} from '../session-usage';
import { BarList, Meter, Segmented, Sparkline, StackedBar, type BarRow, type Segment } from './analytics/charts';
import { fmtPct } from './analytics/model';
import { Icon } from './ui';

/** Stable fallback so a zustand selector never returns a fresh array (React #185 infinite loop). */
const EMPTY: never[] = [];

type DetailView = 'turns' | 'tools' | 'errors';
type TurnMetric = 'cost' | 'time' | 'tokens';

const DETAILS: { value: DetailView; label: string }[] = [
  { value: 'turns', label: 'Turns' },
  { value: 'tools', label: 'Tools' },
  { value: 'errors', label: 'Errors' }
];

const METRICS: { value: TurnMetric; label: string }[] = [
  { value: 'cost', label: 'Cost' },
  { value: 'time', label: 'Time' },
  { value: 'tokens', label: 'Tokens' }
];

/** Token kinds in a fixed slot order, so a mix keeps its colours when a kind is absent. */
const TOKEN_SEGMENTS = [
  { key: 'inputTokens', label: 'Input', color: 'var(--chart-1)' },
  { key: 'outputTokens', label: 'Output', color: 'var(--chart-2)' },
  { key: 'cacheReadTokens', label: 'Cache read', color: 'var(--chart-3)' },
  { key: 'cacheWriteTokens', label: 'Cache write', color: 'var(--chart-4)' },
  { key: 'reasoningTokens', label: 'Reasoning', color: 'var(--chart-5)' }
] as const;

const FILE_SEGMENTS = [
  { key: 'update', label: 'Modified', color: 'var(--chart-1)' },
  { key: 'add', label: 'Added', color: 'var(--chart-3)' },
  { key: 'delete', label: 'Deleted', color: 'var(--chart-2)' },
  { key: 'rename', label: 'Renamed', color: 'var(--chart-4)' }
] as const;

const HINT_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];

export function SessionUsage({ session, items }: { session: SessionMeta; items?: readonly TranscriptItem[] }) {
  const stats = useMemo(() => sessionUsageStats(session, items ?? EMPTY), [session, items]);
  const [view, setView] = useState<DetailView>('turns');
  const u = session.usage;
  const totalTokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens;
  const speed = useMemo(() => speedOfTurns(stats.series.map((p) => ({ status: p.status, durationMs: p.durationMs, usage: { outputTokens: p.outputTokens } }))), [stats.series]);
  const turnCount = Math.max(u.turns, stats.turns.total);
  const avgTurnMs = stats.turns.timed > 0 ? stats.turns.totalMs / stats.turns.timed : 0;
  const avgTurnCost = turnCount > 0 ? u.costUsd / turnCount : 0;
  const cache = cacheHitRate(u);
  const ctxPct = u.contextWindow && u.contextTokens ? Math.min(1, u.contextTokens / u.contextWindow) : null;
  const budget = session.config.maxBudgetUsd;
  const failures = failureCount(stats);
  const costSpark = useMemo(() => stats.series.slice(-24).map((p) => p.costUsd), [stats.series]);

  return (
    <div className="usage" data-testid="usage-panel">
      <div className="usage-hero">
        <div className="usage-hero-main">
          <div className="usage-hero-label">Session spend</div>
          <div className="usage-hero-value">{fmtCost(u.costUsd)}</div>
          <div className="usage-hero-sub">
            {turnCount} turn{turnCount === 1 ? '' : 's'} · {stats.tools.total} tool call{stats.tools.total === 1 ? '' : 's'}
            {stats.turns.totalMs > 0 ? ` · ${fmtDuration(stats.turns.totalMs)} working` : ''}
          </div>
        </div>
        {costSpark.length > 1 && <Sparkline values={costSpark} width={104} height={34} />}
      </div>

      <div className="usage-kpis">
        <Kpi label="Tokens" value={fmtTokens(totalTokens)} sub={`${fmtTokens(u.inputTokens)} in · ${fmtTokens(u.outputTokens)} out`} title="Every token this session reported, including cache traffic and reasoning." />
        <Kpi label="Cache hit" value={fmtPct(cache)} sub={`${fmtTokens(u.cacheReadTokens)} reused`} title="Cache reads as a share of everything read into the model (cache reads + fresh input)." />
        <Kpi label="Output speed" value={fmtRate(speed.tokens, speed.ms) || '—'} sub={avgTurnMs > 0 ? `${fmtDuration(avgTurnMs)} / turn` : undefined} title="Output tokens per second of turn wall time, averaged over completed turns (includes tool execution and any subagents the turn ran)." />
        <Kpi label="Avg turn" value={avgTurnCost > 0 ? fmtCost(avgTurnCost) : '—'} sub={stats.turns.longestMs > 0 ? `longest ${fmtDuration(stats.turns.longestMs)}` : undefined} title="Session cost divided by the number of turns." />
        <Kpi label="Tool calls" value={String(stats.tools.total)} sub={stats.tools.totalMs > 0 ? `${fmtDuration(stats.tools.totalMs)} in tools` : undefined} tone={stats.tools.running > 0 ? 'live' : undefined} title="Tool calls recorded in the loaded transcript." />
        <Kpi
          label="Failures"
          value={String(failures)}
          sub={stats.warnings > 0 ? `${stats.warnings} warning${stats.warnings === 1 ? '' : 's'}` : stats.approvals.denied > 0 ? `${stats.approvals.denied} denied` : undefined}
          tone={failures > 0 ? 'bad' : undefined}
          title="Failed tool calls, declined tool calls and failed turns."
        />
        <Kpi label="Files touched" value={String(stats.files.touched)} sub={`+${stats.files.add} ~${stats.files.update} −${stats.files.delete}`} title="Distinct paths reported as changed by tool calls in this session." />
        <Kpi label="Messages" value={String(stats.messages.user)} sub={`${stats.messages.assistant} ${stats.messages.assistant === 1 ? 'reply' : 'replies'}`} title="Prompts you sent, and replies the agent produced." />
      </div>

      {(ctxPct !== null || budget || stats.tools.total > 0) && (
        <div className="usage-meters">
          {ctxPct !== null && (
            <Meter
              value={ctxPct}
              label="Context window"
              tone={ctxPct > 0.85 ? 'red' : ctxPct > 0.6 ? 'amber' : 'accent'}
              sub={`${fmtTokens(u.contextTokens)} of ${fmtTokens(u.contextWindow)}`}
              title="How full the model's context is right now, as last reported by the harness."
            />
          )}
          {budget ? (
            <Meter
              value={Math.min(1, u.costUsd / budget)}
              label="Budget"
              tone={u.costUsd / budget > 0.85 ? 'red' : u.costUsd / budget > 0.6 ? 'amber' : 'accent'}
              sub={`${fmtCost(u.costUsd)} of ${fmtCost(budget)} cap`}
              title="Spend against this session's budget cap."
            />
          ) : null}
          {stats.tools.total > 0 && (
            <Meter
              value={toolSuccessRate(stats)}
              label="Tool success"
              tone={(toolSuccessRate(stats) ?? 1) < 0.8 ? 'amber' : 'accent'}
              sub={`${stats.tools.done} clean · ${stats.tools.errors} failed${stats.tools.declined > 0 ? ` · ${stats.tools.declined} declined` : ''}`}
              title="Tool calls that finished without an error, as a share of the calls that have settled."
            />
          )}
        </div>
      )}

      {totalTokens > 0 && (
        <section className="usage-block">
          <h5>Token mix</h5>
          <StackedBar segments={TOKEN_SEGMENTS.filter((s) => u[s.key] > 0).map((s) => ({ key: s.key, label: s.label, value: u[s.key], color: s.color }))} format={fmtTokens} title="Token mix for this session" />
        </section>
      )}

      <div className="usage-switch">
        <Segmented value={view} options={DETAILS} onChange={setView} ariaLabel="Usage detail" />
        <span className="spacer" />
        {view === 'errors' && failures > 0 && <span className="usage-switch-note">{fmtPct(turnSuccessRate(stats))} of turns completed</span>}
      </div>

      <div className="usage-detail">
        {view === 'turns' && <TurnsDetail stats={stats} />}
        {view === 'tools' && <ToolsDetail stats={stats} />}
        {view === 'errors' && <ErrorsDetail stats={stats} />}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, title, tone }: { label: string; value: string; sub?: string; title?: string; tone?: 'bad' | 'live' }) {
  return (
    <div className={`ukpi ${tone ? `ukpi-${tone}` : ''}`} title={title}>
      <div className="ukpi-value">{value}</div>
      <div className="ukpi-label">{label}</div>
      {sub && <div className="ukpi-sub">{sub}</div>}
    </div>
  );
}

const METRIC_VALUE: Record<TurnMetric, (p: TurnPoint) => number> = {
  cost: (p) => p.costUsd,
  time: (p) => p.durationMs,
  tokens: (p) => p.inputTokens + p.outputTokens
};

const METRIC_FORMAT: Record<TurnMetric, (v: number) => string> = {
  cost: fmtCost,
  time: (v) => fmtDuration(v) || '0ms',
  tokens: fmtTokens
};

function TurnsDetail({ stats }: { stats: SessionUsageStats }) {
  const [metric, setMetric] = useState<TurnMetric>('cost');
  const [focus, setFocus] = useState<number | null>(null);
  const points = stats.series.slice(-60);
  if (points.length === 0) return <div className="chart-empty">No completed turns yet — the timeline fills in as the agent works.</div>;
  const value = METRIC_VALUE[metric];
  const format = METRIC_FORMAT[metric];
  const max = Math.max(...points.map(value), Number.EPSILON);
  const shown = focus !== null && points[focus] ? points[focus] : points[points.length - 1];
  const index = focus !== null && points[focus] ? focus : points.length - 1;
  const outcome = { completed: 'Completed', interrupted: 'Interrupted', failed: 'Failed' } as const;
  return (
    <>
      <div className="usage-block-head">
        <h5>Turn activity</h5>
        <span className="spacer" />
        <Segmented value={metric} options={METRICS} onChange={setMetric} ariaLabel="Turn metric" />
      </div>
      {/* The readout is the hover layer: a column is narrow in this panel, so the value lands in a
          fixed line above the chart rather than in a tooltip that would not fit beside it. */}
      <div className="uturn-readout" role="status">
        <span className={`uturn-dot st-${shown.status}`} aria-hidden />
        <span className="uturn-readout-main">
          Turn {index + 1}/{points.length} · {format(value(shown))}
        </span>
        <span className="uturn-readout-sub">
          {outcome[shown.status]} · {fmtDuration(shown.durationMs) || '—'} · {fmtTokens(shown.outputTokens)} out · {shown.tools} tool{shown.tools === 1 ? '' : 's'}
        </span>
      </div>
      <div className="uturns" onMouseLeave={() => setFocus(null)}>
        {points.map((p, i) => (
          <button
            key={p.id}
            type="button"
            className={`uturn st-${p.status} ${i === index ? 'focused' : ''}`}
            onMouseEnter={() => setFocus(i)}
            onFocus={() => setFocus(i)}
            onBlur={() => setFocus(null)}
            title={`Turn ${i + 1} · ${outcome[p.status]} · ${fmtCost(p.costUsd)} · ${fmtDuration(p.durationMs) || '—'} · ${fmtTokens(p.inputTokens)} in / ${fmtTokens(p.outputTokens)} out`}
            aria-label={`Turn ${i + 1}, ${outcome[p.status]}, ${format(value(p))}`}
          >
            <span className="uturn-fill" style={{ height: `${Math.max(3, (value(p) / max) * 100)}%` }} />
          </button>
        ))}
      </div>
      <div className="uturn-legend">
        {(['completed', 'interrupted', 'failed'] as const).map((s) =>
          stats.turns[s] > 0 ? (
            <span key={s} className="uturn-key">
              <span className={`uturn-dot st-${s}`} aria-hidden /> {outcome[s]} <b>{stats.turns[s]}</b>
            </span>
          ) : null
        )}
      </div>
      <h5>Recent turns</h5>
      <div className="uturn-rows">
        {points
          .slice(-12)
          .reverse()
          .map((p, i) => (
            <div key={p.id} className="uturn-row">
              <span className={`uturn-dot st-${p.status}`} aria-hidden />
              <span className="uturn-row-name">#{points.length - i}</span>
              <span className="uturn-row-val mono">{fmtCost(p.costUsd)}</span>
              <span className="uturn-row-val mono">{fmtDuration(p.durationMs) || '—'}</span>
              <span className="uturn-row-val mono">{fmtTokens(p.outputTokens)}</span>
              <span className="uturn-row-rate muted">{fmtRate(p.outputTokens, p.durationMs) || `${p.tools} tool${p.tools === 1 ? '' : 's'}`}</span>
            </div>
          ))}
      </div>
    </>
  );
}

function ToolsDetail({ stats }: { stats: SessionUsageStats }) {
  if (stats.tools.total === 0) return <div className="chart-empty">No tool calls in this session yet.</div>;
  const mix: Segment[] = stats.tools.byHint.map((h, i) => ({ key: h.hint, label: HINT_LABEL[h.hint], value: h.calls, color: HINT_COLORS[i % HINT_COLORS.length] }));
  const rows: BarRow[] = stats.tools.byName.map((t) => ({
    key: t.name,
    label: t.name,
    value: t.calls,
    sub: [HINT_LABEL[t.hint], t.timed > 0 ? `avg ${fmtDuration(t.totalMs / t.timed)}` : null, t.errors > 0 ? `${t.errors} failed` : null].filter(Boolean).join(' · '),
    title: `${t.name} · ${t.calls} call${t.calls === 1 ? '' : 's'}${t.errors > 0 ? ` · ${t.errors} failed` : ''}${t.files > 0 ? ` · ${t.files} file change${t.files === 1 ? '' : 's'}` : ''}`,
    color: t.errors > 0 ? 'var(--amber)' : 'var(--accent)'
  }));
  const fileSegments = FILE_SEGMENTS.filter((s) => stats.files[s.key] > 0).map((s) => ({ key: s.key, label: s.label, value: stats.files[s.key], color: s.color }));
  const slow = [...stats.tools.byName].filter((t) => t.timed > 0).sort((a, b) => b.totalMs - a.totalMs)[0];
  return (
    <>
      <div className="usage-block-head">
        <h5>Tool mix</h5>
        <span className="spacer" />
        <span className="usage-switch-note">{stats.tools.byName.length} distinct tool{stats.tools.byName.length === 1 ? '' : 's'}</span>
      </div>
      <StackedBar segments={mix} format={(v) => String(v)} title="Tool calls by category" />
      {slow && <div className="usage-note">Most time in <b>{slow.name}</b> — {fmtDuration(slow.totalMs)} over {slow.timed} call{slow.timed === 1 ? '' : 's'}.</div>}
      <h5>Busiest tools</h5>
      <BarList rows={rows} format={(v) => String(v)} limit={8} emptyText="No tool calls recorded." />
      {fileSegments.length > 0 && (
        <>
          <h5>File changes</h5>
          <StackedBar segments={fileSegments} format={(v) => String(v)} title="Reported file changes by kind" />
        </>
      )}
    </>
  );
}

function ErrorsDetail({ stats }: { stats: SessionUsageStats }) {
  const offenders: BarRow[] = stats.tools.byName
    .filter((t) => t.errors > 0)
    .sort((a, b) => b.errors - a.errors)
    .map((t) => ({ key: t.name, label: t.name, value: t.errors, sub: `${fmtPct(t.errors / t.calls)} of ${t.calls} call${t.calls === 1 ? '' : 's'}`, color: 'var(--red)' }));
  const counts = [
    { key: 'tool', label: 'Failed tools', value: stats.tools.errors, title: 'Tool calls the harness reported as failed.' },
    { key: 'turn', label: 'Failed turns', value: stats.turns.failed, title: 'Turns that ended with an error instead of a reply.' },
    { key: 'interrupted', label: 'Interrupted', value: stats.turns.interrupted, title: 'Turns you stopped before they finished.' },
    { key: 'declined', label: 'Declined', value: stats.tools.declined, title: 'Tool calls the agent abandoned after an approval was refused.' },
    { key: 'denied', label: 'Denied', value: stats.approvals.denied, title: 'Approval requests you denied.' },
    { key: 'warn', label: 'Warnings', value: stats.warnings, title: 'Warning lines the session logged.' }
  ];
  return (
    <>
      <div className="usage-meters">
        <Meter value={turnSuccessRate(stats)} label="Turn completion" tone={(turnSuccessRate(stats) ?? 1) < 0.9 ? 'amber' : 'accent'} sub={`${stats.turns.completed} of ${stats.turns.total} turn${stats.turns.total === 1 ? '' : 's'}`} title="Turns that reached a completed state." />
        <Meter value={toolSuccessRate(stats)} label="Tool success" tone={(toolSuccessRate(stats) ?? 1) < 0.8 ? 'amber' : 'accent'} sub={`${stats.tools.errors} failed of ${stats.tools.total}`} title="Tool calls that finished without an error." />
      </div>
      <div className="uerr-counts">
        {counts.map((c) => (
          <div key={c.key} className={`uerr-count ${c.value > 0 ? 'hot' : ''}`} title={c.title}>
            <span className="uerr-count-value">{c.value}</span>
            <span className="uerr-count-label">{c.label}</span>
          </div>
        ))}
      </div>
      {offenders.length > 0 && (
        <>
          <h5>Where failures land</h5>
          <BarList rows={offenders} format={(v) => String(v)} share={false} limit={6} emptyText="No failing tools." />
        </>
      )}
      <h5>Error log</h5>
      {stats.errors.length === 0 ? <div className="chart-empty">Nothing has failed in this session.</div> : <div className="uerr-list">{stats.errors.map((e) => <ErrorRow key={e.id} entry={e} />)}</div>}
    </>
  );
}

const ERROR_ICON: Record<ErrorEntry['source'], string> = { tool: 'bolt', turn: 'alert', session: 'alert' };

function ErrorRow({ entry }: { entry: ErrorEntry }) {
  return (
    <div className="uerr" title={entry.detail}>
      <Icon name={ERROR_ICON[entry.source]} size={12} className="uerr-icon" />
      <span className="uerr-head">
        <span className="uerr-label">{entry.label}</span>
        <span className="uerr-time muted">{relTime(entry.ts)}</span>
      </span>
      <span className="uerr-detail mono">{entry.detail}</span>
    </div>
  );
}
