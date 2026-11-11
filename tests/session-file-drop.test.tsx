/** @vitest-environment jsdom */
/** Files dragged from the OS onto a session pane attach to that pane's composer, like the + button. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (..._args: unknown[]) => undefined as unknown);
(window as unknown as { harness: unknown }).harness = { platform: 'darwin', invoke, on: vi.fn().mockReturnValue(() => undefined) };

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionPanes } from '../src/renderer/src/components/SessionPanes';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta } from '../src/shared/types';

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id, title: id, createdAt: 1, updatedAt: 1, status: 'idle', cwd: '.', harnessRef: {},
    config: { harness: 'native', projectRoot: '.', permissionMode: 'ask' },
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 },
    ...extra
  }) as unknown as SessionMeta;

/** What Chromium hands a drop from Finder/Explorer: the `Files` type, the files, and an entry per item. */
const fileDrag = (files: File[], folders: string[] = []) => ({
  dataTransfer: {
    types: ['Files'],
    files,
    items: files.map((f) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: folders.includes(f.name) }) })),
    dropEffect: 'none'
  }
});

const show = (sessions: SessionMeta[], activePaneId = 'p0') =>
  useStore.setState({
    sessions,
    activeId: sessions[activePaneId === 'p0' ? 0 : 1]?.id ?? null,
    layout: {
      orientation: 'horizontal',
      panes: sessions.map((s, i) => ({ id: `p${i}`, sessionId: s.id })),
      activePaneId,
      sizes: sessions.map(() => 1 / sessions.length)
    }
  });

afterEach(() => {
  cleanup();
  invoke.mockClear();
});

describe('dropping files onto a session', () => {
  it('attaches a file dropped on the transcript and sends it with the next message', async () => {
    show([meta('drop-a')]);
    const view = render(<SessionPanes empty={null} />);
    const pane = screen.getByTestId('session-pane');
    const notes = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    const over = fileDrag([notes]);
    fireEvent.dragOver(pane, over);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    expect(screen.getByTestId('file-drop-overlay')).toBeTruthy();

    // Dropped well away from the composer: anywhere on the pane counts.
    fireEvent.drop(pane.querySelector('.transcript') ?? pane, fileDrag([notes]));
    await screen.findByText('notes.txt');
    expect(screen.queryByTestId('file-drop-overlay')).toBeNull();

    const box = view.container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'read this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('sessions:send', {
        id: 'drop-a',
        input: { text: 'read this', images: undefined, files: [{ name: 'notes.txt', mimeType: 'text/plain', data: btoa('hello') }], mode: 'now' }
      })
    );
  });

  it('attaches to the pane it was dropped on and makes that pane active', async () => {
    show([meta('drop-left'), meta('drop-right')]);
    render(<SessionPanes empty={null} />);
    const [left, right] = screen.getAllByTestId('session-pane');
    fireEvent.drop(right!, fileDrag([new File(['png'], 'shot.png', { type: 'image/png' })]));
    await waitFor(() => expect(right!.querySelector('.attachment img')).toBeTruthy());
    expect(left!.querySelector('.attachment img')).toBeNull();
    expect(useStore.getState().layout.activePaneId).toBe('p1');
  });

  it('refuses a dropped folder with a message instead of attaching it', async () => {
    const toast = vi.spyOn(useStore.getState(), 'toast');
    show([meta('drop-folder')]);
    const view = render(<SessionPanes empty={null} />);
    fireEvent.drop(screen.getByTestId('session-pane'), fileDrag([new File([], 'src'), new File(['ok'], 'ok.txt', { type: 'text/plain' })], ['src']));
    await screen.findByText('ok.txt');
    expect(view.container.querySelectorAll('.file-attachment')).toHaveLength(1);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('src is a folder'), 'error');
  });

  it('does not offer a drop on a read-only specialist session', () => {
    show([meta('drop-worker', { mission: { missionId: 'm1', role: 'worker' } as SessionMeta['mission'] })]);
    render(<SessionPanes empty={null} />);
    const pane = screen.getByTestId('session-pane');
    const over = fileDrag([new File(['x'], 'x.txt')]);
    fireEvent.dragOver(pane, over);
    expect(over.dataTransfer.dropEffect).toBe('none');
    expect(screen.queryByTestId('file-drop-overlay')).toBeNull();
  });
});
