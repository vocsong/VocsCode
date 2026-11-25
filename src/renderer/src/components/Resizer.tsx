/**
 * Drag handle for the sidebar and the right-hand panel.
 *
 * While dragging it writes the grid's `--sidebar` / `--panel` custom property straight onto the
 * `.app` element so the pane tracks the pointer without a React render per mouse move; the final
 * width is persisted to settings on release (App re-renders with the same value, so nothing jumps).
 */
import React, { useState } from 'react';
import { invoke } from '../api';
import { useStore } from '../store';
import { useMinimalUi } from '../ui-mode';

type Target = 'sidebar' | 'panel';

/** Bounds and reset width per pane; the defaults mirror SettingsStore's. */
const LIMITS: Record<Target, { min: number; max: number; def: number }> = {
  sidebar: { min: 200, max: 560, def: 280 },
  panel: { min: 300, max: 760, def: 420 }
};

/** The main column never gets squeezed below this, whatever the window size. */
const MAIN_MIN = 420;

/**
 * Zen: the side panel is a drawer that slides out over the column, so it starts wider than the
 * Standard panel. ui-zen.css draws it at `max(--panel, 560px)`; the drag uses the same floor so the
 * edge stays under the pointer. Both sides also keep a 52px rail when they are not pinned open.
 */
const ZEN_PANEL_MIN = 560;
const ZEN_RAIL = 52;

const VAR: Record<Target, string> = { sidebar: '--sidebar', panel: '--panel' };

export function Resizer({ target }: { target: Target }) {
  const [dragging, setDragging] = useState(false);
  const sidebarWidth = useStore((s) => s.settings?.sidebarWidth);
  const panelWidth = useStore((s) => s.settings?.panelWidth);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const pins = useStore((s) => s.pins);
  const minimal = useMinimalUi();
  if (sidebarWidth === undefined || panelWidth === undefined) return null;

  const zenPanel = Math.max(ZEN_PANEL_MIN, panelWidth);
  const width = target === 'sidebar' ? sidebarWidth : minimal ? zenPanel : panelWidth;
  const other = !minimal
    ? target === 'sidebar' ? (panelOpen ? panelWidth : 0) : sidebarOpen ? sidebarWidth : 0
    : target === 'sidebar'
      ? panelOpen ? ZEN_RAIL + (pins.right ? zenPanel : 0) : 0
      : sidebarOpen ? (pins.left ? sidebarWidth : ZEN_RAIL) : 0;
  const { max, def } = LIMITS[target];
  const min = minimal && target === 'panel' ? ZEN_PANEL_MIN : LIMITS[target].min;
  const clamp = (w: number) => Math.round(Math.min(Math.min(max, window.innerWidth - other - MAIN_MIN), Math.max(min, w)));

  const paint = (w: number) => document.querySelector<HTMLElement>('.app')?.style.setProperty(VAR[target], `${w}px`);

  const commit = (w: number) => {
    if (w === width) return;
    paint(w);
    void invoke('settings:update', target === 'sidebar' ? { sidebarWidth: w } : { panelWidth: w })
      .then((s) => useStore.getState().setSettings(s))
      .catch(() => paint(width));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    let next = width;
    setDragging(true);
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      // The sidebar grows to the right, the panel to the left.
      next = clamp(width + (target === 'sidebar' ? ev.clientX - startX : startX - ev.clientX));
      paint(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      setDragging(false);
      commit(next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') commit(clamp(width + (target === 'sidebar' ? -step : step)));
    else if (e.key === 'ArrowRight') commit(clamp(width + (target === 'sidebar' ? step : -step)));
    else if (e.key === 'Home' || e.key === 'Enter') commit(clamp(def));
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`resizer resizer-${target} ${dragging ? 'dragging' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => commit(clamp(def))}
      onKeyDown={onKeyDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${target === 'sidebar' ? 'sidebar' : 'panel'}`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
    />
  );
}

/** Bounds for the panel's vertical split, as a share of its height owned by the upper half. */
const SPLIT = { min: 0.2, max: 0.8, def: 0.62 };

/**
 * Drag handle between the panel's two halves.
 *
 * Same contract as `Resizer`, rotated: the split fraction is written straight onto `--panel-split`
 * while dragging and persisted to settings on release, so the halves track the pointer without a
 * React render per mouse move.
 */
export function SplitResizer() {
  const [dragging, setDragging] = useState(false);
  const hasSettings = useStore((s) => s.settings !== null);
  const panelSplit = useStore((s) => s.settings?.panelSplit);
  if (!hasSettings) return null;
  const current = Math.min(SPLIT.max, Math.max(SPLIT.min, panelSplit ?? SPLIT.def));
  const clamp = (fraction: number) => Math.min(SPLIT.max, Math.max(SPLIT.min, fraction));

  const paint = (fraction: number) => document.querySelector<HTMLElement>('.app')?.style.setProperty('--panel-split', String(fraction));
  const commit = (fraction: number) => {
    const next = Math.round(clamp(fraction) * 1000) / 1000;
    if (next === current) return;
    paint(next);
    void invoke('settings:update', { panelSplit: next })
      .then((s) => useStore.getState().setSettings(s))
      .catch(() => paint(current));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const panel = e.currentTarget.parentElement;
    const height = panel?.getBoundingClientRect().height ?? 0;
    if (!height) return;
    const startY = e.clientY;
    let next = current;
    setDragging(true);
    document.body.classList.add('resizing-row');
    const move = (ev: PointerEvent) => {
      next = clamp(current + (ev.clientY - startY) / height);
      paint(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-row');
      setDragging(false);
      commit(next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.08 : 0.025;
    if (e.key === 'ArrowUp') commit(current - step);
    else if (e.key === 'ArrowDown') commit(current + step);
    else if (e.key === 'Home' || e.key === 'Enter') commit(SPLIT.def);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`resizer resizer-split ${dragging ? 'dragging' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => commit(SPLIT.def)}
      onKeyDown={onKeyDown}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize panel sections"
      aria-valuenow={Math.round(current * 100)}
      aria-valuemin={Math.round(SPLIT.min * 100)}
      aria-valuemax={Math.round(SPLIT.max * 100)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
    />
  );
}
