// Settings → MCP control: the Vocs relay connection (Connect with Vocs, status, analytics sharing,
// the account's computers and the kill switch). The panel is driven through window.harness.invoke
// so the test asserts the exact channels the renderer calls.
/** @vitest-environment jsdom */
const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  // The separate automation panel has its own contract, not a relay-connection response.
  invoke: (channel: string, args: unknown) => channel === 'control:get'
    ? Promise.resolve({ instanceId: '30e4d8a1-cb8b-40bc-aa03-0c7ace255174', enabled: false, projects: [], grants: [] })
    : invokeMock(channel, args),
  on: vi.fn().mockReturnValue(() => undefined)
};

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { ConfirmHost } from '../src/renderer/src/components/ui';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, RemoteDeviceInfo, RemoteState } from '../src/shared/types';

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

const computers: RemoteDeviceInfo[] = [
  { deviceId: 'h_1', kind: 'host', name: 'Work PC', platform: 'win32 x64', lastSeen: Date.now(), online: true },
  { deviceId: 'h_2', kind: 'host', name: 'Laptop', platform: 'darwin arm64', lastSeen: Date.now() - 60_000 }
];

function remoteResult(over: { state?: Partial<RemoteState>; devices?: RemoteDeviceInfo[]; registered?: boolean; signInAvailable?: boolean; enabled?: boolean } = {}) {
  return {
    config: { enabled: over.enabled ?? true },
    state: { status: 'online', registered: true, ...over.state } as RemoteState,
    devices: over.devices ?? computers,
    // The relay main reports; the panel offers no way to change it.
    relayUrl: 'https://relay.example',
    registered: over.registered ?? true,
    signInAvailable: over.signInAvailable ?? true
  };
}

function renderPanel(result = remoteResult(), settings: Partial<AppSettings> = {}): void {
  invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'remote:get' ? result : {}));
  useStore.setState({ settings: { ...baseSettings, ...settings } as AppSettings });
  render(<><SettingsView /><ConfirmHost /></>);
  fireEvent.click(screen.getByText('MCP control'));
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

describe('Settings → MCP control', () => {
  it('groups the relay connection with external and local MCP control, and offers no browser access', async () => {
    renderPanel();
    await screen.findByText('Vocs relay connection');
    expect(screen.getAllByText('External MCP control').length).toBeGreaterThan(0);
    expect(screen.getByText(/MCP clients such as Dots and Muse can then reach it/)).toBeTruthy();
    // Nothing of the retired paired-browser access is left on the page.
    for (const gone of [/pair a browser/i, /view-only/i, /offline mirror/i, /QR code/, /Recent activity/, /enrollment secret/i]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(invokeMock.mock.calls.map(([channel]) => channel)).not.toContain('remote:pairStart');
  });

  it('is found by searching for MCP, Dots or the relay, and no longer for browser pairing', async () => {
    useStore.setState({ settings: { ...baseSettings } as AppSettings });
    invokeMock.mockImplementation(() => Promise.resolve(remoteResult()));
    render(<SettingsView />);
    const search = screen.getByLabelText('Search settings');
    for (const [query, topic] of [['dots', 'External MCP control'], ['relay', 'Vocs relay connection'], ['local cli', 'Local CLI & MCP discovery']] as const) {
      fireEvent.change(search, { target: { value: query } });
      expect(screen.getByRole('button', { name: new RegExp(topic) }).textContent).toContain('MCP control');
    }
    fireEvent.change(search, { target: { value: 'qr pair' } });
    expect(screen.getByRole('status').textContent).toMatch(/^0 results/);
  });

  it('lists the account computers and removes one by its device id', async () => {
    renderPanel();
    await screen.findByText('Your computers');
    expect(screen.getByText('Work PC')).toBeTruthy();
    expect(screen.getByText(/win32 x64 · connected now/)).toBeTruthy();
    fireEvent.click(screen.getAllByText('Remove')[1]);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:revoke', { deviceId: 'h_2' }));
  });

  it('tells the owner about browsers an earlier version paired, without listing them as computers', async () => {
    renderPanel(remoteResult({ devices: [computers[0], { deviceId: 'w_1', kind: 'web', name: 'Chrome', platform: 'web', lastSeen: Date.now() }] }));
    expect((await screen.findByTestId('remote-legacy-browsers')).textContent).toMatch(/A browser paired by an earlier version is still\s+on your account/);
    expect(screen.queryByText('Chrome')).toBeNull();
    expect(screen.getAllByText('Remove')).toHaveLength(1);
  });

  it('pulls the kill switch only after the confirmation dialog', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('remote-revoke-all'));
    await screen.findByText('Remove every other device?');
    expect(invokeMock).not.toHaveBeenCalledWith('remote:revokeAll', undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(screen.queryByText('Remove every other device?')).toBeNull());
    expect(invokeMock).not.toHaveBeenCalledWith('remote:revokeAll', undefined);

    fireEvent.click(screen.getByTestId('remote-revoke-all'));
    await screen.findByText('Remove every other device?');
    const confirm = screen.getAllByRole('button', { name: 'Remove all' }).find((b) => !b.hasAttribute('data-testid'))!;
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:revokeAll', undefined));
  });

  it('shares analytics with code.vocs.io by default, and turns it off through remote:setShareAnalytics', async () => {
    renderPanel();
    await screen.findByText('Analytics dashboard');
    const toggle = screen.getByLabelText('Share analytics with code.vocs.io') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(screen.getByText('Share analytics with code.vocs.io'));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:setShareAnalytics', { share: false }));
  });

  it('disconnects through remote:disable', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('remote-disconnect'));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:disable', undefined));
  });
});

