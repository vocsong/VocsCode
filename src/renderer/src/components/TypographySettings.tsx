/**
 * Settings → Appearance → Text & fonts. Every control writes the whole typography object back, and
 * App.tsx / the main process apply it at once, so the sample below and the real window move together.
 */
import React, { useMemo } from 'react';
import {
  CODE_SIZES,
  CONTENT_SIZES,
  CUSTOM_FONT,
  DEFAULT_TYPOGRAPHY,
  FONT_PRESETS,
  LINE_SPACINGS,
  TRANSCRIPT_WIDTHS,
  UI_SCALES,
  fontStack,
  isDefaultTypography,
  normalizeTypography,
  type FontPreset,
  type FontRole,
  type TypographySettings as Typography
} from '../../../shared/typography';
import { Button, Field } from './ui';

const installed = new Map<string, boolean>();

/**
 * Whether a font family is installed: text set in it must measure differently from the same text in
 * each generic fallback. Canvas measurement is the one check that works for local system fonts.
 */
function isInstalled(family: string): boolean {
  const known = installed.get(family);
  if (known !== undefined) return known;
  // OffscreenCanvas keeps this off the DOM; where it is missing (jsdom), every preset stays offered.
  const ctx = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d');
  let found = true;
  if (ctx) {
    const sample = 'mmmmmmmmmmlli1WQ@#0O';
    found = ['monospace', 'serif', 'sans-serif'].some((generic) => {
      ctx.font = `72px ${generic}`;
      const base = ctx.measureText(sample).width;
      ctx.font = `72px '${family}', ${generic}`;
      return ctx.measureText(sample).width !== base;
    });
  }
  installed.set(family, found);
  return found;
}

function available(p: FontPreset): boolean {
  return !p.probe || isInstalled(p.probe);
}

