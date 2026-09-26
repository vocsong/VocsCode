/** Offline transcript mirror (docs/REMOTE-ACCESS.md P4). The desktop seals these shapes with the
 *  shared mirror key and uploads them to the relay as opaque blobs; a paired browser opens them
 *  when the desktop is unreachable. Both halves must agree on the shape, and the relay never sees
 *  it in the clear — so titles, folders and transcript text all stay inside the ciphertext. */
import type { TranscriptItem } from './types';

/** One row of the offline sidebar. */
export interface MirrorIndexEntry {
  id: string;
  title: string;
  status: string;
  harness: string;
  projectRoot: string;
  updatedAt: number;
}

/** The whole sidebar, sealed as one blob so the relay cannot enumerate session titles. */
export interface MirrorIndex {
  hostName: string;
  updatedAt: number;
  /** The session the desktop was last on, so an offline browser can open it. */
  focus?: string | null;
  sessions: MirrorIndexEntry[];
}

/** One session's transcript snapshot. A tail is kept when the full transcript is too large. */
export interface MirrorSnapshot {
  id: string;
  title: string;
  status: string;
  harness: string;
  updatedAt: number;
  /** True when older items were dropped to stay under the size cap. */
  truncated?: boolean;
  items: TranscriptItem[];
}
