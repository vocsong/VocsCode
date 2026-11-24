/** @vitest-environment jsdom */
/** UI tests for ongoing background activity across Transcript, Composer, Header, Sidebar, RightPanel, and Web shell. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({ ok: true, ended: 1, failed: [] });
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { OngoingActivityStrip } from '../src/renderer/src/components/OngoingActivityStrip';
import { Composer } from '../src/renderer/src/components/Composer';
import { Header } from '../src/renderer/src/components/Header';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta } from '../src/shared/types';

const NOW = 1_700_000_000_000;

function makeSession(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    title: 'PR 636',
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    config: { harness: 'pi', projectRoot: 'G:/proj', permissionMode: 'auto' },
    cwd: 'G:/proj',
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    ...patch
  };
}

beforeEach(() => {
  invokeMock.mockClear();
  invokeMock.mockResolvedValue({ ok: true, ended: 1, failed: [] });
  useStore.setState({
    sessions: [makeSession()],
    activeId: 's1',
    settings: { folders: ['G:/proj'], sidebarWidth: 280, panelWidth: 420, providers: [] } as never,
    processSummary: null,
    panelBottomOpened: [],
    panelBottomTab: 'mcp',
    subagentReveal: null,
    toasts: []
  });
});

afterEach(cleanup);

describe('OngoingActivityStrip', () => {
  it('renders a single background subagent when parent turn is idle, with Inspect and Stop actions', async () => {
    const session = makeSession({
      status: 'idle',
      ongoing: [{ id: 'subagent:r1', kind: 'subagent', agent: 'Explore', runId: 'r1', label: 'Wait on CI baseline', startedAt: Date.now() - 12_000, toolUses: 5, turns: 2, canStop: true }]
    });
    render(<OngoingActivityStrip session={session} />);
    const strip = screen.getByTestId('ongoing-autonomous');
    expect(strip.textContent).toContain('Background Explore running');
    expect(strip.textContent).toContain('Wait on CI baseline');
    expect(strip.textContent).toContain('Will report back');

    fireEvent.click(screen.getByTestId('ongoing-inspect'));
    expect(useStore.getState().subagentReveal).toEqual({ sessionId: 's1', runId: 'r1' });

    await act(async () => {
      fireEvent.click(screen.getByTestId('ongoing-stop'));
    });
    expect(invokeMock).toHaveBeenCalledWith('subagents:stop', { id: 's1', runId: 'r1' });
  });

  it('renders multiple ongoing items in a collapsible list (subagent + hook + command)', () => {
    const session = makeSession({
      status: 'idle',
      ongoing: [
        { id: 'subagent:r1', kind: 'subagent', agent: 'Explore', runId: 'r1', label: 'Check tests', startedAt: Date.now() - 5_000 },
        { id: 'hook:h1', kind: 'hook', label: 'verify-lint', detail: 'Stop', startedAt: Date.now() - 2_000 }
      ]
    });
    render(<OngoingActivityStrip session={session} />);
    expect(screen.getByTestId('ongoing-toggle').textContent).toContain('1 subagent, 1 hook running in background');
    expect(screen.getAllByTestId('ongoing-item')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('ongoing-toggle'));
    expect(screen.queryAllByTestId('ongoing-item')).toHaveLength(0);
  });

  it('shows Category 2 background OS processes only when parent turn is not running, with Processes link and End button', async () => {
    useStore.setState({
      processSummary: {
        count: 2,
        orphaned: 1,
        bySession: {
          s1: [{ pid: 4242, startedAt: NOW - 30_000, name: 'node.exe', label: 'npm run dev', detached: true }]
        }
      }
    });
    const runningSession = makeSession({ status: 'running' });
    const { rerender } = render(<OngoingActivityStrip session={runningSession} />);
    expect(screen.queryByTestId('ongoing-processes')).toBeNull();

    rerender(<OngoingActivityStrip session={makeSession({ status: 'idle' })} />);
    const procStrip = screen.getByTestId('ongoing-processes');
    expect(procStrip.textContent).toContain('npm run dev');
    expect(procStrip.textContent).toContain('detached');

    fireEvent.click(screen.getByTestId('ongoing-open-processes'));
    expect(useStore.getState().panelBottomTab).toBe('processes');

    await act(async () => {
      fireEvent.click(screen.getByTestId('ongoing-end-process'));
    });
    expect(invokeMock).toHaveBeenCalledWith('processes:end', { targets: [{ pid: 4242, startedAt: NOW - 30_000 }] });
  });
});

describe('Sidebar, Header, Composer, RightPanel, and Web shell ongoing indicators', () => {
  it('surfaces ongoing subagent in Sidebar row, top running badge, Header pill, Composer placeholder, and Subagents tab badge', () => {
    const session = makeSession({
      status: 'idle',
      ongoing: [{ id: 'subagent:r1', kind: 'subagent', agent: 'Explore', runId: 'r1', label: 'Check CI', startedAt: NOW - 5_000 }]
    });
    useStore.setState({
      sessions: [session],
      processSummary: {
        count: 2,
        orphaned: 0,
        bySession: { s1: [{ pid: 777, startedAt: NOW - 10_000, name: 'node.exe', label: 'vite' }] }
      }
    });

    const { container } = render(
      <>
        <Sidebar />
        <Header session={session} />
        <Composer session={session} />
        <RightPanel session={session} />
      </>
    );

    // Sidebar top activity badge counts idle-with-ongoing as running, row carries data-ongoing="true" and pill.
    expect(container.querySelector('.sidebar-status')?.textContent).toContain('1 running');
    const row = screen.getByTestId('session-row');
    expect(row.getAttribute('data-ongoing')).toBe('true');
    expect(within(row).getByTestId('session-ongoing-status').textContent).toBe('1 subagent');

    // Header shows pulsing ongoing pill.
    expect(screen.getByTestId('header-ongoing').textContent).toBe('1 subagent');

    // Composer keeps Send enabled with a background-work placeholder hint.
    const textarea = container.querySelector('.composer textarea') as HTMLTextAreaElement;
    expect(textarea.placeholder).toContain('Background work running');

    // RightPanel badges both Subagents (live running count) and Processes (active session process count).
    expect(screen.getByTestId('subagents-running-count').textContent).toBe('1');
    expect(screen.getByTestId('processes-session-count').textContent).toBe('1');
  });
});
