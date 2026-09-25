/** Mission coordination history (MISSION-SPEC-v0.2 §19). One host owns a store; callers must
 * await a committed intent before performing its external side effect. This is not a shell/API
 * exactly-once guarantee. Snapshots are disposable caches; the journal is never compacted here. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../log';
import { MISSION_REVISION_CONFLICT_PREFIX } from '../../shared/mission-errors';

export interface MissionState {
  schemaVersion: number;
  id: string;
  revision: number;
  lastEventSequence: number;
}

export interface MissionTransaction {
  idempotencyKey: string;
  actor: string;
  expectedRevision: number;
  kind: string;
  /** Host-only, validated non-material telemetry. Advances journal sequence, not control CAS. */
  observation?: true;
  /** Original wire request, captured as JSON. Supply this for callbacks that generate IDs/times:
   * canonical request identity then permits retries WITHOUT invoking the callback again. */
  request?: unknown;
}

export interface MissionJournalEvent<T extends MissionState> extends MissionTransaction {
  schemaVersion: number;
  eventId: string;
  missionId: string;
  sequence: number;
  timestamp: string;
  /** The resulting revision, not the revision supplied by a caller's draft. */
  currentRevision: number;
  requestFingerprint: string;
  previousChecksum: string | null;
  payload: T;
  checksum: string;
}

export interface MissionStoreOptions<T extends MissionState> {
  /** An assertion/parser/guard: throw or return false to reject. Transformations are not applied. */
  validate: (value: unknown) => T | boolean | void;
  /** Required to admit/replay observations; must reject any coordination/authority change. */
  validateObservation?: (before: T, after: T) => boolean | void;
  schemaVersion?: number;
  snapshotEvery?: number;
  /** Both writes and reads are bounded; a read may request a smaller limit. Default: 8 MiB. */
  maxBlobBytes?: number;
  log?: Logger;
}

type ErrorCode = 'INVALID' | 'NOT_FOUND' | 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'BLOCKED' | 'CORRUPT' | 'UNSUPPORTED_SCHEMA' | 'UNSAFE_PATH' | 'TOO_LARGE';

export class MissionStoreError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: { expectedRevision: number; currentRevision: number }) {
    super(code === 'REVISION_CONFLICT' ? `${MISSION_REVISION_CONFLICT_PREFIX} ${message}` : message);
    this.name = 'MissionStoreError';
  }
}

export interface MissionStoreIssue {
  missionId: string;
  severity: 'warning' | 'blocked';
  message: string;
}

type Mutation<T> = T | ((draft: T) => T | void);
type BlobKind = 'artifacts' | 'source';
interface Entry<T extends MissionState> {
  state?: T;
  events: MissionJournalEvent<T>[];
  keys: Map<string, MissionJournalEvent<T>>;
  bytes: number;
}
interface Snapshot<T extends MissionState> {
  schemaVersion: number;
  missionId: string;
  lastEventSequence: number;
  journalChecksum: string;
  state: T;
  checksum: string;
}

interface ArtifactRetention {
  schemaVersion: number;
  missionId: string;
  idempotencyKey: string;
  request?: unknown;
  blobId: string;
  byteLength: number;
  checksum: string;
}

const RETAINED_ARTIFACT = /^artifact-([a-f0-9]{64})-([a-f0-9]{64})$/;
const VERSION = 1;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const NOFOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RENAME_RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Portable IDs deliberately exclude case aliases, Windows device names, dots and ADS syntax. */
function validId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id);
}

function assertId(id: string): void {
  if (!validId(id)) throw new MissionStoreError('INVALID', 'Invalid Mission ID');
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** JSON data only, with ordinary optional properties omitted exactly as on disk. */
function jsonCopy<T>(value: T): T {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) {
      throw new MissionStoreError('INVALID', 'Mission data must be finite JSON values');
    }
    return item;
  });
  if (encoded === undefined) throw new MissionStoreError('INVALID', 'Mission data must be JSON');
  return JSON.parse(encoded) as T;
}

