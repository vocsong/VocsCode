/** Filesystem helpers shared by the main process: JSON and JSONL persistence, and path containment checks. */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return fallback;
    // Corrupt JSON: keep a backup and return fallback rather than crashing the app.
    try {
      await fs.copyFile(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* ignore */
    }
    return fallback;
  }
}

let tmpCounter = 0;

/** Windows reports these while another handle still has the target open, and they clear on their own. */
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 5 || !TRANSIENT_RENAME_ERRORS.has(code)) throw e;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}

async function writeJsonOnce(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.${(tmpCounter = (tmpCounter + 1) % 1_000_000)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    await renameWithRetry(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** In-flight write per file, so two callers never rename onto the same target at once. */
const writeChain = new Map<string, Promise<void>>();

/**
 * Atomic JSON write: write to a unique temp file, then rename over the target. Writes to the same
 * path are serialized rather than racing, because on Windows two concurrent renames onto one target
 * make the loser fail with EPERM. The rename is also retried for transient locks (antivirus, indexer).
 */
export async function writeJson(file: string, data: unknown): Promise<void> {
  const run = (writeChain.get(file) ?? Promise.resolve()).then(
    () => writeJsonOnce(file, data),
    () => writeJsonOnce(file, data)
  );
  writeChain.set(file, run);
  try {
    await run;
  } finally {
    if (writeChain.get(file) === run) writeChain.delete(file);
  }
}

export async function appendLine(file: string, line: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, line + '\n', 'utf8');
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const out: T[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as T);
      } catch {
        /* skip bad line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

export function isSubPath(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
