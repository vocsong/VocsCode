/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, SessionMeta } from '../src/shared/types';

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
  defaultUseWorktree: false,
  defaultModelByHarness: {},
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
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('harness:models', expect.anything()));

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

  it('starts a session on a typed custom model id the catalog does not list', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'harness:models') return { models: [{ id: 'claude-sonnet-5', provider: 'anthropic', displayName: 'Claude Sonnet 5' }] };
      if (channel === 'sessions:create') return createdSession;
      return {};
    });
    render(<NewSessionDialog />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('harness:models', expect.anything()));

    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'glm-4.6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use “glm-4.6”' }));
    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'sessions:create',
        expect.objectContaining({ config: expect.objectContaining({ model: { provider: 'anthropic', model: 'glm-4.6' } }) }),
      ),
    );
  });
});