describe('Connect with Vocs', () => {
  const offline = (over: { registered?: boolean; signInAvailable?: boolean } = {}) =>
    remoteResult({ enabled: false, state: { status: 'off', registered: over.registered ?? false }, devices: [], registered: over.registered ?? false, signInAvailable: over.signInAvailable });

  it('registers a new computer through Connect with Vocs', async () => {
    renderPanel(offline(), { remote: { enabled: false } });
    const signIn = await screen.findByTestId('remote-sign-in');
    await vi.waitFor(() => expect(signIn.textContent).toBe('Connect with Vocs'));
    expect(screen.queryByTestId('remote-disconnect')).toBeNull();
    fireEvent.click(signIn);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:signIn', undefined));
  });

  it('reconnects a registered computer with one click and no secret', async () => {
    renderPanel(offline({ registered: true }), { remote: { enabled: false } });
    const connect = await screen.findByTestId('remote-sign-in');
    await vi.waitFor(() => expect(connect.textContent).toBe('Connect'));
    fireEvent.click(connect);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:signIn', undefined));
  });

  it('cannot register a new computer on a relay without Vocs sign-in', async () => {
    renderPanel(offline({ signInAvailable: false }), { remote: { enabled: false } });
    const signIn = (await screen.findByTestId('remote-sign-in')) as HTMLButtonElement;
    await vi.waitFor(() => expect(signIn.disabled).toBe(true));
    expect(signIn.title).toMatch(/has no Vocs sign-in/);
  });

  it('shows the check code while the browser finishes, reopens the page, and cancels', async () => {
    const link = 'https://relay.example/dashboard?connect=' + 'ab'.repeat(32);
    renderPanel(remoteResult({ state: { status: 'connecting', registered: false, detail: 'finish in your browser', signIn: { link, checkCode: 'K7M2-XQ9P' } }, devices: [], registered: false }));
    expect((await screen.findByTestId('remote-sign-in-code')).textContent).toBe('K7M2-XQ9P');
    // No second sign-in is offered while one is in flight.
    expect(screen.queryByTestId('remote-sign-in')).toBeNull();
    fireEvent.click(screen.getByText('Open the page again'));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('app:openExternal', { url: link }));
    const cancel = screen.getByTestId('remote-disconnect');
    expect(cancel.textContent).toBe('Cancel');
    fireEvent.click(cancel);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:disable', undefined));
  });
});
