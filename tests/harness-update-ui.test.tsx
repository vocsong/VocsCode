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
import type { AppSettings, HarnessAvailability, HarnessId, HarnessUpdate } from '../src/shared/types';

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
  useStore.setState({ availability, settings: { ...baseSettings } as AppSettings, toasts: [] });
});

afterEach(async () => {
  await act(async () => {
    cleanup();
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

  it('installs the newer version, then refreshes the card and the check', async () => {
    await openAndCheck();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Update to 0.87.1' }));
    });

    expect(invokeMock).toHaveBeenCalledWith('harness:install', { id: 'pi' });
    // The card re-reads availability and re-checks, so the button cannot outlive the update.
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'harness:availability')).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'harness:checkUpdates')).toHaveLength(2);
    expect(useStore.getState().toasts.at(-1)?.text).toContain('Updated Pi to 0.87.1');
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
