import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  KNOWLEDGE_USAGE_LATENCY_MS, KNOWLEDGE_USAGE_SOURCES, KNOWLEDGE_USAGE_WINDOWS,
  type KnowledgeUsageDays, type KnowledgeUsageLatency, type KnowledgeUsageLookup, type KnowledgeUsageOutcome,
  type KnowledgeUsageReport, type KnowledgeUsageSource, type KnowledgeUsageTotals, type RecentKnowledgeLookup
} from '../../../../shared/knowledge-usage';
import { invoke } from '../../api';
import { Badge, Button, Spinner, Toggle } from '../ui';
import { ConfirmAction, InlineError } from './controls';
import { LookupFeedback } from './LookupFeedback';
import { errorMessage, useScopeGuard } from './useIntelligence';

const SOURCE_LABELS: Record<KnowledgeUsageSource, string> = {
  wiki: 'Wiki', memory: 'Memory', history: 'Session history', graph: 'Code graph', collection: 'Collections', passive: 'Passive learning notes'
};
const LOOKUP_LABELS: Record<KnowledgeUsageLookup, string> = {
  intelligence_search: 'Evidence search', context_compile: 'Context packet', memory_recall: 'Memory recall', intelligence_trace: 'Evidence trace',
  knowledge_search: 'Wiki search', knowledge_read: 'Wiki page read', knowledge_related: 'Related wiki pages', session_history_search: 'Session history search'
};
const OUTCOME_LABELS: Record<KnowledgeUsageOutcome, string> = { hit: 'Hit', empty: 'Empty', failed: 'Failed' };
const FEEDBACK_WINDOW_MS = 60 * 60_000;
const count = (n: number) => n.toLocaleString();
const lookupCount = ({ hit, empty, failed }: KnowledgeUsageTotals) => hit + empty + failed;

type Current = () => boolean;
type ReadReport = () => Promise<KnowledgeUsageReport>;

function latency(value: KnowledgeUsageLatency) {
  if (value === null) return 'Not enough samples';
  if (value === 'overflow') return `> ${count(KNOWLEDGE_USAGE_LATENCY_MS.at(-1)!)} ms`;
  return `≤ ${count(value)} ms`;
}

function SurfaceTotals({ title, totals, agent = false }: { title: string; totals: KnowledgeUsageTotals; agent?: boolean }) {
  const heading = useId();
  const total = lookupCount(totals);
  const rated = totals.helped + totals.notHelpful;
  return (
    <section className="intelligence-card" aria-labelledby={heading}>
      <h4 id={heading}>{title}</h4>
      <dl className="knowledge-usage-totals">
        <dt>Hit (with evidence)</dt><dd>{count(totals.hit)} of {count(total)} lookups</dd>
        <dt>Empty</dt><dd>{count(totals.empty)}</dd>
        <dt>Failed</dt><dd>{count(totals.failed)}</dd>
        <dt>Helped</dt><dd>{count(totals.helped)} of {count(rated)} rated</dd>
        <dt>Not helpful</dt><dd>{count(totals.notHelpful)}</dd>
        <dt>Feedback coverage</dt><dd>{count(rated)} of {count(total)} lookups rated</dd>
        <dt>Local lookup p50</dt><dd>{latency(totals.p50)}</dd>
        <dt>Local lookup p95</dt><dd>{latency(totals.p95)}</dd>
        {agent && <><dt>Mean response size</dt><dd>{totals.meanResponseBytes === null ? 'No measured responses' : `${count(totals.meanResponseBytes)} bytes`}</dd></>}
        {totals.staleGraph > 0 && <><dt>Stale graph</dt><dd>{count(totals.staleGraph)}</dd></>}
        {totals.truncated > 0 && <><dt>Truncated</dt><dd>{count(totals.truncated)}</dd></>}
      </dl>
    </section>
  );
}

function SourceBreakdown({ desktop, agent }: Pick<KnowledgeUsageReport, 'desktop' | 'agent'>) {
  const heading = useId();
  return (
    <section className="intelligence-card">
      <h4 id={heading}>Lookups by returned source</h4>
      <p className="muted small">Each count is the number of lookups that returned that source. A lookup can return several sources. These counts don't show which sources were used or helped.</p>
      <table className="knowledge-usage-sources" aria-labelledby={heading}>
        <thead><tr><th scope="col">Source</th><th scope="col">Desktop</th><th scope="col">Agent</th></tr></thead>
        <tbody>
          {KNOWLEDGE_USAGE_SOURCES.map((source) => <tr key={source} className={source === 'passive' ? 'knowledge-usage-passive' : undefined}>
            <th scope="row">{SOURCE_LABELS[source]}</th><td>{count(desktop.sources[source] ?? 0)}</td><td>{count(agent.sources[source] ?? 0)}</td>
          </tr>)}
        </tbody>
      </table>
    </section>
  );
}

