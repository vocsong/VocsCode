/**
 * Unit tests for the transcript virtual-window math.
 */
import { describe, expect, it } from 'vitest';
import { chunkKey, estimateChunkHeight, windowRange } from '../src/renderer/src/transcript-window';
import type { TranscriptItem } from '../src/shared/types';

const item = (kind: TranscriptItem['kind'], id: string): TranscriptItem => ({ id, kind, ts: 0 }) as TranscriptItem;

describe('windowRange', () => {
  it('renders nothing for an empty list', () => {
    expect(windowRange([0], 0, 500)).toEqual({ start: 0, end: 0 });
  });

  it('starts at zero when the viewport is at the top and overscan covers it', () => {
    expect(windowRange([0, 100, 200], 0, 50, 400)).toEqual({ start: 0, end: 2 });
  });

  it('windows around the middle of a long list', () => {
    const tops = Array.from({ length: 101 }, (_, i) => i * 100);
    const range = windowRange(tops, 5000, 300, 400);
    expect(range.start).toBeGreaterThan(0);
    expect(range.end).toBeLessThan(100);
    expect(tops[range.start]!).toBeLessThanOrEqual(5000);
    expect(tops[range.end]!).toBeGreaterThanOrEqual(5300);
  });

  it('clamps the end at the last row', () => {
    const tops = Array.from({ length: 11 }, (_, i) => i * 100);
    const range = windowRange(tops, 900, 300, 400);
    expect(range.end).toBe(10);
  });

  it('never returns an inverted range for zero-height viewports', () => {
    const tops = Array.from({ length: 5 }, (_, i) => i * 50);
    const range = windowRange(tops, 0, 0, 0);
    expect(range.start).toBeLessThanOrEqual(range.end);
    expect(range.end).toBeLessThanOrEqual(4);
  });
});

describe('chunk helpers', () => {
  it('keys single chunks by item id and groups by the group id', () => {
    const single = item('assistant', 'a1');
    expect(chunkKey({ kind: 'single', item: single })).toBe('a1');
    expect(chunkKey({ kind: 'group', id: 'g1', entries: [single] })).toBe('group:g1');
  });

  it('estimates a positive height for every chunk kind', () => {
    const kinds: TranscriptItem['kind'][] = ['user', 'assistant', 'tool', 'approval', 'info', 'turn', 'plan'];
    for (const kind of kinds) {
      expect(estimateChunkHeight({ kind: 'single', item: item(kind, kind) })).toBeGreaterThan(0);
    }
    expect(estimateChunkHeight({ kind: 'group', id: 'g', entries: [] })).toBeGreaterThan(0);
  });
});
