/** Deep session search: an FTS5 index (node:sqlite) over transcript items and session meta.
 *
 * The index is derived state: `sessions/<id>/transcript.jsonl` stays the source of truth, and
 * deleting search.db just triggers a rebuild on the next boot. Text per transcript item is
 * extracted (user/assistant text, tool name/summary/output, info lines); titles, status labels,
 * project roots and goal objectives go into a second, title-boosted tier.
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SearchFilters, SearchResponse, SearchResult, SessionMeta, TranscriptItem } from '../shared/types';

const require_ = createRequire(import.meta.url);

/** node:sqlite is experimental-but-present on Node 22+; degrade to a disabled search when missing. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DatabaseSync: typeof import('node:sqlite').DatabaseSync | null = (() => {
  try {
    return require_('node:sqlite').DatabaseSync;
  } catch {
    return null;
  }
})();

/** Per-item text cap: tool output can be megabytes; search does not need all of it. */
const MAX_ITEM_TEXT = 50_000;
/** Debounce for incremental transcript appends before they hit the index. */
const FLUSH_MS = 400;

export interface SearchStore {
  list(): SessionMeta[];
  get(id: string): SessionMeta | undefined;
  readTranscript(id: string): Promise<TranscriptItem[]>;
  sessionDir(id: string): string;
  transcriptWritePending(id: string): boolean;
}

export interface SearchIndexDeps {
  store: SearchStore;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Builds the searchable text for one transcript item. Kinds that never carry user-meaningful
 * prose (turn footers, approval cards, plan state) are skipped.
 */
export function itemText(item: TranscriptItem): { kind: SearchResult['kind']; text: string } | null {
  switch (item.kind) {
    case 'user':
      return { kind: 'user', text: item.text };
    case 'assistant':
      return { kind: 'assistant', text: item.text };
    case 'tool':
      return { kind: 'tool', text: [item.name, item.title, item.summary, item.output].filter((t): t is string => !!t).join('\n') };
    case 'info':
      return { kind: 'info', text: item.text };
    default:
      return null;
  }
}

/** The per-session meta row: title, label, root and goal, searched as the top tier. */
export function metaText(s: SessionMeta): string {
  return [s.title, s.statusLabel, s.config.projectRoot, s.goal?.objective].filter((t): t is string => !!t && t.length > 0).join('\n');
}

/**
 * Turns free user input into a safe FTS5 MATCH expression: every term is quoted (so FTS syntax
 * characters cannot inject operators or throw), joined implicitly with AND. A trailing `*` on a
 * term becomes a prefix search.
 */
export function ftsQuery(q: string): string | null {
  const terms = q.trim().split(/\s+/).slice(0, 12);
  const out: string[] = [];
  for (const term of terms) {
    const prefix = term.endsWith('*');
    const core = prefix ? term.slice(0, -1) : term;
    if (!core) continue;
    out.push(`"${core.replace(/"/g, '""')}"${prefix ? '*' : ''}`);
    if (out.length >= 8) break;
  }
  return out.length ? out.join(' ') : null;
}

type TranscriptCoverage = {
  validated: boolean;
  version: number;
  loading?: boolean;
  /** Latest appends received while the disk snapshot is in flight. */
  replay?: Map<string, TranscriptItem>;
};

export class SearchIndex {
  private db: InstanceType<typeof import('node:sqlite').DatabaseSync> | null = null;
  /** Queued item upserts per session, drained on a debounce. */
  private pending = new Map<string, Map<string, TranscriptItem>>();
  /** Rewrites and removals invalidate the identity held by in-flight reads and stats. */
  private coverage = new Map<string, TranscriptCoverage>();
  /** Sessions whose transcript changed wholesale (rewrite/clear); re-synced from disk. */
  private resync = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private statements = new Map<string, unknown>();

  constructor(
    private readonly userData: string,
    private readonly deps: SearchIndexDeps
  ) {}

