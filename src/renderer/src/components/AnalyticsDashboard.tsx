/** Analytics dashboard: spend, tokens and turns across all sessions, with daily trend and rollups. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AnalyticsSummary, UsageBucket } from '../../../shared/types';
import { invoke, on } from '../api';
import { basename, fmtCost, fmtDuration, fmtRate, fmtTokens, relTime } from '../format';
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

type Metric = 'cost' | 'tokens' | 'calls' | 'speed';

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
        toolCalls: acc.toolCalls + d.usage.toolCalls,
        tokens: acc.tokens + d.usage.inputTokens + d.usage.outputTokens + d.usage.cacheReadTokens + d.usage.cacheWriteTokens,
        speedTokens: acc.speedTokens + d.usage.speedTokens,
        speedMs: acc.speedMs + d.usage.speedMs
      }),
      { costUsd: 0, turns: 0, durationMs: 0, toolCalls: 0, tokens: 0, speedTokens: 0, speedMs: 0 }
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
              <Stat
                label={`Cost · ${rangeLabel(range)}`}
                value={fmtCost(rangeStats.costUsd)}
                sub={range !== 0 ? `All-time ${fmtCost(summary.totals.costUsd)}` : undefined}
              />
              <Stat label="Avg cost / turn" value={fmtCost(rangeStats.avgTurnUsd)} sub={`${fmtDuration(rangeStats.avgTurnMs)} avg`} />
              <Stat
                label={`Output speed · ${rangeLabel(range)}`}
                value={fmtRate(rangeStats.speedTokens, rangeStats.speedMs) || '—'}
                sub={range !== 0 && fmtRate(summary.speed.tokens, summary.speed.ms) ? `All-time ${fmtRate(summary.speed.tokens, summary.speed.ms)}` : undefined}
                title="Output tokens per second of turn wall time, over completed turns that reported both (includes tool execution)"
              />
              <Stat label="Sessions" value={String(summary.sessionCount)} sub={`${summary.activeDays} active day${summary.activeDays === 1 ? '' : 's'}`} />
              <Stat label="Turns" value={String(rangeStats.turns)} />
              <Stat
                label="Tool calls"
                value={String(rangeStats.toolCalls)}
                sub={summary.toolTotals.errors ? `${summary.toolTotals.errors} errors · ${summary.toolTotals.declined} declined` : undefined}
              />
              <Stat label="Input tokens" value={fmtTokens(summary.totals.inputTokens)} />
              <Stat label="Output tokens" value={fmtTokens(summary.totals.outputTokens)} />
              <Stat label="Cache tokens" value={fmtTokens(summary.totals.cacheReadTokens + summary.totals.cacheWriteTokens)} />
              <Stat label="Total tokens" value={fmtTokens(summary.totals.inputTokens + summary.totals.outputTokens + summary.totals.cacheReadTokens + summary.totals.cacheWriteTokens)} />
              <Stat label="Tools all-time" value={String(summary.toolTotals.calls)} sub={summary.toolTotals.errors ? `${summary.toolTotals.errors} errors · ${summary.toolTotals.declined} declined` : undefined} />
            </div>

            <h4>Daily trend</h4>
            <div className="day-chart-head">
              <div className="row gap8">
                <span className="muted small">Show</span>
                <div className="segmented">
                  <button type="button" className={`segment ${metric === 'cost' ? 'active' : ''}`} onClick={() => setMetric('cost')}>
                    Cost
                  </button>
                  <button type="button" className={`segment ${metric === 'tokens' ? 'active' : ''}`} onClick={() => setMetric('tokens')}>
                    Tokens
                  </button>
                  <button type="button" className={`segment ${metric === 'calls' ? 'active' : ''}`} onClick={() => setMetric('calls')}>
                    Tool calls
                  </button>
                  <button type="button" className={`segment ${metric === 'speed' ? 'active' : ''}`} onClick={() => setMetric('speed')}>
                    Speed
                  </button>
                </div>
              </div>
              <TrendTotals days={summary.days} metric={metric} />
            </div>
            <DayChart days={summary.days} metric={metric} />
            {summary.firstDay && <div className="muted small">Tracking since {summary.firstDay} · {summary.sessionCount} session{summary.sessionCount === 1 ? '' : 's'}</div>}

            <div className="analytics-cols">
              <div className="analytics-col">
                <Breakdown title="By harness" buckets={summary.byHarness} />
                <Breakdown title="By model" buckets={summary.byModel} formatLabel={(b) => b.label} />
                <ModelRates rates={summary.modelRates} />
                <Breakdown title="By project" buckets={summary.byProject} formatLabel={(b) => basename(b.label)} />
              </div>
              <div className="analytics-col">
                <h4>Tool calls</h4>
                <ToolTable tools={summary.tools} totals={summary.toolTotals} />
                <h4>Files changed</h4>
                <FileTable files={summary.files} />
              </div>
            </div>

            <h4>Sessions</h4>
            <SessionTable summary={summary} />
          </>
        )}
      </div>
    </div>
  );
}

function rangeLabel(range: Range): string {
  return range === 0 ? 'all time' : `last ${range} days`;
}

/** Speed is a per-day tokens/second average (0 when the day has no sample); the rest are sums. */
function metricValue(d: AnalyticsSummary['days'][number], metric: Metric): number {
  if (metric === 'speed') return d.usage.speedMs > 0 ? (d.usage.speedTokens / d.usage.speedMs) * 1000 : 0;
  return metric === 'cost' ? d.usage.costUsd : metric === 'calls' ? d.usage.toolCalls : d.usage.inputTokens + d.usage.outputTokens + d.usage.cacheReadTokens + d.usage.cacheWriteTokens;
}

