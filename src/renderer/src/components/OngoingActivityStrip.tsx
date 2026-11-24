/**
 * Live ongoing background activity strip anchored at the bottom of the transcript.
 *
 * Keeps two categories visually distinct:
 * - Autonomous harness work (`session.ongoing`: subagents, background commands/tasks, hooks):
 *   active blue spinner signalling that work in this session is still executing and may report
 *   back on its own. Works on desktop and paired remote web shells.
 * - Background OS processes (`processSummary.bySession[session.id]`, desktop-only): quieter
 *   neutral/amber chip shown when the parent turn is not actively running, surfacing detached
 *   jobs, running terminal commands, or lingering child servers without claiming the agent is
 *   still thinking.
 */
import React, { useEffect, useState } from 'react';
import type { OngoingItem, SessionMeta } from '../../../shared/types';
import { ongoingStripHeadline } from '../../../shared/ongoing';
import type { SessionOngoingProcess } from '../../../shared/processes';
import { canInvoke, invoke, isWeb } from '../api';
import { fmtDuration } from '../format';
import { useStore } from '../store';
import { Button, Icon, Spinner } from './ui';

const EMPTY_ONGOING: readonly OngoingItem[] = [];
const EMPTY_PROCS: readonly SessionOngoingProcess[] = [];

function itemIcon(item: OngoingItem): string {
  if (item.kind === 'subagent') return 'fork';
  if (item.kind === 'hook') return 'bolt';
  if (item.detail === 'local_bash') return 'terminal';
  return 'activity';
}

function itemMeta(item: OngoingItem, now: number): string {
  const parts: string[] = [];
  if (item.kind === 'subagent') {
    if (item.turns) parts.push(`${item.turns} ${item.turns === 1 ? 'turn' : 'turns'}`);
    if (item.toolUses) parts.push(`${item.toolUses} ${item.toolUses === 1 ? 'tool' : 'tools'}`);
  } else if (item.kind === 'hook' && item.detail) {
    parts.push(item.detail);
  } else if (item.kind === 'task' && item.detail && item.detail !== 'wakeup') {
    parts.push(item.detail.replace(/_/g, ' '));
  }
  const elapsed = item.startedAt > 0 ? Math.max(0, now - item.startedAt) : 0;
  if (elapsed >= 1_000) parts.push(fmtDuration(elapsed));
  return parts.join(' · ');
}

