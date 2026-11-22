/**
 * The memory ledger: typed, scoped, stateful records in one app-owned SQLite file
 * (`<userData>/intelligence/memory.db`), with an FTS5 index kept in step by triggers.
 *
 * What lives here is what a project wiki must not hold: episodes and lessons from past work,
 * verified procedures, declared preferences and records promoted into a collection. A wiki page is
 * never copied into this file as a second editable version — markdown stays the wiki's only source
 * of truth, and a promoted page is stored here as a cited snapshot, not as the page.
 *
 * Three properties are enforced in SQL rather than by the callers:
 *
 *   scope before search   every read takes a `MemoryVisibility` and turns it into the WHERE clause,
 *                         so a row outside the caller's project, branch, session and granted
 *                         collections is never fetched, let alone filtered afterwards.
 *   forget means gone     deletes the record and its FTS entries in one transaction, leaving a
 *                         tombstone hash so the same statement is not re-captured. Secure delete
 *                         reduces remnants in the ledger; it does not erase backups or transcripts.
 *   state is checked      transitions go through the shared state machine, and every change of
 *                         state or scope leaves an audit row that never contains the content.
 *
 * node:sqlite is optional exactly as it is for session search: without it the ledger reports itself
 * unavailable and every caller degrades to the wiki and session history. No Electron imports.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  DEFAULT_EPISODE_TTL_DAYS,
  MEMORY_KINDS,
  VERIFICATION_METHODS,
  evidenceKey,
  isExpired,
  isRecallableState,
  isMemoryScope,
  isMemoryState,
  isMemoryType,
  transitionProblem,
  type EvidenceSource,
  type IntelligenceAuditEntry,
  type MemoryKind,
  type MemoryRecord,
  type MemoryRecordInput,
  type MemoryScope,
  type MemoryState,
  type MemoryType,
  type MemoryVerification
} from '../../shared/intelligence';
import { errorMessage } from '../util/async';

const require_ = createRequire(import.meta.url);

type Database = InstanceType<typeof import('node:sqlite').DatabaseSync>;

const DatabaseSync: typeof import('node:sqlite').DatabaseSync | null = (() => {
  try {
    return require_('node:sqlite').DatabaseSync;
  } catch {
    return null;
  }
})();

const MAX_TITLE = 200;
const MAX_TEXT = 8_000;
const MAX_SOURCES = 24;
const MAX_AUDIT_ROWS = 4_000;
const MAX_LIST = 500;

/** Everything a caller may see, decided before any row is read. */
export interface MemoryVisibility {
  projectId: string;
  /** Branch-scope records surface only for a session on that branch. */
  branch?: string;
  /** Session-scope records surface only for that session. */
  sessionId?: string;
  /** Collections the project is a member of; their records are visible. */
  collectionIds: string[];
  /** Current authors allowed in each granted collection (if supplied, enforced before FTS ranking). */
  collectionProjects?: Record<string, string[]>;
  /** Personal records are served only when the user turned that on. */
  personal: boolean;
}

export interface MemoryFilter {
  states?: MemoryState[];
  types?: MemoryType[];
  scopes?: MemoryScope[];
  /** Include records whose `expiresAt` has passed. Off by default: expired is history. */
  includeExpired?: boolean;
  limit?: number;
}

export interface MemorySearchHit {
  record: MemoryRecord;
  /** bm25 rank mapped to 0..1 within the result set (1 = best). */
  score: number;
  snippet: string;
  /** True when only some of the query terms matched. */
  partial: boolean;
}

export interface MemoryStoreDeps {
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  now?: () => number;
}

