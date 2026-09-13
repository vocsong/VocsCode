/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { isTerminalEventTarget } from '../src/renderer/src/components/Transcript';
import { TranscriptFind, search } from '../src/renderer/src/components/TranscriptFind';

function html(s: string): HTMLDivElement {
  const div = document.createElement('div');
  div.innerHTML = s;
  return div;
}

const textOf = (m: Range[]) => m.map((r) => r.toString()).join('');

describe('transcript keyboard routing', () => {
  it('recognizes terminal descendants so Ctrl+F is left to the terminal bar', () => {
    const terminal = document.createElement('div');
    terminal.className = 'term-view';
    const textarea = document.createElement('textarea');
    terminal.append(textarea);
    document.body.append(terminal);
    expect(isTerminalEventTarget(textarea)).toBe(true);
    expect(isTerminalEventTarget(document.createElement('div'))).toBe(false);
    terminal.remove();
  });
});

describe('transcript find search', () => {
  it('finds case-insensitive matches and reports them in document order', () => {
    const matches = search(html('<div>Hello <b>wo</b>rld, hello WORLD again</div>'), 'HELLO');
    expect(matches.length).toBe(2);
    expect(textOf(matches[0])).toBe('Hello');
    expect(textOf(matches[1])).toBe('hello');
  });

  it('finds matches spanning adjacent text nodes', () => {
    const matches = search(html('<div><b>foo</b>bar</div>'), 'foobar');
    expect(matches.length).toBe(1);
    expect(textOf(matches[0])).toBe('foobar');
  });

  it('skips text inside textareas and the find bar itself', () => {
    const matches = search(html('<div><textarea>needle</textarea><span class="find-bar">needle</span><p>needle</p></div>'), 'needle');
    expect(matches.length).toBe(1);
    expect(textOf(matches[0])).toBe('needle');
  });

  it('returns no matches for an empty query', () => {
    expect(search(html('<div>abc</div>'), '')).toEqual([]);
  });
});

describe('transcript find bar mount', () => {
  it('does not touch the highlight registry incorrectly when mounted closed', () => {
    // Repro for the blank-screen crash: the registry is CSS.highlights itself, not an object wrapping it.
    const registry = new Map<string, unknown>();
    (globalThis as unknown as { CSS: unknown }).CSS = { highlights: registry };
    (globalThis as unknown as { Highlight: unknown }).Highlight = class {};
    const container = { current: html('<div>needle</div>') };
    expect(() => render(<TranscriptFind open={false} onClose={() => undefined} container={container} revision={0} />)).not.toThrow();
  });

  it('registers a highlight for the matches when open', () => {
    const registry = new Map<string, unknown>();
    (globalThis as unknown as { CSS: unknown }).CSS = { highlights: registry };
    (globalThis as unknown as { Highlight: unknown }).Highlight = class {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    };
    Element.prototype.scrollIntoView = () => undefined; // jsdom has no layout
    const container = { current: html('<div>needle needle</div>') };
    const { getByPlaceholderText } = render(<TranscriptFind open onClose={() => undefined} container={container} revision={0} />);
    fireEvent.change(getByPlaceholderText('Find in messages'), { target: { value: 'needle' } });
    expect((registry.get('transcript-find-match') as { ranges: Range[] }).ranges.length).toBe(2);
  });
});
