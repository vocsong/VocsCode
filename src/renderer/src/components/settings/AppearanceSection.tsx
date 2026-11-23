/** Settings → Appearance: interface mode, color theme/palette, and typography. */
import React, { useEffect, useState } from 'react';
import { DEFAULT_PALETTE, GROUP_LABELS, GROUP_ORDER, PALETTES, THEME_MODES, findPalette, resolveScheme, swatchFor, type PaletteId, type ThemeMode } from '../../../../shared/themes';
import type { AppSettings } from '../../../../shared/types';
import { UI_MODES, type UiModeId } from '../../../../shared/ui-modes';
import { darkQuery, systemPrefersDark } from '../../theme';
import { SettingsGroup } from '../SettingsPrimitives';
import { TypographySettings } from '../TypographySettings';
import { Icon } from '../ui';

const MODE_ICONS: Record<ThemeMode, string> = { system: 'monitor', light: 'sun', dark: 'moon' };

/** Whether the OS currently asks for dark, kept live so System previews follow an OS switch. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(systemPrefersDark);
  useEffect(() => {
    const query = darkQuery();
    if (!query) return;
    const sync = (): void => setDark(query.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return dark;
}

/**
 * The color theme: a System / Light / Dark switch, then one swatch per palette, grouped by family.
 * The two are independent — every palette has a light and a dark variant — so the swatches are
 * drawn in the scheme the window paints right now.
 */
function ThemePicker({ mode, palette, onMode, onPalette }: { mode: ThemeMode; palette: PaletteId; onMode: (mode: ThemeMode) => void; onPalette: (id: PaletteId) => void }) {
  const scheme = resolveScheme(mode, useSystemDark());
  return (
    <div className="theme-picker">
      <div className="theme-mode-row">
        <div className="theme-mode" role="group" aria-label="Light or dark mode">
          {THEME_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`theme-mode-option${mode === m.id ? ' active' : ''}`}
              title={m.description}
              aria-pressed={mode === m.id}
              onClick={() => onMode(m.id)}
            >
              <Icon name={MODE_ICONS[m.id]} size={14} />
              {m.name}
            </button>
          ))}
        </div>
        <span className="theme-mode-hint">{mode === 'system' ? `Following your computer · ${scheme === 'dark' ? 'Dark' : 'Light'} now` : 'Applies to every palette'}</span>
      </div>
      {GROUP_ORDER.map((group) => {
        const palettes = PALETTES.filter((p) => p.group === group);
        if (!palettes.length) return null;
        return (
          <div key={group}>
            <div className="theme-family">{GROUP_LABELS[group]}</div>
            <div className="theme-grid">
              {palettes.map((t) => {
                const [base, raised, accent] = swatchFor(t.id, scheme);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`theme-card${palette === t.id ? ' active' : ''}`}
                    title={t.description}
                    aria-label={t.name}
                    aria-pressed={palette === t.id}
                    onClick={() => onPalette(t.id)}
                  >
                    <span className="theme-swatch" style={{ background: base, borderColor: raised }}>
                      <span className="theme-swatch-bar" style={{ background: raised }} />
                      <span className="theme-swatch-dot" style={{ background: accent }} />
                    </span>
                    <span className="theme-card-name">
                      {t.name}
                      {t.animated && <Icon name="sparkles" size={11} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One card per interface mode, each with a wireframe of the layout it gives the window. */
function UiModePicker({ value, onChange }: { value: UiModeId; onChange: (id: UiModeId) => void }) {
  return (
    <div className="ui-mode-picker" role="group" aria-label="Interface">
      {UI_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`ui-mode-card${value === m.id ? ' active' : ''}`}
          data-testid={`ui-mode-${m.id}`}
          title={m.description}
          aria-label={`${m.name} interface`}
          aria-pressed={value === m.id}
          onClick={() => onChange(m.id)}
        >
          <UiModeMiniature id={m.id} />
          <span className="ui-mode-name">
            {m.name}
            {value === m.id && <Icon name="check" size={13} />}
          </span>
          <span className="ui-mode-tagline">{m.tagline}</span>
        </button>
      ))}
    </div>
  );
}

/** A schematic of each layout, drawn in the current theme's colors. */
function UiModeMiniature({ id }: { id: UiModeId }) {
  if (id === 'zen') {
    return (
      <span className="ui-mini ui-mini-zen" aria-hidden="true">
        <span className="ui-mini-rail"><i className="on" /><i /><i /><i /></span>
        <span className="ui-mini-column"><b className="w60" /><b className="w90" /><b className="w75" /><b className="w40 user" /><b className="w85" /></span>
        <span className="ui-mini-pill" />
      </span>
    );
  }
  return (
    <span className="ui-mini ui-mini-standard" aria-hidden="true">
      <span className="ui-mini-side"><b className="w80" /><b className="w60" /><b className="w70" /><b className="w50" /></span>
      <span className="ui-mini-main"><span className="ui-mini-head" /><b className="w70" /><b className="w90" /><b className="w50 user" /><span className="ui-mini-box" /></span>
      <span className="ui-mini-panel"><b className="w70" /><b className="w50" /></span>
    </span>
  );
}

export function AppearanceSection({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const palette = findPalette(settings.palette ?? DEFAULT_PALETTE) ?? PALETTES[0];
  const mode = THEME_MODES.find((m) => m.id === settings.theme) ?? THEME_MODES[0];
  return <div className="settings-section">
    <div className="settings-theme-preview" aria-hidden="true">
      <div className="settings-preview-sidebar"><Icon name="logo" size={24} /><span /><span /><span /></div>
      <div className="settings-preview-workspace"><div className="settings-eyebrow">YOUR NEXT GREAT IDEA</div><strong>A calmer place to build.</strong><p>One workspace. Every coding agent.</p><div className="settings-preview-message"><Icon name="sparkles" size={16} /> Ready when you are.</div></div>
      <div className="settings-preview-caption"><Icon name={MODE_ICONS[mode.id]} size={15} />{palette.name} · {mode.name}<span>Live preview</span></div>
    </div>
    <SettingsGroup id="appearance-interface" title="Interface" description="How the window is laid out. Separate from the color theme: every theme works with every layout, and switching keeps your sessions, drafts and panels as they are." icon="layout">
      <UiModePicker value={settings.uiMode ?? 'standard'} onChange={(next) => update({ uiMode: next })} />
    </SettingsGroup>
    <SettingsGroup id="appearance-theme" title="Color theme" description="Pick light or dark once, then any palette. Every palette has both variants, and System follows your computer." icon="palette">
      <ThemePicker mode={settings.theme} palette={settings.palette ?? DEFAULT_PALETTE} onMode={(next) => update({ theme: next })} onPalette={(next) => update({ palette: next })} />
    </SettingsGroup>
    <SettingsGroup id="appearance-typography" title="Text & fonts" description="Size, fonts and line length, tuned for long reading sessions. The sample below shows each change as you make it." icon="type">
      <TypographySettings value={settings.typography} onChange={(next) => update({ typography: next })} />
    </SettingsGroup>
  </div>;
}