interface Row {
  id: string;
  projectId: string | null;
  type: string;
  kind: string;
  scope: string;
  state: string;
  title: string;
  text: string;
  branch: string | null;
  sessionId: string | null;
  collectionId: string | null;
  origin: string;
  confidence: string | null;
  data: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

interface RowData {
  sources?: EvidenceSource[];
  verification?: MemoryVerification;
  supersedes?: string[];
  supersededBy?: string;
  promotedFrom?: MemoryRecord['promotedFrom'];
}

function clip(value: string, max: number): string {
  const text = value.replace(/\u0000/g, '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function cleanSources(sources: EvidenceSource[] | undefined): EvidenceSource[] {
  const out: EvidenceSource[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || typeof s.ref !== 'string' || !s.ref.trim() || typeof s.type !== 'string') continue;
    const key = `${s.type}\u0000${s.ref}\u0000${s.revision ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: s.type,
      ref: clip(s.ref, 400),
      ...(typeof s.note === 'string' && s.note ? { note: clip(s.note, 300) } : {}),
      ...(typeof s.revision === 'string' && s.revision ? { revision: clip(s.revision, 80) } : {}),
      ...(typeof s.projectId === 'string' && s.projectId ? { projectId: s.projectId } : {})
    });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

type ScopeAddress = Pick<MemoryRecordInput, 'scope' | 'branch' | 'sessionId' | 'collectionId'>;

function normalizedText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim() || text.trim();
}

/** A content hash within the exact scope, never the content itself. */
export function memoryTombstoneKey(projectId: string | null, text: string, address: ScopeAddress = {}): string {
  const scope = address.scope ?? (projectId ? 'project' : 'personal');
  const key = scope === 'branch' ? address.branch : scope === 'session' ? address.sessionId : scope === 'collection' ? address.collectionId : null;
  return createHash('sha256').update(JSON.stringify([projectId, scope, key, normalizedText(text)])).digest('hex');
}

/**
 * A safe FTS5 MATCH expression from free text: every term quoted so operators cannot be injected.
 * `all` joins with AND; `any` with OR, for a natural-language question where no row holds every word.
 */
export function memoryMatchQuery(terms: string[], mode: 'all' | 'any'): string | null {
  const quoted = terms.filter((t) => t.length > 1).slice(0, 12).map((t) => `"${t.replace(/"/g, '""')}"`);
  if (!quoted.length) return null;
  return quoted.join(mode === 'all' ? ' ' : ' OR ');
}

export class MemoryStore {
  private db: Database | null = null;
  private failure: string | null = null;
  readonly file: string;

  constructor(
    dir: string,
    private readonly deps: MemoryStoreDeps
  ) {
    this.file = path.join(dir, 'memory.db');
  }

  get available(): boolean {
    return this.db !== null;
  }

