import { describe, expect, it } from 'vitest';
import { MissionScheduler } from '../src/main/mission/scheduler';

const scheduler = (turns = 10, workers = 4) => new MissionScheduler({ maxConcurrentAgentTurnsGlobal: turns, maxConcurrentWorkersPerMission: workers, maxConcurrentHeavyChecksGlobal: 1 });

describe('Mission resource admission', () => {
  it('admits four workers and queues the fifth without consuming the lead opportunity', async () => {
    const s = scheduler();
    expect(s.register('m')).toBe(true);
    const workers = await Promise.all([1, 2, 3, 4].map((n) => s.acquire({ missionId: 'm', ownerId: `w${n}`, kind: 'worker' })));
    let fifthStarted = false;
    const fifth = s.acquire({ missionId: 'm', ownerId: 'w5', kind: 'worker' }).then((lease) => { fifthStarted = true; return lease; });
    const lead = await s.acquire({ missionId: 'm', ownerId: 'l', kind: 'lead' });
    expect(fifthStarted).toBe(false);
    expect(s.snapshot().active).toHaveLength(5);
    workers[0].release(true);
    (await fifth).release(true);
    lead.release(true);
    workers.slice(1).forEach((lease) => lease.release(true));
    expect(s.snapshot().active).toHaveLength(0);
  });

  it('bounds two Missions globally and preserves one lead slot each', async () => {
    const s = scheduler(4);
    s.register('a'); s.register('b');
    const aWorker = await s.acquire({ missionId: 'a', ownerId: 'wa', kind: 'worker' });
    const bWorker = await s.acquire({ missionId: 'b', ownerId: 'wb', kind: 'worker' });
    const queued = s.acquire({ missionId: 'a', ownerId: 'wa2', kind: 'worker' });
    const leads = await Promise.all(['a', 'b'].map((missionId) => s.acquire({ missionId, ownerId: `l${missionId}`, kind: 'lead' })));
    expect(s.snapshot().active).toHaveLength(4);
    expect(s.snapshot().queued.map((r) => r.ownerId)).toEqual(['wa2']);
    aWorker.release(true);
    const next = await queued;
    expect(s.snapshot().active).toHaveLength(4);
    [next, bWorker, ...leads].forEach((lease) => lease.release(true));
  });

  it('serializes heavy checks across Missions independently of model slots', async () => {
    const s = scheduler(); s.register('a'); s.register('b');
    const first = await s.acquire({ missionId: 'a', ownerId: 'check-a', kind: 'heavy_check' });
    let started = false;
    const second = s.acquire({ missionId: 'b', ownerId: 'check-b', kind: 'heavy_check' }).then((lease) => { started = true; return lease; });
    await s.acquire({ missionId: 'b', ownerId: 'lead', kind: 'lead' });
    expect(started).toBe(false);
    first.release(true);
    (await second).release(true);
    expect(s.snapshot().active.map((r) => r.ownerId)).toEqual(['lead']);
  });

  it('does not release permission/tool waits on pause and refuses unsafe unregister', async () => {
    const s = scheduler(2, 1); s.register('m');
    const active = await s.acquire({ missionId: 'm', ownerId: 'tool', kind: 'worker' });
    const queued = s.acquire({ missionId: 'm', ownerId: 'queued', kind: 'worker' });
    const rejected = expect(queued).rejects.toThrow('paused');
    s.pause('m');
    await rejected;
    expect(s.snapshot().active).toHaveLength(1);
    expect(() => s.unregister('m')).toThrow('non-quiescent');
    await expect(s.acquire({ missionId: 'm', ownerId: 'later', kind: 'lead' })).rejects.toThrow('not admitting');
    expect(() => active.release(false as true)).toThrow('quiescent');
    active.release(true);
    s.unregister('m');
    expect(s.snapshot()).toEqual({ active: [], queued: [], missions: [] });
  });

  it('cancels queued admission without accidentally canceling a running owner', async () => {
    const s = scheduler(2, 1); s.register('m');
    const active = await s.acquire({ missionId: 'm', ownerId: 'one', kind: 'worker' });
    const abort = new AbortController();
    const waiting = s.acquire({ missionId: 'm', ownerId: 'two', kind: 'worker', signal: abort.signal });
    const rejected = expect(waiting).rejects.toThrow('canceled');
    abort.abort(); await rejected;
    await expect(s.acquire({ missionId: 'm', ownerId: 'one', kind: 'worker' })).rejects.toThrow('already');
    active.release(true); active.release(true);
    expect(s.snapshot().active).toHaveLength(0);
  });

  it('counts recovered unknown leads against tightened global and account ceilings without admitting them', async () => {
    const s = new MissionScheduler({ maxConcurrentAgentTurnsGlobal: 2, maxConcurrentWorkersPerMission: 1, maxConcurrentHeavyChecksGlobal: 1, accountLimits: { shared: 1 } });
    s.register('new');
    const one = s.retainUnknownLead({ missionId: 'old-a', ownerId: 'unknown-a', accountId: 'shared' });
    const two = s.retainUnknownLead({ missionId: 'old-b', ownerId: 'unknown-b', accountId: 'shared' });
    expect(s.snapshot().active).toHaveLength(2); expect(() => s.unregister('old-a')).toThrow('non-quiescent');
    await expect(s.acquire({ missionId: 'old-b', ownerId: 'unsafe-resume', kind: 'lead' })).rejects.toThrow('not admitting');
    const next = s.acquire({ missionId: 'new', ownerId: 'new-answer', kind: 'lead', accountId: 'shared' });
    expect(s.snapshot().queued.map((r) => r.ownerId)).toEqual(['new-answer']);
    one.release(true); s.unregister('old-a');
    expect(s.snapshot().queued).toHaveLength(1); // account remains owned by the other unknown turn
    two.release(true); s.unregister('old-b');
    const admitted = await next; expect(s.snapshot().active.map((r) => r.ownerId)).toEqual(['new-answer']);
    admitted.release(true); s.unregister('new'); expect(s.snapshot()).toEqual({ active: [], queued: [], missions: [] });
  });

  it('does not oversubscribe lead capacity and honors account backpressure', async () => {
    const s = scheduler(1); expect(s.register('a')).toBe(true); expect(s.register('b')).toBe(false);
    const shared = new MissionScheduler({ maxConcurrentAgentTurnsGlobal: 4, maxConcurrentWorkersPerMission: 4, maxConcurrentHeavyChecksGlobal: 1, accountLimits: { subscription: 1 } });
    shared.register('a'); shared.register('b');
    const one = await shared.acquire({ missionId: 'a', ownerId: 'a', kind: 'lead', accountId: 'subscription' });
    const two = shared.acquire({ missionId: 'b', ownerId: 'b', kind: 'lead', accountId: 'subscription' });
    expect(shared.snapshot().active).toHaveLength(1);
    one.release(true); (await two).release(true);
  });
});
