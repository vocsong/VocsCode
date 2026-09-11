/** Local tools for the native loop: bash, read, write, edit, glob and grep, each gated by the active permission mode. */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { FileChange } from '../../../shared/types';
import { which } from '../../runtime';
import { truncate } from '../../util/async';
import { killTree } from '../spawn';

export interface NativeToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating: boolean;
  isEdit: boolean;
}

export const NATIVE_TOOLS: NativeToolDef[] = [
  {
    name: 'bash',
    description:
      'Run a shell command in the project working directory and return its combined stdout/stderr and exit code. Use for builds, tests, git, package managers, and quick inspection. Long outputs are truncated. Prefer dedicated file tools for reading and editing files.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to execute.' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 120000, max 600000).' },
        description: { type: 'string', description: 'Short description of what the command does.' }
      },
      required: ['command'],
      additionalProperties: false
    },
    mutating: true,
    isEdit: false
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file with line numbers. Use offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the working directory.' },
        offset: { type: 'integer', description: '1-based line number to start from.' },
        limit: { type: 'integer', description: 'Maximum number of lines to return (default 2000).' }
      },
      required: ['path'],
      additionalProperties: false
    },
    mutating: false,
    isEdit: false
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Creates parent directories as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    mutating: true,
    isEdit: true
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Include enough surrounding context to make the match unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', minLength: 1 },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false
    },
    mutating: true,
    isEdit: true
  },
  {
    name: 'list_dir',
    description: 'List entries of a directory (name, type, size). Hidden and ignored folders like node_modules are included but marked.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (default: working directory).' } },
      additionalProperties: false
    },
    mutating: false,
    isEdit: false
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern (supports ** and *), e.g. "src/**/*.ts". Ignores node_modules, .git, dist and build folders.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Root directory to search (default: working directory).' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    mutating: false,
    isEdit: false
  },
  {
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns matching lines as path:line: text. Optionally restrict to a glob of file names.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression (JavaScript / ripgrep syntax).' },
        path: { type: 'string', description: 'Directory or file to search (default: working directory).' },
        glob: { type: 'string', description: 'File name glob filter, e.g. "*.ts".' },
        max_results: { type: 'integer', description: 'Maximum matches to return (default 200).' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    mutating: false,
    isEdit: false
  }
];

