import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { resolveIntelligenceSettings } from '../../../shared/intelligence';
import { authorityOf, isPendingStatus, isServable, pageIdFromPath, pathForProposal, type KnowledgeGraph, type KnowledgeJobState, type KnowledgePageDetail, type KnowledgePageSummary, type KnowledgeView } from '../../../shared/knowledge';
import type { SessionMeta } from '../../../shared/types';
import { canInvoke, invoke } from '../api';
import { installMarkdownHandlers, renderMarkdown } from '../markdown';
import { useStore } from '../store';
import { HighlightedSnippet } from './HighlightedSnippet';
import { Badge, Button, EmptyState, Icon, Spinner, Toggle } from './ui';
import { CollectionsView } from './knowledge/CollectionsView';
import { EvidenceView } from './knowledge/EvidenceView';
import { MemoryRefresh, MemoryView } from './knowledge/MemoryView';
import { SourcesView } from './knowledge/SourcesView';
import { InlineError, PromoteControl } from './knowledge/controls';
import { errorMessage, useIntelligence, useScopeGuard, type IntelligenceController, type KnowledgeSection } from './knowledge/useIntelligence';
import './knowledge/knowledge.css';

const SECTIONS = [
  ['knowledge', 'Knowledge'], ['memory', 'Memory'], ['collections', 'Collections'], ['evidence', 'Evidence'], ['sources', 'Sources']
] as const;
const INTELLIGENCE_SECTIONS = { memory: MemoryView, collections: CollectionsView, evidence: EvidenceView, sources: SourcesView };

/** Keep the panel entry and wiki as the default; activating another tab is an explicit read. */
export function KnowledgeTab({ session }: { session: SessionMeta }) {
  const id = useId();
  const [active, setActive] = useState<KnowledgeSection>('knowledge');
  const [focused, setFocused] = useState<KnowledgeSection>('knowledge');
  const scope = JSON.stringify([session.id, session.config.projectRoot, session.cwd, session.worktreeBranch]);
  // The web bridge omits these local-only channels. Desktop and mock renderers have no gate.
  if (window.harness && !canInvoke('intelligence:view')) return (
    <div className="knowledge-workspace" data-testid="knowledge-tab">
      <WikiView key={scope} session={session} active intelligence={null} />
    </div>
  );
  return (
    <div className="knowledge-workspace" data-testid="knowledge-tab">
      <div className="knowledge-view-tabs" role="tablist" aria-label="Project knowledge views" onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(active);
      }}>
        {SECTIONS.map(([section, label], index) => (
          <button key={section} type="button" role="tab" id={`${id}-${section}-tab`} aria-controls={`${id}-${section}-panel`}
            aria-selected={active === section} tabIndex={focused === section ? 0 : -1} data-testid={`knowledge-view-${section}`}
            onFocus={() => setFocused(section)} onClick={() => { setActive(section); setFocused(section); }} onKeyDown={(e) => {
              const count = SECTIONS.length;
              const next = e.key === 'ArrowRight' ? (index + 1) % count : e.key === 'ArrowLeft' ? (index + count - 1) % count
                : e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : null;
              if (next === null) return;
              e.preventDefault();
              // Focus moves without starting a read until the user activates the tab.
              e.currentTarget.ownerDocument.getElementById(`${id}-${SECTIONS[next][0]}-tab`)?.focus();
            }}>{label}</button>
        ))}
      </div>
      <KnowledgeSession key={scope} session={session} active={active} id={id} />
    </div>
  );
}

