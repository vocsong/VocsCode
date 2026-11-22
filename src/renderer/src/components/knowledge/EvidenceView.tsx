import React, { useState } from 'react';
import type { ContextPacket, IntelligenceEvidence, IntelligenceSearchResponse } from '../../../../shared/intelligence';
import { invoke } from '../../api';
import { Badge, Button } from '../ui';
import type { IntelligenceSectionProps } from './useIntelligence';

/** Provenance and freshness stay visible even when the match is just a short excerpt. */
function EvidenceRow({ evidence }: { evidence: IntelligenceEvidence }) {
  const { provider, projectName, title, text, authority, historical, freshness, staleReason, revision, why } = evidence;
  return (
    <article className="intelligence-card" data-testid="evidence-row">
      <div className="intelligence-row">
        <Badge tone="blue">{provider}</Badge>
        <span className="muted small">{projectName}</span>
        <Badge>{authority}</Badge>
        {historical && authority !== 'history' && <Badge tone="amber">history</Badge>}
      </div>
      <h4>{title}</h4>
      {text && <p className="intelligence-text">{text.replace(/[\u0001\u0002]/g, '')}</p>}
      {freshness && <p className="muted small">{freshness === 'stale' && staleReason ? `stale — ${staleReason}` : freshness === 'unknown' ? 'Freshness unknown' : freshness}</p>}
      {revision && <p className="muted small">Revision <code title={revision}>{revision.slice(0, 12)}</code></p>}
      <p className="muted small">Why: {why}</p>
    </article>
  );
}

/** Inspect the evidence for a question before using its bounded, cited packet. */
export function EvidenceView({ sessionId, busy, run }: IntelligenceSectionProps) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'project' | 'collection'>('project');
  const [search, setSearch] = useState<IntelligenceSearchResponse | null>(null);
  const [packet, setPacket] = useState<ContextPacket | null>(null);
  const [copied, setCopied] = useState(false);
  const response = packet ?? search;
  const canQuery = !busy && !!query.trim();

  const submit = (kind: 'search' | 'compile') => run(async (current) => {
    const request = { sessionId, query: query.trim(), scope };
    if (kind === 'search') {
      const result = await invoke('intelligence:search', request);
      if (current()) {
        setSearch(result);
        setPacket(null);
      }
    } else {
      setCopied(false);
      const result = await invoke('intelligence:compile', request);
      if (current()) setPacket(result);
    }
  });

  const reset = () => {
    setSearch(null);
    setPacket(null);
    setCopied(false);
  };

  return (
    <div className="intelligence-view">
      <h3>Search evidence</h3>
      <form className="intelligence-fields" onSubmit={(e) => { e.preventDefault(); if (canQuery) void submit('search'); }}>
        <label className="intelligence-field">Question
          <input data-testid="evidence-query" value={query} placeholder="What has this project learned?" maxLength={500} disabled={busy} onChange={(e) => { setQuery(e.target.value); reset(); }} />
        </label>
        <label className="intelligence-field">Search scope
          <select data-testid="evidence-scope" value={scope} disabled={busy} onChange={(e) => { setScope(e.target.value === 'collection' ? 'collection' : 'project'); reset(); }}>
            <option value="project">This project</option>
            <option value="collection">Project and its collections</option>
          </select>
        </label>
        <div className="intelligence-actions">
          <Button size="sm" type="submit" variant="primary" data-testid="evidence-search" disabled={!canQuery}>Search</Button>
          <Button size="sm" data-testid="evidence-compile" disabled={!canQuery} onClick={() => void submit('compile')}>Compile context</Button>
        </div>
      </form>
      {!response && <p className="muted small">Ask a question to see evidence, or compile a context packet.</p>}
      {response && <p className="muted small">Detected intent: {response.intent}</p>}
      {search && (
        search.results.length ? search.results.map((item) => <EvidenceRow key={`${item.provider}:${item.projectId}:${item.ref}`} evidence={item} />)
          : <p className="muted small">No evidence matched — try a narrower question or another scope.</p>
      )}
      {!!response?.conflicts.length && <section className="intelligence-card" data-testid="evidence-conflicts">
        <h4>Conflicts</h4>
        <ul>{response.conflicts.map(({ a, b, reason }, i) => <li key={i}>{a} vs {b}: {reason}</li>)}</ul>
      </section>}
      {!!response?.missing.length && <section className="intelligence-card" data-testid="evidence-missing">
        <h4>Missing</h4>
        <ul>{response.missing.map((item, i) => <li key={i}>{item}</li>)}</ul>
      </section>}
      {packet && <section className="intelligence-card">
        <h4>Context packet</h4>
        <p className="muted small">{packet.usedTokens} of {packet.budgetTokens} tokens{packet.truncated ? ' · truncated' : ''}</p>
        <pre data-testid="evidence-packet">{packet.text}</pre>
        <div className="intelligence-actions">
          <Button size="sm" data-testid="evidence-copy" disabled={busy} onClick={() => void run(async (current) => {
            if (!navigator.clipboard) throw new Error('The clipboard is unavailable. Select and copy the packet text instead.');
            await navigator.clipboard.writeText(packet.text);
            if (current()) setCopied(true);
          })}>Copy</Button>
          {copied && <span className="muted small" role="status">Copied</span>}
        </div>
      </section>}
    </div>
  );
}
