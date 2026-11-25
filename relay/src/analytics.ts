/**
 * Analytics snapshots for the code.vocs.io dashboard (docs/WEB-DASHBOARD.md §4).
 *
 * A desktop uploads compressed parts, then commits a manifest that lists them. Parts are stored
 * under their id and hash, so a part re-uploaded ahead of its manifest never changes what the
 * committed manifest serves. The commit refuses a manifest naming a part the relay does not hold,
 * so a reader never sees a dangling reference, and drops every part the new manifest no longer
 * lists. A per-host catalogue of stored parts and sizes means pruning and clearing never load a
 * part body.
 *
 * Unlike the transcript mirror these values are readable aggregates, not ciphertext: the owner
 * decided the dashboard should work from a Vocs sign-in alone.
 */
import type { RelayStorage, RelayStore } from './storage';
import {
  ANALYTICS_MAX_PARTS,
  ANALYTICS_PART_MAX_BASE64,
  ANALYTICS_SNAPSHOT_SCHEMA,
  SNAPSHOT_PART_HASH,
  SNAPSHOT_PART_ID,
  type AnalyticsPartBody,
  type AnalyticsSnapshotManifest,
  type SnapshotPartRef
} from '../../src/shared/analytics/snapshot-wire';

export class AnalyticsError extends Error {
  constructor(
    readonly code: 'invalid' | 'too-large' | 'missing-part' | 'quota',
    readonly detail?: string[]
  ) {
    super(`analytics: ${code}`);
  }
}

const MAX_LABEL = 64;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const prefixOf = (accountId: string, hostId: string) => `analytics:${accountId}:${hostId}:`;
const manifestKey = (accountId: string, hostId: string) => `${prefixOf(accountId, hostId)}manifest`;
const catalogueKey = (accountId: string, hostId: string) => `${prefixOf(accountId, hostId)}parts`;
const partKey = (accountId: string, hostId: string, ref: string) => `${prefixOf(accountId, hostId)}part:${ref}`;
/** A stored part's identity: `days.2026-11@<hash>`. */
const refOf = (id: string, hash: string) => `${id}@${hash}`;

interface PartRecord {
  data: string;
  updatedAt: number;
}

interface ManifestRecord {
  manifest: AnalyticsSnapshotManifest;
  receivedAt: number;
}

/** Stored part ref (`id@hash`) → its size, so commits and clears never read part bodies. */
type Catalogue = Record<string, { bytes: number }>;

function base64Bytes(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - pad;
}

function checkPartId(id: unknown): string {
  if (typeof id !== 'string' || !SNAPSHOT_PART_ID.test(id)) throw new AnalyticsError('invalid');
  return id;
}

/** Shape-checks an uploaded part; the relay stores it as given and never decompresses it. */
export function parsePartBody(id: unknown, body: unknown): { id: string } & AnalyticsPartBody {
  const partId = checkPartId(id);
  const b = body as Partial<AnalyticsPartBody> | null;
  if (!b || typeof b !== 'object' || typeof b.hash !== 'string' || !SNAPSHOT_PART_HASH.test(b.hash) || typeof b.data !== 'string') throw new AnalyticsError('invalid');
  if (b.data.length > ANALYTICS_PART_MAX_BASE64) throw new AnalyticsError('too-large');
  if (!b.data || b.data.length % 4 !== 0 || !BASE64.test(b.data)) throw new AnalyticsError('invalid');
  return { id: partId, hash: b.hash, data: b.data };
}

function label(value: unknown): string {
  if (typeof value !== 'string') throw new AnalyticsError('invalid');
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_LABEL);
}

/** Validates a manifest strictly: unknown fields are refused, not carried along. */
export function parseManifest(body: unknown): AnalyticsSnapshotManifest {
  const m = body as Record<string, unknown> | null;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new AnalyticsError('invalid');
  const allowed = new Set(['schemaVersion', 'generatedAt', 'appVersion', 'platform', 'parts']);
  if (Object.keys(m).some((k) => !allowed.has(k))) throw new AnalyticsError('invalid');
  if (m.schemaVersion !== ANALYTICS_SNAPSHOT_SCHEMA) throw new AnalyticsError('invalid');
  if (typeof m.generatedAt !== 'number' || !Number.isFinite(m.generatedAt) || m.generatedAt < 0) throw new AnalyticsError('invalid');
  if (!Array.isArray(m.parts) || m.parts.length > ANALYTICS_MAX_PARTS) throw new AnalyticsError('invalid');
  const seen = new Set<string>();
  const parts: SnapshotPartRef[] = m.parts.map((p: unknown) => {
    const r = p as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Object.keys(r).some((k) => k !== 'id' && k !== 'hash' && k !== 'bytes')) throw new AnalyticsError('invalid');
    const id = checkPartId(r.id);
    if (seen.has(id) || typeof r.hash !== 'string' || !SNAPSHOT_PART_HASH.test(r.hash) || typeof r.bytes !== 'number' || !(r.bytes >= 0)) throw new AnalyticsError('invalid');
    seen.add(id);
    return { id, hash: r.hash, bytes: r.bytes };
  });
  return { schemaVersion: ANALYTICS_SNAPSHOT_SCHEMA, generatedAt: m.generatedAt, appVersion: label(m.appVersion), platform: label(m.platform), parts };
}

