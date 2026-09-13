/** @vitest-environment jsdom */
/**
 * Tests for the streaming markdown throttle: parse at most once per interval while a reply
 * streams, and once more as soon as it finishes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

vi.mock('../src/renderer/src/markdown', () => ({ renderMarkdown: vi.fn((md: string) => `<p>${md}</p>`) }));

import { renderMarkdown } from '../src/renderer/src/markdown';
import { STREAM_MARKDOWN_INTERVAL_MS, useStreamingMarkdown } from '../src/renderer/src/use-streaming-markdown';

const calls = () => vi.mocked(renderMarkdown).mock.calls.length;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(renderMarkdown).mockClear();
});

describe('useStreamingMarkdown', () => {
  it('throttles parses while streaming and catches up on the interval', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ text, streaming }: { text: string; streaming: boolean }) => useStreamingMarkdown(text, streaming), {
      initialProps: { text: 'a', streaming: true }
    });
    expect(calls()).toBe(1);
    expect(result.current).toBe('<p>a</p>');

    rerender({ text: 'ab', streaming: true });
    rerender({ text: 'abc', streaming: true });
    expect(calls()).toBe(1);
    expect(result.current).toBe('<p>a</p>');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STREAM_MARKDOWN_INTERVAL_MS);
    });
    expect(calls()).toBe(2);
    expect(result.current).toBe('<p>abc</p>');
  });

  it('parses immediately once the stream finishes', () => {
    const { result, rerender } = renderHook(({ text, streaming }: { text: string; streaming: boolean }) => useStreamingMarkdown(text, streaming), {
      initialProps: { text: 'partial', streaming: true }
    });
    rerender({ text: 'partial and done', streaming: false });
    expect(calls()).toBe(2);
    expect(result.current).toBe('<p>partial and done</p>');
  });

  it('does not re-parse an unchanged message', () => {
    const { rerender } = renderHook(({ text, streaming }: { text: string; streaming: boolean }) => useStreamingMarkdown(text, streaming), {
      initialProps: { text: 'same', streaming: true }
    });
    rerender({ text: 'same', streaming: true });
    rerender({ text: 'same', streaming: false });
    expect(calls()).toBe(1);
  });
});
