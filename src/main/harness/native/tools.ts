/** Local tools for the native loop: bash, read, write, edit, glob and grep, each gated by the active permission mode. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Worker } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileChange } from '../../../shared/types';
import { which } from '../../runtime';
import { makeFileChange } from '../../util/file-changes';
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
    description: 'Read a UTF-8 text file with line numbers. Use offset/limit or the returned byte_offset for continuation. Read all pages of the current version before overwriting or editing an existing file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the working directory.' },
        offset: { type: 'integer', description: '1-based line number to start from; cannot combine with byte_offset.' },
        byte_offset: { type: 'integer', description: '0-based UTF-8 byte position returned by a truncated read.' },
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
    description: 'Create or overwrite a file with the given content. Existing files require reading all current content with read_file in this session (continuation pages count). Creates parent directories as needed.',
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
    description: 'Search file contents with smart-case (case-insensitive unless the pattern contains uppercase literals). Returns path:line: text. Uses ripgrep when installed, otherwise JavaScript regex; advanced regex syntax differs between engines. Ignored directories and binary files are excluded; fallback also skips files over 2 MB.',
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
  /** Internal only: complete read or successful mutation; never inferred from previews. */
  fileVersion?: { path: string; fingerprint: string; total: number };
  /** Successfully delivered UTF-8 byte range; pages only combine within this exact content version. */
  readCoverage?: { path: string; fingerprint: string; start: number; end: number; total: number };
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target', '.vocs-code']);
export const MAX_OUTPUT = 30_000;
/** Write to a sibling temp file, then rename over the target so a crash mid-write never truncates the original. */
async function atomicWrite(file: string, content: string, beforeCommit?: () => Promise<void>): Promise<void> {
  const tmp = `${file}.tmp-${randomUUID()}`;
  const handle = await fs.open(tmp, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.close();
    await beforeCommit?.();
    await fs.rename(tmp, file);
  } catch (e) {
    await handle.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

function fingerprint(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function fileVersionKey(cwd: string, p: string): string {
  const abs = path.resolve(cwd, p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** Missing descendants are resolved through their nearest existing ancestor. Uncertainty prompts. */
export async function requiresPathApproval(cwd: string, target: string): Promise<boolean> {
  const outside = (root: string, file: string) => {
    const rel = path.relative(root, file);
    return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  };
  const absolute = path.resolve(cwd, target);
  if (outside(path.resolve(cwd), absolute)) return true;
  try {
    const root = await fs.realpath(cwd);
    const missing: string[] = [];
    let ancestor = absolute;
    for (;;) {
      try {
        await fs.lstat(ancestor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return true;
        missing.unshift(path.basename(ancestor));
        ancestor = parent;
        continue;
      }
      // A dangling link or inaccessible realpath throws rather than authorizing its descendants.
      return outside(root, path.join(await fs.realpath(ancestor), ...missing));
    }
  } catch { return true; }
}

function fileError(cwd: string, file: string, error: unknown): ToolExecResult {
  return { output: `File error for ${file} (cwd: ${cwd}): ${(error as Error).message}`, isError: true };
}

async function textFile(file: string): Promise<Buffer> {
  const st = await fs.stat(file);
  if (!st.isFile()) throw new Error('Not a regular text file; use list_dir for directories.');
  if (st.size > 5_000_000) throw new Error(`File is ${st.size} bytes; exceeds the 5000000-byte text limit.`);
  const bytes = await fs.readFile(file);
  if (bytes.includes(0)) throw new Error('Binary file is not supported by text tools.');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('File is not valid UTF-8 text.'); }
  return bytes;
}

/** Best effort recheck immediately before rename, not atomic CAS against external writers. */
async function checkVersion(file: string, expected: string | undefined, allowNew: boolean): Promise<Buffer | null> {
  let bytes: Buffer;
  try { bytes = await textFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowNew) {
      const entry = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
      if (entry) throw new Error('Path exists but cannot be read (possibly a dangling symlink). Refusing to overwrite.');
      if (expected !== undefined) throw new Error('File disappeared since it was read. Re-read before changing it.');
      return null;
    }
    throw error;
  }
  if (expected === undefined) throw new Error('Read the complete file with read_file before overwriting or editing it.');
  if (fingerprint(bytes) !== expected) throw new Error('File changed since it was read. Re-read the complete file before changing it.');
  return bytes;
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

async function* walk(root: string, rel = '', signal?: AbortSignal, skipped?: { count: number }): AsyncGenerator<{ abs: string; rel: string }> {
  if (signal?.aborted) throw new Error('Search interrupted.');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    if (skipped) skipped.count++;
    return;
  }
  for (const e of entries) {
    if (signal?.aborted) throw new Error('Search interrupted.');
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) { if (skipped) skipped.count++; continue; }
      yield* walk(root, r, signal, skipped);
    } else if (e.isFile()) yield { abs: path.join(root, r), rel: r };
    else if (skipped) skipped.count++;
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

/** Retain a bounded beginning and ending, even when one data chunk exceeds the budget. */
class HeadTail {
  private head = '';
  private tail = '';
  private total = 0;
  push(text: string): void {
    this.total += text.length;
    const room = MAX_OUTPUT / 2 - this.head.length;
    this.head += text.slice(0, room);
    this.tail = (this.tail + text.slice(room)).slice(-MAX_OUTPUT / 2);
  }
  text(): string {
    if (this.total <= this.head.length + this.tail.length) return this.head + this.tail;
    // A character-budget cut must not leave half an astral Unicode character.
    const head = this.head.replace(/[\uD800-\uDBFF]$/, '');
    const tail = this.tail.replace(/^[\uDC00-\uDFFF]/, '');
    const omitted = this.total - head.length - tail.length;
    return head + `\n[${omitted} UTF-16 code units omitted; showing head and tail]\n` + tail;
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (process.platform === 'win32') await killTree(child);
  else if (child.pid) {
    // These subprocesses own a process group so grandchildren cannot retain output pipes.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* exited */ } }
  }
}

export async function runBash(cwd: string, command: string, timeoutMs: number, signal: AbortSignal, onOutput?: (chunk: string) => void): Promise<ToolExecResult> {
  if (signal.aborted) return { output: '[interrupted before execution; exit code: not started]', isError: true, exitCode: null };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { output: 'timeout_ms must be a positive number in milliseconds.', isError: true };
  const duration = Math.min(Math.max(timeoutMs, 1000), 600_000);
  const sh = detectShell();
  return new Promise((resolve) => {
    const capture = new HeadTail();
    let reason = '';
    let done = false;
    let termination: Promise<void> | undefined;
    const child = spawn(sh.file, sh.args(command), { cwd, env: process.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = (why: string) => {
      if (done || termination) return;
      reason = why;
      termination = terminate(child);
    };
    const onAbort = () => stop('interrupted by user');
    const timer = setTimeout(() => stop(`timed out after ${duration} ms (timeout_ms=${duration})`), duration);
    const finish = async (code: number | null, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      await termination;
      resolve({ output: `${capture.text() || '(no output)'}\n[exit code: ${code ?? 'unavailable'}${reason ? `; ${reason}` : ''}${error ? `; Failed to start shell: ${error.message}` : ''}]`, isError: !!error || !!reason || code !== 0, exitCode: code });
    };
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      const push = (s: string) => { capture.push(s); onOutput?.(s); };
      stream.on('data', (d: Buffer) => push(decoder.write(d)));
      stream.on('end', () => push(decoder.end()));
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.on('error', (e) => { void finish(null, e); });
    child.on('close', (code) => { void finish(code); });
  });
}

export async function readFileTool(cwd: string, args: { path: string; offset?: number; limit?: number; byte_offset?: number }): Promise<ToolExecResult> {
  const abs = resolveInCwd(cwd, args.path);
  try {
    for (const key of ['offset', 'limit'] as const) {
      if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key]! < 1)) throw new Error(`${key} must be a positive integer.`);
    }
    if (args.byte_offset !== undefined && (!Number.isInteger(args.byte_offset) || args.byte_offset < 0 || args.offset !== undefined)) throw new Error('byte_offset must be a nonnegative integer and cannot be combined with offset.');
    const bytes = await textFile(abs);
    const content = bytes.toString('utf8');
    const lines = content.split('\n');
    let start = args.offset ?? 1;
    if (start > lines.length) throw new Error(`offset ${start} is beyond EOF (${lines.length} lines).`);
    const byteStart = args.byte_offset ?? Buffer.byteLength(lines.slice(0, start - 1).join('\n') + (start > 1 ? '\n' : ''));
    if (byteStart > bytes.length || (byteStart === bytes.length && bytes.length > 0)) throw new Error(`byte_offset ${byteStart} is beyond EOF (${bytes.length} bytes).`);
    if (byteStart < bytes.length && (bytes[byteStart] & 0xc0) === 0x80) throw new Error('byte_offset must be on a UTF-8 character boundary.');
    if (args.byte_offset !== undefined) start = bytes.subarray(0, byteStart).toString('utf8').split('\n').length;
    const remaining = bytes.subarray(byteStart).toString('utf8').split('\n');
    const selected = remaining.slice(0, Math.min(args.limit ?? 2000, 5000));
    let end = byteStart + Buffer.byteLength(selected.join('\n'));
    const lineLimited = selected.length < remaining.length;
    if (lineLimited) end++; // include the newline before the next page
    const byteLimited = end - byteStart > 180_000;
    if (byteLimited) {
      end = byteStart + 180_000;
      while (end > byteStart && (bytes[end] & 0xc0) === 0x80) end--;
    }
    const body = bytes.subarray(byteStart, end).toString('utf8').split('\n').map((l, i) => `${start + i}\t${l}`).join('\n');
    const partial = byteStart !== 0 || end < bytes.length;
    const notice = end < bytes.length ? `\n[Read truncated; ${bytes.length - end} bytes remain. Continue with byte_offset=${end}${!byteLimited ? ` or offset=${start + selected.length}` : ' (may continue within a line)'}. Continue reading every page of this version before editing.]` : partial ? '\n[End of file; edits are allowed once all pages of this version have been read.]' : '';
    const version = { path: fileVersionKey(cwd, args.path), fingerprint: fingerprint(bytes), total: bytes.length };
    return { output: body + notice, isError: false, fileVersion: partial ? undefined : version, readCoverage: { ...version, start: byteStart, end } };
  } catch (error) { return fileError(cwd, abs, error); }
}

export async function writeFileTool(cwd: string, args: { path: string; content: string }, expected?: string): Promise<ToolExecResult> {
  const abs = resolveInCwd(cwd, args.path);
  try {
    const before = await checkVersion(abs, expected, true);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await atomicWrite(abs, args.content, async () => { await checkVersion(abs, expected, true); });
    const change = makeFileChange(cwd, abs, before?.toString('utf8') ?? null, args.content);
    return { output: `Wrote ${args.content.length} characters to ${change.path}.`, isError: false, changes: [change], fileVersion: { path: fileVersionKey(cwd, args.path), fingerprint: fingerprint(args.content), total: Buffer.byteLength(args.content) } };
  } catch (error) { return fileError(cwd, abs, error); }
}

export async function previewWrite(cwd: string, args: { path: string; content: string }): Promise<FileChange[]> {
  const abs = resolveInCwd(cwd, args.path);
  let before: string | null = null;
  try {
    before = (await textFile(abs)).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return [makeFileChange(cwd, abs, before, args.content)];
}

export async function previewEdit(cwd: string, args: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<{ changes?: FileChange[]; error?: string; after?: string }> {
  if (!args.old_string) return { error: 'old_string must not be empty.' };
  const abs = resolveInCwd(cwd, args.path);
  let before: string;
  try {
    before = (await textFile(abs)).toString('utf8');
  } catch (error) {
    return { error: fileError(cwd, abs, error).output };
  }
  const count = before.split(args.old_string).length - 1;
  if (count === 0) return { error: 'old_string was not found in the file. Re-read the file and try again with exact text.' };
  if (count > 1 && !args.replace_all) return { error: `old_string matches ${count} times; include more context or set replace_all.` };
  const after = args.replace_all ? before.split(args.old_string).join(args.new_string) : before.replace(args.old_string, () => args.new_string);
  return { after, changes: [makeFileChange(cwd, abs, before, after)] };
}

export async function editFileTool(cwd: string, args: { path: string; old_string: string; new_string: string; replace_all?: boolean }, expected?: string): Promise<ToolExecResult> {
  const abs = resolveInCwd(cwd, args.path);
  try {
    const before = (await checkVersion(abs, expected, false))!.toString('utf8');
    if (!args.old_string) throw new Error('old_string must not be empty.');
    const count = before.split(args.old_string).length - 1;
    if (!count) throw new Error('old_string was not found. Re-read the file and use exact text.');
    if (count > 1 && !args.replace_all) throw new Error(`old_string matches ${count} times; include more context or set replace_all.`);
    const after = args.replace_all ? before.split(args.old_string).join(args.new_string) : before.replace(args.old_string, () => args.new_string);
    await atomicWrite(abs, after, async () => { await checkVersion(abs, expected, false); });
    return { output: `Edited ${path.relative(cwd, abs) || args.path}.`, isError: false, changes: [makeFileChange(cwd, abs, before, after)], fileVersion: { path: fileVersionKey(cwd, args.path), fingerprint: fingerprint(after), total: Buffer.byteLength(after) } };
  } catch (error) { return fileError(cwd, abs, error); }
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

export async function globTool(cwd: string, args: { pattern: string; path?: string }, signal?: AbortSignal): Promise<ToolExecResult> {
  const root = resolveInCwd(cwd, args.path);
  try {
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Glob root must be a directory.');
    const re = globToRegExp(args.pattern.replace(/\\/g, '/'));
    const out: string[] = [];
    const skipped = { count: 0 };
    for await (const f of walk(root, '', signal, skipped)) {
      if (re.test(f.rel) || re.test(path.basename(f.rel))) out.push(f.rel);
      if (out.length > 2000) break;
    }
    return searchResult(out, 2000, skipped.count, 'No files matched.');
  } catch (error) { return fileError(cwd, root, error); }
}

function searchResult(lines: string[], max: number, skipped = 0, empty = 'No matches.'): ToolExecResult {
  const selected = lines.slice(0, max);
  let output = selected.join('\n') || empty;
  if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + '\n[Output truncated by character limit; narrow the search.]';
  if (lines.length > max) output += `\n[Results truncated: more than ${max} matches; narrow the search.]`;
  if (skipped) output += `\n[Skipped ${skipped} oversized, binary, ignored, symlink or unreadable inputs; results are incomplete.]`;
  return { output, isError: false };
}

/** Uppercase escapes such as \\S are operators, not uppercase literals. */
function caseSensitive(pattern: string): boolean {
  return /[A-Z]/.test(pattern.replace(/\\(?:[pP]\{[^}]*\}|[xu][0-9a-fA-F]{2,4}|.)/g, (escape) => {
    if (/^\\[xu][0-9a-fA-F]+$/.test(escape)) return String.fromCharCode(parseInt(escape.slice(2), 16));
    return '';
  }));
}

export async function grepTool(cwd: string, args: { pattern: string; path?: string; glob?: string; max_results?: number }, signal: AbortSignal): Promise<ToolExecResult> {
  const root = resolveInCwd(cwd, args.path);
  const requested = args.max_results ?? 200;
  if (!Number.isInteger(requested) || requested < 1) return { output: 'max_results must be a positive integer.', isError: true };
  if (signal.aborted) return { output: 'Search interrupted before execution.', isError: true };
  if (args.pattern.length > 500) return { output: 'Pattern is too long (max 500 characters).', isError: true };
  const max = Math.min(requested, 2000);
  const rg = which('rg');
  if (rg) {
    const rgArgs = ['-n', '--with-filename', '--no-heading', '--color', 'never', '--no-config', caseSensitive(args.pattern) ? '--case-sensitive' : '--ignore-case'];
    if (args.glob) rgArgs.push('-g', args.glob);
    for (const d of IGNORED_DIRS) rgArgs.push('-g', `!${d}`);
    rgArgs.push('-e', args.pattern, root);
    return new Promise<ToolExecResult>((resolve) => {
      const lines: string[] = [];
      let pending = '';
      let stderr = '';
      let reason = '';
      let done = false;
      let lineClipped = false;
      let termination: Promise<void> | undefined;
      const decoder = new StringDecoder('utf8');
      const child = spawn(rg, rgArgs, { cwd, windowsHide: true, detached: process.platform !== 'win32' });
      const stop = (why: string) => {
        if (termination || done) return;
        reason = why;
        termination = terminate(child);
      };
      const onAbort = () => stop('Search interrupted.');
      const timer = setTimeout(() => stop('Search timed out after 30000 ms.'), 30_000);
      const addLine = () => {
        if (pending && lines.length <= max) lines.push(pending.replace(root + path.sep, '').replace(/\r$/, ''));
        pending = '';
        if (lines.length > max) stop('limit');
      };
      const consume = (text: string) => {
        if (termination) return;
        const parts = text.split('\n');
        for (let i = 0; i < parts.length; i++) {
          const room = 1000 - pending.length;
          if (parts[i].length > room) lineClipped = true;
          pending += parts[i].slice(0, room);
          if (i < parts.length - 1) addLine();
          if (termination) break;
        }
      };
      const finish = async (code: number | null, error?: Error) => {
        if (done) return;
        consume(decoder.end());
        if (pending && lines.length <= max) addLine();
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        await termination;
        const res = searchResult(lines, max);
        if (lineClipped) res.output += '\n[Matching line text truncated; use read_file for full context.]';
        if (error || (reason && reason !== 'limit') || (!reason && code !== 0 && code !== 1)) {
          res.isError = true;
          res.output += `\n[${error?.message || reason || `ripgrep exited ${code}`}${stderr ? `: ${stderr}` : ''}]`;
        }
        resolve(res);
      };
      child.stdout.on('data', (d: Buffer) => consume(decoder.write(d)));
      child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(0, MAX_OUTPUT); });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      child.on('error', (e) => { void finish(null, e); });
      child.on('close', (code) => { void finish(code); });
    });
  }
  // Keep potentially catastrophic JS regex evaluation off the main process and cancellable.
  let worker: Worker | undefined;
  let workerError: Error | undefined;
  const controller = new AbortController();
  const onWorkerError = (error: Error) => { workerError = error; controller.abort(); };
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const flags = caseSensitive(args.pattern) ? '' : 'i';
    new RegExp(args.pattern, flags); // report syntax errors before walking
    worker = new Worker(`
      import('node:worker_threads').then(({ parentPort, workerData }) => {
      const re = new RegExp(workerData.pattern, workerData.flags);
      parentPort.on('message', ({ content, max }) => {
        const out = [];
        const lines = content.split('\\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) out.push({ line: i + 1, text: lines[i].slice(0, 300), clipped: lines[i].length > 300 });
          if (out.length >= max) break;
        }
        parentPort.postMessage(out);
      });
      });
    `, { eval: true, workerData: { pattern: args.pattern, flags } });
    const activeWorker = worker;
    activeWorker.on('error', onWorkerError);
    const match = (content: string, count: number) => new Promise<{ line: number; text: string; clipped: boolean }[]>((resolve, reject) => {
      const cleanup = () => { clearTimeout(deadline); controller.signal.removeEventListener('abort', abort); activeWorker.removeListener('message', success); activeWorker.removeListener('error', failure); };
      const success = (rows: { line: number; text: string; clipped: boolean }[]) => { cleanup(); resolve(rows); };
      const failure = (e: Error) => { cleanup(); reject(e); };
      const abort = () => failure(workerError ?? new Error('Search interrupted or timed out.'));
      const deadline = setTimeout(() => failure(new Error('JavaScript regex timed out after 2000 ms; simplify the pattern.')), 2000);
      activeWorker.once('message', success);
      activeWorker.once('error', failure);
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
      else activeWorker.postMessage({ content, max: count });
    });
    const fileRe = args.glob ? globToRegExp(args.glob) : null;
    const out: string[] = [];
    const skipped = { count: 0 };
    let clipped = false;
    const stat = await fs.stat(root);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('Search root must be a regular file or directory.');
    const files = stat.isFile() ? [{ abs: root, rel: path.basename(root) }] : walk(root, '', controller.signal, skipped);
    for await (const f of files) {
      if (controller.signal.aborted) throw new Error('Search interrupted or timed out.');
      if (fileRe && !fileRe.test(f.rel) && !fileRe.test(path.basename(f.rel))) continue;
      let content: string;
      try {
        if ((await fs.stat(f.abs)).size > 2_000_000) { skipped.count++; continue; }
        content = (await textFile(f.abs)).toString('utf8');
      } catch { skipped.count++; continue; }
      const rows = await match(content, max + 1 - out.length);
      for (const row of rows) {
        out.push(`${f.rel}:${row.line}: ${row.text}`);
        clipped ||= row.clipped;
      }
      if (out.length > max) break;
    }
    if (controller.signal.aborted) throw workerError ?? new Error('Search interrupted or timed out.');
    const result = searchResult(out, max, skipped.count);
    if (clipped) result.output += '\n[Matching line text truncated; use read_file for full context.]';
    return result;
  } catch (error) { return fileError(cwd, root, workerError ?? error); }
  finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    await worker?.terminate();
    worker?.removeListener('error', onWorkerError);
  }
}
