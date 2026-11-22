/**
 * Guards the color themes: a System / Light / Dark mode and twenty palettes that each ship a light
 * and a dark variant. Every variant is complete, comfortable to read for hours (legible without
 * glaring), visually distinct from its siblings in the same scheme, and reachable through
 * settings — including from a legacy single-variant theme id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHART_SERIES,
  DEFAULT_PALETTE,
  GROUP_ORDER,
  LEGACY_THEMES,
  PALETTES,
  PALETTE_IDS,
  THEME_MODES,
  chromeFor,
  findPalette,
  isPaletteId,
  isThemeMode,
  migrateTheme,
  resolveScheme,
  swatchFor,
  themeCss,
  themeSourceFor,
  variantFor,
  type ColorScheme,
  type ThemePalette
} from '../src/shared/themes';
import { ansiFromTokens, mix, parseHex, withAlpha, type AnsiTokens } from '../src/shared/ansi';
import { defaultSettings, normalizeSettings } from '../src/main/settings';

/** The tokens every variant must set; the CSS relies on all of them being present. */
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
const STATUS = ['green', 'amber', 'red', 'blue', 'purple', 'cyan'] as const;
const SCHEMES: ColorScheme[] = ['light', 'dark'];

/** Every palette variant, labelled `id/scheme`. */
const VARIANTS = PALETTES.flatMap((p) => SCHEMES.map((scheme) => ({ id: `${p.id}/${scheme}`, scheme, v: p[scheme] })));

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

/** OKLab: a perceptual space, so distances below mean roughly the same thing at every hue. */
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

function chroma(hex: string): number {
  const [, a, b] = oklab(hex);
  return Math.hypot(a, b);
}