/** A different session or checkout cannot inherit the previous view, drafts or pending replies. */
function KnowledgeSession({ session, active, id }: { session: SessionMeta; active: KnowledgeSection; id: string }) {
  const intelligence = useIntelligence(session.id);
  const { view, busy, errors, refresh, run } = intelligence;
  const settings = useStore((s) => s.settings?.intelligence);
  const lastSettings = useRef(settings);
  useEffect(() => {
    if (active !== 'knowledge' && !view && !busy && !errors.load) void refresh();
  }, [active, view, busy, errors.load, refresh]);

  useEffect(() => {
    if (active === 'knowledge' || !view || busy || settings === lastSettings.current) return;
    lastSettings.current = settings;
    // An app-wide settings push can arrive after switching away from the session that wrote it.
    if (JSON.stringify(resolveIntelligenceSettings(settings)) !== JSON.stringify(view.settings)) void refresh();
  }, [active, view, busy, settings, refresh]);

  return SECTIONS.map(([section]) => {
    const selected = section === active;
    const View = section === 'knowledge' ? null : INTELLIGENCE_SECTIONS[section];
    return (
      <div key={section} role="tabpanel" id={`${id}-${section}-panel`} aria-labelledby={`${id}-${section}-tab`} hidden={!selected} tabIndex={0}>
        {section === 'knowledge' ? <WikiView session={session} active={selected} intelligence={intelligence} /> : selected && View && (
          <div className="intelligence-panel" data-testid={view ? `${section}-view` : undefined}>
            {section === 'memory' && <MemoryRefresh sessionId={session.id} busy={busy} run={run} />}
            <InlineError>{errors[section]}</InlineError>
            {errors.load && <div className="intelligence-inline">
              <InlineError>{errors.load}</InlineError>
              <Button size="sm" disabled={busy} onClick={() => void refresh()}>Retry</Button>
            </div>}
            {view ? <View sessionId={session.id} view={view} busy={busy} run={(work) => run(section, work)} /> : !errors.load && (
              <div className="intelligence-row muted" role="status"><Spinner size={14} /> Reading project memory…</div>
            )}
          </div>
        )}
      </div>
    );
  });
}

function statusTone(status: KnowledgePageSummary['status']): 'green' | 'amber' | 'red' | 'neutral' | 'blue' {
  if (status === 'current') return 'green';
  if (isPendingStatus(status)) return 'amber';
  if (status === 'superseded' || status === 'deprecated') return 'red';
  if (status === 'uncertain') return 'blue';
  return 'neutral';
}

function authorityLabel(page: KnowledgePageSummary): string {
  if (page.authority <= 2) return 'human-reviewed';
  if (page.verifiedBy) return 'verified';
  if (page.status === 'current') return 'accepted';
  return page.status;
}

function isReviewDraft(page: Pick<KnowledgePageSummary, 'status' | 'updatedBy'>) {
  return page.status === 'draft' && page.updatedBy === 'auto:evidence-draft';
}

