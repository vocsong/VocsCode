// The stored interface mode (shared/ui-modes.ts): normalized on every load and save, so a hand-edited
// or future value can never leave the window in a layout this build has no styles for.
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultSettings, normalizeSettings, SettingsStore } from '../src/main/settings';
import { isUiModeId, UI_MODES } from '../src/shared/ui-modes';
import type { AppSettings } from '../src/shared/types';

describe('interface mode in settings', () => {
  it('defaults to Standard, keeps a known mode and drops anything else back to Standard', () => {
    expect(defaultSettings().uiMode).toBe('standard');
    expect(normalizeSettings({}).uiMode).toBe('standard');
    expect(normalizeSettings({ theme: 'dark' }).uiMode).toBe('standard');
    for (const m of UI_MODES) expect(normalizeSettings({ uiMode: m.id }).uiMode).toBe(m.id);
    // 'mono' and 'paper' were modes in unreleased builds of this branch; they fall back like any
    // unknown value.
    for (const junk of ['Zen', 'compact', 'mono', 'paper', '', 42, null, { id: 'zen' }]) {
      expect(isUiModeId(junk)).toBe(false);
      expect(normalizeSettings({ uiMode: junk as never }).uiMode).toBe('standard');
    }
  });

  it('persists a switch to settings.json without touching the color theme, and refuses a mode this build does not know', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ui-mode-'));
    try {
      const store = new SettingsStore(dir);
      await store.load();
      await store.update({ theme: 'blueprint' });
      expect((await store.update({ uiMode: 'zen' })).uiMode).toBe('zen');
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8')) as AppSettings;
      expect(onDisk).toMatchObject({ uiMode: 'zen', theme: 'blueprint' });
      const reloaded = new SettingsStore(dir);
      expect((await reloaded.load()).uiMode).toBe('zen');
      expect((await reloaded.update({ uiMode: 'bogus' as never })).uiMode).toBe('standard');
      const final = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8')) as AppSettings;
      expect(final).toMatchObject({ uiMode: 'standard', theme: 'blueprint' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loads a hand-edited unknown mode as Standard', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ui-mode-'));
    try {
      await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ uiMode: 'brutalist', theme: 'dark' }));
      const loaded = await new SettingsStore(dir).load();
      expect(loaded).toMatchObject({ uiMode: 'standard', theme: 'dark' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
