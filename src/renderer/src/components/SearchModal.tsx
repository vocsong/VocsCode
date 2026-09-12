/** Deep search modal (Ctrl+Shift+F): titles, goals and full transcript content via main's FTS5 index. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchResult } from '../../../shared/types';
import { invoke } from '../api';
import { basename, harnessShort, relTime } from '../format';
import { useStore } from '../store';
import { Icon } from './ui';

/** \u0001/\u0002 from main's snippet() become <mark>; \\u2026 ellipsis passes through. */
function Snippet({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/[\u0001\u0002]/), [text]);
  return (
    <>
      {parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <React.Fragment key={i}>{p}</React.Fragment>))}
    </>
  );
}

const KIND_ICON: Record<string, string> = { meta: 'sparkles', user: 'send', assistant: 'sparkles', tool: 'terminal', info: 'info' };

export function SearchModal() {
  const sessions = useStore((s) => s.sessions);
  const close = () => useStore.getState().openSearch(false);
  const [q, setQ] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [available, setAvailable] = useState(true);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  // Debounced deep search; the last request wins.
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      invoke('sessions:search', { q: term, filters: { archived: includeArchived } })
        .then((r) => {
          setAvailable(r.available);
          setResults(r.results);
          setSearching(false);
        })
        .catch(() => {
          setResults([]);
          setSearching(false);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [q, includeArchived]);

  useEffect(() => setIdx(0), [q, results]);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const run = (r: SearchResult) => useStore.getState().jumpToSearchMatch(r.sessionId, r.itemId);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette search-palette">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={ref}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search titles, goals and full transcripts…"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setIdx((i) => Math.min(i + 1, results.length - 1));
              else if (e.key === 'ArrowUp') setIdx((i) => Math.max(i - 1, 0));
              else if (e.key === 'Enter' && results[idx]) {
                close();
                run(results[idx]);
              } else if (e.key === 'Escape') close();
            }}
          />
          {searching && <Icon name="bolt" size={14} className="muted" />}
        </div>
        <label className="search-archived">
          <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} /> Include archived
        </label>
        <div className="palette-list">
          {!available && <div className="sidebar-empty">Deep search is unavailable in this runtime.</div>}
          {available && q.trim() && results.length === 0 && !searching && <div className="sidebar-empty">No matches in titles, goals or transcripts.</div>}
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
                <Icon name={KIND_ICON[r.kind] ?? 'file'} size={14} />
                <span className="search-body">
                  <span className="search-title">
                    {s?.title ?? r.sessionId}
                    <span className="qs-root">
                      {s ? `${harnessShort(s.config.harness)} · ${basename(s.config.projectRoot)} · ${relTime(s.updatedAt)}` : ''}
                    </span>
                  </span>
                  <span className="search-snippet">
                    <Snippet text={r.snippet} />
                  </span>
                </span>
              </button>
            );
          })}
          {q.trim() && (
            <div className="search-hint muted small">
              Enter opens the match · prefix <code>term*</code> · quotes stay literal · Esc closes
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
