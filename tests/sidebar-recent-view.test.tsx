// The sidebar's Recent view: one list across every folder, most recent first, toggled from the
// Projects | Recent switch at the top of the sidebar and persisted through settings:update
// (settings.sidebarView).
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

// settings:update writes the patch back into the store, as the main process push would.
const invokeMock = vi.fn().mockImplementation((channel: string, args?: Partial<AppSettings>) => {
  const settings = useStore.getState().settings;
  if (channel === 'settings:update' && settings && args) useStore.setState({ settings: { ...settings, ...args } });
  return Promise.resolve({});
});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
};

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, SessionMeta } from '../src/shared/types';

afterEach(async () => {
  invokeMock.mockClear();
  await act(async () => { cleanup(); });
});

const baseSettings = {
  folders: ['G:/proj/empty'],
  folderStyles: { 'G:/proj/b': { color: '#f472b6', icon: 'rocket' } },
  folderOrder: ['G:/proj/a', 'G:/proj/b', 'G:/proj/empty'],
  collapsedFolders: ['G:/proj/b'],
  sidebarWidth: 280,
  panelWidth: 420
} as unknown as AppSettings;

const session = (root: string, id: string, lastUserMessageAt: number, over: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: `Session ${id}`,
  cwd: root,
  config: { projectRoot: root, harness: 'native' },
  status: 'idle',
  archived: false,
  pinned: false,
  createdAt: 1,
  updatedAt: 1000,
  lastUserMessageAt,
  usage: { costUsd: 0 },
  ...over
} as unknown as SessionMeta);

const sessions = [
  session('G:/proj/a', 'a-old', 100),
  session('G:/proj/b', 'b-new', 500),
  session('G:/proj/a', 'a-new', 400),
  session('G:/proj/b', 'b-mid', 300),
  session('G:/proj/a', 'a-gone', 900, { archived: true })
];

const rowIds = (container: HTMLElement) => [...container.querySelectorAll('[data-testid="session-row"]')].map((el) => el.getAttribute('data-session-id'));

function mount(list: SessionMeta[], view?: 'folders' | 'recent') {
  useStore.setState({ sessions: list, settings: { ...baseSettings, sidebarView: view } as AppSettings, activeId: null, view: 'chat' });
  return render(<Sidebar />);
}

