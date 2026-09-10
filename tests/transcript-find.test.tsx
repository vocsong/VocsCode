/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { search } from '../src/renderer/src/components/TranscriptFind';

function html(s: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = s;
  return div;
}

const textOf = (m: Range[]) => m.map((r) => r.toString()).join('');

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
