/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FolderBranch } from '../src/renderer/src/components/FolderBranch';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { useStore } from '../src/renderer/src/store';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, isMac: false, modKey: 'Ctrl' }));

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  invoke.mockResolvedValue({ branch: 'develop' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('folder branch in the sidebar', () => {
  it('shows a saved empty folder checkout beside its name without a session', async () => {
    useStore.setState({ sessions: [], settings: { folders: ['G:\\Vocs-Code'] } as never });
    await act(async () => { render(<Sidebar />); });
    const folder = screen.getByText('Vocs-Code').closest('.project-header');
    expect(folder?.querySelector('.project-branch')?.textContent).toBe('develop');
    expect(invoke).toHaveBeenCalledWith('git:folderBranch', { projectRoot: 'G:\\Vocs-Code' });
  });

  it('does not poll while collapsed, then resumes polling when expanded', async () => {
    const view = render(<FolderBranch root="/repo" expanded={false} />);
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalled();
    view.rerender(<FolderBranch root="/repo" expanded />);
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('git:folderBranch', { projectRoot: '/repo' });
    invoke.mockClear();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(invoke).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('refreshes external checkouts on the timer and on focus, then cleans up', async () => {
    const view = render(<FolderBranch root="/repo" />);
    await act(async () => {});
    expect(screen.getByText('develop')).toBeTruthy();
    invoke.mockResolvedValue({ branch: 'feature/CaseSensitive' });
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText('feature/CaseSensitive')).toBeTruthy();
    invoke.mockResolvedValue({ branch: 'abc1234', detached: true });
    await act(async () => { fireEvent.focus(window); });
    expect(screen.getByText('Detached HEAD (abc1234)')).toBeTruthy();
    view.unmount();
    invoke.mockClear();
    await act(async () => { vi.advanceTimersByTime(10_000); fireEvent.focus(window); });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('clears stale labels when a folder stops being a repository or a read fails', async () => {
    const view = render(<FolderBranch root="/repo" />);
    await act(async () => {});
    invoke.mockResolvedValue({});
    await act(async () => { fireEvent.focus(window); });
    expect(view.container.textContent).toBe('');
    invoke.mockResolvedValue({ branch: 'main' });
    await act(async () => { fireEvent.focus(window); });
    expect(screen.getByText('main')).toBeTruthy();
    invoke.mockRejectedValue(new Error('Folder unavailable'));
    await act(async () => { fireEvent.focus(window); });
    expect(view.container.textContent).toBe('');
  });

  it('ignores a late response after switching folders', async () => {
    let resolveOld!: (value: { branch: string }) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const view = render(<FolderBranch root="/old" />);
    view.rerender(<FolderBranch root="/new" />);
    await act(async () => {});
    await act(async () => { resolveOld({ branch: 'stale' }); });
    expect(screen.queryByText('stale')).toBeNull();
    expect(screen.getByText('develop')).toBeTruthy();
  });
});
