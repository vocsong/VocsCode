/**
 * The Layer 2 MCP server as a real process: spawned with node, spoken to over stdio, reading a wiki
 * the TypeScript store wrote. The second half of each assertion is the cross-codec contract — the
 * .mjs frontmatter writer must produce files the app's parser accepts, and vice versa.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { KnowledgeStore } from '../src/main/knowledge/store';
import { KnowledgeService } from '../src/main/knowledge/service';
import { SearchIndex } from '../src/main/search';
import { SessionStore } from '../src/main/store';
import { claimKey, serializeKnowledgeDocument } from '../src/shared/knowledge';
import type { KnowledgePageMeta, KnowledgeScope } from '../src/shared/knowledge';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const script = path.join(process.cwd(), 'resources', 'mcp', 'vocs-memory.mjs');
const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterAll(async () => {
  for (const child of children) child.kill();
  // The memory server holds search.db open read-only; give the kill a beat before removing temps.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function tmpDir(prefix: string): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

interface Rpc {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function start(root: string, extraEnv: Record<string, string> = {}, nodeArgs: string[] = []): { child: ChildProcessWithoutNullStreams; request: (message: Record<string, unknown>) => Promise<Rpc> } {
  const child = spawn(process.execPath, [...nodeArgs, script], { env: { ...process.env, VOCS_MEMORY_ROOT: root, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const pending = new Map<number, (msg: Rpc) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as Rpc;
        if (typeof message.id === 'number') pending.get(message.id)?.(message);
      } catch {
        /* ignore */
      }
    }
  });
  let nextId = 1;
  const request = (body: Record<string, unknown>): Promise<Rpc> => {
    const id = nextId++;
    return new Promise<Rpc>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`vocs-memory did not answer ${String(body.method)}`)), 20_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
    });
  };
  return { child, request };
}

function toolText(rpc: Rpc): string {
  const result = rpc.result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
  return result?.content?.map((c) => c.text ?? '').join('\n') ?? '';
}

function pageMeta(over: Partial<KnowledgePageMeta> = {}): KnowledgePageMeta {
  return {
    id: 'conventions/harness-lifecycle',
    title: 'Harness lifecycle',
    kind: 'convention',
    status: 'current',
    scope: 'repo',
    claim: 'A harness process belongs to exactly one session.',
    keywords: ['harness', 'session', 'lifecycle'],
    labels: [],
    sources: [{ type: 'file', ref: 'src/main/session-manager.ts' }],
    anchors: [{ file: 'src/main/session-manager.ts', symbol: 'SessionManager.buildContext' }],
    related: [],
    supersedes: [],
    contradicts: [],
    review: { state: 'reviewed', by: 'human' },
    ...over
  };
}

