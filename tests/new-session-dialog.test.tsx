/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, SessionMeta } from '../src/shared/types';
import { claudeSdkCatalog, mergeClaudeCatalog } from '../src/main/models/claude-catalog';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({
  invoke,
  on: vi.fn(),
  isMac: false,
  modKey: 'Ctrl',
}));

import { NewSessionDialog } from '../src/renderer/src/components/NewSessionDialog';
import { useStore } from '../src/renderer/src/store';

const settings = {
  defaultHarness: 'claude',
  defaultPermissionMode: 'ask',
  defaultEffort: undefined,
  defaultModelByHarness: {},
  folderSessionDefaults: {},
  favoriteModels: [],
  acpAgents: [],
} as unknown as AppSettings;

const createdSession = {
  id: 'new-session',
  title: 'New session',
  config: { harness: 'claude', projectRoot: 'G:/project', permissionMode: 'ask' },
} as SessionMeta;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'harness:models') return { models: [] };
    if (channel === 'sessions:create') return createdSession;
    if (channel === 'git:folderIsRepo') return { isRepo: true };
    return {};
  });
  useStore.setState({
    settings,
    sessions: [],
    activeId: null,
    availability: {},
    newSessionRoot: 'G:/project',
    openNewSession: vi.fn(),
    setActive: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
  } as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NewSessionDialog', () => {
  it('starts from the first prompt on Enter and keeps Shift+Enter for newlines', async () => {
    render(<NewSessionDialog />);
    // Starting waits for the model list and the folder's git probe; Enter is inert until then.
    const start = screen.getByTitle('Start from the prompt area with Enter') as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(invoke).toHaveBeenCalledWith('harness:models', expect.anything());

    const prompt = screen.getByPlaceholderText('What should the agent do?');
    fireEvent.change(prompt, { target: { value: 'Fix the flaky test' } });
    fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: true });
    expect(invoke).not.toHaveBeenCalledWith('sessions:create', expect.anything());

    fireEvent.keyDown(prompt, { key: 'Enter' });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'sessions:create',
        expect.objectContaining({ initialPrompt: 'Fix the flaky test' }),
      ),
    );
  });

  it('shows Enter as the start shortcut', () => {
    render(<NewSessionDialog />);
    const start = screen.getByTitle('Start from the prompt area with Enter');
    expect(start.textContent).toContain('↵');
    expect(start.textContent).not.toContain('Ctrl');
  });

  it('opens on the model Claude recommends and saves that version, not the moving default', async () => {
    // What Claude Code reports for a login, through the real mapping rather than an IPC fixture.
    const models = claudeSdkCatalog([
      { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks' },
      { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks' },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
    ]);
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'harness:models') return { models };
      if (channel === 'sessions:create') return createdSession;
      if (channel === 'git:folderIsRepo') return { isRepo: true };
      return {};
    });
    render(<NewSessionDialog />);
    const start = screen.getByTitle('Start from the prompt area with Enter') as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));

    const recommended = screen.getByTitle('anthropic/claude-opus-5-5[1m]').closest('button')!;
    expect(recommended.getAttribute('aria-pressed')).toBe('true');
    expect(recommended.textContent).toContain('Opus 5.5 with 1M context (recommended)');
    // The `[1m]` row carries the window it names instead of reading "unknown" — the recommended
    // model's context was the one thing only the static fallback used to know.
    expect(recommended.textContent).toContain('Context 1.00M');
    expect(screen.queryByTitle('anthropic/default')).toBeNull();
    fireEvent.click(start);

    const pinned = { provider: 'anthropic', model: 'claude-opus-5-5[1m]' };
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'sessions:create',
      expect.objectContaining({ config: expect.objectContaining({ model: pinned }) }),
    ));
    expect(invoke).toHaveBeenCalledWith('settings:update', expect.objectContaining({
      defaultModelByHarness: { claude: pinned },
      folderSessionDefaults: {
        'G:/project': expect.objectContaining({ modelByHarness: { claude: pinned } }),
      },
    }));
  });

  it.each([
    { provider: 'anthropic', model: 'claude-opus-5-5' },
    { provider: 'anthropic', model: 'claude-opus-5-5[1m]' },
    { provider: 'custom-anthropic', model: 'claude-opus-5-5' },
  ])('deduplicates normalized Claude rows and remembers the explicit $provider/$model selection', async (selected) => {
    const catalogSettings: AppSettings = {
      ...settings,
      providers: [{
        id: 'custom-anthropic',
        kind: 'anthropic',
        name: 'Custom Anthropic gateway',
        baseUrl: 'https://gateway.example.test',
        enabled: true,
        hasApiKey: true,
        models: [{ id: 'claude-opus-5-5', provider: 'custom-anthropic', displayName: 'Gateway Opus 5.5' }],
      }],
    };
    // The recommended default, aliases and explicit SDK entries resolve to the same canonical ids.
    // Exercise the real mapping and catalog merge rather than supplying a pre-deduplicated IPC fixture.
    const models = mergeClaudeCatalog(claudeSdkCatalog([
      { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      { value: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', description: 'Claude Opus 5.5' },
      { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5 with 1M context · Best for long sessions' },
    ]), catalogSettings);
    useStore.setState({ settings: catalogSettings });
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'harness:models') return { models };
      if (channel === 'sessions:create') return createdSession;
      if (channel === 'git:folderIsRepo') return { isRepo: true };
      return {};
    });
    render(<NewSessionDialog />);
    const start = screen.getByTitle('Start from the prompt area with Enter') as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));

    const titles = ['anthropic/claude-opus-5-5', 'anthropic/claude-opus-5-5[1m]', 'custom-anthropic/claude-opus-5-5'];
    const expectUniqueRows = () => {
      expect(screen.getAllByRole('button', { name: /^(anthropic|custom-anthropic)\// })).toHaveLength(titles.length);
      for (const title of titles) expect(screen.getAllByTitle(title)).toHaveLength(1);
    };
    const buttonFor = (title: string) => screen.getByTitle(title).closest('button')!;
    const pressed = () => titles.filter((title) => buttonFor(title).getAttribute('aria-pressed') === 'true');
    expectUniqueRows();
    // Claude's recommendation opens selected, under the concrete id it resolves to.
    expect(pressed()).toEqual(['anthropic/claude-opus-5-5']);

    const selectedTitle = `${selected.provider}/${selected.model}`;
    fireEvent.click(buttonFor(selectedTitle));
    expectUniqueRows();
    expect(pressed()).toEqual([selectedTitle]);
    fireEvent.click(start);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'sessions:create',
      expect.objectContaining({ config: expect.objectContaining({ model: selected }) }),
    ));
    expect(invoke.mock.calls.filter(([channel]) => channel === 'sessions:create')).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('settings:update', expect.objectContaining({
      defaultModelByHarness: { claude: selected },
      folderSessionDefaults: {
        'G:/project': expect.objectContaining({ modelByHarness: { claude: selected } }),
      },
    }));
  });

  it('does not offer an unlisted model id typed into the model search', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'harness:models') return { models: [{ id: 'claude-sonnet-5', provider: 'anthropic', displayName: 'Claude Sonnet 5' }] };
      if (channel === 'sessions:create') return createdSession;
      if (channel === 'git:folderIsRepo') return { isRepo: true };
      return {};
    });
    render(<NewSessionDialog />);
    // The catalog's first model becomes the selection; typing must not add a custom row alongside it.
    await screen.findByRole('button', { name: /Claude Sonnet 5/ });

    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'glm-4.6' } });
    expect(screen.queryByRole('button', { name: 'Use “glm-4.6”' })).toBeNull();

    // Starting submits the listed selection, never the typed id.
    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.anything()));
    const createCall = invoke.mock.calls.find(([channel]) => channel === 'sessions:create');
    expect((createCall?.[1] as { config: { model?: unknown } }).config.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });

  it('offers worktree isolation for a folder that is a git repository', async () => {
    render(<NewSessionDialog />);
    const toggle = screen.getByLabelText(/Isolate in a git worktree/) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(screen.getByText('(new branch under .vocs-code/worktrees)')).toBeTruthy();

    fireEvent.click(toggle);
    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.anything()));
    const call = invoke.mock.calls.find(([channel]) => channel === 'sessions:create');
    expect((call?.[1] as { config: { useWorktree?: boolean } }).config.useWorktree).toBe(true);
  });

  // A plain folder cannot host a worktree: `git worktree add` fails there, so creation died with
  // "Worktrees require a git repository." — including when only the remembered default asked for it.
  it('disables worktree isolation for a folder with no git repository and never asks for it', async () => {
    useStore.setState({ settings: { ...settings, folderSessionDefaults: { 'G:/project': { useWorktree: true } } } } as never);
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'harness:models') return { models: [] };
      if (channel === 'sessions:create') return createdSession;
      if (channel === 'git:folderIsRepo') return { isRepo: false };
      return {};
    });
    render(<NewSessionDialog />);

    const toggle = screen.getByLabelText(/Isolate in a git worktree/) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(true));
    // The remembered default must not survive as a checked-but-unusable toggle.
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('(unavailable — this folder is not a git repository)')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.anything()));
    const call = invoke.mock.calls.find(([channel]) => channel === 'sessions:create');
    expect((call?.[1] as { config: { useWorktree?: boolean } }).config.useWorktree).toBe(false);
  });
});
