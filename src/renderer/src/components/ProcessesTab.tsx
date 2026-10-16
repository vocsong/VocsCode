/**
 * The Processes tab: every OS process Vocs Code started — through any session, terminal or tool,
 * in any worktree — in one place, so nothing the app spawned can keep holding CPU and memory
 * unseen. Processes left behind (their Vocs Code parent exited, or an earlier run quit or crashed)
 * come first, then the active session, other sessions and the app's own services. Ending a row
 * ends everything under it; the main process re-checks each target, so a stale row cannot end a
 * process the app did not start.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionMeta } from '../../../shared/types';
import { describeProcess, groupProcesses, processKey, rootsOf, type ProcessGroup, type ProcessList, type ProcessTarget, type TrackedProcess } from '../../../shared/processes';
import { invoke } from '../api';
import { basename, fmtBytes, fmtUptime } from '../format';
import { useStore } from '../store';
import { Button, Icon, Spinner } from './ui';

const POLL_MS = 2_000;
/** A second click within this window confirms ending a whole group. */
const CONFIRM_MS = 4_000;

function fmtCpu(cpu: number | undefined): string {
  if (cpu === undefined) return '—';
  return cpu >= 10 ? `${Math.round(cpu)}%` : `${cpu.toFixed(1)}%`;
}

function target(p: TrackedProcess): ProcessTarget {
  return { pid: p.pid, startedAt: p.startedAt };
}

export function ProcessesTab({ session }: { session: SessionMeta }) {
  const sessions = useStore((s) => s.sessions);
  const setActive = useStore((s) => s.setActive);
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<ProcessList | null>(null);
  const [ending, setEnding] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await invoke('processes:list', undefined));
    } catch (e) {
      setList({ sampledAt: Date.now(), processes: [], error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    let live = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || !live) return;
      inFlight = true;
      try {
        await load();
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(null), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirm]);

  const groups = useMemo(() => groupProcesses(list?.processes ?? [], session.id), [list, session.id]);
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const end = async (keys: string[], targets: ProcessTarget[]) => {
    setEnding((prev) => new Set([...prev, ...keys]));
    try {
      const result = await invoke('processes:end', { targets });
      if (result.failed.length) toast(`Could not end ${result.failed.length} process${result.failed.length === 1 ? '' : 'es'}: ${result.failed[0].error}`, 'error');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setEnding((prev) => {
        const next = new Set(prev);
        for (const key of keys) next.delete(key);
        return next;
      });
    }
  };

  const endGroup = (group: ProcessGroup) => {
    if (confirm !== group.key) {
      setConfirm(group.key);
      return;
    }
    setConfirm(null);
    const roots = rootsOf(group.rows);
    void end([group.key, ...roots.map(processKey)], roots.map(target));
  };

  if (!list) {
    return (
      <div className="mcp-loading">
        <Spinner size={14} /> Reading processes…
      </div>
    );
  }

  const shown = list.processes;
  const totalCpu = shown.reduce((sum, p) => sum + (p.cpu ?? 0), 0);
  const totalMemory = shown.reduce((sum, p) => sum + (p.memory ?? 0), 0);

  return (
    <div className="processes" data-testid="processes-tab">
      <div className="changes-head">
        <span className="muted small" data-testid="processes-summary">
          {shown.length} process{shown.length === 1 ? '' : 'es'} · {fmtCpu(totalCpu)} CPU · {fmtBytes(totalMemory)}
        </span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => void load()} aria-label="Refresh processes" title="Refresh" />
      </div>
      {list.error && <div className="callout warn small">{list.error}</div>}
      {!list.error && shown.length === 0 && (
        <div className="panel-empty">
          <Icon name="activity" size={20} />
          <p>Nothing running.</p>
          <p className="muted small">Agents, tools, terminals and servers that Vocs Code starts — in any session or worktree — appear here until they exit.</p>
        </div>
      )}
      {groups.map((group) => {
        const owner = group.sessionId ? sessionsById.get(group.sessionId) : undefined;
        const title =
          group.kind === 'orphaned' ? 'Left behind' : group.kind === 'app' ? 'Vocs Code' : owner?.title || 'Deleted session';
        const detail =
          group.kind === 'orphaned'
            ? 'Their Vocs Code parent has exited, so nothing will stop them'
            : group.kind === 'app'
              ? 'App services and tools'
              : owner
                ? [owner.worktreeBranch, basename(owner.cwd)].filter(Boolean).join(' · ')
                : 'This session no longer exists';
        const busy = ending.has(group.key);
        return (
          <section key={group.key} className={`process-group process-group-${group.kind}`} data-testid={`process-group-${group.kind}`}>
            <div className="process-group-head">
              <Icon name={group.kind === 'orphaned' ? 'alert' : group.kind === 'app' ? 'cube' : 'terminal'} size={13} />
              <span className="process-group-label">
                <span className="process-group-title">
                  {group.kind === 'session' && owner && owner.id !== session.id ? (
                    <button type="button" className="process-session-link" onClick={() => void setActive(owner.id)} title="Open this session">
                      {title}
                    </button>
                  ) : (
                    title
                  )}
                  {group.sessionId === session.id && <span className="muted small"> (this session)</span>}
                </span>
                <span className="process-group-detail muted small" title={detail}>
                  {detail}
                </span>
              </span>
              <span className="process-stats muted small">
                {group.rows.length} · {fmtCpu(group.cpu)} · {fmtBytes(group.memory)}
              </span>
              <Button
                size="sm"
                variant={confirm === group.key ? 'danger' : 'ghost'}
                icon="stop"
                disabled={busy}
                onClick={() => endGroup(group)}
                data-testid={`process-group-end-${group.kind}`}
                title={`End every process in this group (${group.rows.length})`}
              >
                {confirm === group.key ? 'Confirm' : 'End all'}
              </Button>
            </div>
            <ul className="process-rows">
              {group.rows.map(({ process: p, depth }) => {
                const key = processKey(p);
                // A label belongs to the root the app started (a terminal tab, an app service), never to its children.
                const name = p.owner.label ? (p.owner.terminalId ? `Terminal · ${p.owner.label}` : p.owner.label) : describeProcess(p);
                const formerOwner = group.kind === 'orphaned' && depth === 0 && p.owner.sessionId ? sessionsById.get(p.owner.sessionId)?.title : undefined;
                return (
                  <li key={key} className="process-row" style={{ paddingLeft: 8 + Math.min(depth, 6) * 14 }} title={p.command ?? p.name} data-testid="process-row" data-pid={p.pid}>
                    <span className="process-main">
                      <span className="process-name">{name}</span>
                      <span className="process-meta muted small mono">
                        {p.name} · {p.pid}
                        {p.startedAt ? ` · ${fmtUptime(list.sampledAt - p.startedAt)}` : ''}
                        {p.previousRun && depth === 0 ? ' · earlier run' : ''}
                        {formerOwner ? ` · from ${formerOwner}` : ''}
                      </span>
                    </span>
                    <span className="process-stats muted small mono">{fmtCpu(p.cpu)}</span>
                    <span className="process-stats muted small mono">{fmtBytes(p.memory)}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="x"
                      disabled={ending.has(key) || busy}
                      onClick={() => void end([key], [target(p)])}
                      aria-label={`End ${name}`}
                      title="End this process and everything it started"
                      data-testid="process-end"
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
