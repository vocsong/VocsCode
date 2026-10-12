/** P3.5 read/write terminal (docs/REMOTE-ACCESS.md): a paired browser's terminal stream against the
 *  real TerminalManager with a fake PTY. A viewer gets a snapshot, then exactly the output after
 *  it, coalesced; it can never pause or attach the desktop's terminal; a viewer that falls a window
 *  behind is resynced with a fresh snapshot instead of an unbounded backlog. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IPty } from '@lydell/node-pty';
import { DEFAULT_TERMINAL_SETTINGS } from '../src/shared/terminal';
import { REMOTE_TERMINAL_SNAPSHOT_BUDGET, REMOTE_TERMINAL_WINDOW, type RemoteTerminalFrame } from '../src/shared/remote-terminal';
import { TerminalManager, type TerminalSnapshot } from '../src/main/terminal';
import { RemoteTerminalStreams, type TerminalSource } from '../src/main/remote/terminal-streams';

function fakePty() {
  const dataListeners: ((d: string) => void)[] = [];
  const exitListeners: ((e: { exitCode: number }) => void)[] = [];
  const calls: string[] = [];
  return {
    pid: 4242, cols: 80, rows: 24, process: 'fake', handleFlowControl: false,
    onData: (l: (d: string) => void) => {
      dataListeners.push(l);
      return { dispose: () => void dataListeners.splice(dataListeners.indexOf(l), 1) };
    },
    onExit: (l: (e: { exitCode: number }) => void) => {
      exitListeners.push(l);
      return { dispose: () => void exitListeners.splice(exitListeners.indexOf(l), 1) };
    },
    write: (d: string) => void calls.push(`write:${d}`),
    resize: (c: number, r: number) => void calls.push(`resize:${c}x${r}`),
    kill: () => setTimeout(() => [...exitListeners].forEach((l) => l({ exitCode: -1 })), 0),
    pause: () => void calls.push('pause'),
    resume: () => void calls.push('resume'),
    clear: () => undefined,
    emit: (d: string) => [...dataListeners].forEach((l) => l(d)),
    calls
  };
}

const managers: TerminalManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.closeAll()));
});

async function setup() {
  const fake = fakePty();
  const pushes: string[] = [];
  const m = new TerminalManager({
    dir: await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-remote-term-')),
    settings: () => DEFAULT_TERMINAL_SETTINGS,
    version: 'test',
    cwdOf: (id) => (id === 's1' ? os.tmpdir() : undefined),
    push: (ch) => void pushes.push(ch),
    log: () => undefined,
    spawn: () => fake as unknown as IPty,
    killTree: (pty) => pty.kill()
  });
  managers.push(m);
  const frames: { client: string; frame: RemoteTerminalFrame }[] = [];
  const streams = new RemoteTerminalStreams({
    source: () => m,
    send: async (client, frame) => {
      frames.push({ client, frame });
      return 'sent';
    },
    log: () => undefined,
    flushMs: 5
  });
  const info = m.create('s1', { cols: 40, rows: 6 });
  return { fake, m, pushes, frames, streams, info };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const of = (frames: { client: string; frame: RemoteTerminalFrame }[], client: string, kind: RemoteTerminalFrame['kind']) =>
  frames.filter((f) => f.client === client && f.frame.kind === kind).map((f) => f.frame);
const text = (frames: RemoteTerminalFrame[]) => frames.map((f) => (f.kind === 'data' ? f.data : '')).join('');

describe('remote terminal streams (real TerminalManager, fake PTY)', () => {
  it('answers a snapshot at the desktop geometry, then streams only later output, coalesced', async () => {
    const { fake, pushes, frames, streams, info } = await setup();
    fake.emit('before\r\n');
    const snap = await streams.watch('w1', info.id);
    expect(snap).toMatchObject({ terminalId: info.id, cols: 40, rows: 6 });
    expect(snap.snapshot).toContain('before');
    fake.emit('one ');
    fake.emit('two ');
    fake.emit('three');
    await settle();
    const data = of(frames, 'w1', 'data');
    // Three PTY chunks within the flush window travel as one frame carrying the last seq.
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ kind: 'data', data: 'one two three', seq: snap.seq + 3 });
    // Watching is not attaching: the desktop renderer got nothing, and the shell was never paused.
    expect(pushes.filter((ch) => ch === 'push:terminalData')).toHaveLength(0);
    expect(fake.calls).not.toContain('pause');
  });

  it('delivers output produced while the snapshot is taken exactly once', async () => {
    const { fake, frames, streams, info } = await setup();
    fake.emit('old\r\n');
    const watching = streams.watch('w1', info.id);
    fake.emit('racing\r\n'); // fed after the watcher registered, before the snapshot drains
    const snap = await watching;
    fake.emit('after');
    await settle();
    const streamed = text(of(frames, 'w1', 'data'));
    const inSnapshot = snap.snapshot.includes('racing');
    // Either the snapshot holds it or the stream does — never both, never neither.
    expect(inSnapshot !== streamed.includes('racing')).toBe(true);
    expect(streamed.endsWith('after')).toBe(true);
  });

  it('stops streaming a viewer past its window without pausing the shell, then resyncs it with a snapshot', async () => {
    const { fake, frames, streams, info } = await setup();
    const first = await streams.watch('w1', info.id);
    streams.ack('w1', info.id, 0, first.seq); // the browser applied the watch snapshot
    await settle();
    const chunk = 'x'.repeat(16 * 1024);
    for (let i = 0; i < 24; i++) fake.emit(chunk); // 384 KiB, past the 256 KiB window
    await settle();
    const sent = of(frames, 'w1', 'data').reduce((n, f) => n + (f.kind === 'data' ? f.data.length : 0), 0);
    expect(sent).toBeGreaterThan(REMOTE_TERMINAL_WINDOW);
    expect(sent).toBeLessThan(24 * chunk.length);
    expect(fake.calls).not.toContain('pause');
    // More output while behind is dropped, not queued.
    fake.emit('while-behind');
    await settle();
    expect(text(of(frames, 'w1', 'data'))).not.toContain('while-behind');
    expect(of(frames, 'w1', 'reset')).toHaveLength(0);
    // Once it has acknowledged everything it holds, it gets the current screen, and streaming resumes.
    streams.ack('w1', info.id, sent);
    await settle();
    const resets = of(frames, 'w1', 'reset');
    expect(resets).toHaveLength(1);
    expect(resets[0].kind === 'reset' && resets[0].snapshot).toContain('while-behind');
    fake.emit('caught-up');
    await settle();
    expect(text(of(frames, 'w1', 'data'))).toContain('caught-up');
  });

  it('sends output produced during a resync after its reset, never before it', async () => {
    const { m, fake, frames, streams, info } = await setup();
    const first = await streams.watch('w1', info.id);
    streams.ack('w1', info.id, 0, first.seq);
    // Make the resync's snapshot slow, and flood output while it is taken.
    const realSnapshot = m.snapshot.bind(m);
    m.snapshot = async (id, scrollback) => {
      const snap = await realSnapshot(id, scrollback);
      fake.emit('y'.repeat(40 * 1024)); // more than one frame's worth, past the snapshot's floor
      return snap;
    };
    m.clear(info.id);
    await settle(60);
    const order = frames.filter((f) => f.client === 'w1').map((f) => f.frame);
    const reset = order.findIndex((f) => f.kind === 'reset');
    expect(reset).toBeGreaterThanOrEqual(0);
    const floor = (order[reset] as Extract<RemoteTerminalFrame, { kind: 'reset' }>).seq;
    // Every data frame above the new floor follows the reset, so the viewer applies it to the new screen.
    order.forEach((f, i) => {
      if (f.kind === 'data' && f.seq > floor) expect(i).toBeGreaterThan(reset);
    });
    expect(text(order.slice(reset + 1)).length).toBe(40 * 1024);
  });

  it('keeps one snapshot unacknowledged at most, however hard the output floods', async () => {
    const { m, fake, frames, streams, info } = await setup();
    // Every snapshot is outrun by the flood, so each resync ends behind again.
    const realSnapshot = m.snapshot.bind(m);
    m.snapshot = async (id, scrollback) => {
      const snap = await realSnapshot(id, scrollback);
      fake.emit('z'.repeat(REMOTE_TERMINAL_WINDOW + 1));
      return snap;
    };
    const first = await streams.watch('w1', info.id);
    m.clear(info.id);
    await settle(200);
    // The browser has not acknowledged the watch snapshot: no reset may be sent on top of it.
    expect(of(frames, 'w1', 'reset')).toHaveLength(0);
    streams.ack('w1', info.id, 0, first.seq);
    await settle(200);
    const resets = of(frames, 'w1', 'reset');
    expect(resets).toHaveLength(1);
    // Still unacknowledged: still exactly one.
    await settle(200);
    expect(of(frames, 'w1', 'reset')).toHaveLength(1);
    streams.ack('w1', info.id, 0, (resets[0] as Extract<RemoteTerminalFrame, { kind: 'reset' }>).seq);
    await settle(200);
    expect(of(frames, 'w1', 'reset')).toHaveLength(2);
  });

  it('answers a first watch even when the desktop clears the screen while it is taken, then resyncs', async () => {
    const { m, frames, streams, info } = await setup();
    const realSnapshot = m.snapshot.bind(m);
    let cleared = false;
    m.snapshot = async (id, scrollback) => {
      if (!cleared) {
        cleared = true;
        m.clear(id);
      }
      return realSnapshot(id, scrollback);
    };
    const snap = await streams.watch('w1', info.id);
    expect(snap.terminalId).toBe(info.id);
    streams.ack('w1', info.id, 0, snap.seq);
    await settle();
    expect(of(frames, 'w1', 'reset')).toHaveLength(1);
  });

  it('forwards desktop resizes, resyncs on clear, and ends the stream when the tab closes', async () => {
    const { m, frames, streams, info } = await setup();
    const first = await streams.watch('w1', info.id);
    streams.ack('w1', info.id, 0, first.seq);
    await settle();
    m.resize(info.id, 100, 30);
    await settle();
    expect(of(frames, 'w1', 'resize')).toEqual([{ terminalId: info.id, kind: 'resize', cols: 100, rows: 30 }]);
    m.clear(info.id);
    await settle();
    expect(of(frames, 'w1', 'reset')).toHaveLength(1);
    await m.close(info.id);
    await settle();
    expect(of(frames, 'w1', 'closed')).toEqual([{ terminalId: info.id, kind: 'closed' }]);
    expect(streams.size()).toBe(0);
  });

  it('streams to each browser independently and stops for a browser that left', async () => {
    const { fake, frames, streams, info } = await setup();
    await streams.watch('w1', info.id);
    await streams.watch('w2', info.id);
    fake.emit('both');
    await settle();
    expect(text(of(frames, 'w1', 'data'))).toBe('both');
    expect(text(of(frames, 'w2', 'data'))).toBe('both');
    streams.dropClient('w1');
    fake.emit(' only-w2');
    await settle();
    expect(text(of(frames, 'w1', 'data'))).toBe('both');
    expect(text(of(frames, 'w2', 'data'))).toBe('both only-w2');
    streams.unwatch('w2', info.id);
    fake.emit(' nobody');
    await settle();
    expect(text(of(frames, 'w2', 'data'))).toBe('both only-w2');
    expect(streams.size()).toBe(0);
  });

  it('refuses to watch a terminal that does not exist', async () => {
    const { streams } = await setup();
    await expect(streams.watch('w1', 't_missing')).rejects.toThrow('Terminal not found');
    expect(streams.size()).toBe(0);
  });

  it('shrinks the snapshot history until it fits a relay frame', async () => {
    const asked: number[] = [];
    const source: TerminalSource = {
      list: () => [],
      watch: () => () => undefined,
      snapshot: async (_id, scrollback): Promise<TerminalSnapshot> => {
        asked.push(scrollback);
        // Escape-heavy history: every ESC grows to six characters in JSON.
        return { snapshot: '\x1b[31m'.repeat(scrollback * 300) + 'screen', seq: 7, cols: 80, rows: 24, info: { id: 't', sessionId: 's', title: 't', shell: 'bash', shellName: 'bash', cwd: '/', createdAt: 1 } };
      }
    };
    const streams = new RemoteTerminalStreams({ source: () => source, send: async () => 'sent', log: () => undefined });
    const snap = await streams.watch('w1', 't');
    expect(asked).toEqual([1000, 300, 100]);
    expect(JSON.stringify(snap.snapshot).length).toBeLessThanOrEqual(REMOTE_TERMINAL_SNAPSHOT_BUDGET);
  });

  it('measures the snapshot in bytes, since the relay frame limit is in bytes', async () => {
    const asked: number[] = [];
    const source: TerminalSource = {
      list: () => [],
      watch: () => () => undefined,
      // 300 lines of wide text: under the budget in characters, three times over it in UTF-8 bytes.
      snapshot: async (_id, scrollback): Promise<TerminalSnapshot> => {
        asked.push(scrollback);
        return { snapshot: '漢'.repeat(scrollback * 1000), seq: 1, cols: 80, rows: 24, info: { id: 't', sessionId: 's', title: 't', shell: 'bash', shellName: 'bash', cwd: '/', createdAt: 1 } };
      }
    };
    const streams = new RemoteTerminalStreams({ source: () => source, send: async () => 'sent', log: () => undefined });
    const snap = await streams.watch('w1', 't');
    expect(asked).toEqual([1000, 300, 100]);
    expect(new TextEncoder().encode(JSON.stringify(snap.snapshot)).length).toBeLessThanOrEqual(REMOTE_TERMINAL_SNAPSHOT_BUDGET);
  });
});
