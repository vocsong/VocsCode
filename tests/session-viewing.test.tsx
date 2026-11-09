/** @vitest-environment jsdom */
/** A session counts as viewed after 1.5 s on screen in the focused window: the renderer reports the
 *  visible panes to main (so main can tell whether a finished turn was seen) and clears "done · not
 *  viewed" through `sessions:markViewed` once the dwell holds. A browser never reports either. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { PaneLayout } from '../src/renderer/src/panes';

const invoke = vi.fn(async () => undefined);

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  invoke.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function stubHarness(platform: string): void {
  (window as unknown as { harness: unknown }).harness = { platform, invoke, on: () => () => undefined };
}

const focused = (windowFocused: boolean) => ({ desktopFocus: { sessionId: null, at: 0, windowFocused } });
const markViewedCalls = () => invoke.mock.calls.filter((c) => (c as unknown[])[0] === 'sessions:markViewed');

async function setup(platform = 'darwin') {
  stubHarness(platform);
  const { useStore } = await import('../src/renderer/src/store');
  const { useSessionViewing } = await import('../src/renderer/src/desktop-focus');
  renderHook(() => useSessionViewing());
  return useStore;
}

describe('counting a session as viewed', () => {
  it('marks it viewed only once it has been on screen in the focused window for 1.5 s', async () => {
    const useStore = await setup();
    await act(async () => { useStore.setState({ visibleSessionIds: ['s1'], ...focused(true) }); });
    await act(async () => { vi.advanceTimersByTime(1_499); });
    expect(markViewedCalls()).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(markViewedCalls()).toEqual([['sessions:markViewed', { id: 's1' }]]);
    // Staying on it does not keep re-marking it.
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(markViewedCalls()).toHaveLength(1);
  });

  it('does not count a glance: the window losing focus mid-dwell cancels it', async () => {
    const useStore = await setup();
    await act(async () => { useStore.setState({ visibleSessionIds: ['s1'], ...focused(true) }); });
    await act(async () => { vi.advanceTimersByTime(1_000); });
    await act(async () => { useStore.setState(focused(false)); });
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(markViewedCalls()).toHaveLength(0);
    // Coming back starts a fresh dwell.
    await act(async () => { useStore.setState(focused(true)); });
    await act(async () => { vi.advanceTimersByTime(1_500); });
    expect(markViewedCalls()).toEqual([['sessions:markViewed', { id: 's1' }]]);
  });

  it('does not count a session that left the screen before the dwell held', async () => {
    const useStore = await setup();
    await act(async () => { useStore.setState({ visibleSessionIds: ['s1'], ...focused(true) }); });
    await act(async () => { vi.advanceTimersByTime(1_000); });
    await act(async () => { useStore.setState({ visibleSessionIds: ['s2'] }); });
    await act(async () => { vi.advanceTimersByTime(1_500); });
    expect(markViewedCalls()).toEqual([['sessions:markViewed', { id: 's2' }]]);
  });

  it('keeps a running dwell when another pane opens beside it', async () => {
    const useStore = await setup();
    await act(async () => { useStore.setState({ visibleSessionIds: ['s1'], ...focused(true) }); });
    await act(async () => { vi.advanceTimersByTime(1_000); });
    await act(async () => { useStore.setState({ visibleSessionIds: ['s1', 's2'] }); });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(markViewedCalls()).toEqual([['sessions:markViewed', { id: 's1' }]]);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(markViewedCalls()).toEqual([['sessions:markViewed', { id: 's1' }], ['sessions:markViewed', { id: 's2' }]]);
  });

  it('never marks anything while the window is unfocused', async () => {
    const useStore = await setup();
    await act(async () => { useStore.setState({ visibleSessionIds: ['s1'], ...focused(false) }); });
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(markViewedCalls()).toHaveLength(0);
  });

  it('reports the visible panes to main, debounced to where they settle', async () => {
    const useStore = await setup();
    await act(async () => { useStore.setState({ visibleSessionIds: ['s1'] }); });
    await act(async () => { vi.advanceTimersByTime(100); });
    await act(async () => { useStore.setState({ visibleSessionIds: ['s1', 's2'] }); });
    await act(async () => { vi.advanceTimersByTime(250); });
    const reports = invoke.mock.calls.filter((c) => (c as unknown[])[0] === 'desktop:setVisible');
    expect(reports.at(-1)).toEqual(['desktop:setVisible', { sessionIds: ['s1', 's2'] }]);
    expect(reports.some((c) => JSON.stringify(c) === JSON.stringify(['desktop:setVisible', { sessionIds: ['s1'] }]))).toBe(false);
  });

  it('never reports or marks from a browser', async () => {
    const useStore = await setup('browser');
    await act(async () => { useStore.setState({ visibleSessionIds: ['s1'], ...focused(true) }); });
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('visiblePaneSessions', () => {
  const layout = (ids: (string | null)[], active = 0): PaneLayout => ({
    orientation: 'horizontal',
    panes: ids.map((sessionId, i) => ({ id: `p${i}`, sessionId })),
    activePaneId: `p${active}`,
    sizes: ids.map(() => 1 / ids.length)
  });

  it('lists every pane showing a session, skipping an empty pane', async () => {
    const { visiblePaneSessions } = await import('../src/renderer/src/panes');
    expect(visiblePaneSessions(layout(['a', null, 'b']), false)).toEqual(['a', 'b']);
  });

  it('lists only the active pane when the split is too narrow to show the others', async () => {
    const { visiblePaneSessions } = await import('../src/renderer/src/panes');
    expect(visiblePaneSessions(layout(['a', 'b'], 1), true)).toEqual(['b']);
    expect(visiblePaneSessions(layout([null, 'b'], 0), true)).toEqual([]);
  });
});

describe('SessionPanes', () => {
  it('publishes the sessions on screen, and nothing once another view replaces the panes', async () => {
    stubHarness('darwin');
    const React = await import('react');
    const { render } = await import('@testing-library/react');
    const { useStore } = await import('../src/renderer/src/store');
    const { SessionPanes } = await import('../src/renderer/src/components/SessionPanes');
    useStore.setState({
      sessions: [],
      layout: { orientation: 'horizontal', panes: [{ id: 'p0', sessionId: 'a' }, { id: 'p1', sessionId: 'b' }], activePaneId: 'p0', sizes: [0.5, 0.5] }
    });
    const view = render(React.createElement(SessionPanes, { empty: null }));
    expect(useStore.getState().visibleSessionIds).toEqual(['a', 'b']);
    view.unmount();
    expect(useStore.getState().visibleSessionIds).toEqual([]);
  });
});
