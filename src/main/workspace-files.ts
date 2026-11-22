/** Node-only workspace file listing and bounded text I/O. */
import { isUtf8 } from 'node:buffer';
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { imageMimeType, type WorkspaceImage } from '../shared/image-files';
import type { FsEntry } from '../shared/types';
import { FILE_PREVIEW_MAX_BYTES, type IpcResponse, type WorkspaceFileResolution } from '../shared/ipc';

const DEFAULT_MAX_BYTES = 400_000;
const MAX_BYTES = 2_000_000;
/** Images travel whole as base64; past this the panel says so instead of shipping the bytes. */
export const MAX_IMAGE_BYTES = 20_000_000;
/** Git's heuristic: a NUL byte this early means the file is binary, not text worth showing. */
const BINARY_SNIFF_BYTES = 8000;

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** A transcript can name a file the workspace does not have (a bare name from another repo, or one
 *  a worktree never got). Say which path was looked for and where, not Node's `ENOENT: realpath`. */
async function realpathOrNotFound(p: string, missing: () => string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(missing());
    throw error;
  }
}

async function resolveInWorkspace(root: string, target = ''): Promise<{ lexicalRoot: string; lexicalTarget: string; realRoot: string; realTarget: string } | undefined> {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(lexicalRoot, target);
  if (!isWithin(lexicalRoot, lexicalTarget)) return undefined;

  // The root first: when the whole folder is gone, that is what to report, not each file in it.
  const realRoot = await realpathOrNotFound(lexicalRoot, () => `${lexicalRoot} no longer exists`);
  const realTarget = await realpathOrNotFound(lexicalTarget, () => `${path.relative(lexicalRoot, lexicalTarget).split(path.sep).join('/')} was not found in ${lexicalRoot}`);
  if (!isWithin(realRoot, realTarget)) return undefined;
  return { lexicalRoot, lexicalTarget, realRoot, realTarget };
}

/** Shared with the IPC boundary so malformed input cannot trigger even Mission scope reads. */
export function validateWorkspaceFileTarget(target: unknown): string {
  if (typeof target !== 'string' || !target.trim() || target.length > 4096 || /[\x00-\x1f\x7f-\x9f:<>"|?*]/.test(target) || path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) {
    throw new Error('Invalid workspace file path');
  }
  const relative = target.replace(/\\/g, '/').replace(/^\.\//, '');
  if (relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid workspace file path');
  return relative;
}

const RESOLVE_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', 'venv', 'target', '.vocs-code']);
const RESOLVE_MAX_ENTRIES = 50_000;
const RESOLVE_MAX_MATCHES = 100;

/** Resolve shortened chat references without guessing across directories, roots, or partial scans. */
export async function resolveWorkspaceFile(root: string, target: string): Promise<WorkspaceFileResolution> {
  const relative = validateWorkspaceFileTarget(target);
  const lexicalRoot = path.resolve(root);
  const realRoot = await realpathOrNotFound(lexicalRoot, () => `${lexicalRoot} no longer exists`);
  if (!(await fs.stat(realRoot)).isDirectory()) throw Object.assign(new Error('Workspace root is not a directory'), { code: 'ENOTDIR' });

  // Check each existing component before considering fallback. In particular, an absent file
  // below an escaping directory link is a refusal, not permission to search somewhere else.
  let exact = realRoot;
  let absent = false;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    exact = path.join(exact, parts[i]!);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(exact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      absent = true;
      break;
    }
    const symlink = stat.isSymbolicLink();
    try {
      exact = await fs.realpath(exact);
    } catch (error) {
      // A dangling/disappearing component is not eligible for suffix guessing.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      throw error;
    }
    if (!isWithin(realRoot, exact)) throw new Error('Path outside workspace');
    if (symlink) stat = await fs.stat(exact);
    if (i === parts.length - 1) return stat.isFile() ? { status: 'resolved', path: relative } : { status: 'missing' };
  }
  if (!absent) return { status: 'missing' };

  const candidates: string[] = [];
  const suffix = process.platform === 'win32' ? relative.toLowerCase() : relative;
  const pending = [''];
  let visited = 0;
  // Iterative traversal avoids a depth cutoff (which could silently miss another match).
  while (pending.length) {
    const dir = pending.pop()!;
    const absolute = path.join(realRoot, dir);
    try {
      if (dir) {
        if (!(await fs.lstat(absolute)).isDirectory() || !isWithin(realRoot, await fs.realpath(absolute))) return { status: 'incomplete' };
      }
      const entries = await fs.opendir(absolute);
      for await (const entry of entries) {
        if (++visited > RESOLVE_MAX_ENTRIES) return { status: 'incomplete' };
        const name = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!RESOLVE_SKIP_DIRS.has(entry.name)) pending.push(name);
        } else if (entry.isFile()) {
          const comparable = process.platform === 'win32' ? name.toLowerCase() : name;
          if (comparable === suffix || comparable.endsWith(`/${suffix}`)) {
            candidates.push(name);
            if (candidates.length >= RESOLVE_MAX_MATCHES) return { status: 'incomplete' };
          }
        }
      }
    } catch {
      // Unreadable/disappearing subtrees mean uniqueness (or absence) cannot be proven.
      return { status: 'incomplete' };
    }
  }
  for (const candidate of candidates) {
    try {
      const absolute = path.join(realRoot, candidate);
      if (!(await fs.lstat(absolute)).isFile() || !isWithin(realRoot, await fs.realpath(absolute))) return { status: 'incomplete' };
    } catch {
      return { status: 'incomplete' };
    }
  }
  candidates.sort();
  if (candidates.length === 1) return { status: 'resolved', path: candidates[0]! };
  return candidates.length ? { status: 'ambiguous', paths: candidates } : { status: 'missing' };
}

