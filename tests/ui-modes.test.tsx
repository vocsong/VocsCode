// The interface modes (Settings → Appearance → Interface): Standard and the two minimalist layouts,
// Zen and Paper. The layouts themselves are CSS keyed on <html data-ui>, driven end to end by
// tests/e2e.ui-modes.test.ts, and the stored setting is covered by tests/ui-modes-settings.test.ts;
// this covers the renderer side: applying a mode, the picker, the one-button menu, the palette
// commands and the hooks the CSS reads.
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn((channel: string, _payload?: unknown) => Promise.resolve(channel === 'providers:list' ? [] : {}));
(window as unknown as { harness: unknown }).harness = { platform: 'win32', invoke: invokeMock, on: vi.fn(() => () => undefined) };
window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
vi.mock('../src/renderer/src/terminal/host', () => ({ createTerminal: vi.fn().mockResolvedValue(null) }));

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CommandPalette } from '../src/renderer/src/components/CommandPalette';
import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { TitleBar } from '../src/renderer/src/components/TitleBar';
import { WorkGroup } from '../src/renderer/src/components/Transcript';
import { useStore } from '../src/renderer/src/store';
import { activeUiMode, applyUiMode } from '../src/renderer/src/theme';
import { isMinimalUiMode, UI_MODES } from '../src/shared/ui-modes';
import type { AppSettings, SessionMeta, TranscriptItem } from '../src/shared/types';

const base = {
  theme: 'dark', defaultHarness: 'native', defaultPermissionMode: 'ask', notifications: true,
  goalDefaults: { autoContinue: false, maxIterations: 25 }, binaries: {}, providers: [], acpAgents: [],
  recentProjects: [], customShortcuts: {}, customBranchPrefixes: [], folders: ['G:/proj/a'], folderStyles: {},
  sidebarWidth: 280, panelWidth: 420, onboardingDone: true, agent: { enabled: true, collapsed: true }
} as unknown as AppSettings;
const withMode = (uiMode?: AppSettings['uiMode']) => ({ ...base, ...(uiMode ? { uiMode } : {}) }) as AppSettings;

const session = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: `Session ${id}`,
  createdAt: 1_000,
  updatedAt: 1_000,
  config: { harness: 'claude', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as SessionMeta['config'],
  cwd: 'G:/proj/a',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
  ...patch
});

const updates = () => invokeMock.mock.calls.filter(([channel]) => channel === 'settings:update').map(([, patch]) => patch as unknown);

beforeEach(() => {
  invokeMock.mockClear();
  useStore.setState({ settings: withMode(), sessions: [], activeId: null, view: 'chat', paletteOpen: false });
});
afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  document.documentElement.removeAttribute('data-ui');
});

describe('interface mode setting', () => {
  it('catalogues Standard first and two distinct minimalist modes', () => {
    expect(UI_MODES.map((m) => m.id)).toEqual(['standard', 'zen', 'paper']);
    expect(new Set(UI_MODES.map((m) => m.name)).size).toBe(3);
    expect(UI_MODES.filter((m) => isMinimalUiMode(m.id)).map((m) => m.id)).toEqual(['zen', 'paper']);
  });

  it('applies a mode as one attribute on <html>, falling back to Standard', () => {
    applyUiMode('zen');
    expect(document.documentElement.getAttribute('data-ui')).toBe('zen');
    expect(activeUiMode()).toBe('zen');
    applyUiMode('paper');
    expect(activeUiMode()).toBe('paper');
    applyUiMode(undefined);
    expect(document.documentElement.getAttribute('data-ui')).toBe('standard');
    applyUiMode('bogus' as never);
    expect(activeUiMode()).toBe('standard');
  });
});

