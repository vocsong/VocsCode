/**
 * Text & fonts (Settings → Appearance): interface size, the three font roles, transcript and code
 * text sizes, line spacing and transcript width.
 *
 * Three roles, because a coding-agent app reads three kinds of text:
 *
 * - **Interface**: chrome, lists, labels. Drives `--font`.
 * - **Transcript**: what agents and you write. Drives `--content-font`, `--content-size` and
 *   `--content-leading`; it defaults to the interface font.
 * - **Code**: code blocks, diffs, paths and the terminal. Drives `--mono` and `--code-size`.
 *
 * Interface size is the window's zoom factor, applied by the main process, because the chrome's
 * type is authored in fixed pixels and only a zoom scales it without breaking the layout.
 * Everything else is CSS custom properties set by `src/renderer/src/theme.ts`.
 *
 * Fonts are referenced, never bundled. A preset is a named family followed by a fallback stack,
 * so a font that is not installed degrades to the default instead of to Times.
 */

export type TranscriptWidth = 'narrow' | 'normal' | 'wide';
export type LineSpacing = 'compact' | 'normal' | 'relaxed';
export type FontRole = 'ui' | 'content' | 'code';

export interface TypographySettings {
  /** Preset id from {@link FONT_PRESETS}.ui, or `custom`. */
  uiFont: string;
  uiFontCustom: string;
  /** Preset id from {@link FONT_PRESETS}.content (`ui` follows the interface font), or `custom`. */
  contentFont: string;
  contentFontCustom: string;
  /** Preset id from {@link FONT_PRESETS}.code, or `custom`. */
  codeFont: string;
  codeFontCustom: string;
  /** Window zoom factor. */
  uiScale: number;
  /** Transcript text size in CSS pixels. */
  contentSize: number;
  /** Code block and diff text size in CSS pixels. */
  codeSize: number;
  lineSpacing: LineSpacing;
  width: TranscriptWidth;
}

export interface FontPreset {
  id: string;
  name: string;
  /** The CSS font-family value. */
  stack: string;
  /** The family whose presence decides whether the preset is offered as installed. */
  probe?: string;
  /** A few words on why someone would pick it. */
  note?: string;
}

export const SYSTEM_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable', 'Segoe UI', Inter, Roboto, system-ui, sans-serif";
export const DEFAULT_MONO = "'Cascadia Code', 'JetBrains Mono', Consolas, 'SF Mono', Menlo, monospace";
const SERIF = "Charter, 'Bitstream Charter', 'Iowan Old Style', 'Source Serif 4', 'Source Serif Pro', Georgia, Cambria, serif";

const sans = (id: string, family: string, note?: string): FontPreset => ({ id, name: family, stack: `'${family}', ${SYSTEM_SANS}`, probe: family, note });
const mono = (id: string, family: string, note?: string): FontPreset => ({ id, name: family, stack: `'${family}', ${DEFAULT_MONO}`, probe: family, note });

const SANS_FAMILIES: FontPreset[] = [
  sans('inter', 'Inter', 'Neutral, built for screens'),
  sans('segoe', 'Segoe UI', 'Windows'),
  sans('roboto', 'Roboto'),
  sans('noto-sans', 'Noto Sans', 'Wide language coverage'),
  sans('ibm-plex-sans', 'IBM Plex Sans'),
  sans('open-sans', 'Open Sans'),
  { id: 'helvetica', name: 'Helvetica / Arial', stack: `'Helvetica Neue', Helvetica, Arial, ${SYSTEM_SANS}`, probe: 'Arial' },
  sans('verdana', 'Verdana', 'Wide letterforms, very legible small'),
  sans('atkinson', 'Atkinson Hyperlegible', 'Designed for low vision')
];

export const FONT_PRESETS: Record<FontRole, FontPreset[]> = {
  ui: [{ id: 'system', name: 'System default', stack: SYSTEM_SANS }, ...SANS_FAMILIES],
  content: [
    { id: 'ui', name: 'Same as interface', stack: 'var(--font)' },
    { id: 'system', name: 'System default', stack: SYSTEM_SANS },
    { id: 'serif', name: 'Reading serif', stack: SERIF, note: 'Charter or Georgia, for long answers' },
    ...SANS_FAMILIES
  ],
  code: [
    { id: 'default', name: 'Default monospace', stack: DEFAULT_MONO },
    mono('cascadia-code', 'Cascadia Code', 'Ligatures'),
    mono('cascadia-mono', 'Cascadia Mono', 'No ligatures'),
    mono('jetbrains-mono', 'JetBrains Mono'),
    mono('fira-code', 'Fira Code', 'Ligatures'),
    mono('source-code-pro', 'Source Code Pro'),
    mono('ibm-plex-mono', 'IBM Plex Mono'),
    mono('consolas', 'Consolas'),
    { id: 'sf-mono', name: 'SF Mono / Menlo', stack: `'SF Mono', Menlo, ${DEFAULT_MONO}`, probe: 'Menlo' },
    mono('courier', 'Courier New')
  ]
};

/** The option that reveals a free-text family name. */
export const CUSTOM_FONT = 'custom';

export const UI_SCALES = [0.9, 1, 1.1, 1.25];
export const UI_SCALE_RANGE = { min: 0.75, max: 1.5 };
export const CONTENT_SIZES = [12, 13, 14, 15, 16, 17, 18, 20];
export const CODE_SIZES = [11, 12, 12.5, 13, 14, 15, 16];

