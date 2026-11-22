import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../src/main/settings';

describe('Housekeep settings persistence', () => {
  it('uses seven days for new profiles, old settings, and invalid stored values', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-housekeep-settings-'));
    try {
      const store = new SettingsStore(dir);
      expect((await store.load()).housekeepRecentDays).toBe(7);
      for (const housekeepRecentDays of [undefined, null, '0', -1, 1.5, 3651]) {
        await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', housekeepRecentDays }));
        expect(await store.load()).toMatchObject({ theme: 'dark', housekeepRecentDays: 7 });
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('persists both bounds and does not publish a failed write', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-housekeep-settings-'));
    try {
      const store = new SettingsStore(dir);
      await store.load();
      const onChange = vi.fn();
      store.onChange(onChange);
      expect((await store.update({ housekeepRecentDays: 0 })).housekeepRecentDays).toBe(0);

      const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('Disk is full'), { code: 'ENOSPC' }));
      try {
        await expect(store.update({ housekeepRecentDays: 3650 })).rejects.toThrow('Disk is full');
      } finally {
        rename.mockRestore();
      }
      expect(store.get().housekeepRecentDays).toBe(0);
      expect((await new SettingsStore(dir).load()).housekeepRecentDays).toBe(0);
      expect(onChange).toHaveBeenCalledTimes(1);

      expect((await store.update({ housekeepRecentDays: 3650 })).housekeepRecentDays).toBe(3650);
      expect((await new SettingsStore(dir).load()).housekeepRecentDays).toBe(3650);
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
