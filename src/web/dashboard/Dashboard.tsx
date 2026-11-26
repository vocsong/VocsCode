/**
 * The code.vocs.io dashboard (docs/WEB-DASHBOARD.md §2): every computer's uploaded analytics in the
 * desktop's own tabs, for all computers together or one at a time. Totals add up across
 * computers; reliability and code-output reports cannot, so "All computers" shows them per computer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyticsRange, AnalyticsTab } from '@renderer/store';
import { AnalyticsTabBody, AnalyticsTabs } from '@renderer/components/analytics/AnalyticsView';
import { ChartCard, ColumnChart, Segmented } from '@renderer/components/analytics/charts';
import { CodeTab } from '@renderer/components/analytics/CodeTab';
import { AnalyticsEnvProvider, type AnalyticsEnv } from '@renderer/components/analytics/env';
import { buildScope, METRICS, RANGES, TABS, type ChartSeries, type Metric, type Scope } from '@renderer/components/analytics/model';
import { OverviewTab } from '@renderer/components/analytics/OverviewTab';
import { ReliabilityTab } from '@renderer/components/analytics/ReliabilityTab';
import { SpendTab } from '@renderer/components/analytics/SpendTab';
import { TokensTab } from '@renderer/components/analytics/TokensTab';
import { ActivityTab } from '@renderer/components/analytics/ActivityTab';
import { Icon, Spinner } from '@renderer/components/ui';
import { fmtCost, relTime } from '@renderer/format';
import type { AnalyticsSummary } from '@shared/types';
import { combineSnapshots, type ComputerAnalytics } from '@shared/analytics/combine';
import { emptyCodeOutputReport } from '@shared/analytics/code-output';
import { emptyReliabilityReport } from '@shared/analytics/reliability';
import { DashboardLoader, type DashboardData, type LoadedComputer } from './data';

/** A computer that is online but has not synced for this long is flagged. */
export const STALE_MS = 24 * 60 * 60_000;
const REFRESH_MS = 60_000;

type Selection = 'all' | string;

function computerColor(index: number): string {
  return `var(--chart-${(index % 6) + 1})`;
}

function syncLine(c: LoadedComputer, now: number): { text: string; stale: boolean } {
  if (c.error) return { text: `Could not read: ${c.error}`, stale: true };
  if (!c.host.manifest || c.host.receivedAt === null) return { text: 'Not sharing analytics yet', stale: false };
  const stale = c.host.online && now - c.host.receivedAt > STALE_MS;
  return { text: `Synced ${relTime(c.host.receivedAt)}`, stale };
}

