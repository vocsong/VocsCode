// Header: the thinking toggle lives in the title row, the 3-dot menu is gone, and fork/archive
// buttons behave exactly like the sidebar row's (same fork menu, same archive flow).
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
};

import { fireEvent, render, waitFor } from '@testing-library/react';
import { Header } from '../src/renderer/src/components/Header';
import { ConfirmHost } from '../src/renderer/src/components/ui';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta } from '../src/shared/types';

const session = (id = 's_h', patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: 'Header session',
  createdAt: 1_000,
  updatedAt: 1_000,
  config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as SessionMeta['config'],
  cwd: 'G:/proj/a',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
  ...patch
});

function setup(patch: Partial<SessionMeta> = {}, withConfirm = false) {
  invokeMock.mockClear();
  useStore.setState({ activeId: 's_h', view: 'chat', panelOpen: true, showThinking: true });
  return render(
    <>
      <Header session={session('s_h', patch)} />
      {withConfirm && <ConfirmHost />}
    </>
  );
}

describe('header actions', () => {
  it('keeps the panel toggle in the title row and drops the 3-dot menu', () => {
    const { container } = setup();
    const title = container.querySelector('.header-title') as HTMLElement;
    expect(title.querySelector('[aria-label="Toggle panel"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="More"]')).toBeNull();
  });

  it('toggles thinking from the actions row, below the panel toggle', () => {
    const { container } = setup();
    const actions = container.querySelector('.header-actions') as HTMLElement;
    // Order in the actions row: hide thinking, fork, archive.
    const labels = [...actions.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '');
    expect(labels[0]).toBe('Hide thinking');
    expect(labels).toContain('Fork session');
    expect(labels).toContain('Archive session');
    fireEvent.click(actions.querySelector('[aria-label="Hide thinking"]') as HTMLElement);
    expect(useStore.getState().showThinking).toBe(false);
    // The thinking toggle is not in the title row anymore.
    expect((container.querySelector('.header-title') as HTMLElement).querySelector('[aria-label="Hide thinking"]')).toBeNull();
  });

  it('fork button opens the same harness menu as the sidebar row and forks', async () => {
    const { container } = setup();
    const fork = container.querySelector('[aria-label="Fork session"]') as HTMLElement;
    expect(fork).toBeTruthy();
    fireEvent.click(fork);
    const items = [...document.querySelectorAll('.dropdown-menu .menu-item')];
    const labels = items.map((i) => i.textContent ?? '');
    // The session's own harness is offered first, then every other harness.
    expect(labels[0]).toContain('Fork into');
    expect(labels.some((l) => l.includes('Native'))).toBe(true);
    expect(labels.some((l) => l.includes('Claude'))).toBe(true);
    const claude = items.find((i) => (i.textContent ?? '').includes('Claude')) as HTMLElement;
    invokeMock.mockResolvedValueOnce(session('s_f', { config: { harness: 'claude', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as SessionMeta['config'] }));
    fireEvent.click(claude);
    expect(invokeMock).toHaveBeenCalledWith('sessions:fork', { id: 's_h', harness: 'claude' });
    await waitFor(() => expect(useStore.getState().activeId).toBe('s_f'));
  });

  it('archive button archives like the sidebar row', () => {
    const { container } = setup();
    const archive = container.querySelector('[aria-label="Archive session"]') as HTMLElement;
    expect(archive).toBeTruthy();
    fireEvent.click(archive);
    expect(invokeMock).toHaveBeenCalledWith('sessions:archive', { id: 's_h', archived: true });
  });

  it('worktree sessions confirm before archive removes the worktree', () => {
    const { container } = setup({ worktreeBranch: 'agent/a' }, true);
    expect((container.querySelector('[aria-label="Archive session"]') as HTMLElement).title).toBe('Archive & remove worktree');
    fireEvent.click(container.querySelector('[aria-label="Archive session"]') as HTMLElement);
    // Confirmation dialog first; nothing is archived until confirmed.
    expect(invokeMock).not.toHaveBeenCalledWith('sessions:archive', expect.anything());
    expect(document.querySelector('.modal')).toBeTruthy();
  });
});