/** A row of mutually exclusive buttons; the pressed one is the current value. */
function Segmented<T extends string | number>({ label, options, value, onChange }: { label: string; options: { value: T; label: React.ReactNode; title?: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" className={`segmented-option${o.value === value ? ' active' : ''}`} aria-pressed={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const SAMPLE = 'Aa Bb Gg 0O 1lI {} =>';

function FontPicker({ role, label, hint, value, custom, onChange }: { role: FontRole; label: string; hint?: string; value: string; custom: string; onChange: (id: string, custom?: string) => void }) {
  const presets = FONT_PRESETS[role];
  const offered = useMemo(() => presets.map((p) => ({ preset: p, ok: available(p) })), [presets]);
  return (
    <div className="type-font">
      <Field label={label} hint={hint}>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {offered.map(({ preset, ok }) => (
            // The current choice stays selectable even if this computer lacks it (settings copied over).
            <option key={preset.id} value={preset.id} disabled={!ok && preset.id !== value}>
              {preset.name}
              {!ok ? ' — not installed' : preset.note ? ` — ${preset.note}` : ''}
            </option>
          ))}
          <option value={CUSTOM_FONT}>Custom…</option>
        </select>
      </Field>
      {value === CUSTOM_FONT && (
        <input
          className="type-font-custom"
          aria-label={`${label}: custom family`}
          placeholder={role === 'code' ? 'e.g. Berkeley Mono, Iosevka' : 'e.g. Source Sans 3'}
          value={custom}
          spellCheck={false}
          onChange={(e) => onChange(CUSTOM_FONT, e.target.value)}
        />
      )}
      <span className="type-font-preview" style={{ fontFamily: fontStack(role, value, custom) }} aria-hidden="true">
        {SAMPLE}
      </span>
    </div>
  );
}

/** Narrow / Normal / Wide, each with a glyph of the column it gives the transcript. */
function WidthPicker({ value, onChange }: { value: Typography['width']; onChange: (w: Typography['width']) => void }) {
  return (
    <div className="type-width" role="group" aria-label="Transcript width">
      {TRANSCRIPT_WIDTHS.map((w, i) => (
        <button key={w.id} type="button" className={`type-width-option${value === w.id ? ' active' : ''}`} aria-pressed={value === w.id} onClick={() => onChange(w.id)}>
          <span className="type-width-glyph" aria-hidden="true">
            <i style={{ width: `${[46, 68, 92][i]}%` }} />
            <i style={{ width: `${[38, 58, 80][i]}%` }} />
            <i style={{ width: `${[42, 64, 86][i]}%` }} />
          </span>
          <strong>{w.name}</strong>
          <small>{w.description}</small>
        </button>
      ))}
    </div>
  );
}

/** A slice of a real transcript, styled by the same rules, so every choice shows up here first. */
function Sample() {
  return (
    <div className="type-sample" aria-hidden="true">
      <div className="msg-user">
        <div className="msg-bubble">Can you make the retry backoff exponential?</div>
      </div>
      <div className="md">
        <p>
          Done. <code>retryDelay()</code> now doubles the wait after each failed attempt and caps it at 30 seconds, so a flaky network no longer hammers the API.
        </p>
      </div>
      <div className="codeblock">
        <pre>
          <code>{'const delay = Math.min(base * 2 ** attempt, 30_000);\nawait sleep(delay + jitter());'}</code>
        </pre>
      </div>
    </div>
  );
}

export function TypographySettings({ value, onChange }: { value: Typography | undefined; onChange: (next: Typography) => void }) {
  const t = normalizeTypography(value);
  const set = (patch: Partial<Typography>): void => onChange({ ...t, ...patch });
  const scales = UI_SCALES.includes(t.uiScale) ? UI_SCALES : [...UI_SCALES, t.uiScale].sort((a, b) => a - b);
  const sizes = (list: number[], current: number): number[] => (list.includes(current) ? list : [...list, current].sort((a, b) => a - b));

  return (
    <div className="type-settings">
      <div className="type-row">
        <div className="type-row-label">
          <span className="field-label">Interface size</span>
          <span className="field-hint">Scales the whole window: text, icons and spacing together.</span>
        </div>
        <Segmented
          label="Interface size"
          value={t.uiScale}
          onChange={(uiScale) => set({ uiScale })}
          options={scales.map((s) => ({ value: s, label: `${Math.round(s * 100)}%`, title: s === 1 ? 'Default' : undefined }))}
        />
      </div>

      <div className="type-grid">
        <FontPicker role="ui" label="Interface font" hint="Menus, lists, labels and buttons." value={t.uiFont} custom={t.uiFontCustom} onChange={(uiFont, c) => set({ uiFont, ...(c !== undefined ? { uiFontCustom: c } : {}) })} />
        <FontPicker
          role="content"
          label="Transcript font"
          hint="Messages from you and your agents."
          value={t.contentFont}
          custom={t.contentFontCustom}
          onChange={(contentFont, c) => set({ contentFont, ...(c !== undefined ? { contentFontCustom: c } : {}) })}
        />
        <FontPicker
          role="code"
          label="Code font"
          hint="Code blocks, diffs and the terminal."
          value={t.codeFont}
          custom={t.codeFontCustom}
          onChange={(codeFont, c) => set({ codeFont, ...(c !== undefined ? { codeFontCustom: c } : {}) })}
        />
      </div>

      <div className="type-grid">
        <Field label="Transcript text size">
          <select value={t.contentSize} onChange={(e) => set({ contentSize: Number(e.target.value) })}>
            {sizes(CONTENT_SIZES, t.contentSize).map((n) => (
              <option key={n} value={n}>
                {n} px{n === DEFAULT_TYPOGRAPHY.contentSize ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Code text size" hint="The terminal keeps its own size under Terminal.">
          <select value={t.codeSize} onChange={(e) => set({ codeSize: Number(e.target.value) })}>
            {sizes(CODE_SIZES, t.codeSize).map((n) => (
              <option key={n} value={n}>
                {n} px{n === DEFAULT_TYPOGRAPHY.codeSize ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <div className="type-spacing">
          <span className="field-label">Line spacing</span>
          <Segmented label="Line spacing" value={t.lineSpacing} onChange={(lineSpacing) => set({ lineSpacing })} options={LINE_SPACINGS.map((l) => ({ value: l.id, label: l.name }))} />
        </div>
      </div>

      <div className="type-row type-row-stack">
        <div className="type-row-label">
          <span className="field-label">Transcript width</span>
          <span className="field-hint">How wide the conversation column and its lines of prose can grow.</span>
        </div>
        <WidthPicker value={t.width} onChange={(width) => set({ width })} />
      </div>

      <Sample />

      <div className="type-footer">
        <span className="field-hint">Applies instantly, in every theme and interface layout.</span>
        <Button size="sm" variant="ghost" icon="refresh" disabled={isDefaultTypography(t)} onClick={() => onChange({ ...DEFAULT_TYPOGRAPHY })}>
          Reset text &amp; fonts
        </Button>
      </div>
    </div>
  );
}
