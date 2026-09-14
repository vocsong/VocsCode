// P4 remote-access settings panel: the view-only toggle, the paired-device list with per-device
// revoke, and the recent-activity (audit) feed. The panel is driven through window.harness.invoke
// so the test asserts the exact channels the renderer calls.
/** @vitest-environment jsdom */
const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, RemoteAuditEntry, RemoteState } from '../src/shared/types';

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
  terminal: { shell: 'auto', customShellPath: '', customShellArgs: [], fontSize: 13, scrollback: 1000, cursorStyle: 'block', cursorBlink: true },
  remote: { enabled: true, relayUrl: 'https://relay.example' }
} as unknown as AppSettings;

function remoteResult(viewOnly: boolean, audit: RemoteAuditEntry[] = []) {
  const state: RemoteState = { status: 'online', onlineClients: ['w_1'], viewOnly };
  return {
    config: { enabled: true, relayUrl: 'https://relay.example', viewOnly },
    state,
    devices: [
      { deviceId: 'h_1', kind: 'host', name: 'Work PC', platform: 'win32', lastSeen: Date.now() },
      { deviceId: 'w_1', kind: 'web', name: 'Chrome', platform: 'web', lastSeen: Date.now() }
    ],
    audit
  };
}

function renderRemote(audit: RemoteAuditEntry[] = [], viewOnly = false): void {
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'remote:get') return Promise.resolve(remoteResult(viewOnly, audit));
    return Promise.resolve({});
  });
  useStore.setState({ settings: { ...baseSettings } as AppSettings });
  render(<SettingsView />);
  fireEvent.click(screen.getByText('Remote access'));
}

beforeEach(() => {
  invokeMock.mockReset();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
});

afterEach(() => {
  cleanup();
});

describe('remote access settings (P4)', () => {
  it('renders the audit feed and clears it on demand', async () => {
    renderRemote([
      { at: Date.now(), action: 'pair-approve', device: 'w_1' },
      { at: Date.now(), action: 'view-only-blocked', detail: 'sessions:send' }
    ]);
    await screen.findByText('Recent activity');
    expect(screen.getByText(/pair-approve/)).toBeTruthy();
    expect(screen.getByText(/view-only-blocked · sessions:send/)).toBeTruthy();

    fireEvent.click(screen.getByText('Clear activity'));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:clearAudit', undefined));
  });

  it('revokes an individual paired device', async () => {
    renderRemote();
    await screen.findByText('Paired devices');
    // The connected browser is marked, and its own Revoke button carries its device id.
    expect(screen.getByText(/Chrome/)).toBeTruthy();
    fireEvent.click(screen.getAllByText('Revoke')[1]);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:revoke', { deviceId: 'w_1' }));
  });

  it('toggles view-only mode through remote:setViewOnly', async () => {
    renderRemote();
    await screen.findByText('View-only mode');
    const toggle = screen.getByRole('checkbox') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:setViewOnly', { viewOnly: true }));
  });
});
