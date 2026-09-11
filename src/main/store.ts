import path from 'node:path';
import type { SessionMeta, TranscriptItem } from '../shared/types';
import { appendLine, ensureDir, exists, readJson, readJsonl, rmrf, writeJson } from './util/fs';
import { promises as fs } from 'node:fs';

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

  constructor(userData: string) {
    this.root = path.join(userData, 'sessions');
    this.indexFile = path.join(userData, 'sessions.json');
  }

  async load(): Promise<SessionMeta[]> {
    await ensureDir(this.root);
    const loaded = await readJson<SessionMeta[]>(this.indexFile, []);
    // A valid-JSON but wrong-shaped file must not abort boot; fall back to an empty index.
    this.sessions = Array.isArray(loaded) ? loaded.filter((s): s is SessionMeta => !!s && typeof s === 'object' && typeof s.id === 'string') : [];
    // Any session that was running when the app closed is now idle.
    for (const s of this.sessions) {
      if (s.status === 'running' || s.status === 'awaiting' || s.status === 'starting') s.status = 'idle';
      s.queued = 0;
    }
    return this.sessions;
  }

  list(): SessionMeta[] {
    return this.sessions;
  }

  get(id: string): SessionMeta | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  sessionDir(id: string): string {
    return path.join(this.root, id);
  }

  async upsert(meta: SessionMeta): Promise<void> {
    const idx = this.sessions.findIndex((s) => s.id === meta.id);
    if (idx >= 0) this.sessions[idx] = meta;
    else this.sessions.unshift(meta);
    await this.flushIndex();
  }

  async remove(id: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    await this.flushIndex();
    await rmrf(this.sessionDir(id));
  }

  private flushIndex(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => writeJson(this.indexFile, this.sessions)).catch(() => undefined);
    return this.writeQueue;
  }

  async appendTranscript(id: string, item: TranscriptItem): Promise<void> {
    await appendLine(path.join(this.sessionDir(id), 'transcript.jsonl'), JSON.stringify(item));
  }

  async readTranscript(id: string): Promise<TranscriptItem[]> {
    const rows = await readJsonl<TranscriptItem>(path.join(this.sessionDir(id), 'transcript.jsonl'));
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
    await ensureDir(path.dirname(file));
    await fs.writeFile(file, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''), 'utf8');
  }

  async readNativeHistory<T>(id: string): Promise<T | null> {
    const file = path.join(this.sessionDir(id), 'native-history.json');
    if (!(await exists(file))) return null;
    return readJson<T | null>(file, null);
  }

  async writeNativeHistory(id: string, history: unknown): Promise<void> {
    await writeJson(path.join(this.sessionDir(id), 'native-history.json'), history);
  }

  async writeBlob(id: string, name: string, content: string): Promise<string> {
    const file = path.join(this.sessionDir(id), name);
    await ensureDir(path.dirname(file));
    await fs.writeFile(file, content, 'utf8');
    return file;
  }
}
