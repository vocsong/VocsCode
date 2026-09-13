/** @vitest-environment jsdom */
/**
 * Component tests for the windowed transcript: long sessions mount only the visible rows,
 * short sessions still render every row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Transcript, UserMessage } from '../src/renderer/src/components/Transcript';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const scrollPos = new WeakMap<Element, number>();
const originals = {
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
  scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop'),
  scrollIntoView: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 60_000 });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return scrollPos.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      scrollPos.set(this, value);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useStore.setState({ transcripts: {}, loaded: {}, searchJump: null });
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

const session = { id: 's1', title: 't', cwd: '/w', status: 'idle', config: { harness: 'native' }, harnessRef: {}, usage: {} } as unknown as SessionMeta;

function messages(count: number): TranscriptItem[] {
  return Array.from({ length: count }, (_, i) => ({ id: `a${i}`, kind: 'assistant', ts: i, text: `message ${i}` }) as TranscriptItem);
}

describe('user message actions', () => {
  it('shows its timestamp, copies its text, and opens an edit control', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<UserMessage sessionId="s1" item={{ id: 'u1', kind: 'user', ts: new Date('2026-03-14T15:15:00').getTime(), text: 'Message to copy' }} />);

    expect(screen.getByText(/Saturday 3:15 (AM|PM|am|pm)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(writeText).toHaveBeenCalledWith('Message to copy');
    fireEvent.click(screen.getByRole('button', { name: 'Edit and rerun message' }));
    expect((screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement).value).toBe('Message to copy');
  });
});

describe('windowed transcript', () => {
  it('mounts only the visible slice of a long transcript', () => {
    useStore.setState({ transcripts: { s1: messages(400) }, loaded: { s1: true }, showThinking: false, searchJump: null });
    const { container } = render(<Transcript session={session} />);
    const rows = container.querySelectorAll('.transcript-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(400);
    expect(screen.getByText('message 0')).toBeTruthy();
    expect(screen.queryByText('message 399')).toBeNull();
    expect(container.querySelector('.transcript')?.classList.contains('virtual')).toBe(true);
  });

  it('consumes a deep-search jump and restores windowing without collapsing its command group', () => {
    vi.useFakeTimers();
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    const scroll = vi.fn(function (this: HTMLElement) {
      this.closest('.transcript')!.scrollTop = 20_000;
    });
    HTMLElement.prototype.scrollIntoView = scroll;
    const items = messages(400);
    items.splice(200, 0,
      { id: 'cmd1', kind: 'tool', ts: 1, name: 'bash', hint: 'execute', status: 'done' },
      { id: 'cmd2', kind: 'tool', ts: 2, name: 'bash', hint: 'execute', status: 'done' },
      { id: 'turn', kind: 'turn', ts: 3, status: 'completed' });
    useStore.setState({ transcripts: { s1: items }, loaded: { s1: true }, showThinking: false, searchJump: { sessionId: 's1', itemId: 'cmd2', n: 1 } });
    const { container } = render(<Transcript session={session} />);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-item-id="cmd2"]')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2400); });
    expect(useStore.getState().searchJump).toBeNull();
    expect(container.querySelector('.transcript.virtual')).toBeTruthy();
    expect(container.querySelectorAll('.transcript-row').length).toBeLessThan(40);
    expect(container.querySelector('[data-item-id="cmd2"]')).toBeTruthy();
    expect(container.querySelector('.search-jump-hl')).toBeNull();
    act(() => useStore.setState({ transcripts: { s1: [...items, { id: 'new', kind: 'assistant', ts: 500, text: 'new reply', streaming: true }] } }));
    expect(container.querySelectorAll('.transcript-row').length).toBeLessThan(40);
    expect(container.querySelector('[data-item-id="cmd2"]')).toBeTruthy();
  });

  it('does not let an older highlight consume a replacement jump', () => {
    vi.useFakeTimers();
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    useStore.setState({ transcripts: { s1: messages(20) }, loaded: { s1: true }, searchJump: { sessionId: 's1', itemId: 'a2', n: 1 } });
    const { container } = render(<Transcript session={session} />);
    act(() => vi.advanceTimersByTime(2000));
    const newer = { sessionId: 's1', itemId: 'a5', n: 2 };
    act(() => useStore.setState({ searchJump: newer }));
    expect(container.querySelector('[data-item-id="a2"].search-jump-hl')).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(useStore.getState().searchJump).toBe(newer);
    expect(container.querySelector('[data-item-id="a5"].search-jump-hl')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(useStore.getState().searchJump).toBeNull();
    expect(container.querySelector('.search-jump-hl')).toBeNull();
  });

  it('consumes a missing target once loaded rather than disabling windowing indefinitely', () => {
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    useStore.setState({ transcripts: { s1: messages(400) }, loaded: { s1: true }, searchJump: { sessionId: 's1', itemId: 'deleted', n: 1 } });
    const { container } = render(<Transcript session={session} />);
    expect(useStore.getState().searchJump).toBeNull();
    expect(container.querySelectorAll('.transcript-row').length).toBeLessThan(40);
  });

  it('does not rerender an unchanged command group when only the answer streams', () => {
    let durationReads = 0;
    const command = (id: string): TranscriptItem => ({ id, kind: 'tool', ts: 1, name: 'bash', hint: 'execute', status: 'running', get durationMs() { durationReads++; return 10; } });
    const items: TranscriptItem[] = [command('cmd1'), command('cmd2'), { id: 'answer', kind: 'assistant', ts: 3, text: 'first', streaming: true }];
    useStore.setState({ transcripts: { s1: items }, loaded: { s1: true }, showThinking: false, searchJump: null });
    const { container } = render(<Transcript session={session} />);
    expect(container.querySelectorAll('.tool-card')).toHaveLength(2);
    durationReads = 0;
    act(() => useStore.setState({ transcripts: { s1: [...items.slice(0, 2), { id: 'answer', kind: 'assistant', ts: 3, text: 'finished answer', streaming: false }] } }));
    expect(screen.getByText('finished answer')).toBeTruthy();
    expect(container.querySelectorAll('.tool-card')).toHaveLength(2);
    expect(durationReads).toBe(0);
  });

  it('renders every row for a short transcript', () => {
    useStore.setState({ transcripts: { s1: messages(20) }, loaded: { s1: true }, showThinking: false, searchJump: null });
    const { container } = render(<Transcript session={session} />);
    expect(container.querySelectorAll('.transcript-row').length).toBe(20);
    expect(container.querySelector('.transcript')?.classList.contains('virtual')).toBe(false);
  });

  it('renders every row while the find bar is open', () => {
    useStore.setState({ transcripts: { s1: messages(400) }, loaded: { s1: true }, showThinking: false, searchJump: null });
    const { container } = render(<Transcript session={session} />);
    expect(container.querySelectorAll('.transcript-row').length).toBeLessThan(400);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(container.querySelectorAll('.transcript-row').length).toBe(400);
  });
});
