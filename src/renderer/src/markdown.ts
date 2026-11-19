/** Markdown rendering for transcript messages, sanitized before it reaches the DOM. */
import DOMPurify from 'dompurify';
import { Marked, type RendererObject, type Tokens } from 'marked';
import { joinRelative, parseFileLink, parseFileRef, type FileRef } from './file-refs';
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
  /**
   * Workspace-relative folder of the markdown file being rendered. Relative link targets inside a
   * file are relative to that file (`../src/a.ts` in `docs/guide.md`), not to the workspace root.
   */
  fileBase?: string;
}

/** Extra attributes on a file reference: the line number, when the mention carried one. */
const fileAttrs = (ref: FileRef): string => (ref.line ? ` data-line="${ref.line}"` : '');
const fileTitle = (ref: FileRef): string =>
  ref.path.endsWith('/') ? `Show ${ref.path} in the Files panel` : `Preview ${ref.path}${ref.line ? ` at line ${ref.line}` : ''}`;

/** Per-parse state; `parse` is synchronous, so module scope is safe. */
let fileBase: string | undefined;
/** Inside a link, a code span is part of the link's text, never a second, nested file link. */
let linkDepth = 0;

/** What a link target names in the workspace, if anything, with `fileBase` applied to relative targets. */
function linkFileRef(href: string): FileRef | null {
  if (fileBase !== undefined && !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|[\\/#])/.test(href.trim())) {
    const joined = joinRelative(fileBase, href.trim());
    return joined === null ? null : parseFileLink(joined);
  }
  return parseFileLink(href);
}

function buildRenderer(fileLinks: boolean, web: boolean): RendererObject {
  return {
    code({ text, lang }) {
      const language = (lang ?? '').split(/\s+/)[0];
      return `<div class="codeblock"><div class="codeblock-bar"><span class="codeblock-lang">${escapeHtml(language || 'text')}</span><button class="codeblock-copy" data-copy type="button" title="Copy">Copy</button></div><pre><code class="lang-${escapeHtml(language)}">${escapeHtml(text)}</code></pre></div>`;
    },
    link(token: Tokens.Link) {
      const { href, title } = token;
      linkDepth++;
      let inner: string;
      try {
        // The link text is markdown too: `[`a.ts`](a.ts)` shows code, not literal backticks.
        inner = token.tokens?.length ? this.parser.parseInline(token.tokens) : escapeHtml(token.text);
      } finally {
        linkDepth--;
      }
      if (/^https?:\/\//i.test(href ?? '')) {
        // `noopener` on the web: the page that opens is a different origin and must not reach back.
        return `<a href="${escapeHtml(href)}" title="${escapeHtml(title ?? '')}" target="_blank" rel="${web ? 'noopener noreferrer' : 'noreferrer'}">${inner}</a>`;
      }
      const ref = fileLinks ? linkFileRef(href ?? '') : null;
      if (ref) {
        return `<a class="file-ref" role="link" tabindex="0" data-file="${escapeHtml(ref.path)}"${fileAttrs(ref)} title="${escapeHtml(fileTitle(ref))}">${inner}</a>`;
      }
      // Nothing here can open it (mailto:, an anchor, a path outside reach, a script URL): plain text,
      // so nothing looks clickable that is not. The target itself is dropped, never echoed.
      return `<span class="md-link-text"${title ? ` title="${escapeHtml(title)}"` : ''}>${inner}</span>`;
    },
    codespan({ text }) {
      if (fileLinks && linkDepth === 0) {
        const ref = parseFileRef(text);
        if (ref) {
          return `<code class="file-ref" role="link" tabindex="0" data-file="${escapeHtml(ref.path)}"${fileAttrs(ref)} title="${escapeHtml(fileTitle(ref))}">${escapeHtml(text)}</code>`;
        }
      }
      return `<code>${escapeHtml(text)}</code>`;
    },
    image({ href, title, text }) {
      // A remote page must not fetch images from arbitrary hosts; drop them entirely.
      if (web) return '';
      // Transcript images are inert until the assistant resolves them in its own workspace.
      // Never put local paths (or arbitrary URL schemes) into a browser image request.
      if (fileLinks) return `<span data-local-image="${escapeHtml(href ?? '')}" data-image-alt="${escapeHtml(text)}">${escapeHtml(text || 'Image')} (image unavailable)</span>`;
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
  const base = fileLinks ? opts.fileBase : undefined;
  const key = opts.cache === false ? undefined : `${fileLinks ? 'L' : 'P'}${web ? 'W' : ''}${base !== undefined ? `B${base.length}:${base}` : ''}:${md}`;
  if (key !== undefined) {
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.html;
    }
  }
  let html: string;
  fileBase = base;
  linkDepth = 0;
  try {
    html = renderer(fileLinks, web).parse(md, { async: false });
  } catch {
    html = `<pre>${escapeHtml(md)}</pre>`;
  } finally {
    fileBase = undefined;
  }
  // Only web links survive sanitisation; relative, file:, mailto: and custom-scheme hrefs are
  // stripped, matching the main-process app:openExternal handler which only opens http(s).
  // `data-file` is the separate, workspace-scoped channel the Files panel opens.
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel', 'data-copy', 'data-file', 'data-line', 'role', 'tabindex'],
    // Attributes the narrowed ALLOWED_URI_REGEXP would otherwise treat as URI-valued and drop:
    // none of the three is a URI, so they need the URI check waived by name.
    ADD_URI_SAFE_ATTR: ['tabindex', 'target', 'rel'],
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input', ...(web ? ['img', 'image', 'feimage'] : [])],
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
  /** The file reference a click or key landed in; a link's own target wins over anything nested in its text. */
  const fileRefAt = (target: HTMLElement | null): HTMLElement | null =>
    (target?.closest?.('a[data-file]') ?? target?.closest?.('[data-file]')) as HTMLElement | null;
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
    const ref = fileRefAt(target);
    if (ref) {
      e.preventDefault();
      activate(ref);
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
    const el = fileRefAt(e.target as HTMLElement | null);
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
