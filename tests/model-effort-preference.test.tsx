/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewSessionDialog } from '../src/renderer/src/components/NewSessionDialog';
import { useStore } from '../src/renderer/src/store';
import type { EffortLevel, ModelInfo } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, isMac: false, modKey: 'Ctrl' }));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let harnessModels: ModelInfo[] = [];

function settings(defaultEffort?: EffortLevel) {
  return {
    defaultHarness: 'claude',
    defaultPermissionMode: 'ask',
    defaultEffort,
    defaultUseWorktree: false,
    defaultModelByHarness: {},
    favoriteModels: [],
    acpAgents: []
  } as never;
}

function seed(defaultEffort?: EffortLevel) {
  useStore.setState({
    settings: settings(defaultEffort),
    sessions: [],
    activeId: null,
    newSessionOpen: true,
    newSessionRoot: 'G:/repo',
    availability: {},
    models: {},
    modelCatalog: {},
    loaded: {},
    transcripts: {},
    history: [],
    historyIndex: -1,
    toasts: []
  });
}

function effortSelect(): HTMLSelectElement {
  return screen.getByText('Reasoning effort').closest('.field')!.querySelector('select')!;
}

async function startSession() {
  const button = screen.getByRole('button', { name: /Start session/ }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  harnessModels = [];
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === 'harness:models') return Promise.resolve({ models: harnessModels });
    if (channel === 'sessions:create') return Promise.resolve({ id: 's_new' });
    if (channel === 'sessions:transcript') return Promise.resolve([]);
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('reasoning effort preference', () => {
  it('starts with the remembered effort and saves the next successful session choice', async () => {
    seed('low');
    render(<NewSessionDialog />);
    const select = effortSelect();
    expect(select.value).toBe('low');

    fireEvent.change(select, { target: { value: 'high' } });
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), { target: { value: 'Start immediately' } });
    await startSession();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:update', expect.objectContaining({ defaultEffort: 'high' })));
    expect(invoke).toHaveBeenCalledWith('sessions:create', expect.objectContaining({
      config: expect.objectContaining({ effort: 'high' }),
      initialPrompt: 'Start immediately'
    }));
    const settingsCall = invoke.mock.calls.findIndex(([channel]) => channel === 'settings:update');
    const createCall = invoke.mock.calls.findIndex(([channel]) => channel === 'sessions:create');
    expect(invoke.mock.invocationCallOrder[settingsCall]).toBeLessThan(invoke.mock.invocationCallOrder[createCall]);
  });

  it('remembers choosing the harness default', async () => {
    seed('high');
    render(<NewSessionDialog />);
    fireEvent.change(effortSelect(), { target: { value: '' } });
    await startSession();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:update', expect.objectContaining({ defaultEffort: undefined })));
    expect(invoke).toHaveBeenCalledWith('sessions:create', expect.objectContaining({ config: expect.objectContaining({ effort: undefined }) }));
  });

  it('waits for models, then uses the model default when the remembered effort is unsupported', async () => {
    let resolveModels!: (value: { models: ModelInfo[] }) => void;
    invoke.mockImplementation((channel: string) => {
      if (channel === 'harness:models') return new Promise((resolve) => { resolveModels = resolve; });
      if (channel === 'sessions:create') return Promise.resolve({ id: 's_new' });
      if (channel === 'sessions:transcript') return Promise.resolve([]);
      return Promise.resolve({});
    });
    seed('max');
    render(<NewSessionDialog />);
    const start = screen.getByRole('button', { name: /Start session/ }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);

    resolveModels({ models: [{
      id: 'limited',
      provider: 'anthropic',
      displayName: 'Limited',
      isDefault: true,
      supportedEfforts: ['low', 'medium'],
      defaultEffort: 'medium'
    }] });
    await waitFor(() => expect(effortSelect().value).toBe('medium'));
    await startSession();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.objectContaining({ config: expect.objectContaining({ effort: 'medium' }) })));
  });
});
