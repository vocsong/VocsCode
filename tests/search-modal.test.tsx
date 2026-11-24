/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SearchModal } from '../src/renderer/src/components/SearchModal';
import { useStore } from '../src/renderer/src/store';
import type { SearchResponse } from '../src/shared/types';

function SearchModalHost() {
  const searchOpen = useStore((s) => s.searchOpen);
  return searchOpen ? <SearchModal /> : null;
}

afterEach(() => {
  cleanup();
  useStore.getState().openSearch(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('preserves the query and ignores a late All content response after switching to Transcript', async () => {
  vi.useFakeTimers();
  let resolveAll!: (response: SearchResponse) => void;
  const allResponse = new Promise<SearchResponse>((resolve) => { resolveAll = resolve; });
  const invoke = vi.fn<() => Promise<SearchResponse>>()
    .mockReturnValueOnce(allResponse)
    .mockResolvedValueOnce({
      available: true,
      results: [{ sessionId: 'transcript-session', itemId: 'message-1', kind: 'user', ts: 1, snippet: 'needle in a message' }],
    });
  vi.stubGlobal('harness', { invoke });
  useStore.getState().openSearch(true);
  render(<SearchModalHost />);

  const query = '  needle  ';
  fireEvent.change(screen.getByRole('textbox', { name: 'Search sessions' }), { target: { value: query } });
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });
  expect(invoke).toHaveBeenCalledExactlyOnceWith('sessions:search', { q: 'needle', filters: { archived: false, category: 'all' } });

  const transcript = screen.getByRole('button', { name: 'Transcript' });
  fireEvent.click(transcript);
  expect(transcript.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Search sessions' }).value).toBe(query);
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenNthCalledWith(2, 'sessions:search', { q: 'needle', filters: { archived: false, category: 'transcript' } });
  expect(screen.getByText('needle in a message')).toBeTruthy();

  // Settle the older request last, after the Transcript result is already visible.
  await act(async () => {
    resolveAll({
      available: true,
      results: [{ sessionId: 'title-session', kind: 'meta', ts: 2, snippet: 'needle in a title' }],
    });
  });
  expect(screen.queryByText('needle in a title')).toBeNull();
  expect(screen.queryByText('needle in a message')).not.toBeNull();

  transcript.focus();
  fireEvent.keyDown(transcript, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Session search' })).toBeNull();
});
