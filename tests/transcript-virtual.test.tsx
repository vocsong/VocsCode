/** @vitest-environment jsdom */
/**
 * Component tests for the windowed transcript: long sessions mount only the visible rows,
 * short sessions still render every row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Transcript, UserMessage } from '../src/renderer/src/components/Transcript';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const scrollPos = new WeakMap<Element, number>();
const originals = {
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
  scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')
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
  useStore.setState({ transcripts: {}, loaded: {} });
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
