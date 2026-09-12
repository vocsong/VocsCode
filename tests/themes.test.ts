/**
 * Guards the theme catalogue: every data-driven theme is complete, legible, visually distinct from
 * its siblings, and reachable through settings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GROUP_ORDER,
  THEMES,
  THEME_IDS,
  chromeFor,
  findTheme,
  isDarkTheme,
  isThemeId,
  swatchFor,
  themeCss,
  themeSourceFor,
  type ThemePalette
} from '../src/shared/themes';
import { ansiFromTokens, mix, parseHex, withAlpha, type AnsiTokens } from '../src/shared/ansi';
import { defaultSettings, normalizeSettings } from '../src/main/settings';

/** The tokens every palette must set; the CSS relies on all of them being present. */
const TOKENS: (keyof ThemePalette)[] = [
  'bg',
  'bgElev',
  'bgSunken',
  'bgHover',
  'bgActive',
  'fg',
  'fgMuted',
  'fgFaint',
  'border',
  'borderStrong',
  'accent',
  'accentFg',
  'green',
  'amber',
  'red',
  'blue',
  'purple',
  'cyan',
  'userBubble',
  'shadow'
];

/** Opaque tokens are plain hex so the main process and xterm can read them without a CSS parser. */
const HEX_TOKENS = TOKENS.filter((t) => t !== 'shadow' && t !== 'bgHover' && t !== 'bgActive');

