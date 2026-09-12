/** Node-only workspace file listing and bounded reading helpers. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FsEntry } from '../shared/types';

const DEFAULT_MAX_BYTES = 400_000;
const MAX_BYTES = 2_000_000;

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolveInWorkspace(root: string, target = ''): Promise<{ lexicalRoot: string; lexicalTarget: string; realTarget: string } | undefined> {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(lexicalRoot, target);
  if (!isWithin(lexicalRoot, lexicalTarget)) return undefined;

  const [realRoot, realTarget] = await Promise.all([fs.realpath(lexicalRoot), fs.realpath(lexicalTarget)]);
  if (!isWithin(realRoot, realTarget)) return undefined;
  return { lexicalRoot, lexicalTarget, realTarget };
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

export async function readWorkspaceFile(root: string, target: string, maxBytes?: number): Promise<{ content: string; truncated: boolean }> {
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

    const finalSize = (await handle.stat()).size;
    return {
      content: buffer.subarray(0, totalRead).toString('utf8'),
      truncated: finalSize > totalRead,
    };
  } finally {
    await handle.close();
  }
}
