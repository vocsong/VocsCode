/** Autocomplete popovers for @file mentions and /slash commands in the Composer. */
import React from 'react';
import type { SlashEntry } from '../../../../shared/harness-commands';
import { Icon } from '../ui';

export interface MentionState {
  query: string;
  start: number;
  results: string[];
  index: number;
}

export interface SlashState {
  query: string;
  index: number;
}

export function MentionPopover({
  mention,
  mentionError,
  onPick
}: {
  mention: MentionState | null;
  mentionError: string | null;
  onPick: (file: string) => void;
}) {
  if (!mention || (mention.results.length === 0 && !mentionError)) return null;
  return (
    <div className="popover">
      {mentionError ? (
        <div className="popover-item muted"><Icon name="alert" size={12} /> {mentionError}</div>
      ) : mention.results.map((r, i) => (
        <button key={r} type="button" className={`popover-item mono ${i === mention.index ? 'active' : ''}`} onMouseDown={(e) => { e.preventDefault(); onPick(r); }}>
          <Icon name="file" size={12} /> {r}
        </button>
      ))}
    </div>
  );
}

export function SlashPopover({
  slash,
  slashMatches,
  harnessName,
  harnessNote,
  popoverRef,
  onPick
}: {
  slash: SlashState | null;
  slashMatches: SlashEntry[];
  harnessName: string;
  harnessNote: string | null;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  onPick: (entry: SlashEntry) => void;
}) {
  if (!slash || slashMatches.length === 0) return null;
  return (
    <div className="popover slash-popover" ref={popoverRef} role="listbox" aria-label="Slash commands">
      {slashMatches.map((c, i) => (
        <React.Fragment key={`${c.source}:${c.insert}`}>
          {(i === 0 || slashMatches[i - 1].source !== c.source) && (
            <div className="slash-section" role="presentation">{c.source === 'app' ? 'Vocs Code' : harnessName}</div>
          )}
          <button
            type="button"
            role="option"
            aria-selected={i === slash.index}
            data-source={c.source}
            className={`popover-item slash-item ${i === slash.index ? 'active' : ''}`}
            title={c.shadowed ? `Vocs Code has its own /${c.insert.slice(1)}; //${c.insert.slice(1)} sends this one to ${harnessName}.` : undefined}
            onMouseDown={(e) => { e.preventDefault(); onPick(c); }}
          >
            <span className="mono slash-name">/{c.insert}</span>
            {c.args && <span className="muted slash-args">{c.args}</span>}
            {c.kind && c.kind !== 'command' && <span className="slash-kind">{c.kind}</span>}
            <span className="spacer" />
            <span className="muted small slash-desc">{c.shadowed ? [`${harnessName}'s own`, c.description].filter(Boolean).join(' · ') : c.description}</span>
          </button>
        </React.Fragment>
      ))}
      {harnessNote && <div className="slash-note muted small" role="note">{harnessNote}</div>}
    </div>
  );
}
