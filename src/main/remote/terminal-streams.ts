/** Terminals streamed to paired browsers (docs/REMOTE-ACCESS.md P3.5, read/write). Each browser that
 *  watches a terminal gets its own stream: a snapshot, then coalesced output frames sealed to it
 *  alone. A viewer that falls a window behind stops receiving output and gets one fresh snapshot
 *  once it has caught up — the desktop's shell is never paused for a remote viewer, so a slow phone
 *  cannot stall the terminal the desktop is using.
 *
 *  Invariants: output after a snapshot is sent only after that snapshot (the viewer applies frames
 *  against the floor of the snapshot it holds); at most one snapshot is unacknowledged at a time,
 *  so a flood cannot turn into a stream of full-screen resets; and a resync waits until the viewer
 *  has acknowledged every output frame it was sent, so its acks always refer to the current floor. */
import {
  REMOTE_TERMINAL_CHUNK,
  REMOTE_TERMINAL_FLUSH_MS,
  REMOTE_TERMINAL_SCROLLBACK_STEPS,
  REMOTE_TERMINAL_SNAPSHOT_BUDGET,
  REMOTE_TERMINAL_WINDOW,
  type RemoteTerminalFrame,
  type RemoteTerminalSnapshot
} from '../../shared/remote-terminal';
import type { TerminalInfo } from '../../shared/terminal';
import type { TerminalSnapshot, TerminalWatcher } from '../terminal';

/** The slice of TerminalManager a stream needs. */
export interface TerminalSource {
  list(): TerminalInfo[];
  watch(id: string, watcher: TerminalWatcher): () => void;
  snapshot(id: string, scrollback: number): Promise<TerminalSnapshot>;
}

type SendOutcome = 'sent' | 'oversize' | 'skipped';

interface Stream {
  clientId: string;
  terminalId: string;
  stop: () => void;
  /** Seq of the snapshot the viewer holds; output at or below it is already on its screen. */
  floor: number;
  /** A snapshot is being taken: output waits in `pending` to be replayed past it. */
  snapshotting: boolean;
  pending: { seq: number; data: string }[];
  pendingChars: number;
  /** Output overflowed `pending` while a snapshot was taken: that snapshot is already behind. */
  overflowed: boolean;
  /** Output is held (buffered, not sent) until the snapshot it follows has been sent. */
  held: boolean;
  /** Which snapshot set the hold, so a release meant for an older one cannot lift a newer hold. */
  holdToken: number;
  buffer: string;
  bufferSeq: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Output characters sent and not yet acknowledged. */
  unacked: number;
  /** The viewer has not acknowledged the snapshot at `floor` yet. */
  snapshotUnacked: boolean;
  /** The viewer needs a fresh snapshot: it fell behind, or the desktop cleared the screen. Output
   *  is dropped until the resync. */
  stale: boolean;
  resyncing: boolean;
  dropped: boolean;
}

const key = (clientId: string, terminalId: string): string => `${clientId}\u0000${terminalId}`;

/** What a snapshot costs on the wire before sealing: UTF-8 bytes of its JSON encoding. */
const wireBytes = (snapshot: string): number => new TextEncoder().encode(JSON.stringify(snapshot)).length;

export class RemoteTerminalStreams {
  private readonly streams = new Map<string, Stream>();

  constructor(
    private readonly deps: {
      source: () => TerminalSource | null;
      /** Seals one push frame to one browser; the remote host's per-client ordered send. */
      send: (clientId: string, frame: RemoteTerminalFrame) => Promise<SendOutcome>;
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
      /** Test seam. */
      flushMs?: number;
    }
  ) {}

  /** Starts (or restarts) streaming `terminalId` to `clientId`; answers the current screen. Output
   *  produced meanwhile follows it as `data` frames, released once the answer is on its way. */
  async watch(clientId: string, terminalId: string): Promise<RemoteTerminalSnapshot> {
    const source = this.deps.source();
    if (!source) throw new Error('Terminals are not available');
    this.unwatch(clientId, terminalId);
    const stream: Stream = {
      clientId, terminalId, stop: () => undefined, floor: 0, snapshotting: false, pending: [], pendingChars: 0,
      overflowed: false, held: true, holdToken: 0, buffer: '', bufferSeq: 0, timer: null, unacked: 0, snapshotUnacked: false,
      stale: false, resyncing: false, dropped: false
    };
    stream.stop = source.watch(terminalId, {
      data: (seq, data) => this.onData(stream, seq, data),
      resize: (cols, rows) => this.onResize(stream, cols, rows),
      reset: (closed) => this.onReset(stream, closed)
    });
    this.streams.set(key(clientId, terminalId), stream);
    try {
      const snap = await this.takeSnapshot(stream, source);
      // The host seals this answer right after it resolves; output queued meanwhile goes after it.
      const token = stream.holdToken;
      setTimeout(() => this.release(stream, token), 0);
      return snap;
    } catch (e) {
      this.drop(stream);
      throw e;
    }
  }