export interface ToolExecResult {
  output: string;
  isError: boolean;
  exitCode?: number | null;
  changes?: FileChange[];
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target', '.vocs-code']);
export const MAX_OUTPUT = 30_000;
let tmpCounter = 0;

/** Write to a sibling temp file, then rename over the target so a crash mid-write never truncates the original. */
async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${(tmpCounter = (tmpCounter + 1) % 1_000_000)}`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export function resolveInCwd(cwd: string, p: string | undefined): string {
  if (!p) return cwd;
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (i === glob.length - 1) {
          re += '.*'; // trailing ** matches everything below
        } else {
          if (glob[i + 1] === '/') i++;
          re += '(?:.*/)?';
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '.') re += '\\.';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
      } else re += '\\{';
    } else if ('+^$()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

async function* walk(root: string, rel = ''): AsyncGenerator<{ abs: string; rel: string }> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      yield* walk(root, r);
    } else if (e.isFile()) yield { abs: path.join(root, r), rel: r };
  }
}

export function detectShell(): { file: string; args: (cmd: string) => string[]; name: string } {
  if (process.platform === 'win32') {
    const bash = which('bash');
    if (bash && !/System32/i.test(bash)) return { file: bash, args: (cmd) => ['-lc', cmd], name: 'bash (Git Bash)' };
    const pwsh = which('pwsh') ?? which('powershell');
    if (pwsh) return { file: pwsh, args: (cmd) => ['-NoProfile', '-NonInteractive', '-Command', cmd], name: 'PowerShell' };
    return { file: process.env.ComSpec || 'cmd.exe', args: (cmd) => ['/d', '/s', '/c', cmd], name: 'cmd.exe' };
  }
  return { file: process.env.SHELL || '/bin/sh', args: (cmd) => ['-lc', cmd], name: process.env.SHELL || 'sh' };
}

export async function runBash(cwd: string, command: string, timeoutMs: number, signal: AbortSignal, onOutput?: (chunk: string) => void): Promise<ToolExecResult> {
  const sh = detectShell();
  return new Promise((resolve) => {
    let out = '';
    let killed = false;
    const child = spawn(sh.file, sh.args(command), { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const push = (d: Buffer) => {
      const s = d.toString();
      if (out.length < MAX_OUTPUT) out += s;
      onOutput?.(s);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => {
      killed = true;
      killTree(child);
    }, Math.min(Math.max(timeoutMs, 1000), 600_000));
    const onAbort = () => {
      killed = true;
      killTree(child);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ output: `Failed to start shell: ${e.message}`, isError: true, exitCode: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const text = truncate(out, MAX_OUTPUT) + (killed ? (signal.aborted ? '\n[interrupted by user]' : '\n[timed out]') : '');
      resolve({ output: text || '(no output)', isError: killed || (code !== 0 && code !== null), exitCode: code });
    });
  });
}

export async function readFileTool(cwd: string, args: { path: string; offset?: number; limit?: number }): Promise<ToolExecResult> {
  const abs = resolveInCwd(cwd, args.path);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) return { output: `${args.path} is a directory. Use list_dir.`, isError: true };
  if (stat.size > 5_000_000) return { output: `File is ${stat.size} bytes; too large to read at once.`, isError: true };
  const content = await fs.readFile(abs, 'utf8');
  const lines = content.split('\n');
  const start = Math.max(1, args.offset ?? 1);
  const limit = Math.max(1, Math.min(args.limit ?? 2000, 5000));
  const slice = lines.slice(start - 1, start - 1 + limit);
  const width = String(start + slice.length).length;
  const body = slice.map((l, i) => `${String(start + i).padStart(width)}\t${l}`).join('\n');
  const more = start - 1 + limit < lines.length ? `\n… ${lines.length - (start - 1 + limit)} more lines (total ${lines.length})` : '';
  return { output: truncate(body, 200_000) + more, isError: false };
}

export async function writeFileTool(cwd: string, args: { path: string; content: string }): Promise<ToolExecResult> {
  const abs = resolveInCwd(cwd, args.path);
  let before: string | null = null;
  try {
    before = await fs.readFile(abs, 'utf8');
  } catch {
    before = null;
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await atomicWrite(abs, args.content);
  const rel = path.relative(cwd, abs) || args.path;
  const diff = createTwoFilesPatch(rel, rel, before ?? '', args.content, '', '', { context: 3 });
  return { output: `Wrote ${args.content.length} characters to ${rel}.`, isError: false, changes: [{ path: rel, kind: before === null ? 'add' : 'update', diff }] };
}

export async function previewWrite(cwd: string, args: { path: string; content: string }): Promise<FileChange[]> {
  const abs = resolveInCwd(cwd, args.path);
  let before: string | null = null;
  try {
    before = await fs.readFile(abs, 'utf8');
  } catch {
    before = null;
  }
  const rel = path.relative(cwd, abs) || args.path;
  return [{ path: rel, kind: before === null ? 'add' : 'update', diff: createTwoFilesPatch(rel, rel, before ?? '', args.content, '', '', { context: 3 }) }];
}

export async function previewEdit(cwd: string, args: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<{ changes?: FileChange[]; error?: string; after?: string }> {
  if (!args.old_string) return { error: 'old_string must not be empty.' };
  const abs = resolveInCwd(cwd, args.path);
  let before: string;
  try {
    before = await fs.readFile(abs, 'utf8');
  } catch {
    return { error: `File not found: ${args.path}` };
  }
  const count = before.split(args.old_string).length - 1;
  if (count === 0) return { error: 'old_string was not found in the file. Re-read the file and try again with exact text.' };
  if (count > 1 && !args.replace_all) return { error: `old_string matches ${count} times; include more context or set replace_all.` };
  const after = args.replace_all ? before.split(args.old_string).join(args.new_string) : before.replace(args.old_string, args.new_string);
  const rel = path.relative(cwd, abs) || args.path;
  return { after, changes: [{ path: rel, kind: 'update', diff: createTwoFilesPatch(rel, rel, before, after, '', '', { context: 3 }) }] };
}

export async function editFileTool(cwd: string, args: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<ToolExecResult> {
  const preview = await previewEdit(cwd, args);
  if (preview.error) return { output: preview.error, isError: true };
  const abs = resolveInCwd(cwd, args.path);
  await atomicWrite(abs, preview.after ?? '');
  return { output: `Edited ${path.relative(cwd, abs) || args.path}.`, isError: false, changes: preview.changes };
}

export async function listDirTool(cwd: string, args: { path?: string }): Promise<ToolExecResult> {
  const abs = resolveInCwd(cwd, args.path);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const rows: string[] = [];
  for (const e of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    if (e.isDirectory()) rows.push(`${e.name}/${IGNORED_DIRS.has(e.name) ? '  (ignored)' : ''}`);
    else {
      let size = '';
      try {
        size = String((await fs.stat(path.join(abs, e.name))).size);
      } catch {
        /* ignore */
      }
      rows.push(`${e.name}  ${size}`);
    }
  }
  return { output: rows.join('\n') || '(empty)', isError: false };
}

export async function globTool(cwd: string, args: { pattern: string; path?: string }): Promise<ToolExecResult> {
  const root = resolveInCwd(cwd, args.path);
  const re = globToRegExp(args.pattern.replace(/\\/g, '/'));
  const out: string[] = [];
  for await (const f of walk(root)) {
    if (re.test(f.rel) || re.test(path.basename(f.rel))) out.push(f.rel);
    if (out.length >= 2000) break;
  }
  return { output: out.length ? out.join('\n') : 'No files matched.', isError: false };
}

export async function grepTool(cwd: string, args: { pattern: string; path?: string; glob?: string; max_results?: number }, signal: AbortSignal): Promise<ToolExecResult> {
  const root = resolveInCwd(cwd, args.path);
  const max = Math.min(args.max_results ?? 200, 2000);
  const rg = which('rg');
  if (rg) {
    const rgArgs = ['-n', '--no-heading', '--color', 'never', '-m', '50', '--max-count', '50', '-S'];
    if (args.glob) rgArgs.push('-g', args.glob);
    for (const d of IGNORED_DIRS) rgArgs.push('-g', `!${d}`);
    rgArgs.push('-e', args.pattern, root);
    const res = await new Promise<ToolExecResult>((resolve) => {
      let out = '';
      const child = spawn(rg, rgArgs, { cwd, windowsHide: true });
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (out += d.toString()));
      signal.addEventListener('abort', () => child.kill(), { once: true });
      child.on('close', (code) => {
        const lines = out.split('\n').filter(Boolean).slice(0, max);
        resolve({ output: lines.length ? lines.map((l) => l.replace(root + path.sep, '')).join('\n') : code === 1 ? 'No matches.' : out || 'No matches.', isError: code !== 0 && code !== 1 });
      });
      child.on('error', () => resolve({ output: 'ripgrep failed', isError: true }));
    });
    return res;
  }
  // Model-supplied regex runs on the main process; refuse absurd patterns that could stall it.
  if (args.pattern.length > 500) return { output: 'Pattern is too long (max 500 characters).', isError: true };
  let re: RegExp;
  try {
    re = new RegExp(args.pattern, 'i');
  } catch (e) {
    return { output: `Invalid regex: ${(e as Error).message}`, isError: true };
  }
  const fileRe = args.glob ? globToRegExp(args.glob) : null;
  const out: string[] = [];
  const stat = await fs.stat(root).catch(() => null);
  const files = stat?.isFile() ? [{ abs: root, rel: path.basename(root) }] : walk(root);
  for await (const f of files as AsyncIterable<{ abs: string; rel: string }> | { abs: string; rel: string }[]) {
    if (signal.aborted) break;
    if (fileRe && !fileRe.test(path.basename(f.rel))) continue;
    let content: string;
    try {
      const st = await fs.stat(f.abs);
      if (st.size > 2_000_000) continue;
      content = await fs.readFile(f.abs, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push(`${f.rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
        if (out.length >= max) break;
      }
    }
    if (out.length >= max) break;
  }
  return { output: out.length ? out.join('\n') : 'No matches.', isError: false };
}
