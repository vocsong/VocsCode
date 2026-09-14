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
import { SearchIndex } from '../src/main/search';
import { SessionStore } from '../src/main/store';
import { serializeKnowledgeDocument } from '../src/shared/knowledge';
import type { KnowledgePageMeta, KnowledgeScope } from '../src/shared/knowledge';
import type { SessionMeta } from '../src/shared/types';

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

function start(root: string, extraEnv: Record<string, string> = {}): { child: ChildProcessWithoutNullStreams; request: (message: Record<string, unknown>) => Promise<Rpc> } {
  const child = spawn(process.execPath, [script], { env: { ...process.env, VOCS_MEMORY_ROOT: root, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  it('lists its five tools and searches pages the app wrote', async () => {
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

  it('writes proposals the app can read back', async () => {
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
          sources: [{ type: 'file', ref: 'src/main/terminal.ts' }],
          anchors: [{ file: 'src/main/terminal.ts' }]
        }
      }
    });
    const result = JSON.parse(toolText(propose)) as { id: string; status: string };
    expect(result.status).toBe('proposed');

    const store = new KnowledgeStore();
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const proposals = await store.proposals(scope);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].meta.title).toBe('Renderer never owns a PTY');
    expect(proposals[0].meta.claim).toBe('Only the main process may create or kill a PTY.');
    expect(proposals[0].meta.kind).toBe('convention');
    expect(proposals[0].meta.targetPageId).toBe('convention/renderer-never-owns-a-pty');
    expect(proposals[0].meta.sources[0]).toEqual({ type: 'file', ref: 'src/main/terminal.ts' });
    expect(proposals[0].body).toContain('re-attaches to snapshots');
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
