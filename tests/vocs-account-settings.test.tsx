/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { VocsAccountState } from '../src/shared/vocs-account';
const api = vi.hoisted(() => ({ invoke: vi.fn(), isWeb: false }));
vi.mock('../src/renderer/src/api', () => api);
import { VocsAccountSettings } from '../src/renderer/src/components/VocsAccountSettings';
const out = (revision = 1): VocsAccountState => ({ realm: 'staging', status: 'signed_out', revision, refreshing: false, connections: [], deviceSignIn: true, keychain: true });
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
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Keep me signed in on this computer' }).checked).toBe(true);
    expect(api.invoke.mock.calls).toEqual([['vocsAccount:get', undefined]]);
  });
  it('labels production without staging wording and keeps staging labels behind the staging realm', async () => {
    api.invoke.mockResolvedValue({ ...out(), realm: 'production', deviceSignIn: false });
    render(<VocsAccountSettings />); await screen.findByText('Signed out');
    expect(screen.queryByText('Staging only')).toBeNull();
    expect(screen.getByText(/Sign-in opens your system browser at auth.vocs.io/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in with Vocs' })).toBeTruthy();
    expect(screen.queryByText(/staging/i)).toBeNull();
    api.invoke.mockResolvedValue({ ...connected(4), realm: 'production' });
    await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
    expect(screen.getByText('Connected to Vocs')).toBeTruthy();
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
  it('keeps the sign-in button in place, disabled, so a double-click never lands on Cancel', async () => {
    const sign = deferred<VocsAccountState>();
    api.invoke.mockImplementation((channel) => channel === 'vocsAccount:signIn' ? sign.promise : Promise.resolve(out()));
    await ready();
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in to staging' });
    fireEvent.click(button);
    // A real double-click's second click hits whatever is at the same point: the same, now disabled, node.
    expect(button.isConnected).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.nextElementSibling?.textContent).toBe('Cancel sign-in');
    fireEvent.click(button);
    expect(api.invoke.mock.calls.filter(([c]) => c === 'vocsAccount:cancel')).toHaveLength(0);
    expect(api.invoke.mock.calls.filter(([c]) => c === 'vocsAccount:signIn')).toHaveLength(1);
    expect(screen.getByText('Waiting for browser sign-in…')).toBeTruthy();
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
  it('says on the next visit that leaving cancelled the sign-in, and clears it on the next action', async () => {
    const sign = deferred<VocsAccountState>();
    api.invoke.mockImplementation((c) => c === 'vocsAccount:signIn' ? sign.promise : Promise.resolve(out()));
    const view = render(<VocsAccountSettings />); await screen.findByText('Signed out');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to staging' }));
    view.unmount();
    render(<VocsAccountSettings />); await screen.findByText('Signed out');
    expect(screen.getByText(/Sign-in was cancelled because you left this page/)).toBeTruthy();
    api.invoke.mockImplementation((c) => c === 'vocsAccount:signIn' ? new Promise(() => undefined) : Promise.resolve(out()));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to staging' }));
    expect(screen.queryByText(/Sign-in was cancelled because you left this page/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    await screen.findByText('Signed out');
    cleanup();
    // A visit that did not leave a pending sign-in shows no such notice.
    render(<VocsAccountSettings />); await screen.findByText('Signed out');
    expect(screen.queryByText(/you left this page/)).toBeNull();
  });
  it('offers sign-in, not a status re-read, after a refused or expired sign-in', async () => {
    api.invoke.mockResolvedValue({ ...out(), error: 'Session expired. Sign in again.' });
    await ready();
    expect(screen.getByRole('alert').textContent).toContain('Session expired. Sign in again.');
    expect(screen.queryByRole('button', { name: 'Retry status' })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in to staging' }).disabled).toBe(false);
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
  it('keeps me signed in by default, and sends only that choice with sign-in', async () => {
    api.invoke.mockImplementation((c) => Promise.resolve(c === 'vocsAccount:signIn' ? { ...connected(4), persistent: true, expiresAt: undefined, deviceExpiresAt: Date.UTC(2027, 10, 18), keychain: true } : out()));
    await ready();
    expect(screen.getByText(/Stays signed in for up to a year \(90 days unused\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to staging' }));
    await screen.findByText('opaque-account-a');
    expect(api.invoke.mock.calls.filter(([c]) => c === 'vocsAccount:signIn')).toEqual([['vocsAccount:signIn', { persist: true }]]);
    expect(screen.getByTestId('vocs-account-session').textContent).toBe(`Stays signed in on this computer until ${new Date(Date.UTC(2027, 10, 18)).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/five minutes/)).toBeNull();
  });
  it('a cleared checkbox signs in for this session only, as before', async () => {
    api.invoke.mockImplementation((c) => Promise.resolve(c === 'vocsAccount:signIn' ? connected(4) : out()));
    await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep me signed in on this computer' }));
    expect(screen.getByText(/lasts up to five minutes and is kept only in memory/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to staging' }));
    await screen.findByText('opaque-account-a');
    expect(api.invoke.mock.calls.filter(([c]) => c === 'vocsAccount:signIn')).toEqual([['vocsAccount:signIn', { persist: false }]]);
    expect(screen.getByText(/This session lasts up to five minutes/)).toBeTruthy();
  });
  it('shows restoring with sign-out only, and offline with Retry and sign-out', async () => {
    api.invoke.mockResolvedValue({ ...out(), status: 'restoring' });
    render(<VocsAccountSettings />); await screen.findByText('Restoring your sign-in…');
    expect(screen.queryByRole('button', { name: 'Sign in to staging' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Retry/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    cleanup();
    api.invoke.mockImplementation((c) => Promise.resolve(c === 'vocsAccount:refresh' ? { ...connected(9), persistent: true, expiresAt: undefined, deviceExpiresAt: Date.now() + 1e10 } : { ...out(5), status: 'offline' }));
    render(<VocsAccountSettings />); await screen.findByText(/Can’t reach Vocs. Your sign-in is still kept on this computer./);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('opaque-account-a');
    expect(api.invoke.mock.calls.filter(([c]) => c === 'vocsAccount:refresh')).toHaveLength(1);
  });
  it('says the sign-in ended and offers sign-in again', async () => {
    api.invoke.mockResolvedValue({ ...out(), error: 'Your sign-in ended. Sign in again.' });
    await ready();
    expect(screen.getByRole('alert').textContent).toContain('Your sign-in ended. Sign in again.');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in to staging' }).disabled).toBe(false);
  });
  it('hides "Keep me signed in" where the realm does not offer it, and signs in temporarily', async () => {
    api.invoke.mockImplementation((c) => Promise.resolve(c === 'vocsAccount:signIn' ? { ...connected(4), realm: 'production' } : { ...out(), realm: 'production', deviceSignIn: false }));
    render(<VocsAccountSettings />); await screen.findByText('Signed out');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/lasts up to five minutes and is kept only in memory/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Vocs' }));
    await screen.findByText('opaque-account-a');
    expect(api.invoke.mock.calls.filter(([c]) => c === 'vocsAccount:signIn')).toEqual([['vocsAccount:signIn', { persist: false }]]);
  });
  it('without a keychain the box stays on and enabled, says the sign-in ends at close, and keeps the choice', async () => {
    api.invoke.mockImplementation((c) => Promise.resolve(c === 'vocsAccount:signIn' ? connected(4) : { ...out(), keychain: false }));
    await ready();
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Keep me signed in on this computer' });
    expect(box.checked).toBe(true); expect(box.disabled).toBe(false);
    expect(screen.getByText('This computer has no secure keychain, so you’ll be signed out when Vocs Code closes.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to staging' }));
    await screen.findByText('opaque-account-a');
    expect(api.invoke.mock.calls.filter(([c]) => c === 'vocsAccount:signIn')).toEqual([['vocsAccount:signIn', { persist: true }]]);
  });
  it('explains a sign-in that could not be saved', async () => {
    api.invoke.mockResolvedValue({ ...connected(), persistent: true, expiresAt: undefined, deviceExpiresAt: Date.now() + 1e10, keychain: false, notice: 'Vocs Code could not save your sign-in on this computer. You stay signed in until Vocs Code closes.' });
    render(<VocsAccountSettings />); await screen.findByText('opaque-account-a');
    expect(screen.getByTestId('vocs-account-session').textContent).toBe('Signed in until Vocs Code closes');
    expect(screen.getByText('This computer has no secure keychain, so you’ll be signed out when Vocs Code closes.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/could not save your sign-in/);
  });
  it('keeps account management out of remote browser sessions', () => {
    api.isWeb = true;
    render(<VocsAccountSettings />);
    expect(screen.getByText(/Remote browser access cannot authorize/)).toBeTruthy();
    expect(api.invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Sign in to staging' })).toBeNull();
  });
});
