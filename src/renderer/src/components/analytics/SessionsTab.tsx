/** Sessions: every session active in the range as a searchable, sortable table; click one to open it. */
import React, { useMemo, useState } from 'react';
import type { AnalyticsSummary, UsageSessionRecord } from '../../../../shared/types';
import { speedTps } from '../../../../shared/usage-rollup';
import { basename, fmtCost, fmtTokens, relTime } from '../../format';
import { useStore } from '../../store';
import { harnessShort } from '../../format';
import { Badge } from '../ui';
import { Segmented } from './charts';
import { fmtCompact, fmtMs, fmtTps, plural, SESSION_SORTS, sessionMatches, sessionTokens, sortSessions, type Scope, type SessionSort } from './model';
import { Footnotes } from './tiles';

const PAGE = 100;

export function SessionsTab({ scope, summary }: { scope: Scope; summary: AnalyticsSummary }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SessionSort>('cost');
  const [harness, setHarness] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const harnesses = useMemo(() => [...new Set(scope.sessions.map((s) => s.harness))].sort(), [scope.sessions]);
  const rows = useMemo(() => sortSessions(scope.sessions.filter((s) => (!harness || s.harness === harness) && sessionMatches(s, query)), sort), [scope.sessions, harness, query, sort]);
  const shown = rows.slice(0, limit);
  return (
    <>
      <div className="toolbar toolbar-wrap">
        <input className="asearch" type="search" placeholder="Search title, model, project…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search sessions" />
        <span className="muted small">Sort by</span>
        <Segmented value={sort} options={SESSION_SORTS} onChange={setSort} ariaLabel="Sort sessions by" />
        {harnesses.length > 1 && (
          <div className="afilters" role="group" aria-label="Filter by harness">
            <button type="button" className={`afilter ${harness === null ? 'active' : ''}`} onClick={() => setHarness(null)}>
              All harnesses
            </button>
            {harnesses.map((h) => (
              <button key={h} type="button" className={`afilter ${harness === h ? 'active' : ''}`} onClick={() => setHarness(harness === h ? null : h)}>
                {harnessShort(h)}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        <span className="muted small">
          {plural(rows.length, 'session')} · {scope.label}
        </span>
      </div>
      <SessionList sessions={shown} />
      {rows.length > shown.length && (
        <button type="button" className="btn btn-default btn-sm self-start" onClick={() => setLimit((l) => l + PAGE)}>
          Show {Math.min(PAGE, rows.length - shown.length)} more of {rows.length}
        </button>
      )}
      <Footnotes scope={scope} summary={summary} extra={['Per-session figures are lifetime totals for that session; the range decides which sessions are listed.']} />
    </>
  );
}

/** Session rows; live sessions open on click, deleted ones stay as history. */
export function SessionList({ sessions, compact }: { sessions: UsageSessionRecord[]; compact?: boolean }) {
  const live = useStore((s) => s.sessions);
  const setActive = useStore((s) => s.setActive);
  if (sessions.length === 0) return <div className="chart-empty">No sessions in this range.</div>;
  const liveIds = new Set(live.map((s) => s.id));
  return (
    <div className={`slist ${compact ? 'compact' : ''}`} role="table">
      {!compact && (
        <div className="slist-row slist-head" role="row">
          <span>Session</span>
          <span className="num">Spend</span>
          <span className="num">Tokens</span>
          <span className="num">Turns</span>
          <span className="num">Tools</span>
          <span className="num">Time</span>
          <span className="num">Speed</span>
        </div>
      )}
      {sessions.map((s) => {
        const isLive = liveIds.has(s.id);
        return (
          <div key={s.id} className={`slist-row ${isLive ? 'live' : 'gone'}`} role="row" tabIndex={isLive ? 0 : -1} onClick={() => isLive && void setActive(s.id)} onKeyDown={(e) => e.key === 'Enter' && isLive && void setActive(s.id)} title={isLive ? 'Open session' : 'Session was deleted; its usage is kept'}>
            <span className="slist-main">
              <span className="slist-title">{s.title}</span>
              <span className="slist-meta">
                <Badge tone="neutral">{harnessShort(s.harness)}</Badge>
                {s.model && <span className="mono">{s.model}</span>}
                <span>{basename(s.projectRoot)}</span>
                <span>{relTime(s.updatedAt)}</span>
                {!isLive && <span className="slist-gone">deleted</span>}
              </span>
            </span>
            <span className="num slist-cost">{fmtCost(s.usage.costUsd)}</span>
            {!compact && (
              <>
                <span className="num" title={`${fmtTokens(s.usage.inputTokens)} in · ${fmtTokens(s.usage.outputTokens)} out · ${fmtTokens(s.usage.cacheReadTokens + s.usage.cacheWriteTokens)} cache`}>
                  {fmtTokens(sessionTokens(s))}
                </span>
                <span className="num">{fmtCompact(s.usage.turns)}</span>
                <span className="num">{fmtCompact(s.toolCalls)}</span>
                <span className="num" title={s.usage.turns > 0 && s.durationMs ? `avg turn ${fmtMs(s.durationMs / s.usage.turns)}` : undefined}>
                  {fmtMs(s.durationMs ?? 0)}
                </span>
                <span className="num">{fmtTps(speedTps(s.speed))}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
