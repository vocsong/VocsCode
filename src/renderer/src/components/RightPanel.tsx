import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FsEntry, SessionMeta } from '../../../shared/types';
import { nativeGoalCommands } from '../../../shared/goal-driver';
import { HARNESS_BY_ID } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { useGitDiff, useGitSummary } from '../gitReads';
import { workspaceRelativePath } from '../file-refs';
import { clamp, relTime } from '../format';
import { installMarkdownHandlers, renderMarkdown } from '../markdown';
import { useStore, type FileReveal, type PanelBottomTab, type PanelTab } from '../store';
import { BranchesTab } from './BranchesTab';
import { DiffView } from './DiffView';
import { GitSetup } from './GitSetup';
import { McpTab } from './McpTab';
import { DesktopTab } from './DesktopTab';
import { KnowledgeTab } from './KnowledgeTab';
import { Resizer, SplitResizer } from './Resizer';
import { SessionUsage } from './SessionUsage';
import { SubagentsTab } from './SubagentsTab';
import { TerminalPanel } from './TerminalPanel';
import { Badge, Button, Field, Icon, Spinner, Toggle } from './ui';

/** Stable fallback so zustand selectors never return a fresh array (React #185 infinite loop). */
const EMPTY: never[] = [];

const TABS: { id: PanelTab; label: string; icon: string }[] = [
  { id: 'changes', label: 'Changes', icon: 'diff' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'branches', label: 'Git', icon: 'branch' },
  { id: 'goal', label: 'Goal', icon: 'target' },
  { id: 'usage', label: 'Usage', icon: 'chart' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' }
];

/** The lower half holds live session services, which is why it gets its own strip. */
const BOTTOM_TABS: { id: PanelBottomTab; label: string; icon: string }[] = [
  { id: 'mcp', label: 'MCP', icon: 'server' },
  { id: 'desktop', label: 'Desktop', icon: 'cpu' },
  { id: 'subagents', label: 'Subagents', icon: 'fork' },
  { id: 'knowledge', label: 'Knowledge', icon: 'book' }
];

export function RightPanel({ session }: { session: SessionMeta }) {
  const tab = useStore((s) => s.panelTab);
  const setTab = useStore((s) => s.setPanelTab);
  const bottomTab = useStore((s) => s.panelBottomTab);
  const openBottom = useStore((s) => s.setPanelBottomTab);
  const togglePanel = useStore((s) => s.togglePanel);
  // The lower half loads a tab the first time it is opened: MCP probes servers, and the Subagents tab
  // lists run files, neither of which should happen for a half the user may never look at. The set of
  // already-opened tabs lives in the store so leaving the chat view (which unmounts this panel) and
  // coming back does not blank the half's still-selected tab.
  const opened = useStore((s) => s.panelBottomOpened);
  return (
    <aside className="panel">
      <div className="panel-section panel-top">
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
          {tab === 'usage' && <UsageTabPanel session={session} />}
          {tab === 'terminal' && <TerminalPanel session={session} />}
        </div>
      </div>
      <SplitResizer />
      <div className="panel-section panel-bottom">
        <div className="panel-tabs">
          {BOTTOM_TABS.map((t) => (
            <button key={t.id} type="button" className={`panel-tab ${bottomTab === t.id ? 'active' : ''}`} onClick={() => openBottom(t.id)} data-testid={`panel-bottom-${t.id}`}>
              <Icon name={t.icon} size={13} /> {t.label}
            </button>
          ))}
          <span className="spacer" />
        </div>
        <div className="panel-body">
          {bottomTab === 'mcp' && opened.includes('mcp') && <McpTab session={session} />}
          {bottomTab === 'desktop' && opened.includes('desktop') && <DesktopTab session={session} />}
          {bottomTab === 'subagents' && opened.includes('subagents') && <SubagentsTab session={session} />}
          {bottomTab === 'knowledge' && opened.includes('knowledge') && <KnowledgeTab session={session} />}
        </div>
      </div>
      <Resizer target="panel" />
    </aside>
  );
}

function ChangesTab({ session }: { session: SessionMeta }) {
  const version = useStore((s) => s.changesVersion);
  const toast = useStore((s) => s.toast);
  const [selection, setSelection] = useState<{ sessionId: string; path: string | null }>({ sessionId: session.id, path: null });
  const selected = selection.sessionId === session.id ? selection.path : null;
  const setSelected = (path: string | null) => setSelection({ sessionId: session.id, path });
  const summaryRead = useGitSummary(session.id, version);
  const diffRead = useGitDiff(session.id, version, selected);
  const summary = summaryRead.data;
  const diff = diffRead.data?.diff ?? '';
  const diffError = diffRead.data?.error;
  const loading = summaryRead.loading || diffRead.loading;
  const [commitMsg, setCommitMsg] = useState('');
  const visit = useRef(0);

  const refresh = (path?: string | null) => {
    summaryRead.refresh();
    diffRead.refresh(path);
  };
  useEffect(() => {
    setSelected(null);
    setCommitMsg('');
    return () => { visit.current++; };
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (summaryRead.error) toast(summaryRead.error.message, 'error');
  }, [summaryRead.error, toast]);
  useEffect(() => {
    if (diffRead.error) toast(diffRead.error.message, 'error');
  }, [diffRead.error, toast]);

  if (summary && !summary.isRepo) return <GitSetup variant="page" session={session} onChanged={() => void refresh()} />;
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
        <Button variant="ghost" size="sm" icon="external" onClick={() => void invoke('app:openInEditor', { path: session.cwd, sessionId: session.id })} title="Open in editor" />
      </div>
      {summary?.error && (
        <div className="callout warn" role="status">
          {summary.error}
        </div>
      )}
      {diffError && diffError !== summary?.error && (
        <div className="callout warn" role="status">
          {diffError}
        </div>
      )}
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
        {loading && !diffRead.data && <Spinner />}
        {!loading && summary && !summary.error && !summaryRead.error && files.length === 0 && <div className="muted pad">Working tree clean.</div>}
        {files.length > 0 && diffRead.data && (
          <DiffView
            diff={diff}
            onRevert={async (p) => {
              const started = visit.current;
              const r = await invoke('git:revert', { sessionId: session.id, path: p });
              if (visit.current !== started) return;
              if (!r.ok) toast(r.error ?? 'Revert failed', 'error');
              else {
                toast(`Reverted ${p}`, 'success');
                setSelected(null);
                refresh(null);
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
    const started = visit.current;
    try {
      const r = await invoke('git:commit', { sessionId: session.id, message: commitMsg.trim() });
      if (visit.current !== started) return;
      toast(r.ok ? 'Committed' : r.output, r.ok ? 'success' : 'error');
      if (r.ok) {
        setCommitMsg('');
        void refresh();
      }
    } catch (e) {
      // Keep the typed message so the user can retry after the IPC failure.
      if (visit.current === started) toast(e instanceof Error ? e.message : String(e), 'error');
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
  const preBody = useRef<HTMLPreElement | null>(null);
  const toast = useStore((s) => s.toast);
  const reveal = useStore((s) => s.fileReveal);
  /** Line to scroll the raw preview to once the file content is on screen. */
  const [scrollLine, setScrollLine] = useState<number | null>(null);
  /** The session this component instance currently belongs to; responses from other sessions are dropped. */
  const liveId = useRef(session.id);
  /** Monotonic read id so a slow earlier read cannot overwrite a file opened after it. */
  const readSeq = useRef(0);
  /** StrictMode runs mount effects twice; the same reveal must not start two reads. */
  const consumedReveal = useRef<FileReveal | null>(null);

  const openFile = async (rel: string, line?: number) => {
    const sid = session.id;
    const seq = ++readSeq.current;
    try {
      const r = await invoke('fs:read', { sessionId: sid, path: rel, maxBytes: 200_000 });
      if (liveId.current !== sid || readSeq.current !== seq) return;
      const p = rel.replace(/\\/g, '/');
      setPreview({ path: p, ...r });
      setMdView(/\.(?:md|markdown)$/i.test(p));
      setScrollLine(line && line > 0 ? line : null);
    } catch (err) {
      if (liveId.current === sid && readSeq.current === seq) toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  useEffect(() => {
    liveId.current = session.id;
    readSeq.current += 1;
    setPath('');
    setEntries([]);
    setPreview(null);
    setMdView(false);
    setScrollLine(null);
  }, [session.id]);
  // A transcript file link asks for one path; list its folder and preview it, then clear the request
  // so remounting the tab does not reopen a file the user has since navigated away from.
  useEffect(() => {
    if (!reveal || reveal.sessionId !== session.id || consumedReveal.current === reveal) return;
    consumedReveal.current = reveal;
    useStore.getState().consumeFileReveal();
    const rel = workspaceRelativePath(session.cwd, reveal.path);
    if (rel === null) {
      toast(`Cannot open files outside ${session.cwd}`, 'error');
      return;
    }
    const dir = /[\\/]$/.test(reveal.path.trim());
    const clean = rel.replace(/\/+$/, '');
    if (dir || clean === '') {
      setPreview(null);
      setPath(clean);
      return;
    }
    const slash = clean.lastIndexOf('/');
    setPath(slash >= 0 ? clean.slice(0, slash) : '');
    void openFile(clean, reveal.line);
  }, [reveal, session.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Once the raw preview is mounted, bring the mentioned line into view. The pre grows with its
  // content, so the panel body is what actually scrolls.
  useEffect(() => {
    if (scrollLine === null) return;
    const pre = preBody.current;
    if (!pre) return;
    const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight) || 18;
    const scroller = pre.closest('.panel-body') as HTMLElement | null;
    const offset = (scrollLine - 1) * lineHeight - (scroller?.clientHeight ?? pre.clientHeight) / 2;
    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      const preTop = pre.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, preTop + offset);
    } else {
      pre.scrollTop = Math.max(0, offset);
    }
    setScrollLine(null);
  }, [scrollLine, preview, mdView]);
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
  const mdHtml = useMemo(() => (isMd && preview ? renderMarkdown(preview.content, { fileLinks: true }) : ''), [isMd, preview]);
  useEffect(() => {
    if (!mdView || !mdBody.current) return;
    return installMarkdownHandlers(
      mdBody.current,
      (url) => void invoke('app:openExternal', { url }),
      (p, line) => useStore.getState().revealFile(session.id, p, line)
    );
  }, [mdView, mdHtml, session.id]);
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
            <Button size="sm" variant="ghost" icon="external" onClick={() => void invoke('app:openInEditor', { path: `${session.cwd}/${preview.path}`, sessionId: session.id })} title="Open in editor" />
            <Button size="sm" variant="ghost" icon="x" onClick={() => setPreview(null)} />
          </div>
          {isMd && mdView ? (
            <div ref={mdBody} className="md file-md" dangerouslySetInnerHTML={{ __html: mdHtml }} />
          ) : (
            <pre className="mono" ref={preBody}>{preview.content}{preview.truncated ? '\n… (truncated)' : ''}</pre>
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
                else void openFile(e.path);
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
  // The harness owns `/goal` in this session, so there is no app-side goal to drive: show who has it
  // instead of controls that would start a second, competing goal.
  if (session.nativeGoal) return <NativeGoalTab session={session} />;
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

/**
 * The Goal panel for a session whose harness answers `/goal` itself. The harness keeps its goal state
 * to itself, so the panel shows what the app does own: the goal commands this session sent, read back
 * out of the transcript (the creation kickoff and every composer send both land there as a user item),
 * and the harness's own answer to the latest one. No controls — the app runs no goal here.
 */
function NativeGoalTab({ session }: { session: SessionMeta }) {
  const command = session.nativeGoal as string;
  const items = useStore((s) => s.transcripts[session.id] ?? EMPTY);
  // The transcript arrives on an async load, so on first paint it is empty for a session that does
  // have goal commands. Claiming "none sent yet" then would state something the panel cannot know.
  const loaded = useStore((s) => s.loaded[session.id] === true);
  const sent = useMemo(() => nativeGoalCommands(items, command), [items, command]);
  const latest = sent[sent.length - 1];
  const at = useMemo(() => (latest ? items.findIndex((i) => i.id === latest.id) : -1), [items, latest]);
  // Everything the agent has said since the command, as the goal loop works through it.
  const replies = useMemo(() => (at < 0 ? 0 : items.slice(at + 1).filter((i) => i.kind === 'assistant').length), [items, at]);
  // The harness states its goal — status, budget, what it will do next — in the conversation, so its
  // answer to the command is the one place that state reaches the app. Quote the run of messages
  // before the user speaks again; never parse another tool's prose for a status of our own.
  const reply = useMemo(() => {
    if (at < 0) return null;
    for (let i = at + 1; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'user') break;
      if (item.kind === 'assistant' && item.text.trim()) return item.text.trim();
    }
    return null;
  }, [items, at]);
  const busy = session.status === 'running' || session.status === 'awaiting' || session.status === 'starting';
  const line = (c: { command: string; argument: string }) => `${c.command}${c.argument ? ` ${c.argument}` : ''}`;
  return (
    <div className="goal pad">
      <p className="muted small">
        <code>/{command}</code> belongs to {HARNESS_BY_ID[session.config.harness].name} in this session. Typing it in the composer sends the command straight to the harness, which keeps its own goal state — the app's goal engine stays out of the way.
      </p>
      {!loaded ? (
        <Spinner />
      ) : !latest ? (
        <p className="muted small">
          No <code>/{command}</code> command sent in this session yet.
        </p>
      ) : (
        <>
          <Field label="Current goal">
            <div className="mono">{line(latest)}</div>
          </Field>
          <p className="muted small">
            Sent {relTime(latest.ts)} · {replies} agent {replies === 1 ? 'reply' : 'replies'} since{busy ? ' · working on it now' : ''}
          </p>
          {reply && (
            <div className="callout" title={reply}>
              {clamp(reply, 400)}
            </div>
          )}
          {sent.length > 1 && (
            <>
              <div className="muted small">Earlier</div>
              {sent
                .slice(0, -1)
                .reverse()
                .map((c) => (
                  <div key={c.id} className="row gap8">
                    <span className="file-path mono" title={line(c)}>
                      {line(c)}
                    </span>
                    <span className="muted small">{relTime(c.ts)}</span>
                  </div>
                ))}
            </>
          )}
        </>
      )}
      <p className="muted small">Turn off <strong>Prefer a harness's own /goal</strong> under Settings → Goal defaults to give the command back to the app.</p>
    </div>
  );
}

/** Subscribes the Usage dashboard to the live transcript; the dashboard itself stays a pure view. */
function UsageTabPanel({ session }: { session: SessionMeta }) {
  const items = useStore((s) => s.transcripts[session.id] ?? EMPTY);
  return <SessionUsage session={session} items={items} />;
}
