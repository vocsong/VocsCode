/**
 * Renderer-side stall and failure reporting. A frozen window is either a blocked main process or a
 * blocked renderer; main watches its own event loop (src/main/diag.ts) and these three numbers cover
 * the other side — a long task that hogged the thread, an input event that took too long to be
 * handled, and plain timer drift for stalls no observer attributes. Uncaught exceptions and
 * unhandled rejections go the same way: in a packaged build DevTools is closed, so the main log is
 * the only place a renderer error can be read afterwards. Everything lands in the main log.
 */
import { invoke } from './api';

/** Thresholds: well past a dropped frame, so ordinary rendering never reports. */
const MIN_LONGTASK_MS = 500;
const MIN_INPUT_DELAY_MS = 400;
const TICK_MS = 250;
const MIN_LOOP_LAG_MS = 1000;
/** A component erroring on every render must not turn into a log flood. */
const MAX_ERROR_REPORTS_PER_MINUTE = 20;
const MAX_REPORT_CHARS = 4000;

let errorReports = 0;
let errorWindowStart = 0;

/** A stack when there is one, the message otherwise; never `[object Object]`. */
export function describeThrown(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Writes a renderer failure to the main log. Safe to call from anywhere; never throws. */
export function reportRendererError(level: 'warn' | 'error', message: string): void {
  const now = Date.now();
  if (now - errorWindowStart > 60_000) {
    errorWindowStart = now;
    errorReports = 0;
  }
  if (++errorReports > MAX_ERROR_REPORTS_PER_MINUTE) return;
  try {
    void invoke('app:log', { level, message: message.slice(0, MAX_REPORT_CHARS) }).catch(() => undefined);
  } catch {
    /* no bridge (tests, a torn-down window) */
  }
}

/** PerformanceObserver options and entries the DOM lib does not type yet. */
interface EventTimingInit extends PerformanceObserverInit {
  durationThreshold?: number;
}
interface LongTaskEntry extends PerformanceEntry {
  attribution?: { containerType?: string; containerName?: string; containerSrc?: string }[];
}

let started = false;

export function startDiagnostics(): void {
  if (started) return;
  started = true;

  const report = (kind: 'longtask' | 'input-delay' | 'loop-lag', ms: number, detail?: string): void => {
    void invoke('app:diag', { kind, ms: Math.round(ms), detail }).catch(() => undefined);
  };

  window.addEventListener('error', (e) => {
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
    reportRendererError('error', `uncaught exception: ${e.error ? describeThrown(e.error) : e.message}${where}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportRendererError('error', `unhandled rejection: ${describeThrown(e.reason)}`);
  });

  observe(() => {
    const o = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as LongTaskEntry[]) {
        if (e.duration < MIN_LONGTASK_MS) continue;
        report('longtask', e.duration, e.attribution?.map((a) => a.containerName || a.containerType).filter(Boolean).join(',') || undefined);
      }
    });
    o.observe({ entryTypes: ['longtask'] });
  });

  observe(() => {
    const o = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration >= MIN_INPUT_DELAY_MS) report('input-delay', e.duration, e.name);
    });
    o.observe({ type: 'event', durationThreshold: MIN_INPUT_DELAY_MS, buffered: true } as EventTimingInit);
  });

  // A stall that starts before any observer is on the stack (a synchronous dialog, a GC pause) shows
  // up only as timer drift.
  let last = performance.now();
  window.setInterval(() => {
    const now = performance.now();
    const lag = now - last - TICK_MS;
    last = now;
    if (lag >= MIN_LOOP_LAG_MS) report('loop-lag', lag);
  }, TICK_MS);
}

/** An entry type this Chromium does not support must not break the others. */
function observe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* unsupported here */
  }
}