export async function listWorkspaceFiles(root: string, relPath?: string): Promise<FsEntry[]> {
  const resolved = await resolveInWorkspace(root, relPath);
  if (!resolved) return [];

  const entries = await fs.readdir(resolved.realTarget, { withFileTypes: true });
  const out: FsEntry[] = [];
  for (const entry of entries) {
    const realPath = path.join(resolved.realTarget, entry.name);
    let size: number | undefined;
    if (entry.isFile()) {
      try {
        size = (await fs.stat(realPath)).size;
      } catch {
        // The entry may disappear between readdir and stat.
      }
    }
    out.push({
      name: entry.name,
      path: path.relative(resolved.lexicalRoot, path.join(resolved.lexicalTarget, entry.name)),
      isDir: entry.isDirectory(),
      size,
    });
  }
  return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

async function readPrefix(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit);
  let total = 0;
  while (total < limit) {
    const { bytesRead } = await handle.read(buffer, total, limit - total, total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

function isText(bytes: Buffer): boolean {
  return !bytes.includes(0) && isUtf8(bytes);
}

/** `binary` is set, with empty content, when a complete file is not UTF-8 text. */
export async function readWorkspaceFile(
  root: string, target: string, maxBytes?: number,
  canWriteTarget?: (target: string) => Promise<boolean>
): Promise<IpcResponse<'fs:read'>> {
  const placeholder = { content: '', truncated: false, readOnly: true };
  const resolved = await resolveInWorkspace(root, target);
  if (!resolved || !(await fs.lstat(resolved.realTarget)).isFile()) return placeholder;

  const requestedMax = maxBytes ?? DEFAULT_MAX_BYTES;
  const limit = Math.min(Math.max(0, Math.trunc(requestedMax)), MAX_BYTES);
  const handle = await fs.open(resolved.realTarget, constants.O_RDONLY | SAFE_OPEN_FLAGS);
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) return placeholder;
    const bytes = await readPrefix(handle, Math.min(initial.size, limit));
    const final = await handle.stat();
    const truncated = final.size > bytes.length;
    // A preview cut in the middle of a UTF-8 character remains truncated text, not binary.
    if (truncated ? bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0) : !isText(bytes)) {
      return { content: '', truncated: false, binary: true };
    }
    const readOnly = !truncated && (final.nlink !== 1 || final.size > FILE_PREVIEW_MAX_BYTES ||
      (canWriteTarget !== undefined && !(await canWriteTarget(resolved.realTarget))));
    return { content: bytes.toString('utf8'), truncated, ...(readOnly ? { readOnly: true } : {}) };
  } finally {
    await handle.close();
  }
}

function assertWritableTextFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n) throw new Error('Only existing regular files without hard links can be saved.');
  if (stat.size > FILE_PREVIEW_MAX_BYTES) throw new Error('File is too large to edit in the preview.');
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function encodePreviewText(text: string): Buffer {
  if (Buffer.byteLength(text, 'utf8') > FILE_PREVIEW_MAX_BYTES) throw new Error('Text exceeds the preview size limit.');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.includes(0) || bytes.toString('utf8') !== text) throw new Error('Save requires valid UTF-8 text without NUL bytes.');
  return bytes;
}

// On POSIX, refuse a replaced leaf and keep a raced FIFO from blocking open.
const SAFE_OPEN_FLAGS = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
const savingFiles = new Set<string>();

/** Compare and update a pinned file descriptor: never create a file or reopen the path to write. */
export async function writeWorkspaceText(
  root: string, target: string, content: string, expectedContent: string,
  options: { canonicalRoot?: string; authorizeTarget?: (target: string) => Promise<void> } = {}
): Promise<void> {
  const relative = validateWorkspaceFileTarget(target);
  const next = encodePreviewText(content);
  const expected = encodePreviewText(expectedContent);
  const resolved = await resolveInWorkspace(root, relative);
  if (!resolved || (options.canonicalRoot && resolved.realRoot !== options.canonicalRoot)) throw new Error('Path outside workspace or workspace location changed.');
  await options.authorizeTarget?.(resolved.realTarget);
  const original = await fs.lstat(resolved.realTarget, { bigint: true });
  assertWritableTextFile(original);
  const key = `${original.dev}:${original.ino}`;
  if (savingFiles.has(key)) throw new Error('Another save is in progress for this file.');
  savingFiles.add(key);
  const conflict = () => new Error('File changed on disk. Reload the preview before saving.');
  try {
    // No O_CREAT or O_TRUNC. Recheck identity on all platforms.
    const handle = await fs.open(resolved.realTarget, constants.O_RDWR | SAFE_OPEN_FLAGS);
    try {
      const initial = await handle.stat({ bigint: true });
      assertWritableTextFile(initial);
      if (!sameFile(original, initial)) throw conflict();
      const bytes = await readPrefix(handle, FILE_PREVIEW_MAX_BYTES + 1);
      if (bytes.length > FILE_PREVIEW_MAX_BYTES) throw new Error('File is too large to edit in the preview.');
      if (!isText(bytes)) throw new Error('Only valid UTF-8 text files without binary content can be saved.');
      if (!bytes.equals(expected)) throw conflict();
      const currentPath = await resolveInWorkspace(root, relative);
      if (!currentPath || currentPath.realRoot !== resolved.realRoot || currentPath.realTarget !== resolved.realTarget) throw conflict();
      const current = await fs.lstat(currentPath.realTarget, { bigint: true });
      assertWritableTextFile(current);
      if (!sameFile(initial, current) || current.size !== BigInt(bytes.length) || current.mtimeNs !== initial.mtimeNs || current.ctimeNs !== initial.ctimeNs) throw conflict();
      if (bytes.equals(next)) return;
      // This is optimistic, not a filesystem CAS against arbitrary external processes.
      // Write before shrinking so a failure before the first byte never truncates the file.
      let offset = 0;
      while (offset < next.length) {
        const { bytesWritten } = await handle.write(next, offset, next.length - offset, offset);
        if (!bytesWritten) throw new Error('Could not finish writing the file.');
        offset += bytesWritten;
      }
      if (next.length < bytes.length) await handle.truncate(next.length);
    } finally {
      await handle.close();
    }
  } finally {
    savingFiles.delete(key);
  }
}

/** Reads a workspace image as base64 for the Files panel. Null when the path escapes the
 *  workspace or is not an image type; `data` is empty when the file is over the size cap. */
export async function readWorkspaceImage(root: string, target: string): Promise<WorkspaceImage | null> {
  const mimeType = imageMimeType(target);
  if (!mimeType) return null;
  const resolved = await resolveInWorkspace(root, target);
  if (!resolved) return null;
  const size = (await fs.stat(resolved.realTarget)).size;
  if (size > MAX_IMAGE_BYTES) return { mimeType, data: '', size, tooLarge: true };
  const bytes = await fs.readFile(resolved.realTarget);
  return { mimeType, data: bytes.toString('base64'), size: bytes.length, tooLarge: false };
}
