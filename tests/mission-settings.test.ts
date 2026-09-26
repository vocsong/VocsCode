import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, normalizeSettings, SettingsStore } from '../src/main/settings';
import { createDefaultMissionConfig, type MissionConfig } from '../src/shared/mission-config';
import type { AppSettings } from '../src/shared/types';
import { deferred } from '../src/main/util/async';

let root: string;
let store: SettingsStore;
const log = vi.fn();
const read = async () => JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8')) as AppSettings;

function configured(): MissionConfig {
  const mission = createDefaultMissionConfig();
  mission.presets = [{ id: 'lead', revision: 1, name: 'Engineer', harnessId: 'native', model: { provider: 'local', model: 'demo', connectionId: 'account-one' }, reasoning: { kind: 'explicit', value: 'low' }, enabled: true }];
  mission.tiers[4].presetIds = ['lead'];
  mission.defaultLeadPresetId = 'lead';
  return mission;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-settings-'));
  log.mockReset();
  store = new SettingsStore(root, log);
  await store.load();
  await store.update({ folders: ['/project'], providers: [...defaultSettings().providers, {
    id: 'local', name: 'Local', kind: 'ollama', enabled: true, hasApiKey: false,
    models: [{ provider: 'local', id: 'demo', displayName: 'Demo', supportsReasoning: true, supportedEfforts: ['low', 'high'] }]
  }] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('Mission settings persistence boundary', () => {
  it('normalizes old absent settings to five empty pools without choosing a default', () => {
    expect(normalizeSettings({ theme: 'system' }).mission).toEqual(createDefaultMissionConfig());
    expect(normalizeSettings(undefined).missionProjects).toEqual({});
  });

  it('round-trips exact presets, project references, restrictions and tightening without changing ordinary defaults', async () => {
    const saved = await store.update({ mission: configured(), missionProjects: { '/project': {
      schemaVersion: 1, revision: 1, defaultLeadPresetId: null, tiers: [{ id: 1, presetIds: ['lead'] }],
      allowedProviderIds: ['local'], allowedConnectionIds: ['account-one'], limits: { maxConcurrentWorkersPerMission: 2 }
    } } });
    const reloaded = await new SettingsStore(root).load();
    expect(reloaded.mission).toEqual(saved.mission);
    expect(reloaded.missionProjects).toEqual(saved.missionProjects);
    expect(reloaded.mission?.presets[0]).toMatchObject(configured().presets[0]);
    expect(reloaded.defaultEffort).toBeUndefined();
    expect(reloaded.defaultHarness).toBe('pi');
  });

  it.each([
    ['future schema', () => ({ mission: { ...configured(), schemaVersion: 99 } })],
    ['known unsupported effort', () => { const mission = configured(); mission.presets[0].reasoning = { kind: 'explicit', value: 'max' }; return { mission }; }],
    ['secret fields', () => { const mission = configured(); return { mission: { ...mission, presets: [{ ...mission.presets[0], apiKey: 'do-not-log-this' }] } }; }],
    ['dangling default', () => ({ mission: { ...configured(), defaultLeadPresetId: 'missing' } })],
    ['wider project limit', () => ({ mission: configured(), missionProjects: { '/project': { schemaVersion: 1, revision: 1, limits: { maxConcurrentWorkersPerMission: 5 } } } })],
    ['project preset injection', () => ({ missionProjects: { '/project': { schemaVersion: 1, revision: 1, presets: [] } } })],
    ['unknown project', () => ({ missionProjects: { '/not-configured': { schemaVersion: 1, revision: 1 } } })],
    ['invalid project map', () => ({ missionProjects: [] })]
  ])('rejects %s with no mutation, disk write or change notification', async (_name, patch) => {
    const previous = structuredClone(store.get());
    const before = await fs.readFile(path.join(root, 'settings.json'), 'utf8');
    const changed = vi.fn();
    store.onChange(changed);
    await expect(store.update(patch() as unknown as Partial<AppSettings>)).rejects.toThrow();
    expect(store.get()).toEqual(previous);
    expect(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).toBe(before);
    expect(changed).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('do-not-log-this');
  });

  it('keeps failed writes out of memory and later queued writes; listeners only see committed snapshots', async () => {
    const before = structuredClone(store.get());
    const changed = vi.fn();
    store.onChange(() => { throw new Error('listener failure'); });
    store.onChange(changed);
    const entered = deferred<void>();
    const release = deferred<void>();
    const open = fs.open.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (!failed && String(args[0]).startsWith(path.join(root, 'settings.json.'))) {
        failed = true;
        entered.resolve();
        await release.promise;
        throw new Error('injected write failure');
      }
      return open(...args);
    });
    const first = store.update({ mission: configured(), theme: 'dark' });
    const result = expect(first).rejects.toThrow('injected write failure');
    await entered.promise;
    const second = store.update({ notifications: false });
    try {
      expect(store.get()).toEqual(before);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await result;
      await second;
    }
    expect(store.get()).toEqual({ ...before, notifications: false });
    expect(await read()).toEqual(JSON.parse(JSON.stringify(store.get())));
    expect(changed).toHaveBeenCalledTimes(1);
    const saved = await store.update({ mission: configured() });
    expect(changed).toHaveBeenCalledTimes(2);
    expect((await new SettingsStore(root).load()).mission).toEqual(saved.mission);
  });

  it('merges serialized successful patches and detaches queued input', async () => {
    const changed = vi.fn();
    store.onChange(changed);
    const mission = configured();
    const first = store.update({ mission });
    mission.presets[0].model.connectionId = 'changed-outside-store';
    const second = store.update({ notifications: false });
    const [a, b] = await Promise.all([first, second]);
    expect(a.mission?.presets[0].model.connectionId).toBe('account-one');
    expect(a.notifications).toBe(true);
    expect(b.notifications).toBe(false);
    expect(b.mission).toEqual(a.mission);
    expect(changed.mock.calls.map(([s]) => s.notifications)).toEqual([true, false]);
    expect((await read()).mission).toEqual(a.mission);
  });

  it.each([null, { ...configured(), schemaVersion: 23 }, { broken: true }])('fails closed on corrupt/future Mission settings, logs diagnostics and preserves them until explicit replacement', async (mission) => {
    const stored = { ...store.get(), mission };
    await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify(stored));
    const reloaded = new SettingsStore(root, log);
    const current = await reloaded.load();
    expect(current.mission).toEqual(createDefaultMissionConfig());
    expect(current.missionProjects).toEqual({});
    expect(log).toHaveBeenCalledWith('error', expect.stringMatching(/Mission.*disabled/));
    await reloaded.update({ notifications: false });
    expect((await read()).mission).toEqual(mission);
    await reloaded.update({ mission: createDefaultMissionConfig(), missionProjects: {} });
    expect((await read()).mission).toEqual(createDefaultMissionConfig());
  });
});
