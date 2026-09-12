/** Node-only workspace file listing and bounded reading helpers. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FsEntry } from '../shared/types';

const DEFAULT_MAX_BYTES = 400_000;
const MAX_BYTES = 2_000_000;

function resolveInWorkspace(root: string, target = ''): string | undefined {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return resolvedTarget;
}

export async function listWorkspaceFiles(root: string, relPath?: string): Promise<FsEntry[]> {
  const dir = resolveInWorkspace(root, relPath);
  if (!dir) return [];

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: FsEntry[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    let size: number | undefined;
    if (entry.isFile()) {
      try {
        size = (await fs.stat(absolutePath)).size;
      } catch {
        // The entry may disappear between readdir and stat.
      }
    }
    out.push({
      name: entry.name,
      path: path.relative(path.resolve(root), absolutePath),
      isDir: entry.isDirectory(),
      size,
    });
  }
  return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

export async function readWorkspaceFile(root: string, target: string, maxBytes?: number): Promise<{ content: string; truncated: boolean }> {
  const absolutePath = resolveInWorkspace(root, target);
  if (!absolutePath) return { content: '', truncated: false };

  const requestedMax = maxBytes ?? DEFAULT_MAX_BYTES;
  const limit = Math.min(Math.max(0, Math.trunc(requestedMax)), MAX_BYTES);
  const handle = await fs.open(absolutePath, 'r');
  try {
    const initialSize = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(initialSize, limit));
    let totalRead = 0;
    while (totalRead < buffer.length) {
      const { bytesRead } = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }

    const finalSize = (await handle.stat()).size;
    return {
      content: buffer.subarray(0, totalRead).toString('utf8'),
      truncated: finalSize > totalRead,
    };
  } finally {
    await handle.close();
  }
}
