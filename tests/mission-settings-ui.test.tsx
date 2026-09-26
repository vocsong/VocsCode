/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { MissionSettings } from '../src/renderer/src/components/mission/MissionSettings';
import { useStore } from '../src/renderer/src/store';
import { createDefaultMissionConfig, validateMissionConfig } from '../src/shared/mission-config';
import type { AppSettings, ModelInfo } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ canInvoke: () => true, invoke, isMac: false, modKey: 'Ctrl', platform: 'win32', on: () => () => undefined }));
const models: ModelInfo[] = [
  { provider: 'account-one', id: 'engine', displayName: 'First endpoint', supportsReasoning: true, supportedEfforts: ['low', 'high'] },
  { provider: 'account-two', id: 'engine', displayName: 'Second endpoint', supportsReasoning: false }
];
let saved: AppSettings;

beforeEach(() => {
  invoke.mockReset();
  saved = {
    version: 1, theme: 'system', defaultHarness: 'native', defaultEffort: 'max', defaultPermissionMode: 'ask',
    defaultModelByHarness: {}, favoriteModels: [], folders: ['/project'], binaries: {}, acpAgents: [], modelOverrides: {},
    notifications: false, goalDefaults: { autoContinue: true, maxIterations: 25, preferHarness: true },
    mission: createDefaultMissionConfig(), missionProjects: {}, agent: { enabled: false },
    providers: models.map((m) => ({ id: m.provider, name: m.provider, enabled: true, kind: 'ollama', hasApiKey: false, models: [m] }))
  } as unknown as AppSettings;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  useStore.setState({ settings: saved, modelCatalog: {}, view: 'settings' });
  invoke.mockImplementation(async (channel: string, request: Partial<AppSettings>) => {
    if (channel === 'providers:list') return saved.providers;
    if (channel === 'harness:models') return { models };
    if (channel === 'settings:update') {
      saved = { ...saved, ...request };
      return saved;
    }
    return {};
  });
});
afterEach(cleanup);

function open() {
  render(<SettingsView />);
  fireEvent.click(screen.getByRole('button', { name: 'Mission' }));
}
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
async function addPreset(name = 'Engineer', provider = 'account-one') {
  fireEvent.click(screen.getByRole('button', { name: 'New preset' }));
  change('Preset name', name);
  await screen.findByTitle(`${provider}/engine`);
  fireEvent.click(screen.getByTitle(`${provider}/engine`).closest('button')!);
  if (provider === 'account-one') change('Reasoning', 'high');
  fireEvent.click(screen.getByRole('button', { name: 'Apply preset' }));
  return screen.getByRole('region', { name: `Preset ${name}` });
}
async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save Mission settings' }));
  await screen.findByRole('status');
}

