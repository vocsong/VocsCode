/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { VocsAccountState } from '../src/shared/vocs-account';
const api = vi.hoisted(() => ({ invoke: vi.fn(), isWeb: false }));
vi.mock('../src/renderer/src/api', () => api);
import { VocsAccountSettings } from '../src/renderer/src/components/VocsAccountSettings';
const out = (revision = 1): VocsAccountState => ({ realm: 'staging', status: 'signed_out', revision, refreshing: false, connections: [] });
const connected = (revision = 3): VocsAccountState => ({ ...out(revision), status: 'signed_in', accountId: 'opaque-account-a', expiresAt: Date.now() + 300000, connections: [{ id: 'openrouter', name: 'OpenRouter', transport: 'streamable-http', resource: 'https://vocs-mcp-staging.vocs.workers.dev/openrouter', authorizationServer: 'https://vocs-mcp-staging.vocs.workers.dev', accountScopes: ['models:read'], authorization: 'oauth_required', executionReadiness: 'not_checked' }] });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
beforeEach(() => { api.isWeb = false; api.invoke.mockReset().mockResolvedValue(out()); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function ready() { render(<VocsAccountSettings />); await screen.findByText('Signed out'); }
describe('staging Vocs account settings', () => {
  it('labels temporary staging clearly and does not authorize anything on mount', async () => {
    await ready();
    expect(screen.getByText('Staging only')).toBeTruthy();
    expect(screen.getByText(/Local projects and existing tools remain available/)).toBeTruthy();
    expect(screen.getByText(/Persistent sign-in is not enabled/)).toBeTruthy();
    expect(api.invoke.mock.calls).toEqual([['vocsAccount:get', undefined]]);
  });
  it('deduplicates sign-in and cancels without accepting an abandoned completion', async () => {
    const sign = deferred<VocsAccountState>();
    api.invoke.mockImplementation((channel) => channel === 'vocsAccount:signIn' ? sign.promise : Promise.resolve(out(channel === 'vocsAccount:cancel' ? 4 : 1)));
    await ready();
    const button = screen.getByRole('button', { name: 'Sign in to staging' });
    fireEvent.click(button); fireEvent.click(button);
    expect(api.invoke.mock.calls.filter(([c]) => c === 'vocsAccount:signIn')).toHaveLength(1);
    expect(screen.getByText('Waiting for browser sign-in…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    await screen.findByText('Signed out');
    await act(async () => sign.resolve(connected(3)));
    expect(screen.queryByText('opaque-account-a')).toBeNull();
    expect(screen.queryByText('OpenRouter')).toBeNull();
  });
  it('cancel on leaving prevents a pending browser sign-in from leaking into the next page', async () => {
    const sign = deferred<VocsAccountState>();
    api.invoke.mockImplementation((c) => c === 'vocsAccount:signIn' ? sign.promise : Promise.resolve(out()));
    const view = render(<VocsAccountSettings />); await screen.findByText('Signed out');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to staging' }));
    view.unmount();
    expect(api.invoke.mock.calls.filter(([c]) => c === 'vocsAccount:cancel')).toHaveLength(1);
    await act(async () => sign.resolve(connected()));
    expect(screen.queryByText('OpenRouter')).toBeNull();
  });
  it('renders descriptive catalog only and an account switch wins a pending refresh', async () => {
    const refresh = deferred<VocsAccountState>();
    api.invoke.mockImplementation((c) => c === 'vocsAccount:refresh' ? refresh.promise : Promise.resolve(c === 'vocsAccount:signOut' ? out(5) : c === 'vocsAccount:signIn' ? { ...connected(6), accountId: 'opaque-account-b', connections: [] } : connected()));
    render(<VocsAccountSettings />); await screen.findByText('OpenRouter');
    expect(screen.getByText('Separate authorization required')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(connect|install|run)$/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('Signed out');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to staging' }));
    await screen.findByText('opaque-account-b');
    await act(async () => refresh.resolve(connected(4)));
    expect(screen.getByText('opaque-account-b')).toBeTruthy();
    expect(screen.queryByText('OpenRouter')).toBeNull();
    expect(screen.queryByText('opaque-account-a')).toBeNull();
  });
  it('renders failures safely, supports retry, and does not surface IPC exception contents', async () => {
    api.invoke.mockRejectedValueOnce(new Error('secret-token-DO-NOT-PRINT')).mockResolvedValue(out());
    render(<VocsAccountSettings />);
    await screen.findByRole('alert');
    expect(screen.queryByText(/secret-token/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry status' }));
    await screen.findByText('Signed out');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('ignores a stale polling revision after a newer state has been observed', async () => {
    vi.useFakeTimers();
    api.invoke.mockResolvedValue(connected(5));
    render(<VocsAccountSettings />);
    await act(async () => {});
    api.invoke.mockResolvedValue(out(1));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('OpenRouter')).toBeTruthy();
    api.invoke.mockResolvedValue(out(6));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('Signed out')).toBeTruthy();
    expect(screen.queryByText('OpenRouter')).toBeNull();
  });
  it('does not restore cached account state while sign-out is pending, including an earlier poll', async () => {
    vi.useFakeTimers();
    const poll = deferred<VocsAccountState>(), logout = deferred<VocsAccountState>();
    api.invoke.mockResolvedValueOnce(connected(3)).mockImplementation((c) => c === 'vocsAccount:signOut' ? logout.promise : poll.promise);
    render(<VocsAccountSettings />);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.queryByText('opaque-account-a')).toBeNull();
    await act(async () => poll.resolve(connected(3)));
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(api.invoke.mock.calls.filter(([c]) => c === 'vocsAccount:get')).toHaveLength(2);
    expect(screen.queryByText('opaque-account-a')).toBeNull();
    await act(async () => logout.resolve(out(4)));
    expect(screen.getByText('Signed out')).toBeTruthy();
  });
  it('clears a transient read error after background recovery', async () => {
    vi.useFakeTimers();
    api.invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(out());
    render(<VocsAccountSettings />); await act(async () => {});
    expect(screen.getByRole('alert')).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps account management out of remote browser sessions', () => {
    api.isWeb = true;
    render(<VocsAccountSettings />);
    expect(screen.getByText(/Remote browser access cannot authorize/)).toBeTruthy();
    expect(api.invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Sign in to staging' })).toBeNull();
  });
});
