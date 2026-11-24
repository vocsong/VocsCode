import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphScheduler } from '../src/main/intelligence/graph-scheduler';

afterEach(() => vi.useRealTimers());

describe('desktop Graphify scheduling', () => {
  it('coalesces navigation, only checks the selected workspace, and polls for later commits', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const refresh = vi.fn(async (_id: string, _signal: AbortSignal) => {});
    const scheduler = new GraphScheduler({ enabled: () => true, refresh, onError, settleMs: 50, pollMs: 100 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
    scheduler.select('first');
    await vi.advanceTimersByTimeAsync(49);
    scheduler.select('second');
    await vi.advanceTimersByTimeAsync(50);
    scheduler.select('second');
    expect(refresh.mock.calls.map(([id]) => id)).toEqual(['second']);
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh.mock.calls.map(([id]) => id)).toEqual(['second', 'second']);
    scheduler.select(null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    await scheduler.close();
  });

  it('keeps settle and poll deadlines when switching sessions on the same checkout', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async (_id: string, _signal: AbortSignal) => {});
    const scheduler = new GraphScheduler({ enabled: () => true, refresh, onError: vi.fn(), settleMs: 50, pollMs: 100 });
    scheduler.select('A', 'main');
    await vi.advanceTimersByTimeAsync(49);
    scheduler.select('B', 'main');
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh.mock.calls.map(([id]) => id)).toEqual(['B']);
    await vi.advanceTimersByTimeAsync(25);
    scheduler.select('A', 'main');
    await vi.advanceTimersByTimeAsync(74);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh.mock.calls.map(([id]) => id)).toEqual(['B', 'A']);
    await scheduler.close();
  });

  it.each([
    { change: 'another session on the same checkout', sessionId: 'B', checkoutKey: 'main', aborts: false },
    { change: 'another session on a different checkout', sessionId: 'B', checkoutKey: 'worktree', aborts: true },
    { change: 'a different checkout for the same session', sessionId: 'A', checkoutKey: 'worktree', aborts: true },
    { change: 'an unkeyed session whose ID matches the checkout key', sessionId: 'main', checkoutKey: undefined, aborts: true }
  ])('keeps polling after switching to $change during a refresh', async ({ sessionId, checkoutKey, aborts }) => {
    vi.useFakeTimers();
    const onError = vi.fn();
    let finish!: () => void;
    const refresh = vi.fn(async (_id: string, _signal: AbortSignal) => {}).mockImplementationOnce(
      () => new Promise<void>((resolve, reject) => {
        finish = aborts ? () => reject(new Error('obsolete build failed')) : resolve;
      })
    );
    const scheduler = new GraphScheduler({ enabled: () => true, refresh, onError, settleMs: 50, pollMs: 100 });
    scheduler.select('A', 'main');
    await vi.advanceTimersByTimeAsync(50);
    scheduler.select(sessionId, checkoutKey);
    expect(refresh.mock.calls[0]?.[1].aborted).toBe(aborts);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh.mock.calls.map(([id]) => id)).toEqual(['A']);
    finish();
    await vi.advanceTimersByTimeAsync((aborts ? 50 : 100) - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh.mock.calls.map(([id]) => id)).toEqual(['A', sessionId]);
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh.mock.calls.map(([id]) => id)).toEqual(['A', sessionId, sessionId]);
    expect(onError).not.toHaveBeenCalled();
    await scheduler.close();
  });

  it('cancels on deselection, disable, and quit without polling', async () => {
    vi.useFakeTimers();
    let enabled = true;
    let finish!: () => void;
    const refresh = vi.fn((_id: string, _signal: AbortSignal) => new Promise<void>((resolve) => { finish = resolve; }));
    const scheduler = new GraphScheduler({ enabled: () => enabled, refresh, onError: vi.fn(), settleMs: 50, pollMs: 100 });
    scheduler.select('first', 'main');
    await vi.advanceTimersByTimeAsync(50);
    scheduler.select(null, 'main');
    expect(refresh.mock.calls[0]?.[1].aborted).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.select('second', 'main');
    await vi.advanceTimersByTimeAsync(50);
    expect(refresh.mock.calls[1]?.[0]).toBe('second');
    enabled = false;
    scheduler.settingsChanged();
    expect(refresh.mock.calls[1]?.[1].aborted).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    enabled = true;
    scheduler.settingsChanged();
    await vi.advanceTimersByTimeAsync(50);
    const closed = scheduler.close();
    expect(refresh.mock.calls[2]?.[1].aborted).toBe(true);
    finish();
    await closed;
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
