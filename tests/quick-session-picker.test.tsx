/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuickSessionPicker } from '../src/renderer/src/components/QuickSessionPicker';
import { useStore } from '../src/renderer/src/store';

afterEach(cleanup);

const meta = (id: string, projectRoot: string) => ({ id, title: id, archived: false, config: { projectRoot } }) as never;

function seedStore(opts: { openQuickSession?: () => void; createQuickSession?: (root: string) => void; startNewSession?: () => void } = {}) {
  useStore.setState({
    quickSessionOpen: true,
    sessions: [meta('b', 'C:/work/beta'), meta('a', 'C:/work/alpha')],
    settings: {
      folders: ['C:/work/pinned'],
      recentProjects: ['C:/work/old'],
      folderOrder: ['C:/work/alpha', 'C:/work/pinned']
    } as never,
    openQuickSession: opts.openQuickSession ?? (() => {}),
    createQuickSession: opts.createQuickSession ?? (async () => {}),
    startNewSession: opts.startNewSession ?? (async () => {})
  } as never);
}

describe('QuickSessionPicker', () => {
  it('lists known folders once, in sidebar order, plus a browse fallback', () => {
    seedStore();
    const { container } = render(<QuickSessionPicker />);
    const labels = [...container.querySelectorAll('.palette-item')].map((el) => el.textContent);
    // folderOrder puts alpha and pinned first; beta sorts after; recentProjects dedup in.
    expect(labels.some((t) => t!.includes('C:/work/alpha'))).toBe(true);
    expect(labels.some((t) => t!.includes('C:/work/pinned'))).toBe(true);
    expect(labels.filter((t) => t!.includes('C:/work/beta'))).toHaveLength(1);
    expect(labels.some((t) => t!.includes('C:/work/old'))).toBe(true);
    expect(labels[labels.length - 1]).toContain('Browse for another folder');
  });

  it('picks a folder on Enter, then creates the session on a second Enter', () => {
    const createQuickSession = vi.fn();
    const openQuickSession = vi.fn();
    seedStore({ createQuickSession, openQuickSession });
    render(<QuickSessionPicker />);
    fireEvent.keyDown(window, { key: 'ArrowDown' }); // alpha -> pinned
    fireEvent.keyDown(window, { key: 'Enter' });
    // Stage 2 shows the prompt area; nothing is created yet.
    expect(createQuickSession).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/First prompt/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(createQuickSession).toHaveBeenCalledWith('C:/work/pinned', { prompt: '', images: [] });
    expect(openQuickSession).toHaveBeenCalledWith(false);
  });

  it('sends the typed prompt with the session and keeps Shift+Enter for newlines', () => {
    const createQuickSession = vi.fn();
    seedStore({ createQuickSession });
    render(<QuickSessionPicker />);
    fireEvent.click(screen.getByText('C:/work/pinned'));
    const textarea = screen.getByPlaceholderText(/First prompt/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Fix the flaky test' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(createQuickSession).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(createQuickSession).toHaveBeenCalledWith('C:/work/pinned', { prompt: 'Fix the flaky test', images: [] });
  });

  it('backs out to the folder list on Escape while the prompt is empty', () => {
    const openQuickSession = vi.fn();
    seedStore({ openQuickSession });
    render(<QuickSessionPicker />);
    fireEvent.keyDown(window, { key: 'Enter' }); // pick the first folder
    expect(screen.getByPlaceholderText(/First prompt/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(openQuickSession).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button').length).toBeGreaterThan(1);
  });

  it('falls back to the folder-picker flow for the browse row', () => {
    const startNewSession = vi.fn();
    const openQuickSession = vi.fn();
    seedStore({ startNewSession, openQuickSession });
    render(<QuickSessionPicker />);
    const rows = screen.getAllByRole('button');
    fireEvent.click(rows[rows.length - 1]);
    expect(startNewSession).toHaveBeenCalled();
    expect(openQuickSession).toHaveBeenCalledWith(false);
  });

  it('closes on Escape without creating anything', () => {
    const createQuickSession = vi.fn();
    const openQuickSession = vi.fn();
    seedStore({ createQuickSession, openQuickSession });
    render(<QuickSessionPicker />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(openQuickSession).toHaveBeenCalledWith(false);
    expect(createQuickSession).not.toHaveBeenCalled();
  });
});
