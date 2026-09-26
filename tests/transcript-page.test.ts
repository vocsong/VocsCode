/** Tail-first transcript windows for paired browsers (src/shared/transcript-page.ts): the
 *  web client loads the newest items, refreshes from its window's start, and pages back. */
import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_PAGE_DEFAULT, TRANSCRIPT_PAGE_MAX, transcriptPage } from '../src/shared/transcript-page';
import type { TranscriptItem } from '../src/shared/types';

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, kind: 'user', ts: i, text: `m${i}` }) as TranscriptItem);

describe('transcript pages', () => {
  it('serves the newest items first, then earlier pages and refreshes from a window start', () => {
    const all = items(500);
    const tail = transcriptPage(all, {});
    expect(tail.total).toBe(500);
    expect(tail.start).toBe(500 - TRANSCRIPT_PAGE_DEFAULT);
    expect(tail.items.map((i) => i.id).at(-1)).toBe('i499');
    const earlier = transcriptPage(all, { start: tail.start - 50, end: tail.start });
    expect(earlier.items.map((i) => i.id)).toEqual(all.slice(250, 300).map((i) => i.id));
    // A refresh re-reads everything from the window's start, including items appended since.
    const grown = items(510);
    expect(transcriptPage(grown, { start: 300 })).toMatchObject({ start: 300, total: 510 });
    expect(transcriptPage(grown, { start: 300 }).items).toHaveLength(210);
    expect(transcriptPage(all, { limit: 5 }).items.map((i) => i.id)).toEqual(['i495', 'i496', 'i497', 'i498', 'i499']);
  });

  it('clamps hostile or stale requests instead of throwing or overflowing', () => {
    const all = items(3000);
    expect(transcriptPage(all, { start: 0 }).items).toHaveLength(TRANSCRIPT_PAGE_MAX);
    expect(transcriptPage(all, { start: 0 }).start).toBe(3000 - TRANSCRIPT_PAGE_MAX);
    expect(transcriptPage(all, { limit: 1e9 }).items).toHaveLength(TRANSCRIPT_PAGE_MAX);
    expect(transcriptPage(all, { start: -5, end: 10 })).toMatchObject({ start: 0, total: 3000 });
    expect(transcriptPage(all, { start: 'x', end: 'y', limit: null })).toMatchObject({ start: 3000 - TRANSCRIPT_PAGE_DEFAULT });
    // A cleared transcript is shorter than the window a client still holds: it gets what exists.
    expect(transcriptPage(items(3), { start: 200 })).toEqual({ items: [], start: 3, total: 3 });
    expect(transcriptPage([], {})).toEqual({ items: [], start: 0, total: 0 });
  });
});
