/** Unit tests for the deep search index: query sanitization, extraction, indexing and search. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ftsQuery, itemText, SearchIndex } from '../src/main/search';
import { SessionStore } from '../src/main/store';
import type { SearchCategory, SessionMeta, TranscriptItem } from '../src/shared/types';

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

function gate() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
}

/** Observe completion without making production init blocking or replacing any rebuild work. */
function watchBackfill(index: SearchIndex) {
  return vi.spyOn(index as unknown as { backfill(): Promise<void> }, 'backfill');
}

async function expectRestart(dir: string, hits: [q: string, id: string][], rebuilds: string[] = []): Promise<void> {
  const store = new SessionStore(dir);
  await store.load();
  const index = new SearchIndex(dir, { store, log: () => undefined });
  const reads = vi.spyOn(store, 'readTranscript');
  const backfill = watchBackfill(index);
  try {
    await index.init();
    await backfill.mock.results[0].value;
    expect(reads.mock.calls).toEqual(rebuilds.map((id) => [id]));
    for (const [q, id] of hits) expect(index.search({ q }).results.map((r) => r.itemId)).toEqual([id]);
  } finally {
    index.close();
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
  it('does not let a boot-racing append certify the unindexed history', async () => {
    const { dir, store, index } = setup();
    const id = 'boot-race';
    const old = user('historic marmot');
    const appended = assistant('new ocelot');
    await store.upsert(meta(id));
    await store.appendTranscript(id, old);

    const statEntered = gate();
    const resumeStat = gate();
    const realStat = fs.stat.bind(fs);
    const stat = vi.spyOn(fs, 'stat').mockImplementationOnce(async (...args) => {
      statEntered.release();
      await resumeStat.reached;
      return realStat(...args);
    });
    const reads = vi.spyOn(store, 'readTranscript');
    const backfill = watchBackfill(index);
    try {
      await index.init();
      expect(index.available).toBe(true);
      await statEntered.reached;
      await store.appendTranscript(id, appended);
      index.flushNow();
      expect(index.search({ q: 'ocelot' }).results.map((r) => r.itemId)).toEqual([appended.id]);
      expect(index.search({ q: 'marmot' }).results).toEqual([]);
      // Let any append-triggered stat and its SQLite write finish before boot can sample the file.
      await Promise.all(stat.mock.results.slice(1).map((r) => r.value));
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      resumeStat.release();
      await backfill.mock.results[0]?.value;
      stat.mockRestore();
    }

    expect(index.search({ q: 'marmot' }).results.map((r) => r.itemId)).toEqual([old.id]);
    expect(index.search({ q: 'ocelot' }).results.map((r) => r.itemId)).toEqual([appended.id]);
    expect(reads.mock.calls).toEqual([[id]]);
    index.close();
    await expectRestart(dir, [['marmot', old.id], ['ocelot', appended.id]]);
  });

  it('preserves a newer flushed upsert when an older rebuild snapshot lands', async () => {
    const { dir, store, index } = setup();
    const id = 'snapshot-race';
    const old = user('historic marmot');
    const original = assistant('stale ocelot');
    const updated = { ...assistant('updated capybara'), id: original.id };
    await store.upsert(meta(id));
    await store.appendTranscript(id, old);
    await store.appendTranscript(id, original);

    const snapshotCaptured = gate();
    const resumeSnapshot = gate();
    const readTranscript = store.readTranscript.bind(store);
    const reads = vi.spyOn(store, 'readTranscript').mockImplementationOnce(async (id) => {
      const snapshot = await readTranscript(id);
      snapshotCaptured.release();
      await resumeSnapshot.reached;
      return snapshot;
    });
    const backfill = watchBackfill(index);
    try {
      await index.init();
      expect(index.available).toBe(true);
      await snapshotCaptured.reached;
      await store.appendTranscript(id, updated);
      index.flushNow();
    } finally {
      resumeSnapshot.release();
      await backfill.mock.results[0]?.value;
    }

    expect(index.search({ q: 'ocelot' }).results).toEqual([]);
    expect(index.search({ q: 'capybara' }).results.map((r) => r.itemId)).toEqual([updated.id]);
    expect(reads.mock.calls).toEqual([[id]]);
    index.close();
    const hits: [string, string][] = [['marmot', old.id], ['capybara', updated.id]];
    // The changed file gets one conservative revalidation; truly unchanged boots skip it.
    await expectRestart(dir, hits, [id]);
    await expectRestart(dir, hits);
  });

  it('reuses the complete index for a new session on its first warm boot', async () => {
    const { dir, store, index } = setup();
    await index.init();
    const id = 'new-session';
    const item = user('new session woodpecker');
    await store.upsert(meta(id));
    await store.appendTranscript(id, item);
    const persisted = gate();
    const stat = fs.stat.bind(fs);
    const spy = vi.spyOn(fs, 'stat').mockImplementationOnce(async (...args) => {
      const result = await stat(...args);
      setImmediate(persisted.release);
      return result;
    });
    try {
      index.flushNow();
      expect(spy).toHaveBeenCalledTimes(1);
      await persisted.reached;
    } finally { spy.mockRestore(); }
    index.close();
    await expectRestart(dir, [['woodpecker', item.id]]);
  });

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

  it('isolates session names, goals, messages and tool output before applying limits', async () => {
    const { store, index } = setup2();
    const goal = { objective: 'needle milestone', status: 'active', createdAt: 1, updatedAt: 1, iterations: 0, maxIterations: 1, autoContinue: false } as const;
    await store.upsert(meta('name', { title: 'needle cleanup' }));
    await store.upsert(meta('goal', { title: 'Follow-up', goal }));
    await store.upsert(meta('context', { statusLabel: 'needle' }));
    await store.upsert(meta('body'));
    for (let i = 0; i < 45; i++) await store.upsert(meta(`archived-${i}`, { title: 'needle', archived: true }));
    index.syncMeta(store.list());

    // Enough highly ranked tool matches to displace all messages in an unfiltered body query.
    for (let i = 0; i < 410; i++) index.indexItem('body', tool('Read', 'needle needle needle', 'code.ts', i));
    const prompt = user('I need to look up the needle in this transcript.');
    const reply = assistant('I found the needle in the conversation.');
    index.indexItem('body', prompt);
    index.indexItem('body', reply);
    index.indexItem('body', { id: 'info', kind: 'info', ts: 1, level: 'info', text: 'needle' });
    index.flushNow();

    const q = 'needl*';
    const find = (category: SearchCategory, limit?: number) =>
      index.search({ q, filters: { category }, limit }).results;
    expect(find('title', 1)).toEqual([expect.objectContaining({ sessionId: 'name', snippet: '\u0001needle\u0002 cleanup' })]);
    expect(find('goal')).toEqual([expect.objectContaining({ sessionId: 'goal', snippet: '\u0001needle\u0002 milestone' })]);
    expect(find('transcript').map((r) => r.itemId).sort()).toEqual([prompt.id, reply.id].sort());
    expect(find('tool', 1)).toEqual([expect.objectContaining({ kind: 'tool', sessionId: 'body' })]);
    expect(find('all', 1)).toHaveLength(1);
    expect(find('all').some((r) => r.sessionId === 'context')).toBe(true);
    expect(index.search({ q, filters: { category: 'title', archived: true }, limit: 50 }).results).toHaveLength(46);
  });

  it('upgrades a legacy metadata index without rebuilding a covered transcript', async () => {
    const { dir, store, index } = setup();
    const session = meta('legacy', { title: 'Actual session name' });
    const prompt = user('Preserved transcript');
    await store.upsert(session);
    await store.appendTranscript(session.id, prompt);
    const backfill = watchBackfill(index);
    await index.init();
    await backfill.mock.results[0].value;
    index.close();

    // Put back the pre-category schema, without touching transcript rows or coverage.
    const db = new DatabaseSync(path.join(dir, 'search.db'));
    try {
      db.exec(`
        DROP TABLE session_meta;
        DROP TABLE meta_fts;
        CREATE TABLE session_meta (id INTEGER PRIMARY KEY, sessionId TEXT UNIQUE NOT NULL, text TEXT NOT NULL);
        CREATE VIRTUAL TABLE meta_fts USING fts5(text, content='session_meta', content_rowid='id', tokenize='porter unicode61');
        CREATE TRIGGER meta_ai AFTER INSERT ON session_meta BEGIN
          INSERT INTO meta_fts(rowid, text) VALUES (new.id, new.text);
        END;
        INSERT INTO session_meta(sessionId, text) VALUES ('legacy', 'obsolete title /repo');
      `);
    } finally { db.close(); }

    const failed = new SearchIndex(dir, { store, log: () => undefined });
    vi.spyOn(failed, 'syncMeta').mockImplementationOnce(() => { throw new Error('simulated metadata rebuild failure'); });
    await failed.init();
    expect(failed.available).toBe(false);
    const legacyDb = new DatabaseSync(path.join(dir, 'search.db'), { readOnly: true });
    try {
      expect(legacyDb.prepare('SELECT text FROM session_meta WHERE sessionId = ?').get(session.id)).toMatchObject({ text: 'obsolete title /repo' });
    } finally { legacyDb.close(); }

    const upgraded = new SearchIndex(dir, { store, log: () => undefined });
    const reads = vi.spyOn(store, 'readTranscript');
    const restartBackfill = watchBackfill(upgraded);
    try {
      await upgraded.init();
      await restartBackfill.mock.results[0].value;
      expect(reads).not.toHaveBeenCalled();
      expect(upgraded.search({ q: 'actual', filters: { category: 'title' } }).results).toEqual([
        expect.objectContaining({ sessionId: session.id, kind: 'meta' })
      ]);
      expect(upgraded.search({ q: 'obsolete' }).results).toEqual([]);
      expect(upgraded.search({ q: 'preserved', filters: { category: 'transcript' } }).results).toEqual([
        expect.objectContaining({ sessionId: session.id, itemId: prompt.id })
      ]);
    } finally { upgraded.close(); }
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