function deltaE(x: string, y: string): number {
  const [a, b] = [oklab(x), oklab(y)];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('theme catalogue', () => {
  it('offers System, Light and Dark as modes, apart from the palettes', () => {
    expect(THEME_MODES.map((m) => m.id)).toEqual(['system', 'light', 'dark']);
    expect(THEME_MODES.map((m) => m.name)).toEqual(['System', 'Light', 'Dark']);
  });

  it('has twenty palettes with unique ids and names, Default first', () => {
    expect(PALETTES).toHaveLength(20);
    expect(PALETTES[0].id).toBe(DEFAULT_PALETTE);
    expect(new Set(PALETTE_IDS).size).toBe(PALETTES.length);
    expect(new Set(PALETTES.map((p) => p.name)).size).toBe(PALETTES.length);
    // A palette must not be named like a mode, or the picker would offer two "Dark" buttons.
    for (const p of PALETTES) expect(THEME_MODES.map((m) => m.name)).not.toContain(p.name);
  });

  it('groups the palettes evenly, four per family', () => {
    for (const p of PALETTES) expect(GROUP_ORDER).toContain(p.group);
    for (const g of GROUP_ORDER) expect(PALETTES.filter((p) => p.group === g), g).toHaveLength(4);
  });

  it('has exactly one animated palette, Nebula', () => {
    expect(PALETTES.filter((p) => p.animated).map((p) => p.id)).toEqual(['nebula']);
  });

  it('defines every token in both variants, with opaque colors as plain hex', () => {
    for (const { id, v } of VARIANTS) {
      expect(Object.keys(v).sort(), id).toEqual([...TOKENS].sort());
      for (const token of HEX_TOKENS) expect(v[token], `${id}.${token}`).toMatch(/^#[0-9a-f]{6}$/);
      for (const token of ['bgHover', 'bgActive'] as const) expect(v[token], `${id}.${token}`).toMatch(/^rgba\(/);
      expect(v.shadow, `${id}.shadow`).toMatch(/^0 \d+px \d+px rgba\(/);
    }
  });
});

describe('palette readability', () => {
  it('keeps body text clearly readable without glaring', () => {
    for (const { id, v } of VARIANTS) {
      // Comfortably past AAA, but short of pure white on black (21:1), which halates in long sessions.
      expect(contrast(v.fg, v.bg), `${id} fg/bg`).toBeGreaterThanOrEqual(11);
      expect(contrast(v.fg, v.bg), `${id} fg/bg`).toBeLessThanOrEqual(16);
      expect(contrast(v.fg, v.bgElev), `${id} fg/bg-elev`).toBeGreaterThanOrEqual(7);
      expect(contrast(v.fg, v.userBubble), `${id} fg/user-bubble`).toBeGreaterThanOrEqual(7);
    }
  });

  it('keeps secondary text, accents and status hues at AA', () => {
    for (const { id, v } of VARIANTS) {
      expect(contrast(v.fgMuted, v.bg), `${id} fg-muted/bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v.fgFaint, v.bg), `${id} fg-faint/bg`).toBeGreaterThanOrEqual(3);
      // The accent is used as link and label text, and carries its own label on buttons.
      expect(contrast(v.accent, v.bg), `${id} accent/bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v.accentFg, v.accent), `${id} accent-fg/accent`).toBeGreaterThanOrEqual(4.5);
      // Status hues are read as text (badges, diff stats), so they must read as text.
      for (const hue of STATUS) expect(contrast(v[hue], v.bg), `${id} ${hue}/bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v.borderStrong, v.bg), `${id} border-strong/bg`).toBeGreaterThanOrEqual(1.2);
    }
  });

  it('keeps surfaces calm: tinted, never saturated, never pure white or black', () => {
    for (const { id, scheme, v } of VARIANTS) {
      if (scheme === 'light') {
        expect(v.bg, id).not.toBe('#ffffff');
        expect(luminance(v.bg), `${id} bg luminance`).toBeLessThanOrEqual(0.95);
      } else {
        expect(v.bg, id).not.toBe('#000000');
        expect(luminance(v.bg), `${id} bg luminance`).toBeGreaterThanOrEqual(0.005);
      }
      for (const surface of ['bg', 'bgElev', 'bgSunken'] as const) {
        expect(chroma(v[surface]), `${id}.${surface} chroma`).toBeLessThanOrEqual(scheme === 'light' ? 0.03 : 0.05);
      }
      // Accents are colorful but not neon.
      expect(chroma(v.accent), `${id} accent chroma`).toBeLessThanOrEqual(0.2);
    }
  });

  it('keeps each variant on its declared side, with surfaces stacked the same way', () => {
    for (const { id, scheme, v } of VARIANTS) {
      expect(luminance(v.bg) < 0.18, `${id} is ${scheme}`).toBe(scheme === 'dark');
      expect(luminance(v.bgSunken), `${id} sunken <= bg`).toBeLessThanOrEqual(luminance(v.bg));
      expect(luminance(v.bg), `${id} bg <= elev`).toBeLessThanOrEqual(luminance(v.bgElev));
    }
  });

  it('makes every pair of palettes distinguishable within a scheme', () => {
    for (const scheme of SCHEMES) {
      for (let i = 0; i < PALETTES.length; i++) {
        for (let j = i + 1; j < PALETTES.length; j++) {
          const [a, b] = [PALETTES[i][scheme], PALETTES[j][scheme]];
          const label = `${scheme}: ${PALETTES[i].id} vs ${PALETTES[j].id}`;
          // Surfaces are deliberately quiet, so the accent carries most of a palette's identity; a
          // shift of the ground counts double because it fills the window.
          expect(deltaE(a.accent, b.accent) + 2 * deltaE(a.bg, b.bg), label).toBeGreaterThanOrEqual(0.07);
        }
      }
    }
  });

  it('gives every palette a light variant that is not just its dark one', () => {
    for (const p of PALETTES) expect(p.light.bg, p.id).not.toBe(p.dark.bg);
  });
});

describe('theme lookups', () => {
  it('accepts known modes and palette ids and rejects anything else', () => {
    for (const m of THEME_MODES) expect(isThemeMode(m.id)).toBe(true);
    for (const id of PALETTE_IDS) expect(isPaletteId(id)).toBe(true);
    for (const junk of ['', 'Dark', 'midnight-navy', 'nebula ', null, 7, undefined]) {
      expect(isThemeMode(junk)).toBe(false);
      expect(isPaletteId(junk)).toBe(false);
    }
    expect(findPalette('nope')).toBeUndefined();
  });

  it('resolves a mode to a scheme, deferring to the OS only for system', () => {
    expect(resolveScheme('system', true)).toBe('dark');
    expect(resolveScheme('system', false)).toBe('light');
    expect(resolveScheme('dark', false)).toBe('dark');
    expect(resolveScheme('light', true)).toBe('light');
  });

  it('hands nativeTheme the mode itself', () => {
    expect(themeSourceFor('system')).toBe('system');
    expect(themeSourceFor('light')).toBe('light');
    expect(themeSourceFor('dark')).toBe('dark');
    // Unknown values must not crash the main process; they defer to the OS.
    expect(themeSourceFor('nope')).toBe('system');
  });

  it('derives caption colors from the palette variant the window paints', () => {
    const midnight = findPalette('midnight')!;
    expect(chromeFor('midnight', 'dark')).toEqual({ color: midnight.dark.bgElev, symbolColor: midnight.dark.fg });
    expect(chromeFor('midnight', 'light')).toEqual({ color: midnight.light.bgElev, symbolColor: midnight.light.fg });
    // Two palettes in one scheme must not share a caption, or switching would leave the old one.
    expect(chromeFor('midnight', 'dark')).not.toEqual(chromeFor('ember', 'dark'));
    // An unknown palette paints as Default rather than crashing the window.
    expect(chromeFor('nope', 'dark')).toEqual(chromeFor('default', 'dark'));
    expect(variantFor('nope', 'light')).toBe(findPalette('default')!.light);
  });

  it('builds a three-color swatch for every palette in each scheme', () => {
    for (const id of PALETTE_IDS) {
      for (const scheme of SCHEMES) {
        const swatch = swatchFor(id, scheme);
        expect(swatch, id).toHaveLength(3);
        for (const c of swatch) expect(c, id).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(swatchFor(id, 'light'), id).not.toEqual(swatchFor(id, 'dark'));
    }
  });
});

describe('legacy theme migration', () => {
  it('keeps a mode and its palette as they are', () => {
    expect(migrateTheme('dark', 'fjord')).toEqual({ theme: 'dark', palette: 'fjord' });
    expect(migrateTheme('system', undefined)).toEqual({ theme: 'system', palette: 'default' });
    expect(migrateTheme('light', 'bogus')).toEqual({ theme: 'light', palette: 'default' });
  });

  it('splits every legacy theme id into the palette it became and the mode it painted', () => {
    expect(migrateTheme('blueprint', undefined)).toEqual({ theme: 'light', palette: 'midnight' });
    expect(migrateTheme('lavender', undefined)).toEqual({ theme: 'light', palette: 'ultraviolet' });
    expect(migrateTheme('porcelain', undefined)).toEqual({ theme: 'light', palette: 'slate' });
    expect(migrateTheme('magma', undefined)).toEqual({ theme: 'dark', palette: 'ember' });
    expect(Object.keys(LEGACY_THEMES)).toHaveLength(20);
    for (const [legacy, to] of Object.entries(LEGACY_THEMES)) {
      expect(isPaletteId(to.palette), legacy).toBe(true);
      expect(['light', 'dark'], legacy).toContain(to.theme);
      expect(migrateTheme(legacy, undefined), legacy).toEqual(to);
    }
  });

  it('falls back to System + Default for anything unknown', () => {
    for (const junk of ['solarized', '', 'DARK', 'toString', '__proto__', 7, null]) {
      expect(migrateTheme(junk, undefined), String(junk)).toEqual({ theme: 'system', palette: 'default' });
    }
    // A valid palette survives a junk mode.
    expect(migrateTheme('bogus', 'dusk')).toEqual({ theme: 'system', palette: 'dusk' });
  });
});

describe('themeCss', () => {
  const css = themeCss();

  it('emits one block per palette variant, keyed on palette and resolved scheme', () => {
    for (const p of PALETTES) {
      for (const scheme of SCHEMES) expect(css).toContain(`html:root[data-palette='${p.id}'][data-scheme='${scheme}'] {`);
    }
    expect(css.match(/html:root\[/g)).toHaveLength(PALETTES.length * 2);
    // The CSS keys on the resolved scheme; the mode attribute alone never paints anything.
    expect(css).not.toContain('data-theme');
  });

  it('writes every token as a kebab-case custom property with a color-scheme', () => {
    const midnight = findPalette('midnight')!;
    const block = css.split(`html:root[data-palette='midnight'][data-scheme='dark'] {`)[1].split('}')[0];
    expect(block).toContain('color-scheme: dark;');
    expect(block).toContain(`--bg-elev: ${midnight.dark.bgElev};`);
    expect(block).toContain(`--border-strong: ${midnight.dark.borderStrong};`);
    expect(block).toContain(`--user-bubble: ${midnight.dark.userBubble};`);
    expect(block).not.toMatch(/--[a-z]*[A-Z]/);
    expect(css.split(`html:root[data-palette='midnight'][data-scheme='light'] {`)[1].split('}')[0]).toContain('color-scheme: light;');
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
    // Palettes declare base hues only; the -soft washes are computed once in :root.
    for (const soft of ['--accent-soft', '--red-soft', '--purple-soft']) {
      expect(css).not.toContain(soft);
      expect(styles).toContain(`${soft}: color-mix(`);
    }
  });

  it('keeps the pre-script fallback in styles.css identical to the Default palette', () => {
    const styles = fs.readFileSync(path.join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8');
    const rootBlock = styles.slice(styles.indexOf(':root {'), styles.indexOf('}', styles.indexOf(':root {')));
    const darkStart = styles.indexOf(':root:not([data-scheme]) {');
    expect(darkStart, 'dark fallback block').toBeGreaterThan(-1);
    const darkBlock = styles.slice(darkStart, styles.indexOf('}', darkStart));
    const def = findPalette('default')!;
    const kebab = (k: string): string => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    for (const token of TOKENS) {
      expect(rootBlock, `light ${token}`).toContain(`${kebab(token)}: ${def.light[token]};`);
      expect(darkBlock, `dark ${token}`).toContain(`${kebab(token)}: ${def.dark[token]};`);
    }
  });
});

describe('theme settings', () => {
  it('defaults to System + Default', () => {
    expect(defaultSettings().theme).toBe('system');
    expect(defaultSettings().palette).toBe('default');
    expect(normalizeSettings({})).toMatchObject({ theme: 'system', palette: 'default' });
  });

  it('round-trips every mode with every palette', () => {
    for (const m of THEME_MODES) {
      for (const id of PALETTE_IDS) expect(normalizeSettings({ theme: m.id, palette: id })).toMatchObject({ theme: m.id, palette: id });
    }
  });

  it('keeps the palette when only the mode changes, and the mode when only the palette changes', () => {
    const start = normalizeSettings({ theme: 'dark', palette: 'evergreen' });
    expect(normalizeSettings({ ...start, theme: 'light' })).toMatchObject({ theme: 'light', palette: 'evergreen' });
    expect(normalizeSettings({ ...start, palette: 'claret' })).toMatchObject({ theme: 'dark', palette: 'claret' });
  });

  it('upgrades a settings.json written with a legacy theme id', () => {
    expect(normalizeSettings({ theme: 'blueprint' as never })).toMatchObject({ theme: 'light', palette: 'midnight' });
    expect(normalizeSettings({ theme: 'ember' as never })).toMatchObject({ theme: 'dark', palette: 'ember' });
  });

  it('falls back for values that are not in the catalogue', () => {
    for (const junk of ['solarized', '', 'DARK']) {
      expect(normalizeSettings({ theme: junk as never }).theme).toBe('system');
    }
    expect(normalizeSettings({ theme: 'dark', palette: 'neon' as never })).toMatchObject({ theme: 'dark', palette: 'default' });
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

  it('gives every variant sixteen distinct, readable slots', () => {
    for (const { id, scheme, v } of VARIANTS) {
      const ansi = ansiFromTokens(scheme === 'dark', tokensFor(v));
      const slots = Object.values(ansi);
      expect(slots, id).toHaveLength(16);
      for (const c of slots) expect(c, id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(new Set(slots.map((c) => c.toLowerCase())).size, `${id} has duplicate slots`).toBe(16);
      // The terminal paints on --bg-sunken, so every hue has to stay readable there. The four
      // achromatic slots are the ground-to-ink ramp itself — in a light theme white is a background
      // color, not text — so they are checked as a span instead.
      const GRAYS = ['black', 'white', 'brightBlack', 'brightWhite'];
      for (const [name, color] of Object.entries(ansi)) {
        if (GRAYS.includes(name)) continue;
        expect(contrast(color, v.bgSunken), `${id}.${name}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(ansi.brightWhite, ansi.black), `${id} ramp`).toBeGreaterThanOrEqual(7);
      // brightBlack is the one gray programs use as text (dimmed output, comments).
      expect(contrast(ansi.brightBlack, v.bgSunken), `${id}.brightBlack`).toBeGreaterThanOrEqual(3);
    }
  });

  it('makes every bright variant stand out further from the ground than its base', () => {
    for (const { id, scheme, v } of VARIANTS) {
      const dark = scheme === 'dark';
      const ansi = ansiFromTokens(dark, tokensFor(v));
      for (const hue of ['Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan'] as const) {
        const base = ansi[hue.toLowerCase() as 'red'];
        const bright = ansi[`bright${hue}` as 'brightRed'];
        expect(contrast(bright, v.bgSunken), `${id} bright${hue}`).toBeGreaterThan(contrast(base, v.bgSunken));
        // Lighter on a dark ground, deeper on a light one.
        expect(luminance(bright) > luminance(base), `${id} bright${hue} direction`).toBe(dark);
      }
    }
  });

  it('gives no two variants the same terminal palette', () => {
    const seen = VARIANTS.map(({ scheme, v }) => JSON.stringify(ansiFromTokens(scheme === 'dark', tokensFor(v))));
    expect(new Set(seen).size).toBe(VARIANTS.length);
  });

  it('swaps black and white between the light and dark branches', () => {
    const p = findPalette('midnight')!.light;
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
  it('gives every palette variant the slots of its scheme, and the fallback declares them in styles.css', () => {
    expect(CHART_SERIES.light).toHaveLength(6);
    expect(new Set(CHART_SERIES.light).size).toBe(6);
    expect(CHART_SERIES.dark).toHaveLength(6);
    const css = themeCss();
    for (const p of PALETTES) {
      for (const scheme of SCHEMES) {
        const start = css.indexOf(`[data-palette='${p.id}'][data-scheme='${scheme}']`);
        expect(start).toBeGreaterThan(-1);
        const block = css.slice(start, css.indexOf('}', start));
        CHART_SERIES[scheme].forEach((hex, i) => expect(block).toContain(`--chart-${i + 1}: ${hex};`));
      }
    }
    const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'styles.css'), 'utf8');
    CHART_SERIES.light.forEach((hex, i) => expect(styles).toContain(`--chart-${i + 1}: ${hex};`));
    CHART_SERIES.dark.forEach((hex, i) => expect(styles).toContain(`--chart-${i + 1}: ${hex};`));
  });
});
