// `.worktreeinclude`: the gitignored files a new worktree gets a copy of.
//
// A worktree is a fresh checkout, so the untracked files a project needs to run — `.env`,
// `.env.local`, a local secrets config — are missing from it. A `.worktreeinclude` at the project
// root lists them in .gitignore syntax; when the app creates a worktree it copies every file that
// matches a pattern AND is gitignored from the project root into the new checkout. Tracked files
// are never copied (the checkout already has them), and nothing in the checkout is overwritten.
//
// The file name and its rules follow Claude Code's, so one file serves both. A pattern starting
// with `**/` — and a bare name like `config.json`, which means the same — does not reach into a
// directory that is gitignored as a whole (`node_modules/`) unless that directory itself matches
// or the first name after `**/` is one of the names in the directory's path; so `config.json`
// copies a root config, not every `node_modules/*/config.json`. To copy out of such a directory,
// name it: `vendor/**/config.json`.
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/** The app's own folder (worktrees, project wiki): never copied, whatever the patterns say. */
const APP_DIR = '.vocs-code';

export interface IncludeRule {
  negate: boolean;
  /** A trailing `/`: matches directories only. */
  dirOnly: boolean;
  /** The pattern's segments from the root; an unanchored pattern (no inner `/`) starts with `**`. */
  segments: string[];
  regex: RegExp;
}

/** git's ignored, untracked paths under the root, relative to it with `/` separators. */
export interface IgnoredListing {
  /**
   * `git ls-files --others --ignored --exclude-standard --directory`: ignored files, and a
   * directory whose every file is ignored as one entry ending in `/`.
   */
  entries: string[];
  /** Listed directories AND entry ancestors ignored themselves (`node_modules/`), with trailing `/`. */
  ignoredDirs: Set<string>;
}

export interface IncludeResult {
  /** Paths copied, relative to the root with `/` separators. */
  copied: string[];
  /** `<path>: <reason>` for each file that matched but could not be copied. */
  failed: string[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Index of the `]` closing the bracket expression opened at `start`, or -1 when it is unclosed. */
function classEnd(glob: string, start: number): number {
  let j = start + 1;
  if (glob[j] === '!' || glob[j] === '^') j++;
  if (glob[j] === ']') j++;
  for (; j < glob.length; j++) {
    if (glob[j] === '\\') j++;
    else if (glob[j] === '[' && glob[j + 1] === ':' && glob.indexOf(':]', j + 2) >= 0) j = glob.indexOf(':]', j + 2) + 1;
    else if (glob[j] === ']') return j;
  }
  return -1;
}

/** Git's named character classes use ASCII, not JavaScript's Unicode whitespace classes. */
const POSIX_CLASSES: Record<string, string> = {
  alnum: 'a-zA-Z0-9', alpha: 'a-zA-Z', blank: ' \\t', cntrl: '\\x00-\\x1f\\x7f',
  digit: '0-9', graph: '\\x21-\\x7e', lower: 'a-z', print: '\\x20-\\x7e',
  punct: '\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e', space: ' \\t\\r\\n\\v\\f', upper: 'A-Z', xdigit: 'a-fA-F0-9'
};

function classToRegex(body: string): string {
  const negate = body[0] === '!' || body[0] === '^';
  const escapeClass = (c: string): string => '\\[]^-'.includes(c) ? `\\${c}` : c;
  let set = '';
  let previous = '';
  for (let i = negate ? 1 : 0; i < body.length; i++) {
    let c = body[i];
    if (c === '\\') {
      c = body[++i];
    } else if (c === '[' && body[i + 1] === ':') {
      const end = body.indexOf(':]', i + 2);
      if (end >= 0) {
        const name = body.slice(i + 2, end);
        if (!Object.hasOwn(POSIX_CLASSES, name)) return '(?!)';
        set += POSIX_CLASSES[name];
        previous = '';
        i = end + 1;
        continue;
      }
    } else if (c === '-' && previous && i + 1 < body.length) {
      let end = body[++i];
      if (end === '\\') end = body[++i];
      // Git already matched the starting character; a reversed range adds no others.
      if (previous <= end) set += `${escapeClass(previous)}-${escapeClass(end)}`;
      previous = '';
      continue;
    }
    set += escapeClass(c);
    previous = c;
  }
  return negate ? `[^/${set}]` : `(?!/)[${set}]`;
}

/** A gitignore glob as a regex body: `*`, `?` and `[...]` stay within one segment; `**` as a whole segment spans any. */
function globToRegex(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      const wholeSegment = glob[i + 1] === '*' && (i === 0 || glob[i - 1] === '/') && (i + 2 === glob.length || glob[i + 2] === '/');
      if (wholeSegment && i + 2 === glob.length) {
        re += '.*';
        i += 1;
      } else if (wholeSegment) {
        re += '(?:.*/)?';
        i += 2;
      } else {
        while (glob[i + 1] === '*') i++;
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = classEnd(glob, i);
      if (end < 0) return '(?!)';
      re += classToRegex(glob.slice(i + 1, end));
      i = end;
    } else if (c === '\\' && i + 1 < glob.length) {
      re += escapeRe(glob[++i]);
    } else {
      re += escapeRe(c);
    }
  }
  return re;
}

const segmentMatches = (glob: string, name: string): boolean => new RegExp(`^${globToRegex(glob)}$`).test(name);

/** Parses `.worktreeinclude` text with .gitignore rules: comments, `!` negation, leading and trailing `/`, `**`. */
export function parseWorktreeInclude(text: string): IncludeRule[] {
  const rules: IncludeRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let end = raw.length;
    while (raw[end - 1] === ' ') {
      let backslashes = 0;
      for (let i = end - 2; i >= 0 && raw[i] === '\\'; i--) backslashes++;
      if (backslashes % 2) break;
      end--;
    }
    let line = raw.slice(0, end);
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) continue;
    const segments = anchored ? line.split('/') : ['**', line];
    rules.push({ negate, dirOnly, segments, regex: new RegExp(`^${globToRegex(segments.join('/'))}$`) });
  }
  return rules;
}