function scopeLabel(page: Pick<KnowledgePageSummary, 'scope' | 'branch'>) {
  return page.scope === 'branch' ? (page.branch ? `Branch: ${page.branch}` : 'Branch') : 'Repository';
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

/** The wiki is ingested automatically; corrections and background jobs still use the wiki IPC. */
function WikiView({ session, active, intelligence }: { session: SessionMeta; active: boolean; intelligence: IntelligenceController | null }) {
  const toast = useStore((s) => s.toast);
  const settings = useStore((s) => s.settings);
  const [view, setView] = useState<KnowledgeView | null>(null);
  const [selection, setSelection] = useState<{ id: string; detail: KnowledgePageDetail; draft?: KnowledgePageSummary } | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgePageSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [reviewError, setReviewError] = useState<{ id: string; message: string } | null>(null);
  const [reviewResult, setReviewResult] = useState<string | null>(null);
  const drafts = view?.proposals.filter(isReviewDraft) ?? [];
  const draft = selection?.draft;
  // A refresh can remove a draft independently of this panel. Do not offer actions on that preview.
  const detail = draft && !drafts.some((page) => page.id === draft.id) ? null : selection?.detail;
  const detailId = detail ? selection?.id : null;
  const capture = useScopeGuard();
  const loadRequest = useRef(0);
  const readRequest = useRef(0);
  const searchRequest = useRef(0);
  // A page body names files and links out; without handlers those would be coloured but dead.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    return installMarkdownHandlers(el, (url) => void invoke('app:openExternal', { url }), (p, line) => useStore.getState().revealFile(session.id, p, line));
  }, [detail, session.id]);

  const load = useCallback(async () => {
    const current = capture();
    const request = ++loadRequest.current;
    try {
      const next = await invoke('knowledge:view', { sessionId: session.id });
      if (current() && request === loadRequest.current) setView(next);
    } catch (e) {
      if (current() && request === loadRequest.current) toast(errorMessage(e), 'error');
    }
  }, [capture, session.id, toast]);

  // Opening the wiki again picks up pages written from Memory without discarding the open page.
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  // A synthesis job can run for a minute or two; keep the panel's status line moving while it does.
  useEffect(() => {
    if (!generating) return undefined;
    const timer = setInterval(() => void load(), 4_000);
    return () => clearInterval(timer);
  }, [generating, load]);

  // The graph covers wiki pages, not review-only drafts. A failure leaves the page readable.
  const graphPageId = draft ? null : detail?.page.meta.id;
  useEffect(() => {
    if (!graphPageId) {
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
  }, [graphPageId, session.id]);

  const runWiki = async (work: (current: () => boolean) => Promise<void>, onError = (message: string) => toast(message, 'error')) => {
    if (busy) return;
    const current = capture();
    setBusy(true);
    try {
      await work(current);
    } catch (e) {
      if (current()) onError(errorMessage(e));
    } finally {
      if (current()) setBusy(false);
    }
  };

  // The digest priming and auto-distill switches are app-wide, but the project's wiki is where a
  // user notices them, so they live here rather than only in Settings.
  const patchSettings = (patch: { prime?: boolean; autoDistill?: boolean }) => runWiki(async (current) => {
    await invoke('settings:update', { knowledge: { prime: view?.settings.prime ?? true, autoDistill: view?.settings.autoDistill ?? true, ...patch } });
    if (current()) await load();
  });

  const open = async (id: string, draft?: KnowledgePageSummary) => {
    const current = capture();
    const request = ++readRequest.current;
    setReviewError(null);
    try {
      const next = await invoke('knowledge:read', { sessionId: session.id, id });
      if (!current() || request !== readRequest.current) return;
      if (draft && (!next?.page || next.page.meta.id !== id || !isReviewDraft(next.page.meta))) {
        toast('This draft is no longer available for review.', 'error');
        return;
      }
      setSelection(next?.page ? { id, detail: next, draft } : null);
    } catch (e) {
      if (current() && request === readRequest.current) toast(errorMessage(e), 'error');
    }
  };
  const closeDetail = () => {
    ++readRequest.current;
    setSelection(null);
  };
  const closeSelection = (id: string) => setSelection((previous) => previous?.id === id ? null : previous);

  const search = async () => {
    const current = capture();
    const request = ++searchRequest.current;
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    try {
      const found = await invoke('knowledge:search', { sessionId: session.id, q, limit: 30 });
      if (current() && request === searchRequest.current) setResults(found);
    } catch (e) {
      if (current() && request === searchRequest.current) toast(errorMessage(e), 'error');
    }
  };

  const generate = async (mode: 'bootstrap' | 'distill') => {
    if (generating) return;
    const current = capture();
    setGenerating(true);
    try {
      const r = await invoke('knowledge:generate', { sessionId: session.id, mode });
      if (!current()) return;
      toast(r.ok ? r.detail ?? 'Done' : r.error ?? 'Generation failed', r.ok ? 'success' : 'error');
      await load();
    } catch (e) {
      if (current()) toast(errorMessage(e), 'error');
    } finally {
      if (current()) setGenerating(false);
    }
  };

  /** Keep the mutation's returned authority even if a synthesis poll was already in flight. */
  const applyView = async (next: KnowledgeView | null | undefined) => {
    if (!next || !Array.isArray(next.pages)) return load();
    ++loadRequest.current;
    ++searchRequest.current;
    setView(next);
    const pages = new Map(next.pages.map((page) => [page.id, page]));
    setResults((previous) => previous?.flatMap((page) => {
      const fresh = pages.get(page.id);
      return fresh ? [{ ...page, ...fresh, verifiedBy: fresh.verifiedBy }] : [];
    }) ?? null);
  };

  /** Starts an empty wiki, for a project whose docs are too thin to bootstrap a first set of pages. */
  const createWiki = () => runWiki(async (current) => {
    const next = await invoke('knowledge:create', { sessionId: session.id });
    if (!current()) return;
    await applyView(next);
    if (current()) toast('Wiki created — pages are recorded here as you work', 'success');
  });

  /** Tombstones the claim so an agent cannot refile it, and removes the page. */
  const rejectPage = (id: string) => runWiki(async (current) => {
    const next = await invoke('knowledge:review', { sessionId: session.id, id, action: 'reject' });
    if (!current()) return;
    await applyView(next);
    if (!current()) return;
    closeSelection(id);
    toast('Rejected — the claim is remembered so it will not be filed again', 'success');
  });

  const deletePage = (id: string) => runWiki(async (current) => {
    const next = await invoke('knowledge:delete', { sessionId: session.id, id });
    if (!current()) return;
    await applyView(next);
    if (!current()) return;
    closeSelection(id);
    toast(draft?.id === id ? 'Draft deleted' : 'Page deleted', 'success');
  });

  const markReviewed = (id: string, draft?: KnowledgePageSummary) => runWiki(async (current) => {
    setReviewError(null);
    setReviewResult(null);
    const next = await invoke('knowledge:review', { sessionId: session.id, id, action: 'accept' });
    if (!current()) return;
    await applyView(next);
    if (!current() || !draft || !next) return;
    if (next.proposals.some((page) => page.id === id)) throw new Error('The draft is still awaiting review.');
    // The proposal id is not the final wiki id. Return to the updated list and keep a receipt
    // from this review rather than relabeling the draft preview as the accepted page.
    closeSelection(id);
    const targetId = pageIdFromPath(pathForProposal(draft.kind, draft.title));
    const accepted = next.pages.find((page) => page.id === targetId && page.claim === draft.claim && page.status === 'current' && page.authority <= 2 &&
      page.scope === draft.scope && page.branch === draft.branch);
    setReviewResult(accepted
      ? `Accepted “${accepted.title}” into the wiki (${scopeLabel(accepted)}).`
      : `Draft “${draft.title}” is no longer pending. Its reviewed page is not in this view.`);
  }, (message) => setReviewError({ id, message }));

  const publish = () => runWiki(async (current) => {
    if (!view) return;
    const ids = view.pages.filter((p) => p.status === 'current').map((p) => p.id);
    if (!ids.length) {
      toast('No current pages to publish yet', 'error');
      return;
    }
    const r = await invoke('knowledge:publish', { sessionId: session.id, ids });
    if (current()) toast(r.ok ? `Published ${r.written.length} page(s) to docs/wiki/` : r.error ?? 'Publish failed', r.ok ? 'success' : 'error');
  });

  const shown = useMemo(() => (results ?? view?.pages ?? []).slice(0, 200), [results, view?.pages]);
  const graphEdges = useMemo(() => {
    if (!graph || !graphPageId) return [];
    return graph.edges.filter((edge) => edge.from === graphPageId || edge.to === graphPageId);
  }, [graph, graphPageId]);

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
  const summary = !draft && detail ? view.pages.find((page) => page.id === detail.page.meta.id) : undefined;
  const humanReviewed = !draft && !!detail && (summary?.authority ?? authorityOf(detail.page.meta)) <= 2;
  const verified = !draft && !humanReviewed && !!(summary ? summary.verifiedBy : detail?.page.meta.verification);
  const pageStatus = draft ? 'draft' : summary?.status ?? detail?.page.meta.status;

  return (
    <div className="knowledge-tab">
      <div className="mcp-section-head">
        <h3>Project knowledge</h3>
        <span className="spacer" />
        <Badge tone="neutral">{status.pages} page{status.pages === 1 ? '' : 's'}</Badge>
        {status.stale > 0 && <Badge tone="red" title="A cited file changed or disappeared">{status.stale} stale</Badge>}
      </div>
      <div className="muted small mono knowledge-path" title={view.wikiDir}>{view.wikiDir}{view.branch ? ` · branch ${view.branch}` : ''}</div>
      <div className="muted small" data-testid="knowledge-auto-note">
        Knowledge is ingested automatically as you work. Review-only drafts wait for your approval.
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
          onChange={(e) => { ++searchRequest.current; setQuery(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
            if (e.key === 'Escape') {
              ++searchRequest.current;
              setQuery('');
              setResults(null);
            }
          }}
        />
        <Button size="sm" variant="ghost" icon="search" onClick={() => void search()} title="Search page bodies" />
      </div>

      {reviewResult && <p className="muted small" role="status">{reviewResult}</p>}
      {!status.hasWiki && !status.pages && !drafts.length && (
        <EmptyState icon="book" title="No project wiki yet">
          <p>Knowledge is ingested automatically as you work. Generate a first set of pages from this project's README, docs and instructions, or start an empty wiki and let it fill in from there.</p>
          <Button size="sm" disabled={busy} data-testid="knowledge-create" onClick={() => void createWiki()}>
            Start an empty wiki
          </Button>
        </EmptyState>
      )}

      {!detail && drafts.length > 0 && (
        <section className="knowledge-pages" aria-label="Drafts awaiting review" data-testid="knowledge-proposals">
          <h4>Drafts awaiting review</h4>
          <p className="muted small">Drafts stay out of the knowledge digest and Publish until accepted.</p>
          {drafts.map((item) => (
            <button key={item.id} type="button" className="knowledge-row" disabled={busy}
              aria-label={`Review draft: ${item.title} (${scopeLabel(item)})`} onClick={() => void open(item.id, item)}>
              <Icon name="file" size={12} />
              <span className="knowledge-row-main">
                <span className="knowledge-title">{item.title}</span>
                {item.claim && <span className="muted small knowledge-claim">{item.claim}</span>}
              </span>
              <span className="muted small">{scopeLabel(item)}</span>
              <Badge tone="amber">Draft</Badge>
            </button>
          ))}
        </section>
      )}

      {detail && detailId && pageStatus ? (
        <section className="knowledge-detail" data-testid="knowledge-detail">
          <div className="knowledge-card-head">
            <Button size="sm" variant="ghost" icon="chevron" onClick={closeDetail} title="Back to the list" />
            <span className="knowledge-title">{detail.page.meta.title}</span>
            <Badge tone={statusTone(pageStatus)}>{draft ? 'Review-only draft' : pageStatus}</Badge>
            {humanReviewed ? <Badge>human-reviewed</Badge> : verified && <Badge>verified</Badge>}
          </div>
          <div className="knowledge-detail-meta">
            {draft && <span className="muted small">{scopeLabel(detail.page.meta)}</span>}
            <LabelChips labels={detail.page.meta.labels ?? []} testId="knowledge-labels" />
            {detail.page.meta.updatedBy && <span className="muted small knowledge-by" title={`Last written by ${detail.page.meta.updatedBy}`}>{detail.page.meta.updatedBy}</span>}
          </div>
          <div className="knowledge-card-actions">
            <Button
              size="sm"
              disabled={busy}
              data-testid="knowledge-page-reject"
              title={`Tombstone this claim so an agent will not file it again; the ${draft ? 'draft' : 'page'} is removed.`}
              onClick={() => void rejectPage(detailId)}
            >
              Reject (remember)
            </Button>
            <Button size="sm" variant="danger" icon="trash" disabled={busy} data-testid="knowledge-page-delete" title={`Delete this ${draft ? 'draft' : 'page'}. Its claim is not remembered and may be filed again.`} onClick={() => void deletePage(detailId)}>
              Delete
            </Button>
            {!humanReviewed && <Button size="sm" disabled={busy} data-testid="knowledge-mark-reviewed" onClick={() => void markReviewed(detailId, draft)}>{draft ? 'Accept draft' : 'Mark reviewed'}</Button>}
            {intelligence && <PromoteControl key={detailId} prefix="knowledge" view={intelligence.view} busy={busy || intelligence.busy}
              disabledReason={draft ? 'Accept this draft first' : isServable({ status: pageStatus }) ? undefined : 'Mark this page reviewed first'}
              loadError={intelligence.errors.load} onLoad={() => void intelligence.refresh()}
              onPromote={(target) => intelligence.run('knowledge', () => invoke('intelligence:promote', { sessionId: session.id, pageId: detailId, ...target }))} />}
          </div>
          <InlineError>{reviewError?.id === detailId ? reviewError.message : undefined}</InlineError>
          <InlineError>{intelligence?.errors.knowledge}</InlineError>
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
                      <button type="button" className="link" onClick={() => void open(other)}>{titleOf(other)}</button>
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
                  <li key={r.id}><button type="button" className="link" onClick={() => void open(r.id)}>{r.title}</button></li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : (
        <section className="knowledge-pages">
          {shown.length === 0 && status.hasWiki && (results || !drafts.length) && <div className="muted small">No pages match.</div>}
          {shown.map((page) => (
            <div
              key={page.id}
              role="button"
              tabIndex={0}
              className="knowledge-row"
              data-testid={`knowledge-page-${page.id}`}
              onClick={() => void open(page.id)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
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