describe('Appearance → Interface picker', () => {
  const openAppearance = () => {
    useStore.setState({ view: 'settings' });
    render(<SettingsView />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Appearance' }));
    return within(screen.getByRole('group', { name: 'Interface' }));
  };

  it('offers the three layouts apart from the color theme, with the current one pressed', () => {
    useStore.setState({ settings: withMode('zen') });
    const picker = openAppearance();
    const cards = picker.getAllByRole('button');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Standard interface', 'Zen interface', 'Paper interface']);
    expect(cards.map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    // The theme picker is still its own group: choosing a layout never offers a palette, nor the reverse.
    expect(within(screen.getByRole('region', { name: 'Color theme' })).queryByRole('button', { name: 'Zen interface' })).toBeNull();
    expect(picker.queryByRole('button', { name: 'Dark' })).toBeNull();
  });

  it('saves the picked layout and nothing else', () => {
    const picker = openAppearance();
    expect(picker.getByRole('button', { name: 'Standard interface' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(picker.getByRole('button', { name: 'Paper interface' }));
    expect(updates()).toEqual([{ uiMode: 'paper' }]);
  });

  it('is found by searching for what it does', () => {
    useStore.setState({ view: 'settings' });
    render(<SettingsView />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'minimal' } });
    fireEvent.click(screen.getByRole('button', { name: /Interface/ }));
    expect(screen.getByRole('group', { name: 'Interface' })).toBeTruthy();
  });

  it('names its sections in tooltips once the nav shows icons only', () => {
    useStore.setState({ view: 'settings', settings: withMode('paper') });
    render(<SettingsView />);
    const nav = within(screen.getByRole('navigation', { name: 'Settings sections' }));
    expect(nav.getByRole('button', { name: 'Appearance' }).getAttribute('title')).toBe('Appearance');
  });
});

describe('title bar menu', () => {
  it('spells out File, Edit, View and Help in Standard', () => {
    render(<TitleBar />);
    for (const name of ['File', 'Edit', 'View', 'Help']) expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
  });

  it('folds them into one Menu button in the minimalist modes, every menu still reachable', () => {
    useStore.setState({ settings: withMode('zen') });
    render(<TitleBar />);
    expect(screen.queryByRole('button', { name: 'File' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const tabs = screen.getByRole('tablist', { name: 'Menus' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual(['File', 'Edit', 'View', 'Help']);
    expect(screen.getByRole('button', { name: /New session/ })).toBeTruthy();
    fireEvent.mouseEnter(within(tabs).getByRole('tab', { name: 'Help' }));
    expect(screen.getByRole('button', { name: 'About Vocs Code' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New session/ })).toBeNull();
  });

  it('switches the interface from View, marking the current one', () => {
    useStore.setState({ settings: withMode('zen') });
    render(<TitleBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(screen.getByRole('tab', { name: 'View' }));
    expect(screen.getByRole('button', { name: 'Zen interface' }).className).toContain('active');
    expect(screen.getByRole('button', { name: 'Standard interface' }).className).not.toContain('active');
    fireEvent.click(screen.getByRole('button', { name: 'Standard interface' }));
    expect(updates()).toEqual([{ uiMode: 'standard' }]);
    // Picking an item closes the menu, the way every other View item does.
    expect(screen.queryByRole('tablist', { name: 'Menus' })).toBeNull();
  });
});

describe('command palette', () => {
  it('offers the other two interfaces and switches to the one picked', () => {
    useStore.setState({ settings: withMode('paper'), paletteOpen: true });
    render(<CommandPalette />);
    expect(screen.queryByRole('button', { name: /Switch to the Paper interface/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Switch to the Standard interface/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Switch to the Zen interface/ }));
    expect(updates()).toEqual([{ uiMode: 'zen' }]);
    expect(useStore.getState().paletteOpen).toBe(false);
  });
});

describe('markup the minimalist layouts read', () => {
  it('tags each session row with its status, harness tone and pin, and names it on hover only when the title is cut', () => {
    const sessions = [session('s1', { title: 'Add rate limiting', status: 'awaiting', pinned: true }), session('s2', { title: 'Fix flaky test', config: { harness: 'codex', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as SessionMeta['config'] })];
    useStore.setState({ sessions, activeId: 's1' });
    const { container, unmount } = render(<Sidebar />);
    const row = (id: string) => container.querySelector(`[data-session-id="${id}"]`) as HTMLElement;
    expect(row('s1').dataset).toMatchObject({ status: 'awaiting', tone: 'amber', pinned: '' });
    expect(row('s2').dataset.tone).toBe('green');
    expect(row('s2').hasAttribute('data-pinned')).toBe(false);
    expect(row('s1').getAttribute('title')).toBeNull();
    unmount();
    useStore.setState({ settings: withMode('paper') });
    const paper = render(<Sidebar />);
    expect((paper.container.querySelector('[data-session-id="s1"]') as HTMLElement).getAttribute('title')).toBe('Add rate limiting');
    expect(paper.getByRole('button', { name: 'Analytics' }).getAttribute('title')).toBe('Analytics');
  });

  it('opens Paper’s switcher on the session you are in, and leaves the list’s scroll alone elsewhere', () => {
    const scrolled: string[] = [];
    const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) { scrolled.push((this as HTMLElement).dataset.sessionId ?? ''); };
    try {
      useStore.setState({ sessions: [session('s1'), session('s2')], activeId: 's2' });
      const { unmount } = render(<Sidebar />);
      expect(scrolled).toEqual([]);
      unmount();
      useStore.setState({ settings: withMode('paper') });
      render(<Sidebar />);
      expect(scrolled).toEqual(['s2']);
    } finally {
      proto.scrollIntoView = original;
    }
  });

  it('carries the work chip’s facts without words, for Zen and Paper to show', () => {
    let seq = 0;
    const tool = (over: Partial<Extract<TranscriptItem, { kind: 'tool' }>> = {}): TranscriptItem => ({ id: `t${++seq}`, kind: 'tool', ts: 0, name: 'Edit', hint: 'edit', status: 'done', ...over });
    const entries = [tool({ changes: [{ path: 'src/a.ts', kind: 'update' }] }), tool({ changes: [{ path: 'src/b.ts', kind: 'add' }] }), tool({ name: 'bash', hint: 'execute' })];
    const { container } = render(<WorkGroup chunk={{ kind: 'work', id: 't1', entries, turn: { status: 'completed', durationMs: 154_000 } }} sessionId="s" showThinking={false} onImageExpand={() => undefined} />);
    const short = [...container.querySelectorAll('.work-head [data-short]')].map((el) => [el.textContent, el.getAttribute('data-short')]);
    expect(short).toEqual([['Worked for 2m 34s', '2m 34s'], ['3 steps', '3'], ['2 files changed', '±2']]);
  });
});

describe('Paper’s session switcher', () => {
  it('replaces the sidebar toggle with the title, which drops and closes the switcher', () => {
    useStore.setState({ settings: withMode('paper'), sessions: [session('s1', { title: 'Add rate limiting' })], activeId: 's1', switcherOpen: false });
    const { unmount } = render(<TitleBar />);
    expect(screen.queryByRole('button', { name: /sidebar/ })).toBeNull();
    const title = screen.getByRole('button', { name: /Add rate limiting/ });
    expect(title.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(title);
    expect(useStore.getState().switcherOpen).toBe(true);
    expect(title.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(title);
    expect(useStore.getState().switcherOpen).toBe(false);
    unmount();
    // Standard keeps both: the sidebar toggle, and a title that opens the command palette.
    useStore.setState({ settings: withMode('standard') });
    render(<TitleBar />);
    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add rate limiting/ }));
    expect(useStore.getState()).toMatchObject({ paletteOpen: true, switcherOpen: false });
  });

  it('closes when a session or a view is chosen, or a dialog opens over it, without touching the sidebar setting', async () => {
    useStore.setState({ settings: withMode('paper'), sessions: [session('s1'), session('s2')], activeId: 's1', sidebarOpen: true, switcherOpen: true });
    await act(async () => { await useStore.getState().setActive('s2'); });
    expect(useStore.getState()).toMatchObject({ activeId: 's2', switcherOpen: false, sidebarOpen: true });
    for (const open of [
      () => useStore.getState().setView('analytics'),
      () => useStore.getState().openPalette(true),
      () => useStore.getState().openSearch(true),
      () => useStore.getState().openQuickSession(true)
    ]) {
      useStore.setState({ switcherOpen: true });
      open();
      expect(useStore.getState().switcherOpen).toBe(false);
    }
    expect(useStore.getState().sidebarOpen).toBe(true);
  });

  it('turns View → Sidebar and the palette’s sidebar command into ways to open the switcher', () => {
    useStore.setState({ settings: withMode('paper'), sessions: [session('s1')], activeId: 's1', switcherOpen: false, sidebarOpen: true });
    const { unmount } = render(<TitleBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(screen.getByRole('tab', { name: 'View' }));
    expect(screen.queryByRole('button', { name: /^Sidebar/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Sessions/ }));
    expect(useStore.getState()).toMatchObject({ switcherOpen: true, sidebarOpen: true });
    unmount();
    useStore.setState({ switcherOpen: false, paletteOpen: true });
    render(<CommandPalette />);
    expect(screen.queryByRole('button', { name: /Toggle left sidebar/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show sessions/ }));
    expect(useStore.getState()).toMatchObject({ switcherOpen: true, sidebarOpen: true, paletteOpen: false });
  });

  it('shows what is running, waiting or finished elsewhere by the title, and nothing when all is quiet', () => {
    useStore.setState({ settings: withMode('paper'), sessions: [session('s1')], activeId: 's1' });
    const { container, unmount } = render(<TitleBar />);
    expect(container.querySelector('.titlebar-activity')).toBeNull();
    unmount();
    useStore.setState({ sessions: [session('s1', { status: 'running' }), session('s2', { status: 'awaiting' }), session('s3', { status: 'awaiting' })] });
    render(<TitleBar />);
    const trigger = screen.getByRole('button', { name: /Session activity/ });
    expect(trigger.getAttribute('aria-label')).toBe('Session activity: 1 running, 2 awaiting approval');
    expect([...trigger.querySelectorAll('.activity-count')].map((el) => [el.className.replace('activity-count ', ''), el.textContent])).toEqual([['activity-running', '1'], ['activity-awaiting', '2']]);
  });
});