function fmtMetric(metric: Metric, v: number): string {
  if (metric === 'speed') return v > 0 ? fmtRate(v, 1000) : '—';
  return metric === 'cost' ? fmtCost(v) : metric === 'calls' ? `${v} calls` : fmtTokens(v);
}

function TrendTotals({ days, metric }: { days: AnalyticsSummary['days']; metric: Metric }) {
  if (days.length === 0) return null;
  const values = days.map((d) => metricValue(d, metric));
  const peakIdx = values.indexOf(Math.max(...values));
  if (metric === 'speed') {
    const tokens = days.reduce((a, d) => a + d.usage.speedTokens, 0);
    const ms = days.reduce((a, d) => a + d.usage.speedMs, 0);
    if (!ms) return <span className="muted small">No speed samples in range yet.</span>;
    return (
      <span className="muted small">
        {fmtRate(tokens, ms)} average in range · peak {fmtMetric(metric, values[peakIdx])} on {days[peakIdx].date}
      </span>
    );
  }
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <span className="muted small">
      {fmtMetric(metric, total)} in range · peak {fmtMetric(metric, values[peakIdx])} on {days[peakIdx].date}
    </span>
  );
}

function Stat({ label, value, sub, title }: { label: string; value: string; sub?: string; title?: string }) {
  return (
    <div className="stat" title={title}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-label">{sub}</div>}
    </div>
  );
}

