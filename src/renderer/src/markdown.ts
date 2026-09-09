import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

const renderer = new marked.Renderer();
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
renderer.code = ({ text, lang }) => {
  const language = (lang ?? '').split(/\s+/)[0];
  return `<div class="codeblock"><div class="codeblock-bar"><span class="codeblock-lang">${escapeHtml(language || 'text')}</span><button class="codeblock-copy" data-copy type="button" title="Copy">Copy</button></div><pre><code class="lang-${escapeHtml(language)}">${escapeHtml(text)}</code></pre></div>`;
};
renderer.link = ({ href, title, text }) => `<a href="${escapeHtml(href)}" title="${escapeHtml(title ?? '')}" target="_blank" rel="noreferrer">${text}</a>`;
marked.use({ renderer });

const cache = new Map<string, string>();

export function renderMarkdown(md: string): string {
  if (!md) return '';
  const hit = cache.get(md);
  if (hit) return hit;
  let html: string;
  try {
    html = marked.parse(md, { async: false }) as string;
  } catch {
    html = `<pre>${escapeHtml(md)}</pre>`;
  }
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-copy'], FORBID_TAGS: ['style', 'iframe', 'object', 'embed'] });
  if (cache.size > 500) cache.clear();
  cache.set(md, clean);
  return clean;
}

/** Delegated handlers for copy buttons and external links inside rendered markdown. */
export function installMarkdownHandlers(root: HTMLElement, openExternal: (url: string) => void): () => void {
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
    const a = target.closest('a') as HTMLAnchorElement | null;
    if (a && a.href && /^https?:/i.test(a.href)) {
      e.preventDefault();
      openExternal(a.href);
    }
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