const CUSTOM = THEMES.filter((t) => t.palette);

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb color: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Straight RGB distance, 0..441. Coarse, but enough to catch two themes that look the same. */
function distance(a: string, b: string): number {
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

describe('theme catalogue', () => {
  it('has the three built-ins plus twenty data-driven themes, with unique ids and names', () => {
    expect(THEMES.filter((t) => !t.palette).map((t) => t.id)).toEqual(['system', 'light', 'dark']);
    expect(CUSTOM).toHaveLength(20);
    expect(new Set(THEME_IDS).size).toBe(THEMES.length);
    expect(new Set(THEMES.map((t) => t.name)).size).toBe(THEMES.length);
  });

  it('puts every theme in a known group and leans navy', () => {
    for (const t of THEMES) expect(GROUP_ORDER).toContain(t.group);
    expect(CUSTOM.filter((t) => t.group === 'navy')).toHaveLength(4);
    // Nebula, Ultraviolet and Magma are futuristic, so seven of the twenty data themes are navy-family.
    expect(CUSTOM.filter((t) => t.group === 'navy' || t.group === 'futuristic').length).toBeGreaterThanOrEqual(5);
  });

  it('has exactly one animated theme and it is the futuristic one', () => {
    const animated = THEMES.filter((t) => t.animated);
    expect(animated.map((t) => t.id)).toEqual(['nebula']);
    expect(animated[0].group).toBe('futuristic');
  });

  it('defines every token, with opaque colors as plain hex', () => {
    for (const t of CUSTOM) {
      const palette = t.palette as ThemePalette;
      expect(Object.keys(palette).sort(), t.id).toEqual([...TOKENS].sort());
      for (const token of HEX_TOKENS) expect(palette[token], `${t.id}.${token}`).toMatch(/^#[0-9a-f]{6}$/);
      for (const token of ['bgHover', 'bgActive'] as const) expect(palette[token], `${t.id}.${token}`).toMatch(/^rgba\(/);
      expect(palette.shadow, `${t.id}.shadow`).toMatch(/^0 \d+px \d+px rgba\(/);
    }
  });

  it('keeps body text, secondary text and accent labels legible', () => {
    for (const t of CUSTOM) {
      const p = t.palette as ThemePalette;
      // AA for body text on both the ground and raised surfaces.
      expect(contrast(p.fg, p.bg), `${t.id} fg/bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.fg, p.bgElev), `${t.id} fg/bg-elev`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.fg, p.userBubble), `${t.id} fg/user-bubble`).toBeGreaterThanOrEqual(4.5);
      // AA-large for muted metadata and for text sitting on the accent.
      expect(contrast(p.fgMuted, p.bg), `${t.id} fg-muted/bg`).toBeGreaterThanOrEqual(3);
      expect(contrast(p.accentFg, p.accent), `${t.id} accent-fg/accent`).toBeGreaterThanOrEqual(3);
      // Status hues have to be readable as text, since badges tint them over the ground.
      for (const hue of ['green', 'amber', 'red', 'blue', 'purple', 'cyan'] as const) {
        expect(contrast(p[hue], p.bg), `${t.id} ${hue}/bg`).toBeGreaterThanOrEqual(3);
      }
      // Borders must be visible against the surfaces they separate.
      expect(contrast(p.borderStrong, p.bg), `${t.id} border-strong/bg`).toBeGreaterThanOrEqual(1.2);
    }
  });

  it('keeps the light/dark branch consistent with each palette', () => {
    for (const t of CUSTOM) {
      const p = t.palette as ThemePalette;
      const declaredDark = t.base === 'dark';
      expect(luminance(p.bg) < 0.18, `${t.id} base=${t.base}`).toBe(declaredDark);
      // The ground is the darkest surface in a dark theme and the lightest-adjacent in a light one.
      if (declaredDark) expect(luminance(p.bgSunken)).toBeLessThanOrEqual(luminance(p.bgElev));
      else expect(luminance(p.bgSunken)).toBeLessThanOrEqual(luminance(p.bgElev));
    }
  });

  it('makes every pair of themes visually distinguishable', () => {
    for (let i = 0; i < CUSTOM.length; i++) {
      for (let j = i + 1; j < CUSTOM.length; j++) {
        const a = CUSTOM[i].palette as ThemePalette;
        const b = CUSTOM[j].palette as ThemePalette;
        const label = `${CUSTOM[i].id} vs ${CUSTOM[j].id}`;
        expect(a.bg, label).not.toBe(b.bg);
        expect(a.accent, label).not.toBe(b.accent);
        // Either the ground or the accent has to be clearly different, not just off by a shade.
        expect(Math.max(distance(a.bg, b.bg), distance(a.accent, b.accent)), label).toBeGreaterThan(40);
      }
    }
  });
});

describe('theme lookups', () => {
  it('accepts catalogue ids and rejects anything else', () => {
    for (const id of THEME_IDS) expect(isThemeId(id)).toBe(true);
    for (const junk of ['', 'Dark', 'midnight-navy', 'nebula ', null, 7, undefined]) expect(isThemeId(junk)).toBe(false);
    expect(findTheme('nope')).toBeUndefined();
  });

  it('maps each theme onto a nativeTheme source', () => {
    expect(themeSourceFor('system')).toBe('system');
    expect(themeSourceFor('blueprint')).toBe('light');
    expect(themeSourceFor('midnight')).toBe('dark');
    // Unknown ids must not crash the main process; they defer to the OS.
    expect(themeSourceFor('nope')).toBe('system');
  });

  it('resolves darkness, deferring to the OS only for system', () => {
    expect(isDarkTheme('system', true)).toBe(true);
    expect(isDarkTheme('system', false)).toBe(false);
    expect(isDarkTheme('abyss', false)).toBe(true);
    expect(isDarkTheme('solarium', true)).toBe(false);
  });

  it('derives caption colors from the theme, not from the OS', () => {
    const midnight = findTheme('midnight')?.palette as ThemePalette;
    expect(chromeFor('midnight', false)).toEqual({ color: midnight.bgElev, symbolColor: midnight.fg });
    // Two dark themes must not share a caption, or switching between them would show the old one.
    expect(chromeFor('midnight', true)).not.toEqual(chromeFor('ember', true));
    // The built-ins have no palette of their own and follow the light/dark pair in styles.css.
    expect(chromeFor('system', true)).toEqual(chromeFor('dark', false));
    expect(chromeFor('system', false)).toEqual(chromeFor('light', true));
  });

  it('builds a three-color swatch for every theme', () => {
    for (const id of THEME_IDS) {
      const swatch = swatchFor(id, true);
      expect(swatch, id).toHaveLength(3);
      for (const c of swatch) expect(c, id).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(swatchFor('system', true)).not.toEqual(swatchFor('system', false));
  });
});

describe('themeCss', () => {
  const css = themeCss();

  it('emits one block per data-driven theme and none for the built-ins', () => {
    for (const t of CUSTOM) expect(css).toContain(`html:root[data-theme='${t.id}'] {`);
    for (const id of ['system', 'light', 'dark']) expect(css).not.toContain(`html:root[data-theme='${id}'] {`);
  });

  it('writes every token as a kebab-case custom property with a color-scheme', () => {
    const block = css.split(`html:root[data-theme='midnight'] {`)[1].split('}')[0];
    expect(block).toContain('color-scheme: dark;');
    expect(block).toContain('--bg-elev: #16243c;');
    expect(block).toContain('--border-strong: #2f4569;');
    expect(block).toContain('--user-bubble: #1a2b47;');
    expect(block).not.toMatch(/--[a-z]*[A-Z]/);
    expect(css.split(`html:root[data-theme='blueprint'] {`)[1].split('}')[0]).toContain('color-scheme: light;');
  });

  it('declares only tokens that something actually consumes', () => {
    const read = (f: string): string => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
    const styles = read('src/renderer/src/styles.css');
    const host = read('src/renderer/src/terminal/host.ts');
    // A token is consumed either through var() in the stylesheet or by name from the terminal,
    // which reads the computed properties to build its ANSI palette.
    const used = new Set([
      ...[...styles.matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]),
      ...[...host.matchAll(/'(--[a-z-]+)'/g)].map((m) => m[1])
    ]);
    for (const decl of new Set([...css.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]))) {
      expect(used, `${decl} is declared but never used`).toContain(decl);
    }
    // Themes declare base hues only; the -soft washes are computed once in :root.
    for (const soft of ['--accent-soft', '--red-soft', '--purple-soft']) {
      expect(css).not.toContain(soft);
      expect(styles).toContain(`${soft}: color-mix(`);
    }
  });
});

describe('theme settings', () => {
  it('defaults to system', () => {
    expect(defaultSettings().theme).toBe('system');
  });

  it('round-trips every catalogue id', () => {
    for (const id of THEME_IDS) expect(normalizeSettings({ theme: id }).theme).toBe(id);
  });

  it('falls back to system for a theme that is not in the catalogue', () => {
    for (const junk of ['solarized', '', 'DARK']) {
      expect(normalizeSettings({ theme: junk as never }).theme).toBe('system');
    }
    expect(normalizeSettings({}).theme).toBe('system');
  });
});

describe('terminal ANSI palette', () => {
  const tokensFor = (p: ThemePalette): AnsiTokens => ({
    fg: p.fg,
    bgElev: p.bgElev,
    fgMuted: p.fgMuted,
    fgFaint: p.fgFaint,
    red: p.red,
    green: p.green,
    amber: p.amber,
    blue: p.blue,
    purple: p.purple,
    cyan: p.cyan
  });

  it('gives every theme sixteen distinct, readable slots', () => {
    for (const t of CUSTOM) {
      const p = t.palette as ThemePalette;
      const ansi = ansiFromTokens(t.base === 'dark', tokensFor(p));
      const slots = Object.values(ansi);
      expect(slots, t.id).toHaveLength(16);
      for (const c of slots) expect(c, t.id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(new Set(slots.map((c) => c.toLowerCase())).size, `${t.id} has duplicate slots`).toBe(16);
      // The terminal paints on --bg-sunken, so every hue has to stay readable there. The four
      // achromatic slots are the ground-to-ink ramp itself — in a light theme white is a background
      // color, not text — so they are checked as a span instead.
      const GRAYS = ['black', 'white', 'brightBlack', 'brightWhite'];
      for (const [name, color] of Object.entries(ansi)) {
        if (GRAYS.includes(name)) continue;
        expect(contrast(color, p.bgSunken), `${t.id}.${name}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(ansi.brightWhite, ansi.black), `${t.id} ramp`).toBeGreaterThanOrEqual(7);
      // brightBlack is the one gray programs use as text (dimmed output, comments).
      expect(contrast(ansi.brightBlack, p.bgSunken), `${t.id}.brightBlack`).toBeGreaterThanOrEqual(3);
    }
  });

  it('makes every bright variant stand out further from the ground than its base', () => {
    for (const t of CUSTOM) {
      const p = t.palette as ThemePalette;
      const dark = t.base === 'dark';
      const ansi = ansiFromTokens(dark, tokensFor(p));
      for (const hue of ['Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan'] as const) {
        const base = ansi[hue.toLowerCase() as 'red'];
        const bright = ansi[`bright${hue}` as 'brightRed'];
        expect(contrast(bright, p.bgSunken), `${t.id} bright${hue}`).toBeGreaterThan(contrast(base, p.bgSunken));
        // Lighter on a dark ground, deeper on a light one.
        expect(luminance(bright) > luminance(base), `${t.id} bright${hue} direction`).toBe(dark);
      }
    }
  });

  it('gives no two themes the same terminal palette', () => {
    const seen = CUSTOM.map((t) => JSON.stringify(ansiFromTokens(t.base === 'dark', tokensFor(t.palette as ThemePalette))));
    expect(new Set(seen).size).toBe(CUSTOM.length);
  });

  it('swaps black and white between the light and dark branches', () => {
    const p = findTheme('blueprint')?.palette as ThemePalette;
    const light = ansiFromTokens(false, tokensFor(p));
    const dark = ansiFromTokens(true, tokensFor(p));
    expect(light.black).toBe(p.fg);
    expect(dark.black).toBe(p.bgElev);
    expect(light.brightWhite).toBe('#ffffff');
    expect(dark.brightWhite).not.toBe('#ffffff');
  });
});

describe('color helpers', () => {
  it('parses both hex shapes and rejects everything else', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('  #4D9DFF ')).toEqual([77, 157, 255]);
    for (const junk of ['', '#ff', '#12345', 'rgb(1,2,3)', 'var(--accent)', 'transparent']) {
      expect(parseHex(junk), junk).toBeNull();
    }
  });

  it('mixes toward a target and passes unparseable input through', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('rgba(0, 0, 0, 0.5)', '#ffffff', 0.5)).toBe('rgba(0, 0, 0, 0.5)');
  });

  it('appends alpha only to full hex colors', () => {
    expect(withAlpha('#4d9dff', 0.35)).toBe('#4d9dff59');
    expect(withAlpha('#4d9dff', 1)).toBe('#4d9dffff');
    expect(withAlpha('rgba(0, 0, 0, 0.5)', 0.35)).toBe('rgba(0, 0, 0, 0.5)');
  });
});

describe('chart series tokens', () => {
  it('gives every data-driven theme the slots of its light/dark base, and the built-ins declare them in styles.css', async () => {
    const { CHART_SERIES } = await import('../src/shared/themes');
    expect(CHART_SERIES.light).toHaveLength(6);
    expect(new Set(CHART_SERIES.light).size).toBe(6);
    expect(CHART_SERIES.dark).toHaveLength(6);
    const css = themeCss();
    for (const t of THEMES) {
      if (!t.palette) continue;
      const start = css.indexOf(`[data-theme='${t.id}']`);
      expect(start).toBeGreaterThan(-1);
      const block = css.slice(start, css.indexOf('}', start));
      const base = t.base === 'light' ? 'light' : 'dark';
      CHART_SERIES[base].forEach((hex, i) => expect(block).toContain(`--chart-${i + 1}: ${hex};`));
    }
    const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'styles.css'), 'utf8');
    CHART_SERIES.light.forEach((hex, i) => expect(styles).toContain(`--chart-${i + 1}: ${hex};`));
    CHART_SERIES.dark.forEach((hex, i) => expect(styles).toContain(`--chart-${i + 1}: ${hex};`));
  });
});
