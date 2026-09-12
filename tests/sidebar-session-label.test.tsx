// Session labels: user-set titles render red, inline rename offers preset chips, Enter commits.
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
};

import { fireEvent, render, waitFor } from '@testing-library/react';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta } from '../src/shared/types';

const settings = { folders: [], sidebarWidth: 280, panelWidth: 420 } as never;

const session = (patch: Partial<SessionMeta>): SessionMeta => ({
  id: 's1',
  title: 'Auto title',
  createdAt: 1,
  updatedAt: 2,
  config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'auto' },
  cwd: 'G:/proj/a',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
  ...patch,
});

function renderRow(meta: SessionMeta) {
  useStore.setState({ sessions: [meta], settings, activeId: 's1', view: 'chat' });
  return render(<Sidebar />);
}

describe('sidebar session labels', () => {
  it('marks user-set titles red and auto titles plain', () => {
    const user = renderRow(session({ userTitle: true }));
    expect(user.container.querySelector('.session-title span.user-titled')).toBeTruthy();
    user.unmount();

    const auto = renderRow(session({}));
    expect(auto.container.querySelector('.session-title span.user-titled')).toBeNull();
  });

  it('renames via click with preset chips and commits on Enter', async () => {
    const { container } = renderRow(session({}));
    fireEvent.click(container.querySelector('.session-title span') as HTMLElement);
    const input = document.querySelector('.session-rename') as HTMLInputElement;
    expect(input).toBeTruthy();

    // Preset chips are offered and clicking one fills the input.
    const chips = [...document.querySelectorAll('.suggest-chip')] as HTMLButtonElement[];
    expect(chips.map((c) => c.textContent)).toContain('todo');
    expect(chips.map((c) => c.textContent)).toContain('error');
    fireEvent.click(chips.find((c) => c.textContent === 'todo') as HTMLElement);
    expect(input.value).toBe('todo');
    expect((chips.find((c) => c.textContent === 'todo') as HTMLElement).className).toContain('active');

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sessions:rename', { id: 's1', title: 'todo' }));
  });

  it('Escape cancels without renaming', () => {
    const { container } = renderRow(session({}));
    fireEvent.click(container.querySelector('.session-title span') as HTMLElement);
    const input = document.querySelector('.session-rename') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(document.querySelector('.session-rename')).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith('sessions:rename', expect.anything());
  });
});