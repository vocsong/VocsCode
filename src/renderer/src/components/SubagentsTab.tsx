/**
 * The Subagents tab: what each subagent run did, and what it cost.
 *
 * Runs belong to the session but deliberately stay out of its transcript, so this reads the run files
 * through IPC and refreshes on the live `subagent.run` events the harness reports. What a harness
 * supports varies — `subagentSupport` is the one answer, shared with the main process — so Stop/Steer
 * and the Agents view appear only where they would really work; a harness with no runs at all shows
 * an explanation rather than an empty pane.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { SessionMeta } from '../../../shared/types';
import { subagentSupport, type SubagentCall, type SubagentRun, type SubagentRunSummary } from '../../../shared/subagents';
import { invoke, on } from '../api';
import { fmtCost, fmtDuration, fmtTokens } from '../format';
import { useStore } from '../store';
import { Badge, Button, Icon, Spinner } from './ui';
import { SubagentAgents } from './SubagentAgents';

const LIVE_REFRESH_MS = 400;
/** Bursts of activity (a tool call starting and ending) collapse into one refetch. */
function useLiveRuns(sessionId: string, reload: () => void): void {
  const timer = useRef<number | null>(null);
  useEffect(() => {
    const stop = on('push:sessionEvent', (envelope) => {
      if (envelope.sessionId !== sessionId) return;
      if (envelope.event.type !== 'subagent.run' && envelope.event.type !== 'subagent') return;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        reload();
      }, LIVE_REFRESH_MS);
    });
    return () => {
      stop();
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [sessionId, reload]);
}

const STATUS_TONE: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'neutral'> = {
  completed: 'green',
  error: 'red',
  stopped: 'amber',
  interrupted: 'amber',
  running: 'blue'
};

function statusLabel(status: SubagentRunSummary['status']): string {
  return status === 'running' ? 'running' : status;
}

