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
import { ConfirmHost } from '../src/renderer/src/components/ui';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, RemoteAuditEntry, RemoteState } from '../src/shared/types';
import { decodeQrPath } from './support/qr-decode';

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
  remote: { enabled: true }
} as unknown as AppSettings;

function remoteResult(viewOnly: boolean, audit: RemoteAuditEntry[] = [], extra: Partial<RemoteState> = {}) {
  const state: RemoteState = { status: 'online', onlineClients: ['w_1'], viewOnly, ...extra };
  return {
    config: { enabled: true, viewOnly },
    state,
    devices: [
      { deviceId: 'h_1', kind: 'host', name: 'Work PC', platform: 'win32', lastSeen: Date.now() },
      { deviceId: 'w_1', kind: 'web', name: 'Chrome', platform: 'web', lastSeen: Date.now() }
    ],
    audit,
    // The relay main reports; the panel offers no way to change it.
    relayUrl: 'https://relay.example'
  };
}

function renderRemote(audit: RemoteAuditEntry[] = [], viewOnly = false, extra: Partial<RemoteState> = {}): void {
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'remote:get') return Promise.resolve(remoteResult(viewOnly, audit, extra));
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
  it('connects with only the enrollment secret and names the relay it uses', async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'remote:get') return Promise.resolve({ config: { enabled: false }, state: { status: 'off' }, devices: [], audit: [], relayUrl: 'https://code.vocs.io' });
      return Promise.resolve({ status: 'connecting' });
    });
    useStore.setState({ settings: { ...baseSettings, remote: { enabled: false } } as AppSettings });
    render(<SettingsView />);
    fireEvent.click(screen.getByText('Remote access'));
    await vi.waitFor(() => expect(screen.getByTestId('remote-relay').textContent).toBe('code.vocs.io'));
    // There is no relay URL to type: the secret alone enables Connect.
    expect(screen.queryByTestId('remote-relay-url')).toBeNull();
    const connect = screen.getByTestId('remote-connect') as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('remote-enroll'), { target: { value: ' enroll-secret ' } });
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:enable', { enrollToken: 'enroll-secret' }));
  });

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
    const toggle = screen.getByText('Only allow reading from paired browsers').closest('.toggle')?.querySelector('input') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:setViewOnly', { viewOnly: true }));
  });

  it('shows a live pairing code as a link and a QR code that both open this relay', async () => {
    renderRemote([], false, { pairing: { code: 'ABCD2345', expiresAt: Date.now() + 120_000 } });
    const link = (await screen.findByTestId('remote-pair-link')) as HTMLInputElement;
    // The page claims against its own origin, so the link must be the relay main reports.
    expect(link.value).toBe('https://relay.example/app?code=ABCD2345');
    const qr = screen.getByTestId('remote-pair-qr');
    const extent = Number(qr.getAttribute('viewBox')?.split(' ')[2]);
    expect(decodeQrPath(qr.querySelector('path')!.getAttribute('d')!, extent)).toBe(link.value);
  });

  it('opens the web client in the default browser from the relay name and the pairing hint', async () => {
    renderRemote([], false, { pairing: { code: 'ABCD2345', expiresAt: Date.now() + 120_000 } });
    const opened = () => invokeMock.mock.calls.filter(([channel]) => channel === 'app:openExternal');
    const relay = await screen.findByTestId('remote-relay');
    // The name follows the relay main reports, and so does where it leads.
    await vi.waitFor(() => expect(relay.textContent).toBe('relay.example'));
    fireEvent.click(relay);
    await vi.waitFor(() => expect(opened()).toEqual([['app:openExternal', { url: 'https://relay.example/app' }]]));
    fireEvent.click(await screen.findByTestId('remote-web-app'));
    await vi.waitFor(() => expect(opened()).toHaveLength(2));
    expect(opened()[1]).toEqual(['app:openExternal', { url: 'https://relay.example/app' }]);
  });

  it('pulls the kill switch only after the confirmation dialog', async () => {
    invokeMock.mockImplementation((channel: string) => (channel === 'remote:get' ? Promise.resolve(remoteResult(false)) : Promise.resolve({})));
    useStore.setState({ settings: { ...baseSettings } as AppSettings });
    render(<><SettingsView /><ConfirmHost /></>);
    fireEvent.click(screen.getByText('Remote access'));
    fireEvent.click(await screen.findByTestId('remote-revoke-all'));
    await screen.findByText('Revoke every paired device?');
    expect(invokeMock).not.toHaveBeenCalledWith('remote:revokeAll', undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(screen.queryByText('Revoke every paired device?')).toBeNull());
    expect(invokeMock).not.toHaveBeenCalledWith('remote:revokeAll', undefined);

    fireEvent.click(screen.getByTestId('remote-revoke-all'));
    await screen.findByText('Revoke every paired device?');
    const confirm = screen.getAllByRole('button', { name: 'Revoke all' }).find((b) => !b.hasAttribute('data-testid'))!;
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:revokeAll', undefined));
  });

  it('toggles the offline mirror through remote:setMirror', async () => {
    renderRemote();
    await screen.findByText('Offline mirror');
    fireEvent.click(screen.getByText('Let paired browsers read history while this computer is off'));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:setMirror', { mirror: true }));
  });
});
