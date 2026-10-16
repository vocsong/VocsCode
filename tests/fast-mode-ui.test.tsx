/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, ModelInfo, SessionMeta } from '../src/shared/types';
import { FAST_MODE_COST_WARNING } from '../src/shared/fast-mode';

const { invoke, gate } = vi.hoisted(() => ({ invoke: vi.fn(), gate: { allowed: true } }));
vi.mock('../src/renderer/src/api', () => ({ invoke, on: vi.fn(), canInvoke: () => gate.allowed, isMac: false, isWeb: false, platform: 'win32', modKey: 'Ctrl' }));
vi.mock('../src/renderer/src/gitReads', () => ({ useGitSummary: () => ({ data: undefined }) }));

import { NewSessionDialog } from '../src/renderer/src/components/NewSessionDialog';
import { Header } from '../src/renderer/src/components/Header';
import { ConfirmHost } from '../src/renderer/src/components/ui';
import { useStore } from '../src/renderer/src/store';

const supported = { provider: 'openai', model: 'gpt-5.4' };
const models: ModelInfo[] = [
  { provider: 'openai', id: 'gpt-5.4', displayName: 'GPT 5.4', isDefault: true },
  { provider: 'openai', id: 'gpt-4.1', displayName: 'GPT 4.1' }
];
const settings = { defaultHarness: 'native', defaultPermissionMode: 'ask', defaultEffort: 'high', defaultModelByHarness: { native: supported }, favoriteModels: [], providers: [], acpAgents: [] } as unknown as AppSettings;

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's_fast', title: 'Fast session', createdAt: 1, updatedAt: 1, cwd: 'G:/repo', status: 'idle', harnessRef: {},
    config: { harness: 'native', projectRoot: 'G:/repo', permissionMode: 'ask', useWorktree: false, model: supported, effort: 'high', fastMode: false },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    ...patch
  };
}

function LiveHeader() {
  const meta = useStore((s) => s.sessions[0]);
  return <><Header session={meta} /><ConfirmHost /></>;
}

function seed(meta = session()) {
  useStore.setState({
    settings: { ...settings }, sessions: [meta], activeId: meta.id, newSessionKind: 'normal', newSessionRoot: 'G:/repo', availability: {},
    models: {}, modelCatalog: { native: { models, loading: false } }, missions: {}, missionErrors: {}, toasts: [],
    openNewSession: vi.fn(), setActive: vi.fn().mockResolvedValue(undefined), loadMission: vi.fn()
  });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  gate.allowed = true;
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string, request: { enabled?: boolean }) => {
    if (channel === 'harness:models') return { models };
    if (channel === 'git:folderIsRepo') return { isRepo: false };
    if (channel === 'sessions:create') return { id: 'new-session' };
    if (channel === 'sessions:setFastMode') return session({ config: { ...session().config, fastMode: request.enabled }, fastModeStatus: { state: request.enabled ? 'requested' : 'off' } });
    return {};
  });
  seed();
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function start() {
  const button = screen.getByRole('button', { name: /Start session/ }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.anything()));
  return invoke.mock.calls.find(([channel]) => channel === 'sessions:create')![1].config;
}

function selectModel(id: string) {
  fireEvent.click(document.querySelector(`.mp-name[title="${id}"]`)!.closest('.mp-select')!);
}

describe('new-session Fast mode request', () => {
  it('defaults off and persists an explicit false independently of reasoning effort', async () => {
    render(<NewSessionDialog />);
    const toggle = screen.getByRole('checkbox', { name: 'Fast mode' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(FAST_MODE_COST_WARNING)).toBeTruthy();
    expect(await start()).toMatchObject({ fastMode: false, effort: 'high' });
  });

  it('persists a supported request without changing reasoning effort', async () => {
    render(<NewSessionDialog />);
    const toggle = screen.getByRole('checkbox', { name: 'Fast mode' }) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);
    expect(await start()).toMatchObject({ fastMode: true, effort: 'high', model: supported });
  });

  it('clears unsupported model choices, never restores the request when switching back', async () => {
    render(<NewSessionDialog />);
    const toggle = screen.getByRole('checkbox', { name: 'Fast mode' }) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);
    selectModel('openai/gpt-4.1');
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('Fast mode is not available for this OpenAI model.')).toBeTruthy();
    selectModel('openai/gpt-5.4');
    expect(toggle.checked).toBe(false);
    expect(await start()).toMatchObject({ fastMode: false });
  });

  it('clears requests on unsupported harness changes', async () => {
    render(<NewSessionDialog />);
    const toggle = screen.getByRole('checkbox', { name: 'Fast mode' }) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText('Cursor').closest('button')!);
    await waitFor(() => expect(toggle.disabled).toBe(true));
    expect(toggle.checked).toBe(false);
    expect(await start()).toMatchObject({ harness: 'cursor', fastMode: false });
  });
});