  unwatch(clientId: string, terminalId: string): void {
    const stream = this.streams.get(key(clientId, terminalId));
    if (stream) this.drop(stream);
  }

  /** The browser consumed `chars` of output, and acknowledges the snapshot it applied, by seq. */
  ack(clientId: string, terminalId: string, chars: number, snapshot?: number): void {
    const stream = this.streams.get(key(clientId, terminalId));
    if (!stream) return;
    if (Number.isFinite(chars) && chars > 0) stream.unacked = Math.max(0, stream.unacked - Math.floor(chars));
    if (snapshot !== undefined && snapshot === stream.floor) stream.snapshotUnacked = false;
    this.maybeResync(stream);
  }

  /** The browser's e2e session ended (it left, re-handshook or was revoked). */
  dropClient(clientId: string): void {
    for (const stream of [...this.streams.values()]) if (stream.clientId === clientId) this.drop(stream);
  }

  dropAll(): void {
    for (const stream of [...this.streams.values()]) this.drop(stream);
  }

  /** How many terminals are streamed, to whom: for logs and tests. */
  size(clientId?: string): number {
    return [...this.streams.values()].filter((s) => clientId === undefined || s.clientId === clientId).length;
  }

  private drop(stream: Stream): void {
    if (stream.dropped) return;
    stream.dropped = true;
    stream.stop();
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    stream.buffer = '';
    stream.pending = [];
    const k = key(stream.clientId, stream.terminalId);
    if (this.streams.get(k) === stream) this.streams.delete(k);
  }

  /**
   * The largest snapshot that fits a relay frame. Output fed while it is taken is replayed past its
   * floor into the (held) buffer. A flood that outruns the snapshot retakes it a few times; past
   * that, the viewer is marked stale and resynced once it has acknowledged this one.
   */
  private async takeSnapshot(stream: Stream, source: TerminalSource): Promise<RemoteTerminalSnapshot> {
    stream.snapshotting = true;
    stream.held = true;
    stream.holdToken++;
    stream.buffer = '';
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    let snap: TerminalSnapshot | undefined;
    try {
      for (let attempt = 0; attempt < 4 && (!snap || stream.overflowed); attempt++) {
        stream.overflowed = false;
        stream.pending = [];
        stream.pendingChars = 0;
        snap = undefined;
        for (const scrollback of REMOTE_TERMINAL_SCROLLBACK_STEPS) {
          const candidate = await source.snapshot(stream.terminalId, scrollback);
          if (stream.dropped) throw new Error('Terminal not found');
          if (wireBytes(candidate.snapshot) <= REMOTE_TERMINAL_SNAPSHOT_BUDGET) {
            snap = candidate;
            break;
          }
        }
        if (!snap) throw new Error('This terminal screen is too large to stream');
      }
    } finally {
      stream.snapshotting = false;
    }
    const final = snap!;
    stream.floor = final.seq;
    stream.unacked = 0;
    stream.snapshotUnacked = true;
    // Still behind after the retries, or cleared on the desktop meanwhile: show this snapshot, then
    // resync once the viewer has acknowledged it.
    stream.stale = stream.overflowed || stream.stale;
    stream.overflowed = false;
    const later = stream.stale ? [] : stream.pending.filter((p) => p.seq > final.seq);
    stream.pending = [];
    stream.pendingChars = 0;
    for (const p of later) this.enqueue(stream, p.seq, p.data);
    return { terminalId: stream.terminalId, snapshot: final.snapshot, seq: final.seq, cols: final.cols, rows: final.rows, info: final.info };
  }

  /** Sends what was held behind a snapshot, now that the snapshot is on its way. */
  private release(stream: Stream, token: number): void {
    if (stream.dropped || !stream.held || stream.holdToken !== token || stream.snapshotting) return;
    stream.held = false;
    if (stream.buffer) this.flush(stream);
  }

  /** A fresh snapshot, once the viewer has acknowledged every frame and the previous snapshot. */
  private maybeResync(stream: Stream): void {
    if (stream.dropped || !stream.stale || stream.resyncing || stream.snapshotting || stream.snapshotUnacked || stream.unacked > 0) return;
    void this.resync(stream);
  }