export const LINE_SPACINGS: { id: LineSpacing; name: string; leading: number }[] = [
  { id: 'compact', name: 'Compact', leading: 1.5 },
  { id: 'normal', name: 'Normal', leading: 1.65 },
  { id: 'relaxed', name: 'Relaxed', leading: 1.8 }
];

/**
 * Transcript widths. `conversation` caps the column the transcript and composer share; `reading`
 * caps the line length of prose inside it (Zen draws one narrower column of its own).
 */
export const TRANSCRIPT_WIDTHS: { id: TranscriptWidth; name: string; description: string; conversation: number; reading: number; zenReading: number }[] = [
  { id: 'narrow', name: 'Narrow', description: 'Short lines, focused reading', conversation: 820, reading: 640, zenReading: 600 },
  { id: 'normal', name: 'Normal', description: 'Balanced for prose and code', conversation: 1120, reading: 780, zenReading: 700 },
  { id: 'wide', name: 'Wide', description: 'More code and tables per line', conversation: 1480, reading: 980, zenReading: 860 }
];

export const DEFAULT_TYPOGRAPHY: TypographySettings = {
  uiFont: 'system',
  uiFontCustom: '',
  contentFont: 'ui',
  contentFontCustom: '',
  codeFont: 'default',
  codeFontCustom: '',
  uiScale: 1,
  contentSize: 14,
  codeSize: 12.5,
  lineSpacing: 'normal',
  width: 'normal'
};

const FALLBACK: Record<FontRole, string> = { ui: SYSTEM_SANS, content: 'var(--font)', code: DEFAULT_MONO };

/**
 * Turns a typed family list ("JetBrains Mono, Fira Code") into quoted CSS family names. Only
 * letters, digits, spaces and `-_.` survive, so a value can name fonts but never close the
 * declaration or reach for `url()`. Returns '' when nothing usable is left.
 */
export function sanitizeFontFamily(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .split(',')
    .map((name) => name.replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/\s+/g, ' ').trim())
    .filter((name) => name.length > 0 && name.length <= 64)
    .slice(0, 4)
    .map((name) => `'${name}'`)
    .join(', ');
}

export function findFontPreset(role: FontRole, id: string): FontPreset | undefined {
  return FONT_PRESETS[role].find((p) => p.id === id);
}

/** The CSS font-family a role resolves to: a preset's stack, or a custom family over the default. */
export function fontStack(role: FontRole, id: string, custom = ''): string {
  if (id === CUSTOM_FONT) {
    const families = sanitizeFontFamily(custom);
    return families ? `${families}, ${FALLBACK[role]}` : FALLBACK[role];
  }
  return findFontPreset(role, id)?.stack ?? FALLBACK[role];
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, min, max) : fallback;
const fontId = (role: FontRole, v: unknown, fallback: string): string =>
  typeof v === 'string' && (v === CUSTOM_FONT || findFontPreset(role, v)) ? v : fallback;
const customText = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 200) : '');

/** Reads stored typography, filling gaps and pulling anything out of range back to a safe value. */
export function normalizeTypography(stored: unknown): TypographySettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<Record<keyof TypographySettings, unknown>>;
  const d = DEFAULT_TYPOGRAPHY;
  return {
    uiFont: fontId('ui', s.uiFont, d.uiFont),
    uiFontCustom: customText(s.uiFontCustom),
    contentFont: fontId('content', s.contentFont, d.contentFont),
    contentFontCustom: customText(s.contentFontCustom),
    codeFont: fontId('code', s.codeFont, d.codeFont),
    codeFontCustom: customText(s.codeFontCustom),
    uiScale: num(s.uiScale, d.uiScale, UI_SCALE_RANGE.min, UI_SCALE_RANGE.max),
    contentSize: num(s.contentSize, d.contentSize, 11, 24),
    codeSize: num(s.codeSize, d.codeSize, 10, 20),
    lineSpacing: LINE_SPACINGS.some((l) => l.id === s.lineSpacing) ? (s.lineSpacing as LineSpacing) : d.lineSpacing,
    width: TRANSCRIPT_WIDTHS.some((w) => w.id === s.width) ? (s.width as TranscriptWidth) : d.width
  };
}

export function isDefaultTypography(t: TypographySettings): boolean {
  return (Object.keys(DEFAULT_TYPOGRAPHY) as (keyof TypographySettings)[]).every((k) => {
    // A custom name typed and then abandoned for a preset does not count as a change.
    if (k.endsWith('Custom')) return true;
    return t[k] === DEFAULT_TYPOGRAPHY[k];
  });
}

/** The custom properties the renderer puts on `<html>`; transcript width travels as `data-width`. */
export function typographyVars(t: TypographySettings): Record<string, string> {
  const leading = LINE_SPACINGS.find((l) => l.id === t.lineSpacing)?.leading ?? 1.65;
  return {
    '--font': fontStack('ui', t.uiFont, t.uiFontCustom),
    '--content-font': fontStack('content', t.contentFont, t.contentFontCustom),
    '--mono': fontStack('code', t.codeFont, t.codeFontCustom),
    '--content-size': `${t.contentSize}px`,
    '--content-leading': String(leading),
    '--code-size': `${t.codeSize}px`
  };
}
