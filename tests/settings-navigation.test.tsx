/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const invokeMock = vi.fn((channel: string) => Promise.resolve(channel === 'providers:list' ? [] : { models: [] }));
(window as unknown as { harness: unknown }).harness = { platform: 'win32', invoke: invokeMock, on: vi.fn(() => () => undefined) };
window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
vi.mock('../src/renderer/src/terminal/host', () => ({ createTerminal: vi.fn().mockResolvedValue(null) }));
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SettingsView, openSettings } from '../src/renderer/src/components/SettingsView';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings } from '../src/shared/types';

beforeEach(() => {
  invokeMock.mockClear();
  useStore.setState({ view: 'settings', settings: {
    theme: 'system', defaultHarness: 'claude', defaultPermissionMode: 'ask', notifications: true,
    goalDefaults: { autoContinue: false, maxIterations: 25 }, binaries: {}, providers: [], acpAgents: [],
    recentProjects: [], customShortcuts: {}, customBranchPrefixes: [],
  } as unknown as AppSettings });
});
afterEach(cleanup);

function nav(name: string) { return within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name }); }

describe('task-oriented settings navigation', () => {
  it('separates appearance and session defaults from everyday preferences', async () => {
    render(<SettingsView />);
    expect(screen.getByRole('heading', { name: 'General', level: 1 })).toBeTruthy();
    expect(screen.queryByText('Default harness')).toBeNull();
    fireEvent.click(nav('Session defaults'));
    expect(screen.getByLabelText(/Default harness/)).toBeTruthy();
    expect(nav('Session defaults').getAttribute('aria-current')).toBe('page');
    fireEvent.click(nav('Appearance'));
    expect(screen.getByRole('button', { name: 'System' })).toBeTruthy();
    expect(screen.queryByText('Default harness')).toBeNull();
  });

  it('finds a control by its vocabulary and opens its page, with a clear empty state', async () => {
    render(<SettingsView />);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'compaction' } });
    const result = screen.getByRole('button', { name: /Context management/ });
    expect(result.textContent).toContain('Session defaults');
    fireEvent.click(result);
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText(/Automatically compact context at/)).toBeTruthy();
    fireEvent.change(search, { target: { value: 'nothing-matches-this-query' } });
    expect(screen.getByText('No settings found')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByLabelText(/Automatically compact context at/)).toBeTruthy();
  });

  it('opens the first search result with Enter and clears search on a deep link', async () => {
    render(<SettingsView />);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'theme' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(nav('Appearance').getAttribute('aria-current')).toBe('page');
    fireEvent.change(search, { target: { value: 'does not exist' } });
    await act(async () => openSettings('sessions'));
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText(/Default harness/)).toBeTruthy();
  });

  it('keeps provider model drafts when filtering cards in and out', async () => {
    useStore.setState({ settings: { ...useStore.getState().settings!, providers: [
      { id: 'fixture', name: 'Fixture provider', kind: 'ollama', enabled: true, hasApiKey: false, models: [] },
    ] } });
    render(<SettingsView />);
    await act(async () => fireEvent.click(nav('Providers & keys')));
    const model = screen.getByPlaceholderText('Add a model id') as HTMLInputElement;
    fireEvent.change(model, { target: { value: 'unsaved-local-model' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter providers' }), { target: { value: 'different provider' } });
    expect(model.closest('.provider-card')?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show all providers' }));
    expect(model.closest('.provider-card')?.hasAttribute('hidden')).toBe(false);
    expect(model.value).toBe('unsaved-local-model');
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'providers:save')).toBe(false);
  });

  it('focuses settings search without swallowing modified global shortcuts', () => {
    const globalKey = vi.fn();
    render(<div onKeyDown={globalKey}><SettingsView /></div>);
    const editor = screen.getByLabelText(/Editor command/);
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true, altKey: true });
    expect(globalKey).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search settings' }));
    expect(globalKey).toHaveBeenCalledTimes(2);
  });

  it('retains existing setting writes and reports rejected automatic saves', async () => {
    render(<SettingsView />);
    const notifications = screen.getByRole('checkbox', { name: /Desktop notifications/ });
    fireEvent.click(notifications);
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { notifications: false });
    invokeMock.mockRejectedValueOnce(new Error('Disk is full'));
    await act(async () => fireEvent.change(screen.getByLabelText(/Editor command/), { target: { value: 'code-insiders' } }));
    expect(useStore.getState().toasts.some((toast) => toast.text.includes('Disk is full'))).toBe(true);
  });
});