export function SubagentsTab({ session }: { session: SessionMeta }) {
  const [runs, setRuns] = useState<SubagentRunSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SubagentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [steerText, setSteerText] = useState('');
  const [view, setView] = useState<'runs' | 'agents'>('runs');
  const reveal = useStore((s) => s.subagentReveal);
  const consumeReveal = useStore((s) => s.consumeSubagentReveal);
  const support = subagentSupport(session.config.harness);

  const loadList = React.useCallback(() => {
    if (!support.runs) return;
    void invoke('subagents:list', { id: session.id })
      .then((result) => {
        const list = Array.isArray(result) ? result : [];
        setRuns(list);
        setError(null);
        setSelected((current) => (current && list.some((run) => run.runId === current) ? current : (list[0]?.runId ?? null)));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [session.id, support.runs]);

  useEffect(() => {
    if (!support.runs) {
      setRuns([]);
      return;
    }
    setRuns(null);
    loadList();
  }, [support.runs, loadList]);
  useLiveRuns(session.id, loadList);

  // A transcript tool card can ask for one run by id.
  useEffect(() => {
    if (!reveal || reveal.sessionId !== session.id) return;
    setSelected(reveal.runId);
    consumeReveal();
  }, [reveal, session.id, consumeReveal]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void invoke('subagents:get', { id: session.id, runId: selected })
      .then((run) => {
        if (!cancelled) setDetail(run && typeof run === 'object' ? run : null);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
    // `runs` is the refresh signal: a live event replaces the list, which re-reads the detail too.
  }, [session.id, selected, runs]);

  const stopRun = (runId: string) => {
    void invoke('subagents:stop', { id: session.id, runId }).then((result) => {
      if (!result.ok && result.error) setError(result.error);
    });
  };
  const steerRun = (runId: string) => {
    const message = steerText.trim();
    if (!message) return;
    void invoke('subagents:steer', { id: session.id, runId, message }).then((result) => {
      if (result.ok) setSteerText('');
      else setError(result.error ?? 'Could not steer the run');
    });
  };

  if (!support.runs) {
    return (
      <div className="subagents">
        <div className="panel-empty">
          <Icon name="fork" size={20} />
          <p>This harness does not record subagent runs.</p>
          <p className="muted small">The {session.config.harness} harness has its own way of delegating work, which this panel cannot read.</p>
        </div>
      </div>
    );
  }

  if (runs === null) {
    return (
      <div className="subagents">
        <div className="panel-empty">
          <Spinner size={16} /> Loading runs…
        </div>
      </div>
    );
  }

  return (
    <div className="subagents">
      {support.agents && (
        <div className="subagent-views">
          <button type="button" className={`panel-tab ${view === 'runs' ? 'active' : ''}`} onClick={() => setView('runs')} data-testid="subagent-view-runs">
            Runs
          </button>
          <button type="button" className={`panel-tab ${view === 'agents' ? 'active' : ''}`} onClick={() => setView('agents')} data-testid="subagent-view-agents">
            Agents
          </button>
        </div>
      )}
      {support.agents && view === 'agents' ? (
        <SubagentAgents session={session} />
      ) : (
        <>
      {error && <div className="callout warn small">{error}</div>}
      {runs.length === 0 ? (
        <div className="panel-empty">
          <Icon name="fork" size={20} />
          <p>No subagent runs yet.</p>
          <p className="muted small">When the agent delegates a task, the run, its transcript and its per-call cost appear here.</p>
        </div>
      ) : (
        <div className="subagent-layout">
          <ul className="subagent-list" data-testid="subagent-runs">
            {runs.map((run) => (
              <li key={run.runId}>
                <button type="button" className={`subagent-row ${run.runId === selected ? 'active' : ''}`} onClick={() => setSelected(run.runId)}>
                  <span className="subagent-row-head">
                    <Icon name="fork" size={12} />
                    <span className="subagent-agent">{run.agent}</span>
                    <span className="spacer" />
                    {run.status === 'running' && <Spinner size={11} />}
                    <Badge tone={STATUS_TONE[run.status] ?? 'neutral'}>{statusLabel(run.status)}</Badge>
                  </span>
                  <span className="subagent-desc">{run.description || run.runId}</span>
                    <span className="subagent-meta muted small">
                    {run.mode === 'background' ? 'background · ' : ''}
                    {run.model ?? 'session model'} · {run.turns} turn{run.turns === 1 ? '' : 's'} · {run.toolUses} tool{run.toolUses === 1 ? '' : 's'}
                    {run.costUsd ? ` · ${fmtCost(run.costUsd)}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {detail && (
            <div className="subagent-detail">
              <div className="subagent-detail-head">
                <span className="subagent-agent">{detail.meta.agent}</span>
                <Badge tone={STATUS_TONE[detail.status] ?? 'neutral'}>{statusLabel(detail.status)}</Badge>
                <span className="spacer" />
                {support.control && detail.status === 'running' && <Button size="sm" variant="ghost" icon="stop" onClick={() => stopRun(detail.meta.runId)}>Stop</Button>}
              </div>
              <div className="subagent-detail-stats muted small">
                {detail.meta.provider ? `${detail.meta.provider}/${detail.meta.model ?? ''}` : detail.meta.model ?? 'session model'} · {detail.totals.turns} turn{detail.totals.turns === 1 ? '' : 's'} ·{' '}
                {detail.totals.toolUses} tool{detail.totals.toolUses === 1 ? '' : 's'} · {fmtDuration(detail.totals.durationMs)}
                {detail.totals.costUsd ? ` · ${fmtCost(detail.totals.costUsd)}` : ''}
              </div>
              {detail.error && <div className="callout warn small">{detail.error}</div>}
              {support.control && detail.status === 'running' && (
                <div className="subagent-steer">
                  <input
                    value={steerText}
                    placeholder="Send this run an instruction…"
                    onChange={(e) => setSteerText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') steerRun(detail.meta.runId);
                    }}
                  />
                  <Button size="sm" variant="ghost" icon="send" disabled={!steerText.trim()} onClick={() => steerRun(detail.meta.runId)}>
                    Steer
                  </Button>
                </div>
              )}
              <div className="subagent-transcript">
                {detail.items.length === 0 && <div className="muted small">Nothing recorded yet.</div>}
                {detail.items.map((item) => (
                  <div key={item.id} className={`subagent-item subagent-item-${item.kind}`}>
                    {item.kind === 'tool' ? (
                      <>
                        <span className="subagent-tool-head">
                          <Icon name={item.status === 'done' ? 'check' : item.status === 'error' ? 'x' : 'bolt'} size={11} />
                          <span className="mono">{item.name}</span>
                          {item.summary && <span className="muted small">{item.summary}</span>}
                        </span>
                        {item.output && <pre className="subagent-tool-output mono">{item.output.slice(-4_000)}</pre>}
                      </>
                    ) : (
                      <div className="subagent-text">{item.text ?? item.summary}</div>
                    )}
                  </div>
                ))}
              </div>
              <CallTable calls={detail.calls} />
            </div>
          )}
        </div>
      )}
        </>
      )}
    </div>
  );
}

/** One row per model call: the unit that makes a run's cost explainable. */
function CallTable({ calls }: { calls: SubagentCall[] }) {
  if (calls.length === 0) return null;
  return (
    <table className="subagent-calls">
      <thead>
        <tr>
          <th>#</th>
          <th>Model</th>
          <th className="num">In</th>
          <th className="num">Out</th>
          <th className="num">Cache</th>
          <th className="num">Cost</th>
          <th className="num">Time</th>
          <th>Tools</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((call) => (
          <tr key={call.index}>
            <td>{call.index + 1}</td>
            <td className="mono">{call.model ? `${call.provider ?? ''}/${call.model}` : '—'}</td>
            <td className="num">{fmtTokens(call.inputTokens)}</td>
            <td className="num">{fmtTokens(call.outputTokens)}</td>
            <td className="num">{fmtTokens(call.cacheReadTokens + call.cacheWriteTokens)}</td>
            <td className="num">{call.costUsd ? fmtCost(call.costUsd) : '—'}</td>
            <td className="num">{call.durationMs ? fmtDuration(call.durationMs) : '—'}</td>
            <td className="muted small">{call.toolsInvoked.join(', ') || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
