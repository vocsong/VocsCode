/** @vitest-environment jsdom */
/** The activity tray (docs/superpowers/specs/2026-11-09-session-activity-tray-design.md): what
 *  needs you, what is running, what finished since you last looked and what you viewed recently,
 *  across every folder, one hover or click away from the sidebar header. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'darwin',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { activitySections, RECENT_LIMIT } from '../src/renderer/src/activity';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta } from '../src/shared/types';
import type { MissionOwnership } from '../src/shared/mission';

const session = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: `Title ${id}`,
  createdAt: 1,
  updatedAt: 2,
  config: { harness: 'claude', projectRoot: '/work/alpha', permissionMode: 'auto' },
  cwd: '/work/alpha',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
  ...patch
});
const ids = (list: SessionMeta[]) => list.map((s) => s.id);
const worker: MissionOwnership = { missionId: 'm1', role: 'worker', generation: 1, sourceAccess: 'read_only', requestedTools: [], reasoningDefault: false };

describe('activitySections', () => {
  it('sorts sessions into what needs you, what runs, what finished unviewed and what you viewed', () => {
    const sections = activitySections([
      session('wait', { status: 'awaiting' }),
      session('run', { status: 'running' }),
      session('boot', { status: 'starting' }),
      session('old-done', { unseenAt: 100 }),
      session('new-done', { unseenAt: 300 }),
      // A failed turn lands with the finished work, so a stale error never sits in Needs you.
      session('failed', { status: 'error', unseenAt: 200 }),
      session('seen', { lastViewedAt: 50 }),
      session('plain')
    ], null);
    expect(ids(sections.needs)).toEqual(['wait']);
    expect(ids(sections.running)).toEqual(['run', 'boot']);
    expect(ids(sections.done)).toEqual(['new-done', 'failed', 'old-done']);
    expect(ids(sections.recent)).toEqual(['seen']);
  });

  it('keeps a running session out of Done even if an earlier turn was unviewed', () => {
    const sections = activitySections([session('run', { status: 'running', unseenAt: 10, lastViewedAt: 5 })], null);
    expect(ids(sections.running)).toEqual(['run']);
    expect(sections.done).toEqual([]);
    expect(sections.recent).toEqual([]);
  });

  it('lists the last five viewed, newest first, never the active one or one listed above', () => {
    const viewed = Array.from({ length: 8 }, (_, i) => session(`v${i}`, { lastViewedAt: 1_000 + i }));
    const sections = activitySections([...viewed, session('done', { unseenAt: 1, lastViewedAt: 9_999 })], 'v7');
    expect(RECENT_LIMIT).toBe(5);
    expect(ids(sections.recent)).toEqual(['v6', 'v5', 'v4', 'v3', 'v2']);
  });

  it('leaves archived sessions and Mission workers out of every section', () => {
    const sections = activitySections([
      session('arch', { archived: true, status: 'running', unseenAt: 1, lastViewedAt: 1 }),
      session('work', { mission: worker, status: 'awaiting', unseenAt: 1, lastViewedAt: 1 })
    ], null);
    expect([...sections.needs, ...sections.running, ...sections.done, ...sections.recent]).toEqual([]);
  });
});

const settings = (patch: Record<string, unknown> = {}) => ({ folders: [], sidebarWidth: 280, panelWidth: 420, ...patch }) as never;

function renderSidebar(sessions: SessionMeta[], opts: { activeId?: string | null; collapsed?: string[] } = {}) {
  useStore.setState({
    sessions,
    settings: settings({ collapsedFolders: opts.collapsed ?? [] }),
    activeId: opts.activeId ?? null,
    view: 'chat'
  });
  return render(<Sidebar />);
}

const badges = (container: HTMLElement) => [...container.querySelectorAll('.sidebar-status .badge')].map((el) => el.textContent?.trim());

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the header trigger', () => {
  it('counts what finished unviewed beside running and awaiting', () => {
    const { container } = renderSidebar([
      session('r1', { status: 'running' }),
      session('r2', { status: 'running' }),
      session('a1', { status: 'awaiting' }),
      session('d1', { unseenAt: 10 })
    ]);
    expect(badges(container)).toEqual(['2 running', '1 awaiting', '1 done']);
    expect(screen.getByTestId('activity-trigger').closest('.sidebar-status')).not.toBeNull();
  });

  it('falls back to a Recent sessions button when there is nothing to count', () => {
    const { container } = renderSidebar([session('s1')]);
    expect(container.querySelector('.sidebar-status')).toBeNull();
    expect(screen.getByTestId('activity-trigger').getAttribute('aria-label')).toBe('Recent sessions');
  });

  it('opens on hover after a short pause and closes once the pointer has left', () => {
    renderSidebar([session('d1', { unseenAt: 10 })]);
    const trigger = screen.getByTestId('activity-trigger');
    fireEvent.mouseEnter(trigger.parentElement!);
    act(() => { vi.advanceTimersByTime(249); });
    expect(screen.queryByTestId('activity-tray')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByTestId('activity-tray')).toBeTruthy();
    fireEvent.mouseLeave(trigger.parentElement!);
    act(() => { vi.advanceTimersByTime(299); });
    expect(screen.getByTestId('activity-tray')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByTestId('activity-tray')).toBeNull();
  });

  it('stays open after a click even when the pointer leaves, until Escape', () => {
    renderSidebar([session('d1', { unseenAt: 10 })]);
    const trigger = screen.getByTestId('activity-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('activity-tray')).toBeTruthy();
    fireEvent.mouseLeave(trigger.parentElement!);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByTestId('activity-tray')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('activity-tray')).toBeNull();
  });

  it('closes on a click outside', () => {
    renderSidebar([session('d1', { unseenAt: 10 })]);
    fireEvent.click(screen.getByTestId('activity-trigger'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('activity-tray')).toBeNull();
  });
});

describe('the tray', () => {
  it('shows each section with the folder and harness of every row', () => {
    renderSidebar([
      session('a1', { status: 'awaiting', title: 'Needs approval' }),
      session('d1', { unseenAt: Date.now() - 12 * 60_000, title: 'Finished work', config: { harness: 'claude', projectRoot: '/work/beta', permissionMode: 'auto' } })
    ]);
    fireEvent.click(screen.getByTestId('activity-trigger'));
    const tray = screen.getByTestId('activity-tray');
    expect([...tray.querySelectorAll('.activity-section-label')].map((el) => el.textContent)).toEqual(['Needs you', 'Done · not viewed']);
    const rows = screen.getAllByTestId('activity-row');
    expect(rows.map((r) => r.querySelector('.activity-row-title')?.textContent)).toEqual(['Needs approval', 'Finished work']);
    expect(rows[1].querySelector('.activity-row-meta')?.textContent).toBe('beta · Claude');
    expect(rows[1].querySelector('.activity-row-time')?.textContent).toBe('12m ago');
  });

  it('says so when there is nothing to show', () => {
    renderSidebar([session('s1')]);
    fireEvent.click(screen.getByTestId('activity-trigger'));
    expect(screen.getByTestId('activity-tray').textContent).toContain('Nothing running and no recent sessions yet.');
  });

  it('opens a row in a collapsed folder, expanding the folder, and closes', async () => {
    renderSidebar([session('here'), session('d1', { unseenAt: 10, config: { harness: 'claude', projectRoot: '/work/beta', permissionMode: 'auto' } })], {
      activeId: 'here',
      collapsed: ['/work/beta']
    });
    fireEvent.click(screen.getByTestId('activity-trigger'));
    await act(async () => { fireEvent.click(screen.getByTestId('activity-row')); });
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { collapsedFolders: [] });
    expect(useStore.getState().activeId).toBe('d1');
    expect(screen.queryByTestId('activity-tray')).toBeNull();
  });

  it('moves between rows with the arrow keys', () => {
    renderSidebar([session('a1', { status: 'awaiting' }), session('d1', { unseenAt: 10 })]);
    fireEvent.click(screen.getByTestId('activity-trigger'));
    const rows = screen.getAllByTestId('activity-row');
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows[0]);
  });
});

describe('unviewed markers in the session list', () => {
  it('dots a row that finished since you last looked', () => {
    renderSidebar([session('d1', { unseenAt: 10 }), session('s2')]);
    expect(screen.getAllByTestId('session-unseen-dot')).toHaveLength(1);
  });

  it('counts unviewed sessions on a collapsed folder, and only while it is collapsed', () => {
    const list = [session('d1', { unseenAt: 10 }), session('d2', { unseenAt: 20 }), session('s3')];
    renderSidebar(list, { collapsed: ['/work/alpha'] });
    expect(screen.getByTestId('project-unseen').textContent).toBe('●2');
    cleanup();
    renderSidebar(list);
    expect(screen.queryByTestId('project-unseen')).toBeNull();
  });
});
