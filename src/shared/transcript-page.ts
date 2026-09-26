/** Tail-first transcript windows for paired browsers (docs/REMOTE-ACCESS.md §8.5): a phone on a
 *  slow link asks for the newest items and pages back on demand, instead of replaying the whole
 *  transcript on every refresh. Positions are stable because a transcript keeps each item where
 *  it first appeared (updates replace it in place); a clear rewrites the file shorter, which a
 *  client sees as `total` dropping below its window. */
import type { TranscriptItem } from './types';

export const TRANSCRIPT_PAGE_DEFAULT = 200;
/** Upper bound on one response, whatever the request asks for. */
export const TRANSCRIPT_PAGE_MAX = 2000;

export interface TranscriptPage {
  items: TranscriptItem[];
  /** Index of `items[0]` in the whole transcript. */
  start: number;
  total: number;
}

/** Items [start, end) — `end` defaults to the tail, `start` to `limit` items before `end`. */
export function transcriptPage(items: TranscriptItem[], request: { start?: unknown; end?: unknown; limit?: unknown }): TranscriptPage {
  const total = items.length;
  // Anything but a finite number counts as absent.
  const int = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback);
  const end = Math.min(total, Math.max(0, int(request.end, total)));
  const limit = Math.min(TRANSCRIPT_PAGE_MAX, Math.max(1, int(request.limit, TRANSCRIPT_PAGE_DEFAULT)));
  const wanted = int(request.start, end - limit);
  const start = Math.max(0, end - TRANSCRIPT_PAGE_MAX, Math.min(end, wanted));
  return { items: items.slice(start, end), start, total };
}
