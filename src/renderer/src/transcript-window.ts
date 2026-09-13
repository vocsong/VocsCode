/**
 * Window math for the transcript's variable-height virtual list. Rows are measured lazily as
 * they render; chunks that have never been measured fall back to a per-kind estimate, so the
 * offsets stay monotonic and the scrollbar does not jump around while the list streams.
 */
import type { TranscriptItem } from '../../shared/types';

/** A run of shell commands collapses into one group chunk; everything else renders alone. */
export type RenderChunk =
  | { kind: 'single'; item: TranscriptItem }
  | { kind: 'group'; id: string; entries: TranscriptItem[] };

/** Stable row key: group chunks keep the id of their first command. */
export function chunkKey(chunk: RenderChunk): string {
  return chunk.kind === 'group' ? `group:${chunk.id}` : chunk.item.id;
}

/** Rough row height for a chunk that has not been measured yet, including the 10px flex gap. */
export function estimateChunkHeight(chunk: RenderChunk): number {
  if (chunk.kind === 'group') return 190;
  switch (chunk.item.kind) {
    case 'assistant':
      return 100;
    case 'tool':
      return 140;
    case 'approval':
      return 170;
    case 'plan':
      return 130;
    case 'user':
      return 70;
    default:
      return 46;
  }
}

/**
 * Visible row range for the current scroll position. `tops[i]` is the top offset of row i and
 * `tops[rows]` the total content height. Returns `{ start, end }` with `end` exclusive.
 */
export function windowRange(tops: number[], scrollTop: number, viewport: number, overscan = 400): { start: number; end: number } {
  const rows = Math.max(0, tops.length - 1);
  if (rows === 0) return { start: 0, end: 0 };
  const from = Math.max(0, scrollTop - overscan);
  const to = scrollTop + Math.max(0, viewport) + overscan;
  let start = 0;
  while (start + 1 < rows && tops[start + 1]! < from) start++;
  let end = start;
  while (end < rows && tops[end]! < to) end++;
  return { start, end };
}
