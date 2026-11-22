/**
 * Right-panel Layer 2 view for the current project: the wiki that is ingested automatically as the
 * user works, with its labels and relation graph, and the two background jobs that maintain it.
 * Layer 2 is browsed and corrected here — rejecting tombstones a claim, deleting removes a page —
 * but nothing waits on a human to become servable.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPendingStatus, type KnowledgeGraph, type KnowledgeJobState, type KnowledgePageDetail, type KnowledgePageSummary, type KnowledgeView } from '../../../shared/knowledge';
import type { SessionMeta } from '../../../shared/types';
import { invoke } from '../api';
import { installMarkdownHandlers, renderMarkdown } from '../markdown';
import { useStore } from '../store';
import { Badge, Button, EmptyState, Icon, Spinner, Toggle } from './ui';

function statusTone(status: KnowledgePageSummary['status']): 'green' | 'amber' | 'red' | 'neutral' | 'blue' {
  if (status === 'current') return 'green';
  if (isPendingStatus(status)) return 'amber';
  if (status === 'superseded' || status === 'deprecated') return 'red';
  if (status === 'uncertain') return 'blue';
  return 'neutral';
}

function authorityLabel(page: KnowledgePageSummary): string {
  if (page.authority <= 2) return 'human-reviewed';
  if (page.status === 'current') return 'accepted';
  return page.status;
}

/** \u0001/\u0002 markers from main's snippetFor() render as React <mark> nodes (never raw HTML). */
function HighlightedSnippet({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/[\u0001\u0002]/), [text]);
  return (
    <>
      {parts.map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : <React.Fragment key={index}>{part}</React.Fragment>))}
    </>
  );
}

/** Normalized tags, rendered the same way in a list row and a detail header. */
function LabelChips({ labels, testId }: { labels: string[]; testId?: string }) {
  if (!labels.length) return null;
  return (
    <span className="knowledge-labels" data-testid={testId}>
      {labels.map((label) => (
        <span key={label} className="knowledge-label">{label}</span>
      ))}
    </span>
  );
}

function jobText(job: KnowledgeJobState): string {
  const on = job.model ? ` on ${job.model}` : '';
  if (job.state === 'running') return `${job.mode === 'bootstrap' ? 'Generating pages' : 'Distilling recent work'}${on}…`;
  if (job.state === 'failed') return job.error ?? 'The job failed.';
  return job.detail ?? 'Done.';
}

function JobLine({ job }: { job: KnowledgeJobState }) {
  return (
    <div className={`knowledge-job knowledge-job-${job.state}`} data-testid="knowledge-job">
      {job.state === 'running' ? <Spinner size={12} /> : <Icon name={job.state === 'done' ? 'check' : 'alert'} size={12} />}
      <span>{jobText(job)}</span>
    </div>
  );
}