describe('message-header Fast mode request', () => {
  it('requires visible cost confirmation, waits for IPC, and never claims requested means on', async () => {
    let resolve!: (meta: SessionMeta) => void;
    invoke.mockImplementation((channel: string) => channel === 'sessions:setFastMode' ? new Promise((r) => { resolve = r; }) : Promise.resolve({}));
    render(<LiveHeader />);
    const toggle = screen.getByRole('switch', { name: 'Request Fast mode' }) as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(await screen.findByText(FAST_MODE_COST_WARNING)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('sessions:setFastMode', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Enable Fast mode' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:setFastMode', { id: 's_fast', enabled: true }));
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.textContent).toContain('off');
    await act(async () => resolve(session({ config: { ...session().config, fastMode: true }, fastModeStatus: { state: 'requested' } })));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.textContent).toContain('requested');
    expect(toggle.disabled).toBe(false);
    expect(useStore.getState().sessions[0].config.effort).toBe('high');
    expect(invoke).not.toHaveBeenCalledWith('sessions:setEffort', expect.anything());
  });

  it('cancels without mutation and shows failed requests without changing checked state', async () => {
    invoke.mockRejectedValue(new Error('account refused'));
    render(<LiveHeader />);
    const toggle = screen.getByRole('switch', { name: 'Request Fast mode' }) as HTMLButtonElement;
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(invoke).not.toHaveBeenCalledWith('sessions:setFastMode', expect.anything());
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable Fast mode' }));
    expect((await screen.findByRole('alert')).textContent).toContain('account refused');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.textContent).toContain('off');
    expect(toggle.disabled).toBe(false);
  });

  it.each(['requested', 'on', 'unavailable', 'cooldown'] as const)('shows effective %s status, including runtime detail', (state) => {
    seed(session({ config: { ...session().config, fastMode: true }, fastModeStatus: { state, detail: 'runtime detail' } }));
    render(<LiveHeader />);
    const toggle = screen.getByRole('switch', { name: 'Request Fast mode' });
    expect(toggle.textContent).toContain(state);
    expect(toggle.getAttribute('title')).toContain('runtime detail');
  });

  it.each(['running', 'starting', 'awaiting'] as const)('disables changes while %s', (status) => {
    seed(session({ status }));
    render(<LiveHeader />);
    const toggle = screen.getByRole('switch', { name: 'Request Fast mode' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toContain('Stop the session');
  });

  it('uses a custom active ref and provider endpoint instead of the saved model', () => {
    seed(session({ activeModel: { provider: 'openai', model: 'gpt-4.1-custom' } }));
    const view = render(<LiveHeader />);
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
    seed();
    useStore.setState({ settings: { ...settings, providers: [{ id: 'openai', baseUrl: 'https://gateway.example/v1', enabled: true } as never] } });
    render(<LiveHeader />);
    expect((screen.getByRole('switch') as HTMLButtonElement).title).toContain('custom endpoints');
  });

  it('allows an unsupported saved request to be turned off without confirmation', async () => {
    const meta = session();
    seed(session({ config: { ...meta.config, harness: 'cursor', fastMode: true }, fastModeStatus: { state: 'unavailable' } }));
    render(<LiveHeader />);
    const toggle = screen.getByRole('switch') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:setFastMode', { id: 's_fast', enabled: false }));
    expect(screen.queryByText('Enable Fast mode?')).toBeNull();
  });

  it('honors connection capability and hides the toggle for Missions', () => {
    gate.allowed = false;
    const view = render(<LiveHeader />);
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
    seed(session({ mission: { missionId: 'm1', role: 'lead' } as SessionMeta['mission'] }));
    render(<LiveHeader />);
    expect(screen.queryByRole('switch', { name: 'Request Fast mode' })).toBeNull();
  });
});
