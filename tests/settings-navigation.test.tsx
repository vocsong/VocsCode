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
  it('finds Vocs account sign-in and read-only Hub catalog in Connections', async () => {
    render(<SettingsView />);
    fireEvent.click(nav('Vocs account'));
    expect(screen.getByRole('heading', { name: 'Vocs account', level: 1 })).toBeTruthy();
    expect(screen.getByText(/Sign-in opens your system browser at auth.vocs.io/)).toBeTruthy();
    expect(screen.queryByText('Staging only')).toBeNull();
    expect(screen.getByRole('region', { name: 'Hub connections' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'catalog' } });
    fireEvent.click(screen.getByRole('button', { name: /Hub connections/ }));
    expect(nav('Vocs account').getAttribute('aria-current')).toBe('page');
    await act(async () => {});
  });

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

  it('distinguishes new-session defaults from settings that also affect existing sessions', () => {
    render(<SettingsView />);
    fireEvent.click(nav('Session defaults'));
    expect(within(screen.getByRole('region', { name: 'New sessions' })).getByText('These defaults do not change existing sessions. Each project keeps its remembered New Session choices.')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Context management' })).getByText(/also applies to existing sessions at their next idle boundary/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Goal defaults' })).getByText('Auto-continue and iteration defaults apply to new goals. The /goal preference also updates existing sessions.')).toBeTruthy();
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

  it('dismisses results with Escape, restores search focus and preserves the current draft', () => {
    const globalKey = vi.fn();
    render(<div onKeyDown={globalKey}><SettingsView /></div>);
    fireEvent.click(nav('Session defaults'));
    const draft = screen.getByLabelText('New branch prefix') as HTMLInputElement;
    fireEvent.change(draft, { target: { value: 'unsaved-prefix' } });
    const search = screen.getByRole('searchbox', { name: 'Search settings' }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'theme' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const result = screen.getByRole('button', { name: /Color theme/ });
    expect(document.activeElement).toBe(result);
    globalKey.mockClear();
    fireEvent.keyDown(result, { key: 'Escape' });
    expect(search.value).toBe('');
    expect(document.activeElement).toBe(search);
    expect(globalKey).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Session defaults', level: 1 })).toBeTruthy();
    expect(draft.value).toBe('unsaved-prefix');
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'settings:update')).toBe(false);
  });

  it('starts new and refined search results at the top rather than inheriting the page scroll', () => {
    const { container } = render(<SettingsView />);
    fireEvent.click(nav('Appearance'));
    const body = container.querySelector<HTMLDivElement>('.settings-body')!;
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    body.scrollTop = 500;
    fireEvent.change(search, { target: { value: 'p' } });
    expect(body.scrollTop).toBe(0);
    body.scrollTop = 400;
    fireEvent.change(search, { target: { value: 'pr' } });
    expect(body.scrollTop).toBe(0);
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

  it('finds /housekeep in Settings and focuses the recent-session protection field group', () => {
    render(<SettingsView />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: '/housekeep' } });
    fireEvent.click(screen.getByRole('button', { name: /Recent session protection/ }));
    expect(nav('Housekeep').getAttribute('aria-current')).toBe('page');
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Recent session protection' }));
    const days = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Protect sessions used in the last (days)' });
    expect(days.value).toBe('7');
    expect(screen.getByText(/0 disables only the age guard/)).toBeTruthy();
  });

  it('deep-links to Housekeep, rejects invalid drafts, and saves both inclusive bounds', async () => {
    openSettings('housekeep');
    render(<SettingsView />);
    expect(screen.getByRole('heading', { name: 'Housekeep', level: 1 })).toBeTruthy();
    const days = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Protect sessions used in the last (days)' });
    for (const value of ['', '-1', '1.5', '3651']) {
      fireEvent.change(days, { target: { value } });
      fireEvent.blur(days);
      expect(days.value).toBe('7');
      expect(screen.getByRole('alert').textContent).toContain('That value wasn’t saved');
    }
    expect(invokeMock).not.toHaveBeenCalled();

    fireEvent.change(days, { target: { value: '0' } });
    expect(invokeMock).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.blur(days);
      useStore.setState((s) => ({ settings: { ...s.settings!, housekeepRecentDays: 0 } }));
    });
    expect(days.value).toBe('0');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'settings:update', { housekeepRecentDays: 0 });

    fireEvent.change(days, { target: { value: '3650' } });
    await act(async () => {
      fireEvent.keyDown(days, { key: 'Enter' });
      useStore.setState((s) => ({ settings: { ...s.settings!, housekeepRecentDays: 3650 } }));
    });
    fireEvent.blur(days);
    expect(days.value).toBe('3650');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'settings:update', { housekeepRecentDays: 3650 });
    expect(invokeMock).toHaveBeenCalledTimes(2);
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
