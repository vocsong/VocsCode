// Harness logins card (Settings → Providers & keys): the update check names a newer CLI version,
// offers the update where it would take effect, and explains instead of offering a dead button when
// the runtime is one Vocs Code bundles or a path the user pinned.
/** @vitest-environment jsdom */
const invokeMock = vi.fn();
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, HarnessAvailability, HarnessId, HarnessUpdate, ModelInfo } from '../src/shared/types';
import { searchSettings } from '../src/renderer/src/settings-catalog';

const baseSettings = {
  theme: 'system',
  defaultHarness: 'claude',
  defaultPermissionMode: 'ask',
  defaultModelByHarness: {},
  favoriteModels: [],
  notifications: false,
  goalDefaults: { autoContinue: false, maxIterations: 25 },
  binaries: {},
  providers: [],
  acpAgents: [],
  customShortcuts: {},
  folders: [],
  terminal: { shell: 'auto', customShellPath: '', customShellArgs: [], fontSize: 13, scrollback: 1000, cursorStyle: 'block', cursorBlink: true }
} as unknown as AppSettings;

const availability: Partial<Record<HarnessId, HarnessAvailability>> = {
  claude: { available: true, version: '2.1.280 (Claude Code)', authenticated: true, source: 'bundled' },
  codex: { available: true, version: 'codex-cli 0.154.0', authenticated: true, source: 'app-runtime' },
  pi: { available: true, version: '0.85.1', authenticated: true, source: 'system' }
};

const checked: Partial<Record<HarnessId, HarnessUpdate>> = {
  claude: {
    package: '@anthropic-ai/claude-code',
    current: '2.1.280',
    latest: '2.1.283',
    newer: true,
    updatable: false,
    reason: 'it runs the runtime Vocs Code bundles, which moves with an app update'
  },
  codex: { package: '@openai/codex', current: '0.154.0', latest: '0.154.0', newer: false, updatable: true },
  pi: { package: '@earendil-works/pi-coding-agent', current: '0.85.1', latest: '0.87.1', newer: true, updatable: true }
};

function respond(overrides: Record<string, unknown> = {}): void {
  invokeMock.mockReset();
  invokeMock.mockImplementation((channel: string) => {
    if (channel in overrides) return Promise.resolve(overrides[channel]);
    if (channel === 'harness:checkUpdates') return Promise.resolve(checked);
    if (channel === 'harness:install') return Promise.resolve({ ok: true, log: '' });
    if (channel === 'harness:availability') return Promise.resolve(availability);
    if (channel === 'secrets:status') return Promise.resolve({ encryptionAvailable: true, hasFallback: false });
    return Promise.resolve({});
  });
}

async function openProviders(): Promise<void> {
  render(<SettingsView />);
  fireEvent.click(screen.getByRole('button', { name: 'Providers & keys' }));
  await screen.findByText('Harness logins');
}

/** Opening the card must not reach the network on its own: the check is an explicit action. */
async function openAndCheck(): Promise<void> {
  await openProviders();
  expect(invokeMock.mock.calls.filter(([channel]) => channel === 'harness:checkUpdates')).toHaveLength(0);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  });
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
  respond();
  useStore.setState({ availability, settings: { ...baseSettings } as AppSettings, modelCatalog: {}, toasts: [] });
});

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});

const oldModels: ModelInfo[] = [{ id: 'old-model', provider: 'test', displayName: 'Old model' }];
const newModels: ModelInfo[] = [
  { id: 'new-model', provider: 'test', displayName: 'New model' },
  { id: 'another-model', provider: 'test', displayName: 'Another model' }
];
type ModelResponse = { models: ModelInfo[]; error?: string };
function respondModels(handler: (harness: HarnessId) => Promise<ModelResponse>): void {
  const fallback = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((channel: string, payload?: { harness: HarnessId }) => {
    if (channel === 'harness:models') return handler(payload!.harness);
    return fallback(channel);
  });
}
function modelCalls(): unknown[][] {
  return invokeMock.mock.calls.filter(([channel]) => channel === 'harness:models');
}

