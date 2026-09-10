/** Analytics dashboard: spend, tokens and turns across all sessions, with daily trend and rollups. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AnalyticsSummary, UsageBucket } from '../../../shared/types';
import { invoke, on } from '../api';
import { basename, fmtCost, fmtDuration, fmtTokens, relTime } from '../format';
import { useStore } from '../store';
import { harnessShort } from './Sidebar';
import { Button, Icon, Spinner } from './ui';

type Range = 7 | 30 | 90 | 0;
const RANGES: [Range, string][] = [
  [7, '7d'],
  [30, '30d'],
  [90, '90d'],
  [0, 'All']
];

type Metric = 'cost' | 'tokens';

export function AnalyticsDashboard() {
  const setView = useStore((s) => s.setView);
  const [range, setRange] = useState<Range>(30);
  const [metric, setMetric] = useState<Metric>('cost');
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await invoke('analytics:summary', range === 0 ? undefined : { days: range });
      setSummary(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live update: usage arrives as sessionsChanged pushes; refresh at most every 2 s while open.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = on('push:sessionsChanged', () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void load();
      }, 2000);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const rangeStats = useMemo(() => {
    const days = summary?.days ?? [];
    const usage = days.reduce(
      (acc, d) => ({
        costUsd: acc.costUsd + d.usage.costUsd,
        turns: acc.turns + d.usage.turns,
        durationMs: acc.durationMs + d.usage.durationMs,
        tokens: acc.tokens + d.usage.inputTokens + d.usage.outputTokens + d.usage.cacheReadTokens + d.usage.cacheWriteTokens
      }),
      { costUsd: 0, turns: 0, durationMs: 0, tokens: 0 }
    );
    return {
      ...usage,
      avgTurnUsd: usage.turns ? usage.costUsd / usage.turns : 0,
      avgTurnMs: usage.turns ? usage.durationMs / usage.turns : 0
    };
  }, [summary]);

  return (
    <div className="analytics">
      <div className="analytics-top">
        <div className="analytics-title">
          <Button variant="ghost" size="sm" icon="chevronRight" className="rot180" onClick={() => setView('chat')} title="Back" />
          <Icon name="chart" size={16} /> Analytics
        </div>
        <div className="row gap8">
          <div className="segmented">
            {RANGES.map(([r, label]) => (
              <button key={r} type="button" className={`segment ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>
                {r === 0 ? 'All' : r === 7 ? '7 days' : `${r} days`}
              </button>
            ))}
          </div>
          <Button size="sm" icon="refresh" onClick={() => void load()} title="Refresh">
            Refresh
          </Button>
        </div>
      </div>
      <div className="analytics-body">
        {error && <div className="callout warn">{error}</div>}
        {!summary && !error && (
          <div className="boot">
            <Spinner size={20} /> Loading usage data…
          </div>
        )}
        {summary && (
          <>
            <div className="stat-grid analytics-stats">
              <Stat label="All-time cost" value={fmtCost(summary.totals.costUsd)} />
              <Stat label={`Cost · last ${rangeLabel(range)}`} value={fmtCost(rangeStats.costUsd)} />
              <Stat label="Sessions" value={String(summary.sessionCount)} />
              <Stat label="Turns" value={String(rangeStats.turns)} />
              <Stat label="Avg cost / turn" value={fmtCost(rangeStats.avgTurnUsd)} />
              <Stat label="Avg turn duration" value={fmtDuration(rangeStats.avgTurnMs)} />
              <Stat label="Input tokens" value={fmtTokens(summary.totals.inputTokens)} />
              <Stat label="Output tokens" value={fmtTokens(summary.totals.outputTokens)} />
              <Stat label="Cache tokens" value={fmtTokens(summary.totals.cacheReadTokens + summary.totals.cacheWriteTokens)} />
              <Stat label="Active days" value={String(summary.activeDays)} />
            </div>

            <h4>Daily trend</h4>
            <div className="row gap8 analytics-metric-toggle">
              <span className="muted small">Show</span>
              <div className="segmented">
                <button type="button" className={`segment ${metric === 'cost' ? 'active' : ''}`} onClick={() => setMetric('cost')}>
                  Cost
                </button>
                <button type="button" className={`segment ${metric === 'tokens' ? 'active' : ''}`} onClick={() => setMetric('tokens')}>
                  Tokens
                </button>
              </div>
            </div>
            <DayChart days={summary.days} metric={metric} />
            {summary.firstDay && <div className="muted small">Tracking since {summary.firstDay} · {summary.sessionCount} session{summary.sessionCount === 1 ? '' : 's'}</div>}

            <Breakdown title="By harness" buckets={summary.byHarness} />
            <Breakdown title="By model" buckets={summary.byModel} formatLabel={(b) => b.label} />
            <Breakdown title="By project" buckets={summary.byProject} formatLabel={(b) => basename(b.label)} />

            <h4>Sessions</h4>
            <SessionTable summary={summary} />
          </>
        )}
      </div>
    </div>
  );
}

function rangeLabel(range: Range): string {
  return range === 0 ? 'all time' : `${range} days`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function DayChart({ days, metric }: { days: AnalyticsSummary['days']; metric: Metric }) {
  const values = days.map((d) => (metric === 'cost' ? d.usage.costUsd : d.usage.inputTokens + d.usage.outputTokens + d.usage.cacheReadTokens + d.usage.cacheWriteTokens));
  const max = Math.max(0.0001, ...values);
  if (days.length === 0) return <div className="muted small">No usage recorded in this range yet.</div>;
  return (
    <div className="day-chart" role="img" aria-label={`Daily ${metric} chart`}>
      {days.map((d, i) => (
        <div
          key={d.date}
          className="day-bar-col"
          title={`${d.date} · ${fmtCost(d.usage.costUsd)} · ${fmtTokens(d.usage.inputTokens + d.usage.outputTokens + d.usage.cacheReadTokens + d.usage.cacheWriteTokens)} tokens · ${d.usage.turns} turns`}
        >
          <div className="day-bar" style={{ height: `${Math.max(2, (values[i] / max) * 100)}%` }} />
          <div className="day-bar-label">{d.date.slice(8)}</div>
        </div>
      ))}
    </div>
  );
}

function Breakdown({ title, buckets, formatLabel }: { title: string; buckets: UsageBucket[]; formatLabel?: (b: UsageBucket) => string }) {
  const max = Math.max(0.0001, ...buckets.map((b) => b.usage.costUsd));
  return (
    <>
      <h4>{title}</h4>
      {buckets.length === 0 && <div className="muted small">Nothing recorded yet.</div>}
      <div className="breakdown">
        {buckets.map((b) => (
          <div key={b.key} className="breakdown-row" title={formatLabel ? b.key : undefined}>
            <span className="breakdown-label">{formatLabel ? formatLabel(b) : harnessShort(b.label)}</span>
            <span className="breakdown-bar">
              <span style={{ width: `${Math.max(2, (b.usage.costUsd / max) * 100)}%` }} />
            </span>
            <span className="mono">{fmtCost(b.usage.costUsd)}</span>
            <span className="muted small mono">{fmtTokens(b.usage.inputTokens + b.usage.outputTokens)} · {b.sessions} session{b.sessions === 1 ? '' : 's'}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function SessionTable({ summary }: { summary: AnalyticsSummary }) {
  const setActive = useStore((s) => s.setActive);
  const sessions = useStore((s) => s.sessions);
  if (summary.sessions.length === 0) return <div className="muted small">No sessions recorded yet.</div>;
  return (
    <div className="session-usage-list">
      {summary.sessions.slice(0, 50).map((s) => {
        const live = sessions.find((x) => x.id === s.id);
        return (
          <div key={s.id} className="session-usage-row" onClick={() => live && void setActive(s.id)} style={{ cursor: live ? 'pointer' : 'default' }}>
            <div className="session-usage-main">
              <span className="session-usage-title" title={s.title}>{s.title}</span>
              <span className="muted small">
                {harnessShort(s.harness)}
                {s.model ? ` · ${s.model}` : ''} · {basename(s.projectRoot)} · {relTime(s.updatedAt)}
                {!live ? ' · deleted' : ''}
              </span>
            </div>
            <span className="mono">{fmtCost(s.usage.costUsd)}</span>
            <span className="muted small mono">{fmtTokens(s.usage.inputTokens + s.usage.outputTokens)} in/out</span>
            <span className="muted small mono">{s.usage.turns} turns</span>
          </div>
        );
      })}
      {summary.sessions.length > 50 && <div className="muted small">Showing top 50 of {summary.sessions.length} sessions by cost.</div>}
    </div>
  );
}