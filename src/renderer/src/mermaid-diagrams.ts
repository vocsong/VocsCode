/**
 * Draws ```mermaid code blocks as diagrams once their Markdown is in the DOM.
 *
 * `renderMarkdown` returns a sanitized HTML string, and Mermaid needs a live document to measure
 * text and renders asynchronously, so a diagram cannot be part of that string. Every Markdown root
 * that installs handlers is watched instead: a finished Mermaid block gets its SVG in front of the
 * source, which stays in the DOM for Copy and the Code view. A block that does not parse stays a
 * code block. Mermaid loads on the first diagram, never at startup.
 */
import DOMPurify from 'dompurify';
import type { MermaidConfig } from 'mermaid';
import { CHART_SERIES, variantFor, type ColorScheme } from '../../shared/themes';

type Drawing = { id: string; svg: string } | { error: string; retry?: boolean };
interface Look {
  palette: string;
  scheme: ColorScheme;
  font: string;
}

/** A Mermaid block nothing has claimed yet. A streaming message is skipped until it finishes. */
const UNDRAWN = '.codeblock:not([data-diagram]) > pre > code.lang-mermaid';
const CACHE_MAX_ENTRIES = 40;

const drawings = new Map<string, Drawing>();
const inFlight = new Map<string, Promise<Drawing>>();
/** The drawing each block is waiting for, so a late result for an older theme is dropped. */
const wanted = new WeakMap<HTMLElement, string>();
const roots = new Set<() => void>();
let themeObserver: MutationObserver | undefined;
let queue: Promise<unknown> = Promise.resolve();
let loading: Promise<typeof import('mermaid').default> | undefined;
let seq = 0;

function currentLook(): Look {
  const root = document.documentElement;
  return {
    palette: root.getAttribute('data-palette') ?? '',
    scheme: root.getAttribute('data-scheme') === 'dark' ? 'dark' : 'light',
    font: getComputedStyle(document.body).fontFamily || 'sans-serif'
  };
}

/** Mermaid's `base` theme painted from the active palette, so a diagram matches every theme. */
function config(look: Look): MermaidConfig {
  const p = variantFor(look.palette, look.scheme);
  // The palette's surfaces are all neutral, so where color is the data (pie slices, git branches,
  // chart plots) the analytics charts' categorical series stands in.
  const series = CHART_SERIES[look.scheme];
  const categorical = (name: string, count: number, first: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`${name}${first + i}`, series[i % series.length]]));
  return {
    startOnLoad: false,
    // Strict: markup inside a label is escaped, and a diagram cannot bind click handlers.
    securityLevel: 'strict',
    suppressErrorRendering: true,
    fontFamily: look.font,
    // Flat nodes: the default look's drop shadow is a fixed light gray that glows on a dark theme.
    look: 'classic',
    theme: 'base',
    themeVariables: {
      darkMode: look.scheme === 'dark',
      fontFamily: look.font,
      background: p.bgSunken,
      primaryColor: p.bgElev,
      primaryTextColor: p.fg,
      primaryBorderColor: p.borderStrong,
      secondaryColor: p.bg,
      secondaryTextColor: p.fg,
      secondaryBorderColor: p.border,
      tertiaryColor: p.bg,
      tertiaryTextColor: p.fg,
      tertiaryBorderColor: p.border,
      lineColor: p.fgMuted,
      textColor: p.fg,
      noteBkgColor: p.userBubble,
      noteTextColor: p.fg,
      noteBorderColor: p.borderStrong,
      ...categorical('pie', 12, 1),
      ...categorical('git', 8, 0),
      pieStrokeColor: p.bgSunken,
      pieOuterStrokeColor: p.borderStrong,
      pieOpacity: '1',
      xyChart: { plotColorPalette: series.join(',') }
    }
  };
}

function loadMermaid() {
  loading ??= import('mermaid').then((m) => m.default);
  return loading;
}

async function draw(source: string, look: Look): Promise<Drawing> {
  const id = `vocs-mermaid-r${++seq}`;
  try {
    let mermaid;
    try {
      mermaid = await loadMermaid();
    } catch (error) {
      loading = undefined;
      return { error: error instanceof Error ? error.message : String(error), retry: true };
    }
    mermaid.initialize(config(look));
    const { svg } = await mermaid.render(id, source);
    // Mermaid's own output, sanitized again before it is trusted as markup. Labels are HTML inside
    // <foreignObject>, which only survives when it is named as an integration point.
    const clean = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true, html: true },
      ADD_TAGS: ['foreignObject'],
      HTML_INTEGRATION_POINTS: { foreignobject: true }
    });
    return { id, svg: clean };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    // A failed render leaves Mermaid's measuring element in <body>.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}

