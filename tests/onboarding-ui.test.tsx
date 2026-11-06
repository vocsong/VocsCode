/** @vitest-environment jsdom */
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HARNESS_BY_ID } from '../src/shared/harness-meta';
import type { AppSettings, HarnessId, ModelInfo, ProviderConfig } from '../src/shared/types';
import type { HarnessSetupStatus } from '../src/shared/harness-setup';
const invokeMock = vi.fn();
(window as unknown as { harness: unknown }).harness = { platform: 'win32', invoke: invokeMock, on: vi.fn(() => () => undefined) };
window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
vi.mock('../src/renderer/src/terminal/host', () => ({ createTerminal: vi.fn().mockResolvedValue(null) }));
import { OnboardingWizard } from '../src/renderer/src/components/OnboardingWizard';
import { OnboardingProvider } from '../src/renderer/src/components/OnboardingProvider';
import { HarnessSetup } from '../src/renderer/src/components/HarnessSetup';
import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { Modal } from '../src/renderer/src/components/ui';
import { useStore } from '../src/renderer/src/store';

let status: HarnessSetupStatus;
let providers: ProviderConfig[];
const model: ModelInfo = { id: 'fixture-model', provider: 'anthropic', displayName: 'Fixture model' };
const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setupStatus(harness: HarnessId = 'claude'): HarnessSetupStatus {
  return { harness, availability: { available: true, authenticated: true, authMethod: 'subscription', source: 'bundled', binaryPath: '/isolated/vendor' }, requirements: [], providers: [{ id: 'anthropic', source: 'none' }], canInstall: false, loginId: harness === 'codex' ? 'codex' : 'claude' };
}
function baseInvoke(channel: string, req?: unknown): Promise<unknown> {
  if (channel === 'providers:list') return Promise.resolve(providers);
  if (channel === 'harness:setup') return Promise.resolve({ ...status, harness: (req as { harness: HarnessId }).harness });
  if (channel === 'harness:login') return Promise.resolve({ ok: true });
  if (channel === 'harness:models' || channel === 'providers:refreshModels') return Promise.resolve({ models: [model] });
  if (channel === 'secrets:status') return Promise.resolve({ encryptionAvailable: true, hasFallback: false });
  if (channel === 'settings:update') return Promise.resolve({ ...useStore.getState().settings!, ...req as object });
  if (channel === 'harness:availability') return Promise.resolve({});
  return Promise.resolve(undefined);
}
beforeEach(() => {
  providers = [{ id: 'anthropic', name: 'Anthropic', kind: 'anthropic', enabled: true, hasApiKey: false, models: [model] }];
  status = setupStatus();
  invokeMock.mockReset().mockImplementation(baseInvoke);
  const settings = { theme: 'system', defaultHarness: 'pi', defaultPermissionMode: 'ask', defaultModelByHarness: {}, onboardingDone: false, providers,
    binaries: {}, claude: { runtime: 'auto', useProviderKey: false }, codex: { runtime: 'auto' }, pi: { extraArgs: [] }, acpAgents: [], customShortcuts: {}, customBranchPrefixes: [], recentProjects: [], goalDefaults: { autoContinue: false, maxIterations: 25 } } as unknown as AppSettings;
  useStore.setState({ settings, availability: {}, availabilityError: null, modelCatalog: {}, onboardingOpen: false, onboardingDismissed: false, onboardingHarness: null, toasts: [] });
});
afterEach(cleanup);
const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));
async function choose(id: HarnessId) {
  fireEvent.click(screen.getByRole('button', { name: (name) => name.startsWith(HARNESS_BY_ID[id].name) }));
  next();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
}

