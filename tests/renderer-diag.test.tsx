/** Loop-lag reporting (src/renderer/src/diag.ts): a visible window reports a real stall, a hidden
 *  window stays quiet, and becoming visible again does not report the whole hidden period. Error
 *  reports are capped per minute so a render loop cannot flood the main log.
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

describe('renderer error reporting', () => {
  it('caps reports so a component erroring on every render does not flood the log', async () => {
    const { reportRendererError } = await import('../src/renderer/src/diag');
    for (let i = 0; i < 40; i++) reportRendererError(`repeat ${i}`, 'Error: repeat\n  at render');
    const reports = invokeMock.mock.calls.filter(([channel]) => channel === 'app:rendererError');
    expect(reports).toHaveLength(20);
    expect(reports[0][1]).toEqual({ message: 'repeat 0', stack: 'Error: repeat\n  at render', source: undefined });
    // A new minute opens a new budget.
    vi.setSystemTime(Date.now() + 61_000);
    reportRendererError('later');
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'app:rendererError')).toHaveLength(21);
  });
});
