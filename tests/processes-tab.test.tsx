/**
 * The Processes tab: everything the app started, grouped by who it works for with left-behind
 * processes first; ending one row names exactly that process, and ending a group needs a second
 * click and names each of the group's roots once. The right panel badges the tab with the
 * left-behind count from the pushed summary, before the tab is ever opened.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({
  canInvoke: () => true,
  invoke,
  on: vi.fn().mockReturnValue(() => undefined),
  isMac: false,
  modKey: 'Ctrl',
  platform: 'win32',
  isWeb: false,
  webShim: vi.fn()
}));

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ProcessesTab } from '../src/renderer/src/components/ProcessesTab';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { useStore } from '../src/renderer/src/store';
import type { ProcessList, TrackedProcess } from '../src/shared/processes';
import type { SessionMeta } from '../src/shared/types';

const NOW = 1_800_000_000_000;

const session = (id: string, title: string): SessionMeta =>
  ({
    id,
    title,
    createdAt: 1,
    updatedAt: 2,
    config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'auto' },
    cwd: `G:/proj/a/.vocs-code/worktrees/${id}`,
    worktreeBranch: `vocscode/${id}`,
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  }) as SessionMeta;

const p = (pid: number, ppid: number, over: Partial<TrackedProcess> = {}): TrackedProcess => ({
  pid,
  ppid,
  startedAt: NOW - 60_000 + pid,
  name: 'node.exe',
  memory: 50 * 1024 * 1024,
  cpu: 1,
  owner: {},
  ...over
});

const LIST: ProcessList = {
  sampledAt: NOW,
  processes: [
    p(100, 1, { name: 'claude.exe', command: 'C:\\x\\claude.exe --output-format stream-json', owner: { sessionId: 's1' } }),
    p(101, 100, { command: 'node C:\\npm\\node_modules\\npm\\bin\\npm-cli.js run dev', owner: { sessionId: 's1' } }),
    // Start-Processed by the session through a tool shell that has exited: detached, still the session's.
    p(102, 4242, { name: 'powershell.exe', command: 'powershell -NoExit -Command npm run update', owner: { sessionId: 's1' }, orphaned: true }),
    p(200, 1, { name: 'powershell.exe', owner: { sessionId: 's2', terminalId: 't1', label: 'PowerShell' } }),
    p(300, 1, { name: 'cmd.exe', owner: { label: 'GitNexus server' } }),
    p(400, 999, { command: 'node server.js', owner: { sessionId: 's2' }, orphaned: true, previousRun: true }),
    p(401, 400, { command: 'node worker.js', owner: { sessionId: 's2' }, orphaned: true, previousRun: true })
  ]
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === 'processes:list') return Promise.resolve(LIST);
    if (channel === 'processes:end') return Promise.resolve({ ended: 1, failed: [] });
    if (channel === 'mcp:project') return Promise.resolve(null);
    return Promise.resolve({});
  });
  useStore.setState({ sessions: [session('s1', 'Fix login'), session('s2', 'Batch import')], toasts: [], panelTab: 'goal', panelBottomTab: 'mcp', panelBottomOpened: [], processSummary: null });
});
afterEach(cleanup);

describe('Processes tab', () => {
  it('groups processes by session, left-behind first, each under its parent', async () => {
    await act(async () => {
      render(<ProcessesTab session={session('s1', 'Fix login')} />);
    });
    const groups = screen.getAllByTestId(/^process-group-(orphaned|session|app)$/);
    expect(groups.map((g) => g.getAttribute('data-testid'))).toEqual(['process-group-orphaned', 'process-group-session', 'process-group-session', 'process-group-app']);

    const leftBehind = within(groups[0]);
    expect(leftBehind.getByText('Left behind')).toBeTruthy();
    expect(leftBehind.getByText('server.js')).toBeTruthy();
    expect(groups[0].textContent).toContain('earlier run');
    expect(groups[0].textContent).toContain('from Batch import');

    // The active session comes next, its dev server nested under the harness that started it.
    expect(groups[1].textContent).toContain('Fix login');
    expect(groups[1].textContent).toContain('(this session)');
    expect(groups[1].textContent).toContain('vocscode/s1');
    const rows = within(groups[1]).getAllByTestId('process-row');
    expect(rows.map((r) => r.getAttribute('data-pid'))).toEqual(['100', '101', '102']);
    expect(rows[0].textContent).toContain('Claude Code');
    expect(rows[1].textContent).toContain('npm run dev');
    expect(rows[1].style.paddingLeft).toBe('22px');
    expect(within(rows[2]).getByTestId('process-detached').textContent).toBe('detached');
    expect(within(groups[1]).getAllByTestId('process-detached')).toHaveLength(1);
    expect(groups[0].textContent).not.toContain('npm run update');

    expect(groups[2].textContent).toContain('Terminal · PowerShell');
    expect(groups[3].textContent).toContain('GitNexus server');
    expect(screen.getByTestId('processes-summary').textContent).toContain('7 processes');
  });

  it('ends exactly the row it was asked to, naming it by PID and creation time', async () => {
    await act(async () => {
      render(<ProcessesTab session={session('s1', 'Fix login')} />);
    });
    const row = screen.getAllByTestId('process-row').find((r) => r.getAttribute('data-pid') === '101')!;
    await act(async () => {
      fireEvent.click(within(row).getByTestId('process-end'));
    });
    expect(invoke).toHaveBeenCalledWith('processes:end', { targets: [{ pid: 101, startedAt: NOW - 60_000 + 101 }] });
  });

  it('ends a whole group only on a second click, naming each root once', async () => {
    await act(async () => {
      render(<ProcessesTab session={session('s1', 'Fix login')} />);
    });
    const button = screen.getByTestId('process-group-end-orphaned');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(invoke.mock.calls.some(([channel]) => channel === 'processes:end')).toBe(false);
    expect(button.textContent).toBe('Confirm');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(invoke).toHaveBeenCalledWith('processes:end', { targets: [{ pid: 400, startedAt: NOW - 60_000 + 400 }] });
  });

  it('says why when the process table cannot be read', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'processes:list' ? Promise.resolve({ sampledAt: NOW, processes: [], error: 'The Windows process reader did not start.' }) : Promise.resolve({})
    );
    await act(async () => {
      render(<ProcessesTab session={session('s1', 'Fix login')} />);
    });
    expect(screen.getByText('The Windows process reader did not start.')).toBeTruthy();
    expect(screen.queryByText('Nothing running.')).toBeNull();
  });
});

describe('right panel Processes tab', () => {
  it('badges left-behind processes before the tab is opened, and mounts the tab lazily', async () => {
    useStore.setState({ processSummary: { count: 6, orphaned: 2 } });
    await act(async () => {
      render(<RightPanel session={session('s1', 'Fix login')} />);
    });
    expect(screen.getByTestId('processes-orphaned-count').textContent).toBe('2');
    expect(invoke.mock.calls.some(([channel]) => channel === 'processes:list')).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByTestId('panel-bottom-processes'));
    });
    expect(await screen.findByTestId('processes-tab')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('processes:list', undefined);

    act(() => useStore.setState({ processSummary: { count: 4, orphaned: 0 } }));
    expect(screen.queryByTestId('processes-orphaned-count')).toBeNull();
  });
});
