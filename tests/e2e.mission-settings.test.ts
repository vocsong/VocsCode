/** Mission foundations through the real Settings UI; no provider credentials, sessions or agent turns. */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { AppSettings } from '../src/shared/types';
import { expectQuietWindow, isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');
let app: ElectronApplication | null = null;
let tmp: string | undefined;

afterAll(async () => {
  await app?.close().catch(() => undefined);
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

async function launch(userData: string): Promise<Page> {
  app = await electron.launch({
    executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')],
    env: isolatedEnv(userData), timeout: 60_000
  });
  const win = await app.firstWindow();
  await win.waitForSelector('.brand', { timeout: 60_000 });
  await expectQuietWindow(app);
  await win.getByRole('complementary').getByRole('button', { name: 'Settings', exact: true }).click();
  await win.getByRole('button', { name: 'Mission', exact: true }).click();
  await win.getByRole('heading', { name: 'Mission', exact: true }).waitFor();
  return win;
}

describe.runIf(enabled)('Mission settings UI', () => {
  it('saves exact library choices, empty pools, project tightening and survives an Electron restart, with no launch control in Settings', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-settings-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData); await fs.mkdir(project);
    const settingsPath = path.join(userData, 'settings.json');
    await fs.writeFile(settingsPath, seedSettings(project, {
      defaultHarness: 'native', defaultEffort: 'max', agent: { enabled: false },
      providers: [{ id: 'fixture-one', kind: 'ollama', name: 'Fixture (no server)', enabled: true, hasApiKey: false,
        models: [{ id: 'engine', provider: 'fixture-one', displayName: 'Fixture engine', supportsReasoning: true, supportedEfforts: ['low', 'high'] }] }]
    }));
    const readSettings = async (): Promise<AppSettings> => JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    let win = await launch(userData);
    // Honest support boundary for testers, and no stale "launch is not enabled" claim.
    await win.getByTestId('mission-support').getByText('Missions are experimental. Supported today: Pi presets on Windows.', { exact: true }).waitFor();
    expect(await win.getByText(/not enabled in this phase/).count()).toBe(0);
    expect(await win.getByText('Unavailable pool — no presets. No fallback.', { exact: true }).count()).toBe(5);
    expect(await win.getByRole('button', { name: /start mission|launch mission/i }).count()).toBe(0);
    await win.getByRole('button', { name: 'New preset', exact: true }).click();
    const harness = win.getByLabel('Harness', { exact: true });
    expect(await harness.inputValue()).toBe('pi');
    expect(await harness.locator('option[value="native"]').textContent()).toBe('Native loop — not supported for Missions yet');
    // The fixture catalog lives on the native harness: an explicit, labelled choice that is kept.
    await harness.selectOption('native');
    await win.getByLabel('Preset name', { exact: true }).fill('Engineer');
    await win.getByLabel('Provider / billing path', { exact: true }).selectOption('fixture-one');
    await win.locator('.mp-select:has(.mp-name[title="fixture-one/engine"])').click();
    await win.getByLabel('Connection ID (optional)', { exact: true }).fill('subscription-one');
    await win.getByLabel('Reasoning', { exact: true }).selectOption('high');
    await win.getByRole('button', { name: 'Apply preset', exact: true }).click();
    await win.getByRole('region', { name: 'Preset Engineer', exact: true }).getByText('Unverified', { exact: true }).waitFor();
    await win.getByRole('region', { name: 'Preset Engineer', exact: true }).getByText('Not supported for Missions yet', { exact: true }).waitFor();
    expect(await win.getByText('Available', { exact: true }).count()).toBe(0);
    await win.getByLabel('T5: Engineer', { exact: true }).check();
    await win.getByLabel('T3: Engineer', { exact: true }).check();
    await win.getByLabel('Default principal engineer (T5)', { exact: true }).selectOption({ label: 'Engineer' });
    await win.getByText(/Overlapping membership \(T3, T5\)/).waitFor();
    await win.getByLabel('T1 label', { exact: true }).fill('Evidence');
    await win.getByLabel('T1 guidance', { exact: true }).fill('Prescribed evidence collection');
    await win.getByLabel('Workers per Mission', { exact: true }).fill('3');
    expect(await win.getByLabel('Observed Mission cost threshold (USD)', { exact: true }).inputValue()).toBe('');
    await win.getByLabel('Observed Mission cost threshold (USD)', { exact: true }).fill('2.5');
    await win.getByLabel('Observed Mission token threshold', { exact: true }).fill('10000');
    await win.getByText(/in-flight work and delayed or estimated telemetry can overshoot/).waitFor();
    await win.getByLabel('Account capacity connection', { exact: true }).selectOption('subscription-one');
    await win.getByLabel('Account-turn slots app-wide', { exact: true }).fill('2');
    await win.getByRole('button', { name: 'Add account limit', exact: true }).click();
    await win.getByLabel('Project folder', { exact: true }).selectOption(project);
    const projectPanel = win.getByRole('region', { name: 'Project overrides', exact: true });
    await projectPanel.getByText('Override T1 membership', { exact: true }).click();
    expect(await projectPanel.getByLabel('Override T1 membership', { exact: true }).isChecked()).toBe(true);
    await projectPanel.getByLabel('Project T1: Engineer', { exact: true }).check();
    await projectPanel.getByLabel('Project principal engineer (T5)', { exact: true }).selectOption('__none');
    await projectPanel.getByText('Restrict project providers', { exact: true }).click();
    await projectPanel.getByLabel('Permit providers: fixture-one', { exact: true }).uncheck();
    await projectPanel.getByText(/No providers permitted/).waitFor();
    await projectPanel.getByText('Override Workers per Mission', { exact: true }).click();
    await projectPanel.getByLabel('Workers per Mission', { exact: true }).fill('2');
    await win.getByRole('button', { name: 'Save Mission settings', exact: true }).click();
    await win.getByRole('status').filter({ hasText: 'Mission settings saved' }).waitFor();
    const persisted = await readSettings();
    const id = persisted.mission!.presets[0].id;
    expect(persisted.mission!.presets).toEqual([{
      id, revision: 1, name: 'Engineer', enabled: true, harnessId: 'native',
      model: { provider: 'fixture-one', model: 'engine', connectionId: 'subscription-one' }, reasoning: { kind: 'explicit', value: 'high' }
    }]);
    expect(persisted.mission!.defaultLeadPresetId).toBe(id);
    expect(persisted.mission!.limits).toMatchObject({ maxBudgetUsd: 2.5, maxTokens: 10000, accountLimits: { 'subscription-one': 2 } });
    expect(persisted.mission!.tiers[0]).toEqual({ id: 1, label: 'Evidence', guidance: 'Prescribed evidence collection', presetIds: [] });
    expect(persisted.missionProjects![project]).toMatchObject({ defaultLeadPresetId: null, allowedProviderIds: [], tiers: [{ id: 1, presetIds: [id] }], limits: { maxConcurrentWorkersPerMission: 2 } });
    expect(persisted.defaultEffort).toBe('max');

    // A real process restart, not a renderer reload, proves persistence.
    await app!.close(); app = null;
    win = await launch(userData);
    await win.getByRole('region', { name: 'Preset Engineer', exact: true }).getByText('Not supported for Missions yet', { exact: true }).waitFor();
    expect(await win.getByLabel('T1 label', { exact: true }).inputValue()).toBe('Evidence');
    expect(await win.getByLabel('Observed Mission cost threshold (USD)', { exact: true }).inputValue()).toBe('2.5');
    expect(await win.getByLabel('Observed Mission token threshold', { exact: true }).inputValue()).toBe('10000');
    expect(await win.getByLabel('Account slots: subscription-one', { exact: true }).inputValue()).toBe('2');
    expect(await win.getByLabel('Default principal engineer (T5)', { exact: true }).inputValue()).toBe(id);
    expect((await readSettings()).mission).toEqual(persisted.mission);
    await win.getByLabel('Project folder', { exact: true }).selectOption(project);
    expect(await win.getByLabel('Project principal engineer (T5)', { exact: true }).inputValue()).toBe('__none');
    await win.getByText(/No providers permitted/).waitFor();

    // Invalid values never cross the settings boundary or replace the committed version.
    await win.getByLabel('Project folder', { exact: true }).selectOption('');
    await win.getByLabel('Workers per Mission', { exact: true }).fill('0');
    await win.getByRole('button', { name: 'Save Mission settings', exact: true }).click();
    await win.getByRole('alert').filter({ hasText: 'limits.maxConcurrentWorkersPerMission' }).waitFor();
    expect((await readSettings()).mission).toEqual(persisted.mission);
    await win.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await win.getByRole('button', { name: 'Edit Engineer', exact: true }).click();
    await win.getByLabel('Reasoning', { exact: true }).selectOption('');
    await win.getByRole('button', { name: 'Apply preset', exact: true }).click();
    await win.getByRole('button', { name: 'Save Mission settings', exact: true }).click();
    await expect.poll(async () => (await readSettings()).mission?.presets[0].reasoning).toEqual({ kind: 'default' });
    await win.getByRole('button', { name: 'Delete Engineer', exact: true }).click();
    await win.getByRole('button', { name: 'Save Mission settings', exact: true }).click();
    await expect.poll(async () => (await readSettings()).mission?.presets).toEqual([]);
    expect((await readSettings()).mission?.defaultLeadPresetId).toBeUndefined();
    await win.getByText(/Mission launch is unconfigured/).waitFor();
  }, 180_000);
});
