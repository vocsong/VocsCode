/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionMeta } from '../src/shared/types';

const { invoke, gate } = vi.hoisted(() => ({ invoke: vi.fn(), gate: { allowed: true } }));
vi.mock('../src/renderer/src/api', () => ({ invoke, on: vi.fn(), canInvoke: () => gate.allowed, isMac: false, isWeb: false, platform: 'win32', modKey: 'Ctrl' }));
vi.mock('../src/renderer/src/gitReads', () => ({ useGitSummary: () => ({ data: undefined }) }));

import { Header } from '../src/renderer/src/components/Header';
import { useStore } from '../src/renderer/src/store';

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's_awake', title: 'Awake session', createdAt: 1, updatedAt: 1, cwd: 'G:/repo', status: 'idle', harnessRef: {},
    config: { harness: 'native', projectRoot: 'G:/repo', permissionMode: 'ask' },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    ...patch
  } as SessionMeta;
}

function LiveHeader() {
  const meta = useStore((s) => s.sessions[0]);
  return <Header session={meta} />;
}

function seed(meta = session()) {
  useStore.setState({
    sessions: [meta], activeId: meta.id, panelOpen: true, showThinking: true, toasts: [], models: {},
    modelCatalog: { native: { models: [], loading: false } }, missions: {}, missionErrors: {}
  });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  gate.allowed = true;
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string, request: { id: string; enabled: boolean }) => {
    if (channel === 'sessions:setKeepAwake') return session({ keepAwake: request.enabled ? true : undefined });
    return {};
  });
});
afterEach(async () => { await act(async () => { cleanup(); }); vi.unstubAllGlobals(); });

describe('keep computer awake switch in the session header', () => {
  it('starts off, asks the host on click, and only turns on from the host answer', async () => {
    seed();
    render(<LiveHeader />);
    const toggle = screen.getByRole('switch', { name: 'Keep computer awake' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.getAttribute('data-awake')).toBe('off');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(invoke).toHaveBeenCalledWith('sessions:setKeepAwake', { id: 's_awake', enabled: true });
    expect(toggle.getAttribute('data-awake')).toBe('armed');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(invoke).toHaveBeenLastCalledWith('sessions:setKeepAwake', { id: 's_awake', enabled: false });
  });

  it('says the computer is held only while an opted-in session is working', () => {
    seed(session({ keepAwake: true, status: 'running' }));
    render(<LiveHeader />);
    expect(screen.getByRole('switch', { name: 'Keep computer awake' }).getAttribute('data-awake')).toBe('held');
    act(() => useStore.setState({ sessions: [session({ keepAwake: true, status: 'idle' })] }));
    expect(screen.getByRole('switch', { name: 'Keep computer awake' }).getAttribute('data-awake')).toBe('armed');
  });

  it('can be switched while a turn is running', async () => {
    seed(session({ status: 'running' }));
    render(<LiveHeader />);
    const toggle = screen.getByRole('switch', { name: 'Keep computer awake' });
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });

  it('stays off and tells the user when the host refuses', async () => {
    invoke.mockImplementation(async (channel: string) => { if (channel === 'sessions:setKeepAwake') throw new Error('Mission owns this session'); return {}; });
    seed();
    render(<LiveHeader />);
    const toggle = screen.getByRole('switch', { name: 'Keep computer awake' });
    fireEvent.click(toggle);
    await waitFor(() => expect(useStore.getState().toasts.some((t) => /Keep awake failed: .*Mission owns/.test(t.text))).toBe(true));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('is not offered where the connection cannot reach the host machine (a paired browser)', () => {
    gate.allowed = false;
    seed();
    render(<LiveHeader />);
    expect(screen.queryByRole('switch', { name: 'Keep computer awake' })).toBeNull();
  });
});