function DayChart({ days, metric }: { days: AnalyticsSummary['days']; metric: Metric }) {
  if (days.length === 0) return <div className="muted small">No usage recorded in this range yet.</div>;
  const values = days.map((d) => metricValue(d, metric));
  const max = Math.max(0.0001, ...values);
  const labelEvery = Math.max(1, Math.ceil(days.length / 16));
  return (
    <div className="day-chart" role="img" aria-label={`Daily ${metric} chart`}>
      {days.map((d, i) => {
        const v = values[i];
        return (
          <div
            key={d.date}
            className="day-bar-col"
            title={`${d.date} · ${fmtCost(d.usage.costUsd)} · ${fmtTokens(d.usage.inputTokens + d.usage.outputTokens + d.usage.cacheReadTokens + d.usage.cacheWriteTokens)} tokens · ${d.usage.turns} turns · ${d.usage.toolCalls} tool calls${fmtRate(d.usage.speedTokens, d.usage.speedMs) ? ` · ${fmtRate(d.usage.speedTokens, d.usage.speedMs)}` : ''}`}
          >
            <div className={`day-bar${v > 0 ? '' : ' zero'}`} style={{ height: v > 0 ? `${Math.max(3, (v / max) * 100)}%` : undefined }} />
            <div className="day-bar-label">{i % labelEvery === 0 || i === days.length - 1 ? d.date.slice(8) : ''}</div>
          </div>
        );
      })}
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
            <span className="muted small mono">
              {fmtTokens(b.usage.inputTokens + b.usage.outputTokens)} · {b.toolCalls} calls · {b.sessions} session{b.sessions === 1 ? '' : 's'}
              {fmtRate(b.speed.tokens, b.speed.ms) ? ` · ${fmtRate(b.speed.tokens, b.speed.ms)}` : ''}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/** $ per million tokens and $ per call for each model; rates show — while their denominator was never measured. */
function ModelRates({ rates }: { rates: AnalyticsSummary['modelRates'] }) {
  if (rates.length === 0) return null;
  return (
    <>
      <h4>Model rates</h4>
      <div className="muted small">All time · one call = one model turn · $/M tokens blends input, output and cache</div>
      <div className="session-usage-list">
        {rates.map((r) => (
          <div key={r.key} className="session-usage-row tool-usage-row" title={r.key}>
            <div className="session-usage-main">
              <span className="session-usage-title mono">{r.label}</span>
              <span className="muted small">
                {fmtCost(r.costUsd)} · {fmtTokens(r.tokens)} tokens · {r.calls} call{r.calls === 1 ? '' : 's'}
              </span>
            </div>
            <span className="muted small mono">{r.usdPerMTok != null ? `${fmtUnit(r.usdPerMTok)}/M tok` : '—'}</span>
            <span className="muted small mono">{r.usdPerCall != null ? `${fmtUnit(r.usdPerCall)}/call` : '—'}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** Rates carry decimals so cheap models stay readable: $0.10 per M tokens must not round to $0. */
function fmtUnit(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2)}`;
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
            <span className="muted small mono">{s.toolCalls} calls</span>
            <span className="muted small mono">{fmtRate(s.speed?.tokens, s.speed?.ms) || '—'}</span>
          </div>
        );
      })}
      {summary.sessions.length > 50 && <div className="muted small">Showing top 50 of {summary.sessions.length} sessions by cost.</div>}
    </div>
  );
}

function ToolTable({ tools, totals }: { tools: AnalyticsSummary['tools']; totals: AnalyticsSummary['toolTotals'] }) {
  if (tools.length === 0) return <div className="muted small">No tool calls recorded yet.</div>;
  const max = Math.max(0.0001, ...tools.map((t) => t.calls));
  return (
    <>
      <div className="muted small">
        {totals.calls} call{totals.calls === 1 ? '' : 's'} · {totals.errors} error{totals.errors === 1 ? '' : 's'} · {totals.declined} declined · avg {fmtDuration(totals.durationMs / Math.max(1, totals.calls))}
      </div>
      <div className="session-usage-list">
        {tools.map((t) => (
          <div key={t.name} className="session-usage-row tool-usage-row">
            <div className="session-usage-main">
              <span className="session-usage-title mono">{t.name}</span>
              <span className="muted small">
                avg {fmtDuration(t.durationMs / Math.max(1, t.calls))}
                {t.errors ? ` · ${t.errors} error${t.errors === 1 ? '' : 's'}` : ''}
                {t.declined ? ` · ${t.declined} declined` : ''}
              </span>
            </div>
            <span className="breakdown-bar">
              <span style={{ width: `${Math.max(2, (t.calls / max) * 100)}%` }} />
            </span>
            <span className="mono">{t.calls}×</span>
          </div>
        ))}
      </div>
    </>
  );
}

function FileTable({ files }: { files: AnalyticsSummary['files'] }) {
  if (files.length === 0) return <div className="muted small">No file changes recorded yet.</div>;
  return (
    <div className="session-usage-list">
      {files.slice(0, 25).map((f) => (
        <div key={f.path} className="session-usage-row tool-usage-row" title={f.path}>
          <div className="session-usage-main">
            <span className="session-usage-title mono" title={f.path}>{f.path}</span>
            <span className="muted small">
              {f.updates > 0 && `${f.updates} modified`}
              {f.adds > 0 && `${f.updates > 0 ? ' · ' : ''}${f.adds} added`}
              {f.deletes > 0 && `${f.updates + f.adds > 0 ? ' · ' : ''}${f.deletes} deleted`}
              {f.renames > 0 && `${f.updates + f.adds + f.deletes > 0 ? ' · ' : ''}${f.renames} renamed`}
            </span>
          </div>
          <span className="mono">{f.total}×</span>
        </div>
      ))}
      {files.length > 25 && <div className="muted small">Showing top 25 of {files.length} files by change count.</div>}
    </div>
  );
}