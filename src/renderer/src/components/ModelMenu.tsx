/** The composer's quick model, reasoning and speed choices. Only the full catalog drills in. */
import React, { useEffect, useId, useRef, useState } from 'react';
import type { EffortLevel, ModelInfo, ModelRef, SessionMeta } from '../../../shared/types';
import { modelName } from '../../../shared/model-names';
import type { SessionControlOption } from '../session-controls';
import { quickModels } from '../session-controls';
import { useStore } from '../store';
import { Icon, MenuItem, Spinner } from './ui';
import { ModelPicker } from './ModelPicker';
import { FastModeOptions } from './FastModeOptions';

const NO_FAVORITES: ModelRef[] = [];

export function ModelMenu({
  session,
  models,
  loading,
  error,
  current,
  emptyText,
  effortSupported,
  effortLevels,
  effort,
  noEffortNote,
  onSelect,
  onSelectCustom,
  onEffort,
  close
}: {
  session: SessionMeta;
  models: ModelInfo[];
  loading: boolean;
  error?: string;
  current?: ModelRef;
  emptyText: string;
  /** Omit the whole effort section for harnesses that don't take reasoning effort. */
  effortSupported: boolean;
  effortLevels: SessionControlOption<EffortLevel>[];
  effort?: EffortLevel;
  noEffortNote: string;
  onSelect: (m: ModelInfo) => void;
  onSelectCustom: (id: string) => void;
  onEffort: (level: EffortLevel) => void;
  close: () => void;
}) {
  const favorites = useStore((s) => s.settings?.favoriteModels ?? NO_FAVORITES);
  const [showAll, setShowAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const favouriteId = useId();
  const effortId = useId();
  // Restore row focus when returning from the full picker, which focuses its own search.
  useEffect(() => {
    if (!showAll) ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [showAll]);

  if (showAll) {
    return (
      <div className="model-menu model-menu-wide">
        <button type="button" className="menu-item model-menu-back" aria-label="Back" onClick={() => setShowAll(false)}>
          <Icon name="arrowLeft" size={13} /> <span className="menu-item-label">All models</span>
        </button>
        <ModelPicker
          models={models}
          loading={loading}
          error={error}
          selected={current}
          emptyText={emptyText}
          onSelect={(m) => {
            close();
            if (m) onSelect(m);
          }}
          onSelectCustom={(id) => {
            close();
            onSelectCustom(id);
          }}
        />
      </div>
    );
  }

  const short = quickModels(models, favorites, current);
  return (
    <div ref={ref} className="model-menu">
      <div role="group" aria-labelledby={favouriteId}>
        <div className="run-more-label" id={favouriteId}>Favourite</div>
        <div className="model-menu-models">
          {short.map((m) => {
            const selected = m.provider === current?.provider && m.id === current.model;
            return (
              <MenuItem key={`${m.provider}::${m.id}`} active={selected} hint={m.displayName && m.displayName !== m.id ? m.displayName : undefined} onClick={() => { close(); if (!selected) onSelect(m); }}>
                {modelName(m.provider, m.id)}
              </MenuItem>
            );
          })}
        </div>
        {loading && !short.length && <div className="run-more-note row gap6"><Spinner size={11} /> Loading models…</div>}
        {!loading && !short.length && <div className="run-more-note">{error ?? emptyText}</div>}
        <MenuItem trailing={<Icon name="chevronRight" size={13} />} onClick={() => setShowAll(true)}>
          More models
        </MenuItem>
      </div>
      {effortSupported && (
        <div className="run-more-section" role="group" aria-labelledby={effortId}>
          <div className="run-more-label row gap6">
            <span id={effortId}>Reasoning Effort</span>
            <span className="spacer" />
            {!effort && effortLevels.length > 0 && <span className="menu-item-hint">Default</span>}
          </div>
          {effortLevels.map((option) => (
            <MenuItem key={option.value} checked={effort === option.value} onClick={() => { close(); onEffort(option.value); }}>
              {option.label}
            </MenuItem>
          ))}
          {!effortLevels.length && <div className="run-more-note">{noEffortNote}</div>}
        </div>
      )}
      <FastModeOptions key={session.id} session={session} />
    </div>
  );
}
