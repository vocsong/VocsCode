import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { retireLegacyMissionData } from '../src/main/legacy-mission';
import { normalizeSettings } from '../src/main/settings';
import type { AppSettings } from '../src/shared/types';

const dirs: string[] = [];
async function userData(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-mission-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('retired Mission data', () => {
  it('removes the coordination store and ownership receipts but keeps worktrees and delivery checkouts', async () => {
    const root = await userData();
    await fs.mkdir(path.join(root, 'missions', 'm_1'), { recursive: true });
    await fs.writeFile(path.join(root, 'missions', 'm_1', 'journal.jsonl'), '{}\n');
    await fs.mkdir(path.join(root, 'mission-process-ownership'), { recursive: true });
    await fs.writeFile(path.join(root, 'mission-process-ownership', 'a.intent.json'), '{}');
    await fs.mkdir(path.join(root, 'mission-workspaces', 'w_1'), { recursive: true });
    await fs.writeFile(path.join(root, 'mission-workspaces', 'w_1', 'work.txt'), 'unmerged');
    await fs.mkdir(path.join(root, 'mission-delivery'), { recursive: true });
    const logs: string[] = [];

    const result = await retireLegacyMissionData(root, (_level, message) => logs.push(message));

    await expect(fs.stat(path.join(root, 'missions'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(root, 'mission-process-ownership'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(root, 'mission-workspaces', 'w_1', 'work.txt'), 'utf8')).toBe('unmerged');
    expect(result.removed).toEqual([path.join(root, 'missions'), path.join(root, 'mission-process-ownership')]);
    // An empty delivery folder holds nothing worth reporting.
    expect(result.kept).toEqual([path.join(root, 'mission-workspaces')]);
    expect(logs.some((line) => line.includes('mission-workspaces') && line.includes('kept'))).toBe(true);
  });

  it('does nothing in a profile that never had Missions', async () => {
    const root = await userData();
    const logs: string[] = [];
    expect(await retireLegacyMissionData(root, (_level, message) => logs.push(message))).toEqual({ removed: [], kept: [] });
    expect(logs).toEqual([]);
  });

  it('drops the retired Mission settings keys', () => {
    const stored = { mission: { presets: [] }, missionProjects: { 'C:\\repo': {} } } as unknown as Partial<AppSettings>;
    const settings = normalizeSettings(stored) as AppSettings & { mission?: unknown; missionProjects?: unknown };
    expect('mission' in settings).toBe(false);
    expect('missionProjects' in settings).toBe(false);
  });
});
