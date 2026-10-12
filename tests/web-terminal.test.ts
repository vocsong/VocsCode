/** The browser half of the P3.5 read/write terminal (docs/REMOTE-ACCESS.md): the stream controller
 *  (snapshot floor, early frames, acknowledgements, reconnect, ordered input), the screen model that
 *  turns a headless xterm into styled rows without injected styles, and the key mapping. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/headless';
import type { IpcChannel, IpcRequest } from '../src/shared/ipc';
import { ansiFromTokens } from '../src/shared/ansi';
import { REMOTE_TERMINAL_ACK_CHARS, REMOTE_TERMINAL_ACK_MS, REMOTE_TERMINAL_INPUT_MS, type RemoteTerminalFrame, type RemoteTerminalSnapshot } from '../src/shared/remote-terminal';
import { RemoteTerminalStream, type TerminalLink, type TerminalSink } from '../src/web/terminal/remote-terminal';
import { color256, screenRows } from '../src/web/terminal/screen';
import { keyToSequence, pasteSequence } from '../src/web/terminal/keys';

const info = { id: 't1', sessionId: 's1', title: 'bash', shell: 'bash' as const, shellName: 'bash', cwd: '/', createdAt: 1 };
const snap = (seq: number, snapshot = 'screen'): RemoteTerminalSnapshot => ({ terminalId: 't1', snapshot, seq, cols: 80, rows: 24, info });

function harness(answer: (channel: IpcChannel, request: unknown) => Promise<unknown> = async () => undefined) {
  const calls: { channel: IpcChannel; request: unknown }[] = [];
  const listeners = new Set<(frame: RemoteTerminalFrame) => void>();
  const link: TerminalLink = {
    invoke: (async <K extends IpcChannel>(channel: K, request: IpcRequest<K>) => {
      calls.push({ channel, request });
      if (channel === 'terminal:watch') return answer(channel, request);
      return undefined;
    }) as TerminalLink['invoke'],
    on: (_channel, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  const seen: string[] = [];
  const sink: TerminalSink = {
    reset: (s) => void seen.push(`reset:${s.seq}:${s.snapshot}`),
    write: (d) => void seen.push(`write:${d}`),
    resize: (c, r) => void seen.push(`resize:${c}x${r}`),
    closed: () => void seen.push('closed'),
    error: (m) => void seen.push(`error:${m}`)
  };
  const push = (frame: RemoteTerminalFrame) => [...listeners].forEach((l) => l(frame));
  return { link, sink, calls, seen, push, listeners };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RemoteTerminalStream', () => {
  it('holds output that beats the snapshot and applies only what lies past its floor', async () => {
    let release!: (s: RemoteTerminalSnapshot) => void;
    const h = harness(() => new Promise((resolve) => { release = resolve; }));
    const stream = new RemoteTerminalStream(h.link, 't1', h.sink);
    const started = stream.start();
    // Output races the answer: one chunk the snapshot already holds, one it does not.
    h.push({ terminalId: 't1', kind: 'data', seq: 4, data: 'old' });
    h.push({ terminalId: 't1', kind: 'data', seq: 6, data: 'new' });
    h.push({ terminalId: 'other', kind: 'data', seq: 9, data: 'not mine' });
    expect(h.seen).toEqual([]);
    release(snap(5));
    await started;
    expect(h.seen).toEqual(['reset:5:screen', 'write:new']);
    // The applied snapshot is acknowledged by seq: the desktop sends no other snapshot until then.
    expect(h.calls.filter((c) => c.channel === 'terminal:watchAck').map((c) => c.request)).toContainEqual({ terminalId: 't1', chars: 0, snapshot: 5 });
  });

  it('acknowledges every streamed character, applied or not, in batches', async () => {
    vi.useFakeTimers();
    const h = harness(async () => snap(10));
    const stream = new RemoteTerminalStream(h.link, 't1', h.sink);
    await stream.start();
    h.push({ terminalId: 't1', kind: 'data', seq: 9, data: 'abc' }); // under the floor: dropped, still counted
    h.push({ terminalId: 't1', kind: 'data', seq: 11, data: 'defg' });
    // Only the snapshot acknowledgement so far: output waits for its batch.
    expect(h.calls.filter((c) => c.channel === 'terminal:watchAck').map((c) => c.request)).toEqual([{ terminalId: 't1', chars: 0, snapshot: 10 }]);
    vi.advanceTimersByTime(REMOTE_TERMINAL_ACK_MS);
    expect(h.calls.filter((c) => c.channel === 'terminal:watchAck').map((c) => c.request)).toEqual([{ terminalId: 't1', chars: 0, snapshot: 10 }, { terminalId: 't1', chars: 7 }]);
    // A full batch acknowledges at once, without waiting for the timer.
    h.push({ terminalId: 't1', kind: 'data', seq: 12, data: 'z'.repeat(REMOTE_TERMINAL_ACK_CHARS) });
    expect(h.calls.filter((c) => c.channel === 'terminal:watchAck').map((c) => c.request)).toEqual([
      { terminalId: 't1', chars: 0, snapshot: 10 },
      { terminalId: 't1', chars: 7 },
      { terminalId: 't1', chars: REMOTE_TERMINAL_ACK_CHARS }
    ]);
    expect(h.seen).toEqual(['reset:10:screen', 'write:defg', `write:${'z'.repeat(REMOTE_TERMINAL_ACK_CHARS)}`]);
  });

  it('replaces the screen on reset, follows resizes, and stops when the tab closes', async () => {
    const h = harness(async () => snap(1));
    const stream = new RemoteTerminalStream(h.link, 't1', h.sink);
    await stream.start();
    h.push({ kind: 'reset', ...snap(50, 'fresh') });
    h.push({ terminalId: 't1', kind: 'data', seq: 40, data: 'stale' });
    h.push({ terminalId: 't1', kind: 'data', seq: 51, data: 'live' });
    h.push({ terminalId: 't1', kind: 'resize', cols: 120, rows: 40 });
    h.push({ terminalId: 't1', kind: 'closed' });
    h.push({ terminalId: 't1', kind: 'data', seq: 52, data: 'after close' });
    expect(h.seen).toEqual(['reset:1:screen', 'reset:50:fresh', 'write:live', 'resize:120x40', 'closed']);
    // The reset is acknowledged like the first snapshot; characters from before it are not carried over.
    expect(h.calls.filter((c) => c.channel === 'terminal:watchAck').map((c) => c.request)).toEqual([
      { terminalId: 't1', chars: 0, snapshot: 1 },
      { terminalId: 't1', chars: 0, snapshot: 50 }
    ]);
    expect(h.listeners.size).toBe(0);
    expect(h.calls.map((c) => c.channel)).toContain('terminal:unwatch');
  });

  it('re-watches from a fresh snapshot after a reconnect, ignoring the old stream', async () => {
    let seq = 3;
    const h = harness(async () => snap(seq));
    const stream = new RemoteTerminalStream(h.link, 't1', h.sink);
    await stream.start();
    seq = 20;
    await stream.start();
    h.push({ terminalId: 't1', kind: 'data', seq: 10, data: 'lost-socket backlog' });
    h.push({ terminalId: 't1', kind: 'data', seq: 21, data: 'fresh' });
    expect(h.seen).toEqual(['reset:3:screen', 'reset:20:screen', 'write:fresh']);
    expect(h.listeners.size).toBe(1);
    expect(h.calls.filter((c) => c.channel === 'terminal:watch')).toHaveLength(2);
  });

  it('reports a refused watch instead of hanging', async () => {
    const h = harness(async () => { throw new Error('Terminal not found'); });
    await new RemoteTerminalStream(h.link, 't1', h.sink).start();
    expect(h.seen).toEqual(['error:Terminal not found']);
  });

  it('batches typed input into one ordered frame and sends what is pending on stop', async () => {
    vi.useFakeTimers();
    const h = harness(async () => snap(1));
    const stream = new RemoteTerminalStream(h.link, 't1', h.sink);
    await stream.start();
    stream.send('l');
    stream.send('s');
    stream.send('\r');
    expect(h.calls.filter((c) => c.channel === 'terminal:input')).toEqual([]);
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_INPUT_MS);
    expect(h.calls.filter((c) => c.channel === 'terminal:input').map((c) => c.request)).toEqual([{ terminalId: 't1', data: 'ls\r' }]);
    stream.send('\x03');
    stream.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.filter((c) => c.channel === 'terminal:input').map((c) => c.request)).toEqual([
      { terminalId: 't1', data: 'ls\r' },
      { terminalId: 't1', data: '\x03' }
    ]);
    // Nothing is sent after the view is gone.
    stream.send('late');
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_INPUT_MS);
    expect(h.calls.filter((c) => c.channel === 'terminal:input')).toHaveLength(2);
  });
});

const palette = ansiFromTokens(true, { fg: '#e6e7ea', bgElev: '#191c23', fgMuted: '#9aa0aa', fgFaint: '#6b7280', red: '#ff6b6e', green: '#3ecf7a', amber: '#f0b44c', blue: '#6ea0ff', purple: '#c084fc', cyan: '#4dd0e1' });
const theme = { fg: '#e6e7ea', bg: '#0d0f13' };
const write = (term: Terminal, data: string) => new Promise<void>((r) => term.write(data, r));

describe('screenRows', () => {
  it('draws styled runs with palette, 256 and true colors, and marks the cursor', async () => {
    const term = new Terminal({ cols: 30, rows: 4, allowProposedApi: true });
    await write(term, 'plain \x1b[31mred\x1b[0m \x1b[1;38;5;196mhot\x1b[0m \x1b[48;2;1;2;3mrgb\x1b[0m\r\n$ ');
    const rows = screenRows(term, palette, theme);
    expect(rows).toHaveLength(2); // blank rows under the cursor are not drawn
    const [first, prompt] = rows;
    expect(first.runs.map((r) => r.text).join('')).toBe('plain red hot rgb');
    expect(first.runs.find((r) => r.text === 'red')).toMatchObject({ fg: palette.red });
    expect(first.runs.find((r) => r.text === 'hot')).toMatchObject({ fg: color256(196), bold: true });
    expect(first.runs.find((r) => r.text === 'rgb')).toMatchObject({ bg: '#010203' });
    expect(prompt.runs.map((r) => r.text).join('')).toBe('$  ');
    expect(prompt.runs[prompt.runs.length - 1]).toMatchObject({ cursor: true, text: ' ' });
    term.dispose();
  });

  it('swaps colors for inverse video and keeps every row of a full-screen program', async () => {
    const term = new Terminal({ cols: 10, rows: 3, allowProposedApi: true });
    await write(term, '\x1b[?1049h\x1b[H\x1b[7mtop\x1b[0m');
    const rows = screenRows(term, palette, theme, { cursor: false });
    expect(rows).toHaveLength(3);
    expect(rows[0].runs[0]).toMatchObject({ text: 'top', fg: theme.bg, bg: theme.fg });
    term.dispose();
  });

  it('builds the 256-color cube and gray ramp like xterm', () => {
    expect(color256(16)).toBe('#000000');
    expect(color256(196)).toBe('#ff0000');
    expect(color256(231)).toBe('#ffffff');
    expect(color256(232)).toBe('#080808');
    expect(color256(255)).toBe('#eeeeee');
  });
});

describe('keyToSequence', () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
    ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });

  it('maps text, control chords and editing keys', () => {
    expect(keyToSequence(key('a'))).toBe('a');
    expect(keyToSequence(key('c', { ctrlKey: true }))).toBe('\x03');
    expect(keyToSequence(key('C', { ctrlKey: true, shiftKey: true }))).toBe('\x03');
    expect(keyToSequence(key('[', { ctrlKey: true }))).toBe('\x1b');
    expect(keyToSequence(key('b', { altKey: true }))).toBe('\x1bb');
    expect(keyToSequence(key('Enter'))).toBe('\r');
    expect(keyToSequence(key('Backspace'))).toBe('\x7f');
    expect(keyToSequence(key('Tab', { shiftKey: true }))).toBe('\x1b[Z');
    expect(keyToSequence(key('Delete'))).toBe('\x1b[3~');
    expect(keyToSequence(key('F5'))).toBe('\x1b[15~');
  });

  it('honors application cursor mode and modified arrows', () => {
    expect(keyToSequence(key('ArrowUp'))).toBe('\x1b[A');
    expect(keyToSequence(key('ArrowUp'), true)).toBe('\x1bOA');
    expect(keyToSequence(key('ArrowLeft', { ctrlKey: true }))).toBe('\x1b[1;5D');
  });

  it('leaves Cmd chords, bare modifiers and AltGr-composed text alone or as typed', () => {
    expect(keyToSequence(key('v', { metaKey: true }))).toBeNull();
    expect(keyToSequence(key('Shift', { shiftKey: true }))).toBeNull();
    expect(keyToSequence(key('Unidentified'))).toBeNull();
    expect(keyToSequence(key('@', { ctrlKey: true, altKey: true }))).toBe('@');
  });

  it('pastes with CR line ends and bracketed-paste markers that the paste cannot close', () => {
    expect(pasteSequence('a\nb\r\nc', false)).toBe('a\rb\rc');
    expect(pasteSequence('x\x1b[201~rm -rf /\n', true)).toBe('\x1b[200~xrm -rf /\r\x1b[201~');
  });
});