describe('vocs-memory MCP server', () => {
  it.each([
    ['C++ is required.', 'C# is required.'],
    ['The key is Foo.', 'The key is foo.'],
    ['缓存必须持久化。', '缓存不可持久化。']
  ])('preserves exact claim identity, including punctuation, case and Unicode (%s)', async (claim, different) => {
    const projectRoot = tmpDir('vocs-mem-exact-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const { request } = start(wiki);
    const propose = (text: string) => request({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: { title: 'Exact identity', claim: text, body: 'complete body' } } });
    const first = await propose(claim);
    const id = JSON.parse(toolText(first)).id as string;
    expect((await propose(claim)).result).not.toMatchObject({ isError: true });
    const file = path.join(wiki, `${id}.md`);
    const before = await fs.readFile(file, 'utf8');
    expect((await propose(different)).result).toMatchObject({ isError: true });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await new KnowledgeStore().load({ projectRoot, cwd: projectRoot })).map((p) => p.meta.claim)).toEqual([claim]);
  });

  it.each([
    ['Same title', 'Same title'],
    ['A & B', 'A / B'],
    [`${'a'.repeat(60)} first`, `${'a'.repeat(60)} second`]
  ])('refuses implicit generated id collisions without changing the wiki (%s)', async (firstTitle, secondTitle) => {
    const projectRoot = tmpDir('vocs-mem-collision-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    await fs.mkdir(wiki, { recursive: true });
    const { request } = start(wiki);
    const first = await request({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: { title: firstTitle, claim: 'The original claim.', body: 'original body' } } });
    const id = JSON.parse(toolText(first)).id as string;
    const before = await fs.readFile(path.join(wiki, `${id}.md`), 'utf8');
    const collision = await request({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: { title: secondTitle, claim: 'An unrelated claim.', body: 'replacement' } } });
    expect((collision.result as { isError?: boolean }).isError).toBe(true);
    expect(toolText(collision)).toMatch(/different title.*pageId.*page_id/i);
    expect(await fs.readFile(path.join(wiki, `${id}.md`), 'utf8')).toBe(before);
    expect(await new KnowledgeStore().load({ projectRoot, cwd: projectRoot })).toHaveLength(1);
  });

  it('uses actual normalized claims rather than a 32-bit hash or a truncated prefix', async () => {
    const projectRoot = tmpDir('vocs-mem-identity-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const { request } = start(wiki);
    const propose = (title: string, claim: string) => request({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: { title, claim, body: 'complete body' } } });
    const claims = ['claim ep3txk14adwdaeyh1085rcn12yo1a63otbxug55a', 'claim puezp2ukksp1y031bb819jg1c3pufk171h1clm19oq'];
    expect(claimKey(claims[0])).toBe(claimKey(claims[1]));
    expect(JSON.parse(toolText(await propose('First hash', claims[0]))).saved).toBe(true);
    expect(JSON.parse(toolText(await propose('Second hash', claims[1]))).saved).toBe(true);
    expect(await new KnowledgeStore().load({ projectRoot, cwd: projectRoot })).toHaveLength(2);
    const longClaim = 'a'.repeat(310);
    await propose('Long claim', longClaim);
    const collision = await propose('Long claim', `${longClaim} different`);
    expect((collision.result as { isError?: boolean }).isError).toBe(true);
    expect(toolText(collision)).toContain('different claim');
  });

  it('serializes real MCP processes competing for an implicit generated id', async () => {
    const projectRoot = tmpDir('vocs-mem-race-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const clients = Array.from({ length: 4 }, () => start(wiki));
    const results = await Promise.all(clients.map(({ request }, index) => request({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: { title: index % 2 ? 'Race & title' : 'Race / title', claim: `Unrelated claim ${index}`, body: `Complete body ${index}`, labels: [`winner-${index}`] } } })));
    const successes = results.map((rpc) => !(rpc.result as { isError?: boolean }).isError);
    expect(successes.filter(Boolean)).toHaveLength(1);
    for (const [index, rpc] of results.entries()) if (!successes[index]) expect(toolText(rpc)).toContain('different claim');
    const winner = successes.indexOf(true);
    const pages = await new KnowledgeStore().load({ projectRoot, cwd: projectRoot });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ body: `Complete body ${winner}`, meta: { claim: `Unrelated claim ${winner}`, labels: [`winner-${winner}`], evidenceCount: 1 } });
    expect(await fs.readdir(path.join(wiki, 'concept'))).toEqual(['race-title.md']);
    await expect(fs.stat(path.join(wiki, '_write.lock'))).rejects.toThrow();
  });

  it('merges same-claim evidence from competing MCP processes without duplicating a page', async () => {
    const projectRoot = tmpDir('vocs-mem-repeat-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const clients = Array.from({ length: 4 }, () => start(wiki));
    const results = await Promise.all(clients.map(({ request }, index) => request({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: { title: `Title ${index}`, claim: index % 2 ? 'The main  process  owns state.' : 'The main process owns state.', body: `Complete ${index}`, labels: [`label-${index}`] } } })));
    const ids = results.map((rpc) => JSON.parse(toolText(rpc)).id);
    expect(new Set(ids).size).toBe(1);
    const pages = await new KnowledgeStore().load({ projectRoot, cwd: projectRoot });
    expect(pages).toHaveLength(1);
    expect(pages[0].meta.evidenceCount).toBe(4);
    expect(pages[0].meta.labels.slice().sort()).toEqual(['label-0', 'label-1', 'label-2', 'label-3']);
  });

  it('shares the collision boundary between app instances and real MCP processes', async () => {
    const projectRoot = tmpDir('vocs-mem-mixed-');
    const scope = { projectRoot, cwd: projectRoot };
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const svc = new KnowledgeService({ log: () => undefined, settings: () => ({}) as AppSettings });
    const { request } = start(wiki);
    const [app, mcp] = await Promise.all([
      svc.propose(scope, { title: 'Mixed race', claim: 'App claim.', body: 'Complete app body' }, 'agent', 's-app').then(() => true, (error: Error) => { expect(error.message).toContain('different claim'); return false; }),
      request({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: { title: 'Mixed race', claim: 'MCP claim.', body: 'Complete MCP body' } } })
    ]);
    const mcpWon = !(mcp.result as { isError?: boolean }).isError;
    expect(Number(app) + Number(mcpWon)).toBe(1);
    if (!mcpWon) expect(toolText(mcp)).toContain('different claim');
    const pages = await new KnowledgeStore().load(scope);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ body: app ? 'Complete app body' : 'Complete MCP body', meta: { claim: app ? 'App claim.' : 'MCP claim.', evidenceCount: 1 } });
    expect(await fs.readdir(path.join(wiki, 'concept'))).toEqual(['mixed-race.md']);
  });

  it.each(['app', 'mcp'])('preserves a %s winner against the other writer and still permits explicit updates', async (winner) => {
    const projectRoot = tmpDir('vocs-mem-winner-');
    const scope = { projectRoot, cwd: projectRoot };
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const svc = new KnowledgeService({ log: () => undefined, settings: () => ({}) as AppSettings });
    const { request } = start(wiki);
    const app = (claim: string, pageId?: string) => svc.propose(scope, { title: 'Shared name', claim, body: `${claim} body`, pageId, labels: ['app'] }, 'agent');
    const mcp = (claim: string, page_id?: string) => request({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: { title: 'Shared name', claim, body: `${claim} body`, page_id, labels: ['mcp'] } } });
    const id = 'concept/shared-name';
    if (winner === 'app') await app('App claim.');
    else expect(JSON.parse(toolText(await mcp('MCP claim.'))).saved).toBe(true);
    const file = path.join(wiki, `${id}.md`);
    const before = await fs.readFile(file, 'utf8');
    if (winner === 'app') expect((await mcp('MCP claim.')).result).toMatchObject({ isError: true });
    else await expect(app('App claim.')).rejects.toThrow(/different claim/);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    if (winner === 'app') expect(JSON.parse(toolText(await mcp('MCP claim.', id))).saved).toBe(true);
    else expect((await app('App claim.', id)).promoted).toBe(true);
    const page = await new KnowledgeStore().read(scope, id);
    expect(page?.meta.labels.slice().sort()).toEqual(['app', 'mcp']);
    expect(page?.meta.evidenceCount).toBe(2);
    expect(page?.body).toBe(winner === 'app' ? 'MCP claim. body' : 'App claim. body');
  });

  it('merges concurrent explicit app/MCP updates using fresh provenance and complete pages', async () => {
    const projectRoot = tmpDir('vocs-mem-explicit-');
    const scope = { projectRoot, cwd: projectRoot };
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const id = 'concept/custom';
    const store = new KnowledgeStore();
    await store.write(scope, pageMeta({ id, labels: ['original'], createdAt: '2020-01-01T00:00:00.000Z', evidenceCount: 5, confidence: 'high', review: { state: 'reviewed', by: 'human', note: 'Preserve me.' }, related: ['concept/other'] }), 'original');
    const svc = new KnowledgeService({ log: () => undefined, settings: () => ({}) as AppSettings, store });
    const clients = Array.from({ length: 3 }, () => start(wiki));
    const results = await Promise.all([
      svc.propose(scope, { pageId: id, title: 'Custom', claim: 'App replacement.', body: 'App replacement. body', labels: ['app'], sources: [{ type: 'file', ref: 'app.ts' }] }, 'agent'),
      ...clients.map(({ request }, index) => request({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: { page_id: id, title: 'Custom', claim: `MCP replacement ${index}.`, body: `MCP replacement ${index}. body`, labels: [`mcp-${index}`], sources: [{ type: 'file', ref: `mcp-${index}.ts` }] } } }).then((rpc) => { expect(JSON.parse(toolText(rpc)).saved).toBe(true); return rpc; }))
    ]);
    expect(results).toHaveLength(4);
    const page = await new KnowledgeStore().read(scope, id);
    expect(page?.meta).toMatchObject({ createdAt: '2020-01-01T00:00:00.000Z', evidenceCount: 9, confidence: 'high', review: { state: 'reviewed', by: 'human', note: 'Preserve me.' }, related: ['concept/other'] });
    expect(page?.meta.labels.slice().sort()).toEqual(['app', 'mcp-0', 'mcp-1', 'mcp-2', 'original']);
    expect(page?.meta.sources.map((s) => s.ref).sort()).toEqual(['app.ts', 'mcp-0.ts', 'mcp-1.ts', 'mcp-2.ts', 'src/main/session-manager.ts']);
    expect(page?.body).toBe(`${page?.meta.claim} body`);
    expect(await fs.readdir(path.join(wiki, 'concept'))).toEqual(['custom.md']);
  });

  it('preserves the complete old page on a real-process rename failure and can retry', async () => {
    const projectRoot = tmpDir('vocs-mem-failure-');
    const scope = { projectRoot, cwd: projectRoot };
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const id = 'concept/failure';
    await new KnowledgeStore().write(scope, pageMeta({ id, createdAt: '2020-01-01T00:00:00.000Z' }), 'complete original body');
    const file = path.join(wiki, `${id}.md`);
    const before = await fs.readFile(file, 'utf8');
    // Inject at the real child's filesystem boundary, without a test hook in production code.
    const preload = `import { promises as fs } from 'node:fs'; const rename = fs.rename; let failed = false; fs.rename = async (from, to) => { if (!failed && String(to) === ${JSON.stringify(file)}) { failed = true; throw Object.assign(new Error('injected MCP rename failure'), { code: 'EACCES' }); } return rename(from, to); };`;
    const { request } = start(wiki, {}, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`]);
    const propose = () => request({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: { title: 'Failure', claim: 'Replacement claim.', body: 'complete replacement body', page_id: id, labels: ['replacement'] } } });
    const failure = await propose();
    expect(failure.result).toMatchObject({ isError: true });
    expect(toolText(failure)).toContain('injected MCP rename failure');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readdir(path.dirname(file))).toEqual(['failure.md']);
    await expect(fs.stat(path.join(wiki, '_write.lock'))).rejects.toThrow();
    expect(JSON.parse(toolText(await propose())).saved).toBe(true);
    const page = await new KnowledgeStore().read(scope, id);
    expect(page?.body).toBe('complete replacement body');
    expect(page?.meta.createdAt).toBe('2020-01-01T00:00:00.000Z');
    expect(page?.meta.evidenceCount).toBe(1);
  });

  it('fails closed on an abandoned cross-process lock and recovers after offline removal', async () => {
    const projectRoot = tmpDir('vocs-mem-lock-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const lock = path.join(wiki, '_write.lock');
    await fs.mkdir(lock, { recursive: true });
    await fs.utimes(lock, new Date(0), new Date(0));
    const { request } = start(wiki);
    const propose = () => request({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: { title: 'Recovery', claim: 'Recovered claim.', body: 'complete body' } } });
    const result = await propose();
    expect(result.result).toMatchObject({ isError: true });
    expect(toolText(result)).toContain('stop all app/MCP writers');
    expect(await fs.readdir(wiki)).toEqual(['_write.lock']);
    await fs.rmdir(lock);
    expect(JSON.parse(toolText(await propose())).saved).toBe(true);
    expect((await new KnowledgeStore().load({ projectRoot, cwd: projectRoot }))[0].body).toBe('complete body');
  });

  it('refuses a damaged destination without writing and recovers when it is repaired offline', async () => {
    const projectRoot = tmpDir('vocs-mem-damaged-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const file = path.join(wiki, 'concept', 'damaged.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'hand-written content without frontmatter');
    const { request } = start(wiki);
    const propose = () => request({ method: 'tools/call', params: { name: 'knowledge_propose', arguments: { title: 'Damaged', claim: 'A claim.', body: 'complete body' } } });
    expect((await propose()).result).toMatchObject({ isError: true });
    expect(await fs.readFile(file, 'utf8')).toBe('hand-written content without frontmatter');
    expect(await fs.readdir(path.dirname(file))).toEqual(['damaged.md']);
    await fs.rm(file);
    expect(JSON.parse(toolText(await propose())).saved).toBe(true);
    expect((await new KnowledgeStore().read({ projectRoot, cwd: projectRoot }, 'concept/damaged'))?.body).toBe('complete body');
  });

  it('lists its six tools and searches pages the app wrote', async () => {
    const projectRoot = tmpDir('vocs-mem-');
    const store = new KnowledgeStore();
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    await store.write(scope, pageMeta(), '# Harness lifecycle\n\nOne harness per session; the main process owns it.');
    await store.write(scope, pageMeta({ id: 'gotchas/pty', title: 'Duplicate PTYs', kind: 'gotcha', claim: 'Reconnects can duplicate a PTY.', keywords: ['pty'], status: 'draft' }), 'A draft page.');
    // Another branch's slice must stay invisible to a session that is not on that branch.
    await fs.mkdir(path.join(projectRoot, '.vocs-code', 'wiki', 'branches', 'other'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.vocs-code', 'wiki', 'branches', 'other', 'zebra.md'),
      serializeKnowledgeDocument(pageMeta({ id: 'zebra', title: 'Zebra branch note', claim: 'A zebra-only claim.', keywords: ['zebra'] }), 'zebra body'),
      'utf8'
    );

    const { request } = start(path.join(projectRoot, '.vocs-code', 'wiki'));
    const init = await request({ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect((init.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe('vocs-memory');

    const tools = await request({ method: 'tools/list', params: {} });
    const names = (tools.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(['knowledge_search', 'knowledge_read', 'knowledge_related', 'knowledge_propose', 'knowledge_status', 'session_history_search']);

    const search = await request({ method: 'tools/call', params: { name: 'knowledge_search', arguments: { query: 'harness session' } } });
    const payload = JSON.parse(toolText(search)) as { results: { id: string; claim?: string; authority?: string }[] };
    expect(payload.results.map((r) => r.id)).toEqual(['conventions/harness-lifecycle']);
    expect(payload.results[0].authority).toBe('human-reviewed');
    // A draft is never served to an agent as knowledge.
    const draftSearch = await request({ method: 'tools/call', params: { name: 'knowledge_search', arguments: { query: 'PTY' } } });
    expect(JSON.parse(toolText(draftSearch)).results).toHaveLength(0);

    const read = await request({ method: 'tools/call', params: { name: 'knowledge_read', arguments: { page: 'conventions/harness-lifecycle' } } });
    const page = JSON.parse(toolText(read)) as { body: string; sources: { ref: string }[]; anchors: { symbol?: string }[] };
    expect(page.body).toContain('One harness per session');
    expect(page.sources[0].ref).toBe('src/main/session-manager.ts');
    expect(page.anchors[0].symbol).toBe('SessionManager.buildContext');

    const related = await request({ method: 'tools/call', params: { name: 'knowledge_related', arguments: { path: 'src/main/session-manager.ts' } } });
    expect(JSON.parse(toolText(related)).page).toBe('conventions/harness-lifecycle');

    const status = await request({ method: 'tools/call', params: { name: 'knowledge_status', arguments: {} } });
    expect(JSON.parse(toolText(status)).pages).toBe(2);
    // Another branch's page is not in this session's view.
    const zebra = await request({ method: 'tools/call', params: { name: 'knowledge_search', arguments: { query: 'zebra' } } });
    expect(JSON.parse(toolText(zebra)).count).toBe(0);
  });

  it('writes a current page the app reads back and serves', async () => {
    const projectRoot = tmpDir('vocs-mem-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    await fs.mkdir(wiki, { recursive: true });
    const { request } = start(wiki);
    const propose = await request({
      method: 'tools/call',
      params: {
        name: 'knowledge_propose',
        arguments: {
          title: 'Renderer never owns a PTY',
          claim: 'Only the main process may create or kill a PTY.',
          kind: 'convention',
          body: '## Why\n\nThe renderer re-attaches to snapshots.',
          labels: ['Terminal & PTY', 'terminal'],
          sources: [{ type: 'file', ref: 'src/main/terminal.ts' }],
          anchors: [{ file: 'src/main/terminal.ts' }]
        }
      }
    });
    const result = JSON.parse(toolText(propose)) as { id: string; targetPageId: string; status: string; saved: boolean };
    expect(result).toMatchObject({ status: 'current', saved: true });
    expect(result.targetPageId).toBe('convention/renderer-never-owns-a-pty');

    // The page lands under the wiki root, never in the legacy proposal queue.
    const raw = await fs.readFile(path.join(wiki, 'convention', 'renderer-never-owns-a-pty.md'), 'utf8');
    expect(raw).toContain('status: current');
    expect(raw).toContain('updated_by: agent:mcp');
    await expect(fs.access(path.join(wiki, '_proposals'))).rejects.toThrow();

    // The app's own store reads it back, normalizing the labels the same way shared does.
    const store = new KnowledgeStore();
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const page = await store.read(scope, result.targetPageId);
    expect(page?.meta.status).toBe('current');
    expect(page?.meta.updatedBy).toBe('agent:mcp');
    expect(page?.meta.labels).toEqual(['terminal-pty', 'terminal']);
    expect(page?.body).toContain('re-attaches to snapshots');

    // It is servable immediately: knowledge_search finds the new page.
    const search = await request({ method: 'tools/call', params: { name: 'knowledge_search', arguments: { query: 'renderer PTY' } } });
    const payload = JSON.parse(toolText(search)) as { results: { id: string; labels: string[] }[] };
    expect(payload.results.map((r) => r.id)).toContain(result.targetPageId);
    expect(payload.results.find((r) => r.id === result.targetPageId)?.labels).toEqual(['terminal-pty', 'terminal']);
  });

  it('files a worktree session proposal into the project wiki, not the branch slice', async () => {
    const projectRoot = tmpDir('vocs-mem-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const branchRoot = path.join(wiki, 'branches', 'vocscode-feature');
    await fs.mkdir(branchRoot, { recursive: true });
    // A worktree session is the app's default; every one of them carries a branch root.
    const { request } = start(wiki, { VOCS_MEMORY_BRANCH_ROOT: branchRoot, VOCS_MEMORY_BRANCH: 'vocscode/feature' });
    const propose = await request({
      method: 'tools/call',
      params: { name: 'knowledge_propose', arguments: { title: 'PTY ownership', claim: 'Only the main process owns a PTY.', kind: 'convention', body: 'Body text.' } }
    });
    const result = JSON.parse(toolText(propose)) as { targetPageId: string; scope: string };
    expect(result.scope).toBe('repo');

    // The page lands where every other session of the project can read it.
    const raw = await fs.readFile(path.join(wiki, 'convention', 'pty-ownership.md'), 'utf8');
    expect(raw).toContain('scope: repo');
    expect(raw).not.toContain('branch:');
    await expect(fs.access(path.join(branchRoot, 'convention'))).rejects.toThrow();

    // A session on the branch sees it through the ordinary repo-scope overlay.
    const store = new KnowledgeStore();
    const fromBranch: KnowledgeScope = { projectRoot, cwd: projectRoot, branch: 'vocscode/feature' };
    expect((await store.read(fromBranch, 'convention/pty-ownership'))?.meta.scope).toBe('repo');
  });

  it('rewrites an inherited branch page inside its own slice', async () => {
    const projectRoot = tmpDir('vocs-mem-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const branchRoot = path.join(wiki, 'branches', 'vocscode-feature');
    const store = new KnowledgeStore();
    const branchScope: KnowledgeScope = { projectRoot, cwd: projectRoot, branch: 'vocscode/feature' };
    await store.write(branchScope, pageMeta({ id: 'conventions/branch-only', title: 'Branch note', claim: 'A claim only this branch has.', scope: 'branch', branch: 'vocscode/feature' }), 'branch body');

    const { request } = start(wiki, { VOCS_MEMORY_BRANCH_ROOT: branchRoot, VOCS_MEMORY_BRANCH: 'vocscode/feature' });
    const propose = await request({
      method: 'tools/call',
      params: { name: 'knowledge_propose', arguments: { title: 'Branch note', claim: 'A claim only this branch has.', kind: 'convention', page_id: 'conventions/branch-only', body: 'updated body' } }
    });
    expect((JSON.parse(toolText(propose)) as { scope: string }).scope).toBe('branch');

    // The update stays in the branch slice: no repo-scope twin, and the branch copy is the new body.
    expect(await fs.readFile(path.join(branchRoot, 'conventions', 'branch-only.md'), 'utf8')).toContain('updated body');
    await expect(fs.access(path.join(wiki, 'conventions', 'branch-only.md'))).rejects.toThrow();
  });

  it.each(['Only the main process may create or kill a PTY.', 'ONLY THE MAIN process may create or kill a PTY!'])('refuses a tombstoned claim and writes nothing (%s)', async (refiled) => {
    const projectRoot = tmpDir('vocs-mem-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    await fs.mkdir(wiki, { recursive: true });
    const claim = 'Only the main process may create or kill a PTY.';
    await fs.writeFile(path.join(wiki, '_rejected.json'), JSON.stringify({ [claimKey(claim)]: { claim, at: new Date().toISOString() } }), 'utf8');
    const { request } = start(wiki);
    const propose = await request({
      method: 'tools/call',
      params: { name: 'knowledge_propose', arguments: { title: 'Renderer never owns a PTY', claim: refiled, kind: 'convention', body: 'body' } }
    });
    const result = JSON.parse(toolText(propose)) as { rejected?: boolean; saved?: boolean };
    expect(result.rejected).toBe(true);
    expect(result.saved).toBe(false);
    // Nothing was written: the kind directory was never created.
    await expect(fs.access(path.join(wiki, 'convention'))).rejects.toThrow();
  });

  it('updates the page a page_id already names instead of duplicating it', async () => {
    const projectRoot = tmpDir('vocs-mem-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    await fs.mkdir(path.join(wiki, 'conventions'), { recursive: true });
    const store = new KnowledgeStore();
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    await store.write(
      scope,
      pageMeta({ id: 'conventions/custom-id', title: 'Existing page', claim: 'The first claim.', labels: ['alpha'], createdAt: '2020-01-01T00:00:00.000Z' }),
      'original body'
    );
    const { request } = start(wiki);
    const propose = await request({
      method: 'tools/call',
      params: {
        name: 'knowledge_propose',
        arguments: { title: 'Updated title', claim: 'A different claim.', kind: 'convention', page_id: 'conventions/custom-id', body: 'new body', labels: ['beta'] }
      }
    });
    expect((JSON.parse(toolText(propose)) as { targetPageId: string }).targetPageId).toBe('conventions/custom-id');

    const files = (await fs.readdir(path.join(wiki, 'conventions'))).filter((f) => f.endsWith('.md'));
    expect(files).toEqual(['custom-id.md']);
    const raw = await fs.readFile(path.join(wiki, 'conventions', 'custom-id.md'), 'utf8');
    expect(raw).toContain('created_at: 2020-01-01T00:00:00.000Z');

    // A fresh store sees the rewritten page: new claim/body, merged labels, original created_at.
    const page = await new KnowledgeStore().read(scope, 'conventions/custom-id');
    expect(page?.meta.claim).toBe('A different claim.');
    expect(page?.meta.labels).toEqual(['alpha', 'beta']);
    expect(page?.meta.createdAt).toBe('2020-01-01T00:00:00.000Z');
    expect(page?.body).toBe('new body');
  });

  it('surfaces a page that shares only a label with a lexical match', async () => {
    const projectRoot = tmpDir('vocs-mem-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const store = new KnowledgeStore();
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    await store.write(scope, pageMeta({ id: 'gotchas/alpha', title: 'Alpha fix', claim: 'Alpha thing.', keywords: ['alpha'], labels: ['pty'], anchors: [] }), 'alpha body');
    await store.write(scope, pageMeta({ id: 'gotchas/beta', title: 'Beta fix', claim: 'Beta thing.', keywords: ['beta'], labels: ['pty'], anchors: [] }), 'beta body');
    const { request } = start(wiki);
    const search = await request({ method: 'tools/call', params: { name: 'knowledge_search', arguments: { query: 'alpha' } } });
    const payload = JSON.parse(toolText(search)) as { results: { id: string; degree?: number }[] };
    const ids = payload.results.map((r) => r.id);
    expect(ids).toContain('gotchas/alpha');
    // Beta matches no query term and is pulled in only by the shared `pty` label edge.
    expect(ids).toContain('gotchas/beta');
    expect(payload.results.find((r) => r.id === 'gotchas/beta')?.degree).toBe(1);
  });

  it('reports the edge type that connects two related pages', async () => {
    const projectRoot = tmpDir('vocs-mem-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const store = new KnowledgeStore();
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    await store.write(scope, pageMeta({ id: 'concepts/left', title: 'Left', claim: 'Left claim.', labels: ['auth'], anchors: [{ file: 'a.ts' }] }), 'left');
    await store.write(scope, pageMeta({ id: 'concepts/right', title: 'Right', claim: 'Right claim.', labels: ['auth'], anchors: [{ file: 'b.ts' }] }), 'right');
    const { request } = start(wiki);
    const related = await request({ method: 'tools/call', params: { name: 'knowledge_related', arguments: { page: 'concepts/left' } } });
    const payload = JSON.parse(toolText(related)) as { page: string; related: { id: string; title: string; edge: string }[] };
    expect(payload.page).toBe('concepts/left');
    expect(payload.related).toContainEqual({ id: 'concepts/right', title: 'Right', edge: 'label' });
  });

  it('rejects a page that does not exist with a usable error', async () => {
    const projectRoot = tmpDir('vocs-mem-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    await fs.mkdir(wiki, { recursive: true });
    const { request } = start(wiki);
    const read = await request({ method: 'tools/call', params: { name: 'knowledge_read', arguments: { page: 'missing/page' } } });
    expect((read.result as { isError?: boolean }).isError).toBe(true);
    expect(toolText(read)).toContain('knowledge_search');
  });
});

describe('session history recall', () => {
  function session(id: string, projectRoot: string, over: Partial<SessionMeta> = {}): SessionMeta {
    return {
      id,
      title: `Session ${id}`,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      config: { harness: 'native', permissionMode: 'ask', projectRoot },
      cwd: projectRoot,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
      ...over
    } as SessionMeta;
  }

  /** Builds a real search.db through the app's own index, then closes it for the server to read. */
  async function seedIndex(): Promise<{ userData: string; wiki: string; projectRoot: string }> {
    const userData = tmpDir('vocs-mem-ud-');
    const projectRoot = tmpDir('vocs-mem-proj-');
    const otherRoot = tmpDir('vocs-mem-other-');
    const store = new SessionStore(userData);
    await store.load();
    await store.upsert(session('s_a', projectRoot));
    await store.upsert(session('s_b', otherRoot));
    await store.upsert(session('s_c', projectRoot, { archived: true }));
    const search = new SearchIndex(userData, { store, log: () => undefined });
    await search.init();
    search.syncMeta(store.list());
    search.indexItem('s_a', { id: 'u1', kind: 'user', ts: 1_700_000_000_001, text: 'the PTY reconnect duplicates tabs; key sk-abcdefghijklmnopqrstuvwx' });
    search.indexItem('s_b', { id: 'u1', kind: 'assistant', ts: 1_700_000_000_002, text: 'PTY reconnect handled in the other project' });
    search.indexItem('s_c', { id: 'u1', kind: 'user', ts: 1_700_000_000_003, text: 'PTY reconnect note in an archived session' });
    search.flushNow();
    search.close();
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    await fs.mkdir(wiki, { recursive: true });
    return { userData, wiki, projectRoot };
  }

  it('returns only this project, redacts secrets, and skips archived sessions', async () => {
    const { userData, wiki, projectRoot } = await seedIndex();
    const { request } = start(wiki, { VOCS_MEMORY_USER_DATA: userData, VOCS_MEMORY_PROJECT_ROOT: projectRoot });
    const call = await request({ method: 'tools/call', params: { name: 'session_history_search', arguments: { query: 'PTY reconnect' } } });
    const payload = JSON.parse(toolText(call)) as { available: boolean; count: number; results: { sessionId: string; kind: string; snippet: string }[] };
    expect(payload.available).toBe(true);
    expect(payload.results.map((r) => r.sessionId)).toEqual(['s_a']);
    expect(payload.results[0].snippet).toContain('<secret>');
    expect(payload.results[0].snippet).not.toContain('sk-abcdefghijklmnopqrst');

    const archived = await request({ method: 'tools/call', params: { name: 'session_history_search', arguments: { query: 'PTY reconnect', include_archived: true } } });
    const withArchived = JSON.parse(toolText(archived)) as { results: { sessionId: string }[] };
    expect(withArchived.results.map((r) => r.sessionId).sort()).toEqual(['s_a', 's_c']);
  });

  it('serves nothing rather than every project when the app gave it no project scope', async () => {
    const { userData, wiki } = await seedIndex();
    // VOCS_MEMORY_ROOT is the wiki this server reads; the project scope is deliberately absent, as
    // it would be for a session the app did not attribute to a project.
    const { request } = start(wiki, { VOCS_MEMORY_USER_DATA: userData });
    const call = await request({ method: 'tools/call', params: { name: 'session_history_search', arguments: { query: 'PTY reconnect' } } });
    const payload = JSON.parse(toolText(call)) as { available: boolean; reason?: string; results?: unknown[] };
    expect(payload.available).toBe(false);
    expect(payload.results ?? []).toHaveLength(0);
  });

  it('degrades to an explanation when the app has no index yet', async () => {
    const projectRoot = tmpDir('vocs-mem-proj-');
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    await fs.mkdir(wiki, { recursive: true });
    const { request } = start(wiki, { VOCS_MEMORY_USER_DATA: tmpDir('vocs-mem-empty-'), VOCS_MEMORY_PROJECT_ROOT: projectRoot });
    const call = await request({ method: 'tools/call', params: { name: 'session_history_search', arguments: { query: 'anything' } } });
    const payload = JSON.parse(toolText(call)) as { available: boolean; reason?: string };
    expect(payload.available).toBe(false);
    expect(payload.reason).toContain('unavailable');
  });
});
