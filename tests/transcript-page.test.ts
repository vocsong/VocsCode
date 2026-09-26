/** Tail-first transcript windows for paired browsers (src/shared/transcript-page.ts): the
 *  web client loads the newest items, refreshes from its window's start, and pages back. */
import { describe, expect, it } from 'vitest';
import { DIFF_MAX, INPUT_MAX, TOOL_OUTPUT_MAX, TRANSCRIPT_PAGE_DEFAULT, TRANSCRIPT_PAGE_MAX, TRANSCRIPT_PAGE_MAX_BYTES, transcriptPage, trimItemForRemote } from '../src/shared/transcript-page';
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

describe('remote trimming', () => {
  it('drops user images and reports how many were left behind', () => {
    const item: TranscriptItem = {
      id: 'u1', kind: 'user', ts: 0, text: 'look at these',
      images: [{ mimeType: 'image/png', data: 'A'.repeat(10_000), name: 'a.png' }, { mimeType: 'image/png', data: 'B', name: 'b.png' }]
    };
    expect(trimItemForRemote(item)).toEqual({ id: 'u1', kind: 'user', ts: 0, text: 'look at these', images: undefined, imagesOmitted: 2 });
    // A user message without images passes through untouched.
    const plain: TranscriptItem = { id: 'u2', kind: 'user', ts: 0, text: 'plain' };
    expect(trimItemForRemote(plain)).toBe(plain);
  });

  it('keeps the tail of oversized tool output, diffs and input', () => {
    const item: TranscriptItem = {
      id: 't1', kind: 'tool', ts: 0, name: 'Bash', status: 'done',
      output: `${'x'.repeat(TOOL_OUTPUT_MAX + 50)}THE END`,
      input: { command: 'y'.repeat(INPUT_MAX + 50) },
      changes: [{ path: 'a.ts', kind: 'update', diff: `${'z'.repeat(DIFF_MAX + 50)}FINAL DIFF` }]
    };
    const trimmed = trimItemForRemote(item);
    if (trimmed.kind !== 'tool') throw new Error('expected a tool item');
    expect(trimmed.output).toContain('THE END');
    expect(trimmed.output).toContain('[trimmed for remote view');
    expect(trimmed.output!.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX + 100);
    expect(typeof trimmed.input).toBe('string');
    expect(trimmed.input as string).toContain('[trimmed for remote view');
    expect(trimmed.changes![0].diff).toContain('FINAL DIFF');
    expect(trimmed.changes![0].diff).toContain('[trimmed for remote view');
  });

  it('serves the newest items that fit the page budget, starting where it says', () => {
    // Each item's output is bigger than the per-item cap, so trimming alone cannot make a
    // 40-item page fit: the budget must drop older items, not the newest ones.
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, kind: 'tool', ts: i, name: 'Bash', status: 'done', output: 'x'.repeat(TOOL_OUTPUT_MAX) }) as TranscriptItem);
    const page = transcriptPage(many, {});
    expect(page.total).toBe(40);
    expect(page.items.length).toBeLessThan(40);
    expect(page.items.at(-1)?.id).toBe('t39');
    expect(page.start).toBe(40 - page.items.length);
    expect(page.items[0].id).toBe(`t${page.start}`);
  });

  it('serves one item even when it alone exceeds the whole budget', () => {
    const huge: TranscriptItem = { id: 'big', kind: 'assistant', ts: 1, text: 'x'.repeat(TRANSCRIPT_PAGE_MAX_BYTES + 1) };
    const small: TranscriptItem = { id: 'small', kind: 'info', ts: 0, level: 'info', text: 'ok' };
    expect(transcriptPage([small, huge], {})).toEqual({ items: [huge], start: 1, total: 2 });
  });
});
