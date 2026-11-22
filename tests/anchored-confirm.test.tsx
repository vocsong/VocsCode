// Confirmations opened from a control pop up at that control instead of centred over a dimmed
// window: archiving a worktree session or deleting one from the sidebar asks right at the row, and
// the control is marked while the dialog is up so CSS keeps it showing (Zen's rail stays open, the
// row keeps its hover actions). A dialog with no anchor, or one whose anchor has left the page,
// stays centred.
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { ContextMenuHost } from '../src/renderer/src/components/ContextMenu';
import { ConfirmHost, askConfirm, placeBeside } from '../src/renderer/src/components/ui';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const settings = {
  folders: ['G:/proj/a'],
  folderStyles: {},
  collapsedFolders: [],
  sidebarWidth: 280,
  panelWidth: 420
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

const box = (left: number, top: number, width: number, height: number) =>
  ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

// jsdom lays nothing out: give the dialog a real size and let each test place its anchor.
const DIALOG = { width: 380, height: 160 };
const rects = new Map<Element, DOMRect>();
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('modal')) return box(0, 0, DIALOG.width, DIALOG.height);
    return rects.get(this) ?? box(0, 0, 0, 0);
  });
});
afterEach(async () => {
  // Only one confirmation may be open at a time: answer a leftover one so a failing test cannot
  // block the dialogs of the tests after it.
  const leftover = screen.queryByRole('button', { name: 'Cancel' });
  if (leftover) fireEvent.click(leftover);
  await act(async () => {
    cleanup();
  });
  rects.clear();
  vi.restoreAllMocks();
});

function setup(sessions: SessionMeta[]) {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  useStore.setState({ sessions, settings, activeId: null, view: 'chat', toasts: [], archiving: {} });
  return render(
    <>
      <Sidebar />
      <ContextMenuHost />
      <ConfirmHost />
    </>
  );
}

const rowButton = (row: Element, label: string) => row.querySelector(`[aria-label="${label}"]`) as HTMLElement;
const backdrop = () => document.querySelector('.modal-backdrop') as HTMLElement;

describe('placeBeside', () => {
  const viewport = { width: 1280, height: 800 };

  it('opens below the control with right edges lined up', () => {
    expect(placeBeside(box(600, 100, 26, 26), DIALOG, viewport)).toEqual({ top: 132, left: 246 });
  });

  it('flips above the control when the window has no room below', () => {
    expect(placeBeside(box(600, 700, 26, 26), DIALOG, viewport)).toEqual({ top: 700 - 6 - 160, left: 246 });
  });

  it('stays inside the window on every side', () => {
    // A control at the window's left edge would push the dialog off-screen to the left.
    expect(placeBeside(box(10, 100, 26, 26), DIALOG, viewport).left).toBe(8);
    // Too short for either side: pinned to the bottom margin rather than cut off.
    expect(placeBeside(box(600, 100, 26, 26), DIALOG, { width: 1280, height: 250 }).top).toBe(250 - 8 - 160);
  });
});

describe('anchored confirmations from the sidebar', () => {
  it('asks to remove a worktree at the archive button, holding it marked until the answer', async () => {
    const { container } = setup([session('s_a', { title: 'A', worktreeBranch: 'agent/a' })]);
    const archive = rowButton(container.querySelector('.session-row')!, 'Archive session');
    rects.set(archive, box(600, 100, 26, 26));
    fireEvent.click(archive);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Remove the worktree for "A"?');
    expect(dialog.classList.contains('is-anchored')).toBe(true);
    expect(backdrop().classList.contains('is-anchored')).toBe(true);
    expect({ top: dialog.style.top, left: dialog.style.left }).toEqual({ top: '132px', left: '246px' });
    expect(archive.hasAttribute('data-dialog-anchor')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(archive.hasAttribute('data-dialog-anchor')).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith('sessions:archive', expect.anything());
  });

  it('asks about uncommitted changes at the same button, then archives with force', async () => {
    const { container } = setup([session('s_a', { title: 'A', worktreeBranch: 'agent/a' })]);
    invokeMock.mockImplementation(async (channel: string, args: { forceWorktree?: boolean }) => {
      if (channel === 'sessions:archive' && !args.forceWorktree) throw new Error('worktree contains modified or untracked files');
      return {};
    });
    const archive = rowButton(container.querySelector('.session-row')!, 'Archive session');
    rects.set(archive, box(600, 100, 26, 26));
    fireEvent.click(archive);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive & remove' }));

    const force = await screen.findByText('Discard uncommitted changes?');
    const dialog = force.closest('[role="dialog"]') as HTMLElement;
    expect(dialog.classList.contains('is-anchored')).toBe(true);
    expect({ top: dialog.style.top, left: dialog.style.left }).toEqual({ top: '132px', left: '246px' });
    expect(archive.hasAttribute('data-dialog-anchor')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Discard & remove' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sessions:archive', { id: 's_a', archived: true, removeWorktree: true, forceWorktree: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(archive.hasAttribute('data-dialog-anchor')).toBe(false);
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:archive')).toHaveLength(2);
  });

  it('asks at the row when archive is picked from its right-click menu', async () => {
    const { container } = setup([session('s_a', { title: 'A', worktreeBranch: 'agent/a' })]);
    const row = container.querySelector('.session-row') as HTMLElement;
    rects.set(row, box(0, 200, 280, 40));
    fireEvent.contextMenu(row, { clientX: 40, clientY: 210 });
    const item = [...document.querySelectorAll<HTMLElement>('[data-testid="context-menu"] .menu-item')].find((b) => b.textContent?.startsWith('Archive & remove worktree'));
    fireEvent.click(item!);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.classList.contains('is-anchored')).toBe(true);
    expect({ top: dialog.style.top, left: dialog.style.left }).toEqual({ top: '246px', left: '8px' });
    expect(row.hasAttribute('data-dialog-anchor')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(row.hasAttribute('data-dialog-anchor')).toBe(false);
  });

  it('asks to delete an archived session at its delete button', async () => {
    const { container } = setup([session('s_a', { title: 'A', archived: true })]);
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    const del = rowButton(container.querySelector('.session-row')!, 'Delete session');
    rects.set(del, box(600, 100, 26, 26));
    fireEvent.click(del);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Delete session "A"?');
    expect(dialog.classList.contains('is-anchored')).toBe(true);
    expect(del.hasAttribute('data-dialog-anchor')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sessions:delete', { id: 's_a', removeWorktree: false }));
    expect(del.hasAttribute('data-dialog-anchor')).toBe(false);
  });
});

describe('unanchored confirmations', () => {
  function host() {
    useStore.setState({ toasts: [] });
    return render(<ConfirmHost />);
  }

  it('stay centred over a dimmed window', async () => {
    host();
    let answer: Promise<boolean> = Promise.resolve(false);
    act(() => { answer = askConfirm({ title: 'Centred?' }); });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.classList.contains('is-anchored')).toBe(false);
    expect(backdrop().classList.contains('is-anchored')).toBe(false);
    expect(dialog.style.top).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(answer).resolves.toBe(true);
  });

  it('fall back to centred when the anchor has already left the page', async () => {
    host();
    const gone = document.createElement('button');
    act(() => { void askConfirm({ title: 'Anchor gone', anchor: gone }); });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.classList.contains('is-anchored')).toBe(false);
    expect(gone.hasAttribute('data-dialog-anchor')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
