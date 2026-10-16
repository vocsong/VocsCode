/**
 * Attribution without adapter changes: a session's adapter runs every call as that session, and a
 * ChildProcess started from such a call — directly or from an async continuation, as an SDK does —
 * is reported with the session as its owner. Spawns outside any owner context are not reported.
 */
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { currentProcessOwner, observeOwnedSpawns, ownedAdapter, withProcessOwner } from '../src/main/process-context';
import type { ProcessOwner } from '../src/shared/processes';

class FakeAdapter {
  #runs = 0;
  readonly id = 'fake';
  pids: number[] = [];
  get runs(): number {
    return this.#runs;
  }
  async start(): Promise<void> {
    this.#runs++;
    await new Promise((r) => setTimeout(r, 5));
    // An SDK spawns from deep inside its own async code; the owner must survive the hops.
    await Promise.resolve();
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((r) => child.once('exit', r));
    if (child.pid) this.pids.push(child.pid);
  }
  owner(): ProcessOwner | undefined {
    return currentProcessOwner();
  }
}

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe('process ownership context', () => {
  it('reports a process an adapter starts, from an async continuation, as its session\'s', async () => {
    const seen: [number, ProcessOwner][] = [];
    stop = observeOwnedSpawns((pid, owner) => seen.push([pid, owner]));
    const adapter = ownedAdapter(new FakeAdapter(), { sessionId: 's1' });
    await adapter.start();
    expect(adapter.pids).toHaveLength(1);
    expect(seen).toEqual([[adapter.pids[0], { sessionId: 's1' }]]);
  });

  it('does not report a spawn made outside any owner context', async () => {
    const seen: number[] = [];
    stop = observeOwnedSpawns((pid) => seen.push(pid));
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((r) => child.once('exit', r));
    expect(seen).toEqual([]);
    await withProcessOwner({ label: 'GitNexus server' }, async () => {
      const labelled = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      await new Promise((r) => labelled.once('exit', r));
      expect(seen).toEqual([labelled.pid]);
    });
  });

  it('keeps the adapter itself intact: private fields, getters, assignments and method identity', async () => {
    const real = new FakeAdapter();
    const adapter = ownedAdapter(real, { sessionId: 's2' });
    expect(adapter.owner()).toEqual({ sessionId: 's2' });
    expect(currentProcessOwner()).toBeUndefined();
    expect(adapter.start).toBe(adapter.start);
    expect(adapter instanceof FakeAdapter).toBe(true);
    await adapter.start();
    expect(adapter.runs).toBe(1);
    adapter.pids = [42];
    expect(real.pids).toEqual([42]);
    expect(adapter.id).toBe('fake');
  });
});
