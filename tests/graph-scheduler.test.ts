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

  it('cancels an active job and waits for it before rescheduling; off and quit do not poll', async () => {
    vi.useFakeTimers();
    let enabled = true;
    let finish!: () => void;
    const refresh = vi.fn((_id: string, _signal: AbortSignal) => new Promise<void>((resolve) => { finish = resolve; }));
    const scheduler = new GraphScheduler({ enabled: () => enabled, refresh, onError: vi.fn(), settleMs: 50, pollMs: 100 });
    scheduler.select('first');
    await vi.advanceTimersByTimeAsync(50);
    scheduler.select('second');
    expect(refresh.mock.calls[0]?.[1].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
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
