/**
 * The composer's model menu: a short list of models, Effort › and More models › drilling in place
 * (a side flyout would clip at the window edge), and the Fast mode request. Unmounts on close, so it
 * always reopens on the short list.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { EffortLevel, ModelInfo, ModelRef, SessionMeta } from '../../../shared/types';
import { modelName } from '../../../shared/model-names';
import type { SessionControlOption } from '../session-controls';
import { quickModels } from '../session-controls';
import { useStore } from '../store';
import { Icon, MenuItem, Spinner } from './ui';
import { ModelPicker } from './ModelPicker';
import { FastModePill } from './FastModePill';

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
  /** The harness takes reasoning effort at all; without it the Effort row is not offered. */
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
  const [view, setView] = useState<'main' | 'effort' | 'models'>('main');
  const ref = useRef<HTMLDivElement>(null);
  // A drilled-in view keeps keyboard focus on its rows; the full picker focuses its own search.
  useEffect(() => {
    if (view !== 'models') ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [view]);

  const isCurrent = (m: ModelInfo) => !!current && m.provider === current.provider && m.id === current.model;
  const back = (label: string) => (
    <button type="button" className="menu-item model-menu-back" aria-label="Back" onClick={() => setView('main')}>
      <Icon name="arrowLeft" size={13} /> <span className="menu-item-label">{label}</span>
    </button>
  );

  if (view === 'models') {
    return (
      <div ref={ref} className="model-menu model-menu-wide">
        {back('All models')}
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

  if (view === 'effort') {
    return (
      <div ref={ref} className="model-menu">
        {back('Reasoning effort')}
        {effortLevels.map((option) => (
          <MenuItem key={option.value} active={effort === option.value} onClick={() => { close(); onEffort(option.value); }}>
            {option.label}
          </MenuItem>
        ))}
      </div>
    );
  }

  const short = quickModels(models, favorites, current);
  return (
    <div ref={ref} className="model-menu">
      <div className="model-menu-models">
        {short.map((m) => (
          <MenuItem key={`${m.provider}::${m.id}`} active={isCurrent(m)} hint={m.displayName && m.displayName !== m.id ? m.displayName : undefined} onClick={() => { close(); if (!isCurrent(m)) onSelect(m); }}>
            {modelName(m.provider, m.id)}
          </MenuItem>
        ))}
      </div>
      {loading && !short.length && <div className="run-more-note row gap6"><Spinner size={11} /> Loading models…</div>}
      {!loading && !short.length && <div className="run-more-note">{error ?? emptyText}</div>}
      {effortSupported && (
        <div className="run-more-section">
          <MenuItem disabled={!effortLevels.length} hint={effortLevels.length ? effort ?? 'default' : 'Not supported'} trailing={<Icon name="chevronRight" size={13} />} onClick={() => setView('effort')}>
            Effort
          </MenuItem>
          {!effortLevels.length && <div className="run-more-note">{noEffortNote}</div>}
        </div>
      )}
      <div className="run-more-section">
        <MenuItem trailing={<Icon name="chevronRight" size={13} />} onClick={() => setView('models')}>
          More models
        </MenuItem>
      </div>
      <div className="run-more-footer">
        <FastModePill key={session.id} session={session} />
      </div>
    </div>
  );
}
