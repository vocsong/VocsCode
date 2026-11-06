import { describe, expect, it, vi } from 'vitest';
import { KeepAwake, isSessionActive, type PowerBlocker } from '../src/main/keep-awake';
import type { SessionMeta } from '../src/shared/types';

function blocker() {
  let next = 1;
  const live = new Set<number>();
  const api: PowerBlocker & { live: Set<number>; starts: number } = {
    live, starts: 0,
    start: vi.fn(() => { api.starts++; const id = next++; live.add(id); return id; }),
    stop: vi.fn((id: number) => { live.delete(id); })
  };
  return api;
}

const meta = (id: string, status: SessionMeta['status'], patch: Partial<SessionMeta> = {}): SessionMeta => ({ id, status, ...patch }) as SessionMeta;

describe('KeepAwake', () => {
  it.each([['running', true], ['awaiting', true], ['starting', true], ['idle', false], ['stopped', false], ['error', false], ['pr', false], ['merged', false]] as const)(
    'treats %s as active=%s', (status, active) => expect(isSessionActive({ status })).toBe(active));

  it('holds exactly one blocker while an opted-in session works, and releases it when the turn ends', () => {
    const power = blocker();
    const awake = new KeepAwake(power, vi.fn());
    awake.sync([meta('a', 'running', { keepAwake: true })]);
    awake.sync([meta('a', 'running', { keepAwake: true }), meta('b', 'awaiting', { keepAwake: true })]);
    expect(power.live.size).toBe(1);
    expect(power.starts).toBe(1);
    expect(power.start).toHaveBeenCalledWith('prevent-app-suspension');
    awake.sync([meta('a', 'idle', { keepAwake: true }), meta('b', 'awaiting', { keepAwake: true })]);
    expect(awake.held).toBe(true);
    awake.sync([meta('a', 'idle', { keepAwake: true }), meta('b', 'idle', { keepAwake: true })]);
    expect(awake.held).toBe(false);
    expect(power.live.size).toBe(0);
  });

  it('never holds for a session that did not opt in, or one that is archived', () => {
    const power = blocker();
    const awake = new KeepAwake(power, vi.fn());
    awake.sync([meta('a', 'running'), meta('b', 'running', { keepAwake: false }), meta('c', 'running', { keepAwake: true, archived: true })]);
    expect(power.start).not.toHaveBeenCalled();
    expect(awake.held).toBe(false);
  });

  it('releases when the opted-in session is removed or the choice is turned off mid-turn', () => {
    const power = blocker();
    const awake = new KeepAwake(power, vi.fn());
    awake.sync([meta('a', 'running', { keepAwake: true })]);
    awake.sync([meta('a', 'running')]);
    expect(power.live.size).toBe(0);
    awake.sync([meta('a', 'running', { keepAwake: true })]);
    expect(power.live.size).toBe(1);
    awake.sync([]);
    expect(power.live.size).toBe(0);
  });

  it('can hold again after a release, with a fresh blocker each time', () => {
    const power = blocker();
    const awake = new KeepAwake(power, vi.fn());
    for (let i = 0; i < 3; i++) {
      awake.sync([meta('a', 'running', { keepAwake: true })]);
      awake.sync([meta('a', 'idle', { keepAwake: true })]);
    }
    expect(power.starts).toBe(3);
    expect(power.live.size).toBe(0);
  });

  it('release() is idempotent and survives a blocker that throws on stop', () => {
    const power = blocker();
    const log = vi.fn();
    const awake = new KeepAwake(power, log);
    awake.release();
    expect(power.stop).not.toHaveBeenCalled();
    awake.sync([meta('a', 'running', { keepAwake: true })]);
    (power.stop as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('gone'); });
    expect(() => awake.release()).not.toThrow();
    expect(awake.held).toBe(false);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('gone'));
    awake.release();
    expect(power.stop).toHaveBeenCalledTimes(1);
  });
});