describe('first-run connection guide', () => {
  it.each(['claude', 'codex'] as const)('completes the %s subscription path without requiring or storing an API key', async (id) => {
    status = setupStatus(id);
    const close = vi.fn();
    render(<OnboardingWizard onClose={close} />);
    await choose(id);
    expect(document.querySelector('input[type="password"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: id === 'claude' ? 'Sign in with Claude' : 'Sign in with ChatGPT' }));
    await screen.findByText(/Opening the window does not mean you are signed in/);
    expect(invokeMock).toHaveBeenCalledWith('harness:login', { harness: id });
    fireEvent.click(screen.getByRole('button', { name: 'Recheck setup' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
    next();
    await screen.findByText('1 catalog model.');
    next();
    expect(screen.getByText(/does not block a subscription-backed coding session/)).toBeTruthy();
    next();
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(useStore.getState().settings).toMatchObject({ onboardingDone: true, defaultHarness: id });
    for (const channel of ['secrets:set', 'providers:test', 'sessions:create', 'sessions:send']) expect(invokeMock.mock.calls.some(([c]) => c === channel)).toBe(false);
  });
  it('keeps unknown sign-in unverified and requires an explicit bypass instead of ready', async () => {
    status.availability.authenticated = 'unknown';
    delete status.availability.authMethod;
    render(<OnboardingWizard initialHarness="claude" onClose={vi.fn()} />);
    await screen.findByText('Sign-in not verified');
    expect(screen.queryByText(/^ready$/i)).toBeNull();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Continue without a verified connection' }));
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('lets an explicit unverified bypass recover from a failed setup check', async () => {
    invokeMock.mockImplementation((channel: string, req?: unknown) => channel === 'harness:setup' ? Promise.reject(new Error('probe unavailable')) : baseInvoke(channel, req));
    render(<OnboardingWizard initialHarness="claude" onClose={vi.fn()} />);
    await screen.findByText('probe unavailable');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Continue without a verified connection' }));
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('requires a fresh check after starting another sign-in even when an old account was detected', async () => {
    render(<OnboardingWizard initialHarness="claude" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }));
    await screen.findByText(/Opening the window does not mean you are signed in/);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Recheck setup' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('does not present a failed catalog’s fallback suggestions as verified model access', async () => {
    invokeMock.mockImplementation((channel: string, req?: unknown) => channel === 'harness:models' ? Promise.resolve({ models: [model], error: 'Sign-in expired' }) : baseInvoke(channel, req));
    render(<OnboardingWizard onClose={vi.fn()} />);
    await choose('claude'); next();
    await screen.findByText('1 suggested model.');
    expect(screen.getByRole('alert').textContent).toMatch(/not verified account access/);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Continue without verified model access' }));
    next(); next();
    expect(screen.getByText(/Setup is not fully verified/)).toBeTruthy();
  });
  it('shows a failed completion write, remains open and retries the same choices', async () => {
    const close = vi.fn();
    render(<OnboardingWizard onClose={close} />);
    await choose('claude'); next(); await screen.findByText('1 catalog model.'); next(); next();
    invokeMock.mockImplementation((channel: string, req?: unknown) => channel === 'settings:update' ? Promise.reject(new Error('disk full')) : baseInvoke(channel, req));
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await screen.findByText('Setup was not saved. disk full');
    expect(close).not.toHaveBeenCalled(); expect(useStore.getState().settings!.onboardingDone).toBe(false);
    invokeMock.mockImplementation(baseInvoke);
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
  it('does not persist completion when dismissed, and has a repeatable entry point', async () => {
    const close = vi.fn();
    render(<OnboardingWizard onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalledOnce();
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'settings:update')).toBe(false);
    useStore.getState().openOnboarding('codex'); useStore.getState().dismissOnboarding();
    expect(useStore.getState()).toMatchObject({ onboardingOpen: false, onboardingDismissed: true });
    expect(useStore.getState().settings!.onboardingDone).toBe(false);
    useStore.getState().openOnboarding('claude');
    expect(useStore.getState()).toMatchObject({ onboardingOpen: true, onboardingHarness: 'claude' });
  });
  it('preserves API-key drafts across Back/Next without writing them implicitly', async () => {
    status = { ...setupStatus('native'), loginId: undefined };
    render(<OnboardingWizard initialHarness="native" onClose={vi.fn()} />);
    const input = await screen.findByLabelText(/Anthropic API key/);
    fireEvent.change(input, { target: { value: 'unsaved-fixture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import chats from Claude Code or Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' })); next();
    expect((screen.getByLabelText(/Anthropic API key/) as HTMLInputElement).value).toBe('unsaved-fixture');
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'secrets:set')).toBe(false);
  });
});

describe('installation and login recovery', () => {
  it('reports installer rejection, offers retry and rechecks after success without inventing readiness', async () => {
    status = { ...setupStatus('pi'), availability: { available: false }, installId: 'pi', canInstall: true, loginId: 'pi' };
    invokeMock.mockImplementation((channel: string, req?: unknown) => channel === 'harness:install' ? Promise.reject(new Error('npm unavailable')) : baseInvoke(channel, req));
    render(<HarnessSetup harness="pi" onChange={vi.fn()} />);
    const install = await screen.findByRole('button', { name: 'Install Pi' });
    fireEvent.click(install); await screen.findByText('npm unavailable');
    expect((install as HTMLButtonElement).disabled).toBe(false);
    invokeMock.mockImplementation((channel: string, req?: unknown) => channel === 'harness:install' ? Promise.resolve({ ok: true, log: 'fixture installed' }) : baseInvoke(channel, req));
    fireEvent.click(install);
    await screen.findByText(/Installer finished/);
    await waitFor(() => expect(invokeMock.mock.calls.filter(([c]) => c === 'harness:setup')).toHaveLength(2));
    expect(screen.getByText('Setup needed')).toBeTruthy();
  });
  it('does not confuse opening a sign-in terminal with completing authentication', async () => {
    status.availability.authenticated = false; delete status.availability.authMethod;
    render(<HarnessSetup harness="claude" onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }));
    await screen.findByText(/Opening the window does not mean you are signed in/);
    expect(screen.getByText('Recheck sign-in')).toBeTruthy();
    status = setupStatus();
    fireEvent.click(screen.getByRole('button', { name: 'Recheck setup' }));
    await screen.findByText('Subscription sign-in detected');
    expect(invokeMock.mock.calls.filter(([c]) => c === 'harness:setup')).toHaveLength(2);
  });
  it('never shows unknown sign-in as ready in Settings, and opens the matching setup path', async () => {
    useStore.setState({ availability: { claude: { available: true, authenticated: 'unknown' } } });
    render(<SettingsView />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Harnesses' }));
    const row = screen.getByText(HARNESS_BY_ID.claude.name).closest('.harness-row')! as HTMLElement;
    expect(within(row).getByText('Sign-in not verified')).toBeTruthy();
    expect(within(row).queryByText(/^ready$/i)).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: `Set up ${HARNESS_BY_ID.claude.name}` }));
    expect(useStore.getState()).toMatchObject({ onboardingOpen: true, onboardingHarness: 'claude' });
  });
});

describe('credential save boundary', () => {
  it('waits for an in-flight credential change before allowing the guide to advance or close', async () => {
    const pending = deferred<void>(), close = vi.fn();
    providers[0].hasApiKey = true;
    status = { ...setupStatus('native'), loginId: undefined };
    invokeMock.mockImplementation((channel: string, req?: unknown) => channel === 'secrets:set' ? pending.promise : baseInvoke(channel, req));
    render(<OnboardingWizard initialHarness="native" onClose={close} />);
    fireEvent.change(await screen.findByLabelText(/Anthropic API key/), { target: { value: 'replacement-fixture' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Skip setup' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(close).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('writes only on Save and preserves newer edits while the submitted key is pending', async () => {
    const pending = deferred<void>();
    invokeMock.mockImplementation((channel: string, req?: unknown) => channel === 'secrets:set' ? pending.promise : baseInvoke(channel, req));
    render(<OnboardingProvider providers={providers} access={[]} providerId="anthropic" onSelect={vi.fn()} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    const input = screen.getByLabelText(/Anthropic API key/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'first-private-fixture' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save key' }) as HTMLButtonElement).disabled).toBe(false));
    expect(invokeMock.mock.calls.some(([c]) => c === 'secrets:set')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    fireEvent.change(input, { target: { value: 'newer-private-fixture' } });
    await act(async () => pending.resolve());
    expect(input.value).toBe('newer-private-fixture');
    expect(invokeMock).toHaveBeenCalledWith('secrets:set', { providerId: 'anthropic', apiKey: 'first-private-fixture' });
    expect(invokeMock.mock.calls.some(([c]) => c === 'settings:update')).toBe(false);
  });
  it('retains the draft and restores Save after a failed vault write', async () => {
    invokeMock.mockImplementation((channel: string, req?: unknown) => channel === 'secrets:set' ? Promise.reject(new Error('vault locked')) : baseInvoke(channel, req));
    render(<OnboardingProvider providers={providers} access={[]} providerId="anthropic" onSelect={vi.fn()} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    const input = screen.getByLabelText(/Anthropic API key/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'retry-private-fixture' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save key' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await screen.findByText(/vault locked/);
    expect(input.value).toBe('retry-private-fixture');
    expect((screen.getByRole('button', { name: 'Save key' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('discloses unavailable OS encryption before the first key is saved', async () => {
    invokeMock.mockImplementation((channel: string, req?: unknown) => channel === 'secrets:status' ? Promise.resolve({ encryptionAvailable: false, hasFallback: false }) : baseInvoke(channel, req));
    render(<OnboardingProvider providers={providers} access={[]} providerId="anthropic" onSelect={vi.fn()} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.change(screen.getByLabelText(/Anthropic API key/), { target: { value: 'private-fixture' } });
    await screen.findByText(/OS encryption is unavailable/);
    expect((screen.getByRole('button', { name: 'Save key' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand and want to save a key on this machine' }));
    expect((screen.getByRole('button', { name: 'Save key' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('freshness and stacked-dialog boundaries', () => {
  it('keeps a fresh setup-card check when an older whole-app availability request finishes later', async () => {
    const old = deferred<unknown>();
    invokeMock.mockImplementation((c: string, req?: unknown) => c === 'harness:availability' ? old.promise : baseInvoke(c, req));
    const boot = useStore.getState().refreshAvailability();
    render(<HarnessSetup harness="claude" onChange={vi.fn()} />);
    await screen.findByText('Subscription sign-in detected');
    await act(async () => { old.resolve({ claude: { available: true, authenticated: false }, pi: { available: false } }); await boot; });
    expect(useStore.getState().availability.claude?.authenticated).toBe(true);
    expect(useStore.getState().availability.pi?.available).toBe(false);
    // A genuinely newer whole-app recheck must still be able to report sign-out.
    await act(async () => { await useStore.getState().refreshAvailability(); });
    expect(useStore.getState().availability.claude?.authenticated).toBe(false);
  });
  it('a stale availability check cannot overwrite a fresh login recheck', async () => {
    const old = deferred<unknown>(), fresh = deferred<unknown>(); let count = 0;
    invokeMock.mockImplementation((c: string, req?: unknown) => c === 'harness:availability' ? (++count === 1 ? old.promise : fresh.promise) : baseInvoke(c, req));
    const first = useStore.getState().refreshAvailability(), second = useStore.getState().refreshAvailability();
    fresh.resolve({ claude: { available: true, authenticated: true } }); await second;
    old.resolve({ claude: { available: true, authenticated: false } }); await first;
    expect(useStore.getState().availability.claude?.authenticated).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('harness:availability', { refresh: true });
  });
  it('discarded in-flight catalogs do not revive an old auth error after setup', async () => {
    const old = deferred<unknown>(), fresh = deferred<unknown>(); let count = 0;
    invokeMock.mockImplementation((c: string, req?: unknown) => c === 'harness:models' ? (++count === 1 ? old.promise : fresh.promise) : baseInvoke(c, req));
    const first = useStore.getState().ensureModelCatalog('claude');
    useStore.getState().dismissOnboarding();
    const second = useStore.getState().ensureModelCatalog('claude');
    fresh.resolve({ models: [model] }); await second;
    old.resolve({ models: [], error: 'Old signed-out result' }); await first;
    expect(useStore.getState().modelCatalog.claude).toEqual({ models: [model], loading: false });
  });
  it('Escape closes only the setup overlay and restores the underlying draft and focus', () => {
    const parentClose = vi.fn();
    function Stack() {
      const [open, setOpen] = useState(false);
      return <><Modal title="New session" onClose={parentClose}><input aria-label="First prompt" defaultValue="Preserve my prompt" /><button onClick={() => setOpen(true)}>Setup</button></Modal>{open && <Modal title="Setup" onClose={() => setOpen(false)}><input aria-label="Visible input" /><div hidden><button>Hidden last action</button></div></Modal>}</>;
    }
    render(<Stack />);
    const setup = screen.getByRole('button', { name: 'Setup' }); setup.focus(); fireEvent.click(setup);
    const visible = screen.getByLabelText('Visible input'); visible.focus(); fireEvent.keyDown(visible, { key: 'Tab' });
    expect(document.activeElement).toBe(within(screen.getByRole('dialog', { name: 'Setup' })).getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(parentClose).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog', { name: 'Setup' })).toBeNull();
    expect((screen.getByLabelText('First prompt') as HTMLInputElement).value).toBe('Preserve my prompt'); expect(document.activeElement).toBe(setup);
  });
});
