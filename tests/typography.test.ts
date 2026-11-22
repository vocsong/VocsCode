/**
 * Guards Text & fonts: stored values are normalized into a safe range, typed font names can only
 * ever name fonts, every preset resolves to a stack with a fallback, and the CSS the renderer and
 * stylesheets agree on stays in sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODE_SIZES,
  CONTENT_SIZES,
  CUSTOM_FONT,
  DEFAULT_MONO,
  DEFAULT_TYPOGRAPHY,
  FONT_PRESETS,
  LINE_SPACINGS,
  SYSTEM_SANS,
  TRANSCRIPT_WIDTHS,
  UI_SCALES,
  UI_SCALE_RANGE,
  fontStack,
  isDefaultTypography,
  normalizeTypography,
  sanitizeFontFamily,
  typographyVars,
  type FontRole
} from '../src/shared/typography';
import { defaultSettings, normalizeSettings } from '../src/main/settings';

const read = (f: string): string => fs.readFileSync(path.join(process.cwd(), f), 'utf8');

describe('typography defaults', () => {
  it('reproduces the app as it looked before the setting existed', () => {
    const vars = typographyVars(DEFAULT_TYPOGRAPHY);
    expect(vars['--font']).toBe(SYSTEM_SANS);
    expect(vars['--mono']).toBe(DEFAULT_MONO);
    // The transcript follows the interface font unless told otherwise.
    expect(vars['--content-font']).toBe('var(--font)');
    expect(vars['--content-size']).toBe('14px');
    expect(vars['--content-leading']).toBe('1.65');
    expect(vars['--code-size']).toBe('12.5px');
    expect(DEFAULT_TYPOGRAPHY.uiScale).toBe(1);
    expect(DEFAULT_TYPOGRAPHY.width).toBe('normal');
  });

  it('keeps the stylesheet fallbacks equal to the defaults, so nothing shifts before settings load', () => {
    const styles = read('src/renderer/src/styles.css');
    const root = styles.slice(styles.indexOf(':root {'), styles.indexOf('}', styles.indexOf(':root {')));
    expect(root).toContain(`--font: ${SYSTEM_SANS};`);
    expect(root).toContain(`--mono: ${DEFAULT_MONO};`);
    expect(root).toContain('--content-font: var(--font);');
    expect(root).toContain('--content-size: 14px;');
    expect(root).toContain('--content-leading: 1.65;');
    expect(root).toContain('--code-size: 12.5px;');
    const normal = TRANSCRIPT_WIDTHS.find((w) => w.id === 'normal')!;
    expect(root).toContain(`--reading: ${normal.reading}px;`);
    expect(styles).toContain(`--conversation-width: ${normal.conversation}px;`);
  });

  it('writes the narrow and wide widths into the stylesheets with the same numbers', () => {
    const styles = read('src/renderer/src/styles.css');
    const zen = read('src/renderer/src/ui-zen.css');
    for (const w of TRANSCRIPT_WIDTHS.filter((x) => x.id !== 'normal')) {
      const reading = styles.split(`:root[data-width='${w.id}'] {`)[1]?.split('}')[0] ?? '';
      expect(reading, w.id).toContain(`--reading: ${w.reading}px;`);
      const column = styles.split(`:root[data-width='${w.id}'] .pane {`)[1]?.split('}')[0] ?? '';
      expect(column, w.id).toContain(`--conversation-width: ${w.conversation}px;`);
      const zenBlock = zen.split(`:root[data-ui='zen'][data-width='${w.id}'][data-palette][data-scheme] {`)[1]?.split('}')[0] ?? '';
      expect(zenBlock, `zen ${w.id}`).toContain(`--reading: ${w.zenReading}px;`);
    }
    expect(zen).toContain(`--reading: ${TRANSCRIPT_WIDTHS.find((w) => w.id === 'normal')!.zenReading}px;`);
  });

  it('orders widths and spacings from tightest to loosest', () => {
    expect(TRANSCRIPT_WIDTHS.map((w) => w.id)).toEqual(['narrow', 'normal', 'wide']);
    const [narrow, normal, wide] = TRANSCRIPT_WIDTHS;
    expect(narrow.conversation < normal.conversation && normal.conversation < wide.conversation).toBe(true);
    expect(narrow.reading < normal.reading && normal.reading < wide.reading).toBe(true);
    // Prose never runs wider than the column that holds it.
    for (const w of TRANSCRIPT_WIDTHS) expect(w.reading, w.id).toBeLessThan(w.conversation);
    expect(LINE_SPACINGS.map((l) => l.leading)).toEqual([...LINE_SPACINGS.map((l) => l.leading)].sort());
  });

  it('offers the default in every size list, and only sizes the normalizer keeps', () => {
    expect(UI_SCALES).toContain(DEFAULT_TYPOGRAPHY.uiScale);
    expect(CONTENT_SIZES).toContain(DEFAULT_TYPOGRAPHY.contentSize);
    expect(CODE_SIZES).toContain(DEFAULT_TYPOGRAPHY.codeSize);
    for (const s of UI_SCALES) expect(normalizeTypography({ uiScale: s }).uiScale).toBe(s);
    for (const s of CONTENT_SIZES) expect(normalizeTypography({ contentSize: s }).contentSize).toBe(s);
    for (const s of CODE_SIZES) expect(normalizeTypography({ codeSize: s }).codeSize).toBe(s);
  });
});

describe('font presets', () => {
  it('gives every preset a unique id and a stack that ends in a generic family', () => {
    for (const role of ['ui', 'content', 'code'] as FontRole[]) {
      const ids = FONT_PRESETS[role].map((p) => p.id);
      expect(new Set(ids).size, role).toBe(ids.length);
      expect(ids, role).not.toContain(CUSTOM_FONT);
      for (const p of FONT_PRESETS[role]) {
        if (p.stack === 'var(--font)') continue;
        expect(p.stack, `${role}/${p.id}`).toMatch(role === 'code' ? /monospace$/ : /(sans-serif|serif)$/);
        // A preset named after one family must lead with it, so picking it actually changes the font.
        if (p.probe && p.id !== 'helvetica' && p.id !== 'sf-mono') expect(p.stack.startsWith(`'${p.probe}'`), `${role}/${p.id}`).toBe(true);
      }
    }
  });

  it('starts each list with the default and lets the transcript follow the interface', () => {
    expect(FONT_PRESETS.ui[0].id).toBe(DEFAULT_TYPOGRAPHY.uiFont);
    expect(FONT_PRESETS.content[0].id).toBe(DEFAULT_TYPOGRAPHY.contentFont);
    expect(FONT_PRESETS.content[0].stack).toBe('var(--font)');
    expect(FONT_PRESETS.code[0].id).toBe(DEFAULT_TYPOGRAPHY.codeFont);
    expect(FONT_PRESETS.content.some((p) => p.id === 'serif')).toBe(true);
  });

  it('puts a custom family in front of the role default', () => {
    expect(fontStack('code', CUSTOM_FONT, 'Berkeley Mono')).toBe(`'Berkeley Mono', ${DEFAULT_MONO}`);
    expect(fontStack('ui', CUSTOM_FONT, 'Source Sans 3, Inter')).toBe(`'Source Sans 3', 'Inter', ${SYSTEM_SANS}`);
    expect(fontStack('content', CUSTOM_FONT, 'Literata')).toBe(`'Literata', var(--font)`);
    // An empty or unusable custom name is the default, not an empty font-family.
    expect(fontStack('code', CUSTOM_FONT, '')).toBe(DEFAULT_MONO);
    expect(fontStack('code', CUSTOM_FONT, ';;;')).toBe(DEFAULT_MONO);
    expect(fontStack('ui', 'no-such-preset')).toBe(SYSTEM_SANS);
  });
});

describe('custom font names', () => {
  it('can only ever name fonts', () => {
    for (const hostile of [
      "Inter'; background: url(https://evil.example/x)",
      'Inter; } body { display: none',
      'Inter") , url(x)',
      'var(--accent)',
      'Inter\\27 ; color: red',
      'expression(alert(1))'
    ]) {
      const out = sanitizeFontFamily(hostile);
      expect(out, hostile).not.toMatch(/[;{}()\\:"]/);
      // Every family is single-quoted with nothing quoted inside it.
      for (const part of out.split(', ').filter(Boolean)) expect(part, hostile).toMatch(/^'[^']+'$/);
    }
  });

  it('keeps real names, including spaces, digits, dots and accents', () => {
    expect(sanitizeFontFamily('JetBrains Mono')).toBe("'JetBrains Mono'");
    expect(sanitizeFontFamily('  Source  Serif 4 , Iosevka Term SS08 ')).toBe("'Source Serif 4', 'Iosevka Term SS08'");
    expect(sanitizeFontFamily('Noto Sans JP, Hiragino Kaku Gothic ProN')).toBe("'Noto Sans JP', 'Hiragino Kaku Gothic ProN'");
    expect(sanitizeFontFamily('Agave Nerd Font v1.2')).toBe("'Agave Nerd Font v1.2'");
    expect(sanitizeFontFamily('Fira Sans Condensed, Avenir Next, Roboto, Arial, Helvetica')).toBe("'Fira Sans Condensed', 'Avenir Next', 'Roboto', 'Arial'");
    expect(sanitizeFontFamily(42)).toBe('');
  });
});

describe('normalizeTypography', () => {
  it('fills a missing or broken value with the defaults', () => {
    for (const junk of [undefined, null, 7, 'big', []]) expect(normalizeTypography(junk), String(junk)).toEqual(DEFAULT_TYPOGRAPHY);
  });

  it('clamps sizes and scale into a range the layout survives', () => {
    expect(normalizeTypography({ uiScale: 9 }).uiScale).toBe(UI_SCALE_RANGE.max);
    expect(normalizeTypography({ uiScale: 0.1 }).uiScale).toBe(UI_SCALE_RANGE.min);
    expect(normalizeTypography({ uiScale: Number.NaN }).uiScale).toBe(1);
    expect(normalizeTypography({ contentSize: 3 }).contentSize).toBe(11);
    expect(normalizeTypography({ contentSize: 99 }).contentSize).toBe(24);
    expect(normalizeTypography({ codeSize: '13' as never }).codeSize).toBe(DEFAULT_TYPOGRAPHY.codeSize);
  });

  it('drops unknown fonts, spacings and widths, and keeps known ones', () => {
    const t = normalizeTypography({ uiFont: 'comic', contentFont: 'serif', codeFont: CUSTOM_FONT, codeFontCustom: 'Iosevka', lineSpacing: 'airy' as never, width: 'wide' });
    expect(t).toMatchObject({ uiFont: 'system', contentFont: 'serif', codeFont: CUSTOM_FONT, codeFontCustom: 'Iosevka', lineSpacing: 'normal', width: 'wide' });
  });

  it('treats a typed-then-abandoned custom name as no change', () => {
    expect(isDefaultTypography(DEFAULT_TYPOGRAPHY)).toBe(true);
    expect(isDefaultTypography({ ...DEFAULT_TYPOGRAPHY, codeFontCustom: 'Iosevka' })).toBe(true);
    expect(isDefaultTypography({ ...DEFAULT_TYPOGRAPHY, width: 'narrow' })).toBe(false);
    expect(isDefaultTypography({ ...DEFAULT_TYPOGRAPHY, uiScale: 1.1 })).toBe(false);
  });
});

describe('typography settings', () => {
  it('defaults new installs and older settings files to the default typography', () => {
    expect(defaultSettings().typography).toEqual(DEFAULT_TYPOGRAPHY);
    expect(normalizeSettings({ theme: 'dark' }).typography).toEqual(DEFAULT_TYPOGRAPHY);
  });

  it('round-trips a full choice and repairs a bad one', () => {
    const chosen = { ...DEFAULT_TYPOGRAPHY, uiScale: 1.1, uiFont: 'inter', contentFont: 'serif', codeFont: 'jetbrains-mono', contentSize: 16, codeSize: 13, lineSpacing: 'relaxed' as const, width: 'narrow' as const };
    expect(normalizeSettings({ typography: chosen }).typography).toEqual(chosen);
    expect(normalizeSettings({ typography: { ...chosen, contentSize: 400 } }).typography?.contentSize).toBe(24);
  });
});

describe('typography wiring', () => {
  it('drives the transcript, code and composer text from the variables', () => {
    const styles = read('src/renderer/src/styles.css');
    const block = (selector: string): string => styles.split(`\n${selector} {`)[1]?.split('}')[0] ?? '';
    expect(block('.md')).toContain('font-family: var(--content-font);');
    expect(block('.md')).toContain('font-size: var(--content-size);');
    expect(block('.md')).toContain('line-height: var(--content-leading);');
    expect(block('.codeblock pre')).toContain('font-size: var(--code-size);');
    expect(block('.diff-line.mono')).toContain('var(--code-size)');
    expect(block('.msg-user .msg-bubble')).toContain('font-size: var(--content-size);');
    expect(block('.composer-box textarea')).toContain('var(--content-size)');
    // Zen keeps its larger reading type as an offset, so the setting still moves it.
    const zen = read('src/renderer/src/ui-zen.css');
    expect(zen.split(":root[data-ui='zen'] .md {")[1].split('}')[0]).toContain('var(--content-size)');
  });

  it('lets the terminal follow the code font', () => {
    const host = read('src/renderer/src/terminal/host.ts');
    expect(host).toContain("attributeFilter: ['style']");
    expect(host).toContain("cssVar('--mono')");
  });
});
