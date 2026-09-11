/**
 * The terminal's 16 ANSI slots, derived from a theme's own tokens so program output matches the
 * surrounding UI in every theme instead of using one fixed palette per light/dark branch.
 *
 * Pure color math: no DOM, no xterm. The renderer feeds it computed CSS custom properties; tests
 * feed it palettes straight from the theme catalogue.
 */

/** The theme tokens the palette is built from. */
export interface AnsiTokens {
  fg: string;
  bgElev: string;
  fgMuted: string;
  fgFaint: string;
  red: string;
  green: string;
  amber: string;
  blue: string;
  purple: string;
  cyan: string;
}

export interface AnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** Parses `#rgb`/`#rrggbb` into 0-255 channels, or null for anything else. */
export function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(c: [number, number, number]): string {
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/** Blends `a` toward `b` by `t` (0..1). Returns `a` verbatim if either side is unparseable. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as [number, number, number]);
}

/** Appends an alpha channel to a `#rrggbb` color; other formats pass through unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  return m ? `#${m[1]}${Math.round(alpha * 255).toString(16).padStart(2, '0')}` : color;
}

/**
 * "Bright" means more emphasis, not literally lighter: a bright hue is pushed away from the theme's
 * own ground, so it lightens on a dark theme and deepens on a light one. Lifting a light theme's
 * hues toward white instead would leave bright text less readable than normal text.
 */
export function ansiFromTokens(dark: boolean, t: AnsiTokens): AnsiPalette {
  const toward = dark ? '#ffffff' : '#000000';
  const amount = dark ? 0.3 : 0.18;
  const emphasize = (c: string): string => mix(c, toward, amount);
  const base = { red: t.red, green: t.green, yellow: t.amber, blue: t.blue, magenta: t.purple, cyan: t.cyan };
  return {
    ...base,
    brightRed: emphasize(base.red),
    brightGreen: emphasize(base.green),
    brightYellow: emphasize(base.yellow),
    brightBlue: emphasize(base.blue),
    brightMagenta: emphasize(base.magenta),
    brightCyan: emphasize(base.cyan),
    // In a dark theme "black" is the darkest surface and "white" a dimmed foreground; on paper the
    // two swap roles, so black is the body text and white the faintest readable gray. The two grays
    // come from different tokens in each branch, or normal white and bright black would collide.
    black: dark ? t.bgElev : t.fg,
    white: dark ? mix(t.fg, t.bgElev, 0.2) : t.fgFaint,
    brightBlack: dark ? t.fgFaint : t.fgMuted,
    brightWhite: dark ? mix(t.fg, '#ffffff', 0.55) : '#ffffff'
  };
}
