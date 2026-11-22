/** The 7-day disk cache behind `harness:models`: expiry, fingerprints, persistence and recovery. */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MODEL_CATALOG_TTL_MS, ModelCatalogCache } from '../src/main/model-catalog-cache';
import type { ModelInfo } from '../src/shared/types';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-model-cache-'));
  dirs.push(d);
  return d;
};
const opus: ModelInfo = { id: 'claude-opus-5-5', provider: 'anthropic', displayName: 'Opus 5.5' };
const sonnet: ModelInfo = { id: 'claude-sonnet-5-5', provider: 'anthropic', displayName: 'Sonnet 5.5' };

describe('ModelCatalogCache', () => {
  it('serves a catalog for seven days, then rediscovers', async () => {
    let now = 1_000_000;
    const cache = new ModelCatalogCache(await tmp(), { now: () => now });
    const discover = vi.fn().mockResolvedValue({ models: [opus] });
    await cache.get('claude', 'fp', discover);
    now += MODEL_CATALOG_TTL_MS - 1;
    expect(await cache.get('claude', 'fp', discover)).toEqual({ models: [opus] });
    expect(discover).toHaveBeenCalledTimes(1);
    now += 1;
    discover.mockResolvedValue({ models: [opus, sonnet] });
    expect(await cache.get('claude', 'fp', discover)).toEqual({ models: [opus, sonnet] });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('misses on a different fingerprint and on a clock that moved backwards', async () => {
    let now = 5_000_000;
    const cache = new ModelCatalogCache(await tmp(), { now: () => now });
    const discover = vi.fn().mockResolvedValue({ models: [opus] });
    await cache.get('claude', 'endpoint-a', discover);
    await cache.get('claude', 'endpoint-b', discover);
    expect(discover).toHaveBeenCalledTimes(2);
    now -= 60_000;
    await cache.get('claude', 'endpoint-b', discover);
    expect(discover).toHaveBeenCalledTimes(3);
  });

  it('does not store empty or failed catalogs', async () => {
    const cache = new ModelCatalogCache(await tmp());
    const discover = vi.fn().mockResolvedValueOnce({ models: [] }).mockResolvedValueOnce({ models: [opus], error: 'fallback' }).mockResolvedValue({ models: [opus] });
    await cache.get('pi', 'fp', discover);
    await cache.get('pi', 'fp', discover);
    await cache.get('pi', 'fp', discover);
    await cache.get('pi', 'fp', discover);
    expect(discover).toHaveBeenCalledTimes(3);
  });

  it('keeps the catalog on disk without the fingerprint source, and starts empty from a corrupt file', async () => {
    const dir = await tmp();
    await new ModelCatalogCache(dir).get('claude', 'https://proxy.example/v1', async () => ({ models: [opus] }));
    const raw = await fs.readFile(path.join(dir, 'model-catalog-cache.json'), 'utf8');
    expect(raw).toContain('claude-opus-5-5');
    expect(raw).not.toContain('proxy.example');
    const discover = vi.fn().mockResolvedValue({ models: [sonnet] });
    expect(await new ModelCatalogCache(dir).get('claude', 'https://proxy.example/v1', discover)).toEqual({ models: [opus] });
    expect(discover).not.toHaveBeenCalled();

    await fs.writeFile(path.join(dir, 'model-catalog-cache.json'), '{ not json');
    expect(await new ModelCatalogCache(dir).get('claude', 'https://proxy.example/v1', discover)).toEqual({ models: [sonnet] });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('still answers and keeps the catalog in memory when the write fails', async () => {
    const parent = await tmp();
    const blocked = path.join(parent, 'not-a-dir');
    await fs.writeFile(blocked, 'file in the way');
    const log = vi.fn();
    const cache = new ModelCatalogCache(blocked, { log });
    const discover = vi.fn().mockResolvedValue({ models: [opus] });
    expect(await cache.get('codex', 'fp', discover)).toEqual({ models: [opus] });
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('could not save'));
    expect(await cache.get('codex', 'fp', discover)).toEqual({ models: [opus] });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('shares one discovery between concurrent callers', async () => {
    const cache = new ModelCatalogCache(await tmp());
    let release!: (v: { models: ModelInfo[] }) => void;
    const discover = vi.fn(() => new Promise<{ models: ModelInfo[] }>((r) => { release = r; }));
    const both = Promise.all([cache.get('cursor', 'fp', discover), cache.get('cursor', 'fp', discover)]);
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    release({ models: [opus] });
    expect(await both).toEqual([{ models: [opus] }, { models: [opus] }]);
  });

  it('a clear during discovery keeps that older result out of the cache', async () => {
    const dir = await tmp();
    const cache = new ModelCatalogCache(dir);
    let release!: (v: { models: ModelInfo[] }) => void;
    const pending = cache.get('claude', 'fp', () => new Promise((r) => { release = r; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await cache.clear();
    release({ models: [opus] });
    expect(await pending).toEqual({ models: [opus] });
    const discover = vi.fn().mockResolvedValue({ models: [sonnet] });
    expect(await cache.get('claude', 'fp', discover)).toEqual({ models: [sonnet] });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('a clear with nothing cached writes no file', async () => {
    const dir = await tmp();
    await new ModelCatalogCache(dir).clear();
    await new ModelCatalogCache(dir).clear('claude');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('clears one harness or all of them, on disk too', async () => {
    const dir = await tmp();
    const cache = new ModelCatalogCache(dir);
    const discover = vi.fn().mockResolvedValue({ models: [opus] });
    await cache.get('claude', 'fp', discover);
    await cache.get('pi', 'fp', discover);
    await cache.clear('claude');
    await cache.get('claude', 'fp', discover);
    await cache.get('pi', 'fp', discover);
    expect(discover).toHaveBeenCalledTimes(3);
    await cache.clear();
    expect(await fs.readFile(path.join(dir, 'model-catalog-cache.json'), 'utf8')).not.toContain('claude-opus-5-5');
    await cache.get('pi', 'fp', discover);
    expect(discover).toHaveBeenCalledTimes(4);
  });
});
