/**
 * The analytics snapshot's wire contract, shared by the desktop uploader, the relay and the web
 * dashboard. Import-free on purpose: the relay compiles it without the desktop's type graph.
 */

export const ANALYTICS_SNAPSHOT_SCHEMA = 1;

/** `days.2026-11`, `sessions.2026-11`, `tools` or `reports`. */
export const SNAPSHOT_PART_ID = /^(?:(?:days|sessions)\.\d{4}-\d{2}|tools|reports)$/;

/** Lowercase hex SHA-256 of a part's JSON text. */
export const SNAPSHOT_PART_HASH = /^[0-9a-f]{64}$/;

/**
 * Cap on a part's compressed bytes. Parts travel and are stored as base64 (4/3 larger), and a
 * Durable Object value holds at most about 2 MB, so 1.4 MB leaves the record around it room.
 */
export const ANALYTICS_PART_MAX_BYTES = 1_400_000;
export const ANALYTICS_PART_MAX_BASE64 = Math.ceil(ANALYTICS_PART_MAX_BYTES / 3) * 4;

/** More parts than a computer could produce (two a month for 25 years, plus tools and reports). */
export const ANALYTICS_MAX_PARTS = 602;

export interface SnapshotPartRef {
  id: string;
  /** SHA-256 of the part's JSON text, hex. */
  hash: string;
  /** Stored (compressed) size in bytes. */
  bytes: number;
}

export interface AnalyticsSnapshotMeta {
  generatedAt: number;
  appVersion: string;
  platform: string;
}

export interface AnalyticsSnapshotManifest extends AnalyticsSnapshotMeta {
  schemaVersion: number;
  parts: SnapshotPartRef[];
}

/** One part as uploaded and served: its hash and the gzip-compressed JSON, base64-encoded. */
export interface AnalyticsPartBody {
  hash: string;
  data: string;
}

/** One computer on the account as the dashboard's overview route reports it. */
export interface AnalyticsHost {
  hostId: string;
  name: string;
  platform: string;
  online: boolean;
  lastSeen: number;
  /** Null when the computer never uploaded, or stopped sharing. */
  manifest: AnalyticsSnapshotManifest | null;
  /** When the relay committed the manifest. */
  receivedAt: number | null;
}
