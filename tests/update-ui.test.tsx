// In-app auto-update UI (issue #198): the title-bar pill and the Settings → About updates panel.
// The pill appears only when there is something to act on, and its click drives the update along;
// the About panel offers the manual check and the restart-to-update action.
/** @vitest-environment jsdom */
const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('update pill (title bar)', () => {
  it('stays hidden while idle, checking, up-to-date or errored', () => {
    for (const status of ['idle', 'checking', 'up-to-date', 'error'] as const) {
      setUpdateState({ status });
      const { container } = render(<TitleBar />);
      expect(container.querySelector('.update-pill')).toBeNull();
      cleanup();
    }
  });

  it('offers the download for an available update and invokes update:download on click', () => {
    setUpdateState({ status: 'available', version: '0.3.0' });
    const { container } = render(<TitleBar />);
    const pill = container.querySelector('.update-pill') as HTMLButtonElement;
    expect(pill.textContent).toContain('0.3.0');
    fireEvent.click(pill);
    expect(invokeMock).toHaveBeenCalledWith('update:download', undefined);
  });

  it('shows download progress and the deferred restart prompt', () => {
    setUpdateState({ status: 'downloading', version: '0.3.0', progress: { percent: 42.4, bytesPerSecond: 0, transferred: 0, total: 0 } });
    const { container } = render(<TitleBar />);
    expect((container.querySelector('.update-pill') as HTMLButtonElement).textContent).toContain('42%');
    cleanup();

    setUpdateState({ status: 'restart-pending', version: '0.3.0', deferred: true });
    const second = render(<TitleBar />);
    expect((second.container.querySelector('.update-pill') as HTMLButtonElement).textContent).toContain('0.3.0');
    // A deferred prompt still installs on an explicit click.
    fireEvent.click(second.container.querySelector('.update-pill') as HTMLButtonElement);
    expect(invokeMock).toHaveBeenCalledWith('update:install', undefined);
  });

  it('offers restart-to-install once the app is quiet again', () => {
    setUpdateState({ status: 'restart-pending', version: '0.3.0' });
    const { container } = render(<TitleBar />);
    const pill = container.querySelector('.update-pill') as HTMLButtonElement;
    expect(pill.textContent).toBe('Restart to update');
    fireEvent.click(pill);
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