function ComputerCards({ data, selected, onSelect, perComputer, range, now }: { data: DashboardData; selected: Selection; onSelect: (s: Selection) => void; perComputer: Map<string, ComputerAnalytics>; range: AnalyticsRange; now: number }) {
  return (
    <ul className="w-computers" role="list" aria-labelledby="computers-title">
      {data.computers.map((c, i) => {
        const sync = syncLine(c, now);
        const summary = perComputer.get(c.host.hostId)?.summary;
        const active = selected === c.host.hostId;
        const className = `v-card w-computer${sync.stale ? ' is-stale' : ''}`;
        const details = (
          <>
            <span className="w-computer-head">
              <span className="w-computer-swatch" data-slot={(i % 6) + 1} aria-hidden="true" />
              <span className="w-computer-name" title={c.host.name}>{c.host.name}</span>
              <span className={`v-badge${c.host.online ? ' v-badge-live' : ''}`}>{c.host.online ? 'Online' : 'Offline'}</span>
            </span>
            <span className="w-computer-meta">
              {c.host.platform && <span>{c.host.platform}</span>}
              {c.host.manifest?.appVersion && <span>v{c.host.manifest.appVersion}</span>}
            </span>
            <span className="w-computer-sync" data-testid="computer-sync">{sync.text}{sync.stale && c.host.online && !c.error ? ' · stale' : ''}</span>
            {summary && (
              <span className="w-computer-figure">
                <span className="v-num w-computer-spend" data-testid="computer-spend">{fmtCost(buildScope(summary, range, now).totals.costUsd)}</span>
                <span className="w-computer-meta">Spend</span>
              </span>
            )}
          </>
        );
        return (
          <li key={c.host.hostId}>
            {summary ? (
              <button type="button" data-testid="computer-card" className={className} aria-pressed={active} onClick={() => onSelect(active ? 'all' : c.host.hostId)}>
                {details}
              </button>
            ) : <div data-testid="computer-card" className={className}>{details}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** One series per computer for a metric, on the combined view's calendar. */
function computerSeries(scope: Scope, computers: ComputerAnalytics[], order: string[], metric: Metric, now: number): ChartSeries[] {
  const m = METRICS[metric];
  return computers.map((c) => {
    const own = new Map(buildScope(c.summary, scope.range, now).days.map((d) => [d.date, m.of(d.usage)]));
    return { key: c.hostId, label: c.name, color: computerColor(order.indexOf(c.hostId)), values: scope.days.map((d) => own.get(d.date) ?? 0) };
  });
}

function ByComputerCard({ scope, computers, order, metric, now }: { scope: Scope; computers: ComputerAnalytics[]; order: string[]; metric: Metric; now: number }) {
  const m = METRICS[metric];
  const series = computerSeries(scope, computers, order, metric, now);
  return (
    <ChartCard title={`${m.label} by computer`} subtitle={scope.label} wide>
      <div data-testid="by-computer">
        <ColumnChart dates={scope.days.map((d) => d.date)} series={series} format={m.fmt} axis={m.axis} integer={metric === 'turns'} ariaLabel={`${m.label} per day by computer`} />
      </div>
    </ChartCard>
  );
}

/** Reports that cannot be added together, shown one computer after another. */
function PerComputer({ computers, range, now, render }: { computers: ComputerAnalytics[]; range: AnalyticsRange; now: number; render: (scope: Scope, summary: AnalyticsSummary) => React.ReactNode }) {
  if (computers.length === 0) return <div className="chart-empty">No computer has shared analytics yet.</div>;
  return (
    <>
      <p className="muted small w-per-computer-note">These figures are rates and percentiles that do not add up across computers, so each computer is shown on its own.</p>
      {computers.map((c) => (
        <section key={c.hostId} className="w-per-computer" data-testid="per-computer-section">
          <h2 className="w-per-computer-title">{c.name}</h2>
          {render(buildScope(c.summary, range, now), c.summary)}
        </section>
      ))}
    </>
  );
}

export function Dashboard({ loader = new DashboardLoader(), now: nowFn = Date.now }: { loader?: DashboardLoader; now?: () => number }) {
  const loaderRef = useRef(loader);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Selection>('all');
  const [range, setRange] = useState<AnalyticsRange>(30);
  const [tab, setTab] = useState<AnalyticsTab>('overview');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loaderRef.current.load());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const now = nowFn();
  const shared = useMemo(() => (data?.computers ?? []).filter((c): c is LoadedComputer & { snapshot: NonNullable<LoadedComputer['snapshot']> } => !!c.snapshot), [data]);
  const order = useMemo(() => (data?.computers ?? []).map((c) => c.host.hostId), [data]);
  // A computer that left the account takes the selection with it.
  const selection: Selection = selected !== 'all' && !shared.some((c) => c.host.hostId === selected) ? 'all' : selected;

  // Every computer is summarized once per data/range change; the selection only picks from it.
  const combined = useMemo(
    () => (data ? combineSnapshots(shared.map((c) => ({ hostId: c.host.hostId, name: c.host.name, snapshot: c.snapshot })), range, now) : null),
    [data, shared, range] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const perComputer = useMemo(() => new Map((combined?.computers ?? []).map((c) => [c.hostId, c])), [combined]);
  const view = useMemo(() => {
    if (!combined) return null;
    if (selection !== 'all') {
      const one = perComputer.get(selection)!;
      return { summary: one.summary, computers: [one], combined: false };
    }
    const summary: AnalyticsSummary = { ...combined.summary, reliability: emptyReliabilityReport(now, range), codeOutput: emptyCodeOutputReport(now, range) };
    return { summary, computers: combined.computers, combined: true };
  }, [combined, perComputer, selection]); // eslint-disable-line react-hooks/exhaustive-deps
  const scope = useMemo(() => (view ? buildScope(view.summary, range, now) : null), [view, range]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = useMemo(() => new Map((data?.computers ?? []).map((c) => [c.host.hostId, c.host.name])), [data]);
  const env: AnalyticsEnv = useMemo(
    () => ({
      drillDown: false,
      liveSessions: false,
      // Combined session ids are `<hostId>:<id>`; a single computer's are its own.
      computerOf: (s) => (selection === 'all' ? names.get(s.id.slice(0, s.id.indexOf(':'))) : undefined)
    }),
    [names, selection]
  );

  const replace = useMemo(() => {
    if (!view?.combined || !scope) return undefined;
    const by = (metric: Metric) => <ByComputerCard scope={scope} computers={view.computers} order={order} metric={metric} now={now} />;
    return {
      overview: <OverviewTab scope={scope} summary={view.summary} afterStats={by('cost')} />,
      spend: <>{by('cost')}<SpendTab scope={scope} summary={view.summary} /></>,
      tokens: <>{by('tokens')}<TokensTab scope={scope} summary={view.summary} /></>,
      activity: <>{by('turns')}<ActivityTab scope={scope} summary={view.summary} /></>,
      reliability: <PerComputer computers={view.computers} range={range} now={now} render={(s, summary) => <ReliabilityTab scope={s} summary={summary} />} />,
      code: <PerComputer computers={view.computers} range={range} now={now} render={(s, summary) => <CodeTab scope={s} summary={summary} />} />
    };
  }, [view, scope, order, range]); // eslint-disable-line react-hooks/exhaustive-deps

  const switcher = [{ value: 'all', label: 'All computers' }, ...shared.map((c) => ({ value: c.host.hostId, label: c.host.name }))];

  return (
    <div className="w-dashboard" data-testid="dashboard">
      <header className="v-page-head w-page-head">
        <div>
          <p className="v-eyebrow v-eyebrow-sm">Your workspace</p>
          <h1 className="v-display-m">Analytics</h1>
          <p className="v-text">Usage and spend across your Vocs Code computers.</p>
        </div>
        <div className="w-refresh">
          {data && <span className="v-micro analytics-updated" role="status">{loading ? 'Refreshing…' : `Updated ${relTime(data.loadedAt)}`}</span>}
          <button type="button" className="v-btn v-btn-secondary v-btn-sm" onClick={() => void load()} disabled={loading} title="Refresh now">
            <Icon name="refresh" size={15} /> Refresh
          </button>
        </div>
      </header>
      {error && <div className="v-note v-note-danger" role="alert"><Icon name="alert" size={18} /><span>Could not refresh analytics. {error}</span></div>}
      {!data && !error && (
        <div className="v-card w-empty w-loading" role="status">
          <Spinner size={18} /> Loading your computers…
        </div>
      )}
      {data && data.computers.length === 0 && (
        <section className="v-card w-empty" data-testid="dashboard-empty">
          <span className="v-glyph v-glyph-lg"><Icon name="monitor" size={22} /></span>
          <h2 className="v-title">No computers yet</h2>
          <p className="v-text">Open Vocs Code on a computer, go to <strong>Settings → MCP control</strong> (<strong>Remote access</strong> in older versions) and click <strong>Connect with Vocs</strong>. Its analytics appear here a few seconds later.</p>
        </section>
      )}
      {data && data.computers.length > 0 && (
        <>
          <div className="w-dashboard-controls">
            {shared.length > 1 && <div className="w-filter"><span aria-hidden="true">Computer</span><Segmented value={selection} options={switcher} onChange={setSelected} ariaLabel="Computer" /></div>}
            <div className="w-filter"><span aria-hidden="true">Date range</span><Segmented value={range} options={RANGES} onChange={setRange} ariaLabel="Date range" /></div>
          </div>
          <section className="w-device-section" aria-labelledby="computers-title">
            <div className="w-section-head">
              <h2 className="v-title" id="computers-title">Computers</h2>
              <span className="v-micro">{shared.length} of {data.computers.length} sharing analytics</span>
            </div>
            <ComputerCards data={data} selected={selection} onSelect={setSelected} perComputer={perComputer} range={range} now={now} />
          </section>
          {shared.length === 0 ? (
            <section className="v-card w-empty" data-testid="dashboard-waiting">
              <span className="v-glyph v-glyph-lg"><Icon name="chart" size={22} /></span>
              <h2 className="v-title">Waiting for analytics</h2>
              <p className="v-text">None of your computers has shared analytics yet. Update Vocs Code on them and keep <strong>Share analytics with code.vocs.io</strong> on in Settings → MCP control (Remote access in older versions).</p>
            </section>
          ) : (
            view && scope && (
              <AnalyticsEnvProvider value={env}>
                <AnalyticsTabs tab={tab} onTab={setTab} />
                <div className="analytics-body" role="tabpanel" aria-label={TABS.find((item) => item.id === tab)?.label} aria-busy={loading}>
                  <AnalyticsTabBody tab={tab} scope={scope} summary={view.summary} replace={replace} />
                </div>
              </AnalyticsEnvProvider>
            )
          )}
        </>
      )}
    </div>
  );
}
