/** Tail-first transcript windows for paired browsers (docs/REMOTE-ACCESS.md §8.5): a phone on a
 *  slow link asks for the newest items and pages back on demand, instead of replaying the whole
 *  transcript on every refresh. Positions are stable because a transcript keeps each item where
 *  it first appeared (updates replace it in place); a clear rewrites the file shorter, which a
 *  client sees as `total` dropping below its window.
 *
 *  A window is bounded in bytes as well as items: the relay silently drops a frame over its limit
 *  (REMOTE_FRAME_MAX_BYTES before sealing, roughly a third more on the wire), so items are trimmed
 *  to per-item caps and then as many newest items as the budget holds are served. One item is
 *  always served even when it alone exceeds the budget, so a page can be slow but never empty. */
import type { TranscriptItem } from './types';

export const TRANSCRIPT_PAGE_DEFAULT = 200;
/** Upper bound on one response, whatever the request asks for. */
export const TRANSCRIPT_PAGE_MAX = 2000;
/** Bytes of item JSON one page may carry, before the seal and base64 that reach the relay. */
export const TRANSCRIPT_PAGE_MAX_BYTES = 512 * 1024;
/** Per-item caps for the remote copy: room for a full command, diff or answer, not for a build log. */
export const TOOL_OUTPUT_MAX = 32 * 1024;
export const DIFF_MAX = 16 * 1024;
export const INPUT_MAX = 8 * 1024;

export interface TranscriptPage {
  items: TranscriptItem[];
  /** Index of `items[0]` in the whole transcript. */
  start: number;
  total: number;
}

const encoder = new TextEncoder();
/** What one item costs in the sealed frame, near enough for a budget. */
const bytesOf = (item: TranscriptItem): number => encoder.encode(JSON.stringify(item)).byteLength;

/** The tail of an over-long string, kept because a command or log ends with the answer. */
const tail = (text: string, max: number): string => `${text.slice(text.length - max)}\n[trimmed for remote view: first ${text.length - max} of ${text.length} characters omitted]`;

/** The remote copy of one item: text worth quoting is kept, but unbounded tool output, diffs,
 *  tool input and pasted images are what blow a frame, so they are trimmed or dropped. */
export function trimItemForRemote(item: TranscriptItem): TranscriptItem {
  switch (item.kind) {
    case 'user': {
      if (!item.images?.length) return item;
      return { ...item, images: undefined, imagesOmitted: item.images.length };
    }
    case 'tool': {
      const next = { ...item };
      let changed = false;
      if (next.output && next.output.length > TOOL_OUTPUT_MAX) {
        next.output = tail(next.output, TOOL_OUTPUT_MAX);
        changed = true;
      }
      if (next.changes?.length) {
        let trimmed = false;
        const changes = next.changes.map((change) => {
          if (!change.diff || change.diff.length <= DIFF_MAX) return change;
          trimmed = true;
          return { ...change, diff: tail(change.diff, DIFF_MAX) };
        });
        if (trimmed) {
          next.changes = changes;
          changed = true;
        }
      }
      if (next.input !== undefined) {
        const input = typeof next.input === 'string' ? next.input : JSON.stringify(next.input);
        if (input.length > INPUT_MAX) {
          next.input = tail(input, INPUT_MAX);
          changed = true;
        }
      }
      return changed ? next : item;
    }
    default:
      return item;
  }
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
  const window = items.slice(start, end).map(trimItemForRemote);
  if (!window.length) return { items: window, start, total };
  // Walk backwards so the budget keeps the newest items; the first is included whatever it weighs.
  let used = 0;
  let first = window.length - 1;
  for (let i = window.length - 1; i >= 0; i--) {
    const bytes = bytesOf(window[i]);
    if (i < window.length - 1 && used + bytes > TRANSCRIPT_PAGE_MAX_BYTES) break;
    used += bytes;
    first = i;
  }
  return { items: window.slice(first), start: start + first, total };
}
