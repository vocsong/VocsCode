/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue([]);
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
};
(window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined });

vi.mock('../src/renderer/src/terminal/host', () => ({ createTerminal: vi.fn().mockResolvedValue(null) }));

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModelPicker } from '../src/renderer/src/components/ModelPicker';
import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, ModelInfo } from '../src/shared/types';

const settings = {
  theme: 'system',
  defaultHarness: 'claude',
  defaultPermissionMode: 'ask',
  defaultEffort: undefined,
  autoCompactionThreshold: undefined,
  favoriteModels: [],
  notifications: true,
  goalDefaults: { autoContinue: true, maxIterations: 25 },
  binaries: {},
  providers: [],
  acpAgents: [],
  utilityModel: undefined,
} as unknown as AppSettings;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useStore.setState({ settings, view: 'settings' });
});

afterEach(() => cleanup());

describe('context window UI', () => {
  it('names each model by its provider and shows a context value or an explicit unknown state', () => {
    const models: ModelInfo[] = [
      { id: 'known', provider: 'test', displayName: 'Known model', contextWindow: 272_000, pricing: { input: 2.5, output: 15 } },
      { id: 'unknown', provider: 'test', displayName: 'Unknown model' },
      { id: 'hand-added', provider: 'test', displayName: 'hand-added' },
    ];
    render(<ModelPicker models={models} selected={{ provider: 'test', model: 'known' }} onSelect={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: 'Search models' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /test\/known/ }).getAttribute('aria-pressed')).toBe('true');
    // The catalog's own label is a hint beside the context window, not the name.
    expect(screen.getByText('Known model · Context 272k · $2.5/$15')).toBeTruthy();
    expect(screen.getByText('Unknown model · Context unknown')).toBeTruthy();
    // A hand-added model labels itself with its id, so the hint does not repeat the name.
    expect(screen.getByText('Context unknown')).toBeTruthy();
  });

  it('pins the selected model to the top of the list, without duplicating it', () => {
    const models: ModelInfo[] = [
      { id: 'alpha', provider: 'acme', displayName: 'Alpha' },
      { id: 'beta', provider: 'acme', displayName: 'Beta' },
      { id: 'gamma', provider: 'other', displayName: 'Gamma' },
    ];
    const { container } = render(
      <ModelPicker models={models} selected={{ provider: 'other', model: 'gamma' }} onSelect={vi.fn()} />
    );

    const groups = [...container.querySelectorAll('.mp-list > .menu-group, .mp-list > div > .menu-group')];
    expect(groups[0]?.textContent).toBe('Selected');
    const firstRow = container.querySelector('.mp-list .mp-row');
    expect(firstRow?.querySelector('.mp-name')?.textContent).toBe('other/gamma');
    expect(firstRow?.querySelector('.mp-select')?.getAttribute('aria-pressed')).toBe('true');
    // The selected model is pinned once, not repeated under its provider group.
    expect(screen.getAllByText('other/gamma')).toHaveLength(1);
  });

  it('pins a selected model that is no longer in the catalog', () => {
    const models: ModelInfo[] = [{ id: 'alpha', provider: 'acme', displayName: 'Alpha' }];
    const { container } = render(
      <ModelPicker models={models} selected={{ provider: 'gone', model: 'removed-model' }} onSelect={vi.fn()} />
    );

    const rows = [...container.querySelectorAll('.mp-list .mp-row')];
    expect(rows).toHaveLength(2);
    expect(container.querySelector('.mp-list .menu-group')?.textContent).toBe('Selected');
    // A selection the catalog no longer lists is still named by its provider, not by the bare id.
    expect(rows[0]?.querySelector('.mp-name')?.textContent).toBe('gone/removed-model');
    expect(rows[0]?.querySelector('.mp-select')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('pins the harness-default row when the current selection is default', () => {
    const models: ModelInfo[] = [
      { id: 'alpha', provider: 'acme', displayName: 'Alpha' },
      { id: 'beta', provider: 'acme', displayName: 'Beta' },
    ];
    const { container } = render(<ModelPicker models={models} clearOption={{ label: 'Harness default' }} onSelect={vi.fn()} />);

    expect(container.querySelector('.mp-list .menu-group')?.textContent).toBe('Selected');
    const pinned = container.querySelector('.mp-list .menu-item.active');
    expect(pinned?.textContent).toContain('Harness default');
    expect(screen.getAllByText('Harness default')).toHaveLength(1);
  });

  it('offers every requested auto-compaction preset and persists the selection', () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Session defaults' }));
    const select = screen.getByText('Automatically compact context at').closest('label')?.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((option) => option.text)).toEqual([
      'Harness default',
      '50% of context window',
      '75% of context window',
      '90% of context window',
      '100k tokens',
      '250k tokens',
      '500k tokens',
      '750k tokens',
      '1M tokens',
    ]);

    fireEvent.change(select, { target: { value: '750k' } });
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { autoCompactionThreshold: '750k' });
  });
});
