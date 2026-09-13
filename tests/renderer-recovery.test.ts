/** Unit tests for the crashed-renderer recovery policy (src/main/renderer-recovery.ts):
 *  a one-off crash reloads, a crash loop stops and is reported, and a quiet period starts a
 *  fresh count. Electron-free on purpose, so this runs in plain Node. */
import { describe, expect, it } from 'vitest';
import { RendererRecovery } from '../src/main/renderer-recovery';

function harness(opts: { limit?: number; windowMs?: number } = {}) {
  let time = 1_000_000;
  let reloads = 0;
  const logs: [string, string][] = [];
  const recovery = new RendererRecovery({
    log: (level, message) => logs.push([level, message]),
    reload: () => (reloads += 1),
    now: () => time,
    ...opts
  });
  return {
    recovery,
    logs,
    reloadCount: () => reloads,
    advance: (ms: number) => {
      time += ms;
    }
  };
}

describe('renderer recovery', () => {
  it('reloads after a crash and says why in the log', () => {
    const h = harness();
    expect(h.recovery.gone('crashed', 139)).toBe(true);
    expect(h.reloadCount()).toBe(1);
    expect(h.logs).toEqual([['error', 'renderer process gone: crashed (exit 139); reloading (1/3)']]);
  });

  it('stops reloading a crash loop and reports it instead', () => {
    const h = harness({ limit: 2 });
    expect(h.recovery.gone('oom', -1073741819)).toBe(true);
    expect(h.recovery.gone('oom', -1073741819)).toBe(true);
    expect(h.recovery.gone('oom', -1073741819)).toBe(false);
    expect(h.reloadCount()).toBe(2);
    expect(h.logs.at(-1)?.[0]).toBe('error');
    expect(h.logs.at(-1)?.[1]).toContain('not reloading');
  });

  it('starts a fresh count after a quiet period', () => {
    const h = harness({ limit: 1, windowMs: 60_000 });
    expect(h.recovery.gone('crashed', 1)).toBe(true);
    expect(h.recovery.gone('crashed', 1)).toBe(false);
    h.advance(60_001);
    expect(h.recovery.gone('crashed', 1)).toBe(true);
    expect(h.reloadCount()).toBe(2);
  });

  it('never reloads for a window that is closing', () => {
    const h = harness();
    expect(h.recovery.gone('clean-exit', 0)).toBe(false);
    expect(h.recovery.gone('killed', 1)).toBe(false);
    expect(h.reloadCount()).toBe(0);
    expect(h.logs.every(([level]) => level === 'info')).toBe(true);
  });
});
