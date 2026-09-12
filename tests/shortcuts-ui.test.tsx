// Custom shortcuts end to end: the Settings → Shortcuts page add/remove flows and the
// command runner that turns a bound accelerator into store/IPC calls.
/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};
(window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined });

vi.mock('../src/renderer/src/terminal/host', () => ({ createTerminal: vi.fn().mockResolvedValue(null) }));

import { fireEvent, render } from '@testing-library/react';
import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { runShortcutCommand } from '../src/renderer/src/shortcuts';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const settings = {
  theme: 'system',
  defaultHarness: 'claude',
  defaultPermissionMode: 'ask',
  notifications: true,
  goalDefaults: { autoContinue: true, maxIterations: 25 },
  binaries: {},
  providers: [],
  acpAgents: [],
  recentProjects: [],
  customShortcuts: {}
} as unknown as AppSettings;

const session = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: id,
  createdAt: 1_000,
  updatedAt: 1_000,
  config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as SessionMeta['config'],
  cwd: 'G:/proj/a',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
  ...patch
});

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invokeMock.mockClear();
  useStore.setState({ sessions: [], activeId: null, view: 'chat', sidebarOpen: true, settings: { ...settings, customShortcuts: {} } as AppSettings });
});

describe('runShortcutCommand', () => {
  it('forks the active session and activates the fork', async () => {
    useStore.setState({ sessions: [session('s1')], activeId: 's1' });
    invokeMock.mockResolvedValueOnce(session('s2', { title: 'A (fork)' }));
    runShortcutCommand('session.fork');
    await tick();
    expect(invokeMock).toHaveBeenCalledWith('sessions:fork', { id: 's1' });
    expect(useStore.getState().activeId).toBe('s2');
    expect(useStore.getState().view).toBe('chat');
  });

  it('archives the active session like the sidebar row does', () => {
    useStore.setState({ sessions: [session('s1')], activeId: 's1' });
    runShortcutCommand('session.archive');
    expect(invokeMock).toHaveBeenCalledWith('sessions:archive', { id: 's1', archived: true });
  });

  it('pins and interrupts the active session', () => {
    useStore.setState({ sessions: [session('s1')], activeId: 's1' });
    runShortcutCommand('session.pin');
    expect(invokeMock).toHaveBeenCalledWith('sessions:pin', { id: 's1', pinned: true });
    runShortcutCommand('session.interrupt');
    expect(invokeMock).toHaveBeenCalledWith('sessions:interrupt', { id: 's1' });
  });

  it('skips session commands when no session is active', () => {
    useStore.setState({ sessions: [session('s1')], activeId: null });
    runShortcutCommand('session.archive');
    runShortcutCommand('session.fork');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('dispatches app-level commands to the store', async () => {
    runShortcutCommand('app.toggleSidebar');
    expect(useStore.getState().sidebarOpen).toBe(false);
    runShortcutCommand('app.togglePanel');
    expect(useStore.getState().panelOpen).toBe(false);
    runShortcutCommand('app.newSessionQuick');
    expect(useStore.getState().quickSessionOpen).toBe(true);
    invokeMock.mockResolvedValueOnce({ path: null });
    runShortcutCommand('app.newSession');
    await tick();
    expect(invokeMock).toHaveBeenCalledWith('app:pickFolder', { defaultPath: undefined });
  });
});

describe('settings shortcuts page', () => {
  const openSection = () => {
    render(<SettingsView />);
    const nav = [...document.querySelectorAll('.settings-link')].find((b) => b.textContent?.includes('Shortcuts')) as HTMLElement;
    fireEvent.click(nav);
  };

  it('captures a combo and saves the binding', () => {
    openSection();
    const capture = document.querySelector('.shortcut-capture') as HTMLInputElement;
    fireEvent.keyDown(capture, { ctrlKey: true, altKey: true, code: 'KeyA' });
    expect(capture.value).toBe('Ctrl+Alt+A');
    fireEvent.click([...document.querySelectorAll('.shortcut-add .btn')].find((b) => b.textContent === 'Add') as HTMLElement);
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { customShortcuts: { 'Ctrl+Alt+A': 'session.archive' } });
  });

  it('blocks reserved combinations and says so', () => {
    openSection();
    const capture = document.querySelector('.shortcut-capture') as HTMLInputElement;
    fireEvent.keyDown(capture, { ctrlKey: true, code: 'KeyN' });
    expect(capture.value).toBe('Ctrl+N');
    expect(document.querySelector('.shortcut-warn')?.textContent).toContain('reserved by a built-in shortcut');
    const add = [...document.querySelectorAll('.shortcut-add .btn')].find((b) => b.textContent === 'Add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });

  it('lists existing bindings and removes one', () => {
    useStore.setState({ settings: { ...settings, customShortcuts: { 'Ctrl+Alt+F': 'session.fork' } } as AppSettings });
    openSection();
    expect(document.querySelectorAll('.shortcut-row')).toHaveLength(1);
    expect(document.querySelector('.shortcut-row')?.textContent).toContain('Fork session');
    fireEvent.click(document.querySelector('[title="Remove shortcut"]') as HTMLElement);
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { customShortcuts: {} });
  });

  it('moving a binding to a new combo announces the move', () => {
    useStore.setState({ settings: { ...settings, customShortcuts: { 'Ctrl+Alt+A': 'session.archive' } } as AppSettings });
    openSection();
    const capture = document.querySelector('.shortcut-capture') as HTMLInputElement;
    // Same command, new combo: the old binding moves.
    fireEvent.keyDown(capture, { ctrlKey: true, altKey: true, code: 'KeyR' });
    expect(document.body.textContent).toContain('Moves the binding for Archive session from Ctrl+Alt+A');
  });
});
