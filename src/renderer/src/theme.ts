/**
 * Applies the color theme to the document.
 *
 * Every palette variant is data in `src/shared/themes.ts`, injected here as one stylesheet keyed on
 * three attributes of `<html>`: `data-theme` (the chosen mode: system, light or dark),
 * `data-palette` (the color family) and `data-scheme` (the mode resolved against the OS — the one
 * the CSS reads). `styles.css` keeps a Default fallback so a full palette exists before any script
 * runs.
 */
import { DEFAULT_PALETTE, DEFAULT_THEME_MODE, isPaletteId, isThemeMode, resolveScheme, themeCss, type ColorScheme, type PaletteId, type ThemeMode } from '../../shared/themes';
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

let followingOs = false;

/** Re-resolves `data-scheme` from the mode on `<html>`; System tracks the OS through this. */
function paintScheme(): void {
  const root = document.documentElement;
  const scheme = resolveScheme(activeThemeMode(), systemPrefersDark());
  if (root.getAttribute('data-scheme') !== scheme) root.setAttribute('data-scheme', scheme);
}

/** Puts a mode and palette on `<html>`. Only attributes change, so nothing remounts. */
export function applyTheme(mode: ThemeMode, palette: PaletteId = DEFAULT_PALETTE): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', isThemeMode(mode) ? mode : DEFAULT_THEME_MODE);
  root.setAttribute('data-palette', isPaletteId(palette) ? palette : DEFAULT_PALETTE);
  paintScheme();
  const query = darkQuery();
  if (!followingOs && query) {
    followingOs = true;
    query.addEventListener('change', paintScheme);
  }
}

/** The mode currently on `<html>`, for code that reads the DOM rather than the store. */
export function activeThemeMode(): ThemeMode {
  const mode = document.documentElement.getAttribute('data-theme');
  return isThemeMode(mode) ? mode : DEFAULT_THEME_MODE;
}

/** The palette currently on `<html>`. */
export function activePalette(): PaletteId {
  const id = document.documentElement.getAttribute('data-palette');
  return isPaletteId(id) ? id : DEFAULT_PALETTE;
}

/** The scheme the window paints right now: the mode, with System resolved against the OS. */
export function activeScheme(): ColorScheme {
  return resolveScheme(activeThemeMode(), systemPrefersDark());
}

/** The OS dark-mode query, or null where the host has no matchMedia (jsdom). */
export function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
}

/** Whether the OS asks for dark. Without a media query to ask, System paints light. */
export function systemPrefersDark(): boolean {
  return darkQuery()?.matches ?? false;
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
