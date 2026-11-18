// The sidebar update button handles download progress and restart. The About panel offers a manual check.
/** @vitest-environment jsdom */
const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { TitleBar } from '../src/renderer/src/components/TitleBar';
import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, UpdateState } from '../src/shared/types';

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

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});

function setUpdateState(updateState: UpdateState, isPackaged = true): void {
  invokeMock.mockReset();
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'app:info') return Promise.resolve({ version: '0.2.0', platform: 'win32', userData: 'C:/u', isPackaged });
    if (channel === 'app:doctor') return Promise.resolve({ electron: '44', node: '22', platform: 'win32', harnesses: {}, providers: [] } as never);
    return Promise.resolve({});
  });
  act(() => {
    useStore.setState({ updateState, settings: { ...baseSettings } as AppSettings });
  });
}

describe('update button beside Settings', () => {
  it('stays hidden while idle, checking, up-to-date or errored', () => {
    for (const status of ['idle', 'checking', 'up-to-date', 'error'] as const) {
      setUpdateState({ status });
      const { container } = render(<Sidebar />);
      expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
      expect(container.querySelector('.update-pill')).toBeNull();
      cleanup();
    }
  });

  it('offers one Update button directly beside Settings and starts the download on click', () => {
    setUpdateState({ status: 'available', version: '0.3.0' });
    const { container } = render(<><TitleBar /><Sidebar /></>);
    const settings = screen.getByRole('button', { name: 'Settings' });
    const update = screen.getByRole('button', { name: /^Update\b/ });
    expect(settings.nextElementSibling).toBe(update);
    expect(update.textContent).toBe('Update');
    expect(update.title).toContain('0.3.0');
    expect(container.querySelectorAll('.update-pill')).toHaveLength(1);
    fireEvent.click(update);
    expect(invokeMock).toHaveBeenCalledWith('update:download', undefined);
  });

  it('shows download progress and the deferred restart prompt', () => {
    setUpdateState({ status: 'downloading', version: '0.3.0', progress: { percent: 42.4, bytesPerSecond: 0, transferred: 0, total: 0 } });
    render(<Sidebar />);
    const progress = screen.getByRole<HTMLButtonElement>('button', { name: 'Updating… 42%' });
    expect(progress.disabled).toBe(true);
    cleanup();

    setUpdateState({ status: 'restart-pending', version: '0.3.0', deferred: true });
    render(<Sidebar />);
    // A deferred prompt still installs on an explicit click.
    fireEvent.click(screen.getByRole('button', { name: 'Update ready' }));
    expect(invokeMock).toHaveBeenCalledWith('update:install', undefined);
  });

  it('offers restart-to-install once the app is quiet again', () => {
    setUpdateState({ status: 'restart-pending', version: '0.3.0' });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Install update' }));
    expect(invokeMock).toHaveBeenCalledWith('update:install', undefined);
  });
});

describe('updates panel (Settings → About)', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
    });
  });

  function renderAbout(): HTMLElement {
    const view = render(<SettingsView />);
    fireEvent.click(screen.getByText('About & doctor'));
    return view.container;
  }

  it('shows the manual check for an idle update state and invokes update:check', async () => {
    setUpdateState({ status: 'idle' });
    const container = renderAbout();
    const check = await screen.findByText('Check for updates');
    expect(container.textContent).toContain('0.2.0');
    fireEvent.click(check);
    expect(invokeMock).toHaveBeenCalledWith('update:check', undefined);
    cleanup();
    // No panel, no button: unpackaged builds never check.
    invokeMock.mockReset();
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'app:info') return Promise.resolve({ version: '0.2.0', platform: 'win32', userData: 'C:/u', isPackaged: false });
      if (channel === 'app:doctor') return Promise.resolve({ electron: '44', node: '22', platform: 'win32', harnesses: {}, providers: [] } as never);
      return Promise.resolve({});
    });
    const dev = render(<SettingsView />);
    fireEvent.click(screen.getByText('About & doctor'));
    await screen.findByText(/0\.2\.0 · Electron/);
    expect(dev.container.querySelector('.settings-updates')).toBeNull();
    cleanup();
  });

  it('describes the deferred restart state and drives update:install from the About panel', async () => {
    setUpdateState({ status: 'restart-pending', version: '0.3.0', deferred: true });
    renderAbout();
    expect(await screen.findByText(/is ready/)).toBeTruthy();
    fireEvent.click(screen.getByText('Restart to update'));
    expect(invokeMock).toHaveBeenCalledWith('update:install', undefined);
    cleanup();
  });

  it('reports a failed update with its error', async () => {
    setUpdateState({ status: 'error', error: 'feed offline' });
    renderAbout();
    expect(await screen.findByText(/feed offline/)).toBeTruthy();
  });
});
