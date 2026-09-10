/** Searchable model picker with star favorites: shared by the header dropdown and the new-session dialog. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelInfo, ModelRef } from '../../../shared/types';
import { invoke } from '../api';
import { useStore } from '../store';
import { Icon, Spinner } from './ui';

const EMPTY_FAVORITES: ModelRef[] = [];

const favKey = (m: ModelRef) => `${m.provider}::${m.model}`;
const infoKey = (m: ModelInfo) => `${m.provider}::${m.id}`;

export function ModelPicker({
  models,
  loading,
  error,
  selected,
  onSelect,
  clearOption,
  emptyText = 'No models available'
}: {
  models: ModelInfo[];
  loading?: boolean;
  error?: string;
  selected?: ModelRef;
  onSelect: (m: ModelInfo | null) => void;
  /** Optional "no explicit model" row (e.g. harness default). */
  clearOption?: { label: string };
  emptyText?: string;
}) {
  const favorites = useStore((s) => s.settings?.favoriteModels ?? EMPTY_FAVORITES);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const favSet = useMemo(() => new Set(favorites.map(favKey)), [favorites]);

  const toggleFavorite = (m: ModelInfo) => {
    const key = infoKey(m);
    const next = favorites.some((f) => favKey(f) === key)
      ? favorites.filter((f) => favKey(f) !== key)
      : [...favorites, { provider: m.provider, model: m.id }];
    void invoke('settings:update', { favoriteModels: next });
  };

  const matches = (m: ModelInfo) =>
    !q || m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q);

  const rows = useMemo(() => {
    // Keep only models that still exist in the current catalog, preserving stored order.
    const known = favorites.filter((f) => models.some((m) => m.provider === f.provider && m.id === f.model));
    const isFav = (m: ModelInfo) => known.some((f) => f.provider === m.provider && f.model === m.id);
    const rest = models.filter((m) => !isFav(m));
    return { known, isFav, rest };
  }, [favorites, models]);

  const renderRow = (m: ModelInfo) => {
    const active = selected && selected.provider === m.provider && selected.model === m.id;
    const fav = rows.isFav(m);
    return (
      <div key={`${m.provider}/${m.id}`} className={`mp-row ${active ? 'active' : ''}`}>
        <button type="button" className="mp-select" onClick={() => onSelect(m)}>
          <span className="mp-name" title={`${m.provider}/${m.id}`}>
            {m.displayName}
          </span>
          <span className="menu-item-hint">{m.pricing ? `$${m.pricing.input}/$${m.pricing.output}` : undefined}</span>
          {active && <Icon name="check" size={14} />}
        </button>
        <button
          type="button"
          className={`mp-star ${fav ? 'on' : ''}`}
          title={fav ? 'Remove from favorites' : 'Add to favorites'}
          aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(m);
          }}
        >
          <Icon name="star" size={14} />
        </button>
      </div>
    );
  };

  const favRows = rows.known.map((f) => models.find((m) => m.provider === f.provider && m.id === f.model)!).filter(Boolean);
  const filteredFav = favRows.filter(matches);
  const groups = new Map<string, ModelInfo[]>();
  for (const m of rows.rest) if (matches(m)) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  const anyResults = filteredFav.length > 0 || groups.size > 0;

  return (
    <div className="model-picker">
      <div className="mp-search">
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models…"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const first = filteredFav[0] ?? [...groups.values()][0]?.[0];
              if (first) onSelect(first);
            }
          }}
        />
        {query && (
          <button type="button" className="mp-clear" onClick={() => setQuery('')} aria-label="Clear search">
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      {loading && (
        <div className="menu-empty row gap6">
          <Spinner size={11} /> Loading models…
        </div>
      )}
      {error && <div className="menu-empty">{error}</div>}
      {!loading && !error && !anyResults && <div className="menu-empty">{q ? `No models match “${query}”.` : emptyText}</div>}
      <div className="mp-list">
        {filteredFav.length > 0 && (
          <>
            <div className="menu-group">Favorites</div>
            {filteredFav.map(renderRow)}
          </>
        )}
        {[...groups.entries()].map(([provider, list]) => (
          <div key={provider}>
            <div className="menu-group">{provider}</div>
            {list.map(renderRow)}
          </div>
        ))}
        {clearOption && !q && (
          <>
            <div className="menu-group">Other</div>
            <button type="button" className={`menu-item ${!selected ? 'active' : ''}`} onClick={() => onSelect(null)}>
              <span className="menu-item-label">{clearOption.label}</span>
              {!selected && <Icon name="check" size={14} />}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
