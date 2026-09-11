import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FsEntry, GitSummary, SessionMeta, TranscriptItem } from '../../../shared/types';
import { invoke } from '../api';
import { fmtCost, fmtDuration, fmtTokens } from '../format';
import { installMarkdownHandlers, renderMarkdown } from '../markdown';
import { useStore, type PanelTab } from '../store';
import { BranchesTab } from './BranchesTab';
import { DiffView } from './DiffView';
import { Resizer } from './Resizer';
import { TerminalPanel } from './TerminalPanel';
import { Badge, Button, EmptyState, Field, Icon, Spinner, Toggle } from './ui';

/** Stable fallback so zustand selectors never return a fresh array (React #185 infinite loop). */
const EMPTY: never[] = [];

const TABS: { id: PanelTab; label: string; icon: string }[] = [
  { id: 'changes', label: 'Changes', icon: 'diff' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'branches', label: 'Branches', icon: 'branch' },
  { id: 'goal', label: 'Goal', icon: 'target' },
  { id: 'usage', label: 'Usage', icon: 'chart' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' }
];

export function RightPanel({ session }: { session: SessionMeta }) {
  const tab = useStore((s) => s.panelTab);
  const setTab = useStore((s) => s.setPanelTab);
  const togglePanel = useStore((s) => s.togglePanel);
  return (
    <aside className="panel">
      <div className="panel-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`panel-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={13} /> {t.label}
            {t.id === 'goal' && session.goal?.status === 'active' && <span className="dot-live" />}
          </button>
        ))}
        <span className="spacer" />
        <Button variant="ghost" size="sm" icon="x" onClick={() => togglePanel(false)} aria-label="Close panel" />
      </div>
      <div className="panel-body">
        {tab === 'changes' && <ChangesTab session={session} />}
        {tab === 'files' && <FilesTab session={session} />}
        {tab === 'branches' && <BranchesTab session={session} />}
        {tab === 'goal' && <GoalTab session={session} />}
        {tab === 'usage' && <UsageTab session={session} />}
        {tab === 'terminal' && <TerminalPanel session={session} />}
      </div>
      <Resizer target="panel" />
    </aside>
  );
}

