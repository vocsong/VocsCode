/** Ctrl+F find bar for the transcript: highlights matches in the rendered DOM via the CSS Custom Highlight API. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './ui';

const MATCH_HL = 'transcript-find-match';
const CURRENT_HL = 'transcript-find-current';

type HighlightRegistry = { highlights: Map<string, unknown> };

/** One match, possibly spanning several adjacent text nodes (e.g. across bold spans). */
type Match = Range[];

function registry(): HighlightRegistry | null {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return null;
  return CSS.highlights as unknown as HighlightRegistry;
}

/** Walk the container's text nodes and find every case-insensitive occurrence of the query. Exported for tests. */
export function search(root: HTMLElement, query: string): Match[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || p.closest('script, style, textarea, .find-bar')) return NodeFilter.FILTER_REJECT;
      return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    starts.push(text.length);
    text += node.nodeValue;
    nodes.push(node);
  }
  const haystack = text.toLowerCase();
  const matches: Match[] = [];
  let k = 0; // nodes are ordered, so the node scan resumes where the previous match left off
  let i = haystack.indexOf(q);
  while (i !== -1) {
    const end = i + q.length;
    const parts: Match = [];
    for (; k < nodes.length && starts[k] < end; k++) {
      const nodeEnd = starts[k] + nodes[k].nodeValue!.length;
      if (nodeEnd <= i) continue;
      const r = document.createRange();
      r.setStart(nodes[k], Math.max(i, starts[k]) - starts[k]);
      r.setEnd(nodes[k], Math.min(end, nodeEnd) - starts[k]);
      parts.push(r);
    }
    k = Math.max(0, k - 1); // the last node may also start the next match
    matches.push(parts);
    i = haystack.indexOf(q, i + 1);
  }
  return matches;
}

export function TranscriptFind({ open, onClose, container, revision }: { open: boolean; onClose: () => void; container: React.RefObject<HTMLDivElement | null>; revision: unknown }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-run the search whenever the query, visibility or transcript content changes.
  useEffect(() => {
    const hl = registry();
    const root = container.current;
    if (!open || !root || !hl) {
      setMatches([]);
      return;
    }
    const found = query ? search(root, query) : [];
    setMatches(found);
    setActive((a) => (found.length ? Math.min(a, found.length - 1) : 0));
    if (found.length) hl.highlights.set(MATCH_HL, new Highlight(...found.flat()));
    else hl.highlights.delete(MATCH_HL);
    return () => {
      hl.highlights.delete(MATCH_HL);
      hl.highlights.delete(CURRENT_HL);
    };
  }, [open, query, container, revision]);

  // Keep the active match highlighted and in view.
  useEffect(() => {
    const hl = registry();
    if (!hl) return;
    const current = matches[active];
    if (!current) {
      hl.highlights.delete(CURRENT_HL);
      return;
    }
    hl.highlights.set(CURRENT_HL, new Highlight(...current));
    current[0].startContainer.parentElement?.scrollIntoView({ block: 'center' });
  }, [active, matches]);

  useEffect(() => {
    if (open) inputRef.current?.select();
  }, [open]);

  const step = useCallback(
    (delta: number) => {
      if (!matches.length) return;
      setActive((a) => (a + delta + matches.length) % matches.length);
    },
    [matches.length],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  if (!open) return null;
  return (
    <div className="find-bar" onKeyDown={onKeyDown}>
      <Icon name="search" size={13} />
      <input ref={inputRef} value={query} placeholder="Find in messages" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
      <span className="find-count mono">{query ? (matches.length ? `${active + 1}/${matches.length}` : 'No matches') : ''}</span>
      <button type="button" className="find-btn" title="Previous match (Shift+Enter)" onClick={() => step(-1)}>
        <Icon name="chevron" size={13} className="rot-up" />
      </button>
      <button type="button" className="find-btn" title="Next match (Enter)" onClick={() => step(1)}>
        <Icon name="chevron" size={13} />
      </button>
      <button type="button" className="find-btn" title="Close (Escape)" onClick={onClose}>
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}
