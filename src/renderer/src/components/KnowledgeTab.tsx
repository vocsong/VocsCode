/**
 * Right-panel Layer 2 view for the current project: the curated wiki, what awaits review, and the
 * two background jobs that maintain it. Pages are read-only here — the only edits are accepting or
 * rejecting a proposal and copying reviewed pages into docs/wiki/.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KnowledgeJobState, KnowledgePageDetail, KnowledgePageSummary, KnowledgeView } from '../../../shared/knowledge';
import type { SessionMeta } from '../../../shared/types';
import { invoke } from '../api';
import { renderMarkdown } from '../markdown';
import { useStore } from '../store';
import { Badge, Button, EmptyState, Icon, Spinner, Toggle } from './ui';

function statusTone(status: KnowledgePageSummary['status']): 'green' | 'amber' | 'red' | 'neutral' | 'blue' {
  if (status === 'current') return 'green';
  if (status === 'proposed' || status === 'draft') return 'amber';
  if (status === 'superseded' || status === 'deprecated') return 'red';
  if (status === 'uncertain') return 'blue';
  return 'neutral';
}

function authorityLabel(page: KnowledgePageSummary): string {
  if (page.authority <= 2) return 'human-reviewed';
  if (page.status === 'current') return 'accepted';
  return page.status;
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
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgePageSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const liveId = useRef(session.id);

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

  const decide = async (id: string, action: 'accept' | 'reject') => {
    setBusy(true);
    try {
      const next = await invoke('knowledge:review', { sessionId: session.id, id, action });
      setView(next);
      setDetail(null);
      toast(action === 'accept' ? 'Accepted into the wiki' : 'Discarded', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Accepts every draft and proposal in one call; the panel re-renders from the returned view. */
  const acceptAll = async () => {
    setBusy(true);
    try {
      const r = await invoke('knowledge:reviewAll', { sessionId: session.id });
      setView(r.view);
      setDetail(null);
      toast(r.accepted ? `Accepted ${r.accepted} item${r.accepted === 1 ? '' : 's'}` : 'Nothing to accept', r.accepted ? 'success' : 'error');
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
      toast('No accepted pages to publish yet', 'error');
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
  // Anything still awaiting a decision: proposals plus non-current, non-historical pages.
  const pendingCount = (view?.proposals.length ?? 0) + (view?.pages ?? []).filter((p) => p.status !== 'current' && p.status !== 'deprecated' && p.status !== 'superseded').length;

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

  return (
    <div className="knowledge-tab" data-testid="knowledge-tab">
      <div className="mcp-section-head">
        <h3>Project knowledge</h3>
        <span className="spacer" />
        <Badge tone="neutral">{status.pages} page{status.pages === 1 ? '' : 's'}</Badge>
        {status.proposals > 0 && <Badge tone="amber">{status.proposals} to review</Badge>}
        {status.stale > 0 && <Badge tone="red" title="A cited file changed or disappeared">{status.stale} stale</Badge>}
      </div>
      <div className="muted small mono knowledge-path" title={view.wikiDir}>{view.wikiDir}{view.branch ? ` · branch ${view.branch}` : ''}</div>

      <div className="knowledge-actions">
        <Button size="sm" variant="primary" icon="sparkles" disabled={generating || !modelReady} data-testid="knowledge-generate" onClick={() => void generate('bootstrap')}>
          {generating ? 'Working…' : 'Generate from docs'}
        </Button>
        <Button size="sm" icon="refresh" disabled={generating || !modelReady} onClick={() => void generate('distill')}>
          Distil recent work
        </Button>
        <span className="spacer" />
        <Button size="sm" icon="check" disabled={busy || pendingCount === 0} data-testid="knowledge-accept-all" title="Accept every draft and proposal as current" onClick={() => void acceptAll()}>
          Accept all{pendingCount ? ` (${pendingCount})` : ''}
        </Button>
        <Button size="sm" variant="ghost" icon="upload" disabled={busy} onClick={() => void publish()} title="Copy accepted pages into the tracked docs/wiki/ path">
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
          <p>Generate a first set of pages from this project's README, docs and instructions, then review what is worth keeping.</p>
        </EmptyState>
      )}

      {view.proposals.length > 0 && (
        <section className="knowledge-proposals" data-testid="knowledge-proposals">
          <div className="mcp-section-head"><h3>Needs review</h3><span className="spacer" /><span className="muted small">Nothing here is served to an agent until accepted.</span></div>
          {view.proposals.map((p) => (
            <div key={p.id} className="knowledge-card" data-testid={`knowledge-proposal-${p.id}`}>
              <div className="knowledge-card-head">
                <Icon name="bulb" size={12} />
                <span className="knowledge-title">{p.title}</span>
                <Badge tone="amber">{p.kind}</Badge>
                {p.evidenceCount && p.evidenceCount > 1 && <Badge tone="blue">{p.evidenceCount} sessions</Badge>}
              </div>
              {p.claim && <div className="knowledge-claim">{p.claim}</div>}
              <div className="muted small">→ {p.targetPageId ?? p.id}</div>
              <div className="knowledge-card-actions">
                <Button size="sm" variant="primary" disabled={busy} data-testid={`knowledge-accept-${p.id}`} onClick={() => void decide(p.id, 'accept')}>Accept</Button>
                <Button size="sm" disabled={busy} data-testid={`knowledge-reject-${p.id}`} onClick={() => void decide(p.id, 'reject')}>Reject</Button>
                <Button size="sm" variant="ghost" onClick={() => void open(p.id)}>Preview</Button>
              </div>
            </div>
          ))}
        </section>
      )}

      {detail ? (
        <section className="knowledge-detail" data-testid="knowledge-detail">
          <div className="knowledge-card-head">
            <Button size="sm" variant="ghost" icon="chevron" onClick={() => setDetail(null)} title="Back to the list" />
            <span className="knowledge-title">{detail.page.meta.title}</span>
            <Badge tone={statusTone(detail.page.meta.status)}>{detail.page.meta.status}</Badge>
          </div>
          {/* A generated draft is only knowledge once a human accepts it; until then it is not served. */}
          {detail.page.meta.status !== 'current' && (
            <div className="knowledge-card-actions">
              <Button size="sm" variant="primary" disabled={busy} data-testid="knowledge-page-accept" onClick={() => void decide(detail.page.meta.id, 'accept')}>
                Accept as current
              </Button>
              <Button size="sm" disabled={busy} data-testid="knowledge-page-discard" onClick={() => void decide(detail.page.meta.id, 'reject')}>
                Discard
              </Button>
            </div>
          )}
          {detail.page.meta.claim && <div className="knowledge-claim">{detail.page.meta.claim}</div>}
          {detail.stale && (
            <div className="knowledge-stale" data-testid="knowledge-stale">
              <Icon name="alert" size={12} /> Possibly out of date: {detail.staleReasons.join('; ')}
            </div>
          )}
          <div className="knowledge-body markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.page.body, { fileLinks: true }) }} />
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
                {detail.page.meta.anchors.map((a) => (
                  <li key={`${a.file}:${a.symbol ?? ''}`}><code className="mono">{a.file}</code>{a.symbol ? `#${a.symbol}` : ''}</li>
                ))}
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
          {shown.length === 0 && status.hasWiki && <div className="muted small">No pages match.</div>}
          {shown.map((page) => {
            const pending = page.status !== 'current' && page.status !== 'deprecated' && page.status !== 'superseded';
            return (
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
                  {page.snippet && <span className="muted small knowledge-snippet" dangerouslySetInnerHTML={{ __html: page.snippet.replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>') }} />}
                </span>
                <span className="muted small">{page.kind}</span>
                <Badge tone={statusTone(page.status)}>{authorityLabel(page)}</Badge>
                {pending && (
                  <Button
                    size="sm"
                    variant="primary"
                    icon="check"
                    title="Accept as current"
                    aria-label={`Accept ${page.title}`}
                    data-testid={`knowledge-row-accept-${page.id}`}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void decide(page.id, 'accept');
                    }}
                  />
                )}
              </div>
            );
          })}
        </section>
      )}

      <section className="knowledge-switches">
        <Toggle checked={view.settings.prime} disabled={busy} onChange={(v) => void patchSettings({ prime: v })} label="Prime new sessions with the knowledge digest" />
        <Toggle checked={view.settings.autoDistill} disabled={busy} onChange={(v) => void patchSettings({ autoDistill: v })} label="Distil commits, PRs and merges automatically" />
      </section>
    </div>
  );
}
