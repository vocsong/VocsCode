// Settings → General → Worktree branches: the saved custom branch prefixes every project's New
// Session dialog offers after vocscode/, feat/, fix/ and chore/ — adding, refusing and removing.
/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockImplementation((channel: string) => Promise.resolve(channel === 'providers:list' ? [] : {}));
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};
(window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined });

vi.mock('../src/renderer/src/terminal/host', () => ({ createTerminal: vi.fn().mockResolvedValue(null) }));

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings } from '../src/shared/types';

const settings = {
  theme: 'system',
  defaultHarness: 'claude',
  defaultPermissionMode: 'ask',
  notifications: true,
  goalDefaults: { autoContinue: true, maxIterations: 25 },
  binaries: {},
  providers: [],
  acpAgents: [],
  recentProjects: [],
  customShortcuts: {},
  customBranchPrefixes: ['ops', 'team/feat']
} as unknown as AppSettings;

const prefixUpdates = () => invokeMock.mock.calls.filter(([channel, patch]) => channel === 'settings:update' && 'customBranchPrefixes' in (patch as object)).map(([, patch]) => (patch as Partial<AppSettings>).customBranchPrefixes);

beforeEach(() => {
  cleanup();
  invokeMock.mockClear();
  useStore.setState({ view: 'settings', settings: { ...settings } });
});

describe('Settings → Worktree branches', () => {
  it('lists the saved prefixes and removes one', () => {
    render(<SettingsView />);
    expect(screen.getByText('ops/')).toBeTruthy();
    expect(screen.getByText('team/feat/')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Remove ops/'));

    expect(prefixUpdates()).toEqual([['team/feat']]);
  });

  it('adds a typed prefix in its stored form, newest first', () => {
    render(<SettingsView />);
    fireEvent.change(screen.getByLabelText('New branch prefix'), { target: { value: ' bug/ ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(prefixUpdates()).toEqual([['bug', 'ops', 'team/feat']]);
    expect((screen.getByLabelText('New branch prefix') as HTMLInputElement).value).toBe('');
  });

  it('refuses a prefix that is already offered or that git cannot take', () => {
    render(<SettingsView />);
    const input = screen.getByLabelText('New branch prefix');
    const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: 'feat/' } });
    expect(screen.getByText('feat/ is already offered.')).toBeTruthy();
    expect(add.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'my feature' } });
    expect(screen.getByText(/Not a valid branch prefix/)).toBeTruthy();
    expect(add.disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(prefixUpdates()).toEqual([]);
  });
});
