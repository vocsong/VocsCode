/**
 * The interface mode as React sees it. The layout itself is CSS on `<html data-ui>` (theme.ts's
 * applyUiMode); components only read the mode where a minimalist layout needs different markup:
 * a tooltip in place of a hidden label, a shorter placeholder, the one-button menu.
 */
import { invoke } from './api';
import { toastError, useStore } from './store';
import { DEFAULT_UI_MODE, isMinimalUiMode, type UiModeId } from '../../shared/ui-modes';

export function useUiMode(): UiModeId {
  return useStore((s) => s.settings?.uiMode ?? DEFAULT_UI_MODE);
}

/** True in Zen and Paper, where labels give way to icons and glyphs. */
export function useMinimalUi(): boolean {
  return useStore((s) => isMinimalUiMode(s.settings?.uiMode));
}

/** Saves the mode; the settings push re-renders the app, and App applies it to `<html>`. */
export function setUiMode(id: UiModeId): void {
  if (useStore.getState().settings?.uiMode === id) return;
  void invoke('settings:update', { uiMode: id }).catch(toastError);
}