export function KnowledgeTab({ session }: { session: SessionMeta }) {
  const toast = useStore((s) => s.toast);
  const settings = useStore((s) => s.settings);
  const [view, setView] = useState<KnowledgeView | null>(null);
  const [detail, setDetail] = useState<KnowledgePageDetail | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgePageSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const liveId = useRef(session.id);
  // A page body names files and links out; without handlers those would be coloured but dead.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    return installMarkdownHandlers(el, (url) => void invoke('app:openExternal', { url }), (p, line) => useStore.getState().revealFile(session.id, p, line));
  }, [detail, session.id]);

  const load = useCallback(async () => {
    const sid = session.id;
    liveId.current = sid;
    try {
      const next = await invoke('knowledge:view', { sessionId: sid });
      if (liveId.current === sid) setView(next);
    } catch (e) {
      if (liveId.current === sid) toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }, [session.id, toast]);

  useEffect(() => {
    setDetail(null);
    setResults(null);
    setQuery('');
    void load();
  }, [load]);

  // A synthesis job can run for a minute or two; keep the panel's status line moving while it does.
  useEffect(() => {
    if (!generating) return undefined;
    const timer = setInterval(() => void load(), 4_000);
    return () => clearInterval(timer);
  }, [generating, load]);

  // The graph is derived from the pages, so it is only worth fetching while a detail is open. A
  // failure (or an older main process without the channel) leaves the page readable without it.
  const detailId = detail?.page.meta.id ?? null;
  useEffect(() => {
    if (!detailId) {
      setGraph(null);
      return undefined;
    }
    let alive = true;
    void (async () => {
      try {
        const next = await invoke('knowledge:graph', { sessionId: session.id });
        if (alive) setGraph(next ?? null);
      } catch {
        if (alive) setGraph(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [detailId, session.id]);

  // The digest priming and auto-distill switches are app-wide, but the project's wiki is where a
  // user notices them, so they live here rather than only in Settings.
  const patchSettings = async (patch: { prime?: boolean; autoDistill?: boolean }) => {
    setBusy(true);
    try {
      await invoke('settings:update', { knowledge: { prime: view?.settings.prime ?? true, autoDistill: view?.settings.autoDistill ?? true, ...patch } });
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string) => {
    try {
      const next = await invoke('knowledge:read', { sessionId: session.id, id });
      setDetail(next && next.page ? next : null);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const search = async () => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    try {
      const found = await invoke('knowledge:search', { sessionId: session.id, q, limit: 30 });
      setResults(found.map((r) => ({ ...r })));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const generate = async (mode: 'bootstrap' | 'distill') => {
    if (generating) return;
    setGenerating(true);
    try {
      const r = await invoke('knowledge:generate', { sessionId: session.id, mode });
      toast(r.ok ? r.detail ?? 'Done' : r.error ?? 'Generation failed', r.ok ? 'success' : 'error');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setGenerating(false);
    }
  };

  /** The mutation channels return the refreshed view; fall back to a reload if one comes back empty. */
  const applyView = async (next: KnowledgeView | null | undefined) => {
    if (next && Array.isArray(next.pages)) setView(next);
    else await load();
  };

  /** Starts an empty wiki, for a project whose docs are too thin to bootstrap a first set of pages. */
  const createWiki = async () => {
    setBusy(true);
    try {
      await applyView(await invoke('knowledge:create', { sessionId: session.id }));
      toast('Wiki created — pages are recorded here as you work', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Tombstones the claim so an agent cannot refile it, and removes the page. */
  const rejectPage = async (id: string) => {
    setBusy(true);
    try {
      await applyView(await invoke('knowledge:review', { sessionId: session.id, id, action: 'reject' }));
      setDetail(null);
      toast('Rejected — the claim is remembered so it will not be filed again', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const deletePage = async (id: string) => {
    setBusy(true);
    try {
      await applyView(await invoke('knowledge:delete', { sessionId: session.id, id }));
      setDetail(null);
      toast('Page deleted', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!view) return;
    const ids = view.pages.filter((p) => p.status === 'current').map((p) => p.id);
    if (!ids.length) {
      toast('No current pages to publish yet', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await invoke('knowledge:publish', { sessionId: session.id, ids });
      toast(r.ok ? `Published ${r.written.length} page(s) to docs/wiki/` : r.error ?? 'Publish failed', r.ok ? 'success' : 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => (results ?? view?.pages ?? []).slice(0, 200), [results, view?.pages]);
  const graphEdges = useMemo(() => {
    if (!graph || !detailId) return [];
    return graph.edges.filter((edge) => edge.from === detailId || edge.to === detailId);
  }, [graph, detailId]);

  if (!view) {
    return (
      <div className="mcp-loading">
        <Spinner size={14} /> Reading project knowledge…
      </div>
    );
  }

  const status = view.status;
  // Background generation runs on the utility model; without one the button can only fail, so say so.
  const modelReady = !!settings?.utilityModel;
  const titleOf = (id: string) => view.pages.find((p) => p.id === id)?.title ?? id;

  return (
    <div className="knowledge-tab" data-testid="knowledge-tab">
      <div className="mcp-section-head">
        <h3>Project knowledge</h3>
        <span className="spacer" />
        <Badge tone="neutral">{status.pages} page{status.pages === 1 ? '' : 's'}</Badge>
        {status.stale > 0 && <Badge tone="red" title="A cited file changed or disappeared">{status.stale} stale</Badge>}
      </div>
      <div className="muted small mono knowledge-path" title={view.wikiDir}>{view.wikiDir}{view.branch ? ` · branch ${view.branch}` : ''}</div>
      <div className="muted small" data-testid="knowledge-auto-note">
        Knowledge is ingested automatically as you work — this panel is for browsing and correcting it.
      </div>

      <div className="knowledge-actions">
        <Button size="sm" variant="primary" icon="sparkles" disabled={generating || !modelReady} data-testid="knowledge-generate" onClick={() => void generate('bootstrap')}>
          {generating ? 'Working…' : 'Generate from docs'}
        </Button>
        <Button size="sm" icon="refresh" disabled={generating || !modelReady} onClick={() => void generate('distill')}>
          Distil recent work
        </Button>
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon="upload" disabled={busy} onClick={() => void publish()} title="Copy current pages into the tracked docs/wiki/ path">
          Publish
        </Button>
      </div>
      {!modelReady && (
        <div className="muted small" data-testid="knowledge-needs-model">
          Generation needs a utility model — choose one in Settings → General → Background model.
        </div>
      )}
      {status.job && <JobLine job={status.job} />}

      <div className="knowledge-search">
        <input
          value={query}
          placeholder="Search this project's knowledge…"
          aria-label="Search project knowledge"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
            if (e.key === 'Escape') {
              setQuery('');
              setResults(null);
            }
          }}
        />
        <Button size="sm" variant="ghost" icon="search" onClick={() => void search()} title="Search page bodies" />
      </div>

      {!status.hasWiki && !status.pages && (
        <EmptyState icon="book" title="No project wiki yet">
          <p>Knowledge is ingested automatically as you work. Generate a first set of pages from this project's README, docs and instructions, or start an empty wiki and let it fill in from there.</p>
          <Button size="sm" disabled={busy} data-testid="knowledge-create" onClick={() => void createWiki()}>
            Start an empty wiki
          </Button>
        </EmptyState>
      )}

      {detail ? (
        <section className="knowledge-detail" data-testid="knowledge-detail">
          <div className="knowledge-card-head">
            <Button size="sm" variant="ghost" icon="chevron" onClick={() => setDetail(null)} title="Back to the list" />
            <span className="knowledge-title">{detail.page.meta.title}</span>
            <Badge tone={statusTone(detail.page.meta.status)}>{detail.page.meta.status}</Badge>
          </div>
          <div className="knowledge-detail-meta">
            <LabelChips labels={detail.page.meta.labels ?? []} testId="knowledge-labels" />
            {detail.page.meta.updatedBy && <span className="muted small knowledge-by" title={`Last written by ${detail.page.meta.updatedBy}`}>{detail.page.meta.updatedBy}</span>}
          </div>
          <div className="knowledge-card-actions">
            <Button
              size="sm"
              disabled={busy}
              data-testid="knowledge-page-reject"
              title="Tombstone this claim so an agent will not file it again; the page is removed."
              onClick={() => void rejectPage(detail.page.meta.id)}
            >
              Reject (remember)
            </Button>
            <Button size="sm" variant="danger" icon="trash" disabled={busy} data-testid="knowledge-page-delete" title="Delete this page. Its claim is not remembered and may be filed again." onClick={() => void deletePage(detail.page.meta.id)}>
              Delete
            </Button>
          </div>
          {detail.page.meta.claim && <div className="knowledge-claim">{detail.page.meta.claim}</div>}
          {detail.stale && (
            <div className="knowledge-stale" data-testid="knowledge-stale">
              <Icon name="alert" size={12} /> Possibly out of date: {detail.staleReasons.join('; ')}
            </div>
          )}
          <div ref={body} className="knowledge-body markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.page.body, { fileLinks: true }) }} />
          {detail.page.meta.sources.length > 0 && (
            <div className="knowledge-meta">
              <h4>Sources</h4>
              <ul>
                {detail.page.meta.sources.map((s) => (
                  <li key={`${s.type}:${s.ref}`}><code className="mono">{s.type}</code> {s.ref}{s.note ? ` — ${s.note}` : ''}</li>
                ))}
              </ul>
            </div>
          )}
          {detail.page.meta.anchors.length > 0 && (
            <div className="knowledge-meta">
              <h4>GitNexus anchors</h4>
              <ul>
                {detail.anchors.map((a) => (
                  <li key={`${a.file}:${a.symbol ?? ''}`} className="knowledge-anchor">
                    <code className="mono">{a.file}</code>
                    {a.symbol ? `#${a.symbol}` : ''}
                    <Badge tone={a.status === 'resolved' ? 'green' : a.status === 'unresolved' ? 'red' : 'neutral'}>{a.status === 'unavailable' ? 'not checked' : a.status}</Badge>
                    {a.lines && <span className="muted small">lines {a.lines.start}-{a.lines.end}</span>}
                    {a.note && <span className="muted small">{a.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {graphEdges.length > 0 && (
            <div className="knowledge-meta" data-testid="knowledge-graph">
              <h4>Relations</h4>
              <ul>
                {graphEdges.map((edge) => {
                  const outgoing = edge.from === detail.page.meta.id;
                  const other = outgoing ? edge.to : edge.from;
                  return (
                    <li key={`${edge.from}:${edge.to}:${edge.type}`} className="knowledge-edge">
                      <span className="muted small" title={outgoing ? 'This page points to it' : 'It points to this page'}>{outgoing ? '→' : '←'}</span>
                      <Badge tone="neutral">{edge.type}</Badge>
                      <button type="button" className="link-btn" onClick={() => void open(other)}>{titleOf(other)}</button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {detail.related.length > 0 && (
            <div className="knowledge-meta">
              <h4>Related</h4>
              <ul>
                {detail.related.map((r) => (
                  <li key={r.id}><button type="button" className="link-btn" onClick={() => void open(r.id)}>{r.title}</button></li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : (
        <section className="knowledge-pages">
          {shown.length === 0 && status.hasWiki && <div className="muted small">No pages match.</div>}
          {shown.map((page) => (
            <div
              key={page.id}
              role="button"
              tabIndex={0}
              className="knowledge-row"
              data-testid={`knowledge-page-${page.id}`}
              onClick={() => void open(page.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void open(page.id);
                }
              }}
            >
              <Icon name="file" size={12} />
              <span className="knowledge-row-main">
                <span className="knowledge-title">{page.title}</span>
                {page.claim && <span className="muted small knowledge-claim">{page.claim}</span>}
                {page.snippet && <span className="muted small knowledge-snippet"><HighlightedSnippet text={page.snippet} /></span>}
                <LabelChips labels={page.labels ?? []} testId={`knowledge-labels-${page.id}`} />
              </span>
              {page.updatedBy && <span className="muted small knowledge-by" title={`Last written by ${page.updatedBy}`}>{page.updatedBy}</span>}
              <span className="muted small">{page.kind}</span>
              <Badge tone={statusTone(page.status)}>{authorityLabel(page)}</Badge>
              <Button
                size="sm"
                variant="ghost"
                icon="x"
                title="Reject (remember) — tombstone this claim so an agent will not file it again"
                aria-label={`Reject ${page.title}`}
                data-testid={`knowledge-row-reject-${page.id}`}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void rejectPage(page.id);
                }}
              />
            </div>
          ))}
        </section>
      )}

      {view.rejectedClaims.length > 0 && (
        // Rejecting is only accountable if the user can see what is being kept out: this is the
        // ledger the agent tools read to refuse a refiled claim.
        <details className="knowledge-rejected" data-testid="knowledge-rejected">
          <summary>
            {view.rejectedClaims.length} rejected claim{view.rejectedClaims.length === 1 ? '' : 's'}
          </summary>
          <div className="muted small">Remembered so no agent files them again. Deleting a page does not add one; rejecting does.</div>
          <ul>
            {view.rejectedClaims.map((claim) => (
              <li key={claim}>{claim}</li>
            ))}
          </ul>
        </details>
      )}

      <section className="knowledge-switches">
        <Toggle checked={view.settings.prime} disabled={busy} onChange={(v) => void patchSettings({ prime: v })} label="Prime new sessions with the knowledge digest" />
        <Toggle checked={view.settings.autoDistill} disabled={busy} onChange={(v) => void patchSettings({ autoDistill: v })} label="Distil commits, PRs and merges automatically" />
      </section>
    </div>
  );
}
