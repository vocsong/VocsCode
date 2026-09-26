/** Markdown rendering for transcript messages, sanitized before it reaches the DOM. */
import DOMPurify from 'dompurify';
import { Marked, type RendererObject } from 'marked';
import { parseFileRef, type FileRef } from './file-refs';
import { isWeb } from './api';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface MarkdownOptions {
  /**
   * Render inline code spans and relative links that look like workspace files as file references
   * carrying `data-file`. Callers that install handlers with an `openFile` callback opt in; the
   * plain renderer (skills, issue bodies) leaves them as ordinary text.
   */
  fileLinks?: boolean;
  /** Reuse and retain rendered HTML (default true). Set false for intermediate streaming renders. */
  cache?: boolean;
  /** Override the platform's default: a web page drops images and opens links `noopener`. */
  web?: boolean;
}

/** Extra attributes on a file reference: the line number, when the mention carried one. */
const fileAttrs = (ref: FileRef): string => (ref.line ? ` data-line="${ref.line}"` : '');

function buildRenderer(fileLinks: boolean, web: boolean): RendererObject {
  return {
    code({ text, lang }) {
      const language = (lang ?? '').split(/\s+/)[0];
      return `<div class="codeblock"><div class="codeblock-bar"><span class="codeblock-lang">${escapeHtml(language || 'text')}</span><button class="codeblock-copy" data-copy type="button" title="Copy">Copy</button></div><pre><code class="lang-${escapeHtml(language)}">${escapeHtml(text)}</code></pre></div>`;
    },
    link({ href, title, text }) {
      if (fileLinks) {
        const ref = parseFileRef(href ?? '');
        if (ref) {
          return `<a class="file-ref" role="link" tabindex="0" data-file="${escapeHtml(ref.path)}"${fileAttrs(ref)} title="Show ${escapeHtml(ref.path)} in the Files panel">${text}</a>`;
        }
      }
      // `noopener` on the web: the page that opens is a different origin and must not reach back.
      return `<a href="${escapeHtml(href)}" title="${escapeHtml(title ?? '')}" target="_blank" rel="${web ? 'noopener noreferrer' : 'noreferrer'}">${text}</a>`;
    },
    codespan({ text }) {
      if (fileLinks) {
        const ref = parseFileRef(text);
        if (ref) {
          return `<code class="file-ref" role="link" tabindex="0" data-file="${escapeHtml(ref.path)}"${fileAttrs(ref)} title="Show ${escapeHtml(ref.path)} in the Files panel">${escapeHtml(text)}</code>`;
        }
      }
      return `<code>${escapeHtml(text)}</code>`;
    },
    image({ href, title, text }) {
      // A remote page must not fetch images from arbitrary hosts; drop them entirely.
      if (web) return '';
      return `<img src="${escapeHtml(href ?? '')}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
    }
  };
}

const instances = new Map<string, Marked>();
function renderer(fileLinks: boolean, web: boolean): Marked {
  const key = `${fileLinks ? 'L' : 'P'}${web ? 'W' : ''}`;
  let instance = instances.get(key);
  if (!instance) {
    instance = new Marked({ gfm: true, breaks: false });
    instance.use({ renderer: buildRenderer(fileLinks, web) });
    instances.set(key, instance);
  }
  return instance;
}

// Budget retained source keys + sanitized HTML as UTF-16 (2 bytes/code unit). The entry cap
// also bounds Map/object overhead; oversized replies render normally without displacing hits.
const CACHE_MAX_BYTES = 4 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { html: string; bytes: number }>();
let cacheBytes = 0;

export function renderMarkdown(md: string, opts: MarkdownOptions = {}): string {
  if (!md) return '';
  const fileLinks = !!opts.fileLinks;
  const web = opts.web ?? isWeb;
  const key = opts.cache === false ? undefined : `${fileLinks ? 'L' : 'P'}${web ? 'W' : ''}:${md}`;
  if (key !== undefined) {
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.html;
    }
  }
  let html: string;
  try {
    html = renderer(fileLinks, web).parse(md, { async: false });
  } catch {
    html = `<pre>${escapeHtml(md)}</pre>`;
  }
  // Only web links survive sanitisation; relative, file:, mailto: and custom-scheme hrefs are
  // stripped, matching the main-process app:openExternal handler which only opens http(s).
  // `data-file` is the separate, workspace-scoped channel the Files panel opens.
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel', 'data-copy', 'data-file', 'data-line', 'role', 'tabindex'],
    // Attributes the narrowed ALLOWED_URI_REGEXP would otherwise treat as URI-valued and drop:
    // none of the three is a URI, so they need the URI check waived by name.
    ADD_URI_SAFE_ATTR: ['tabindex', 'target', 'rel'],
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input'],
    ALLOWED_URI_REGEXP: /^https?:\/\//i
  });
  if (key !== undefined) {
    const bytes = (key.length + clean.length) * 2;
    if (bytes <= CACHE_MAX_BYTES) {
      while (cache.size >= CACHE_MAX_ENTRIES || cacheBytes + bytes > CACHE_MAX_BYTES) {
        const oldest = cache.entries().next().value;
        if (!oldest) break;
        cache.delete(oldest[0]);
        cacheBytes -= oldest[1].bytes;
      }
      cache.set(key, { html: clean, bytes });
      cacheBytes += bytes;
    }
  }
  return clean;
}

/**
 * Delegated handlers for copy buttons, file references and links inside rendered markdown.
 * Every anchor click is intercepted: http(s) links open in the system browser, file references go
 * to `openFile` when the caller supplied one, and anything else is ignored so the app window never
 * navigates away from the renderer page.
 */
export function installMarkdownHandlers(root: HTMLElement, openExternal: (url: string) => void, openFile?: (path: string, line?: number) => void): () => void {
  const activate = (el: HTMLElement | null): boolean => {
    const p = el?.getAttribute('data-file');
    if (!p || !openFile) return false;
    const line = Number(el?.getAttribute('data-line'));
    openFile(p, Number.isInteger(line) && line > 0 ? line : undefined);
    return true;
  };
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const copyBtn = target.closest('[data-copy]') as HTMLButtonElement | null;
    if (copyBtn) {
      const code = copyBtn.closest('.codeblock')?.querySelector('code');
      if (code) {
        void navigator.clipboard.writeText(code.textContent ?? '');
        copyBtn.textContent = 'Copied';
        setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
      }
      e.preventDefault();
      return;
    }
    if (target.closest('[data-file]')) {
      e.preventDefault();
      activate(target.closest('[data-file]') as HTMLElement);
      return;
    }
    const a = target.closest('a') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) openExternal(href);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = (e.target as HTMLElement | null)?.closest?.('[data-file]') as HTMLElement | null;
    if (!el) return;
    e.preventDefault();
    activate(el);
  };
  const onAuxClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, [data-file]')) e.preventDefault();
  };
  root.addEventListener('click', onClick);
  root.addEventListener('auxclick', onAuxClick);
  if (openFile) root.addEventListener('keydown', onKeyDown);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('auxclick', onAuxClick);
    root.removeEventListener('keydown', onKeyDown);
  };
}
