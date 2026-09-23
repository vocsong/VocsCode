/**
 * Live anchor resolution against a real MCP server over Streamable HTTP: the fixture answers the
 * same `context` shape GitNexus does, so this covers the JSON parsing, the caching and every
 * degraded path without needing an index.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitnexusAnchorResolver } from '../src/main/knowledge/anchors';
import type { KnowledgeScope } from '../src/shared/knowledge';

const fixture = path.resolve('tests/fixtures/mcp-graph-server.mjs');

let root: string;
let server: ChildProcess | null = null;
let calls = 0;
/** How many lookups the fixture had in flight at once, at their peak. */
let inFlight = 0;
let peakInFlight = 0;

/** Starts the graph fixture and waits for the port it announces. */
async function startGraph(slowMs?: number): Promise<string> {
  const child = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(slowMs ? { GRAPH_SLOW_MS: String(slowMs) } : {}) } });
  server = child;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('graph fixture did not start')), 20_000);
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      // Consume whole lines only: a chunk boundary must not re-count the lines already seen.
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith('CALL:context:')) {
          calls++;
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
        } else if (line.startsWith('END:context:')) {
          inFlight--;
        } else if (line.startsWith('READY:')) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${line.slice('READY:'.length).trim()}/mcp`);
        }
      }
    });
    child.on('error', reject);
  });
}

function resolver(url: string | null, repo: string | null = 'Vocs-Code') {
  return createGitnexusAnchorResolver({
    url: async () => url,
    repoName: async () => repo,
    log: () => undefined
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-anchors-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'present.ts'), 'export const x = 1;\n', 'utf8');
  calls = 0;
  inFlight = 0;
  peakInFlight = 0;
});

afterEach(async () => {
  server?.kill();
  server = null;
  await new Promise((resolve) => setTimeout(resolve, 150));
  await fs.rm(root, { recursive: true, force: true });
});

const scope = (): KnowledgeScope => ({ projectRoot: root, cwd: root });

describe('anchor resolution', () => {
  it('reports found symbols with their location, and moved ones with a note', async () => {
    const url = await startGraph();
    const [found, moved] = await resolver(url).resolve(scope(), [
      { file: 'src/main/session-manager.ts', symbol: 'buildContext' },
      { file: 'src/main/session-manager.ts', symbol: 'movedSymbol' }
    ]);
    expect(found).toMatchObject({ status: 'resolved', foundName: 'buildContext', uid: 'Method:src/main/session-manager.ts:SessionManager.buildContext#2' });
    expect(found.lines).toEqual({ start: 520, end: 562 });
    expect(found.note).toBeUndefined();
    expect(moved).toMatchObject({ status: 'resolved', foundFile: 'src/main/elsewhere.ts' });
    expect(moved.note).toContain('src/main/elsewhere.ts');
  });

  it('reports a symbol the index does not have as unresolved, including the advice line GitNexus appends', async () => {
    const url = await startGraph();
    const [gone] = await resolver(url).resolve(scope(), [{ file: 'src/main/gone.ts', symbol: 'NeverExisted' }]);
    expect(gone.status).toBe('unresolved');
    expect(gone.note).toContain("Symbol 'NeverExisted' not found");
  });

  it('caches a resolution instead of asking again', async () => {
    const url = await startGraph();
    // One resolver instance is what the app holds; the cache lives with it.
    const resolve = resolver(url);
    const anchors = [{ file: 'src/main/session-manager.ts', symbol: 'buildContext' }];
    await resolve.resolve(scope(), anchors);
    await resolve.resolve(scope(), anchors);
    expect(calls).toBe(1);
  });

  it('answers file-only anchors from disk, without calling the graph', async () => {
    const url = await startGraph();
    const [present, missing] = await resolver(url).resolve(scope(), [{ file: 'src/present.ts' }, { file: 'src/absent.ts' }]);
    expect(present.status).toBe('resolved');
    expect(missing).toMatchObject({ status: 'unresolved', note: 'File not found.' });
    expect(calls).toBe(0);
  });

  it('degrades to unavailable when GitNexus is down or the project is not indexed', async () => {
    const off = await resolver(null).resolve(scope(), [{ file: 'src/main/x.ts', symbol: 'x' }]);
    expect(off[0]).toMatchObject({ status: 'unavailable', note: 'GitNexus is not running.' });
    const unindexed = await resolver('http://127.0.0.1:1/mcp', null).resolve(scope(), [{ file: 'src/main/x.ts', symbol: 'x' }]);
    expect(unindexed[0]).toMatchObject({ status: 'unavailable', note: 'This project is not indexed by GitNexus.' });
    const refused = await resolver('http://127.0.0.1:1/mcp').resolve(scope(), [{ file: 'src/main/x.ts', symbol: 'x' }]);
    expect(refused[0].status).toBe('unavailable');
  });

  it('does not ask GitNexus to start when the project is not indexed', async () => {
    let urlAsked = false;
    const resolve = createGitnexusAnchorResolver({
      url: async () => {
        urlAsked = true;
        return 'http://127.0.0.1:1/mcp';
      },
      repoName: async () => null,
      log: () => undefined
    });
    const out = await resolve.resolve(scope(), [{ file: 'src/main/x.ts', symbol: 'x' }]);
    expect(out[0]).toMatchObject({ status: 'unavailable', note: 'This project is not indexed by GitNexus.' });
    // Starting the server for an unindexed project is the slow path the panel must never wait on.
    expect(urlAsked).toBe(false);
  });

  it('bounds the whole call, including a slow start, and says it ran out of time', async () => {
    let urlAsked = false;
    const resolve = createGitnexusAnchorResolver({
      url: async () => {
        urlAsked = true;
        return 'http://127.0.0.1:1/mcp';
      },
      repoName: () => new Promise((r) => setTimeout(() => r('Vocs-Code'), 3_000)),
      log: () => undefined,
      budgetMs: 200
    });
    const started = Date.now();
    const out = await resolve.resolve(scope(), [{ file: 'src/main/x.ts', symbol: 'x' }]);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(out[0]).toMatchObject({ status: 'unavailable', note: 'Anchor resolution ran out of time.' });
    // The budget is spent, so nothing after it is even attempted.
    expect(urlAsked).toBe(false);
  });

  it('reports the timer winning the registry or server lookup even when the clock reads before the deadline', async () => {
    // A coarse clock can still read one tick before the deadline after setTimeout has fired.
    // Timeout attribution must come from the race winner, not from a fresh clock reading.
    let urlAsked = false;
    const anchor = { file: 'src/main/x.ts', symbol: 'x' };
    const unindexed = createGitnexusAnchorResolver({
      repoName: () => new Promise<string | null>(() => undefined),
      url: async () => {
        urlAsked = true;
        return 'http://127.0.0.1:1/mcp';
      },
      log: () => undefined,
      budgetMs: 10,
      now: () => 0
    });
    expect(await unindexed.resolve(scope(), [anchor])).toEqual([{ ...anchor, status: 'unavailable', note: 'Anchor resolution ran out of time.' }]);
    expect(urlAsked).toBe(false);

    const offline = createGitnexusAnchorResolver({
      repoName: async () => 'Vocs-Code',
      url: () => new Promise<string | null>(() => undefined),
      log: () => undefined,
      budgetMs: 10,
      now: () => 0
    });
    expect(await offline.resolve(scope(), [anchor])).toEqual([{ ...anchor, status: 'unavailable', note: 'Anchor resolution ran out of time.' }]);
  });

  it('stops waiting on a wedged lookup instead of holding the detail view', async () => {
    const url = await startGraph();
    const resolve = createGitnexusAnchorResolver({ url: async () => url, repoName: async () => 'Vocs-Code', log: () => undefined, budgetMs: 400 });
    const started = Date.now();
    // The fixture answers `sleepy` only after 3s; the panel must not wait for it.
    const out = await resolve.resolve(scope(), [{ file: 'src/main/session-manager.ts', symbol: 'sleepy' }]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out[0].status).toBe('unavailable');
  });

  it('looks symbols up in parallel rather than one after another', async () => {
    const url = await startGraph(120);
    const resolve = createGitnexusAnchorResolver({ url: async () => url, repoName: async () => 'Vocs-Code', log: () => undefined, concurrency: 2 });
    const out = await resolve.resolve(
      scope(),
      ['a', 'b', 'c', 'd'].map((n) => ({ file: `src/${n}.ts`, symbol: 'sleepy' }))
    );
    expect(out.map((a) => a.status)).toEqual(['resolved', 'resolved', 'resolved', 'resolved']);
    expect(calls).toBe(4);
    // Serial workers would never have two lookups waiting at the same time.
    expect(peakInFlight).toBeGreaterThan(1);
  });

  it('keeps the page order when only some anchors resolve', async () => {
    const url = await startGraph();
    const out = await resolver(url).resolve(scope(), [
      { file: 'src/present.ts' },
      { file: 'src/main/session-manager.ts', symbol: 'buildContext' },
      { file: 'src/absent.ts' }
    ]);
    expect(out.map((a) => a.status)).toEqual(['resolved', 'resolved', 'unresolved']);
  });
});
