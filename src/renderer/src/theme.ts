/**
 * Applies the theme catalogue to the document.
 *
 * Light and Dark are authored in `styles.css` so a full palette exists before any script runs;
 * every other theme is data in `src/shared/themes.ts` and injected here as one stylesheet.
 */
import { isThemeId, themeCss, type ThemeId } from '../../shared/themes';
import { DEFAULT_UI_MODE, isUiModeId, type UiModeId } from '../../shared/ui-modes';

const STYLE_ID = 'vocs-theme-palettes';

/** Injects the data-driven palettes. Safe to call more than once. */
export function installThemeStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = themeCss();
  document.head.append(el);
}

export function applyTheme(id: ThemeId): void {
  document.documentElement.setAttribute('data-theme', id);
}

/** The theme currently on `<html>`, for code that reads the DOM rather than the store. */
export function activeTheme(): ThemeId {
  const id = document.documentElement.getAttribute('data-theme');
  return isThemeId(id) ? id : 'system';
}

export function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Applies an interface mode (shared/ui-modes.ts). Only an attribute changes: the minimalist layouts
 * are CSS over the same component tree, so nothing remounts and no state is lost on a switch.
 */
export function applyUiMode(id: UiModeId | undefined): void {
  document.documentElement.setAttribute('data-ui', isUiModeId(id) ? id : DEFAULT_UI_MODE);
}

/** The interface mode currently on `<html>`. */
export function activeUiMode(): UiModeId {
  const id = document.documentElement.getAttribute('data-ui');
  return isUiModeId(id) ? id : DEFAULT_UI_MODE;
}
