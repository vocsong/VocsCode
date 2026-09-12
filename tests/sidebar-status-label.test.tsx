// Status label: clicking the badge opens a picker; custom labels render red; new labels persist to settings.
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
};

import { fireEvent, render } from '@testing-library/react';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta } from '../src/shared/types';

const settings = { folders: [], customLabels: ['wip'], sidebarWidth: 280, panelWidth: 420 } as never;

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

describe('sidebar status labels', () => {
  it('renders a user-set label in red instead of the status name', () => {
    const custom = renderRow(session({ statusLabel: 'todo' }));
    const el = custom.container.querySelector('.session-status.status-custom') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.textContent).toBe('todo');
    custom.unmount();

    const auto = renderRow(session({}));
    expect(auto.container.querySelector('.session-status.status-custom')).toBeNull();
    expect((auto.container.querySelector('.session-status') as HTMLElement).textContent).toBe('Idle');
  });

  it('picks a predefined label on click', () => {
    const { container } = renderRow(session({}));
    fireEvent.click(container.querySelector('.session-status') as HTMLElement);
    const picker = document.querySelector('.status-label-picker') as HTMLElement;
    expect(picker).toBeTruthy();
    expect([...picker.querySelectorAll('.menu-item-label')].map((m) => m.textContent)).toContain('Working');

    const working = [...picker.querySelectorAll('.menu-item')].find((m) => m.textContent === 'Working') as HTMLElement;
    fireEvent.click(working);
    expect(invokeMock).toHaveBeenCalledWith('sessions:label', { id: 's1', label: 'Working' });
  });

  it('picking the current status name resets to auto', () => {
    const { container } = renderRow(session({}));
    fireEvent.click(container.querySelector('.session-status') as HTMLElement);
    const idle = [...document.querySelectorAll('.menu-item')].find((m) => m.textContent === 'Idle') as HTMLElement;
    fireEvent.click(idle);
    expect(invokeMock).toHaveBeenCalledWith('sessions:label', { id: 's1', label: undefined });
  });

  it('adds a new label to the predefined list and applies it', () => {
    const { container } = renderRow(session({}));
    fireEvent.click(container.querySelector('.session-status') as HTMLElement);
    const input = document.querySelector('.status-label-add input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wip' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // 'wip' already exists in settings, so the list dedupes to itself.
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { customLabels: ['wip'] });
    expect(invokeMock).toHaveBeenCalledWith('sessions:label', { id: 's1', label: 'wip' });
  });

  it('resets a custom label back to the status', () => {
    const { container } = renderRow(session({ statusLabel: 'todo' }));
    fireEvent.click(container.querySelector('.session-status.status-custom') as HTMLElement);
    const reset = [...document.querySelectorAll('.menu-item')].find((m) => m.textContent === 'Reset to status') as HTMLElement;
    expect(reset).toBeTruthy();
    fireEvent.click(reset);
    expect(invokeMock).toHaveBeenCalledWith('sessions:label', { id: 's1', label: undefined });
  });

  it('toasts instead of silently swallowing a failed label save', async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'sessions:label') return Promise.reject(new Error('No handler registered'));
      return Promise.resolve({});
    });
    const { container } = renderRow(session({}));
    useStore.setState({ toasts: [] });
    fireEvent.click(container.querySelector('.session-status') as HTMLElement);
    const todo = [...document.querySelectorAll('.menu-item')].find((m) => m.textContent === 'Todo') as HTMLElement;
    fireEvent.click(todo);
    await Promise.resolve();
    await Promise.resolve();
    expect(useStore.getState().toasts.some((t) => t.kind === 'error' && t.text.includes('No handler registered'))).toBe(true);
  });
});