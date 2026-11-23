/** One desktop terminal streamed into this browser (docs/REMOTE-ACCESS.md P3.5): watches it, applies
 *  output past the snapshot floor, acknowledges what it consumed, batches typed input, and takes a
 *  fresh snapshot whenever it (re)starts — after a reconnect, the screen comes back whole instead
 *  of guessing at what the dead socket lost. No DOM; the view supplies the sink. */
import type { IpcChannel, IpcRequest, IpcResponse, PushPayloads } from '@shared/ipc';
import {
  REMOTE_TERMINAL_ACK_CHARS,
  REMOTE_TERMINAL_ACK_MS,
  REMOTE_TERMINAL_INPUT_MAX,
  REMOTE_TERMINAL_INPUT_MS,
  type RemoteTerminalFrame,
  type RemoteTerminalSnapshot
} from '@shared/remote-terminal';

export interface TerminalLink {
  invoke<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>>;
  on(channel: 'push:remoteTerminal', listener: (payload: PushPayloads['push:remoteTerminal']) => void): () => void;
}

export interface TerminalSink {
  /** Replace the screen with a snapshot at the desktop's geometry. */
  reset(snapshot: RemoteTerminalSnapshot): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** The tab was closed on the desktop. */
  closed(): void;
  error(message: string): void;
}

export class RemoteTerminalStream {
  private unsubscribe: (() => void) | null = null;
  /** Bumped by every start/stop so a superseded watch is ignored. */
  private generation = 0;
  /** Snapshot floor; null until the watch answers, while frames wait in `early`. */
  private floor: number | null = null;
  private early: RemoteTerminalFrame[] = [];
  private unackedChars = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private input = '';
  private inputTimer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly link: TerminalLink,
    readonly terminalId: string,
    private readonly sink: TerminalSink
  ) {}

  /** Watches the terminal, or re-watches it after a reconnect: always from a fresh snapshot. */
  async start(): Promise<void> {
    this.stopped = false;
    const generation = ++this.generation;
    this.floor = null;
    this.early = [];
    this.unackedChars = 0;
    this.clearAckTimer();
    this.unsubscribe?.();
    // Subscribe before asking: output can arrive ahead of the answer and is held until it does.
    this.unsubscribe = this.link.on('push:remoteTerminal', (frame) => {
      if (generation === this.generation && frame?.terminalId === this.terminalId) this.onFrame(frame);
    });
    try {
      const snap = await this.link.invoke('terminal:watch', { terminalId: this.terminalId });
      if (generation !== this.generation) return;
      this.applySnapshot(snap);
      const early = this.early;
      this.early = [];
      for (const frame of early) this.onFrame(frame);
    } catch (e) {
      if (generation === this.generation) this.sink.error(e instanceof Error ? e.message : String(e));
    }
  }

  /** Stops watching; the desktop drops this browser's stream. Safe to call twice. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearAckTimer();
    this.flushInput();
    void this.link.invoke('terminal:unwatch', { terminalId: this.terminalId }).catch(() => undefined);
  }

  /** Queues typed or pasted input; a burst within a few milliseconds goes as one frame. */
  send(data: string): void {
    if (!data || this.stopped) return;
    this.input += data;
    if (this.input.length >= REMOTE_TERMINAL_INPUT_MAX) this.flushInput();
    else if (!this.inputTimer) this.inputTimer = setTimeout(() => this.flushInput(), REMOTE_TERMINAL_INPUT_MS);
  }

  private flushInput(): void {
    if (this.inputTimer) clearTimeout(this.inputTimer);
    this.inputTimer = null;
    while (this.input) {
      const data = this.input.slice(0, REMOTE_TERMINAL_INPUT_MAX);
      this.input = this.input.slice(data.length);
      // In order, one at a time: the shell must see keystrokes in the order they were typed.
      this.sending = this.sending.then(() => this.link.invoke('terminal:input', { terminalId: this.terminalId, data })).catch((e: unknown) => {
        this.sink.error(e instanceof Error ? e.message : String(e));
      });
    }
  }

  private applySnapshot(snap: RemoteTerminalSnapshot): void {
    this.floor = snap.seq;
    this.sink.reset(snap);
    // The desktop zeroes its count at every snapshot and waits for this acknowledgement before it
    // sends another, so a flood can never become a stream of full-screen resets.
    this.clearAckTimer();
    this.unackedChars = 0;
    if (!this.stopped) void this.link.invoke('terminal:watchAck', { terminalId: this.terminalId, chars: 0, snapshot: snap.seq }).catch(() => undefined);
  }

  private onFrame(frame: RemoteTerminalFrame): void {
    if (this.floor === null) {
      this.early.push(frame);
      return;
    }
    switch (frame.kind) {
      case 'data':
        // Every streamed character counts against the window, applied or not.
        this.consumed(frame.data.length);
        if (frame.seq > this.floor) this.sink.write(frame.data);
        return;
      case 'reset':
        this.applySnapshot(frame);
        return;
      case 'resize':
        this.sink.resize(frame.cols, frame.rows);
        return;
      case 'closed':
        this.stop();
        this.sink.closed();
        return;
    }
  }

  private consumed(chars: number): void {
    this.unackedChars += chars;
    if (this.unackedChars >= REMOTE_TERMINAL_ACK_CHARS) this.ack();
    else if (!this.ackTimer) this.ackTimer = setTimeout(() => this.ack(), REMOTE_TERMINAL_ACK_MS);
  }

  private ack(): void {
    this.clearAckTimer();
    const chars = this.unackedChars;
    this.unackedChars = 0;
    if (chars > 0 && !this.stopped) void this.link.invoke('terminal:watchAck', { terminalId: this.terminalId, chars }).catch(() => undefined);
  }

  private clearAckTimer(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }
}
