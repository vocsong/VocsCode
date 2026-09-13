/** Loop-lag reporting (src/renderer/src/diag.ts): a visible window reports a real stall, a hidden
 *  window stays quiet, and becoming visible again does not report the whole hidden period.
 *  @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

type Hidden = { hidden: boolean };

beforeEach(() => {
  vi.resetModules();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (document as unknown as Partial<Hidden>).hidden;
});

describe('loop-lag reporting', () => {
  it('reports a stall while visible and ignores the throttled ticks of a hidden window', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { startDiagnostics } = await import('../src/renderer/src/diag');
    startDiagnostics();

    now = 5_000;
    await vi.advanceTimersByTimeAsync(250);
    expect(invokeMock).toHaveBeenCalledWith('app:diag', expect.objectContaining({ kind: 'loop-lag', ms: 4_750 }));

    invokeMock.mockClear();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    now = 65_000;
    await vi.advanceTimersByTimeAsync(250);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does not report the hidden period as lag once the window is visible again', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { startDiagnostics } = await import('../src/renderer/src/diag');
    startDiagnostics();

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    now = 3_600_000;
    await vi.advanceTimersByTimeAsync(250);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    invokeMock.mockClear();
    now = 3_600_250;
    await vi.advanceTimersByTimeAsync(250);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
