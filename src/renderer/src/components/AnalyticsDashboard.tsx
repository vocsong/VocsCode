/**
 * Analytics dashboard: spend, tokens, activity, tools and sessions across every session, in tabs
 * that all read the same date range. Data comes from the main-process analytics store and refreshes
 * live while the view is open.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyticsSummary } from '../../../shared/types';
import { invoke, on } from '../api';
import { relTime } from '../format';
import { useStore, type AnalyticsTab } from '../store';
import { ActivityTab } from './analytics/ActivityTab';
import { Segmented } from './analytics/charts';
import { buildScope, RANGES, TABS } from './analytics/model';
import { OverviewTab } from './analytics/OverviewTab';
import { SessionsTab } from './analytics/SessionsTab';
import { SpendTab } from './analytics/SpendTab';
import { TokensTab } from './analytics/TokensTab';
import { ToolsTab } from './analytics/ToolsTab';
import { Button, Icon, Spinner } from './ui';

export function AnalyticsDashboard() {
  const setView = useStore((s) => s.setView);
  const tab = useStore((s) => s.analyticsTab);
  const range = useStore((s) => s.analyticsRange);
  const setAnalyticsView = useStore((s) => s.setAnalyticsView);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const tablist = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await invoke('analytics:summary', { days: range });
      setSummary(s);
      setUpdatedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
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

  const scope = useMemo(() => (summary ? buildScope(summary, range) : null), [summary, range]);

  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next: AnalyticsTab | undefined;
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length].id;
    else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length].id;
    else if (e.key === 'Home') next = TABS[0].id;
    else if (e.key === 'End') next = TABS[TABS.length - 1].id;
    if (!next) return;
    e.preventDefault();
    setAnalyticsView({ tab: next });
    tablist.current?.querySelector<HTMLButtonElement>(`[data-tab='${next}']`)?.focus();
  };

  return (
    <div className="analytics">
      <div className="analytics-top">
        <div className="analytics-title">
          <Button variant="ghost" size="sm" icon="chevronRight" className="rot180" onClick={() => setView('chat')} title="Back" />
          <Icon name="chart" size={16} /> Analytics
        </div>
        <div className="row gap8">
          {updatedAt && (
            <span className="muted small analytics-updated" title="Refreshes automatically while sessions report usage">
              {loading ? 'Refreshing…' : `Updated ${relTime(updatedAt)}`}
            </span>
          )}
          <Segmented value={range} options={RANGES} onChange={(r) => setAnalyticsView({ range: r })} ariaLabel="Date range" />
          <Button size="sm" icon="refresh" onClick={() => void load()} title="Refresh now">
            Refresh
          </Button>
        </div>
      </div>
      <div className="analytics-tabs" role="tablist" aria-label="Analytics sections" ref={tablist} onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" data-tab={t.id} aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} className={`atab ${tab === t.id ? 'active' : ''}`} onClick={() => setAnalyticsView({ tab: t.id })}>
            <Icon name={t.icon} size={14} /> {t.label}
          </button>
        ))}
      </div>
      <div className={`analytics-body ${loading && summary ? 'refetching' : ''}`} role="tabpanel">
        {error && <div className="callout warn">{error}</div>}
        {!summary && !error && (
          <div className="boot">
            <Spinner size={20} /> Loading usage data…
          </div>
        )}
        {summary && scope && (
          <>
            {tab === 'overview' && <OverviewTab scope={scope} summary={summary} />}
            {tab === 'spend' && <SpendTab scope={scope} summary={summary} />}
            {tab === 'tokens' && <TokensTab scope={scope} summary={summary} />}
            {tab === 'activity' && <ActivityTab scope={scope} summary={summary} />}
            {tab === 'tools' && <ToolsTab scope={scope} summary={summary} />}
            {tab === 'sessions' && <SessionsTab scope={scope} summary={summary} />}
          </>
        )}
      </div>
    </div>
  );
}
