/** Deep search modal (Ctrl+Shift+F): titles, goals and full transcript content via main's FTS5 index. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchCategory, SearchResponse, SearchResult } from '../../../shared/types';
import { invoke } from '../api';
import { relTime } from '../format';
import { useStore } from '../store';
import { HighlightedSnippet } from './HighlightedSnippet';
import { Icon } from './ui';
import { SessionTitle } from './SessionTitle';

const KIND_ICON: Record<SearchResult['kind'], string> = { meta: 'sparkles', user: 'send', assistant: 'sparkles', tool: 'terminal', info: 'info' };
const CATEGORIES = [
  { id: 'all', label: 'All content', placeholder: 'Search titles, goals and full transcripts…', empty: 'No matches in titles, goals or transcripts.' },
  { id: 'title', label: 'Session names', placeholder: 'Search session names…', empty: 'No matching session names.' },
  { id: 'goal', label: 'Goals', placeholder: 'Search session goals…', empty: 'No matching goals.' },
  { id: 'transcript', label: 'Transcript', placeholder: 'Search user and assistant messages…', empty: 'No matching transcript messages.' },
  { id: 'tool', label: 'Tool output', placeholder: 'Search tool calls and output…', empty: 'No matches in tool output.' }
] as const satisfies readonly { id: SearchCategory; label: string; placeholder: string; empty: string }[];
const NO_RESULTS: SearchResult[] = [];

export function SearchModal() {
  const sessions = useStore((s) => s.sessions);
  const close = () => useStore.getState().openSearch(false);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>(CATEGORIES[0]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const term = q.trim();
  const request = useMemo(() => ({ q: term, filters: { archived: includeArchived, category: category.id } }), [term, includeArchived, category]);
  const [settled, setSettled] = useState<{ request: typeof request; response: SearchResponse | null }>();
  const current = settled?.request === request ? settled : undefined;
  const results = current?.response?.results ?? NO_RESULTS;
  const searching = Boolean(term && !current);
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  // Hide old results immediately on a scope change, and ignore any late responses.
  useEffect(() => {
    if (!request.q) return;
    let cancelled = false;
    const t = setTimeout(() => {
      invoke('sessions:search', request).then(
        (response) => { if (!cancelled) setSettled({ request, response }); },
        () => { if (!cancelled) setSettled({ request, response: null }); }
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [request]);

  useEffect(() => setIdx(0), [request, results]);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const run = (r: SearchResult) => {
    close();
    useStore.getState().jumpToSearchMatch(r.sessionId, r.itemId);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette search-palette" role="dialog" aria-label="Session search" aria-modal="true" onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}>
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={ref}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search sessions"
            placeholder={category.placeholder}
            onKeyDown={(e) => {
              if (!results.length) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setIdx((i) => Math.max(0, Math.min(i + step, results.length - 1)));
              } else if (e.key === 'Enter' && results[idx]) run(results[idx]);
            }}
          />
          {searching && <Icon name="bolt" size={14} className="muted" />}
        </div>
        <div className="search-filters">
          <div className="search-categories" role="group" aria-label="Search category">
            {CATEGORIES.map((option) => (
              <button key={option.id} type="button" aria-pressed={category.id === option.id} onClick={() => setCategory(option)}>
                {option.label}
              </button>
            ))}
          </div>
          <label className="search-archived">
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} /> Include archived
          </label>
        </div>
        <div className="palette-list" aria-busy={searching}>
          {current && (!current.response?.available || !results.length) && (
            <div className="sidebar-empty" role="status">
              {!current.response ? 'Search failed.' : current.response.available ? category.empty : 'Deep search is unavailable in this runtime.'}
            </div>
          )}
          {results.map((r, i) => {
            const s = byId.get(r.sessionId);
            return (
              <button
                key={`${r.sessionId}:${r.itemId ?? 'meta'}:${i}`}
                type="button"
                className={`palette-item search-item ${i === idx ? 'active' : ''}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => run(r)}
              >
                <Icon name={KIND_ICON[r.kind]} size={14} />
                <span className="search-body">
                  <span className="search-title">
                    {s ? <SessionTitle session={s} /> : r.sessionId}
                    {s && <span className="search-meta">{relTime(s.updatedAt)}</span>}
                  </span>
                  <span className="search-snippet">
                    <HighlightedSnippet text={r.snippet} />
                  </span>
                </span>
              </button>
            );
          })}
          {term && (
            <div className="search-hint muted small">
              Enter opens the match · prefix <code>term*</code> · quotes stay literal · Esc closes
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
