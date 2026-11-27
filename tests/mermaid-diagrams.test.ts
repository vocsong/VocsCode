/** @vitest-environment jsdom */
/**
 * Mermaid code blocks become diagrams through the production Markdown renderer and handlers.
 * jsdom has no text layout, so Mermaid itself is replaced by a stand-in that returns the kind of
 * SVG it produces (a scoped style, an HTML label, and markup a hostile diagram might smuggle in);
 * `e2e.transcript` draws a real diagram in Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string, source: string) => {
    if (source.includes('BROKEN')) {
      // Mermaid leaves its measuring element behind when a diagram does not parse.
      const stray = document.createElement('div');
      stray.id = `d${id}`;
      document.body.append(stray);
      throw new Error('Parse error on line 2');
    }
    return {
      diagramType: 'flowchart',
      svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" onload="window.pwned = 1"><style>#${id} .node rect{fill:#fff;}</style><g class="node"><rect width="80" height="30"></rect><foreignObject width="80" height="30"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">${source.split('\n')[1]?.trim() ?? ''}</span></div></foreignObject></g><script>window.pwned = 1</script></svg>`
    };
  })
}));
vi.mock('mermaid', () => ({ default: mermaid }));

const FLOW = '```mermaid\nflowchart TD\n  Admin --> Mongo\n```';
const fence = (body: string) => `\`\`\`mermaid\nflowchart TD\n${body}\n\`\`\``;

const disposers: Array<() => void> = [];

// Fresh module instances isolate the diagram cache without a test-only reset API.
async function setup() {
  const { renderMarkdown, installMarkdownHandlers } = await import('../src/renderer/src/markdown');
  const root = document.createElement('div');
  document.body.append(root);
  const dispose = installMarkdownHandlers(root, () => undefined);
  disposers.push(dispose);
  const mount = (md: string, className = 'md') => {
    root.innerHTML = `<div class="${className}">${renderMarkdown(md)}</div>`;
    return root.firstElementChild as HTMLElement;
  };
  return { root, mount, dispose };
}

/** Lets the mutation observer, the lazy import and the render settle. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  vi.resetModules();
  mermaid.initialize.mockClear();
  mermaid.render.mockClear();
  document.documentElement.setAttribute('data-scheme', 'light');
  document.documentElement.setAttribute('data-palette', 'default');
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.innerHTML = '';
  delete (window as { pwned?: number }).pwned;
});

describe('mermaid diagrams in rendered markdown', () => {
  it('draws a mermaid block as a sanitized diagram and keeps its source for Copy and the Code view', async () => {
    const { root, mount } = await setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mount(`Before\n\n${FLOW}\n\nAfter`);
    await settle();

    const block = root.querySelector<HTMLElement>('.codeblock')!;
    expect(block.dataset.diagram).toBe('rendered');
    expect(block.dataset.view).toBe('diagram');
    const svg = block.querySelector('.codeblock-diagram svg')!;
    expect(svg.querySelector('.nodeLabel')?.textContent).toBe('Admin --> Mongo');
    expect(svg.querySelector('style')?.textContent).toContain(`#${svg.id} .node rect`);
    expect(block.querySelector('script')).toBeNull();
    expect(svg.hasAttribute('onload')).toBe(false);
    expect((window as { pwned?: number }).pwned).toBeUndefined();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(mermaid.render.mock.calls[0][1]).toBe('flowchart TD\n  Admin --> Mongo');
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ securityLevel: 'strict', startOnLoad: false }));

    block.querySelector<HTMLButtonElement>('[data-copy]')!.click();
    expect(writeText).toHaveBeenCalledWith('flowchart TD\n  Admin --> Mongo');

    const toggle = block.querySelector<HTMLButtonElement>('[data-diagram-toggle]')!;
    expect(toggle.textContent).toBe('Code');
    toggle.click();
    expect(block.dataset.view).toBe('code');
    expect(toggle.textContent).toBe('Diagram');
    toggle.click();
    expect(block.dataset.view).toBe('diagram');
  });

  it('lets transcript find match only the view on screen, not the hidden source or diagram', async () => {
    const { search } = await import('../src/renderer/src/components/TranscriptFind');
    const { root, mount } = await setup();
    mount(FLOW);
    await settle();
    const block = root.querySelector<HTMLElement>('.codeblock')!;
    const where = () => search(root, 'mongo').map((match) => (match[0].startContainer.parentElement!.closest('pre, .codeblock-diagram') as HTMLElement).tagName);
    expect(where()).toEqual(['DIV']);
    block.querySelector<HTMLButtonElement>('[data-diagram-toggle]')!.click();
    expect(where()).toEqual(['PRE']);
  });

  it('leaves other code blocks alone and never loads the diagram renderer for them', async () => {
    const { root, mount } = await setup();
    mount('```ts\nconst mermaid = 1;\n```');
    await settle();
    const block = root.querySelector<HTMLElement>('.codeblock')!;
    expect(block.dataset.diagram).toBeUndefined();
    expect(block.querySelector('[data-diagram-toggle]')).toBeNull();
    expect(mermaid.initialize).not.toHaveBeenCalled();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('waits for a streaming message to finish before drawing', async () => {
    const { root, mount } = await setup();
    const message = mount(FLOW, 'md streaming');
    await settle();
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(root.querySelector('.codeblock-diagram')).toBeNull();

    message.className = 'md';
    await settle();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.codeblock-diagram svg')).not.toBeNull();
  });

  it('keeps a diagram that does not parse as its code block, with a note and nothing left behind', async () => {
    const { root, mount } = await setup();
    mount(fence('  BROKEN -->'));
    await settle();
    const block = root.querySelector<HTMLElement>('.codeblock')!;
    expect(block.dataset.diagram).toBe('error');
    expect(block.querySelector('.codeblock-diagram')).toBeNull();
    expect(block.querySelector('[data-diagram-toggle]')).toBeNull();
    expect(block.querySelector('code')!.textContent).toContain('BROKEN -->');
    const note = block.querySelector<HTMLElement>('.codeblock-note')!;
    expect(note.textContent).toBe('Diagram could not be drawn');
    expect(note.title).toBe('Parse error on line 2');
    expect(document.querySelector('[id^="dvocs-mermaid"]')).toBeNull();
  });

  it('redraws from its cache when the markdown is mounted again, with a distinct id per copy', async () => {
    const { root, mount } = await setup();
    mount(FLOW);
    await settle();
    expect(mermaid.render).toHaveBeenCalledTimes(1);

    mount(`${FLOW}\n\n${FLOW}`);
    // The cached drawing lands in the same task as the mutation, so the code never paints first.
    await Promise.resolve();
    const drawn = [...root.querySelectorAll('.codeblock-diagram svg')];
    expect(drawn).toHaveLength(2);
    expect(drawn[0].id).not.toBe(drawn[1].id);
    for (const svg of drawn) expect(svg.querySelector('style')?.textContent).toContain(`#${svg.id} `);
    await settle();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it('redraws in the new colors when the theme changes', async () => {
    const { root, mount } = await setup();
    mount(FLOW);
    await settle();
    const light = mermaid.initialize.mock.calls.at(-1)![0];
    expect(light.themeVariables.darkMode).toBe(false);

    document.documentElement.setAttribute('data-scheme', 'dark');
    await settle();
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    const dark = mermaid.initialize.mock.calls.at(-1)![0];
    expect(dark.themeVariables.darkMode).toBe(true);
    expect(dark.themeVariables.primaryTextColor).not.toBe(light.themeVariables.primaryTextColor);
    expect(root.querySelectorAll('.codeblock-diagram svg')).toHaveLength(1);
    expect(root.querySelectorAll('[data-diagram-toggle]')).toHaveLength(1);
  });

  it('stops drawing once the handlers are removed', async () => {
    const { root, mount, dispose } = await setup();
    dispose();
    mount(FLOW);
    await settle();
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(root.querySelector('.codeblock-diagram')).toBeNull();
  });
});