  private async resync(stream: Stream): Promise<void> {
    const source = this.deps.source();
    if (!source) return;
    stream.resyncing = true;
    stream.stale = false;
    try {
      const snap = await this.takeSnapshot(stream, source);
      if (stream.dropped) return;
      const sending = this.deps.send(stream.clientId, { kind: 'reset', ...snap });
      this.release(stream, stream.holdToken); // queued behind the reset in the client's ordered send
      const outcome = await sending;
      if (outcome === 'skipped') this.drop(stream);
      else if (outcome === 'oversize') {
        this.deps.log('warn', `remote: terminal ${stream.terminalId} snapshot for ${stream.clientId} exceeded the relay frame limit; stopping its stream`);
        this.drop(stream);
      }
    } catch (e) {
      // The tab closed while the snapshot was taken (`reset(true)` told the viewer), or it no longer fits.
      this.deps.log('debug', `remote: terminal ${stream.terminalId} resync for ${stream.clientId} failed: ${e instanceof Error ? e.message : String(e)}`);
      this.drop(stream);
    } finally {
      stream.resyncing = false;
    }
    this.maybeResync(stream);
  }

  private onData(stream: Stream, seq: number, data: string): void {
    if (stream.dropped) return;
    if (stream.snapshotting) {
      // Keep what the snapshot may miss, within the window; past that, the snapshot is behind.
      if (stream.overflowed || stream.pendingChars + data.length > REMOTE_TERMINAL_WINDOW) {
        stream.pending = [];
        stream.pendingChars = 0;
        stream.overflowed = true;
        return;
      }
      stream.pending.push({ seq, data });
      stream.pendingChars += data.length;
      return;
    }
    this.enqueue(stream, seq, data);
  }

  private enqueue(stream: Stream, seq: number, data: string): void {
    if (stream.stale || seq <= stream.floor) return;
    stream.buffer += data;
    stream.bufferSeq = seq;
    if (stream.held) {
      // Bounded even while held: a viewer that would be past its window needs a snapshot anyway.
      if (stream.buffer.length > REMOTE_TERMINAL_WINDOW) this.fallBehind(stream);
      return;
    }
    if (stream.buffer.length >= REMOTE_TERMINAL_CHUNK) this.flush(stream);
    else if (!stream.timer) stream.timer = setTimeout(() => this.flush(stream), this.deps.flushMs ?? REMOTE_TERMINAL_FLUSH_MS);
  }

  private flush(stream: Stream): void {
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    while (stream.buffer && !stream.stale && !stream.dropped && !stream.held) {
      const data = stream.buffer.slice(0, REMOTE_TERMINAL_CHUNK);
      stream.buffer = stream.buffer.slice(data.length);
      stream.unacked += data.length;
      const floor = stream.floor;
      void this.deps.send(stream.clientId, { terminalId: stream.terminalId, kind: 'data', seq: stream.bufferSeq, data }).then((outcome) => {
        if (outcome === 'skipped') this.drop(stream);
        else if (outcome === 'oversize' && stream.floor === floor) {
          // Never sent, so never acknowledged: take it back before resyncing.
          stream.unacked = Math.max(0, stream.unacked - data.length);
          this.fallBehind(stream);
        }
      });
      if (stream.unacked > REMOTE_TERMINAL_WINDOW) this.fallBehind(stream);
    }
  }

  /** Stop streaming until the viewer has acknowledged what it holds, then resync with a snapshot. */
  private fallBehind(stream: Stream): void {
    if (stream.dropped) return;
    if (!stream.stale) this.deps.log('debug', `remote: terminal ${stream.terminalId} viewer ${stream.clientId} fell behind; resyncing once it catches up`);
    stream.stale = true;
    stream.buffer = '';
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    this.maybeResync(stream);
  }

  private onResize(stream: Stream, cols: number, rows: number): void {
    // A snapshot in progress or still to come carries the geometry.
    if (stream.dropped || stream.snapshotting || stream.stale) return;
    if (stream.held) {
      // The viewer does not hold the snapshot yet; resync after it so the geometry is right.
      stream.stale = true;
      stream.buffer = '';
      return;
    }
    this.flush(stream);
    void this.deps.send(stream.clientId, { terminalId: stream.terminalId, kind: 'resize', cols, rows });
  }

  private onReset(stream: Stream, closed: boolean): void {
    if (stream.dropped) return;
    if (closed) {
      void this.deps.send(stream.clientId, { terminalId: stream.terminalId, kind: 'closed' });
      this.drop(stream);
      return;
    }
    // Cleared on the desktop: buffered output predates the clear, and a snapshot replaces it —
    // after any snapshot in progress lands and the viewer has caught up.
    stream.stale = true;
    stream.buffer = '';
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    this.maybeResync(stream);
  }
}