async function catalogue(tx: RelayStorage, accountId: string, hostId: string): Promise<Catalogue> {
  return (await tx.get<Catalogue>(catalogueKey(accountId, hostId))) ?? {};
}

/** Stores one part. It is not readable until a manifest that lists it is committed. */
export async function putAnalyticsPart(store: RelayStore, input: { accountId: string; hostId: string; id: string; hash: string; data: string }, now: number): Promise<void> {
  await store.transaction(async (tx) => {
    const parts = await catalogue(tx, input.accountId, input.hostId);
    const ref = refOf(input.id, input.hash);
    // Room for a full committed set plus a full staged one.
    if (!(ref in parts) && Object.keys(parts).length >= ANALYTICS_MAX_PARTS * 2) throw new AnalyticsError('quota');
    await tx.put<PartRecord>(partKey(input.accountId, input.hostId, ref), { data: input.data, updatedAt: now });
    parts[ref] = { bytes: base64Bytes(input.data) };
    await tx.put(catalogueKey(input.accountId, input.hostId), parts);
  });
}

/** Commits a manifest whose every part is held with the same hash, then drops unlisted parts. */
export async function commitAnalyticsManifest(store: RelayStore, input: { accountId: string; hostId: string; manifest: AnalyticsSnapshotManifest }, now: number): Promise<void> {
  await store.transaction(async (tx) => {
    const parts = await catalogue(tx, input.accountId, input.hostId);
    const missing = input.manifest.parts.filter((p) => !(refOf(p.id, p.hash) in parts)).map((p) => p.id);
    if (missing.length) throw new AnalyticsError('missing-part', missing);
    const listed = new Set(input.manifest.parts.map((p) => refOf(p.id, p.hash)));
    for (const ref of Object.keys(parts)) {
      if (listed.has(ref)) continue;
      await tx.delete(partKey(input.accountId, input.hostId, ref));
      delete parts[ref];
    }
    // Sizes come from what the relay stored, not from what the manifest claims.
    const manifest = { ...input.manifest, parts: input.manifest.parts.map((p) => ({ ...p, bytes: parts[refOf(p.id, p.hash)].bytes })) };
    await tx.put(catalogueKey(input.accountId, input.hostId), parts);
    await tx.put<ManifestRecord>(manifestKey(input.accountId, input.hostId), { manifest, receivedAt: now });
  });
}

export async function getAnalyticsManifest(store: RelayStorage, accountId: string, hostId: string): Promise<ManifestRecord | undefined> {
  return store.get<ManifestRecord>(manifestKey(accountId, hostId));
}

/** A committed part, or undefined when the host's current manifest does not list it. */
export async function getAnalyticsPart(store: RelayStore, accountId: string, hostId: string, id: string): Promise<AnalyticsPartBody | undefined> {
  checkPartId(id);
  const record = await store.get<ManifestRecord>(manifestKey(accountId, hostId));
  const listed = record?.manifest.parts.find((p) => p.id === id);
  if (!listed) return undefined;
  const part = await store.get<PartRecord>(partKey(accountId, hostId, refOf(id, listed.hash)));
  return part ? { hash: listed.hash, data: part.data } : undefined;
}

/** Drops a host's whole snapshot: sharing turned off, or the computer revoked. */
export async function clearAnalytics(store: RelayStore, accountId: string, hostId: string): Promise<void> {
  await store.transaction(async (tx) => {
    for (const ref of Object.keys(await catalogue(tx, accountId, hostId))) await tx.delete(partKey(accountId, hostId, ref));
    await tx.delete(catalogueKey(accountId, hostId));
    await tx.delete(manifestKey(accountId, hostId));
  });
}