  get available(): boolean {
    return this.db !== null;
  }

  /** Opens the database and kicks off (non-blocking) backfill of not-yet-indexed transcripts. */
  async init(): Promise<void> {
    if (!DatabaseSync) {
      this.deps.log('warn', 'node:sqlite unavailable; deep session search is disabled');
      return;
    }
    try {
      this.db = new DatabaseSync(path.join(this.userData, 'search.db'));
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS items (
          id INTEGER PRIMARY KEY,
          sessionId TEXT NOT NULL,
          itemId TEXT NOT NULL,
          kind TEXT NOT NULL,
          ts INTEGER NOT NULL,
          text TEXT NOT NULL,
          UNIQUE(sessionId, itemId)
        );
        CREATE INDEX IF NOT EXISTS items_session ON items(sessionId);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
          text, content='items', content_rowid='id', tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
          INSERT INTO fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
          INSERT INTO fts(fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
          INSERT INTO fts(fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TABLE IF NOT EXISTS session_meta (
          id INTEGER PRIMARY KEY,
          sessionId TEXT UNIQUE NOT NULL,
          text TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS meta_fts USING fts5(
          text, content='session_meta', content_rowid='id', tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS meta_ai AFTER INSERT ON session_meta BEGIN
          INSERT INTO meta_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS meta_ad AFTER DELETE ON session_meta BEGIN
          INSERT INTO meta_fts(meta_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS meta_au AFTER UPDATE ON session_meta BEGIN
          INSERT INTO meta_fts(meta_fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO meta_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TABLE IF NOT EXISTS files (
          sessionId TEXT PRIMARY KEY,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
      `);
    } catch (e) {
      this.db = null;
      this.deps.log('warn', `search index failed to open: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // Backfill runs in the background; the window must not wait on a first-run full scan.
    void this.backfill();
  }

  close(): void {
    this.flushNow();
    this.db?.close();
    this.db = null;
  }

  // -- incremental updates -------------------------------------------------

  /** Queues one transcript item (last write wins per item id); drained on a debounce. */
  indexItem(sessionId: string, item: TranscriptItem): void {
    if (!this.db) return;
    let coverage = this.coverage.get(sessionId);
    if (!coverage) {
      // Existing transcripts are registered before startup backfill yields. A new session has
      // no older items to validate; imports and forks explicitly enter via resyncSession.
      coverage = { validated: !this.resync.has(sessionId), version: 0 };
      this.coverage.set(sessionId, coverage);
    }
    coverage.version++;
    if (!itemText(item)) return;
    let byId = this.pending.get(sessionId);
    if (!byId) {
      byId = new Map();
      this.pending.set(sessionId, byId);
    }
    byId.set(item.id, item);
    coverage.replay?.set(item.id, item);
    this.scheduleFlush();
  }

  /** A transcript was rewritten (clear, fork); re-sync that session from disk after a beat. */
  resyncSession(sessionId: string): void {
    if (!this.db) return;
    this.pending.delete(sessionId);
    this.coverage.delete(sessionId);
    this.stmt('DELETE FROM files WHERE sessionId = ?').run(sessionId);
    this.resync.add(sessionId);
    this.scheduleFlush();
  }

  /** Session deleted: drop everything indexed for it. */
  dropSession(sessionId: string): void {
    if (!this.db) return;
    this.pending.delete(sessionId);
    this.coverage.delete(sessionId);
    this.resync.delete(sessionId);
    this.db.prepare('DELETE FROM items WHERE sessionId = ?').run(sessionId);
    this.db.prepare('DELETE FROM session_meta WHERE sessionId = ?').run(sessionId);
    this.db.prepare('DELETE FROM files WHERE sessionId = ?').run(sessionId);
  }

  /** Keeps the meta tier in sync with the current session list (called on every pushSessions). */
  syncMeta(list: SessionMeta[]): void {
    if (!this.db) return;
    const upsert = this.stmt(
      'INSERT INTO session_meta(sessionId, text) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET text = excluded.text'
    );
    const alive = new Set<string>();
    for (const s of list) {
      alive.add(s.id);
      const text = metaText(s);
      const row = this.stmt('SELECT text FROM session_meta WHERE sessionId = ?').get(s.id) as { text: string } | undefined;
      if (!row || row.text !== text) upsert.run(s.id, text);
    }
    // Meta rows for deleted sessions go too.
    for (const r of this.db.prepare('SELECT sessionId FROM session_meta').all() as { sessionId: string }[]) {
      if (!alive.has(r.sessionId)) this.db.prepare('DELETE FROM session_meta WHERE sessionId = ?').run(r.sessionId);
    }
  }

  // -- querying ------------------------------------------------------------

  search({ q, filters, limit }: { q: string; filters?: SearchFilters; limit?: number }): SearchResponse {
    if (!this.db) return { available: false, results: [] };
    const match = ftsQuery(q ?? '');
    if (!match) return { available: true, results: [] };
    const cap = Math.min(limit ?? 60, 200);
    const scope = this.sessionScope(filters);
    if (scope.size === 0) return { available: true, results: [] };
    const results: SearchResult[] = [];
    if (scope.size === 0) return { available: true, results: [] };

    // Tier 1: titles, labels, project roots, goals.
    const metaRows = this.db
      .prepare(
        `SELECT m.sessionId AS sessionId, snippet(meta_fts, 0, char(1), char(2), char(8230), 24) AS snip
         FROM meta_fts JOIN session_meta m ON m.id = meta_fts.rowid
         WHERE meta_fts MATCH ? ORDER BY bm25(meta_fts) LIMIT 40`
      )
      .all(match) as { sessionId: string; snip: string }[];
    for (const r of metaRows) {
      if (!scope.has(r.sessionId)) continue;
      const s = this.deps.store.get(r.sessionId);
      results.push({ sessionId: r.sessionId, kind: 'meta', ts: s?.updatedAt ?? 0, snippet: r.snip });
    }

    // Tier 2: transcript content, capped per session so one chatty session cannot drown the rest.
    const args: string[] = [match];
    const ids = [...scope];
    const scopeSql = ` AND i.sessionId IN (${ids.map(() => '?').join(',')})`;
    args.push(...ids);
    const bodyRows = this.db
      .prepare(
        `SELECT i.sessionId AS sessionId, i.itemId AS itemId, i.kind AS kind, i.ts AS ts,
                snippet(fts, 0, char(1), char(2), char(8230), 18) AS snip
         FROM fts JOIN items i ON i.id = fts.rowid
         WHERE fts MATCH ?${scopeSql}
         ORDER BY bm25(fts) LIMIT 400`
      )
      .all(...args) as { sessionId: string; itemId: string; kind: SearchResult['kind']; ts: number; snip: string }[];
    const perSession = new Map<string, number>();
    for (const r of bodyRows) {
      const n = perSession.get(r.sessionId) ?? 0;
      if (n >= 3) continue;
      perSession.set(r.sessionId, n + 1);
      results.push({ sessionId: r.sessionId, itemId: r.itemId, kind: r.kind, ts: r.ts, snippet: r.snip });
      if (results.length >= cap) break;
    }
    return { available: true, results };
  }

  /**
   * Transcript recall for the intelligence core: body rows only, restricted in SQL to the session
   * ids the caller already resolved as in scope, so a row from another project is never read.
   * Every term must match first; unless `strict`, a natural-language question nothing holds in full
   * falls back to any term, and those hits are flagged partial.
   */
  recall({ q, sessionIds, limit, strict }: { q: string; sessionIds: string[]; limit?: number; strict?: boolean }): { available: boolean; partial: boolean; results: SearchResult[] } {
    if (!this.db) return { available: false, partial: false, results: [] };
    const ids = [...new Set(sessionIds)].slice(0, 2000);
    const terms = (q ?? '')
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length > 1)
      .slice(0, 8);
    if (!ids.length || !terms.length) return { available: true, partial: false, results: [] };
    const cap = Math.min(Math.max(limit ?? 6, 1), 40);
    const db = this.db;
    const run = (match: string): SearchResult[] => {
      const rows = db
        .prepare(
          `SELECT i.sessionId AS sessionId, i.itemId AS itemId, i.kind AS kind, i.ts AS ts,
                  snippet(fts, 0, char(1), char(2), char(8230), 18) AS snip
           FROM fts JOIN items i ON i.id = fts.rowid
           WHERE fts MATCH ? AND i.sessionId IN (${ids.map(() => '?').join(',')})
           ORDER BY bm25(fts) LIMIT ?`
        )
        .all(match, ...ids, cap * 10) as { sessionId: string; itemId: string; kind: SearchResult['kind']; ts: number; snip: string }[];
      const perSession = new Map<string, number>();
      const out: SearchResult[] = [];
      for (const r of rows) {
        const n = perSession.get(r.sessionId) ?? 0;
        if (n >= 3) continue;
        perSession.set(r.sessionId, n + 1);
        out.push({ sessionId: r.sessionId, itemId: r.itemId, kind: r.kind, ts: r.ts, snippet: r.snip });
        if (out.length >= cap) break;
      }
      return out;
    };
    const quoted = terms.map((t) => `"${t.replace(/"/g, '""')}"`);
    try {
      const all = run(quoted.join(' '));
      if (all.length || terms.length < 2 || strict) return { available: true, partial: false, results: all };
      const any = run(quoted.join(' OR '));
      return { available: true, partial: any.length > 0, results: any };
    } catch (e) {
      this.deps.log('warn', `search recall failed: ${e instanceof Error ? e.message : String(e)}`);
      return { available: true, partial: false, results: [] };
    }
  }

  /** The set of session ids a query may touch; archived sessions stay out unless opted in. */
  private sessionScope(filters?: SearchFilters): Set<string> {
    const f = filters;
    return new Set(
      this.deps.store
        .list()
        .filter((s) => (f?.archived ? true : !s.archived))
        .filter((s) => !f?.harness || s.config.harness === f.harness)
        .filter((s) => !f?.projectRoot || s.config.projectRoot === f.projectRoot)
        .map((s) => s.id)
    );
  }

  // -- internals -----------------------------------------------------------

  private stmt(sql: string) {
    let st = this.statements.get(sql);
    if (!st) {
      st = this.db!.prepare(sql);
      this.statements.set(sql, st);
    }
    return st as ReturnType<InstanceType<typeof import('node:sqlite').DatabaseSync>['prepare']>;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, FLUSH_MS);
  }

  /** Drains queued appends and resyncs; also refreshes the mtime/size coverage rows. */
  flushNow(): void {
    if (!this.db) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const id of this.resync) void this.syncSessionFromDisk(id);
    this.resync.clear();
    const db = this.db;
    for (const [sessionId, byId] of this.pending) {
      const coverage = this.coverage.get(sessionId);
      try {
        db.exec('BEGIN');
        this.upsertItems(sessionId, byId.values());
        db.exec('COMMIT');
        if (coverage?.validated) this.recordCoverage(sessionId, coverage);
      } catch (e) {
        if (coverage) coverage.validated = false;
        try {
          db.exec('ROLLBACK');
        } catch {
          /* no open transaction */
        }
        this.deps.log('warn', `search index flush failed for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.pending.clear();
  }

  private upsertItems(sessionId: string, items: Iterable<TranscriptItem>): void {
    const upsert = this.stmt(
      `INSERT INTO items(sessionId, itemId, kind, ts, text) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sessionId, itemId) DO UPDATE SET kind = excluded.kind, ts = excluded.ts, text = excluded.text`
    );
    for (const item of items) {
      const t = itemText(item);
      if (t) upsert.run(sessionId, item.id, t.kind, item.ts, t.text.slice(0, MAX_ITEM_TEXT));
    }
  }

  /** Validates an existing stamp or reindexes the transcript from disk. */
  private async syncSessionFromDisk(sessionId: string): Promise<void> {
    const db = this.db;
    if (!db) return;
    const coverage = this.coverage.get(sessionId) ?? { validated: false, version: 0 };
    if (coverage.loading || coverage.validated) return;
    coverage.loading = true;
    this.coverage.set(sessionId, coverage);
    try {
      const file = path.join(this.deps.store.sessionDir(sessionId), 'transcript.jsonl');
      const st = await fsStat(file);
      if (!st || this.db !== db || this.coverage.get(sessionId) !== coverage) return;
      const covered = this.stmt('SELECT mtime, size FROM files WHERE sessionId = ?').get(sessionId) as { mtime: number; size: number } | undefined;
      if (covered && covered.mtime === st.mtimeMs && covered.size === st.size) {
        coverage.validated = true;
        return;
      }
      const version = coverage.version;
      const replay = coverage.replay = new Map<string, TranscriptItem>();
      const items = await this.deps.store.readTranscript(sessionId);
      if (this.db !== db || this.coverage.get(sessionId) !== coverage) return;
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM items WHERE sessionId = ?').run(sessionId);
        this.upsertItems(sessionId, items);
        // Restore later appends, including those already flushed while the read was in flight.
        if (replay.size) this.upsertItems(sessionId, replay.values());
        // Only the pre-read stat is known to be covered. Leave it stale if the file grew.
        this.stmt('INSERT OR REPLACE INTO files(sessionId, mtime, size) VALUES (?, ?, ?)').run(sessionId, st.mtimeMs, st.size);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      this.pending.delete(sessionId);
      coverage.validated = coverage.version === version;
    } catch (e) {
      this.deps.log('warn', `search resync failed for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      delete coverage.replay;
      delete coverage.loading;
    }
  }

  /** Remembers a transcript stat only for a validated, still-current append batch. */
  private recordCoverage(sessionId: string, coverage: TranscriptCoverage): void {
    if (this.deps.store.transcriptWritePending(sessionId)) return;
    const db = this.db;
    const version = coverage.version;
    void (async () => {
      try {
        const file = path.join(this.deps.store.sessionDir(sessionId), 'transcript.jsonl');
        const st = await fsStat(file);
        if (st && this.db === db && this.coverage.get(sessionId) === coverage && coverage.validated && coverage.version === version
          && !this.deps.store.transcriptWritePending(sessionId)) {
          this.stmt('INSERT OR REPLACE INTO files(sessionId, mtime, size) VALUES (?, ?, ?)').run(sessionId, st.mtimeMs, st.size);
        }
      } catch {
        // Coverage is an optimization only; next boot simply re-reads the session.
      }
    })();
  }

  /** Boot-time: index sessions missing or stale in the coverage table; drop deleted ones. */
  private async backfill(): Promise<void> {
    const db = this.db;
    if (!db) return;
    try {
      const alive = new Set(this.deps.store.list().map((s) => s.id));
      for (const id of alive) this.coverage.set(id, { validated: false, version: 0 });
      const known = db.prepare('SELECT sessionId FROM files').all() as { sessionId: string }[];
      for (const { sessionId } of known) {
        if (!alive.has(sessionId)) this.dropSession(sessionId);
      }
      for (const id of alive) {
        if (this.db !== db) return;
        if (this.deps.store.get(id) && !this.resync.has(id)) await this.syncSessionFromDisk(id);
      }
    } catch (e) {
      this.deps.log('warn', `search backfill failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function fsStat(file: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await fs.stat(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}
