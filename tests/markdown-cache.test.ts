/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fresh production module instances isolate the private cache without a test-only reset API.
async function setup() {
  const [{ renderMarkdown }, { Parser }, { default: DOMPurify }] = await Promise.all([
    import('../src/renderer/src/markdown'), import('marked'), import('dompurify'),
  ]);
  const parse = vi.spyOn(Parser, 'parse');
  const sanitize = vi.spyOn(DOMPurify, 'sanitize');
  const expectCalls = (count: number) => {
    expect(parse).toHaveBeenCalledTimes(count);
    expect(sanitize).toHaveBeenCalledTimes(count);
  };
  return { renderMarkdown, expectCalls };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('production markdown cache', () => {
  it('bypasses both lookup and retention without bypassing sanitization', async () => {
    const { renderMarkdown, expectCalls } = await setup();
    const text = '**safe** <script>alert(1)</script>';
    const html = renderMarkdown(text);
    expect(html).toContain('<strong>safe</strong>');
    expect(html).not.toContain('<script>');
    expect(renderMarkdown(text, { cache: false })).toBe(html);
    expect(renderMarkdown(text)).toBe(html);
    expectCalls(2);
    const fresh = '[bad](javascript:alert(1)) <img src="x" onerror="alert(1)">';
    const uncached = renderMarkdown(fresh, { cache: false });
    expect(uncached).not.toMatch(/javascript:|onerror/);
    expect(renderMarkdown(fresh)).toBe(uncached);
    expectCalls(4);
  });

  it('keeps file-link modes separate and caches empty sanitized output', async () => {
    const { renderMarkdown, expectCalls } = await setup();
    const text = 'See `src/main/index.ts:12` and [docs](https://example.com).';
    const plain = renderMarkdown(text);
    const linked = renderMarkdown(text, { fileLinks: true });
    expect(plain).not.toContain('data-file');
    expect(linked).toContain('data-file="src/main/index.ts"');
    expect(linked).toContain('data-line="12"');
    expect(linked).toContain('href="https://example.com"');
    expect(renderMarkdown(text, { fileLinks: false })).toBe(plain);
    expect(renderMarkdown(text, { fileLinks: true })).toBe(linked);
    expectCalls(2);
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('');
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('');
    expectCalls(3);
  });

  it('evicts the least recently used entry at 500 entries, not the entire cache', async () => {
    const { renderMarkdown, expectCalls } = await setup();
    for (let i = 0; i < 500; i++) renderMarkdown(`entry ${i}`);
    renderMarkdown('entry 0');
    renderMarkdown('entry 500');
    renderMarkdown('entry 0');
    renderMarkdown('entry 499');
    renderMarkdown('entry 500');
    expectCalls(501);
    renderMarkdown('entry 1');
    expectCalls(502);
  });

  it('budgets source keys and HTML as UTF-16, evicting least recently used entries', async () => {
    const { renderMarkdown, expectCalls } = await setup();
    // Four ~1 MiB entries fit within 4 MiB; five do not (well below the entry limit).
    const texts = Array.from({ length: 5 }, (_, i) => `${i} ${'x'.repeat(260_000)}`);
    for (const text of texts.slice(0, 4)) renderMarkdown(text);
    renderMarkdown(texts[0]);
    renderMarkdown(texts[4]);
    renderMarkdown(texts[0]);
    renderMarkdown(texts[3]);
    renderMarkdown(texts[4]);
    expectCalls(5);
    renderMarkdown(texts[1]);
    expectCalls(6);
  });

  it('does not retain an oversized message or evict useful entries for it', async () => {
    const { renderMarkdown, expectCalls } = await setup();
    const warm = renderMarkdown('keep this completed message');
    const huge = 'x'.repeat(1_100_000);
    expect(renderMarkdown(huge)).toBe(`<p>${huge}</p>\n`);
    expect(renderMarkdown(huge)).toBe(`<p>${huge}</p>\n`);
    expect(renderMarkdown('keep this completed message')).toBe(warm);
    expectCalls(3);
  });
});