/** The parent keys this card by receipt; neither the time nor a vote carries to another lookup. */
function AgentFeedback({ sessionId, lookup, busy, submit }: {
  sessionId: string;
  lookup?: RecentKnowledgeLookup;
  busy: boolean;
  submit: (send: () => Promise<boolean>) => Promise<boolean | undefined>;
}) {
  const expiresAt = lookup ? lookup.endedAt + FEEDBACK_WINDOW_MS : 0;
  const [expired, setExpired] = useState(() => Date.now() >= expiresAt);
  useEffect(() => {
    if (expired) return undefined;
    const timer = setTimeout(() => setExpired(true), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expired, expiresAt]);
  const ended = lookup && !expired ? new Date(lookup.endedAt) : undefined;
  return (
    <section className="intelligence-card">
      <h4>Latest agent lookup in this session</h4>
      {lookup && ended ? <>
        <div className="intelligence-row">
          <span>{LOOKUP_LABELS[lookup.lookup]}</span>
          <Badge>{OUTCOME_LABELS[lookup.outcome]}</Badge>
          <time className="muted small" dateTime={ended.toISOString()}>{ended.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
        </div>
        {!!lookup.sources.length && <p className="muted small">Returned sources: {lookup.sources.map((source) => SOURCE_LABELS[source]).join(', ')}</p>}
        <LookupFeedback sessionId={sessionId} receipt={lookup.receipt} initialVote={lookup.vote} label="Did this agent lookup help?" disabled={busy} submit={submit} />
      </> : <p className="muted small">No recent agent lookup for this session. Refresh after an agent lookup to see it here.</p>}
      <p className="muted small">Feedback is available for up to one hour and only until the app restarts.</p>
    </section>
  );
}

/** Mounted only for the selected Usage tab, within the keyed session subtree. */
export function UsageView({ sessionId }: { sessionId: string }) {
  const capture = useScopeGuard();
  const pending = useRef<Current | null>(null);
  const [days, setDays] = useState<KnowledgeUsageDays>(7);
  const [lastReport, setReport] = useState<KnowledgeUsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const report = lastReport?.days === days ? lastReport : null;

  // Serialize local actions, including the report read after a vote. A pending reply from
  // a closed tab or session never updates state or starts another read.
  const run = useCallback(async function run<T>(work: (current: Current) => Promise<T>) {
    const current = capture();
    if (!current() || pending.current?.()) return undefined;
    pending.current = current;
    setBusy(true);
    try {
      const result = await work(current);
      return current() ? result : undefined;
    } finally {
      if (current()) {
        pending.current = null;
        setBusy(false);
      }
    }
  }, [capture]);

  const applyReport = useCallback(async (current: Current, read: ReadReport) => {
    setError(undefined);
    try {
      const next = await read();
      if (!current()) return false;
      if (!next) throw new Error('Local Knowledge usage is unavailable.');
      setReport(next);
      return true;
    } catch (e) {
      if (current()) setError(errorMessage(e));
      return false;
    }
  }, []);

  const read = useCallback((days: KnowledgeUsageDays) => invoke('intelligence:usage:view', { sessionId, days }), [sessionId]);
  const refresh = useCallback((days: KnowledgeUsageDays) => run((current) => applyReport(current, () => read(days))), [run, applyReport, read]);
  useEffect(() => { void refresh(7); }, [refresh]);

  return (
    <div className="intelligence-panel" data-testid="usage-view">
      <div className="intelligence-view">
        <h3>Local Knowledge usage</h3>
        <section className="intelligence-card">
          {report && <Toggle checked={report.enabled} disabled={busy} label="Track usage for this project" onChange={(enabled) => {
            void run((current) => applyReport(current, () => invoke('intelligence:usage:configure', { sessionId, days, enabled })));
          }} />}
          <p className="muted small">Off by default. If you opt in, only daily aggregates are saved on this computer. No queries, results, or other content are saved in these metrics. They never appear in the web dashboard.</p>
          <p className="muted small">Turning tracking off stops new counting but keeps existing counts. You can clear all usage counts for this project below.</p>
        </section>
        <div className="intelligence-actions knowledge-usage-actions">
          <label className="intelligence-field knowledge-usage-period">Report period
            <select value={days} disabled={busy} onChange={(e) => {
              const next = e.target.value === '30' ? 30 : 7;
              setDays(next);
              void refresh(next);
            }}>
              {KNOWLEDGE_USAGE_WINDOWS.map((days) => <option key={days} value={days}>Last {days} days</option>)}
            </select>
          </label>
          <Button size="sm" icon="refresh" disabled={busy} onClick={() => void refresh(days)}>Refresh</Button>
          {report && <ConfirmAction label="Clear counts" testId="usage-clear" busy={busy}
            detail="Clear all stored usage counts for this project, not just this period. This does not change whether tracking is on."
            onConfirm={async () => (await run((current) => applyReport(current, () => invoke('intelligence:usage:clear', { sessionId, days })))) === true} />}
        </div>
        {busy && <div className="intelligence-row muted small" role="status"><Spinner size={12} /> Updating usage…</div>}
        <InlineError>{error}</InlineError>
        {report && <>
          {report.enabled && <AgentFeedback key={report.recentAgent?.receipt} sessionId={sessionId} lookup={report.recentAgent} busy={busy} submit={(send) => run(async (current) => {
            const accepted = await send();
            if (current() && accepted === true) await applyReport(current, () => read(days));
            return accepted;
          })} />}
          {!lookupCount(report.desktop) && !lookupCount(report.agent) && <p className="muted small">No lookups recorded in this period.</p>}
          <p className="muted small">A hit returned evidence; an empty lookup found none; a failed lookup ended in an error. Feedback counts only explicit votes, not effects on answers.</p>
          <SurfaceTotals title="Desktop Evidence" totals={report.desktop} />
          <SurfaceTotals title="Agent lookups" totals={report.agent} agent />
          <p className="muted small">Latency is local lookup time, shown at the upper bound of a timing bucket. Response size is the mean bytes of local tool text for successful agent lookups, not tokens.</p>
          <SourceBreakdown desktop={report.desktop} agent={report.agent} />
        </>}
      </div>
    </div>
  );
}
