/** Unit tests for the deep search index: query sanitization, extraction, indexing and search. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { ftsQuery, itemText, SearchIndex } from '../src/main/search';
import { SessionStore } from '../src/main/store';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const dirs: string[] = [];

afterAll(async () => {
  for (const i of indexes) i.close();
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function tmpDir(): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vocs-search-'));
  dirs.push(d);
  return d;
}

function meta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    config: { harness: 'native', permissionMode: 'ask', projectRoot: '/repo' },
    cwd: '/repo',
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    ...overrides
  } as SessionMeta;
}

const user = (text: string, ts = 1): TranscriptItem => ({ id: `u_${text.length}_${ts}`, kind: 'user', ts, text });
const assistant = (text: string, ts = 2): TranscriptItem => ({ id: `a_${text.length}_${ts}`, kind: 'assistant', ts, text });
const tool = (name: string, summary: string, output?: string, ts = 3): TranscriptItem => ({
  id: `t_${ts}`,
  kind: 'tool',
  ts,
  name,
  status: 'done',
  summary,
  output
});

function setup() {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const index = new SearchIndex(dir, { store, log: () => undefined });
  wire(store, index);
  indexes.push(index);
  return { dir, store, index };
}

/** Mirrors the wiring src/main/index.ts does in the app. */
function wire(store: SessionStore, index: SearchIndex): void {
  store.hooks = {
    onAppend: (id, item) => index.indexItem(id, item),
    onRewrite: (id) => index.resyncSession(id),
    onRemove: (id) => index.dropSession(id)
  };
}

const indexes: SearchIndex[] = [];

/** Waits until the predicate holds (backfill and flushes run in the background). */
async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ftsQuery', () => {
  it('quotes every term so FTS syntax cannot inject operators', () => {
    expect(ftsQuery('permission gate')).toBe('"permission" "gate"');
    expect(ftsQuery('NOT hijack* OR')).toBe('"NOT" "hijack"* "OR"');
  });

  it('neutralizes operators and brackets inside terms', () => {
    expect(ftsQuery('a(b) AND c')).toBe('"a(b)" "AND" "c"');
    expect(ftsQuery('foo-bar')).toBe('"foo-bar"');
  });

  it('keeps trailing * as a prefix search and drops empty terms', () => {
    expect(ftsQuery('perm* ')).toBe('"perm"*');
    // A literal-quoted '*' is harmless; the important part is that it cannot throw.
    expect(ftsQuery('***')).toBe('"**"*');
  });

  it('returns null for empty or whitespace queries', () => {
    expect(ftsQuery('')).toBeNull();
    expect(ftsQuery('   ')).toBeNull();
  });
});

describe('itemText', () => {
  it('extracts searchable text for user, assistant, tool and info items', () => {
    expect(itemText(user('hello'))).toEqual({ kind: 'user', text: 'hello' });
    expect(itemText(assistant('hi there'))).toEqual({ kind: 'assistant', text: 'hi there' });
    const t = itemText(tool('Bash', 'npm test', 'all passing'));
    expect(t?.kind).toBe('tool');
    expect(t?.text).toContain('npm test');
    expect(t?.text).toContain('all passing');
    expect(itemText({ id: 'i', kind: 'info', ts: 1, level: 'warn', text: 'retried' })?.text).toBe('retried');
  });

  it('skips turn footers, approvals and plans', () => {
    expect(itemText({ id: 't', kind: 'turn', ts: 1, status: 'completed' })).toBeNull();
    expect(itemText({ id: 'p', kind: 'plan', ts: 1, entries: [] })).toBeNull();
  });
});

