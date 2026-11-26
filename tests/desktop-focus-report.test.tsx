/** @vitest-environment jsdom */
/** The desktop reports its active session to main, debounced to where a switch settles. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

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

describe('reporting desktop focus', () => {
  it('debounces rapid session switches to where they settle', async () => {
    stubHarness('win32');
    const { useStore } = await import('../src/renderer/src/store');
    const { useReportDesktopFocus } = await import('../src/renderer/src/desktop-focus');
    useStore.setState({ activeId: 's1' });
    renderHook(() => useReportDesktopFocus());

    await act(async () => { vi.advanceTimersByTime(200); });
    expect(invoke).not.toHaveBeenCalled(); // still inside the quiet window
    await act(async () => { useStore.setState({ activeId: 's2' }); });
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('desktop:setFocus', { sessionId: 's2' });
  });
});
