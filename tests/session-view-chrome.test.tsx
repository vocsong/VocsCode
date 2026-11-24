// The session view's ways in: the title bar names where you are and opens the command palette,
// Vesta minimizes into the title bar, the sidebar leads with New session and the app's other
// views with Settings at the foot, and the welcome screen is a clean start.
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { TitleBar } from '../src/renderer/src/components/TitleBar';
import { Welcome } from '../src/renderer/src/components/Welcome';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const settings = {
  folders: ['G:/proj/a'],
  folderStyles: {},
  sidebarWidth: 280,
  panelWidth: 420,
  onboardingDone: true,
  agent: { enabled: true, collapsed: true }
} as unknown as AppSettings;

const session = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: `Session ${id}`,
  createdAt: 1_000,
  updatedAt: 1_000,
  config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as SessionMeta['config'],
  cwd: 'G:/proj/a',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
  ...patch
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  useStore.setState({ settings, sessions: [], activeId: null, view: 'chat', paletteOpen: false, quickSessionOpen: false });
});

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});

describe('title bar', () => {
  it('names the open session with its harness and project and opens the command palette', () => {
    useStore.setState({ sessions: [session('s1', { title: 'Add rate limiting', cwd: 'G:/worktrees/limit' })], activeId: 's1' });
    const { container } = render(<TitleBar />);
    const search = container.querySelector('.titlebar-search') as HTMLElement;
    expect(search.querySelector('.harness-pill[data-harness="native"]')?.textContent).toBe('Native');
    expect(search.querySelector('.titlebar-search-text')?.textContent).toBe('Native a | Add rate limiting');
    expect(search.title).toMatch(/^Native a \| Add rate limiting · Vocs Code/);
    expect(search.textContent).toContain('Ctrl+K');
    fireEvent.click(search);
    expect(useStore.getState().paletteOpen).toBe(true);
  });

  it('offers search when no session is open', () => {
    const { container } = render(<TitleBar />);
    expect(container.querySelector('.titlebar-search-text')?.textContent).toBe('Search sessions and commands');
  });

  it('holds Vesta’s launcher, and none once Vesta is switched off', () => {
    const { unmount } = render(<TitleBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Vesta' }));
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { agent: { enabled: true, collapsed: false } });
    unmount();
    useStore.setState({ settings: { ...settings, agent: { enabled: false } } as AppSettings });
    render(<TitleBar />);
    expect(screen.queryByRole('button', { name: 'Open Vesta' })).toBeNull();
  });
});

describe('sidebar navigation', () => {
  it('ends the list switch row with a New session icon, which opens the Ctrl+Shift+N dialog on the open session’s folder', async () => {
    useStore.setState({ sessions: [session('s1')], activeId: 's1', newSessionOpen: false, newSessionRoot: null });
    const { container } = render(<Sidebar />);
    const button = screen.getByRole('button', { name: 'New session' });
    // One compact row: the icon is the last control beside Projects | Recent and Archived, not a row of its own.
    const row = container.querySelector('.sidebar-viewswitch') as HTMLElement;
    expect(row.lastElementChild).toBe(button);
    expect(button.textContent?.trim()).toBe('');
    expect(button.title).toBe('New session in this folder (Ctrl+Shift+N)');
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+N');
    expect(container.querySelectorAll('.sidebar-nav .sidebar-new')).toHaveLength(0);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(useStore.getState()).toMatchObject({ newSessionOpen: true, newSessionRoot: 'G:/proj/a', quickSessionOpen: false });
    expect(invokeMock).not.toHaveBeenCalledWith('app:pickFolder', expect.anything());
  });

  it('asks for a folder first when no session is open, like Ctrl+Shift+N', async () => {
    invokeMock.mockImplementation(async (channel: string) => (channel === 'app:pickFolder' ? { path: 'G:/proj/b' } : {}));
    useStore.setState({ settings: { ...settings, recentProjects: ['G:/proj/a'] } as AppSettings, newSessionOpen: false, newSessionRoot: null });
    const { container } = render(<Sidebar />);
    await act(async () => {
      fireEvent.click(container.querySelector('.sidebar-new') as HTMLElement);
    });
    expect(invokeMock).toHaveBeenCalledWith('app:pickFolder', expect.anything());
    expect(useStore.getState()).toMatchObject({ newSessionOpen: true, newSessionRoot: 'G:/proj/b', quickSessionOpen: false });
  });

  it('keeps the views at the top, the Archived toggle beside the list layout switch and Settings at the foot', () => {
    const { container } = render(<Sidebar />);
    const labels = (selector: string) => [...container.querySelectorAll(selector)].map((el) => el.textContent?.trim());
    expect(labels('.sidebar-views .sidebar-link')).toEqual(['Analytics', 'Skills', 'MCP']);
    expect(labels('.sidebar-bottom .sidebar-link')).toEqual(['Settings']);
    expect(container.querySelector('.sidebar-section-label')?.textContent).toBe('Sessions');
    const archived = screen.getByRole('button', { name: 'Archived' });
    expect(archived.closest('.sidebar-viewswitch')).not.toBeNull();
    fireEvent.click(archived);
    expect(container.querySelector('.sidebar-section-label')?.textContent).toBe('Archived sessions');
    // A pressed toggle, not a relabelled link: pressing it again returns to active sessions.
    expect(screen.getByRole('button', { name: 'Archived', pressed: true })).toBe(archived);
    fireEvent.click(archived);
    expect(container.querySelector('.sidebar-section-label')?.textContent).toBe('Sessions');
    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }));
    expect(useStore.getState().view).toBe('analytics');
  });
});

describe('welcome screen', () => {
  it('starts a session or opens Settings, and lists the keys worth knowing', () => {
    const startNewSession = vi.fn().mockResolvedValue(undefined);
    useStore.setState({ startNewSession } as never);
    const { container } = render(<Welcome />);
    expect(container.querySelector('.welcome-title')?.textContent).toBe('Welcome to Vocs Code');
    expect([...container.querySelectorAll('.welcome-key .kbd')].map((k) => k.textContent)).toEqual(['Ctrl+N', 'Ctrl+Alt+N', 'Ctrl+K', 'Ctrl+Shift+F', 'Ctrl+1…9', 'Ctrl+J']);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(startNewSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Setup guide' }));
    expect(useStore.getState()).toMatchObject({ onboardingOpen: true, onboardingHarness: null });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useStore.getState().view).toBe('settings');
  });
});
