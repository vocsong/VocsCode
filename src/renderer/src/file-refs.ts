/**
 * Recognition and workspace resolution for file paths mentioned in transcript markdown.
 *
 * The rules deliberately stay conservative: a false positive turns prose into a link that opens
 * nothing, so a token only counts when it looks like a real file (a known extension or a bare
 * project file such as `Dockerfile`) or like an explicit directory reference ending in a slash.
 */

/** Extensions common enough that `name.ext` is almost always a file, never a product name or sentence. */
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'cts', 'mts',
  'json', 'jsonc', 'json5', 'md', 'mdx', 'markdown',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xhtml',
  'py', 'pyi', 'rs', 'go', 'java', 'kt', 'kts', 'scala', 'clj', 'cljs', 'cljc',
  'cs', 'vb', 'fs', 'fsx', 'rb', 'php', 'swift', 'm', 'mm', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx',
  'r', 'jl', 'lua', 'dart', 'ex', 'exs', 'erl', 'hrl', 'hs', 'lhs', 'pl', 'pm', 'zig', 'nim', 'asm',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'thrift', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'txt', 'text', 'log', 'csv', 'tsv', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'pdf',
  'lock', 'mod', 'sum', 'gradle', 'cmake', 'tf', 'tfvars', 'hcl', 'nix', 'mk', 'make', 'awk', 'diff', 'patch', 'ipynb',
  'vue', 'svelte', 'astro', 'wasm', 'wat', 'map', 'zip', 'tar', 'gz', 'tgz', 'rar', '7z',
  'pem', 'crt', 'cer', 'key', 'p12', 'pfx', 'pub', 'asc', 'md5', 'sha1', 'sha256', 'gpg'
]);

/** Extension-less project files worth linking when they appear on their own. */
const BARE_FILENAMES = new Set([
  'dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile', 'brewfile', 'justfile', 'vagrantfile', 'jenkinsfile',
  'license', 'readme', 'changelog', 'codeowners',
  '.env', '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc', '.babelrc'
]);

/** Product names that look like `name.js` but are never files in the workspace. */
const NOT_FILES = new Set([
  'node.js', 'next.js', 'nuxt.js', 'vue.js', 'angular.js', 'ember.js', 'backbone.js', 'jquery.js',
  'three.js', 'd3.js', 'moment.js', 'day.js', 'express.js', 'alpine.js', 'chart.js', 'p5.js',
  'lodash.js', 'underscore.js', 'knockout.js', 'jasmine.js', 'mocha.js', 'mermaid.js'
]);

export interface FileRef {
  /** Path with backslashes normalised to slashes and any line suffix removed; directories end with `/`. */
  path: string;
  /** 1-based line number when the mention carried one (`foo.ts:12`, `foo.ts:12:9`, `foo.ts#L12`). */
  line?: number;
}

/** `foo.ts:12`, `foo.ts:12:9` and `foo.ts#L12` all point at a line inside the file. */
const LINE_SUFFIX = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+))$/;

/**
 * Parses a single token (an inline code span or a relative link target) as a workspace path.
 * Returns null for anything that is not confidently a file or directory reference.
 */
export function parseFileRef(raw: string): FileRef | null {
  let text = raw.trim();
  if (!text || text.length > 240) return null;

  let line: number | undefined;
  const suffix = LINE_SUFFIX.exec(text);
  if (suffix && suffix[1]) {
    text = suffix[1];
    const n = Number(suffix[2] ?? suffix[3]);
    if (Number.isInteger(n) && n > 0) line = n;
  }

  // Whitespace, markdown markup, globs and shell syntax all mean this is prose, not a path.
  if (/[\s`"'<>|*?{}()[\]!$&=;,^~]/.test(text)) return null;
  if (text.includes('://') || text.startsWith('//') || text.startsWith('-')) return null;
  // A leading `@` is an npm scope (`@scope/pkg/index.ts`), not a workspace path.
  if (text.startsWith('@')) return null;
  // After a line suffix, a colon can only belong to a Windows drive letter.
  if ((/^[A-Za-z]:[\\/]/.test(text) ? text.slice(2) : text).includes(':')) return null;

  const isDir = /[\\/]$/.test(text);
  const normalized = text.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '');
  const segments = normalized.split('/').filter((seg, i) => !(i === 0 && seg === ''));
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  if (isDir) return { path: `${normalized}/` };

  const base = segments[segments.length - 1]!;
  if (!looksLikeFileName(base)) return null;
  return line ? { path: normalized, line } : { path: normalized };
}

function looksLikeFileName(base: string): boolean {
  const lower = base.toLowerCase();
  if (NOT_FILES.has(lower)) return false;
  if (BARE_FILENAMES.has(lower)) return true;
  const ext = /\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(base)?.[1];
  return !!ext && FILE_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Resolves a mention to a path the workspace-scoped `fs:read`/`fs:list` handlers accept:
 * relative mentions pass through, absolute ones are stripped of the session cwd prefix, and
 * anything outside the workspace resolves to null. Returns '' when the target is the cwd itself.
 */
export function workspaceRelativePath(cwd: string, target: string): string | null {
  const raw = target.trim().replace(/\\/g, '/');
  if (!raw) return null;
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const windows = /^[A-Za-z]:([\\/]|$)/.test(root);
  const isAbsolute = /^[A-Za-z]:\//.test(raw) || raw.startsWith('/');

  let rel: string;
  if (!isAbsolute) {
    rel = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  } else if (windows && raw.startsWith('/')) {
    // `/src/foo.ts` with a Windows cwd is how replies write workspace-root paths; treating it as
    // absolute would point at the drive root and always miss the workspace.
    rel = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  } else {
    const candidate = raw.replace(/\/+$/, '');
    // Windows paths are case-insensitive on every platform that can produce them here.
    const fold = /^[A-Za-z]:\//.test(root) || /^[A-Za-z]:\//.test(candidate);
    const base = root === '' ? '/' : root;
    const prefix = base.endsWith('/') ? base : `${base}/`;
    const same = fold ? candidate.toLowerCase() === base.toLowerCase() : candidate === base;
    const startsWith = fold ? candidate.toLowerCase().startsWith(prefix.toLowerCase()) : candidate.startsWith(prefix);
    if (same) return '';
    if (!startsWith) return null;
    rel = candidate.slice(prefix.length);
  }
  if (rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return rel;
}
