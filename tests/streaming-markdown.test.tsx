/** @vitest-environment jsdom */
/** Exercise the throttle and cache through the production parser and sanitizer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import DOMPurify from 'dompurify';
import { Parser } from 'marked';
import { renderMarkdown } from '../src/renderer/src/markdown';
import { STREAM_MARKDOWN_INTERVAL_MS, useStreamingMarkdown } from '../src/renderer/src/use-streaming-markdown';

beforeEach(() => {
  vi.spyOn(Parser, 'parse');
  vi.spyOn(DOMPurify, 'sanitize');
});

const expectCalls = (count: number) => {
  expect(Parser.parse).toHaveBeenCalledTimes(count);
  expect(DOMPurify.sanitize).toHaveBeenCalledTimes(count);
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useStreamingMarkdown', () => {
  it('throttles parses while streaming and catches up on the interval', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ text, streaming }: { text: string; streaming: boolean }) => useStreamingMarkdown(text, streaming), {
      initialProps: { text: 'a', streaming: true }
    });
    expectCalls(1);
    expect(result.current).toBe('<p>a</p>\n');

    rerender({ text: 'ab', streaming: true });
    rerender({ text: 'abc', streaming: true });
    expectCalls(1);
    expect(result.current).toBe('<p>a</p>\n');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STREAM_MARKDOWN_INTERVAL_MS);
    });
    expectCalls(2);
    expect(result.current).toBe('<p>abc</p>\n');
  });

  it('parses and caches immediately once the stream finishes, cancelling the pending render', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ text, streaming }: { text: string; streaming: boolean }) => useStreamingMarkdown(text, streaming), {
      initialProps: { text: 'partial', streaming: true }
    });
    rerender({ text: 'partial and pending', streaming: true });
    rerender({ text: 'partial and done', streaming: false });
    expectCalls(2);
    expect(result.current).toBe('<p>partial and done</p>\n');
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_MARKDOWN_INTERVAL_MS); });
    expect(renderMarkdown('partial and done', { fileLinks: true })).toBe(result.current);
    expectCalls(2);
  });

  it('caches the completion even when its text matches the last streamed render', () => {
    const { result, rerender } = renderHook(({ text, streaming }: { text: string; streaming: boolean | undefined }) => useStreamingMarkdown(text, streaming), {
      initialProps: { text: 'same final text', streaming: true as boolean | undefined }
    });
    rerender({ text: 'same final text', streaming: true });
    expectCalls(1);
    rerender({ text: 'same final text', streaming: undefined });
    expectCalls(2);
    expect(renderMarkdown('same final text', { fileLinks: true })).toBe(result.current);
    rerender({ text: 'same final text', streaming: false });
    expectCalls(2);
  });

  it('does not retain growing streaming prefixes but reuses completed renders on remount', async () => {
    vi.useFakeTimers();
    const completed = 'Earlier completed `src/main/index.ts:12`';
    const warm = renderMarkdown(completed, { fileLinks: true });
    const prefixes = Array.from({ length: 32 }, (_, i) => `**Growing reply** ${'x'.repeat((i + 1) * 2048)} <script>alert(1)</script>`);
    const { result, rerender, unmount } = renderHook(({ text, streaming }) => useStreamingMarkdown(text, streaming), {
      initialProps: { text: prefixes[0], streaming: true }
    });
    for (const text of prefixes.slice(1)) {
      rerender({ text, streaming: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_MARKDOWN_INTERVAL_MS); });
      expect(result.current).toContain('<strong>Growing reply</strong>');
      expect(result.current).not.toContain('<script>');
    }
    expectCalls(33);
    const final = prefixes[prefixes.length - 1];
    rerender({ text: final, streaming: false });
    expectCalls(34);
    const finalHtml = result.current;
    unmount();
    const remounted = renderHook(() => useStreamingMarkdown(final, false));
    expect(remounted.result.current).toBe(finalHtml);
    expect(renderMarkdown(completed, { fileLinks: true })).toBe(warm);
    expectCalls(34);
    // Every intermediate prefix, including the initial render, must be a cache miss.
    for (const text of prefixes.slice(0, -1)) renderMarkdown(text, { fileLinks: true });
    expectCalls(65);
  });

  it('cancels an outstanding streaming parse on unmount', async () => {
    vi.useFakeTimers();
    const { rerender, unmount } = renderHook(({ text }) => useStreamingMarkdown(text, true), {
      initialProps: { text: 'unmount initial' }
    });
    rerender({ text: 'unmount pending' });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_MARKDOWN_INTERVAL_MS); });
    expectCalls(1);
  });
});
