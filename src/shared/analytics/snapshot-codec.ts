/**
 * Wire encoding for analytics snapshot parts: gzip-compressed JSON, hashed by its text so an
 * unchanged part is never re-uploaded. Uses only web platform APIs (CompressionStream, SubtleCrypto),
 * which Electron's main process, browsers and Cloudflare Workers all provide.
 */
import { partitionSnapshot, type AnalyticsSnapshot, type AnalyticsSnapshotManifest, type SnapshotPartRef } from './snapshot';

/** Stays under the Durable Object value limit (about 2 MB) with room for the record around it. */
export const ANALYTICS_PART_MAX_BYTES = 1_900_000;

export class SnapshotPartTooLargeError extends Error {
  constructor(
    readonly partId: string,
    readonly bytes: number
  ) {
    super(`analytics part ${partId} is ${bytes} bytes compressed, over the ${ANALYTICS_PART_MAX_BYTES}-byte cap`);
  }
}

async function pipe(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzipText(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return pipe(new TextEncoder().encode(text), new CompressionStream('gzip'));
}

export async function gunzipText(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  return new TextDecoder().decode(await pipe(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), new DecompressionStream('gzip')));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface EncodedPart {
  id: string;
  hash: string;
  body: Uint8Array;
}

/**
 * Encodes a snapshot for upload. A part whose hash matches the one in `uploaded` (the parts the
 * relay already holds, by id) is listed in the manifest but not re-encoded, so the caller uploads
 * only what changed.
 */
export async function encodeSnapshot(snapshot: AnalyticsSnapshot, uploaded: ReadonlyMap<string, SnapshotPartRef> = new Map()): Promise<{ manifest: AnalyticsSnapshotManifest; changed: EncodedPart[] }> {
  const manifest: AnalyticsSnapshotManifest = { schemaVersion: snapshot.schemaVersion, generatedAt: snapshot.generatedAt, appVersion: snapshot.appVersion, platform: snapshot.platform, parts: [] };
  const changed: EncodedPart[] = [];
  for (const part of partitionSnapshot(snapshot)) {
    const hash = await sha256Hex(part.json);
    const known = uploaded.get(part.id);
    if (known?.hash === hash) {
      manifest.parts.push({ ...known });
      continue;
    }
    const body = await gzipText(part.json);
    if (body.byteLength > ANALYTICS_PART_MAX_BYTES) throw new SnapshotPartTooLargeError(part.id, body.byteLength);
    manifest.parts.push({ id: part.id, hash, bytes: body.byteLength });
    changed.push({ id: part.id, hash, body });
  }
  return { manifest, changed };
}
