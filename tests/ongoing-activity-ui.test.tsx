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

  it('shows inline PID, hides foreground harness children while running, surfaces detached/terminal processes immediately, and supports Processes/End actions', async () => {
    useStore.setState({
      processSummary: {
        count: 3,
        orphaned: 1,
        bySession: {
          s1: [
            { pid: 4100, startedAt: NOW - 15_000, name: 'vitest.exe', label: 'vitest run' },
            { pid: 4242, startedAt: NOW - 30_000, name: 'node.exe', label: 'npm run dev', detached: true }
          ]
        }
      }
    });
    const runningSession = makeSession({ status: 'running' });
    const { rerender } = render(<OngoingActivityStrip session={runningSession} />);
    // While parent turn is running: detached process still shows (with PID), non-detached child stays hidden.
    const runningProcStrip = screen.getByTestId('ongoing-processes');
    expect(runningProcStrip.textContent).toContain('npm run dev');
    expect(runningProcStrip.textContent).toContain('PID 4242');
    expect(runningProcStrip.textContent).toContain('detached');
    expect(runningProcStrip.textContent).not.toContain('vitest run');

    // Once parent turn is idle: both processes surface with inline PIDs on expansion.
    rerender(<OngoingActivityStrip session={makeSession({ status: 'idle' })} />);
    expect(screen.getByTestId('ongoing-processes').textContent).toContain('2 background processes running');
    fireEvent.click(screen.getByTestId('ongoing-processes-toggle'));
    const rows = screen.getAllByTestId('ongoing-process-item');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('PID 4100');
    expect(rows[1]!.textContent).toContain('PID 4242');

    fireEvent.click(screen.getByTestId('ongoing-open-processes'));
    expect(useStore.getState().panelBottomTab).toBe('processes');

    await act(async () => {
      fireEvent.click(screen.getAllByTestId('ongoing-end-process')[1]!);
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

    // Header shows pulsing ongoing pill and quiet processes pill when idle.
    expect(screen.getByTestId('header-ongoing').textContent).toBe('1 subagent');
    const procPill = screen.getByTestId('header-processes');
    expect(procPill.textContent).toContain('1 process');
    expect(procPill.getAttribute('title')).toContain('PID 777');
    fireEvent.click(procPill);
    expect(useStore.getState().panelBottomTab).toBe('processes');

    // Composer keeps Send enabled with a background-work placeholder hint.
    const textarea = container.querySelector('.composer textarea') as HTMLTextAreaElement;
    expect(textarea.placeholder).toContain('Background work running');

    // RightPanel badges both Subagents (live running count) and Processes (active session process count).
    expect(screen.getByTestId('subagents-running-count').textContent).toBe('1');
    expect(screen.getByTestId('processes-session-count').textContent).toBe('1');
  });

  it('hides the quiet Header processes pill while the session is actively running', () => {
    const running = makeSession({ status: 'running' });
    useStore.setState({
      sessions: [running],
      processSummary: {
        count: 1,
        orphaned: 0,
        bySession: { s1: [{ pid: 888, startedAt: NOW - 5_000, name: 'node.exe', label: 'vite', detached: true }] }
      }
    });
    render(<Header session={running} />);
    expect(screen.queryByTestId('header-processes')).toBeNull();
  });
});