/** Key order is not request identity. No assignment to a normal object's __proto__ is involved. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function fingerprint<T extends MissionState>(id: string, request: MissionTransaction, payload: T): string {
  return hash({ missionId: id, actor: request.actor, expectedRevision: request.expectedRevision, kind: request.kind, idempotencyKey: request.idempotencyKey,
    ...(request.observation ? { observation: true } : {}),
    ...(request.request !== undefined ? { request: request.request } : { payload }) });
}

function transaction(value: MissionTransaction): MissionTransaction {
  if (!object(value) || !integer(value.expectedRevision) || value.expectedRevision === Number.MAX_SAFE_INTEGER ||
    value.observation !== undefined && (value.observation !== true || value.actor !== 'host') ||
    ![value.idempotencyKey, value.actor, value.kind].every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 512)) {
    throw new MissionStoreError('INVALID', 'Invalid Mission transaction metadata');
  }
  return { idempotencyKey: value.idempotencyKey, actor: value.actor, expectedRevision: value.expectedRevision, kind: value.kind,
    ...(value.observation ? { observation: true } : {}),
    ...(value.request !== undefined ? { request: jsonCopy(value.request) } : {}) };
}

export class MissionStore<T extends MissionState> {
  private readonly base: string;
  private anchor?: string;
  private initializing?: Promise<void>;
  private readonly entries = new Map<string, Entry<T>>();
  private readonly known = new Set<string>();
  /** Survives a failed reload: forgetting a previously acknowledged commit is not recovery. */
  private readonly tips = new Map<string, { sequence: number; checksum: string }>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly problems = new Map<string, MissionStoreIssue[]>();
  private readonly snapshotEvery: number;
  private readonly schemaVersion: number;
  private readonly maxBlobBytes: number;

  constructor(userData: string, private readonly options: MissionStoreOptions<T>) {
    this.base = path.resolve(userData);
    this.snapshotEvery = options.snapshotEvery ?? 25;
    this.schemaVersion = options.schemaVersion ?? VERSION;
    this.maxBlobBytes = options.maxBlobBytes ?? 8 * 1024 * 1024;
    if (!integer(this.snapshotEvery) || this.snapshotEvery < 1 || !integer(this.schemaVersion) || this.schemaVersion < 1 ||
      !integer(this.maxBlobBytes) || this.maxBlobBytes < 1 || this.maxBlobBytes > MAX_BLOB_BYTES || typeof options.validate !== 'function') {
      throw new MissionStoreError('INVALID', 'Invalid Mission store options');
    }
  }

  list(): T[] {
    return [...this.entries.values()].flatMap((entry) => entry.state ? [structuredClone(entry.state)] : []);
  }

  get(id: string): T | undefined {
    assertId(id);
    const state = this.entries.get(id)?.state;
    return state ? structuredClone(state) : undefined;
  }

  issues(): MissionStoreIssue[] {
    return structuredClone([...this.problems.values()].flat());
  }

  isBlocked(id: string): boolean {
    assertId(id);
    return this.problems.get(id)?.some((issue) => issue.severity === 'blocked') ?? false;
  }

  /** Explicit reload is the only way to reopen admission after an uncertain write. A full boot
   * isolates corrupt Missions; load(id) rejects instead, so a repair caller sees its exact failure. */
  async load(): Promise<T[]>;
  async load(id: string): Promise<T | undefined>;
  async load(id?: string): Promise<T[] | T | undefined> {
    if (id !== undefined) {
      assertId(id);
      return this.queue(id, async () => { await this.recover(id); return this.get(id); });
    }
    const root = await this.root();
    const names = new Set([...this.known, ...(await fs.readdir(root))]);
    await Promise.all([...names].map(async (name) => {
      if (!validId(name)) { this.report(name, 'warning', 'Ignored an invalid Mission directory name'); return; }
      await this.load(name).catch(() => undefined); // recover records a visible, per-Mission block.
    }));
    return this.list();
  }

  /** Creation commits revision/sequence 1. Draft revision fields are always host-owned. */
  async create(state: T, metadata: MissionTransaction): Promise<T> {
    const input = jsonCopy(state);
    assertId(input.id);
    const request = transaction(metadata);
    if (request.observation) throw new MissionStoreError('INVALID', 'An observation cannot create a Mission');
    if (request.expectedRevision !== 0) throw new MissionStoreError('REVISION_CONFLICT', 'Creation expects revision 0');
    return this.queue(input.id, async () => {
      const entry = await this.admit(input.id);
      const duplicate = entry.keys.get(request.idempotencyKey);
      if (duplicate) return this.retry(input.id, entry, duplicate, request, input, true);
      if (entry.state) throw new MissionStoreError('REVISION_CONFLICT', 'Mission already exists', { expectedRevision: 0, currentRevision: entry.state.revision });
      const next = this.prepare(input.id, undefined, input, 1, 1);
      return this.commit(input.id, entry, request, next);
    });
  }

  /** Mutators are synchronous; external side effects belong AFTER this promise resolves.
   * With metadata.request, duplicates return the original result without invoking the mutator.
   * Without it, mutators must be pure/deterministic: duplicate payloads are evaluated on their
   * ORIGINAL base revision to detect changed closed-over values, never on today's state. */
  async transact(id: string, metadata: MissionTransaction, mutate: Mutation<T>): Promise<T> {
    assertId(id);
    const request = transaction(metadata);
    const input = typeof mutate === 'function' ? mutate : jsonCopy(mutate);
    return this.queue(id, async () => {
      const entry = await this.admit(id);
      const duplicate = entry.keys.get(request.idempotencyKey);
      if (duplicate) return this.retry(id, entry, duplicate, request, input, false);
      if (!entry.state) throw new MissionStoreError('NOT_FOUND', 'Mission not found');
      if (entry.state.revision !== request.expectedRevision) throw new MissionStoreError('REVISION_CONFLICT', `Expected revision ${request.expectedRevision}; current revision is ${entry.state.revision}`, { expectedRevision: request.expectedRevision, currentRevision: entry.state.revision });
      const next = this.prepare(id, entry.state, input, entry.state.revision + (request.observation ? 0 : 1), entry.state.lastEventSequence + 1);
      if (request.observation) this.checkObservation(entry.state, next);
      return this.commit(id, entry, request, next);
    });
  }

  /** Retain a caller-owned identity independently of mailbox commit. The full key/request and
   * bytes are checked on every retry, not just their filename hashes. No existing file is ever
   * truncated: complete staged writes recover; incomplete/changed bytes require explicit repair. */
  async retainArtifact(id: string, idempotencyKey: string, input: Uint8Array | string, request?: unknown): Promise<string> {
    const keyHash = this.artifactKey(id, idempotencyKey);
    const bytes = this.blobBytes(input);
    const blobId = `artifact-${keyHash}-${createHash('sha256').update(bytes).digest('hex')}`;
    const body = { schemaVersion: VERSION, missionId: id, idempotencyKey, ...(request === undefined ? {} : { request: jsonCopy(request) }), blobId, byteLength: bytes.length };
    const receipt = { ...body, checksum: hash(body) };
    const encoded = Buffer.from(JSON.stringify(receipt));
    if (encoded.length > MAX_EVENT_BYTES) throw new MissionStoreError('TOO_LARGE', 'Artifact retention identity exceeds the byte limit');
    return this.queue(id, async () => {
      if (!(await this.admit(id)).state) throw new MissionStoreError('NOT_FOUND', 'Mission not found');
      try {
        const parent = path.join(await this.missionDir(id, false), 'artifacts');
        await this.directory(parent, true);
        const final = path.join(parent, `retained-${keyHash}`), staged = path.join(parent, `.retaining-${keyHash}`);
        let published = true;
        try { await this.directory(final, false); }
        catch (error) { if (code(error) !== 'ENOENT') throw error; published = false; }
        const dir = published ? final : staged;
        if (!published) await this.directory(dir, true);
        const identityFile = path.join(dir, 'identity.json'), contentFile = path.join(dir, 'content');
        const names = await fs.readdir(dir);
        if (names.some((name) => name !== 'identity.json' && name !== 'content')) throw new MissionStoreError('CORRUPT', 'Unrecognized files in artifact retention');
        if (!published && !(await this.leaf(identityFile))) {
          if (names.length) throw new MissionStoreError('CORRUPT', 'Staged artifact bytes exist without their retained identity');
          await this.writeExclusive(identityFile, encoded);
        }
        const retained = await this.readRetention(id, dir, keyHash);
        if (canonical(retained) !== canonical(receipt)) throw new MissionStoreError('IDEMPOTENCY_CONFLICT', 'Artifact idempotency key was already used for different request identity or bytes');
        if (!published && !(await this.leaf(contentFile))) await this.writeExclusive(contentFile, bytes);
        const retainedBytes = await this.readBlobFile(contentFile, this.maxBlobBytes, blobId.slice(-64), true);
        if (!retainedBytes.equals(bytes)) throw new MissionStoreError('IDEMPOTENCY_CONFLICT', 'Artifact idempotency key was already used for different bytes');
        // Flush the recovered receipt too: a previous fsync/rename acknowledgment may have
        // failed. The nonempty directory rename publishes both files together and cannot
        // replace another published identity, unlike renaming an individual file on POSIX.
        await this.readBlobFile(identityFile, MAX_EVENT_BYTES, undefined, true);
        await this.syncDirectory(dir);
        if (!published) {
          await this.directory(parent, false);
          await fs.rename(staged, final);
        }
        await this.syncDirectory(parent);
        return blobId;
      } catch (error) {
        if (!(error instanceof MissionStoreError && error.code === 'IDEMPOTENCY_CONFLICT')) this.report(id, 'blocked', `Artifact retention failed; reload before retrying: ${message(error)}`);
        throw error;
      }
    });
  }

  /** Includes unpublished/uncertain retention. A retry that drops all attachments must not
   * bypass a previously retained image identity merely because it no longer writes a blob. */
  async hasArtifactRetention(id: string, idempotencyKey: string): Promise<boolean> {
    const keyHash = this.artifactKey(id, idempotencyKey);
    return this.queue(id, async () => {
      if (!(await this.admit(id)).state) throw new MissionStoreError('NOT_FOUND', 'Mission not found');
      const parent = path.join(await this.missionDir(id, false), 'artifacts');
      for (const name of [`retained-${keyHash}`, `.retaining-${keyHash}`]) {
        try { await this.directory(path.join(parent, name), false); return true; }
        catch (error) { if (code(error) !== 'ENOENT') throw error; }
      }
      return false;
    });
  }

  writeArtifact(id: string, bytes: Uint8Array | string): Promise<string> { return this.writeBlob(id, 'artifacts', bytes); }
  writeSource(id: string, bytes: Uint8Array | string): Promise<string> { return this.writeBlob(id, 'source', bytes); }
  readArtifact(id: string, artifactId: string, maxBytes = this.maxBlobBytes): Promise<Buffer> { return this.readBlob(id, 'artifacts', artifactId, maxBytes); }
  readSource(id: string, sourceId: string, maxBytes = this.maxBlobBytes): Promise<Buffer> { return this.readBlob(id, 'source', sourceId, maxBytes); }

  private queue<R>(id: string, run: () => Promise<R>): Promise<R> {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(run);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(id, settled);
    void settled.then(() => { if (this.queues.get(id) === settled) this.queues.delete(id); });
    return result;
  }

  private report(id: string, severity: MissionStoreIssue['severity'], reason: string): void {
    const issues = this.problems.get(id) ?? [];
    if (!issues.some((issue) => issue.severity === severity && issue.message === reason)) issues.push({ missionId: id, severity, message: reason });
    this.problems.set(id, issues);
    try { this.options.log?.('warn', `Mission ${id}: ${reason}`); } catch { /* Observers cannot change commit semantics. */ }
  }

  private async admit(id: string): Promise<Entry<T>> {
    if (!this.known.has(id)) await this.recover(id);
    if (this.isBlocked(id)) throw new MissionStoreError('BLOCKED', 'Mission mutation is blocked; explicitly reload/recover it before retrying');
    return this.entries.get(id)!;
  }

  private checkedState(value: unknown): T {
    if (!object(value) || !validId(value.id) || !integer(value.schemaVersion) || !integer(value.revision) || !integer(value.lastEventSequence)) {
      throw new MissionStoreError('INVALID', 'Invalid Mission state');
    }
    if (value.schemaVersion !== this.schemaVersion) throw new MissionStoreError('UNSUPPORTED_SCHEMA', `Unsupported Mission schema ${value.schemaVersion}`);
    const copy = jsonCopy(value) as unknown as T;
    const result = this.options.validate(structuredClone(copy));
    if (result === false || result instanceof Promise) throw new MissionStoreError('INVALID', 'Mission validation failed (validators must be synchronous)');
    return copy;
  }

  private prepare(id: string, before: T | undefined, mutate: Mutation<T>, revision: number, sequence: number): T {
    let candidate: T;
    if (typeof mutate === 'function') {
      if (!before) throw new MissionStoreError('INVALID', 'No base state for mutation');
      const draft = structuredClone(before);
      candidate = mutate(draft) ?? draft;
    } else candidate = jsonCopy(mutate);
    if (!object(candidate) || candidate.id !== id || !integer(revision) || !integer(sequence)) throw new MissionStoreError('INVALID', 'Mutation changed Mission identity or exhausted its revision');
    return this.checkedState({ ...candidate, revision, lastEventSequence: sequence });
  }

  private checkObservation(before: T | undefined, after: T): void {
    if (!before || !this.options.validateObservation) throw new MissionStoreError('INVALID', 'Mission observations require an explicit non-material-change validator');
    if (this.options.validateObservation(structuredClone(before), structuredClone(after)) === false) throw new MissionStoreError('INVALID', 'Observation changed Mission coordination state');
  }

  private retry(id: string, entry: Entry<T>, event: MissionJournalEvent<T>, request: MissionTransaction, mutate: Mutation<T>, creating: boolean): T {
    if ((event.sequence === 1) !== creating || request.expectedRevision !== event.expectedRevision || request.actor !== event.actor || request.kind !== event.kind || request.observation !== event.observation) {
      throw new MissionStoreError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different request');
    }
    if ((request.request !== undefined) !== (event.request !== undefined)) throw new MissionStoreError('IDEMPOTENCY_CONFLICT', 'Idempotency request identity cannot change between retries');
    const before = entry.events[event.sequence - 2]?.payload;
    const next = request.request !== undefined ? event.payload : this.prepare(id, before, mutate, event.currentRevision, event.sequence);
    if (fingerprint(id, request, next) !== event.requestFingerprint) throw new MissionStoreError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different request or payload');
    return structuredClone(event.payload);
  }

  private async commit(id: string, entry: Entry<T>, request: MissionTransaction, next: T): Promise<T> {
    const body = { schemaVersion: VERSION, eventId: randomUUID(), missionId: id, sequence: next.lastEventSequence, timestamp: new Date().toISOString(),
      ...request, currentRevision: next.revision, requestFingerprint: fingerprint(id, request, next), previousChecksum: entry.events.at(-1)?.checksum ?? null, payload: next };
    const event: MissionJournalEvent<T> = { ...body, checksum: hash(body) };
    const line = JSON.stringify(event) + '\n';
    const size = Buffer.byteLength(line);
    if (size > MAX_EVENT_BYTES) throw new MissionStoreError('TOO_LARGE', 'Mission event exceeds the journal size limit');
    try {
      const dir = await this.missionDir(id, true);
      const handle = await this.openFile(path.join(dir, 'journal.jsonl'), constants.O_RDWR | constants.O_APPEND | (entry.bytes === 0 ? constants.O_CREAT : 0));
      try {
        if ((await handle.stat()).size !== entry.bytes) throw new MissionStoreError('CORRUPT', 'Journal changed outside its owning store; reload before writing');
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await this.syncDirectory(dir);
    } catch (error) {
      this.report(id, 'blocked', `Journal append failed; its outcome requires recovery: ${message(error)}`);
      throw new MissionStoreError('BLOCKED', `Mission journal write failed: ${message(error)}`);
    }
    // Publication comes strictly after append+fsync. No callback/returned draft aliases this state.
    entry.events.push(event);
    entry.keys.set(event.idempotencyKey, event);
    entry.state = next;
    entry.bytes += size;
    this.tips.set(id, { sequence: event.sequence, checksum: event.checksum });
    if (event.sequence % this.snapshotEvery === 0) {
      try { await this.snapshot(id, event); }
      catch (error) {
        // The event IS committed. Reject to stop side-effect admission, but preserve committed state.
        // Recovery and an idempotent retry return it without appending a second intent.
        this.report(id, 'blocked', `Snapshot failed after journal commit: ${message(error)}`);
        throw new MissionStoreError('BLOCKED', 'Mission snapshot failed after journal commit; explicitly reload before retrying');
      }
    }
    return structuredClone(next);
  }

  private validateEvent(value: unknown, id: string, entry: Entry<T>, eventIds: Set<string>): MissionJournalEvent<T> {
    if (!object(value)) throw new MissionStoreError('CORRUPT', 'Invalid journal event');
    if (value.schemaVersion !== VERSION) throw new MissionStoreError('UNSUPPORTED_SCHEMA', `Unsupported journal schema ${String(value.schemaVersion)}`);
    const event = value as unknown as MissionJournalEvent<T>;
    const { checksum, ...body } = event;
    if (!HASH.test(checksum) || hash(body) !== checksum) throw new MissionStoreError('CORRUPT', 'Journal checksum mismatch');
    transaction(event);
    if (event.missionId !== id || !UUID.test(event.eventId) || eventIds.has(event.eventId) || entry.keys.has(event.idempotencyKey) ||
      event.sequence !== entry.events.length + 1 || event.expectedRevision !== (entry.state?.revision ?? 0) || event.currentRevision !== event.expectedRevision + (event.observation ? 0 : 1) ||
      event.previousChecksum !== (entry.events.at(-1)?.checksum ?? null) || typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) {
      throw new MissionStoreError('CORRUPT', 'Journal identity, sequence or revision chain is invalid');
    }
    const state = this.checkedState(event.payload);
    if (event.observation) this.checkObservation(entry.state, state);
    if (state.id !== id || state.revision !== event.currentRevision || state.lastEventSequence !== event.sequence || fingerprint(id, event, state) !== event.requestFingerprint) {
      throw new MissionStoreError('CORRUPT', 'Journal payload or request fingerprint is invalid');
    }
    eventIds.add(event.eventId);
    entry.events.push(event);
    entry.keys.set(event.idempotencyKey, event);
    entry.state = state;
    return event;
  }

  private async recover(id: string): Promise<void> {
    this.known.add(id);
    this.problems.delete(id);
    const entry: Entry<T> = { events: [], keys: new Map(), bytes: 0 };
    const tip = this.tips.get(id);
    try {
      let dir: string;
      try { dir = await this.missionDir(id, false); }
      catch (error) {
        if (code(error) !== 'ENOENT') throw error;
        if (tip) throw new MissionStoreError('CORRUPT', 'Previously committed Mission directory is missing');
        this.entries.set(id, entry);
        return;
      }
      const hasRetainedFiles = (await fs.readdir(dir)).some((name) => name !== 'journal.jsonl');
      const snapshot = await this.readSnapshot(id, dir);
      let handle: FileHandle | undefined;
      try { handle = await this.openFile(path.join(dir, 'journal.jsonl'), constants.O_RDWR); }
      catch (error) { if (code(error) !== 'ENOENT') throw error; }
      if (handle) {
        try {
          const raw = await handle.readFile();
          entry.bytes = raw.lastIndexOf(10) + 1;
          const committed = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, entry.bytes));
          const ids = new Set<string>();
          for (const line of committed.split('\n').slice(0, -1)) {
            if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new MissionStoreError('CORRUPT', 'Oversized journal event');
            this.validateEvent(JSON.parse(line), id, entry, ids);
          }
          if (tip && entry.events[tip.sequence - 1]?.checksum !== tip.checksum) throw new MissionStoreError('CORRUPT', 'Previously committed journal history is missing or changed');
          if (!entry.events.length && hasRetainedFiles) throw new MissionStoreError('CORRUPT', 'Retained files exist without committed journal history');
          this.applySnapshot(id, entry, snapshot);
          // Validate the entire prefix BEFORE truncation: never "repair" interior corruption.
          if (entry.bytes !== raw.length) {
            await handle.truncate(entry.bytes);
            this.report(id, 'warning', `Recovered incomplete final journal line (${raw.length - entry.bytes} bytes truncated)`);
          }
          // A prior fsync may have failed after a complete line was written. Recovery durably
          // acknowledges that event before either publishing it or permitting another append.
          await handle.sync();
        } finally { await handle.close(); }
      } else if (tip || hasRetainedFiles) throw new MissionStoreError('CORRUPT', 'Committed Mission or retained files exist without their journal');
      const last = entry.events.at(-1);
      if (last) this.tips.set(id, { sequence: last.sequence, checksum: last.checksum });
      this.entries.set(id, entry);
    } catch (error) {
      this.entries.delete(id); // Never publish a prefix when later ownership-changing events are unknown.
      this.report(id, 'blocked', `Recovery blocked: ${message(error)}`);
      throw error instanceof MissionStoreError ? error : new MissionStoreError('CORRUPT', `Mission recovery failed: ${message(error)}`);
    }
  }

  private async readSnapshot(id: string, dir: string): Promise<Snapshot<T> | undefined> {
    const file = path.join(dir, 'snapshot.json');
    if (!(await this.leaf(file))) return undefined;
    const handle = await this.openFile(file, constants.O_RDONLY);
    let raw: string;
    try {
      if ((await handle.stat()).size > MAX_EVENT_BYTES * 2) throw new MissionStoreError('CORRUPT', 'Oversized snapshot');
      raw = await handle.readFile('utf8');
    } finally { await handle.close(); }
    try {
      const value: unknown = JSON.parse(raw);
      if (!object(value)) throw new Error('Invalid snapshot');
      if (value.schemaVersion !== VERSION) throw new MissionStoreError('UNSUPPORTED_SCHEMA', `Unsupported snapshot schema ${String(value.schemaVersion)}`);
      const snapshot = value as unknown as Snapshot<T>;
      const { checksum, ...body } = snapshot;
      if (!HASH.test(checksum) || checksum !== hash(body) || snapshot.missionId !== id || !integer(snapshot.lastEventSequence) || snapshot.lastEventSequence < 1) throw new Error('Invalid snapshot checksum or identity');
      this.checkedState(snapshot.state);
      return snapshot;
    } catch (error) {
      if (error instanceof MissionStoreError && error.code === 'UNSUPPORTED_SCHEMA') throw error;
      this.report(id, 'warning', `Ignored invalid snapshot cache: ${message(error)}`);
      return undefined;
    }
  }

  private applySnapshot(id: string, entry: Entry<T>, snapshot?: Snapshot<T>): void {
    if (!snapshot) return;
    if (snapshot.lastEventSequence > entry.events.length) throw new MissionStoreError('CORRUPT', 'Snapshot is ahead of the journal; committed history is missing');
    const event = entry.events[snapshot.lastEventSequence - 1];
    if (event.checksum !== snapshot.journalChecksum || canonical(event.payload) !== canonical(snapshot.state)) {
      this.report(id, 'warning', 'Ignored snapshot cache that does not match its journal event');
      return;
    }
    entry.state = snapshot.state;
    for (const later of entry.events.slice(snapshot.lastEventSequence)) entry.state = later.payload;
  }

  private async snapshot(id: string, event: MissionJournalEvent<T>): Promise<void> {
    const body = { schemaVersion: VERSION, missionId: id, lastEventSequence: event.sequence, journalChecksum: event.checksum, state: event.payload };
    const dir = await this.missionDir(id, false);
    const file = path.join(dir, 'snapshot.json');
    const tmp = path.join(dir, `snapshot.${randomUUID()}.tmp`);
    try {
      const handle = await this.openFile(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try { await handle.writeFile(JSON.stringify({ ...body, checksum: hash(body) }, null, 2), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      // Same atomic/fsync and Windows transient-lock convention as util/fs.ts; unlike the
      // general JSON helper, exclusive random temp files and every ancestor are checked here.
      for (let attempt = 0; ; attempt++) {
        await this.directory(dir, false);
        await this.leaf(file);
        await this.leaf(tmp);
        try { await fs.rename(tmp, file); break; }
        catch (error) {
          if (attempt >= 5 || !RENAME_RETRY.has(code(error) ?? '')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        }
      }
      await this.syncDirectory(dir);
    } catch (error) {
      await this.directory(dir, false).then(async () => { if (await this.leaf(tmp)) await fs.unlink(tmp); }).catch(() => undefined);
      throw error;
    }
  }

  private artifactKey(id: string, idempotencyKey: string): string {
    assertId(id);
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 4096) throw new MissionStoreError('INVALID', 'Invalid artifact retention key');
    return hash({ missionId: id, idempotencyKey });
  }

  private blobBytes(input: Uint8Array | string): Buffer {
    if (typeof input !== 'string' && !(input instanceof Uint8Array)) throw new MissionStoreError('INVALID', 'Artifact content must be bytes or text');
    if ((typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength) > this.maxBlobBytes) throw new MissionStoreError('TOO_LARGE', 'Artifact exceeds the byte limit');
    return typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  }

  private async writeExclusive(file: string, bytes: Buffer): Promise<void> {
    const handle = await this.openFile(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  }

  private async readRetention(id: string, dir: string, keyHash: string): Promise<ArtifactRetention> {
    const raw = await this.readBlobFile(path.join(dir, 'identity.json'), MAX_EVENT_BYTES);
    let value: unknown;
    try { value = JSON.parse(raw.toString('utf8')); }
    catch { throw new MissionStoreError('CORRUPT', 'Invalid artifact retention identity'); }
    if (!object(value)) throw new MissionStoreError('CORRUPT', 'Invalid artifact retention identity');
    const receipt = value as unknown as ArtifactRetention, { checksum, ...body } = receipt;
    if (receipt.schemaVersion !== VERSION || receipt.missionId !== id || typeof receipt.idempotencyKey !== 'string' ||
      hash({ missionId: id, idempotencyKey: receipt.idempotencyKey }) !== keyHash || !HASH.test(checksum) || hash(body) !== checksum ||
      !integer(receipt.byteLength) || receipt.byteLength > MAX_BLOB_BYTES || typeof receipt.blobId !== 'string' ||
      RETAINED_ARTIFACT.exec(receipt.blobId)?.[1] !== keyHash) throw new MissionStoreError('CORRUPT', 'Artifact retention checksum or identity mismatch');
    return receipt;
  }

  private async writeBlob(id: string, kind: BlobKind, input: Uint8Array | string): Promise<string> {
    assertId(id);
    const bytes = this.blobBytes(input);
    return this.queue(id, async () => {
      const entry = await this.admit(id);
      if (!entry.state) throw new MissionStoreError('NOT_FOUND', 'Mission not found');
      // The digest binds immutable content, while the random component prevents chosen names.
      const blobId = `${kind === 'source' ? 'source' : 'artifact'}-${randomUUID()}-${createHash('sha256').update(bytes).digest('hex')}`;
      try {
        const dir = path.join(await this.missionDir(id, false), kind);
        await this.directory(dir, true);
        const handle = await this.openFile(path.join(dir, blobId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        await this.syncDirectory(dir);
        return blobId;
      } catch (error) {
        this.report(id, 'blocked', `Artifact write failed; reload before retrying: ${message(error)}`);
        throw error;
      }
    });
  }

  private async readBlob(id: string, kind: BlobKind, blobId: string, maxBytes: number): Promise<Buffer> {
    assertId(id);
    const prefix = kind === 'source' ? 'source-' : 'artifact-';
    const retained = typeof blobId === 'string' && kind === 'artifacts' ? RETAINED_ARTIFACT.exec(blobId) : null;
    if (!retained && (typeof blobId !== 'string' || !blobId.startsWith(prefix) || !UUID.test(blobId.slice(prefix.length, prefix.length + 36)) ||
      blobId[prefix.length + 36] !== '-' || !HASH.test(blobId.slice(prefix.length + 37)))) throw new MissionStoreError('INVALID', 'Invalid artifact ID');
    if (!integer(maxBytes) || maxBytes > this.maxBlobBytes) throw new MissionStoreError('INVALID', 'Invalid artifact read limit');
    return this.queue(id, async () => {
      const dir = path.join(await this.missionDir(id, false), kind);
      if (retained) {
        const artifact = path.join(dir, `retained-${retained[1]}`);
        const receipt = await this.readRetention(id, artifact, retained[1]);
        if (receipt.blobId !== blobId) throw new MissionStoreError('CORRUPT', 'Artifact reference does not match its retained identity');
        const bytes = await this.readBlobFile(path.join(artifact, 'content'), maxBytes, retained[2]);
        if (bytes.length !== receipt.byteLength) throw new MissionStoreError('CORRUPT', 'Artifact length does not match its retained identity');
        return bytes;
      }
      return this.readBlobFile(path.join(dir, blobId), maxBytes, blobId.slice(-64));
    });
  }

  private async readBlobFile(file: string, maxBytes: number, digest?: string, sync = false): Promise<Buffer> {
    const handle = await this.openFile(file, sync ? constants.O_RDWR : constants.O_RDONLY);
    try {
      const size = (await handle.stat()).size;
      if (size > maxBytes) throw new MissionStoreError('TOO_LARGE', 'Artifact exceeds the requested read limit');
      // Read at most the cap plus one sentinel byte, even if a foreign process grows the file.
      const bytes = Buffer.alloc(Math.min(size + 1, maxBytes + 1));
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length !== size || (await handle.stat()).size !== size) throw new MissionStoreError('CORRUPT', 'Artifact changed while reading');
      const result = bytes.subarray(0, length);
      if (digest !== undefined && createHash('sha256').update(result).digest('hex') !== digest) throw new MissionStoreError('CORRUPT', 'Artifact checksum mismatch');
      if (sync) await handle.sync();
      return result;
    } finally { await handle.close(); }
  }

  /** userData is host-configured, not a request path. Resolve its trusted ancestors once, then
   * reject replacement of that anchor and ALL symlink/junction descendants on every operation.
   * Private userData + no-follow opens are not an OS sandbox against hostile local processes. */
  private async root(): Promise<string> {
    if (!this.anchor) {
      this.initializing ??= (async () => {
        await fs.mkdir(this.base, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(this.base);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MissionStoreError('UNSAFE_PATH', 'Unsafe Mission storage root');
        this.anchor = await fs.realpath(this.base);
      })();
      try { await this.initializing; } finally { this.initializing = undefined; }
    }
    const root = path.join(this.anchor!, 'missions');
    await this.directory(root, true);
    return root;
  }

  private async missionDir(id: string, create: boolean): Promise<string> {
    const dir = path.join(await this.root(), id);
    await this.directory(dir, create);
    return dir;
  }

  private async directory(dir: string, create: boolean): Promise<void> {
    const baseStat = await fs.lstat(this.base);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink() || await fs.realpath(this.base) !== this.anchor) throw new MissionStoreError('UNSAFE_PATH', 'Mission storage root was replaced');
    const relative = path.relative(this.anchor!, dir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new MissionStoreError('UNSAFE_PATH', 'Path escapes Mission storage');
    let current = this.anchor!;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      const parent = current;
      current = path.join(current, part);
      let stat: Stats;
      try { stat = await fs.lstat(current); }
      catch (error) {
        if (!create || code(error) !== 'ENOENT') throw error;
        await fs.mkdir(current, { mode: 0o700 }).catch((e: unknown) => { if (code(e) !== 'EEXIST') throw e; });
        stat = await fs.lstat(current);
        await this.syncDirectory(parent);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) throw new MissionStoreError('UNSAFE_PATH', 'Symlink, junction or non-directory in Mission storage');
    }
  }

  private async leaf(file: string): Promise<Stats | undefined> {
    let stat: Stats;
    try { stat = await fs.lstat(file); }
    catch (error) { if (code(error) === 'ENOENT') return undefined; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await fs.realpath(file) !== file) throw new MissionStoreError('UNSAFE_PATH', 'Mission storage files must be regular, unlinked files');
    return stat;
  }

  private async openFile(file: string, flags: number): Promise<FileHandle> {
    await this.directory(path.dirname(file), false);
    await this.leaf(file);
    const handle = await fs.open(file, flags | NOFOLLOW, 0o600);
    try {
      await this.directory(path.dirname(file), false);
      const actual = await handle.stat();
      const named = await this.leaf(file);
      if (!actual.isFile() || actual.nlink !== 1 || !named || actual.dev !== named.dev || actual.ino !== named.ino) throw new MissionStoreError('UNSAFE_PATH', 'Mission storage file was replaced while opening');
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  private async syncDirectory(dir: string): Promise<void> {
    // Windows cannot fsync directory handles through Node. File handles still MUST be flushed;
    // POSIX additionally persists directory entries (new journal/blob and snapshot rename).
    if (process.platform === 'win32') return;
    const handle = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
