/** Settings → General & Housekeep sections. */
import React, { useState } from 'react';
import { HARNESSES } from '../../../../shared/harness-meta';
import { DEFAULT_HOUSEKEEP_RECENT_DAYS, MAX_HOUSEKEEP_RECENT_DAYS, normalizeHousekeepRecentDays } from '../../../../shared/housekeep';
import { DEFAULT_PALETTE, THEME_MODES, findPalette } from '../../../../shared/themes';
import type { AppSettings } from '../../../../shared/types';
import { UI_MODES } from '../../../../shared/ui-modes';
import { SETTINGS_PAGES, type SettingsSection } from '../../settings-catalog';
import { SettingsGroup } from '../SettingsPrimitives';
import { Field, Icon, Toggle } from '../ui';

export function HousekeepSection({ recentDays, onSave }: { recentDays?: number; onSave: (days: number) => Promise<unknown> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ days: number } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const current = submitted?.days ?? normalizeHousekeepRecentDays(recentDays);
  const commit = (input: HTMLInputElement) => {
    if (draft === null) return;
    setDraft(null);
    // A blank or incomplete number is not an intentional zero. Only submit a valid, finished edit.
    setInvalid(!input.validity.valid);
    if (!input.validity.valid || input.valueAsNumber === current) return;
    const mine = { days: input.valueAsNumber };
    setSubmitted(mine);
    void onSave(mine.days).finally(() => setSubmitted((latest) => latest === mine ? null : latest));
  };

  return (
    <SettingsGroup id="housekeep-recent" title="Recent session protection" icon="clock">
      <Field label="Protect sessions used in the last (days)">
        <input
          type="number" min={0} max={MAX_HOUSEKEEP_RECENT_DAYS} step={1} required
          value={draft ?? current}
          aria-describedby="housekeep-recent-hint"
          onChange={(e) => { setDraft(e.currentTarget.value); setInvalid(false); }}
          onBlur={(e) => commit(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            commit(e.currentTarget);
          }}
        />
      </Field>
      <p id="housekeep-recent-hint" className="field-hint">Enter a whole number from 0 to {MAX_HOUSEKEEP_RECENT_DAYS} (default: {DEFAULT_HOUSEKEEP_RECENT_DAYS}). 0 disables only the age guard; other protections still apply.</p>
      {invalid && <p role="alert">That value wasn’t saved. Enter a whole number from 0 to {MAX_HOUSEKEEP_RECENT_DAYS}.</p>}
    </SettingsGroup>
  );
}

export function GeneralSection({ settings, update, navigate }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; navigate: (section: SettingsSection) => void }) {
  const palette = findPalette(settings.palette ?? DEFAULT_PALETTE);
  const mode = THEME_MODES.find((m) => m.id === settings.theme);
  const links: { section: SettingsSection; detail: string }[] = [
    { section: 'appearance', detail: `${UI_MODES.find((m) => m.id === (settings.uiMode ?? 'standard'))?.name ?? 'Standard'} · ${palette?.name ?? 'Default'} · ${mode?.name ?? 'System'}` },
    { section: 'sessions', detail: HARNESSES.find((h) => h.id === settings.defaultHarness)?.name ?? 'Choose your defaults' },
    { section: 'providers', detail: `${settings.providers.filter((p) => p.enabled).length} enabled providers` },
    { section: 'shortcuts', detail: 'Make it second nature' },
  ];
  return <div className="settings-section">
    <div className="settings-overview">
      <span className="settings-overview-symbol"><Icon name="settings" size={24} /></span>
      <div><div className="settings-eyebrow">YOUR WORKSPACE, YOUR WAY</div><h2>A little setup. A better flow.</h2><p>Start with the essentials, or search for exactly what you need.</p></div>
    </div>
    <div className="settings-quick-links">
      {links.map((link) => {
        const item = SETTINGS_PAGES.find((p) => p.id === link.section)!;
        return <button key={item.id} type="button" className="settings-quick-link" onClick={() => navigate(item.id)}>
          <span className="settings-quick-icon"><Icon name={item.icon} size={19} /></span><span><strong>{item.label}</strong><small>{link.detail}</small></span><Icon name="chevronRight" size={15} />
        </button>;
      })}
    </div>
    <SettingsGroup id="general-notifications" title="Stay in the loop" description="Get a heads-up when your agents need you, without interrupting your focus." icon="bell">
      <Toggle checked={settings.notifications} onChange={(v) => update({ notifications: v })} label="Desktop notifications when a turn finishes or approval is needed (only while the window is unfocused)" />
    </SettingsGroup>
    <SettingsGroup id="general-editor" title="Your editor" description="Jump from a file or diff into the editor you already love." icon="code">
      <Field label="Editor command" hint="Used by “Open in editor”. VS Code (code) supports jumping to a line.">
        <input value={settings.binaries.editor ?? ''} placeholder="code" onChange={(e) => update({ binaries: { ...settings.binaries, editor: e.target.value } })} />
      </Field>
    </SettingsGroup>
  </div>;
}
