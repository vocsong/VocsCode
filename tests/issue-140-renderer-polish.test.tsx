/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, isMac: false, modKey: 'Ctrl', platform: 'win32' }));
vi.mock('../src/renderer/src/models', () => ({ useSessionModels: () => ({ models: [], loading: false }) }));
vi.mock('../src/renderer/src/terminal/host', () => ({
  clearFind: vi.fn(),
  clear: vi.fn(),
  createTerminal: vi.fn(),
  focus: vi.fn(),
  find: vi.fn(),
  mount: vi.fn(),
  recentOutput: vi.fn(() => ''),
  selectAll: vi.fn(),
  setFindHandler: vi.fn(),
  unmount: vi.fn()
}));

import { Composer } from '../src/renderer/src/components/Composer';
import { OnboardingWizard } from '../src/renderer/src/components/OnboardingWizard';
import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { ConfirmHost } from '../src/renderer/src/components/ui';
import { TerminalPanel } from '../src/renderer/src/components/TerminalPanel';
import * as host from '../src/renderer/src/terminal/host';
import { useStore } from '../src/renderer/src/store';

const session = (id: string): SessionMeta => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  config: { harness: 'native', projectRoot: 'G:/repo', permissionMode: 'ask' } as SessionMeta['config'],
  cwd: 'G:/repo',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
});

const settings = {
  theme: 'system',
  defaultHarness: 'native',
  defaultPermissionMode: 'ask',
  defaultModelByHarness: {},
  defaultEffort: undefined,
  autoCompactionThreshold: undefined,
  notifications: false,
  utilityModel: undefined,
  goalDefaults: { autoContinue: false, maxIterations: 25 },
  binaries: {},
  onboardingDone: false,
  folders: [],
  recentProjects: [],
  folderOrder: [],
  collapsedFolders: [],
  folderStyles: {},
  customLabels: [],
  customShortcuts: {},
  terminal: { shell: 'auto', customShellPath: '', customShellArgs: [], fontSize: 13, scrollback: 1000, cursorStyle: 'block', cursorBlink: true },
  acpAgents: []
} as unknown as AppSettings;

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) });
  invoke.mockReset();
  invoke.mockResolvedValue({});
  useStore.setState({ settings, sessions: [], activeId: null, terminals: [], terminalsLoaded: true, activeTerminal: {}, toasts: [] } as never);
});
afterEach(() => cleanup());

describe('issue 140 renderer error states', () => {
  it('shows when file mention search is unavailable', async () => {
    invoke.mockImplementation((channel: string) => channel === 'fs:search' ? Promise.reject(new Error('walk failed')) : Promise.resolve({}));
    render(<Composer session={session('s1')} />);
    const input = screen.getByPlaceholderText(/Message the agent/);
    fireEvent.change(input, { target: { value: '@src' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(screen.getByText('Search unavailable')).toBeTruthy();
  });

  it('surfaces provider list failures in Settings and onboarding', async () => {
    invoke.mockImplementation((channel: string) => channel === 'providers:list' ? Promise.reject(new Error('provider service offline')) : Promise.resolve({}));
    const settingsView = render(<SettingsView />);
    expect(await screen.findByText(/Provider list unavailable: provider service offline/)).toBeTruthy();
    settingsView.unmount();
    render(<OnboardingWizard />);
    expect(await screen.findByText(/Provider list unavailable: provider service offline/)).toBeTruthy();
  });

  it('clears active terminal search decorations on panel unmount', () => {
    useStore.setState({
      settings,
      sessions: [session('s1')],
      activeId: 's1',
      terminals: [{ id: 't1', sessionId: 's1', title: 'shell', shellName: 'shell', cwd: 'G:/repo', createdAt: 1 }],
      activeTerminal: { s1: 't1' },
      terminalsLoaded: true
    } as never);
    const view = render(<TerminalPanel session={session('s1')} />);
    view.unmount();
    expect(host.clearFind).toHaveBeenCalledWith('t1');
  });

  it('shows the fallback-secret warning in Providers', async () => {
    const provider = {
      id: 'openai',
      kind: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://one.example/v1',
      hasApiKey: true,
      models: [],
      enabled: true
    };
    useStore.setState({ settings: { ...settings, providers: [provider] }, sessions: [] } as never);
    invoke.mockImplementation((channel: string) => channel === 'secrets:status' ? Promise.resolve({ encryptionAvailable: false, hasFallback: true }) : Promise.resolve({}));
    render(<SettingsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Providers & keys' }));
    expect(await screen.findByText(/OS encryption is unavailable/)).toBeTruthy();
  });

  it('confirms a keyed provider endpoint change and does not save a cancelled draft', async () => {
    const provider = {
      id: 'openai',
      kind: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://one.example/v1',
      hasApiKey: true,
      models: [],
      enabled: true
    };
    useStore.setState({ settings: { ...settings, providers: [provider] }, sessions: [] } as never);
    render(
      <>
        <SettingsView />
        <ConfirmHost />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Providers & keys' }));
    const input = await screen.findByDisplayValue(provider.baseUrl);
    fireEvent.change(input, { target: { value: 'https://two.example/v1' } });
    fireEvent.blur(input);
    expect(await screen.findByText(/Change the endpoint for OpenAI/)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('providers:save', expect.anything());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect((screen.getByDisplayValue(provider.baseUrl) as HTMLInputElement).value).toBe(provider.baseUrl);

    fireEvent.change(screen.getByDisplayValue(provider.baseUrl), { target: { value: 'https://two.example/v1' } });
    fireEvent.blur(screen.getByDisplayValue('https://two.example/v1'));
    expect(await screen.findByText(/Change the endpoint for OpenAI/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change endpoint' }));
    await act(async () => undefined);
    expect(invoke).toHaveBeenCalledWith('providers:save', expect.objectContaining({ id: 'openai', baseUrl: 'https://two.example/v1' }));
  });
});
