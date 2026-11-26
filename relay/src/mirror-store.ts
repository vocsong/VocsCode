/** Offline transcript mirror storage (docs/RELAY.md).
 *  The relay stores opaque sealed blobs so a paired browser can read history while the desktop is
 *  off. It never holds the key: only the IV, the ciphertext and plaintext routing metadata
 *  (session id, size, timestamp). Every entry is bounded and TTL'd so one host cannot fill the DO. */
import type { RelayStorage, RelayStore } from './storage';

/** A sealed blob exactly as it travels: random 96-bit IV + AES-256-GCM ciphertext, base64url. */
export interface MirrorBlob {
  iv: string;
  ct: string;
}

export interface MirrorSessionMeta {
  sessionId: string;
  updatedAt: number;
  bytes: number;
}

export class MirrorError extends Error {
  constructor(readonly code: 'invalid-id' | 'too-large' | 'quota') {
    super(`mirror: ${code}`);
  }
}

const MIRROR_MAX_SESSIONS = 200;
/** Per-blob cap on the base64 ciphertext. SQLite-backed Durable Objects store at most 2 MB of key
 *  and value together, so anything larger could never be written; the desktop sizes its
 *  snapshots to fit (src/main/remote/mirror.ts). */
export const MIRROR_MAX_BLOB_CHARS = 1_900_000;
const MIRROR_MAX_IV_CHARS = 32;
const MIRROR_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const mirrorIndexKey = (accountId: string, hostId: string) => `mirror:${accountId}:${hostId}:index`;
const mirrorMetaKey = (accountId: string, hostId: string) => `mirror:${accountId}:${hostId}:meta`;
const mirrorPrefix = (accountId: string, hostId: string) => `mirror:${accountId}:${hostId}:s:`;
const mirrorSessionKey = (accountId: string, hostId: string, sessionId: string) => `${mirrorPrefix(accountId, hostId)}${sessionId}`;

interface MirrorIndexRecord {
  blob: MirrorBlob;
  updatedAt: number;
}

interface MirrorSessionRecord {
  blob: MirrorBlob;
  updatedAt: number;
  bytes: number;
}

/** The per-host catalogue of mirrored sessions. Pruning, listing and clearing read this, never the
 *  multi-megabyte blobs themselves, which would not fit in a Durable Object's memory together. */
interface MirrorCatalogue {
  sessions: Record<string, { updatedAt: number; bytes: number }>;
}

async function catalogue(tx: RelayStorage, accountId: string, hostId: string): Promise<MirrorCatalogue> {
  const existing = await tx.get<MirrorCatalogue>(mirrorMetaKey(accountId, hostId));
  if (existing) return existing;
  // Written before the catalogue existed: build it once from the records themselves.
  const prefix = mirrorPrefix(accountId, hostId);
  const sessions: MirrorCatalogue['sessions'] = {};
  for (const [key, record] of await tx.list<MirrorSessionRecord>(prefix)) sessions[key.slice(prefix.length)] = { updatedAt: record.updatedAt, bytes: record.bytes };
  return { sessions };
}

/** base64 length → decoded byte length, without decoding. */
function sealedBytes(blob: MirrorBlob): number {
  return Math.floor((blob.ct.length * 3) / 4);
}

function checkBlob(blob: MirrorBlob): number {
  if (blob.ct.length > MIRROR_MAX_BLOB_CHARS || blob.iv.length > MIRROR_MAX_IV_CHARS) throw new MirrorError('too-large');
  return sealedBytes(blob);
}

/** Drops expired sessions and the oldest past the budget, by id: no blob is read. */
async function pruneCatalogue(tx: RelayStorage, accountId: string, hostId: string, meta: MirrorCatalogue, now: number): Promise<void> {
  for (const [id, entry] of Object.entries(meta.sessions)) {
    if (now - entry.updatedAt <= MIRROR_TTL_MS) continue;
    await tx.delete(mirrorSessionKey(accountId, hostId, id));
    delete meta.sessions[id];
  }
  const live = Object.entries(meta.sessions).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [id] of live.slice(0, Math.max(0, live.length - MIRROR_MAX_SESSIONS))) {
    await tx.delete(mirrorSessionKey(accountId, hostId, id));
    delete meta.sessions[id];
  }
  const index = await tx.get<MirrorIndexRecord>(mirrorIndexKey(accountId, hostId));
  if (index && now - index.updatedAt > MIRROR_TTL_MS) await tx.delete(mirrorIndexKey(accountId, hostId));
}

