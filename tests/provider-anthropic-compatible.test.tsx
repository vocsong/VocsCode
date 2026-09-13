/** @vitest-environment jsdom */
/** A gateway can back Claude Code only when it is added as an Anthropic-compatible provider, and a
 *  gateway that publishes no catalog needs its model ids entered by hand. */
import type { AppSettings, ProviderConfig } from '../src/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { useStore } from '../src/renderer/src/store';

const baseSettings = {
  theme: 'system',
  defaultHarness: 'claude',
  defaultPermissionMode: 'ask',
  defaultModelByHarness: {},
  favoriteModels: [],
  notifications: false,
  goalDefaults: { autoContinue: false, maxIterations: 25 },
  binaries: {},
  providers: [],
  acpAgents: [],
  customShortcuts: {},
  folders: [],
  terminal: { shell: 'auto', customShellPath: '', customShellArgs: [], fontSize: 13, scrollback: 1000, cursorStyle: 'block', cursorBlink: true }
} as unknown as AppSettings;

const anthropicProvider: ProviderConfig = {
  id: 'anthropic',
  kind: 'anthropic',
  name: 'Anthropic',
  baseUrl: 'https://api.anthropic.com',
  hasApiKey: false,
  models: [],
  enabled: true
};

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
  invoke.mockReset();
  invoke.mockResolvedValue({});
  useStore.setState({ settings: { ...baseSettings, providers: [anthropicProvider] }, sessions: [], activeId: null } as never);
});
afterEach(() => cleanup());

function openProviders(): void {
  render(<SettingsView />);
  fireEvent.click(screen.getByRole('button', { name: 'Providers & keys' }));
}

describe('Anthropic-compatible providers', () => {
  it('adds an Anthropic-compatible provider so Claude Code can run on it', async () => {
    openProviders();
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    fireEvent.change(screen.getByPlaceholderText('id (letters, dashes)'), { target: { value: 'zai' } });
    fireEvent.change(screen.getByPlaceholderText('Display name'), { target: { value: 'Z.AI (GLM)' } });
    fireEvent.change(screen.getByPlaceholderText('Base URL (…/v1)'), { target: { value: 'https://api.z.ai/api/anthropic' } });
    const card = screen.getByPlaceholderText('Base URL (…/v1)').closest('.provider-card') as HTMLElement;
    fireEvent.change(within(card).getByRole('combobox'), { target: { value: 'anthropic' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Add provider' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'providers:save',
        expect.objectContaining({ id: 'zai', kind: 'anthropic', name: 'Z.AI (GLM)', baseUrl: 'https://api.z.ai/api/anthropic' })
      )
    );
  });

  it('accepts a model id for an endpoint that publishes no catalog', async () => {
    useStore.setState({ settings: { ...baseSettings, providers: [{ ...anthropicProvider, baseUrl: 'https://api.z.ai/api/anthropic' }] } } as never);
    openProviders();
    const input = screen.getByPlaceholderText('Add a model id');
    const card = input.closest('.provider-card') as HTMLElement;
    fireEvent.change(input, { target: { value: 'glm-4.6' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'providers:save',
        expect.objectContaining({ id: 'anthropic', models: [expect.objectContaining({ id: 'glm-4.6', provider: 'anthropic' })] })
      )
    );
  });

  it('removes a model id when its chip is clicked', async () => {
    const withModel: ProviderConfig = { ...anthropicProvider, models: [{ id: 'glm-4.6', provider: 'anthropic', displayName: 'glm-4.6' }] };
    useStore.setState({ settings: { ...baseSettings, providers: [withModel] } } as never);
    openProviders();
    fireEvent.click(screen.getByRole('button', { name: 'glm-4.6 ×' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('providers:save', expect.objectContaining({ id: 'anthropic', models: [] })));
  });
});
