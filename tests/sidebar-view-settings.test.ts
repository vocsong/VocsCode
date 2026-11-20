// settings.sidebarView (the sidebar's Folders / Recent layout): normalized on every load and save,
// so a hand-edited or future value always falls back to the folder-grouped default.
import { describe, expect, it } from 'vitest';
import { defaultSettings, normalizeSettings } from '../src/main/settings';

describe('sidebar view in settings', () => {
  it('stores the view as folders unless it is exactly recent', () => {
    expect(defaultSettings().sidebarView).toBe('folders');
    expect(normalizeSettings({}).sidebarView).toBe('folders');
    expect(normalizeSettings({ sidebarView: 'recent' }).sidebarView).toBe('recent');
    for (const junk of ['Recent', 'flat', '', 42, null]) expect(normalizeSettings({ sidebarView: junk as never }).sidebarView).toBe('folders');
  });
});
