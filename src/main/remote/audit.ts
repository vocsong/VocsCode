/** Remote-access audit trail (docs/REMOTE-ACCESS.md §6.5, P4). Pairing, approval, revocation and
 *  connection events, plus refused remote actions, are appended to a bounded JSONL file under
 *  userData and surfaced in Settings → Remote access. Writes are best-effort: an unwritable file
 *  must never break the remote host, so a failed append only costs durability, not the session. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RemoteAuditAction, RemoteAuditEntry } from '../../shared/types';
import type { Logger } from '../log';

/** The UI feed and the file are both capped; the file is rewritten once it grows past this. */
const MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 256 * 1024;

export class RemoteAudit {
  private entries: RemoteAuditEntry[] = [];
  private readonly file: string;
  /** Serializes appends so rotation never races a concurrent write. */
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly deps: { dir: string; log: Logger }) {
    this.file = path.join(deps.dir, 'remote-audit.jsonl');
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log('warn', `could not read the remote audit log (${e instanceof Error ? e.message : String(e)}); starting a fresh one`);
      }
      return;
    }
    this.entries = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        this.entries.push(JSON.parse(line) as RemoteAuditEntry);
      } catch {
        // A torn final line (crash mid-append) is expected; skip it rather than discard the file.
      }
    }
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
  }

  record(action: RemoteAuditAction, entry: { device?: string; detail?: string } = {}): RemoteAuditEntry {
    const full: RemoteAuditEntry = { at: Date.now(), action, ...entry };
    this.entries.push(full);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.append();
    return full;
  }

  /** Newest first — the order the Settings feed shows. */
  list(): RemoteAuditEntry[] {
    return [...this.entries].reverse();
  }

  /** Resolves once every queued append/rotation has settled (used by tests and shutdown). */
  async flush(): Promise<void> {
    await this.writes;
  }

  clear(): void {
    this.entries = [];
    this.writes = this.writes.then(() => fs.rm(this.file, { force: true })).catch((e) => {
      this.deps.log('warn', `could not clear the remote audit log: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private append(): void {
    const snapshot = [...this.entries];
    this.writes = this.writes
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const stat = await fs.stat(this.file).catch(() => null);
        if (stat && stat.size > MAX_FILE_BYTES) {
          // Rewrite with the capped in-memory window instead of appending forever.
          await fs.writeFile(this.file, snapshot.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
          return;
        }
        await fs.appendFile(this.file, `${JSON.stringify(snapshot[snapshot.length - 1])}\n`, 'utf8');
      })
      .catch((e) => {
        this.deps.log('warn', `could not append to the remote audit log: ${e instanceof Error ? e.message : String(e)}`);
      });
  }
}
