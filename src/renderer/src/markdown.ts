/** Markdown rendering for transcript messages, sanitized before it reaches the DOM. */
import DOMPurify from 'dompurify';
import { Marked, type RendererObject } from 'marked';
import { parseFileRef, type FileRef } from './file-refs';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface MarkdownOptions {
  /**
   * Render inline code spans and relative links that look like workspace files as file references
   * carrying `data-file`. Callers that install handlers with an `openFile` callback opt in; the
   * plain renderer (skills, issue bodies) leaves them as ordinary text.
   */
  fileLinks?: boolean;
}

/** Extra attributes on a file reference: the line number, when the mention carried one. */
const fileAttrs = (ref: FileRef): string => (ref.line ? ` data-line="${ref.line}"` : '');

function buildRenderer(fileLinks: boolean): RendererObject {
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
      return `<a href="${escapeHtml(href)}" title="${escapeHtml(title ?? '')}" target="_blank" rel="noreferrer">${text}</a>`;
    },
    codespan({ text }) {
      if (fileLinks) {
        const ref = parseFileRef(text);
        if (ref) {
          return `<code class="file-ref" role="link" tabindex="0" data-file="${escapeHtml(ref.path)}"${fileAttrs(ref)} title="Show ${escapeHtml(ref.path)} in the Files panel">${escapeHtml(text)}</code>`;
        }
      }
      return `<code>${escapeHtml(text)}</code>`;
    }
  };
}

const plain = new Marked({ gfm: true, breaks: false });
plain.use({ renderer: buildRenderer(false) });
const linked = new Marked({ gfm: true, breaks: false });
linked.use({ renderer: buildRenderer(true) });

const cache = new Map<string, string>();

export function renderMarkdown(md: string, opts: MarkdownOptions = {}): string {
  if (!md) return '';
  const fileLinks = !!opts.fileLinks;
  const key = `${fileLinks ? 'L' : 'P'}:${md}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let html: string;
  try {
    html = (fileLinks ? linked : plain).parse(md, { async: false });
  } catch {
    html = `<pre>${escapeHtml(md)}</pre>`;
  }
  // Only web links survive sanitisation; relative, file:, mailto: and custom-scheme hrefs are
  // stripped, matching the main-process app:openExternal handler which only opens http(s).
  // `data-file` is the separate, workspace-scoped channel the Files panel opens.
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'data-copy', 'data-file', 'data-line', 'role', 'tabindex'],
    // `tabindex="0"` is not a URI, and the narrowed ALLOWED_URI_REGEXP would otherwise drop it.
    ADD_URI_SAFE_ATTR: ['tabindex'],
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input'],
    ALLOWED_URI_REGEXP: /^https?:\/\//i
  });
  if (cache.size > 500) cache.clear();
  cache.set(key, clean);
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