describe('sidebar Recent view', () => {
  it('defaults to folder groups and switches to one recency-ordered list across folders, persisting the choice', async () => {
    const { container, getByTestId } = mount(sessions);
    // Folder view: grouped under headers; collapsed folder b hides its rows.
    expect([...container.querySelectorAll('.project-title')].map((el) => el.textContent)).toEqual(['a', 'b', 'empty']);
    expect(rowIds(container)).toEqual(['a-new', 'a-old']);
    expect(container.querySelector('[data-testid="session-folder"]')).toBeNull();

    // Each row omits the redundant "project |" prefix because folder headers (Projects) or the
    // coloured folder chip (Recent) already name the project.
    const rowLabel = (id: string) => [...container.querySelectorAll(`[data-session-id="${id}"] .session-label > span`)].map((el) => el.textContent);
    expect(rowLabel('a-new')).toEqual(['Native', 'Session a-new']);
    expect(container.querySelector('.sidebar-list .session-label-project')).toBeNull();
    expect(container.querySelector('.sidebar-list .session-label-separator')).toBeNull();

    expect(getByTestId('sidebar-folders').getAttribute('aria-pressed')).toBe('true');
    const toggle = getByTestId('sidebar-recent');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { fireEvent.click(toggle); });
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { sidebarView: 'recent' });

    // Recent view: no folder headers, every live row (collapsed folders too) by the user's last message.
    expect(container.querySelectorAll('.project-header')).toHaveLength(0);
    expect(rowIds(container)).toEqual(['b-new', 'a-new', 'b-mid', 'a-old']);
    expect(rowLabel('b-new')).toEqual(['Native', 'Session b-new']);
    expect(container.querySelector('.sidebar-list .session-label-project')).toBeNull();
    expect(container.querySelector('.sidebar-list .session-label-separator')).toBeNull();
    expect(getByTestId('sidebar-recent').getAttribute('aria-pressed')).toBe('true');
    expect(getByTestId('sidebar-recent').classList.contains('active')).toBe(true);
    expect(getByTestId('sidebar-folders').getAttribute('aria-pressed')).toBe('false');
    // Picking the layout already shown writes nothing.
    invokeMock.mockClear();
    await act(async () => { fireEvent.click(getByTestId('sidebar-recent')); });
    expect(invokeMock).not.toHaveBeenCalledWith('settings:update', expect.anything());

    // Each row names its folder, in the folder's own colour.
    const chip = container.querySelector('[data-session-id="b-new"] [data-testid="session-folder"]') as HTMLElement;
    expect(chip.textContent).toBe('b');
    expect(chip.title).toBe('G:/proj/b');
    expect(chip.style.color).toBe('rgb(244, 114, 182)');

    // Projects restores the grouped layout.
    await act(async () => { fireEvent.click(getByTestId('sidebar-folders')); });
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { sidebarView: 'folders' });
    expect(rowIds(container)).toEqual(['a-new', 'a-old']);
  });

  it('keeps pinned rows on top and lists archived rows by recency in the Archived view', async () => {
    const list = [...sessions, session('G:/proj/a', 'a-pin', 1, { pinned: true, pinnedAt: 5 }), session('G:/proj/b', 'b-gone', 800, { archived: true })];
    const { container, getByText } = mount(list, 'recent');
    expect(rowIds(container)).toEqual(['a-pin', 'b-new', 'a-new', 'b-mid', 'a-old']);
    await act(async () => { fireEvent.click(getByText('Archived')); });
    expect(rowIds(container)).toEqual(['a-gone', 'b-gone']);
  });

  it('puts the Projects | Recent switch and the Archived filter together at the top, apart from the nav links', () => {
    const { container, getByTestId } = mount(sessions);
    const sw = container.querySelector('.sidebar-viewswitch') as HTMLElement;
    expect(sw.contains(getByTestId('sidebar-folders'))).toBe(true);
    expect(sw.contains(getByTestId('sidebar-recent'))).toBe(true);
    // Archived sits beside the layout choice but outside it: it filters, it is not a third layout.
    expect(sw.contains(getByTestId('sidebar-archived'))).toBe(true);
    expect(getByTestId('sidebar-archived').closest('.segmented')).toBeNull();
    expect(container.querySelector('.sidebar-section button')).toBeNull();
    expect(sw.closest('.sidebar-views, .sidebar-section, .sidebar-bottom')).toBeNull();
    // Before the list it lays out, right after the New session entry.
    const order = [...(container.querySelector('.sidebar') as HTMLElement).children].map((el) => el.className.split(' ')[0]);
    expect(order.indexOf('sidebar-viewswitch')).toBe(order.indexOf('sidebar-nav') + 1);
    expect(order.indexOf('sidebar-viewswitch')).toBeLessThan(order.indexOf('sidebar-list'));
  });

  it('toggles Archived in place, keeps the layout choice, and shows it in the rail icon', async () => {
    const { container, getByTestId } = mount(sessions, 'recent');
    const railIcon = () => container.querySelector('.sidebar-viewswitch-icon')?.getAttribute('data-icon');
    const archived = getByTestId('sidebar-archived');
    expect(archived.getAttribute('aria-pressed')).toBe('false');
    expect(railIcon()).toBe('list');

    await act(async () => { fireEvent.click(archived); });
    expect(archived.getAttribute('aria-pressed')).toBe('true');
    expect(archived.textContent?.trim()).toBe('Archived');
    expect(container.querySelector('.sidebar-section-label')?.textContent).toBe('Archived sessions');
    expect(rowIds(container)).toEqual(['a-gone']);
    expect(railIcon()).toBe('archive');
    // Layout and filter are independent: the archived list still uses the Recent layout.
    expect(getByTestId('sidebar-recent').getAttribute('aria-pressed')).toBe('true');
    expect(invokeMock).not.toHaveBeenCalledWith('settings:update', expect.anything());

    await act(async () => { fireEvent.click(archived); });
    expect(archived.getAttribute('aria-pressed')).toBe('false');
    expect(rowIds(container)).toEqual(['b-new', 'a-new', 'b-mid', 'a-old']);
    expect(railIcon()).toBe('list');
  });
});
