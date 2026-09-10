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

type Target = 'sidebar' | 'panel';

/** Bounds and reset width per pane; the defaults mirror SettingsStore's. */
const LIMITS: Record<Target, { min: number; max: number; def: number }> = {
  sidebar: { min: 200, max: 560, def: 280 },
  panel: { min: 300, max: 760, def: 420 }
};

/** The main column never gets squeezed below this, whatever the window size. */
const MAIN_MIN = 420;

const VAR: Record<Target, string> = { sidebar: '--sidebar', panel: '--panel' };

export function Resizer({ target }: { target: Target }) {
  const [dragging, setDragging] = useState(false);
  const settings = useStore((s) => s.settings);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  if (!settings) return null;

  const width = target === 'sidebar' ? settings.sidebarWidth : settings.panelWidth;
  const other = target === 'sidebar' ? (panelOpen ? settings.panelWidth : 0) : sidebarOpen ? settings.sidebarWidth : 0;
  const { min, max, def } = LIMITS[target];
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
