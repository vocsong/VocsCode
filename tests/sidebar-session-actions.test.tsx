// Sidebar session rows: three inline actions (pin / fork / archive), archived rows get restore /
// delete only, pinned rows sort first-pin-on-top and accept drag reorder.
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
};

import { fireEvent, render } from '@testing-library/react';
import { Sidebar, sortSessionRows } from '../src/renderer/src/components/Sidebar';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const settings = {
  folders: ['G:/proj/a'],
  folderStyles: {},
  sidebarWidth: 280,
  panelWidth: 420
} as unknown as AppSettings;

const session = (id: string, patch: Partial<SessionMeta>): SessionMeta => ({
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

describe('sidebar session actions', () => {
  it('shows pin/fork/archive actions and no 3-dot menu on an active row', () => {
    useStore.setState({ sessions: [session('s_a', { title: 'A' })], settings, activeId: null, view: 'chat' });
    const { container } = render(<Sidebar />);
    const row = container.querySelector('.session-row') as HTMLElement;
    expect(row.querySelector('.row-menu-btn')).toBeNull();
    const btns = row.querySelectorAll('.row-act-btn');
    expect(btns).toHaveLength(3);
    expect((btns[0] as HTMLElement).title).toBe('Pin to top');
    expect((btns[2] as HTMLElement).title).toBe('Archive');
    fireEvent.click(btns[0]);
    expect(invokeMock).toHaveBeenCalledWith('sessions:pin', { id: 's_a', pinned: true });
  });

  it('pinned rows offer unpin and are draggable', () => {
    useStore.setState({ sessions: [session('s_a', { title: 'A', pinned: true, pinnedAt: 5 })], settings, activeId: null, view: 'chat' });
    const { container } = render(<Sidebar />);
    const row = container.querySelector('.session-row') as HTMLElement;
    expect(row.getAttribute('draggable')).toBe('true');
    const pin = row.querySelector('.row-act-btn') as HTMLElement;
    expect(pin.title).toBe('Unpin');
    expect(pin.className).toContain('is-pinned');
    fireEvent.click(pin);
    expect(invokeMock).toHaveBeenCalledWith('sessions:pin', { id: 's_a', pinned: false });
  });

  it('fork action opens a harness menu and forks into the picked harness', () => {
    useStore.setState({ sessions: [session('s_a', { title: 'A' })], settings, activeId: null, view: 'chat' });
    const { container } = render(<Sidebar />);
    const forkBtn = [...container.querySelectorAll('.row-act-btn')].find((b) => b.getAttribute('aria-label') === 'Fork session') as HTMLElement;
    fireEvent.click(forkBtn);
    const items = [...document.querySelectorAll('.dropdown-menu .menu-item')];
    const labels = items.map((i) => i.textContent ?? '');
    // The session's own harness is offered first, then every other harness.
    expect(labels[0]).toContain('Fork into');
    expect(labels.some((l) => l.includes('Native'))).toBe(true);
    expect(labels.some((l) => l.includes('Claude'))).toBe(true);
    const claude = items.find((i) => (i.textContent ?? '').includes('Claude')) as HTMLElement;
    invokeMock.mockResolvedValueOnce(session('s_f', { config: { harness: 'claude', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as SessionMeta['config'] }));
    fireEvent.click(claude);
    expect(invokeMock).toHaveBeenCalledWith('sessions:fork', { id: 's_a', harness: 'claude' });
  });

  it('archived rows show only restore and delete', () => {
    useStore.setState({ sessions: [session('s_a', { title: 'A', archived: true, worktreeBranch: 'agent/a' })], settings, activeId: null, view: 'chat' });
    const { container } = render(<Sidebar />);
    // Archived sessions only appear once the Archived toggle is on.
    const archived = [...container.querySelectorAll('.sidebar-link')].find((b) => (b.textContent ?? '').includes('Archived')) as HTMLElement;
    fireEvent.click(archived);
    const row = container.querySelector('.session-row') as HTMLElement;
    const btns = [...row.querySelectorAll('.row-act-btn')] as HTMLElement[];
    expect(btns.map((b) => b.title)).toEqual(['Restore session', 'Delete session']);
    expect(row.getAttribute('draggable')).toBe('false');
    fireEvent.click(btns[0]);
    expect(invokeMock).toHaveBeenCalledWith('sessions:archive', { id: 's_a', archived: false });
  });

  it('dragging one pinned row over another persists the new pin order', () => {
    useStore.setState({
      sessions: [
        session('s_a', { title: 'A', pinned: true, pinnedAt: 1 }),
        session('s_b', { title: 'B', pinned: true, pinnedAt: 2 }),
        session('s_c', { title: 'C', updatedAt: 3_000 })
      ],
      settings,
      activeId: null,
      view: 'chat'
    });
    const { container } = render(<Sidebar />);
    const rows = container.querySelectorAll('.session-row');
    expect(rows).toHaveLength(3);
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(rows[0], { dataTransfer });
    // An unpinned row is not a drop target.
    fireEvent.dragOver(rows[2], { dataTransfer });
    expect(invokeMock).not.toHaveBeenCalledWith('sessions:pinOrder', expect.anything());
    fireEvent.dragOver(rows[1], { dataTransfer });
    expect(container.querySelector('.session-row.drag-below')).toBeTruthy();
    fireEvent.drop(rows[1], { dataTransfer });
    expect(invokeMock).toHaveBeenCalledWith('sessions:pinOrder', { ids: ['s_b', 's_a'] });
    expect(container.querySelector('.session-row.dragging')).toBeNull();
  });
});

describe('sortSessionRows', () => {
  it('pinned first by earliest pin stamp, unpinned by recency', () => {
    const list = [
      session('s_c', { updatedAt: 300 }),
      session('s_b', { pinned: true, pinnedAt: 200, updatedAt: 100 }),
      session('s_d', { updatedAt: 200 }),
      session('s_a', { pinned: true, pinnedAt: 100, updatedAt: 400 })
    ];
    expect(sortSessionRows(list).map((s) => s.id)).toEqual(['s_a', 's_b', 's_c', 's_d']);
  });
});