export function OngoingActivityStrip({ session }: { session: SessionMeta }) {
  const autonomous = session.ongoing ?? EMPTY_ONGOING;
  const sessionProcesses = useStore((s) => (isWeb ? EMPTY_PROCS : (s.processSummary?.bySession?.[session.id] ?? EMPTY_PROCS)));
  const parentRunning = session.status === 'running' || session.status === 'starting';
  // During an active parent turn, live tool cards already represent running shell commands;
  // show notable OS processes once the parent turn is no longer actively running.
  const processes = parentRunning ? EMPTY_PROCS : sessionProcesses;
  const hasAutonomous = autonomous.length > 0;
  const hasProcesses = processes.length > 0;

  const [expanded, setExpanded] = useState(true);
  const [procsExpanded, setProcsExpanded] = useState(false);
  const [stopping, setStopping] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const toast = useStore((s) => s.toast);

  // Tick elapsed durations once per second while anything is live.
  useEffect(() => {
    if (!hasAutonomous && !hasProcesses) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasAutonomous, hasProcesses]);

  if (!hasAutonomous && !hasProcesses) return null;

  const stopSubagent = async (runId: string) => {
    setStopping((prev) => new Set(prev).add(runId));
    try {
      const res = await invoke('subagents:stop', { id: session.id, runId });
      if (!res.ok && res.error) toast(res.error, 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
    }
  };

  const endProcess = async (proc: SessionOngoingProcess) => {
    const key = `proc:${proc.pid}:${proc.startedAt}`;
    setStopping((prev) => new Set(prev).add(key));
    try {
      const res = await invoke('processes:end', { targets: [{ pid: proc.pid, startedAt: proc.startedAt }] });
      if (res.failed.length) toast(res.failed[0]!.error, 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const canInspectSubagent = !isWeb && canInvoke('subagents:list');
  const canStopSubagent = !isWeb && canInvoke('subagents:stop');
  const canManageProcesses = !isWeb && canInvoke('processes:end');

  const earliestAutonomous = hasAutonomous ? Math.min(...autonomous.map((i) => i.startedAt || now)) : 0;
  const autonomousElapsed = earliestAutonomous > 0 && now - earliestAutonomous >= 1_000 ? fmtDuration(now - earliestAutonomous) : '';

  return (
    <div className="ongoing-stack" data-testid="ongoing-activity">
      {hasAutonomous && (
        <div className="ongoing-strip ongoing-autonomous" role="status" aria-live="polite" data-testid="ongoing-autonomous">
          {autonomous.length === 1 ? (
            <div className="ongoing-head">
              <Spinner size={12} />
              <span className="ongoing-headline">{ongoingStripHeadline(autonomous)}</span>
              {autonomous[0]!.label && autonomous[0]!.detail !== 'wakeup' && (
                <span className="ongoing-desc" title={autonomous[0]!.label}>{autonomous[0]!.label}</span>
              )}
              {itemMeta(autonomous[0]!, now) && <span className="ongoing-meta muted small">{itemMeta(autonomous[0]!, now)}</span>}
              <span className="spacer" />
              {!parentRunning && autonomous[0]!.kind !== 'hook' && autonomous[0]!.detail !== 'wakeup' && (
                <span className="ongoing-hint muted small">Will report back</span>
              )}
              {canInspectSubagent && autonomous[0]!.runId && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => useStore.getState().revealSubagentRun(session.id, autonomous[0]!.runId!)}
                  data-testid="ongoing-inspect"
                >
                  Inspect
                </Button>
              )}
              {canStopSubagent && autonomous[0]!.canStop && autonomous[0]!.runId && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="stop"
                  disabled={stopping.has(autonomous[0]!.runId)}
                  onClick={() => void stopSubagent(autonomous[0]!.runId!)}
                  data-testid="ongoing-stop"
                >
                  Stop
                </Button>
              )}
            </div>
          ) : (
            <>
              <button
                type="button"
                className="ongoing-head ongoing-toggle"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                data-testid="ongoing-toggle"
              >
                <Spinner size={12} />
                <span className="ongoing-headline">{ongoingStripHeadline(autonomous)}</span>
                {autonomousElapsed && <span className="ongoing-meta muted small">{autonomousElapsed}</span>}
                <span className="spacer" />
                {!parentRunning && <span className="ongoing-hint muted small">Will report back</span>}
                <Icon name={expanded ? 'chevron' : 'chevronRight'} size={12} />
              </button>
              {expanded && (
                <ul className="ongoing-list">
                  {autonomous.map((item) => (
                    <li key={item.id} className="ongoing-row" data-testid="ongoing-item" data-kind={item.kind}>
                      <Icon name={itemIcon(item)} size={12} />
                      <span className="ongoing-row-name">
                        {item.agent ? <span className="ongoing-agent">{item.agent}</span> : null}
                        <span className="ongoing-desc" title={item.label}>{item.label}</span>
                      </span>
                      {itemMeta(item, now) && <span className="ongoing-meta muted small">{itemMeta(item, now)}</span>}
                      <span className="spacer" />
                      {canInspectSubagent && item.runId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => useStore.getState().revealSubagentRun(session.id, item.runId!)}
                          data-testid="ongoing-inspect"
                        >
                          Inspect
                        </Button>
                      )}
                      {canStopSubagent && item.canStop && item.runId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="stop"
                          disabled={stopping.has(item.runId)}
                          onClick={() => void stopSubagent(item.runId!)}
                          data-testid="ongoing-stop"
                        >
                          Stop
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {hasProcesses && (
        <div className="ongoing-strip ongoing-processes" role="status" data-testid="ongoing-processes">
          {processes.length === 1 ? (
            <div className="ongoing-head">
              <Icon name="activity" size={12} />
              <span className="ongoing-headline">Background process running</span>
              <span className="ongoing-desc mono" title={processes[0]!.command ?? processes[0]!.name}>{processes[0]!.label}</span>
              {processes[0]!.detached && <span className="process-flag">detached</span>}
              {processes[0]!.startedAt > 0 && now - processes[0]!.startedAt >= 1_000 && (
                <span className="ongoing-meta muted small">{fmtDuration(now - processes[0]!.startedAt)}</span>
              )}
              <span className="spacer" />
              <Button size="sm" variant="ghost" onClick={() => useStore.getState().setPanelBottomTab('processes')} data-testid="ongoing-open-processes">
                Processes
              </Button>
              {canManageProcesses && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="x"
                  disabled={stopping.has(`proc:${processes[0]!.pid}:${processes[0]!.startedAt}`)}
                  onClick={() => void endProcess(processes[0]!)}
                  aria-label={`End ${processes[0]!.label}`}
                  title="End this process and everything it started"
                  data-testid="ongoing-end-process"
                />
              )}
            </div>
          ) : (
            <>
              <div className="ongoing-head">
                <button
                  type="button"
                  className="ongoing-toggle-inline"
                  aria-expanded={procsExpanded}
                  onClick={() => setProcsExpanded((v) => !v)}
                  data-testid="ongoing-processes-toggle"
                >
                  <Icon name="activity" size={12} />
                  <span className="ongoing-headline">{processes.length} background processes running</span>
                  <Icon name={procsExpanded ? 'chevron' : 'chevronRight'} size={12} />
                </button>
                <span className="spacer" />
                <Button size="sm" variant="ghost" onClick={() => useStore.getState().setPanelBottomTab('processes')} data-testid="ongoing-open-processes">
                  Processes
                </Button>
              </div>
              {procsExpanded && (
                <ul className="ongoing-list">
                  {processes.map((proc) => {
                    const key = `proc:${proc.pid}:${proc.startedAt}`;
                    return (
                      <li key={key} className="ongoing-row" data-testid="ongoing-process-item" data-pid={proc.pid}>
                        <Icon name={proc.terminalId ? 'terminal' : 'activity'} size={12} />
                        <span className="ongoing-desc mono" title={proc.command ?? proc.name}>{proc.label}</span>
                        {proc.detached && <span className="process-flag">detached</span>}
                        {proc.startedAt > 0 && now - proc.startedAt >= 1_000 && (
                          <span className="ongoing-meta muted small">{fmtDuration(now - proc.startedAt)}</span>
                        )}
                        <span className="spacer" />
                        {canManageProcesses && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="x"
                            disabled={stopping.has(key)}
                            onClick={() => void endProcess(proc)}
                            aria-label={`End ${proc.label}`}
                            title="End this process and everything it started"
                            data-testid="ongoing-end-process"
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