  /** Why the ledger is unavailable, for the panel; null while it is open. */
  get reason(): string | null {
    return this.db ? null : (this.failure ?? 'The memory ledger has not been opened.');
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  init(): void {
    if (this.db) return;
    if (!DatabaseSync) {
      this.failure = 'node:sqlite is unavailable in this runtime.';
      this.deps.log('warn', `intelligence: ${this.failure} Memory records are disabled.`);
      return;
    }
    let db: Database | null = null;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      db = new DatabaseSync(this.file);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      // A forgotten record's bytes are overwritten, not left in a free page.
      db.exec('PRAGMA secure_delete = ON');
      db.exec(`
        CREATE TABLE IF NOT EXISTS records (
          rowid INTEGER PRIMARY KEY,
          id TEXT UNIQUE NOT NULL,
          projectId TEXT,
          type TEXT NOT NULL,
          kind TEXT NOT NULL,
          scope TEXT NOT NULL,
          state TEXT NOT NULL,
          title TEXT NOT NULL,
          text TEXT NOT NULL,
          branch TEXT,
          sessionId TEXT,
          collectionId TEXT,
          origin TEXT NOT NULL,
          confidence TEXT,
          data TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          expiresAt TEXT
        );
        CREATE INDEX IF NOT EXISTS records_project ON records(projectId, scope, state);
        CREATE INDEX IF NOT EXISTS records_session ON records(sessionId);
        CREATE INDEX IF NOT EXISTS records_collection ON records(collectionId);
        CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
          title, text, content='records', content_rowid='rowid', tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
          INSERT INTO records_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
          INSERT INTO records_fts(records_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
          INSERT INTO records_fts(records_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
          INSERT INTO records_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
        END;
        CREATE TABLE IF NOT EXISTS tombstones (
          key TEXT PRIMARY KEY,
          at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY,
          at TEXT NOT NULL,
          action TEXT NOT NULL,
          actor TEXT NOT NULL,
          projectId TEXT,
          ref TEXT,
          detail TEXT
        );
        CREATE INDEX IF NOT EXISTS audit_project ON audit(projectId, id);
      `);
      // SQLite's PRAGMA doesn't by itself remove old terms from FTS segment data.
      db.exec("INSERT INTO records_fts(records_fts, rank) VALUES ('secure-delete', 1)");
      this.db = db;
      this.failure = null;
    } catch (e) {
      db?.close();
      this.db = null;
      this.failure = `The memory ledger could not be opened: ${errorMessage(e)}`;
      this.deps.log('warn', `intelligence: ${this.failure}`);
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = null;
  }

  private open(): Database {
    if (!this.db) throw new Error(this.reason ?? 'The memory ledger is unavailable.');
    return this.db;
  }

  /* ------------------------------------------------------------------ */
  /* Visibility                                                         */
  /* ------------------------------------------------------------------ */

  /** The WHERE fragment for what a caller may see; the only place scope is turned into SQL. */
  private visible(v: MemoryVisibility, alias = ''): { sql: string; args: Array<string | number> } {
    const c = alias ? `${alias}.` : '';
    const parts: string[] = [`(${c}scope = 'project' AND ${c}projectId = ?)`];
    const args: Array<string | number> = [v.projectId];
    if (v.branch) {
      parts.push(`(${c}scope = 'branch' AND ${c}projectId = ? AND ${c}branch = ?)`);
      args.push(v.projectId, v.branch);
    }
    if (v.sessionId) {
      parts.push(`(${c}scope = 'session' AND ${c}projectId = ? AND ${c}sessionId = ?)`);
      args.push(v.projectId, v.sessionId);
    }
    if (v.collectionIds.length) {
      const authors = v.collectionProjects ? ` AND EXISTS (SELECT 1 FROM json_each(?) grants JOIN json_each(grants.value) authors WHERE grants.key = ${c}collectionId AND authors.value = ${c}projectId)` : '';
      parts.push(`(${c}scope = 'collection' AND ${c}collectionId IN (${v.collectionIds.map(() => '?').join(',')})${authors})`);
      args.push(...v.collectionIds);
      if (v.collectionProjects) args.push(JSON.stringify(v.collectionProjects));
    }
    if (v.personal) parts.push(`(${c}scope = 'personal')`);
    return { sql: `(${parts.join(' OR ')})`, args };
  }

  private filterSql(filter: MemoryFilter, alias = ''): { sql: string; args: Array<string | number> } {
    const c = alias ? `${alias}.` : '';
    const parts: string[] = [];
    const args: Array<string | number> = [];
    const inList = (column: string, values: readonly string[] | undefined): void => {
      if (!values?.length) return;
      parts.push(`${c}${column} IN (${values.map(() => '?').join(',')})`);
      args.push(...values);
    };
    inList('state', filter.states);
    inList('type', filter.types);
    inList('scope', filter.scopes);
    if (!filter.includeExpired) {
      parts.push(`(${c}expiresAt IS NULL OR ${c}expiresAt > ?)`);
      args.push(new Date(this.now()).toISOString());
    }
    return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', args };
  }

  /* ------------------------------------------------------------------ */
  /* Reading                                                            */
  /* ------------------------------------------------------------------ */

  /** One record by id, only if the caller may see it. */
  get(id: string, visibility: MemoryVisibility): MemoryRecord | null {
    const db = this.open();
    const scope = this.visible(visibility);
    const row = db.prepare(`SELECT * FROM records WHERE id = ? AND ${scope.sql}`).get(id, ...scope.args) as Row | undefined;
    return row ? this.toRecord(row) : null;
  }

  /** One record by id with no visibility check — for the app's own panel and maintenance only. */
  getAny(id: string): MemoryRecord | null {
    const row = this.open().prepare('SELECT * FROM records WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toRecord(row) : null;
  }

  list(visibility: MemoryVisibility, filter: MemoryFilter = {}): MemoryRecord[] {
    const db = this.open();
    const scope = this.visible(visibility);
    const extra = this.filterSql(filter);
    const limit = Math.max(1, Math.min(filter.limit ?? 200, MAX_LIST));
    const rows = db.prepare(`SELECT * FROM records WHERE ${scope.sql}${extra.sql} ORDER BY updatedAt DESC LIMIT ?`).all(...scope.args, ...extra.args, limit) as unknown as Row[];
    return rows.map((row) => this.toRecord(row));
  }

  /**
   * Full-text recall inside the caller's visibility. Every term must match first; when nothing
   * does, any term may, and those hits are marked partial so the caller can say so.
   */
  search(visibility: MemoryVisibility, terms: string[], filter: MemoryFilter = {}): MemorySearchHit[] {
    const db = this.open();
    const scope = this.visible(visibility, 'r');
    const extra = this.filterSql(filter, 'r');
    const limit = Math.max(1, Math.min(filter.limit ?? 12, 60));
    const run = (mode: 'all' | 'any'): Array<Row & { rank: number; snip: string }> => {
      const match = memoryMatchQuery(terms, mode);
      if (!match) return [];
      return db
        .prepare(
          `SELECT r.*, bm25(records_fts, 4.0, 1.0) AS rank, snippet(records_fts, 1, char(1), char(2), char(8230), 24) AS snip
           FROM records_fts JOIN records r ON r.rowid = records_fts.rowid
           WHERE records_fts MATCH ? AND ${scope.sql}${extra.sql}
           ORDER BY rank LIMIT ?`
        )
        .all(match, ...scope.args, ...extra.args, limit) as unknown as Array<Row & { rank: number; snip: string }>;
    };
    let partial = false;
    let rows = run('all');
    if (!rows.length && terms.length > 1) {
      rows = run('any');
      partial = rows.length > 0;
    }
    if (!rows.length) return [];
    // bm25 is "more negative is better"; map onto 0..1 so providers can be compared.
    const best = Math.min(...rows.map((r) => r.rank));
    const worst = Math.max(...rows.map((r) => r.rank));
    return rows.map((row) => ({
      record: this.toRecord(row),
      score: (worst === best ? 1 : 0.4 + 0.6 * ((worst - row.rank) / (worst - best))) * (partial ? 0.6 : 1),
      snippet: row.snip,
      partial
    }));
  }

  /** Records a session produced, across scopes — used when that session is deleted. */
  forSession(sessionId: string): MemoryRecord[] {
    const rows = this.open().prepare('SELECT * FROM records WHERE sessionId = ?').all(sessionId) as unknown as Row[];
    return rows.map((row) => this.toRecord(row));
  }

  /** Promoted copies of a record, in whatever scope they were promoted to. */
  derivedFrom(recordId: string): MemoryRecord[] {
    if (!/^mem_[0-9a-z]+$/.test(recordId)) return [];
    const rows = this.open().prepare(`SELECT * FROM records WHERE data LIKE ?`).all(`%"recordId":"${recordId}"%`) as unknown as Row[];
    return rows.map((row) => this.toRecord(row)).filter((r) => r.promotedFrom?.recordId === recordId);
  }

  count(visibility: MemoryVisibility): number {
    const scope = this.visible(visibility);
    const row = this.open().prepare(`SELECT COUNT(*) AS n FROM records WHERE ${scope.sql}`).get(...scope.args) as { n: number };
    return row.n;
  }

  /* ------------------------------------------------------------------ */
  /* Writing                                                            */
  /* ------------------------------------------------------------------ */

  isTombstoned(projectId: string | null, text: string, address: ScopeAddress = {}): boolean {
    // Existing ledgers used one project-wide hash of the first 240 normalized characters.
    const legacy = createHash('sha256').update(`${projectId ?? 'personal'}\u0000${evidenceKey(text)}`).digest('hex');
    return !!this.open().prepare('SELECT 1 FROM tombstones WHERE key IN (?, ?)').get(memoryTombstoneKey(projectId, text, address), legacy);
  }

  private tombstone(record: MemoryRecord): void {
    this.open().prepare('INSERT OR REPLACE INTO tombstones(key, at) VALUES (?, ?)').run(memoryTombstoneKey(record.projectId, record.text, record), new Date(this.now()).toISOString());
  }

  private transaction<T>(write: () => T): T {
    const db = this.open();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = write();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Stores a record. Returns null when the same text was forgotten or rejected before: a tombstone
   * refuses the capture rather than letting a job refile it every session. The same statement in
   * the same scope updates the existing record's evidence instead of creating a twin.
   */
  create(projectId: string | null, input: MemoryRecordInput, origin: string): MemoryRecord | null {
    const db = this.open();
    const title = clip(input.title, MAX_TITLE);
    const text = clip(input.text, MAX_TEXT);
    if (!title || !text) throw new Error('A memory record needs a title and text.');
    if (!isMemoryType(input.type)) throw new Error('Unknown memory type.');
    const scope: MemoryScope = input.scope ?? 'project';
    if (!isMemoryScope(scope)) throw new Error('Unknown memory scope.');
    if (scope === 'personal') projectId = null;
    else if (!projectId) throw new Error('Only personal records exist without a project.');
    if (scope === 'collection' && !input.collectionId) throw new Error('A collection record needs its collection.');
    if (scope === 'branch' && !input.branch) throw new Error('A branch record needs its branch.');
    if (scope === 'session' && !input.sessionId) throw new Error('A session record needs its session.');
    const state: MemoryState = input.state ?? 'candidate';
    if (!isMemoryState(state)) throw new Error('Unknown memory state.');
    if (state === 'verified' && (!input.verification || !VERIFICATION_METHODS.includes(input.verification.method))) throw new Error('A verified record needs recorded verification.');
    if (origin.startsWith('agent:') && (state === 'active' || state === 'verified' || input.verification || scope === 'collection' || scope === 'personal' || input.type === 'preference')) {
      throw new Error('An agent capture cannot assert verified authority or create shared or personal memory.');
    }
    if (this.isTombstoned(projectId, text, { ...input, scope })) return null;
    const kind: MemoryKind = input.kind && (MEMORY_KINDS as readonly string[]).includes(input.kind) ? input.kind : 'note';
    const stamp = new Date(this.now()).toISOString();
    const sources = cleanSources(input.sources);
    const twin = this.findTwin(projectId, scope, text, { ...input, kind });
    if (twin) {
      // Repeating a claim cannot change its authority or mutate human-reviewed evidence.
      if (origin.startsWith('agent:') && (twin.origin === 'human' || twin.verification?.method === 'human-review')) return twin;
      const merged = cleanSources([...twin.sources, ...sources]);
      if (origin === 'human' && input.verification?.method === 'human-review' && twin.state !== 'verified') {
        const reviewed = this.transition(twin.id, 'verified', 'human', { verification: input.verification });
        return this.write({ ...reviewed, sources: merged });
      }
      return this.write({ ...twin, sources: merged, updatedAt: stamp });
    }
    // Unverified episodic memory fades on its own; everything else stays until someone changes it.
    const expiresAt = input.expiresAt ?? (input.type === 'episodic' && state !== 'verified' ? new Date(this.now() + DEFAULT_EPISODE_TTL_DAYS * 86_400_000).toISOString() : undefined);
    const record: MemoryRecord = {
      id: `mem_${this.now().toString(36)}${randomBytes(5).toString('hex')}`,
      projectId,
      type: input.type,
      kind,
      scope,
      state,
      title,
      text,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(scope === 'collection' && input.collectionId ? { collectionId: input.collectionId } : {}),
      sources,
      origin,
      ...(input.confidence ? { confidence: input.confidence } : {}),
      ...(input.verification ? { verification: input.verification } : {}),
      ...(input.supersedes?.length ? { supersedes: input.supersedes.slice(0, 12) } : {}),
      ...(input.promotedFrom ? { promotedFrom: input.promotedFrom } : {}),
      createdAt: stamp,
      updatedAt: stamp,
      ...(expiresAt ? { expiresAt } : {})
    };
    db.prepare(
      `INSERT INTO records(id, projectId, type, kind, scope, state, title, text, branch, sessionId, collectionId, origin, confidence, data, createdAt, updatedAt, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...this.toParams(record));
    return record;
  }

  private findTwin(projectId: string | null, scope: MemoryScope, text: string, input: MemoryRecordInput): MemoryRecord | null {
    const key = normalizedText(text);
    const branch = scope === 'branch' ? input.branch ?? null : null;
    const session = scope === 'session' || input.kind === 'episode' ? input.sessionId ?? null : null;
    const collection = scope === 'collection' ? input.collectionId ?? null : null;
    const rows = this.open()
      .prepare(`SELECT * FROM records
                WHERE scope = ? AND projectId IS ? AND type = ? AND kind = ? AND state NOT IN ('revoked', 'rejected', 'superseded', 'expired')
                  AND (expiresAt IS NULL OR expiresAt > ?)
                  AND (? IS NULL OR branch = ?) AND (? IS NULL OR sessionId = ?) AND (? IS NULL OR collectionId = ?)
                ORDER BY updatedAt DESC LIMIT 400`)
      .all(scope, projectId, input.type, input.kind ?? 'note', new Date(this.now()).toISOString(), branch, branch, session, session, collection, collection) as unknown as Row[];
    for (const row of rows) {
      if (normalizedText(row.text) !== key) continue;
      const record = this.toRecord(row);
      const from = record.promotedFrom;
      const source = input.promotedFrom;
      if (from?.projectId !== source?.projectId || from?.recordId !== source?.recordId || from?.pageId !== source?.pageId) continue;
      // A promoted copy must match the exact preview, not an equivalent normalized statement.
      if (source && (record.title !== clip(input.title, MAX_TITLE) || record.text !== text)) continue;
      return record;
    }
    return null;
  }

  private write(record: MemoryRecord): MemoryRecord {
    const params = this.toParams(record);
    this.open()
      .prepare(
        `UPDATE records SET projectId = ?, type = ?, kind = ?, scope = ?, state = ?, title = ?, text = ?, branch = ?, sessionId = ?, collectionId = ?, origin = ?, confidence = ?, data = ?, createdAt = ?, updatedAt = ?, expiresAt = ?
         WHERE id = ?`
      )
      .run(...params.slice(1), record.id);
    return record;
  }

  /** Edits the user-correctable fields of a record; state and scope change only through their own methods. */
  update(id: string, patch: { title?: string; text?: string; sources?: EvidenceSource[]; expiresAt?: string | null; confidence?: MemoryRecord['confidence'] }, actor: string): MemoryRecord | null {
    const current = this.getAny(id);
    if (!current) return null;
    const next: MemoryRecord = { ...current, updatedAt: new Date(this.now()).toISOString() };
    if (patch.title !== undefined) {
      const title = clip(patch.title, MAX_TITLE);
      if (!title) throw new Error('A memory record needs a title.');
      next.title = title;
    }
    if (patch.text !== undefined) {
      const text = clip(patch.text, MAX_TEXT);
      if (!text) throw new Error('A memory record needs text.');
      // Changed content is a different claim: whatever verified the old one no longer applies.
      if (text !== current.text) {
        if (!isRecallableState(current.state)) throw new Error('Only a live record can be edited.');
        if (this.isTombstoned(current.projectId, text, current)) throw new Error('That text was forgotten or rejected.');
        delete next.verification;
        if (next.state === 'verified' || next.state === 'active') next.state = 'candidate';
      }
      next.text = text;
    }
    if (patch.sources) next.sources = cleanSources(patch.sources);
    if (patch.confidence) next.confidence = patch.confidence;
    if (patch.expiresAt === null) delete next.expiresAt;
    else if (patch.expiresAt) next.expiresAt = patch.expiresAt;
    this.transaction(() => {
      this.write(next);
      if (current.text !== next.text || current.title !== next.title) this.revokeDerived(current.id, actor);
    });
    this.audit({ action: 'memory.update', actor, projectId: next.projectId ?? undefined, ref: id });
    return next;
  }

  /** Moves a record through the state machine; throws with the reason when the move is not allowed. */
  transition(id: string, to: MemoryState, actor: 'human' | 'agent', opts: { verification?: MemoryVerification; supersededBy?: string; by?: string } = {}): MemoryRecord {
    const current = this.getAny(id);
    if (!current) throw new Error('No such memory record.');
    if (!isMemoryState(to)) throw new Error('Unknown memory state.');
    if (opts.verification && (to !== 'verified' || !VERIFICATION_METHODS.includes(opts.verification.method))) throw new Error('Invalid verification for this transition.');
    if (actor === 'agent' && (to === 'active' || current.scope === 'collection' || current.scope === 'personal' || current.origin === 'human' || current.verification?.method === 'human-review')) {
      throw new Error('Only the user can change that authority or scope.');
    }
    const candidate: MemoryRecord = opts.verification ? { ...current, verification: opts.verification } : current;
    const problem = transitionProblem(candidate, to, actor);
    if (problem) throw new Error(problem);
    const next: MemoryRecord = { ...candidate, state: to, updatedAt: new Date(this.now()).toISOString() };
    if (to === 'superseded' && opts.supersededBy) next.supersededBy = opts.supersededBy;
    // A verified record is a lesson worth keeping; an episode's default expiry no longer applies.
    if (to === 'verified') delete next.expiresAt;
    // Reviving an expired record clears the date that expired it, or it would expire again on read.
    if (current.state === 'expired' && to !== 'revoked') delete next.expiresAt;
    if (to === 'expired') next.expiresAt = next.updatedAt;
    this.transaction(() => {
      if (next.promotedFrom && to === 'revoked') this.open().prepare('DELETE FROM records WHERE id = ?').run(id);
      else this.write(next);
      if (to === 'rejected' || to === 'revoked') this.tombstone(next);
      if (to === 'uncertain' || to === 'rejected' || to === 'revoked' || to === 'expired' || to === 'superseded') this.revokeDerived(id, actor);
    });
    this.audit({ action: `memory.${to}`, actor: opts.by ?? actor, projectId: next.projectId ?? undefined, ref: id, detail: `${current.state} → ${to}${opts.verification ? ` (${opts.verification.method})` : ''}` });
    return next;
  }

  /**
   * Deletes a record for good and tombstones its text, so the same statement cannot be re-captured.
   * True only when a row was actually removed.
   */
  forget(id: string, actor: string): boolean {
    return this.forgetWithDerived(id, actor).forgotten;
  }

  forgetWithDerived(id: string, actor: string): { forgotten: boolean; derived: number } {
    const db = this.open();
    const removed = this.transaction(() => {
      const current = this.getAny(id);
      if (!current) return [];
      const records = [current, ...this.derivedFrom(id)];
      const drop = db.prepare('DELETE FROM records WHERE id = ?');
      for (const record of records) {
        drop.run(record.id);
        this.tombstone(record);
      }
      return records;
    });
    for (const record of removed) this.audit({ action: 'memory.forget', actor, projectId: record.projectId ?? undefined, ref: record.id, detail: `${record.scope} ${record.type}` });
    if (removed.length) {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (e) {
        this.deps.log('debug', `intelligence: memory checkpoint deferred: ${errorMessage(e)}`);
      }
    }
    return { forgotten: removed.length > 0, derived: Math.max(0, removed.length - 1) };
  }

  /** Invalidate and remove the indexed snapshot in the same transaction as the source change. */
  private revokeDerived(id: string, actor: string): void {
    const drop = this.open().prepare('DELETE FROM records WHERE id = ?');
    for (const copy of this.derivedFrom(id)) {
      drop.run(copy.id);
      this.audit({ action: 'memory.revoke-derived', actor, projectId: copy.projectId ?? undefined, ref: copy.id });
    }
  }

  /** A rejected/deleted wiki page no longer backs any live shared snapshot. */
  retireWikiPromotions(projectId: string, pageId: string): void {
    const db = this.open();
    const copies = db.prepare(`SELECT id FROM records WHERE scope IN ('collection', 'personal')
      AND json_extract(data, '$.promotedFrom.projectId') = ? AND json_extract(data, '$.promotedFrom.pageId') = ?`)
      .all(projectId, pageId) as Array<{ id: string }>;
    if (!copies.length) return;
    this.transaction(() => {
      const drop = db.prepare('DELETE FROM records WHERE id = ?');
      for (const { id } of copies) drop.run(id);
    });
    this.audit({ action: 'promotion.retire-wiki', actor: 'human', projectId, ref: pageId, detail: `${copies.length} snapshot(s)` });
  }

  /** Removes rows without a tombstone: the cleanup for a deleted session's unverified leftovers. */
  purge(ids: string[], actor: string, reason: string): number {
    const db = this.open();
    let removed = 0;
    for (const id of ids) {
      const current = this.getAny(id);
      if (!current) continue;
      db.prepare('DELETE FROM records WHERE id = ?').run(id);
      removed++;
      this.audit({ action: 'memory.purge', actor, projectId: current.projectId ?? undefined, ref: id, detail: reason });
    }
    return removed;
  }

  /** Records carried in an export bundle; ids are kept, an existing id is left untouched. */
  importRecords(projectId: string, records: MemoryRecord[], actor: string): { imported: number; skipped: number } {
    const db = this.open();
    let imported = 0;
    let skipped = 0;
    for (const raw of records) {
      if (!raw || typeof raw.id !== 'string' || !/^mem_[0-9a-z]+$/.test(raw.id) || !isMemoryType(raw.type) || !isMemoryState(raw.state) || !isRecallableState(raw.state)
        || (raw.scope !== 'project' && (raw.scope !== 'branch' || typeof raw.branch !== 'string' || !raw.branch))) {
        skipped++;
        continue;
      }
      // Imports stay inside the project they are imported into; a bundle cannot widen scope.
      const scope = raw.scope;
      const title = typeof raw.title === 'string' ? clip(raw.title, MAX_TITLE) : '';
      const text = typeof raw.text === 'string' ? clip(raw.text, MAX_TEXT) : '';
      if (!title || !text || db.prepare('SELECT 1 FROM records WHERE id = ?').get(raw.id) || this.isTombstoned(projectId, text, raw)) {
        skipped++;
        continue;
      }
      const stamp = new Date(this.now()).toISOString();
      const record: MemoryRecord = {
        id: raw.id,
        projectId,
        type: raw.type,
        kind: (MEMORY_KINDS as readonly string[]).includes(raw.kind) ? raw.kind : 'note',
        scope,
        // A verification made elsewhere is evidence, not something this install checked.
        state: raw.state === 'verified' || raw.state === 'active' ? 'candidate' : raw.state,
        title,
        text,
        ...(scope === 'branch' && raw.branch ? { branch: raw.branch } : {}),
        sources: cleanSources(raw.sources),
        origin: 'import',
        ...(raw.confidence ? { confidence: raw.confidence } : {}),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : stamp,
        updatedAt: stamp,
        ...(typeof raw.expiresAt === 'string' ? { expiresAt: raw.expiresAt } : {})
      };
      db.prepare(
        `INSERT INTO records(id, projectId, type, kind, scope, state, title, text, branch, sessionId, collectionId, origin, confidence, data, createdAt, updatedAt, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...this.toParams(record));
      imported++;
    }
    this.audit({ action: 'memory.import', actor, projectId, detail: `${imported} imported, ${skipped} skipped` });
    return { imported, skipped };
  }

  /** Drops every record of a deleted collection: nothing may keep serving a scope that is gone. */
  removeCollection(collectionId: string, actor: string): number {
    const db = this.open();
    const result = db.prepare(`DELETE FROM records WHERE scope = 'collection' AND collectionId = ?`).run(collectionId);
    const removed = Number(result.changes ?? 0);
    if (removed) this.audit({ action: 'collection.remove-records', actor, ref: collectionId, detail: `${removed} record(s)` });
    return removed;
  }

  /* ------------------------------------------------------------------ */
  /* Audit                                                              */
  /* ------------------------------------------------------------------ */

  /** Who changed authority or scope, and when — never what the record said. */
  audit(entry: Omit<IntelligenceAuditEntry, 'at'>): void {
    if (!this.db) return;
    try {
      this.db
        .prepare('INSERT INTO audit(at, action, actor, projectId, ref, detail) VALUES (?, ?, ?, ?, ?, ?)')
        .run(new Date(this.now()).toISOString(), entry.action, entry.actor, entry.projectId ?? null, entry.ref ?? null, entry.detail ? clip(entry.detail, 300) : null);
      this.db.prepare('DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - ?').run(MAX_AUDIT_ROWS);
    } catch (e) {
      this.deps.log('debug', `intelligence: audit write failed: ${errorMessage(e)}`);
    }
  }

  auditTrail(projectId: string, limit = 40): IntelligenceAuditEntry[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare('SELECT at, action, actor, projectId, ref, detail FROM audit WHERE projectId = ? OR projectId IS NULL ORDER BY id DESC LIMIT ?')
      .all(projectId, Math.max(1, Math.min(limit, 200))) as Array<{ at: string; action: string; actor: string; projectId: string | null; ref: string | null; detail: string | null }>;
    return rows.map((r) => ({ at: r.at, action: r.action, actor: r.actor, ...(r.projectId ? { projectId: r.projectId } : {}), ...(r.ref ? { ref: r.ref } : {}), ...(r.detail ? { detail: r.detail } : {}) }));
  }

  /* ------------------------------------------------------------------ */
  /* Row mapping                                                        */
  /* ------------------------------------------------------------------ */

  private toParams(record: MemoryRecord): Array<string | null> {
    const data: RowData = {
      sources: record.sources,
      ...(record.verification ? { verification: record.verification } : {}),
      ...(record.supersedes?.length ? { supersedes: record.supersedes } : {}),
      ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
      ...(record.promotedFrom ? { promotedFrom: record.promotedFrom } : {})
    };
    return [
      record.id,
      record.projectId,
      record.type,
      record.kind,
      record.scope,
      record.state,
      record.title,
      record.text,
      record.branch ?? null,
      record.sessionId ?? null,
      record.collectionId ?? null,
      record.origin,
      record.confidence ?? null,
      JSON.stringify(data),
      record.createdAt,
      record.updatedAt,
      record.expiresAt ?? null
    ];
  }

  private toRecord(row: Row): MemoryRecord {
    let data: RowData = {};
    try {
      data = JSON.parse(row.data) as RowData;
    } catch {
      data = {};
    }
    const record: MemoryRecord = {
      id: row.id,
      projectId: row.projectId,
      type: isMemoryType(row.type) ? row.type : 'episodic',
      kind: (MEMORY_KINDS as readonly string[]).includes(row.kind) ? (row.kind as MemoryKind) : 'note',
      scope: isMemoryScope(row.scope) ? row.scope : 'project',
      state: isMemoryState(row.state) ? row.state : 'candidate',
      title: row.title,
      text: row.text,
      ...(row.branch ? { branch: row.branch } : {}),
      ...(row.sessionId ? { sessionId: row.sessionId } : {}),
      ...(row.collectionId ? { collectionId: row.collectionId } : {}),
      sources: Array.isArray(data.sources) ? data.sources : [],
      origin: row.origin,
      ...(row.confidence === 'low' || row.confidence === 'medium' || row.confidence === 'high' ? { confidence: row.confidence } : {}),
      ...(data.verification ? { verification: data.verification } : {}),
      ...(data.supersedes?.length ? { supersedes: data.supersedes } : {}),
      ...(data.supersededBy ? { supersededBy: data.supersededBy } : {}),
      ...(data.promotedFrom ? { promotedFrom: data.promotedFrom } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {})
    };
    // Expiry is read-time: a record past its date reports itself expired without a sweeper.
    if (record.state !== 'expired' && isExpired(record, this.now()) && record.state !== 'revoked' && record.state !== 'rejected') record.state = 'expired';
    return record;
  }
}