describe('harness model catalog refresh', () => {
  it('is discoverable in Settings search', () => {
    expect(searchSettings('refresh models')).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: 'providers', topic: expect.objectContaining({ anchor: 'providers-logins' }) })
    ]));
  });

  it('does not probe models, check updates or install when opening Providers or refreshing logins', async () => {
    await openProviders();
    expect(screen.getByRole('button', { name: 'Refresh Claude Agent SDK models' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh Codex (app-server) models' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh Pi models' })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh logins' })));
    expect(modelCalls()).toHaveLength(0);
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'harness:checkUpdates' || channel === 'harness:install' || channel.startsWith('session:'))).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith('harness:availability', { refresh: true });
  });

  it.each([
    ['claude', 'Claude Agent SDK'], ['pi', 'Pi'], ['codex', 'Codex (app-server)']
  ] as const)('refreshes %s on demand and replaces the shared composer catalog cache', async (harness, name) => {
    useStore.setState({ modelCatalog: {
      [harness]: { models: oldModels, loading: false },
      'codex-exec': { models: oldModels, loading: false }
    } });
    respondModels(async () => ({ models: newModels }));
    await openProviders();
    expect(modelCalls()).toHaveLength(0);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: `Refresh ${name} models` })));

    const expectedHarnesses = harness === 'codex' ? ['codex', 'codex-exec'] : [harness];
    expect(modelCalls().map(([, payload]) => payload)).toEqual(expectedHarnesses.map((id) => ({ harness: id })));
    for (const id of expectedHarnesses as HarnessId[]) {
      expect(useStore.getState().modelCatalog[id]).toEqual({ models: newModels, loading: false });
    }
    expect(screen.getByText(new RegExp(`${name.replace(/[()]/g, '\\$&')}: 2 models`))).toBeTruthy();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ kind: 'success', text: expect.stringContaining(`${name}: 2 models`) });
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'harness:install' || channel === 'harness:checkUpdates' || channel.startsWith('session:'))).toHaveLength(0);
  });

  it.each(['rejection', 'response'] as const)('reports a %s failure in the row and toast, preserves the cache, then retries', async (failure) => {
    useStore.setState({ modelCatalog: { pi: { models: oldModels, loading: false } } });
    let attempts = 0;
    respondModels(async () => {
      attempts++;
      if (attempts === 1) {
        if (failure === 'rejection') throw new Error('catalog offline');
        return { models: [], error: 'catalog offline' };
      }
      return { models: newModels };
    });
    await openProviders();
    const button = screen.getByRole('button', { name: 'Refresh Pi models' });
    await act(async () => fireEvent.click(button));
    expect(screen.getByText(/Could not refresh.*Pi.*catalog offline/)).toBeTruthy();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: expect.stringContaining('catalog offline') });
    expect(useStore.getState().modelCatalog.pi).toMatchObject({ models: oldModels, loading: false, error: 'catalog offline' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await act(async () => fireEvent.click(button));
    expect(modelCalls()).toHaveLength(2);
    expect(screen.queryByText(/catalog offline/)).toBeNull();
    expect(screen.getByText('Pi: 2 models')).toBeTruthy();
    expect(useStore.getState().modelCatalog.pi).toEqual({ models: newModels, loading: false });
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ kind: 'success' });
  });

  it('reports a Codex exec catalog failure even when the app-server refresh succeeded', async () => {
    useStore.setState({ modelCatalog: { 'codex-exec': { models: oldModels, loading: false } } });
    respondModels(async (harness) => harness === 'codex-exec' ? { models: [], error: 'exec unavailable' } : { models: newModels });
    await openProviders();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh Codex (app-server) models' })));
    expect(modelCalls()).toHaveLength(2);
    expect(screen.getByText(/Could not refresh.*Codex \(exec SDK\).*exec unavailable/)).toBeTruthy();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: expect.stringContaining('exec unavailable') });
    expect(useStore.getState().modelCatalog.codex).toMatchObject({ models: newModels, loading: false });
    expect(useStore.getState().modelCatalog['codex-exec']).toMatchObject({ models: oldModels, loading: false });
  });

  it('blocks duplicate refreshes while allowing another row to refresh independently', async () => {
    let finishPi!: (result: ModelResponse) => void;
    let finishClaude!: (result: ModelResponse) => void;
    respondModels((harness) => new Promise((resolve) => {
      if (harness === 'pi') finishPi = resolve;
      if (harness === 'claude') finishClaude = resolve;
    }));
    await openProviders();
    const piButton = screen.getByRole('button', { name: 'Refresh Pi models' }) as HTMLButtonElement;
    const claudeButton = screen.getByRole('button', { name: 'Refresh Claude Agent SDK models' }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(piButton);
      fireEvent.click(piButton);
      fireEvent.click(claudeButton);
    });
    expect(modelCalls()).toHaveLength(2);
    expect(piButton.disabled).toBe(true);
    expect(claudeButton.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Refresh Codex (app-server) models' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => finishClaude({ models: newModels }));
    expect(claudeButton.disabled).toBe(false);
    expect(piButton.disabled).toBe(true);
    expect(screen.getByText('Claude Agent SDK: 2 models')).toBeTruthy();
    await act(async () => finishPi({ models: oldModels }));
    expect(piButton.disabled).toBe(false);
    expect(screen.getByText('Pi: 1 model')).toBeTruthy();
    expect(useStore.getState().modelCatalog.claude?.models).toEqual(newModels);
    expect(useStore.getState().modelCatalog.pi?.models).toEqual(oldModels);
  });
});