describe('Mission Settings user flows', () => {
  it('lives in the settings shell with all five unavailable pools, no invented defaults or launch control', () => {
    open();
    expect(screen.getAllByText('Unavailable pool — no presets. No fallback.')).toHaveLength(5);
    expect(screen.getByText(/Mission launch is unconfigured/)).toBeTruthy();
    expect((screen.getByLabelText('Default principal engineer (T5)') as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Save Mission settings' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /start mission|launch mission/i })).toBeNull();
    expect(invoke.mock.calls.some(([c]) => c === 'settings:update')).toBe(false);
  });

  it('creates an atomic exact preset, flags overlapping membership and persists one T5 default', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'New preset' }));
    // The app-wide default harness (native here) cannot run a Mission; a new preset starts on Pi.
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('pi');
    change('Preset name', 'Engineer');
    await screen.findByTitle('account-one/engine');
    fireEvent.click(screen.getByTitle('account-one/engine').closest('button')!);
    expect(within(screen.getByLabelText('Reasoning')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Default', 'low', 'high']);
    change('Connection ID (optional)', 'subscription-one');
    change('Reasoning', 'high');
    change('Preset selection guidance', 'Hard cross-module problems.');
    fireEvent.click(screen.getByRole('button', { name: 'Apply preset' }));
    fireEvent.click(screen.getByLabelText('T5: Engineer'));
    fireEvent.click(screen.getByLabelText('T3: Engineer'));
    const id = (screen.getByLabelText('Default principal engineer (T5)') as HTMLSelectElement).options[1].value;
    change('Default principal engineer (T5)', id);
    expect(screen.getByText(/Overlapping membership \(T3, T5\)/)).toBeTruthy();
    expect(screen.getByText('Default principal engineer', { selector: '.badge' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Preset Engineer' })).getByText('Unverified', { exact: true })).toBeTruthy();
    expect(screen.queryByText('Available', { exact: true })).toBeNull();
    await save();
    expect(saved.mission?.presets).toEqual([expect.objectContaining({ name: 'Engineer', harnessId: 'pi', model: { provider: 'account-one', model: 'engine', connectionId: 'subscription-one' }, reasoning: { kind: 'explicit', value: 'high' }, guidance: 'Hard cross-module problems.' })]);
    expect(saved.mission?.defaultLeadPresetId).toBe(id);
    expect(saved.defaultEffort).toBe('max');
    expect(invoke.mock.calls.filter(([c]) => c === 'settings:update')).toHaveLength(1);
  });

  it('edits Default without app-wide effort fallback, and deleting the default never selects a replacement', async () => {
    open(); await addPreset(); await addPreset('Backup', 'account-two');
    fireEvent.click(screen.getByLabelText('T5: Engineer')); fireEvent.click(screen.getByLabelText('T5: Backup'));
    const select = screen.getByLabelText('Default principal engineer (T5)') as HTMLSelectElement;
    change('Default principal engineer (T5)', select.options[1].value);
    await save();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Engineer' }));
    change('Preset name', 'Renamed engineer'); change('Reasoning', '');
    fireEvent.click(screen.getByRole('button', { name: 'Apply preset' }));
    await save();
    expect(saved.mission?.presets[0]).toMatchObject({ revision: 2, reasoning: { kind: 'default' } });
    expect(saved.defaultEffort).toBe('max');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Renamed engineer' }));
    expect((screen.getByLabelText('Default principal engineer (T5)') as HTMLSelectElement).value).toBe('');
    await save();
    expect(saved.mission?.presets.map((p) => p.name)).toEqual(['Backup']);
    expect(saved.mission?.defaultLeadPresetId).toBeUndefined();
  });

  it('clears global and inheriting-project defaults when removing T5 membership or disabling a preset', async () => {
    open(); await addPreset();
    fireEvent.click(screen.getByLabelText('T5: Engineer'));
    const id = (screen.getByLabelText('Default principal engineer (T5)') as HTMLSelectElement).options[1].value;
    change('Default principal engineer (T5)', id);
    change('Project folder', '/project'); change('Project principal engineer (T5)', id);
    fireEvent.click(screen.getByLabelText('T5: Engineer'));
    expect((screen.getByLabelText('Default principal engineer (T5)') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Project principal engineer (T5)') as HTMLSelectElement).value).toBe('__none');
    await save();
    expect(saved.mission?.defaultLeadPresetId).toBeUndefined();
    expect(saved.missionProjects?.['/project'].defaultLeadPresetId).toBeNull();
    fireEvent.click(screen.getByLabelText('T5: Engineer'));
    change('Default principal engineer (T5)', id);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Engineer' }));
    fireEvent.click(screen.getByLabelText('Preset enabled'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply preset' }));
    await save();
    expect(saved.mission?.presets[0].enabled).toBe(false);
    expect(saved.mission?.defaultLeadPresetId).toBeUndefined();
    expect(screen.getAllByText('Unavailable pool — all presets are disabled.').length).toBeGreaterThan(0);
  });

  it('offers only Default for models without effort and resets exact fields when the harness changes', async () => {
    open(); await addPreset('No effort', 'account-two');
    fireEvent.click(screen.getByRole('button', { name: 'Edit No effort' }));
    expect(within(screen.getByLabelText('Reasoning')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Default']);
    change('Connection ID (optional)', 'account-ref'); change('Harness', 'cursor');
    expect((screen.getByLabelText('Connection ID (optional)') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Model: Not selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply preset' }));
    expect(screen.getByRole('alert').textContent).toContain('model');
    expect(invoke.mock.calls.filter(([c]) => c === 'settings:update')).toHaveLength(0);
  });

  it('edits labels, guidance, membership, default and tightening restrictions for a configured folder using the same library', async () => {
    open(); await addPreset();
    fireEvent.click(screen.getByLabelText('T5: Engineer'));
    const id = (screen.getByLabelText('Default principal engineer (T5)') as HTMLSelectElement).options[1].value;
    change('Default principal engineer (T5)', id);
    change('T1 label', 'Evidence'); change('T1 guidance', 'Collect prescribed evidence only.');
    change('Workers per Mission', '3');
    change('Project folder', '/project');
    fireEvent.click(screen.getByLabelText('Override T1 membership'));
    fireEvent.click(screen.getByLabelText('Project T1: Engineer'));
    change('Project principal engineer (T5)', '__none');
    fireEvent.click(screen.getByLabelText('Restrict project providers'));
    fireEvent.click(screen.getByLabelText('Permit providers: account-one'));
    expect(screen.getByText(/No providers permitted/)).toBeTruthy();
    expect(screen.getByText(/Engineer: Unavailable/)).toBeTruthy();
    expect(screen.getByText(/Project overlapping membership for Engineer \(T1, T5\)/)).toBeTruthy();
    const project = screen.getByRole('region', { name: 'Project overrides' });
    fireEvent.click(within(project).getByLabelText('Override Workers per Mission'));
    fireEvent.change(within(project).getByLabelText('Workers per Mission'), { target: { value: '2' } });
    await save();
    expect(saved.mission?.tiers[0]).toMatchObject({ label: 'Evidence', guidance: 'Collect prescribed evidence only.', presetIds: [] });
    expect(saved.mission?.defaultLeadPresetId).toBe(id);
    expect(saved.missionProjects?.['/project']).toEqual({ schemaVersion: 1, revision: 1, defaultLeadPresetId: null, tiers: [{ id: 1, presetIds: [id] }], allowedProviderIds: [], limits: { maxConcurrentWorkersPerMission: 2 } });
    expect(() => validateMissionConfig(saved.mission)).not.toThrow();
    fireEvent.click(screen.getByRole('button', { name: 'Reset project overrides' }));
    await save();
    expect(saved.missionProjects).toEqual({});
  });

  it('saves explicit whole-Mission thresholds and bounded account capacity without inferred monetary defaults', async () => {
    open();
    expect((screen.getByLabelText('Observed Mission cost threshold (USD)') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Observed Mission token threshold') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/in-flight work and delayed or estimated telemetry can overshoot/)).toBeTruthy();
    change('Observed Mission cost threshold (USD)', '2.5'); change('Observed Mission token threshold', '10000');
    change('Account capacity connection', 'account-one'); change('Account-turn slots app-wide', '2');
    fireEvent.click(screen.getByRole('button', { name: 'Add account limit' }));
    change('Workers per Mission', '3');
    await save();
    expect(saved.mission?.limits).toMatchObject({ maxBudgetUsd: 2.5, maxTokens: 10000, accountLimits: { 'account-one': 2 }, maxConcurrentWorkersPerMission: 3 });
    expect(saved.mission?.tiers.map((tier) => tier.presetIds)).toEqual([[], [], [], [], []]);
    expect(saved.mission?.defaultLeadPresetId).toBeUndefined();
    change('Observed Mission cost threshold (USD)', ''); change('Observed Mission token threshold', '');
    fireEvent.click(screen.getByRole('button', { name: 'Remove account limit: account-one' }));
    await save();
    expect(saved.mission?.limits.maxBudgetUsd).toBeUndefined(); expect(saved.mission?.limits.maxTokens).toBeUndefined();
    expect(saved.mission?.limits.accountLimits).toEqual({});
    change('Project folder', '/project');
    const project = screen.getByRole('region', { name: 'Project overrides' });
    fireEvent.click(within(project).getByLabelText('Override Observed Mission cost threshold (USD)'));
    expect((within(project).getByLabelText('Observed Mission cost threshold (USD)') as HTMLInputElement).value).toBe('');
    expect(within(project).queryByLabelText('Account capacity connection')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save Mission settings' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('maxBudgetUsd'));
    expect(saved.missionProjects?.['/project']).toBeUndefined();
  });

  it('does not send invalid limits and preserves the editable draft after a rejected save', async () => {
    open(); change('Workers per Mission', '0');
    fireEvent.click(screen.getByRole('button', { name: 'Save Mission settings' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('limits.maxConcurrentWorkersPerMission'));
    expect(invoke.mock.calls.filter(([c]) => c === 'settings:update')).toHaveLength(0);
    change('Workers per Mission', '2');
    invoke.mockRejectedValueOnce(new Error('injected disk failure'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Mission settings' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('injected disk failure'));
    expect(saved.mission?.limits.maxConcurrentWorkersPerMission).toBe(4);
    expect((screen.getByLabelText('Workers per Mission') as HTMLInputElement).value).toBe('2');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    await save();
    expect(saved.mission?.limits.maxConcurrentWorkersPerMission).toBe(2);
  });

  it('states what can run a Mission, offers Pi and labels other harnesses without rewriting a saved preset', async () => {
    const mission = createDefaultMissionConfig();
    mission.presets.push({ id: 'saved-claude', revision: 3, name: 'Saved Claude', harnessId: 'claude', model: { provider: 'account-two', model: 'engine' }, reasoning: { kind: 'default' }, enabled: true });
    saved = { ...saved, mission };
    useStore.setState({ settings: saved });
    open();
    expect(screen.getByTestId('mission-support').textContent).toBe('Missions are experimental. Supported today: Pi presets on Windows.');
    expect(screen.queryByText(/not enabled in this phase/)).toBeNull();
    expect(screen.getByText(/Saving never starts a Mission: start one from New Session → Mission, or type \/mission/)).toBeTruthy();
    const card = screen.getByRole('region', { name: 'Preset Saved Claude' });
    expect(within(card).getByText('Not supported for Missions yet')).toBeTruthy();
    expect(within(card).getByText(/Claude Agent SDK presets are not supported for Missions yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New preset' }));
    const harness = screen.getByLabelText('Harness') as HTMLSelectElement;
    expect(harness.value).toBe('pi');
    expect([...harness.options].map((option) => option.textContent)).toEqual([
      'Pi', 'Claude Agent SDK — not supported for Missions yet', 'Codex (app-server) — not supported for Missions yet', 'Codex (exec SDK) — not supported for Missions yet',
      'Cursor — not supported for Missions yet', 'ACP agent (DeepSeek Harness, ...) — not supported for Missions yet', 'Native loop — not supported for Missions yet'
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel preset edit' }));
    // Editing a saved unsupported preset keeps its harness; nothing is silently rewritten to Pi.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Saved Claude' }));
    expect((screen.getByLabelText('Harness') as HTMLSelectElement).value).toBe('claude');
    change('Preset name', 'Saved Claude, renamed');
    fireEvent.click(screen.getByRole('button', { name: 'Apply preset' }));
    await save();
    expect(saved.mission?.presets).toEqual([expect.objectContaining({ id: 'saved-claude', name: 'Saved Claude, renamed', harnessId: 'claude', model: { provider: 'account-two', model: 'engine' } })]);
  });

  it('shows an invalid incoming config diagnostic instead of treating it as executable or silently saving defaults', () => {
    render(<MissionSettings settings={{ ...saved, mission: { ...createDefaultMissionConfig(), schemaVersion: 9 } as unknown as AppSettings['mission'] }} />);
    expect(screen.getByRole('alert').textContent).toContain('Mission configuration is disabled');
    expect(screen.getByRole('button', { name: 'Replace invalid Mission settings' })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });
});
