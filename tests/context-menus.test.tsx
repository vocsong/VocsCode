// Right-click menus in the sidebar: a folder header offers the folder actions (including the only
// way to take a folder out of the app), a session row mirrors its inline actions, and the menu
// closes the way a native one does.
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { TranscriptCapabilitiesProvider } from '../src/renderer/src/capabilities';
import { ContextMenuHost } from '../src/renderer/src/components/ContextMenu';
import { ConfirmHost } from '../src/renderer/src/components/ui';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, SessionMeta, TranscriptItem } from '../src/shared/types';

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});

const settings = {
  folders: ['G:/proj/a', 'G:/proj/b'],
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

function setup(sessions: SessionMeta[] = [session('s_a', { title: 'A' })]) {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ removedSessions: sessions.length });
  useStore.setState({ sessions, settings, activeId: null, view: 'chat', toasts: [] });
  return render(
    <>
      <Sidebar />
      <ContextMenuHost />
      <ConfirmHost />
    </>
  );
}

const rightClick = (el: Element) => fireEvent.contextMenu(el, { clientX: 40, clientY: 60 });
const menuLabels = () => [...document.querySelectorAll('[data-testid="context-menu"] .menu-item-label')].map((n) => n.textContent);
const clickMenuItem = (label: string) => {
  const item = [...document.querySelectorAll<HTMLElement>('[data-testid="context-menu"] .menu-item')].find((b) => b.textContent?.startsWith(label));
  if (!item) throw new Error(`No menu item "${label}" in ${JSON.stringify(menuLabels())}`);
  fireEvent.click(item);
};

describe('sidebar context menus', () => {
  it('offers the folder actions on a folder header, with removal last and destructive', () => {
    const { container } = setup();
    rightClick(container.querySelector('.project-header') as HTMLElement);
    expect(menuLabels()).toEqual(['New session in a', 'Collapse folder', 'Copy path', 'Remove folder from Vocs Code']);
    const remove = [...document.querySelectorAll<HTMLElement>('[data-testid="context-menu"] .menu-item')].at(-1)!;
    expect(remove.classList.contains('danger')).toBe(true);
  });

  it('removes the folder from the app once the confirmation — which says the folder stays on disk — is accepted', async () => {
    const { container } = setup([session('s_a', { title: 'A' }), session('s_b', { title: 'B' })]);
    rightClick(container.querySelector('.project-header') as HTMLElement);
    clickMenuItem('Remove folder from Vocs Code');

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Remove "a" from Vocs Code?');
    // The two sessions go; the project directory explicitly does not.
    expect(dialog.textContent).toContain('2 sessions');
    expect(dialog.textContent).toContain('not deleted');
    expect(dialog.textContent).toContain('G:/proj/a');
    expect(invokeMock).not.toHaveBeenCalledWith('folders:remove', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'Remove folder' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('folders:remove', { root: 'G:/proj/a' }));
  });

  it('leaves the folder alone when the confirmation is dismissed', async () => {
    const { container } = setup();
    rightClick(container.querySelector('.project-header') as HTMLElement);
    clickMenuItem('Remove folder from Vocs Code');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(invokeMock).not.toHaveBeenCalledWith('folders:remove', expect.anything());
  });

  it('mirrors the row actions on a session row and pins from the menu', () => {
    const { container } = setup();
    rightClick(container.querySelector('.session-row') as HTMLElement);
    expect(menuLabels()).toEqual(['Open session', 'Rename', 'Pin to top', 'Archive', 'Delete session']);
    clickMenuItem('Pin to top');
    expect(invokeMock).toHaveBeenCalledWith('sessions:pin', { id: 's_a', pinned: true });
    expect(document.querySelector('[data-testid="context-menu"]')).toBeNull();
  });

  it('offers restore instead of archive on an archived row', () => {
    const { container } = setup([session('s_a', { title: 'A', archived: true, pinned: true })]);
    fireEvent.click(screen.getByText('Archived'));
    rightClick(container.querySelector('.session-row') as HTMLElement);
    expect(menuLabels()).toEqual(['Open session', 'Rename', 'Unpin', 'Restore session', 'Delete session']);
  });

  it('closes on Escape and replaces itself when another row is right-clicked', () => {
    const { container } = setup([session('s_a', { title: 'A' }), session('s_b', { title: 'B' })]);
    rightClick(container.querySelector('.session-row') as HTMLElement);
    expect(document.querySelector('[data-testid="context-menu"]')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-testid="context-menu"]')).toBeNull();

    rightClick(container.querySelector('.project-header') as HTMLElement);
    expect(menuLabels()[0]).toBe('New session in a');
    rightClick(container.querySelectorAll('.session-row')[1] as HTMLElement);
    expect(menuLabels()[0]).toBe('Open session');
  });
});

describe('transcript context menu', () => {
  const items: TranscriptItem[] = [
    { id: 'u1', kind: 'user', ts: 1, text: 'Message to copy' },
    { id: 'a1', kind: 'assistant', ts: 2, text: 'An answer' }
  ];

  function transcript() {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
    useStore.setState({ sessions: [session('s_a')], settings, transcripts: { s_a: items }, loaded: { s_a: true }, showThinking: false, searchJump: null, toasts: [] });
    return render(
      <>
        <Transcript session={session('s_a')} />
        <ContextMenuHost />
      </>
    );
  }

  it('copies the message under the cursor, and offers find, jump and export', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { container } = transcript();

    rightClick(container.querySelector('.msg-user .msg-text') as HTMLElement);
    // Nothing is selected, so only the message copy is offered.
    expect(menuLabels()).toEqual(['Copy message', 'Find in transcript', 'Jump to latest', 'Export transcript…']);
    clickMenuItem('Copy message');
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Message to copy'));
  });

  it('keeps the native menu inside a text field', () => {
    const { container } = transcript();
    const transcriptEl = container.querySelector('.transcript') as HTMLElement;
    const input = document.createElement('textarea');
    transcriptEl.append(input);
    rightClick(input);
    expect(document.querySelector('[data-testid="context-menu"]')).toBeNull();
  });

  it('leaves no menu at all when the host turns the row menu off', () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
    useStore.setState({ sessions: [session('s_a')], settings, transcripts: { s_a: items }, loaded: { s_a: true }, showThinking: false, searchJump: null, toasts: [] });
    const { container } = render(
      <>
        <TranscriptCapabilitiesProvider value={{ contextMenu: false, editAndResend: true, openFile: true }}>
          <Transcript session={session('s_a')} />
        </TranscriptCapabilitiesProvider>
        <ContextMenuHost />
      </>
    );
    rightClick(container.querySelector('.msg-user .msg-text') as HTMLElement);
    expect(document.querySelector('[data-testid="context-menu"]')).toBeNull();
  });
});
