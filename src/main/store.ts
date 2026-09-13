import path from 'node:path';
import type { SessionMeta, TranscriptItem } from '../shared/types';
import type { Logger } from './log';
import { appendLine, ensureDir, exists, readJson, readJsonl, rmrf, writeJson } from './util/fs';
import { promises as fs } from 'node:fs';

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

function assertValidSessionId(id: string): void {
  if (!isValidSessionId(id)) throw new Error('Invalid session ID');
}

/**
 * Persistence for session metadata and transcripts.
 * Layout under userData:
 *   sessions.json                      -> SessionMeta[]
 *   sessions/<id>/transcript.jsonl     -> TranscriptItem upserts (last write wins per id)
 *   sessions/<id>/native-history.json  -> native harness message history
 */
export class SessionStore {
  private readonly root: string;
  private readonly indexFile: string;
  private sessions: SessionMeta[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  /** One shared generation waiting to start, in addition to any in-flight snapshot. */
  private pendingIndexWrite: Promise<void> | null = null;
  /** Per-session transcript write chain: reads and rewrites wait for in-flight appends to land first. */
  private transcriptWrites = new Map<string, Promise<void>>();
  /** Optional observers (the search indexer); set after construction to avoid a dependency cycle. */
  hooks: { onAppend?: (sessionId: string, item: TranscriptItem) => void; onRewrite?: (sessionId: string) => void; onRemove?: (sessionId: string) => void } = {};
  private readonly log: Logger;

  constructor(userData: string, log: Logger = () => undefined) {
    this.root = path.join(userData, 'sessions');
    this.indexFile = path.join(userData, 'sessions.json');
    this.log = log;
  }

  async load(): Promise<SessionMeta[]> {
    await ensureDir(this.root);
    const loaded = await readJson<SessionMeta[]>(this.indexFile, [], { log: this.log });
    // A valid-JSON but wrong-shaped file must not abort boot; fall back to an empty index.
    if (!Array.isArray(loaded)) this.log('warn', `${this.indexFile} is not a session list; starting with no sessions`);
    this.sessions = Array.isArray(loaded)
      ? loaded.filter((s): s is SessionMeta => !!s && typeof s === 'object' && isValidSessionId(s.id))
      : [];
    const dropped = Array.isArray(loaded) ? loaded.length - this.sessions.length : 0;
    if (dropped) this.log('warn', `${this.indexFile}: dropped ${dropped} malformed session entr${dropped === 1 ? 'y' : 'ies'}`);
    // Any session that was running when the app closed is now idle.
    let reset = 0;
    for (const s of this.sessions) {
      if (s.status === 'running' || s.status === 'awaiting' || s.status === 'starting') {
        s.status = 'idle';
        reset++;
      }
      s.queued = 0;
    }
    this.log('info', `loaded ${this.sessions.length} session(s)${reset ? `; ${reset} were still running at the last shutdown and are now idle` : ''}`);
    return this.sessions;
  }

  list(): SessionMeta[] {
    return this.sessions;
  }

  get(id: string): SessionMeta | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  sessionDir(id: string): string {
    assertValidSessionId(id);
    return path.join(this.root, id);
  }

  async upsert(meta: SessionMeta): Promise<void> {
    assertValidSessionId(meta.id);
    const idx = this.sessions.findIndex((s) => s.id === meta.id);
    if (idx >= 0) this.sessions[idx] = meta;
    else this.sessions.unshift(meta);
    await this.flushIndex();
  }

  async remove(id: string): Promise<void> {
    assertValidSessionId(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    await this.flushIndex();
    await (this.transcriptWrites.get(id) ?? Promise.resolve()).catch(() => undefined);
    this.transcriptWrites.delete(id);
    await rmrf(this.sessionDir(id));
    this.hooks.onRemove?.(id);
  }

  private flushIndex(): Promise<void> {
    // Synchronous bursts and updates during a write share the next snapshot's promise.
    if (this.pendingIndexWrite) return this.pendingIndexWrite;
    const run = this.writeQueue.then(() => {
      this.pendingIndexWrite = null;
      // writeJson serializes after asynchronous filesystem work; detach nested mutable meta now.
      return writeJson(this.indexFile, structuredClone(this.sessions));
    });
    this.pendingIndexWrite = run;
    // Reject this generation's callers visibly, without blocking queued or future generations.
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  async appendTranscript(id: string, item: TranscriptItem): Promise<void> {
    const run = this.queueTranscriptWrite(id, () => appendLine(path.join(this.sessionDir(id), 'transcript.jsonl'), JSON.stringify(item)));
    await run;
    this.hooks.onAppend?.(id, item);
  }

  async readTranscript(id: string): Promise<TranscriptItem[]> {
    // A renderer can request the transcript right after a pushed event promised it an item;
    // without this wait the snapshot read can race the pending append and drop that item.
    await (this.transcriptWrites.get(id) ?? Promise.resolve());
    const rows = await readJsonl<TranscriptItem>(path.join(this.sessionDir(id), 'transcript.jsonl'), { log: this.log });
    // Collapse upserts: keep insertion order of first occurrence, latest content.
    const order: string[] = [];
    const byId = new Map<string, TranscriptItem>();
    for (const r of rows) {
      if (!byId.has(r.id)) order.push(r.id);
      byId.set(r.id, r);
    }
    return order.map((i) => byId.get(i) as TranscriptItem);
  }

  /** Rewrites the transcript file from a compacted item list (used after clear). */
  async rewriteTranscript(id: string, items: TranscriptItem[]): Promise<void> {
    const file = path.join(this.sessionDir(id), 'transcript.jsonl');
    // Behind the append chain: a pending append flushing after the rewrite would resurrect a cleared item.
    await this.queueTranscriptWrite(id, async () => {
      await ensureDir(path.dirname(file));
      await fs.writeFile(file, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''), 'utf8');
    });
    this.hooks.onRewrite?.(id);
  }

  /** Chains a transcript write behind the session's pending ones; the chain never rejects. */
  private queueTranscriptWrite<T>(id: string, run: () => Promise<T>): Promise<T> {
    const next = (this.transcriptWrites.get(id) ?? Promise.resolve()).then(run, run);
    this.transcriptWrites.set(id, next.then(() => undefined, () => undefined));
    return next;
  }

  async readNativeHistory<T>(id: string): Promise<T | null> {
    const file = path.join(this.sessionDir(id), 'native-history.json');
    if (!(await exists(file))) return null;
    return readJson<T | null>(file, null, { log: this.log });
  }

  async writeNativeHistory(id: string, history: unknown): Promise<void> {
    await writeJson(path.join(this.sessionDir(id), 'native-history.json'), history);
  }

  async readBlob(id: string, name: string): Promise<string | null> {
    const file = path.join(this.sessionDir(id), name);
    if (!(await exists(file))) return null;
    return fs.readFile(file, 'utf8');
  }

  async writeBlob(id: string, name: string, content: string): Promise<string> {
    const file = path.join(this.sessionDir(id), name);
    await ensureDir(path.dirname(file));
    await fs.writeFile(file, content, 'utf8');
    return file;
  }
}
