/** Node-only workspace file listing and bounded reading helpers. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { imageMimeType, type WorkspaceImage } from '../shared/image-files';
import type { FsEntry } from '../shared/types';
import type { WorkspaceFileResolution } from '../shared/ipc';

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

async function resolveInWorkspace(root: string, target = ''): Promise<{ lexicalRoot: string; lexicalTarget: string; realTarget: string } | undefined> {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(lexicalRoot, target);
  if (!isWithin(lexicalRoot, lexicalTarget)) return undefined;

  // The root first: when the whole folder is gone, that is what to report, not each file in it.
  const realRoot = await realpathOrNotFound(lexicalRoot, () => `${lexicalRoot} no longer exists`);
  const realTarget = await realpathOrNotFound(lexicalTarget, () => `${path.relative(lexicalRoot, lexicalTarget).split(path.sep).join('/')} was not found in ${lexicalRoot}`);
  if (!isWithin(realRoot, realTarget)) return undefined;
  return { lexicalRoot, lexicalTarget, realTarget };
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

/** `binary` is set, with empty content, when the bytes are not text: a zip decoded as UTF-8 is noise. */
export async function readWorkspaceFile(root: string, target: string, maxBytes?: number): Promise<{ content: string; truncated: boolean; binary?: boolean }> {
  const resolved = await resolveInWorkspace(root, target);
  if (!resolved) return { content: '', truncated: false };

  const requestedMax = maxBytes ?? DEFAULT_MAX_BYTES;
  const limit = Math.min(Math.max(0, Math.trunc(requestedMax)), MAX_BYTES);
  const handle = await fs.open(resolved.realTarget, 'r');
  try {
    const initialSize = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(initialSize, limit));
    let totalRead = 0;
    while (totalRead < buffer.length) {
      const { bytesRead } = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }

    if (buffer.subarray(0, Math.min(totalRead, BINARY_SNIFF_BYTES)).includes(0)) return { content: '', truncated: false, binary: true };
    const finalSize = (await handle.stat()).size;
    return {
      content: buffer.subarray(0, totalRead).toString('utf8'),
      truncated: finalSize > totalRead,
    };
  } finally {
    await handle.close();
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