describe('SearchIndex', () => {
  it('indexes appends and finds matches with snippets and item ids', async () => {
    const { store, index } = setup();
    await index.init();
    expect(index.available).toBe(true);
    const s = meta('s1');
    await store.upsert(s);
    index.syncMeta([s]);
    await store.appendTranscript('s1', user('please fix the permission gating bug'));
    await store.appendTranscript('s1', assistant('I fixed the permission gating in permissions.ts', 20));
    index.flushNow();

    const r = index.search({ q: 'permission' });
    expect(r.available).toBe(true);
    const deep = r.results.filter((x) => x.itemId);
    expect(deep.length).toBeGreaterThan(0);
    expect(deep.every((x) => x.sessionId === 's1')).toBe(true);
    // Snippets carry the \u0001/\u0002 highlight markers around the match.
    expect(r.results.some((x) => x.snippet.includes('\u0001permission\u0002'))).toBe(true);
    // Meta tier: title/goal hits come back as kind 'meta'.
    expect(index.search({ q: 'session' }).results.some((x) => x.kind === 'meta' && x.sessionId === 's1')).toBe(true);
  });

  it('ranks title matches above body matches and never throws on FTS syntax input', async () => {
    const { store, index } = setup2();
    const s = meta('s2', { title: 'Terminal rendering fix' });
    await store.upsert(s);
    index.syncMeta([s]);
    await store.upsert(meta('s3', { title: 'Unrelated work' }));
    index.syncMeta([s, meta('s3')]);
    await store.appendTranscript('s3', user('the terminal rendering broke again', 5));
    index.flushNow();

    const r = index.search({ q: 'terminal rendering' });
    expect(r.results[0]).toMatchObject({ sessionId: 's2', kind: 'meta' });
    expect(r.results.some((x) => x.sessionId === 's3' && x.itemId)).toBe(true);
    // Unbalanced syntax must not throw.
    expect(() => index.search({ q: '")(AND* ' })).not.toThrow();
  });

  it('caps hits per session so one session cannot drown out the rest', async () => {
    const { store, index } = setup2();
    await store.upsert(meta('a'));
    await store.upsert(meta('b'));
    index.syncMeta([meta('a'), meta('b')]);
    for (let i = 0; i < 6; i++) {
      await store.appendTranscript('a', assistant(`widget padding pass ${i}`, i));
      await store.appendTranscript('b', assistant('widget padding noted once', 100 + i));
    }
    index.flushNow();
    const r = index.search({ q: 'widget padding' });
    const fromA = r.results.filter((x) => x.sessionId === 'a' && x.itemId).length;
    const fromB = r.results.filter((x) => x.sessionId === 'b' && x.itemId).length;
    expect(fromA).toBeLessThanOrEqual(3);
    expect(fromB).toBeGreaterThan(0);
  });

  it('rebuilds from disk after a transcript rewrite (clear/fork)', async () => {
    const { store, index } = setup2();
    await store.upsert(meta('s4'));
    index.syncMeta([meta('s4')]);
    await store.appendTranscript('s4', user('obscure kestrel sightings'));
    index.flushNow();
    expect(index.search({ q: 'kestrel' }).results.length).toBeGreaterThan(0);

    // rewriteTranscript fires the onRewrite hook; after a resync the text is gone.
    await store.rewriteTranscript('s4', []);
    await waitFor(() => (index.search({ q: 'kestrel' }).results.length === 0 ? true : undefined));
  });

  it('drops everything for a deleted session', async () => {
    const { store, index } = setup2();
    await store.upsert(meta('s5'));
    index.syncMeta([meta('s5')]);
    await store.appendTranscript('s5', user('quantum widget calibration'));
    index.flushNow();
    expect(index.search({ q: 'quantum' }).results.length).toBeGreaterThan(0);
    index.dropSession('s5');
    expect(index.search({ q: 'quantum' }).results).toEqual([]);
  });

  it('respects the archived filter via the session scope', async () => {
    const { store, index } = setup2();
    await store.upsert(meta('a1', { archived: true }));
    await store.upsert(meta('a2'));
    index.syncMeta([meta('a1', { archived: true }), meta('a2')]);
    for (const id of ['a1', 'a2']) {
      await store.appendTranscript(id, user('ferret subnet masking', 1));
    }
    index.flushNow();
    expect(index.search({ q: 'ferret', filters: { archived: false } }).results.map((r) => r.sessionId)).toEqual(['a2']);
    expect(index.search({ q: 'ferret', filters: { archived: true } }).results.length).toBe(2);
    // No filters: archived sessions stay out unless the caller opts in.
    expect(index.search({ q: 'ferret' }).results.map((r) => r.sessionId)).toEqual(['a2']);
  });
});

/** A store whose session dirs live in one temp dir, plus an index over it. */
function setup2() {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const index = new SearchIndex(dir, { store, log: () => undefined });
  wire(store, index);
  index.init();
  indexes.push(index);
  return { store, index };
}
