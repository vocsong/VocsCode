/** Renderer surfaces IPC failures instead of silently swallowing them (issue #129). */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ErrorBoundary } from '../src/renderer/src/ErrorBoundary';
import { OnboardingWizard } from '../src/renderer/src/components/OnboardingWizard';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { TitleBar } from '../src/renderer/src/components/TitleBar';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const settings = {
  defaultHarness: 'native',
  folders: ['G:/proj/a'],
  folderStyles: {},
  folderOrder: [],
  collapsedFolders: [],
  customLabels: [],
  sidebarWidth: 280,
  panelWidth: 420
} as unknown as AppSettings;

const makeSession = (id: string, patch: Partial<SessionMeta> = {}): SessionMeta =>
  ({
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
  }) as SessionMeta;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  useStore.setState({
    settings,
    sessions: [],
    activeId: null,
    transcripts: {},
    loaded: {},
    transcriptErrors: {},
    availability: {},
    availabilityError: null,
    toasts: [],
    panelTab: 'changes',
    view: 'chat'
  });
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

const toastTexts = () => useStore.getState().toasts.map((t) => t.text);

describe('render errors', () => {
  it('shows a reload screen and reports the exception instead of leaving a blank window', async () => {
    const Boom = (): React.ReactNode => {
      throw new Error('kaboom');
    };
    // React logs the caught render error to console.error; keep the test output clean.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      );
      expect(screen.getByText('The interface hit an error')).toBeTruthy();
      expect(screen.getByText('kaboom')).toBeTruthy();
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('app:rendererError', expect.objectContaining({ message: 'kaboom' })));

      fireEvent.click(screen.getByText('Reload'));
      expect(invokeMock).toHaveBeenCalledWith('window:reload', undefined);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('availability check failures', () => {
  it('records the failure, renders a retry, and clears the error on a successful retry', async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'harness:availability') return Promise.reject(new Error('availability ipc down'));
      return Promise.resolve({});
    });

    render(<OnboardingWizard />);
    const retries = await screen.findAllByText(/could not check/i);
    expect(retries.length).toBeGreaterThan(0);
    expect(useStore.getState().availabilityError).toBe('availability ipc down');

    invokeMock.mockClear();
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'harness:availability') return Promise.resolve({ native: { available: true } });
      return Promise.resolve({});
    });
    fireEvent.click(retries[0]);

    await waitFor(() => expect(useStore.getState().availabilityError).toBeNull());
    expect(invokeMock).toHaveBeenCalledWith('harness:availability', undefined);
    expect(useStore.getState().availability.native).toMatchObject({ available: true });
  });
});

describe('transcript load failures', () => {
  it('stores the error, shows Retry instead of the spinner, and reloads on retry', async () => {
    const session = makeSession('s_t');
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'sessions:transcript') return Promise.reject(new Error('transcript unreadable'));
      return Promise.resolve({});
    });

    await useStore.getState().loadTranscript('s_t');
    expect(useStore.getState().transcriptErrors['s_t']).toBe('transcript unreadable');

    render(<Transcript session={session} />);
    expect(screen.getByText('transcript unreadable')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();

    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'sessions:transcript') return Promise.resolve([]);
      return Promise.resolve({});
    });
    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => expect(useStore.getState().loaded['s_t']).toBe(true));
    expect(useStore.getState().transcriptErrors['s_t']).toBeUndefined();
  });
});

describe('active session fallback', () => {
  it('selects the first remaining live session when the active one disappears', () => {
    useStore.setState({ sessions: [makeSession('s_a'), makeSession('s_b')], activeId: 's_b' });
    useStore.getState().setSessions([makeSession('s_a')]);
    expect(useStore.getState().activeId).toBe('s_a');

    useStore.getState().setSessions([makeSession('s_b', { archived: true })]);
    expect(useStore.getState().activeId).toBeNull();

    useStore.getState().setSessions([]);
    expect(useStore.getState().activeId).toBeNull();
  });
});

describe('rename failures', () => {
  it('toasts when a rename is rejected', async () => {
    useStore.setState({ sessions: [makeSession('s_r', { title: 'Old title' })], activeId: null });
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'sessions:rename') return Promise.reject(new Error('rename failed'));
      return Promise.resolve({});
    });

    const { container } = render(<Sidebar />);
    fireEvent.doubleClick(container.querySelector('.session-row') as HTMLElement);
    const input = container.querySelector('.session-rename') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(toastTexts().some((t) => t.includes('rename failed'))).toBe(true));
    expect(invokeMock).toHaveBeenCalledWith('sessions:rename', { id: 's_r', title: 'New title' });
  });
});

describe('fork failures', () => {
  it('toasts when a fork is rejected', async () => {
    useStore.setState({ sessions: [makeSession('s_f')], activeId: null });
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'sessions:fork') return Promise.reject(new Error('fork failed'));
      return Promise.resolve({});
    });

    const { container } = render(<Sidebar />);
    const forkBtn = [...container.querySelectorAll('.row-act-btn')].find((b) => b.getAttribute('aria-label') === 'Fork session') as HTMLElement;
    fireEvent.click(forkBtn);
    const claude = [...document.querySelectorAll('.dropdown-menu .menu-item')].find((i) => (i.textContent ?? '').includes('Claude')) as HTMLElement;
    fireEvent.click(claude);

    await waitFor(() => expect(toastTexts().some((t) => t.includes('fork failed'))).toBe(true));
    expect(invokeMock).toHaveBeenCalledWith('sessions:fork', { id: 's_f', harness: 'claude' });
  });
});

describe('title bar export failures', () => {
  it('toasts when an export is rejected', async () => {
    useStore.setState({ sessions: [makeSession('s_e')], activeId: 's_e' });
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'sessions:export') return Promise.reject(new Error('export failed'));
      return Promise.resolve({});
    });

    render(<TitleBar />);
    fireEvent.click([...document.querySelectorAll('.menubar-btn')].find((b) => b.textContent === 'File') as HTMLElement);
    const exportItem = [...document.querySelectorAll('.dropdown-menu .menu-item')].find((i) => (i.textContent ?? '').includes('Export transcript')) as HTMLElement;
    fireEvent.click(exportItem);

    await waitFor(() => expect(toastTexts().some((t) => t.includes('export failed'))).toBe(true));
    expect(invokeMock).toHaveBeenCalledWith('sessions:export', { id: 's_e' });
  });
});

describe('file preview failures', () => {
  it('toasts when reading a file is rejected', async () => {
    const session = makeSession('s_p');
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'fs:list') return Promise.resolve([{ name: 'notes.txt', path: 'notes.txt', isDir: false, size: 12 }]);
      if (channel === 'fs:read') return Promise.reject(new Error('read failed'));
      return Promise.resolve({});
    });
    useStore.setState({ panelTab: 'files' });

    render(<RightPanel session={session} />);
    fireEvent.click(await screen.findByText('notes.txt'));

    await waitFor(() => expect(toastTexts().some((t) => t.includes('read failed'))).toBe(true));
    expect(invokeMock).toHaveBeenCalledWith('fs:read', { sessionId: 's_p', path: 'notes.txt', maxBytes: 200_000 });
  });
});