describe('harness login updates', () => {
  it('checks on demand and offers the update only where the app can deliver it', async () => {
    await openAndCheck();

    expect(invokeMock).toHaveBeenCalledWith('harness:checkUpdates', { ids: ['claude', 'codex', 'pi'] });
    // Pi can be replaced in the app's runtime dir, so its newer version is a button.
    const update = await screen.findByRole('button', { name: 'Update to 0.87.1' });
    // Claude Code runs the SDK binary the app bundles: a badge and the reason, never a button.
    expect(screen.getByText('2.1.283 available')).toBeTruthy();
    expect(screen.getByText(/Claude Agent SDK 2\.1\.283 is newer, but it runs the runtime Vocs Code bundles/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /2\.1\.283/ })).toBeNull();
    // Codex is up to date, so its row carries no update affordance either.
    expect(screen.queryByRole('button', { name: /0\.154\.0/ })).toBeNull();
    expect(update).toBeTruthy();
  });

  it('rechecks the selected runtime after installation rather than claiming the registry version was installed', async () => {
    await openAndCheck();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Update to 0.87.1' }));
    });

    expect(invokeMock).toHaveBeenCalledWith('harness:install', { id: 'pi' });
    // This fixture still reports the older selected binary: installer success must not invent
    // a newer version or drop the offer. Recheck the actual selected runtime without cached probes.
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'harness:availability')).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith('harness:availability', { refresh: true });
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'harness:checkUpdates')).toHaveLength(2);
    expect(useStore.getState().toasts.at(-1)?.text).toBe('Installer finished for Pi; rechecking the selected runtime.');
    expect(useStore.getState().availability.pi?.version).toBe('0.85.1');
    expect(screen.getByRole('button', { name: 'Update to 0.87.1' })).toBeTruthy();
  });

  it('keeps the offer and reports the failure when the install fails', async () => {
    respond({ 'harness:install': { ok: false, log: 'npm ERR! EACCES' } });
    await openAndCheck();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Update to 0.87.1' }));
    });

    expect(useStore.getState().toasts.at(-1)?.text).toContain('Update failed: npm ERR! EACCES');
    // Nothing changed on disk, so the card neither re-probes nor drops the offer.
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'harness:checkUpdates')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Update to 0.87.1' })).toBeTruthy();
  });

  it('says what is up to date rather than leaving the check silent', async () => {
    respond({
      'harness:checkUpdates': {
        pi: { package: '@earendil-works/pi-coding-agent', current: '0.87.1', latest: '0.87.1', newer: false, updatable: true }
      }
    });
    await openAndCheck();
    expect(await screen.findByText('The harness CLIs are up to date.')).toBeTruthy();
  });

  it('reports a registry it could not reach, and offers nothing', async () => {
    respond({
      'harness:checkUpdates': {
        pi: { package: '@earendil-works/pi-coding-agent', current: '0.85.1', newer: false, updatable: true, error: 'getaddrinfo ENOTFOUND registry.npmjs.org' }
      }
    });
    await openAndCheck();
    expect(await screen.findByText(/Could not reach npm for Pi: getaddrinfo ENOTFOUND/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Update to/ })).toBeNull();
  });
});