/** One drawing per source and look; Mermaid's configuration is global, so renders run in turn. */
function drawingFor(key: string, source: string, look: Look): Promise<Drawing> {
  let pending = inFlight.get(key);
  if (!pending) {
    pending = (queue = queue.then(() => draw(source, look))) as Promise<Drawing>;
    inFlight.set(key, pending);
    void pending.then((drawing) => {
      inFlight.delete(key);
      if ('error' in drawing && drawing.retry) return;
      if (drawings.size >= CACHE_MAX_ENTRIES) drawings.delete(drawings.keys().next().value!);
      drawings.set(key, drawing);
    });
  }
  return pending;
}

function setView(block: HTMLElement, view: 'diagram' | 'code'): void {
  block.dataset.view = view;
  const toggle = block.querySelector<HTMLElement>('[data-diagram-toggle]');
  if (!toggle) return;
  toggle.textContent = view === 'diagram' ? 'Code' : 'Diagram';
  toggle.title = view === 'diagram' ? 'Show the Mermaid source' : 'Show the diagram';
}

function show(block: HTMLElement, drawing: Drawing): void {
  const bar = block.querySelector('.codeblock-bar');
  const copy = bar?.querySelector('[data-copy]');
  if ('error' in drawing) {
    const note = document.createElement('span');
    note.className = 'codeblock-note';
    note.textContent = 'Diagram could not be drawn';
    note.title = drawing.error;
    if (copy) copy.before(note);
    else bar?.append(note);
    block.dataset.diagram = 'error';
    return;
  }
  const view = document.createElement('div');
  view.className = 'codeblock-diagram';
  // Every copy in the document needs its own id: the SVG's styles and arrowheads are keyed on it,
  // and a reference into a hidden copy would not paint.
  view.innerHTML = drawing.svg.split(drawing.id).join(`vocs-mermaid-${++seq}`);
  block.querySelector('pre')?.before(view);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'codeblock-copy codeblock-view';
  toggle.dataset.diagramToggle = '';
  if (copy) copy.before(toggle);
  else bar?.append(toggle);
  block.dataset.diagram = 'rendered';
  setView(block, 'diagram');
}

/** Back to the plain code block, ready to be drawn again. */
function reset(block: HTMLElement): void {
  for (const el of block.querySelectorAll('.codeblock-diagram, .codeblock-note, [data-diagram-toggle]')) el.remove();
  wanted.delete(block);
  delete block.dataset.diagram;
  delete block.dataset.view;
}

function hydrate(code: HTMLElement): void {
  const block = code.closest<HTMLElement>('.codeblock');
  // An unfinished reply re-renders several times a second and its last block may be half written.
  if (!block || block.closest('.md.streaming')) return;
  const source = (code.textContent ?? '').trim();
  if (!source) return;
  const look = currentLook();
  const key = `${look.palette}\n${look.scheme}\n${look.font}\n${source}`;
  const cached = drawings.get(key);
  if (cached) {
    show(block, cached);
    return;
  }
  block.dataset.diagram = 'pending';
  wanted.set(block, key);
  void drawingFor(key, source, look).then((drawing) => {
    if (!block.isConnected || wanted.get(block) !== key) return;
    wanted.delete(block);
    if ('error' in drawing && drawing.retry) reset(block);
    else show(block, drawing);
  });
}

/** One watcher on `<html>` for all roots: a new scheme or palette redraws what is on screen. */
function watchTheme(): void {
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => {
    for (const redraw of roots) redraw();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-scheme', 'data-palette'] });
}

/**
 * Draws the Mermaid blocks under `root`, now and as Markdown is mounted or replaced there.
 * Returns the cleanup.
 */
export function installMermaidDiagrams(root: HTMLElement): () => void {
  if (typeof MutationObserver === 'undefined') return () => undefined;
  const scan = () => {
    for (const code of root.querySelectorAll<HTMLElement>(UNDRAWN)) hydrate(code);
  };
  const redraw = () => {
    for (const block of root.querySelectorAll<HTMLElement>('.codeblock[data-diagram]')) reset(block);
    scan();
  };
  const onClick = (e: MouseEvent) => {
    const toggle = (e.target as HTMLElement).closest?.('[data-diagram-toggle]');
    const block = toggle?.closest<HTMLElement>('.codeblock');
    if (!block) return;
    e.preventDefault();
    setView(block, block.dataset.view === 'diagram' ? 'code' : 'diagram');
  };
  // `class` is watched because the end of a stream changes nothing else: the last streamed HTML
  // is already the final HTML.
  const observer = new MutationObserver(scan);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  root.addEventListener('click', onClick);
  roots.add(redraw);
  watchTheme();
  scan();
  return () => {
    observer.disconnect();
    root.removeEventListener('click', onClick);
    roots.delete(redraw);
  };
}