function ChangesTab({ session }: { session: SessionMeta }) {
  const version = useStore((s) => s.changesVersion);
  const toast = useStore((s) => s.toast);
  const [summary, setSummary] = useState<GitSummary | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  /** The session this component instance currently belongs to; async writes compare against it. */
  const liveId = useRef(session.id);

  const refresh = async () => {
    const sid = session.id;
    setLoading(true);
    try {
      const s = await invoke('git:summary', { sessionId: sid });
      if (liveId.current !== sid) return;
      setSummary(s);
      const d = await invoke('git:diff', { sessionId: sid, path: selected ?? undefined });
      if (liveId.current !== sid) return;
      setDiff(d.diff);
    } catch (e) {
      if (liveId.current === sid) toast(String((e as Error).message ?? e), 'error');
    } finally {
      if (liveId.current === sid) setLoading(false);
    }
  };
  useEffect(() => {
    liveId.current = session.id;
    setSelected(null);
    setDiff('');
    setSummary(null);
  }, [session.id]);
  useEffect(() => {
    void refresh();
  }, [session.id, version, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  if (summary && !summary.isRepo) return <EmptyState icon="branch" title="Not a git repository">Initialize git in this folder to see diffs and revert changes.</EmptyState>;
  const files = summary?.files ?? [];
  return (
    <div className="changes">
      <div className="changes-head">
        <span className="muted small">
          {files.length} changed file{files.length === 1 ? '' : 's'}
          {summary?.branch ? ` on ${summary.branch}` : ''}
          {summary?.ahead ? ` · ↑${summary.ahead}` : ''}
          {summary?.behind ? ` ↓${summary.behind}` : ''}
        </span>
        <span className="spacer" />
        <Button variant="ghost" size="sm" icon="refresh" onClick={() => void refresh()} title="Refresh" />
        <Button variant="ghost" size="sm" icon="external" onClick={() => void invoke('app:openInEditor', { path: session.cwd })} title="Open in editor" />
      </div>
      {files.length > 0 && (
        <div className="file-list">
          <button type="button" className={`file-row ${selected === null ? 'active' : ''}`} onClick={() => setSelected(null)}>
            <span className="file-status all">Σ</span> <span>All changes</span>
          </button>
          {files.map((f) => (
            <button key={f.path} type="button" className={`file-row ${selected === f.path ? 'active' : ''}`} onClick={() => setSelected(f.path)} title={f.path}>
              <span className={`file-status st-${f.status}`}>{f.status}</span>
              <span className="file-path mono">{f.path}</span>
              <span className="diff-stat small">
                {f.additions !== undefined && <span className="add">+{f.additions}</span>} {f.deletions !== undefined && <span className="del">−{f.deletions}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="changes-diff">
        {loading && <Spinner />}
        {!loading && files.length === 0 && <div className="muted pad">Working tree clean.</div>}
        {!loading && files.length > 0 && (
          <DiffView
            diff={diff}
            onRevert={async (p) => {
              const r = await invoke('git:revert', { sessionId: session.id, path: p });
              if (!r.ok) toast(r.error ?? 'Revert failed', 'error');
              else {
                toast(`Reverted ${p}`, 'success');
                setSelected(null);
                void refresh();
              }
            }}
          />
        )}
      </div>
      {files.length > 0 && (
        <div className="commit-box">
          <input placeholder="Commit message" value={commitMsg} onChange={(e) => setCommitMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && commitMsg.trim() && void doCommit()} />
          <Button size="sm" variant="primary" disabled={!commitMsg.trim()} onClick={() => void doCommit()}>
            Commit all
          </Button>
        </div>
      )}
    </div>
  );

  async function doCommit() {
    const r = await invoke('git:commit', { sessionId: session.id, message: commitMsg.trim() });
    toast(r.ok ? 'Committed' : r.output, r.ok ? 'success' : 'error');
    if (r.ok) {
      setCommitMsg('');
      void refresh();
    }
  }
}

function FilesTab({ session }: { session: SessionMeta }) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [preview, setPreview] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  /** Markdown files open in rendered preview; the toggle flips back to the raw text. */
  const [mdView, setMdView] = useState(false);
  const mdBody = useRef<HTMLDivElement | null>(null);
  const toast = useStore((s) => s.toast);
  /** The session this component instance currently belongs to; responses from other sessions are dropped. */
  const liveId = useRef(session.id);
  useEffect(() => {
    liveId.current = session.id;
    setPath('');
    setEntries([]);
    setPreview(null);
    setMdView(false);
  }, [session.id]);
  useEffect(() => {
    const sid = session.id;
    let stale = false;
    invoke('fs:list', { sessionId: sid, relPath: path || undefined })
      .then((list) => {
        if (!stale && liveId.current === sid) setEntries(list);
      })
      .catch((e) => {
        if (!stale && liveId.current === sid) toast(String(e.message ?? e), 'error');
      });
    return () => {
      stale = true;
    };
  }, [session.id, path]); // eslint-disable-line react-hooks/exhaustive-deps
  const isMd = !!preview && /\.(?:md|markdown)$/i.test(preview.path);
  const mdHtml = useMemo(() => (isMd && preview ? renderMarkdown(preview.content) : ''), [isMd, preview]);
  useEffect(() => {
    if (!mdView || !mdBody.current) return;
    return installMarkdownHandlers(mdBody.current, (url) => void invoke('app:openExternal', { url }));
  }, [mdView, mdHtml]);
  const crumbs = path.split(/[\\/]/).filter(Boolean);
  return (
    <div className="files">
      <div className="crumbs">
        <button type="button" onClick={() => setPath('')}>{session.cwd.split(/[\\/]/).pop()}</button>
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            <span className="muted">/</span>
            <button type="button" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
          </React.Fragment>
        ))}
      </div>
      {preview ? (
        <div className="file-preview">
          <div className="file-preview-head">
            <span className="mono">{preview.path}</span>
            <span className="spacer" />
            {isMd && (
              <Button
                size="sm"
                variant="ghost"
                icon={mdView ? 'file' : 'eye'}
                onClick={() => setMdView((v) => !v)}
                title={mdView ? 'Show source' : 'Show markdown preview'}
              />
            )}
            <Button size="sm" variant="ghost" icon="external" onClick={() => void invoke('app:openInEditor', { path: `${session.cwd}/${preview.path}` })} title="Open in editor" />
            <Button size="sm" variant="ghost" icon="x" onClick={() => setPreview(null)} />
          </div>
          {isMd && mdView ? (
            <div ref={mdBody} className="md file-md" dangerouslySetInnerHTML={{ __html: mdHtml }} />
          ) : (
            <pre className="mono">{preview.content}{preview.truncated ? '\n… (truncated)' : ''}</pre>
          )}
        </div>
      ) : (
        <div className="file-list">
          {entries.map((e) => (
            <button
              key={e.path}
              type="button"
              className="file-row"
              onClick={async () => {
                if (e.isDir) setPath(e.path.replace(/\\/g, '/'));
                else {
                  const r = await invoke('fs:read', { sessionId: session.id, path: e.path, maxBytes: 200_000 });
                  const p = e.path.replace(/\\/g, '/');
                  setPreview({ path: p, ...r });
                  setMdView(/\.(?:md|markdown)$/i.test(p));
                }
              }}
            >
              <Icon name={e.isDir ? 'folder' : 'file'} size={13} />
              <span className="file-path">{e.name}</span>
              {!e.isDir && e.size !== undefined && <span className="muted small">{e.size > 1024 ? `${(e.size / 1024).toFixed(1)} KB` : `${e.size} B`}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GoalTab({ session }: { session: SessionMeta }) {
  const g = session.goal;
  const [objective, setObjective] = useState(g?.objective ?? '');
  const [maxIter, setMaxIter] = useState(String(g?.maxIterations ?? 25));
  useEffect(() => {
    setObjective(g?.objective ?? '');
    setMaxIter(String(g?.maxIterations ?? 25));
  }, [g?.objective, g?.maxIterations]);
  const act = (action: 'set' | 'pause' | 'resume' | 'clear' | 'complete' | 'update', extra: { objective?: string; autoContinue?: boolean; maxIterations?: number } = {}) => void invoke('sessions:goal', { id: session.id, action, ...extra });
  return (
    <div className="goal pad">
      <p className="muted small">A goal keeps the session working until the agent proves completion (it must end a reply with <code>GOAL_COMPLETE</code>) or the iteration guard stops it. Modeled on Codex's <code>/goal</code>, available for every harness.</p>
      <Field label="Objective">
        <textarea rows={4} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Describe the outcome, not the steps" />
      </Field>
      <div className="row gap12">
        <Field label="Iteration guard">
          <input type="number" min={1} max={500} value={maxIter} onChange={(e) => setMaxIter(e.target.value)} />
        </Field>
        {g && (
          <Field label="Status">
            <div className="row gap6">
              <Badge tone={g.status === 'active' ? 'green' : g.status === 'complete' ? 'blue' : 'amber'}>{g.status}</Badge>
              <span className="muted small">{g.iterations}/{g.maxIterations} continuations</span>
            </div>
          </Field>
        )}
      </div>
      {g && <Toggle checked={g.autoContinue} onChange={(v) => act('update', { autoContinue: v })} label="Auto-continue after each turn" />}
      <div className="row gap8 wrap">
        <Button variant="primary" icon="target" disabled={!objective.trim()} onClick={() => act('set', { objective, maxIterations: Number(maxIter) || 25 })}>
          {g ? 'Restart goal' : 'Set goal'}
        </Button>
        {g?.status === 'active' && <Button icon="pause" onClick={() => act('pause')}>Pause</Button>}
        {g?.status === 'paused' && <Button icon="play" onClick={() => act('resume')}>Resume</Button>}
        {g && g.status !== 'complete' && <Button icon="check" onClick={() => act('complete')}>Mark complete</Button>}
        {g && <Button variant="ghost" icon="trash" onClick={() => act('clear')}>Clear</Button>}
      </div>
    </div>
  );
}

function UsageTab({ session }: { session: SessionMeta }) {
  const items = useStore((s) => s.transcripts[session.id] ?? EMPTY);
  const turns = useMemo(() => items.filter((i): i is Extract<TranscriptItem, { kind: 'turn' }> => i.kind === 'turn'), [items]);
  const u = session.usage;
  const ctxPct = u.contextWindow && u.contextTokens ? Math.min(100, (u.contextTokens / u.contextWindow) * 100) : null;
  const maxCost = Math.max(0.0001, ...turns.map((t) => t.costUsd ?? 0));
  return (
    <div className="usage pad">
      <div className="stat-grid">
        <Stat label="Cost" value={fmtCost(u.costUsd)} />
        <Stat label="Turns" value={String(u.turns)} />
        <Stat label="Input" value={fmtTokens(u.inputTokens)} />
        <Stat label="Output" value={fmtTokens(u.outputTokens)} />
        <Stat label="Cache read" value={fmtTokens(u.cacheReadTokens)} />
        <Stat label="Cache write" value={fmtTokens(u.cacheWriteTokens)} />
        {u.reasoningTokens > 0 && <Stat label="Reasoning" value={fmtTokens(u.reasoningTokens)} />}
      </div>
      {ctxPct !== null && (
        <div className="ctx-usage">
          <div className="row">
            <span>Context window</span>
            <span className="spacer" />
            <span className="muted small">{fmtTokens(u.contextTokens)} / {fmtTokens(u.contextWindow)} ({ctxPct.toFixed(0)}%)</span>
          </div>
          <div className="bar">
            <span style={{ width: `${ctxPct}%` }} className={ctxPct > 85 ? 'hot' : ''} />
          </div>
        </div>
      )}
      {session.config.maxBudgetUsd && (
        <div className="callout">
          Budget cap ${session.config.maxBudgetUsd.toFixed(2)} · {((u.costUsd / session.config.maxBudgetUsd) * 100).toFixed(0)}% used
        </div>
      )}
      <h4>Per turn</h4>
      {turns.length === 0 && <div className="muted small">No completed turns yet.</div>}
      <div className="turn-bars">
        {turns.slice(-40).map((t) => (
          <div key={t.id} className="turn-bar-row" title={`${fmtDuration(t.durationMs)} · ${fmtCost(t.costUsd)} · ${fmtTokens(t.usage?.inputTokens)} in / ${fmtTokens(t.usage?.outputTokens)} out`}>
            <span className={`turn-bar-status st-${t.status}`} />
            <span className="turn-bar">
              <span style={{ width: `${Math.max(2, ((t.costUsd ?? 0) / maxCost) * 100)}%` }} />
            </span>
            <span className="muted small mono">{fmtCost(t.costUsd)} · {fmtDuration(t.durationMs)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
