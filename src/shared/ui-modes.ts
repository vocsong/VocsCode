/**
 * The app's interface modes: how the window is laid out, independent of its color theme.
 *
 * `standard` is the full layout and `zen` the minimalist alternative, which re-lays the same component
 * tree out with CSS keyed on `<html data-ui>` (`src/renderer/src/ui-zen.css`). Switching therefore
 * never remounts anything, so a draft, a running turn, a terminal or an open panel survive the
 * switch. Every theme works in every mode.
 */

export type UiModeId = 'standard' | 'zen';

export interface UiModeDescriptor {
  id: UiModeId;
  name: string;
  /** One line for the picker card. */
  tagline: string;
  /** Longer copy for the card's tooltip and the settings search. */
  description: string;
}

export const DEFAULT_UI_MODE: UiModeId = 'standard';

export const UI_MODES: readonly UiModeDescriptor[] = [
  {
    id: 'standard',
    name: 'Standard',
    tagline: 'Everything in view',
    description: 'The full layout: a labelled sidebar, session header, side panel and menu bar.'
  },
  {
    id: 'zen',
    name: 'Zen',
    tagline: 'One calm column',
    description: 'Sessions become a rail of dots that opens on hover, the conversation sits in one centered column, the composer floats and the side panel slides over as a drawer. Controls show up when you reach for them.'
  }
];

export function isUiModeId(value: unknown): value is UiModeId {
  return typeof value === 'string' && UI_MODES.some((m) => m.id === value);
}

/** True for the minimalist mode, with its one-button menu and icon-only chrome. */
export function isMinimalUiMode(id: UiModeId | undefined): boolean {
  return id === 'zen';
}
