/** The read/write terminal over the relay (docs/REMOTE-ACCESS.md P3.5): the frames a paired browser
 *  receives for a terminal it watches, and the flow-control numbers both ends agree on. Shared so
 *  the desktop host and the web shell cannot drift. No Node/Electron/DOM imports. */
import type { TerminalInfo } from './terminal';

/** The screen as the desktop has it: a serialized xterm snapshot holding chunks 1..seq, at the
 *  desktop's geometry. Answers `terminal:watch` and arrives again as a `reset` frame. */
export interface RemoteTerminalSnapshot {
  terminalId: string;
  snapshot: string;
  seq: number;
  cols: number;
  rows: number;
  info: TerminalInfo;
}

/** One `push:remoteTerminal` frame. It is sealed to the watching browser alone; it is never part
 *  of the broadcast push surface. A `data` frame applies only when its seq is above the floor of
 *  the snapshot the viewer holds; several PTY chunks coalesce into one frame carrying the seq of
 *  the last. */
export type RemoteTerminalFrame =
  | { terminalId: string; kind: 'data'; seq: number; data: string }
  /** Replace the screen: the viewer fell behind its window, or the desktop cleared it. */
  | ({ kind: 'reset' } & RemoteTerminalSnapshot)
  | { terminalId: string; kind: 'resize'; cols: number; rows: number }
  /** The tab was closed on the desktop. */
  | { terminalId: string; kind: 'closed' };

/** Characters a viewer may hold unacknowledged. Past it the desktop stops streaming to that viewer
 *  (never pausing the shell) and sends one fresh snapshot once the viewer has caught up. A viewer
 *  acknowledges each snapshot it applies, and never has more than one unacknowledged. */
export const REMOTE_TERMINAL_WINDOW = 256 * 1024;
/** Output is coalesced for this long before it is sealed and sent. */
export const REMOTE_TERMINAL_FLUSH_MS = 25;
/** Largest `data` payload in characters. Even if every character escaped to six bytes in JSON and
 *  grew a third under base64, the frame stays well inside the relay's 1 MiB limit. */
export const REMOTE_TERMINAL_CHUNK = 32 * 1024;
/** A viewer acknowledges once it holds this many unacknowledged characters, or after
 *  `REMOTE_TERMINAL_ACK_MS`, whichever comes first. */
export const REMOTE_TERMINAL_ACK_CHARS = 32 * 1024;
export const REMOTE_TERMINAL_ACK_MS = 250;
/** Scrollback tried for a snapshot, largest first, until it fits `REMOTE_TERMINAL_SNAPSHOT_BUDGET`. */
export const REMOTE_TERMINAL_SCROLLBACK_STEPS: readonly number[] = [1000, 300, 100, 0];
/** UTF-8 bytes of the JSON-encoded snapshot allowed before sealing; base64 grows it by a third,
 *  which still leaves room in the relay's 1 MiB frame. */
export const REMOTE_TERMINAL_SNAPSHOT_BUDGET = 600 * 1024;
/** Typed input is batched for this long before it is sent, so a paste or fast typing is one frame. */
export const REMOTE_TERMINAL_INPUT_MS = 16;
/** Largest single `terminal:input` the host accepts from a browser. */
export const REMOTE_TERMINAL_INPUT_MAX = 64 * 1024;
