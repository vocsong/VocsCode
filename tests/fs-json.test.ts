/** Unit tests for atomic JSON persistence: round-trip, overwrite, serialization and corruption quarantine. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { readJson, writeJson } from '../src/main/util/fs';

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function tmpDir(): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vocs-fs-'));
  dirs.push(d);
  return d;
}

describe('writeJson', () => {
  it('round-trips through readJson, creating parent dirs', async () => {
    const file = path.join(tmpDir(), 'nested', 'data.json');
    await writeJson(file, { a: 1, days: { '2026-09-10': { turns: 3 } } });
    await expect(readJson(file, null)).resolves.toEqual({ a: 1, days: { '2026-09-10': { turns: 3 } } });
  });

  it('replaces the target wholesale and leaves no temp files', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'data.json');
    await fs.writeFile(file, '{"old":true}', 'utf8');
    await writeJson(file, { new: true });
    await expect(readJson<{ old?: boolean; new?: boolean } | undefined>(file, undefined)).resolves.toEqual({ new: true });
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('serializes concurrent writes so both land and one wins', async () => {
    const file = path.join(tmpDir(), 'data.json');
    await Promise.all([writeJson(file, { n: 1 }), writeJson(file, { n: 2 })]);
    const v = await readJson<{ n: number } | undefined>(file, undefined);
    expect([1, 2]).toContain(v?.n);
  });
});

describe('readJson corruption handling', () => {
  it('quarantines an unreadable file and returns the fallback', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'data.json');
    await fs.writeFile(file, '\u0000'.repeat(64), 'utf8');
    await expect(readJson(file, 'fallback')).resolves.toBe('fallback');
    expect((await fs.readdir(dir)).filter((f) => f.startsWith('data.json.corrupt-'))).toHaveLength(1);
  });

  it('returns the fallback for a missing file without quarantining', async () => {
    const dir = tmpDir();
    await expect(readJson(path.join(dir, 'absent.json'), 7)).resolves.toBe(7);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