function lastMatch(rules: IncludeRule[], rel: string, isDir: boolean): boolean | undefined {
  let hit: boolean | undefined;
  for (const r of rules) if ((!r.dirOnly || isDir) && r.regex.test(rel)) hit = !r.negate;
  return hit;
}

/**
 * Whether `rel` (root-relative, `/` separators) is named by the rules. As in .gitignore, a matched
 * parent directory takes everything under it, and the last matching rule decides otherwise.
 */
export function isIncluded(rules: IncludeRule[], rel: string, isDir: boolean): boolean {
  const segs = rel.split('/');
  for (let k = 1; k < segs.length; k++) if (lastMatch(rules, segs.slice(0, k).join('/'), true)) return true;
  return lastMatch(rules, rel, isDir) === true;
}

/** Whether a rule can name a path inside `dirSegs`, a directory gitignored as a whole that does not itself match. */
function reaches(rule: IncludeRule, dirSegs: string[]): boolean {
  if (rule.negate) return true;
  const segs = rule.segments;
  if (segs[0] === '**') return segs.length > 1 && dirSegs.some((s) => segmentMatches(segs[1], s));
  for (let i = 0; i < dirSegs.length; i++) {
    if (segs[i] === '**') return true;
    if (i >= segs.length - 1 || !segmentMatches(segs[i], dirSegs[i])) return false;
  }
  return true;
}

/** Every file and symlink under `dir` (root-relative), without following symlinked directories. */
async function* walk(root: string, dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) yield* walk(root, rel);
    else if (e.isFile() || e.isSymbolicLink()) yield rel;
  }
}

/**
 * Creates `relDir` under `root` one segment at a time, refusing a segment that is a symlink or a
 * file: the checkout comes from a branch, and a committed `config -> /elsewhere` link must not
 * carry a copied secret out of the worktree.
 */
async function safeParent(root: string, relDir: string): Promise<boolean> {
  if (relDir === '.' || relDir === '') return true;
  let cur = root;
  // Git always uses `/`; a backslash is a literal filename character on POSIX.
  for (const seg of relDir.split('/')) {
    cur = path.join(cur, seg);
    try {
      const st = await fs.lstat(cur);
      if (!st.isDirectory()) return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      await fs.mkdir(cur).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      });
      if (!(await fs.lstat(cur)).isDirectory()) return false;
    }
  }
  return true;
}

/**
 * Copies the gitignored files `<sourceRoot>/.worktreeinclude` names into `worktree`, a checkout just
 * created from `sourceRoot`. Without the file, git is not asked and nothing is copied.
 */
export async function copyWorktreeIncludes(sourceRoot: string, worktree: string, listIgnored: () => Promise<IgnoredListing>): Promise<IncludeResult> {
  const result: IncludeResult = { copied: [], failed: [] };
  let text: string;
  try {
    text = await fs.readFile(path.join(sourceRoot, WORKTREE_INCLUDE_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw e;
  }
  const rules = parseWorktreeInclude(text);
  if (!rules.some((r) => !r.negate)) return result;

  const copy = async (rel: string): Promise<void> => {
    const src = path.join(sourceRoot, rel);
    const dst = path.join(worktree, rel);
    try {
      if (!(await safeParent(worktree, path.posix.dirname(rel)))) {
        result.failed.push(`${rel}: a parent in the worktree is a symlink or a file`);
        return;
      }
      const st = await fs.lstat(src);
      if (st.isSymbolicLink()) await fs.symlink(await fs.readlink(src), dst);
      else if (st.isFile()) await fs.copyFile(src, dst, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      else return;
      result.copied.push(rel);
    } catch (e) {
      // The checkout already has the path (the branch tracks it): its own copy wins.
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return;
      result.failed.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const listing = await listIgnored();
  const entries = listing.entries.filter((e) => e && e !== `${APP_DIR}/` && !e.startsWith(`${APP_DIR}/`));
  const whole = new Set(entries.filter((e) => listing.ignoredDirs.has(e)));
  const parents = (entry: string): string[] => {
    const dirs: string[] = [];
    for (let i = entry.indexOf('/'); i >= 0 && i < entry.length - 1; i = entry.indexOf('/', i + 1)) dirs.push(entry.slice(0, i + 1));
    return dirs;
  };
  const hasChildren = new Set(entries.flatMap(parents));
  for (const entry of entries) {
    const ancestors = parents(entry);
    if (ancestors.some((d) => whole.has(d))) continue;
    const isDir = entry.endsWith('/');
    // Merely collapsed directories come with their contents listed too; process those instead.
    if (isDir && !listing.ignoredDirs.has(entry) && hasChildren.has(entry)) continue;
    let scoped = rules;
    for (const parent of isDir ? [...ancestors, entry] : ancestors) {
      const dir = parent.slice(0, -1);
      if (listing.ignoredDirs.has(parent) && !isIncluded(scoped, dir, true)) {
        scoped = scoped.filter((r) => reaches(r, dir.split('/')));
      }
    }
    if (!scoped.some((r) => !r.negate)) continue;
    if (!isDir) {
      if (isIncluded(scoped, entry, false)) await copy(entry);
      continue;
    }
    const dir = entry.slice(0, -1);
    try {
      for await (const rel of walk(sourceRoot, dir)) if (isIncluded(scoped, rel, false)) await copy(rel);
    } catch (e) {
      result.failed.push(`${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
