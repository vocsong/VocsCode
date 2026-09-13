/** Renderer failures reach the main log through app:log, bounded so a render loop cannot flood it. */
/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue(undefined);
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { describeThrown, reportRendererError, startDiagnostics } from '../src/renderer/src/diag';

const logCalls = () => invokeMock.mock.calls.filter(([channel]) => channel === 'app:log');

describe('renderer diagnostics', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    startDiagnostics();
  });

  it('forwards uncaught exceptions with their stack and source location', () => {
    const error = new Error('render exploded');
    window.dispatchEvent(new ErrorEvent('error', { message: 'render exploded', error, filename: 'app://renderer/index.js', lineno: 12, colno: 7 }));
    const calls = logCalls();
    expect(calls).toHaveLength(1);
    const [, payload] = calls[0] as [string, { level: string; message: string }];
    expect(payload.level).toBe('error');
    expect(payload.message).toMatch(/^uncaught exception: Error: render exploded/);
    expect(payload.message).toContain('(app://renderer/index.js:12:7)');
  });

  it('forwards unhandled promise rejections, describing non-Error reasons too', () => {
    const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
    rejection.reason = { code: 'EPIPE' };
    window.dispatchEvent(rejection);
    const [, payload] = logCalls()[0] as [string, { level: string; message: string }];
    expect(payload).toEqual({ level: 'error', message: 'unhandled rejection: {"code":"EPIPE"}' });
    expect(describeThrown('plain string')).toBe('plain string');
    expect(describeThrown(new TypeError('bad'))).toMatch(/^TypeError: bad/);
  });

  it('caps reports so a component erroring on every render does not flood the log', () => {
    for (let i = 0; i < 40; i++) reportRendererError('warn', `repeat ${i}`);
    // The two tests above already consumed reports inside the same minute; the cap is 20 total.
    expect(logCalls().length).toBeLessThanOrEqual(20);
    expect(logCalls().length).toBeGreaterThan(0);
  });
});
