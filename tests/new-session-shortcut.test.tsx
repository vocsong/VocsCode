/**
 * Ctrl+Shift+N is the sidebar's per-folder New session button from the keyboard: the dialog opens
 * on the folder of the session you are on, and no native folder picker is raised. With no session
 * there is no folder to seed, so it falls back to the folder picker.
 */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, on: vi.fn(), isMac: false, isWeb: false, platform: 'win32', modKey: 'Ctrl' }));
vi.mock('../src/renderer/src/terminal/host', () => ({ createTerminal: vi.fn().mockResolvedValue(null) }));

import { App } from '../src/renderer/src/App';
import { useStore } from '../src/renderer/src/store';

const settings = {
  theme: 'dark',
  defaultHarness: 'native',
  defaultPermissionMode: 'ask',
  defaultEffort: undefined,
  defaultModelByHarness: {},
  favoriteModels: [],
  acpAgents: [],
  providers: [],
  mcpServers: [],
  modelOverrides: {},
  binaries: {},
  recentProjects: [],
  folders: [],
  folderStyles: {},
  customLabels: [],
  collapsedFolders: [],
  customShortcuts: {},
  sidebarWidth: 260,
  panelWidth: 380,
  panelSplit: 0.62,
  goalDefaults: { autoContinue: true, maxIterations: 25 },
  terminal: {},
  onboardingDone: true
} as unknown as AppSettings;

const session = (id: string, projectRoot: string): SessionMeta => ({
  id,
  title: id,
  createdAt: 1_000,
  updatedAt: 1_000,
  config: { harness: 'native', projectRoot, permissionMode: 'ask' } as SessionMeta['config'],
  cwd: projectRoot,
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
});

const pressNewSessionHere = () => fireEvent.keyDown(window, { key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true });

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined });
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'app:pickFolder') return { path: null };
    if (channel === 'harness:models') return { models: [] };
    return {};
  });
  useStore.setState({
    booted: true,
    bootError: null,
    settings,
    sessions: [],
    activeId: null,
    view: 'chat',
    sidebarOpen: false,
    panelOpen: false,
    newSessionOpen: false,
    newSessionRoot: null,
    quickSessionOpen: false,
    paletteOpen: false
  } as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Ctrl+Shift+N', () => {
  it('opens the new-session dialog on the active session\u2019s folder without the folder picker', async () => {
    useStore.setState({ sessions: [session('s1', 'G:/proj/a')], activeId: 's1' });
    render(<App />);

    pressNewSessionHere();

    await waitFor(() => expect(document.querySelector('.ns-root')?.textContent).toBe('G:/proj/a'));
    expect(invoke).not.toHaveBeenCalledWith('app:pickFolder', expect.anything());
    // The quick picker is Ctrl+N; Ctrl+Shift+N must not fall through to it.
    expect(useStore.getState().quickSessionOpen).toBe(false);
  });

  it('falls back to the folder picker when there is no session to take a folder from', async () => {
    render(<App />);

    pressNewSessionHere();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app:pickFolder', expect.anything()));
    expect(document.querySelector('.ns-root')).toBeNull();
  });
});