/** Stores the sealed session index the browser's offline sidebar renders. */
export async function putMirrorIndex(store: RelayStore, input: { accountId: string; hostId: string; blob: MirrorBlob }, now: number): Promise<void> {
  checkBlob(input.blob);
  await store.transaction(async (tx) => {
    await tx.put<MirrorIndexRecord>(mirrorIndexKey(input.accountId, input.hostId), { blob: input.blob, updatedAt: now });
    const meta = await catalogue(tx, input.accountId, input.hostId);
    await pruneCatalogue(tx, input.accountId, input.hostId, meta, now);
    await tx.put(mirrorMetaKey(input.accountId, input.hostId), meta);
  });
}

export async function getMirrorIndex(store: RelayStore, accountId: string, hostId: string, now: number): Promise<{ blob: MirrorBlob; updatedAt: number } | undefined> {
  const record = await store.get<MirrorIndexRecord>(mirrorIndexKey(accountId, hostId));
  if (!record) return undefined;
  if (now - record.updatedAt > MIRROR_TTL_MS) {
    await store.delete(mirrorIndexKey(accountId, hostId));
    return undefined;
  }
  return record;
}

/** Stores one sealed transcript snapshot, then enforces the per-host session budget. */
export async function putMirrorSession(
  store: RelayStore,
  input: { accountId: string; hostId: string; sessionId: string; blob: MirrorBlob },
  now: number
): Promise<void> {
  if (!SESSION_ID.test(input.sessionId)) throw new MirrorError('invalid-id');
  const bytes = checkBlob(input.blob);
  await store.transaction(async (tx) => {
    await tx.put<MirrorSessionRecord>(mirrorSessionKey(input.accountId, input.hostId, input.sessionId), { blob: input.blob, updatedAt: now, bytes });
    const meta = await catalogue(tx, input.accountId, input.hostId);
    meta.sessions[input.sessionId] = { updatedAt: now, bytes };
    await pruneCatalogue(tx, input.accountId, input.hostId, meta, now);
    await tx.put(mirrorMetaKey(input.accountId, input.hostId), meta);
  });
}

export async function getMirrorSession(
  store: RelayStore,
  input: { accountId: string; hostId: string; sessionId: string },
  now: number
): Promise<MirrorBlob | undefined> {
  if (!SESSION_ID.test(input.sessionId)) throw new MirrorError('invalid-id');
  const record = await store.get<MirrorSessionRecord>(mirrorSessionKey(input.accountId, input.hostId, input.sessionId));
  if (!record) return undefined;
  if (now - record.updatedAt > MIRROR_TTL_MS) {
    await deleteMirrorSession(store, input.accountId, input.hostId, input.sessionId);
    return undefined;
  }
  return record.blob;
}

/** Plaintext routing metadata only: the session id, when it last changed and its size. */
export async function listMirrorSessions(store: RelayStore, accountId: string, hostId: string, now: number): Promise<MirrorSessionMeta[]> {
  const meta = await store.transaction((tx) => catalogue(tx, accountId, hostId));
  return Object.entries(meta.sessions)
    .filter(([, entry]) => now - entry.updatedAt <= MIRROR_TTL_MS)
    .map(([sessionId, entry]) => ({ sessionId, updatedAt: entry.updatedAt, bytes: entry.bytes }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteMirrorSession(store: RelayStore, accountId: string, hostId: string, sessionId: string): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.delete(mirrorSessionKey(accountId, hostId, sessionId));
    const meta = await catalogue(tx, accountId, hostId);
    if (!(sessionId in meta.sessions)) return;
    delete meta.sessions[sessionId];
    await tx.put(mirrorMetaKey(accountId, hostId), meta);
  });
}

/** Drops the whole mirror for a host — mirroring turned off, the key rotated, or the host revoked. */
export async function clearMirror(store: RelayStore, accountId: string, hostId: string): Promise<void> {
  await store.transaction(async (tx) => {
    const meta = await catalogue(tx, accountId, hostId);
    for (const id of Object.keys(meta.sessions)) await tx.delete(mirrorSessionKey(accountId, hostId, id));
    await tx.delete(mirrorIndexKey(accountId, hostId));
    await tx.delete(mirrorMetaKey(accountId, hostId));
  });
}
