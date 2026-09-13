/** Relay core: pairing state machine and device registry (docs/REMOTE-ACCESS.md §6).
 *  Storage-agnostic — the Durable Object implements RelayStore over DO storage, tests
 *  over an in-memory map. The relay never sees private keys or plaintext payloads: it
 *  holds public keys and token hashes only. */

export type Json = Record<string, unknown>;

import type { PublicIdentity } from '../../src/shared/crypto';

/** Implemented by Durable Object storage (worker) and in-memory maps (tests). */
export interface RelayStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** All entries whose key starts with `prefix`, with the full key. */
  list<T>(prefix: string): Promise<Array<[string, T]>>;
}

export interface DeviceRecord {
  deviceId: string;
  /** 'host' = a paired desktop; 'web' = a paired browser. */
  kind: 'host' | 'web';
  name: string;
  platform: string;
  /** Public identity key (JWK, P-256). Handshake signatures bind to this key. */
  pub: PublicIdentity;
  /** SHA-256 hex of the device token; the plaintext token is shown once at pairing. */
  tokenHash: string;
  createdAt: number;
  lastSeen: number;
}

export interface PairingRecord {
  code: string;
  accountId: string;
  hostName: string;
  hostPlatform: string;
  /** The desktop's long-term public key, registered at pair/start. */
  hostPub: PublicIdentity;
  status: 'pending' | 'claimed' | 'approved' | 'denied';
  /** Filled by the web client at claim. */
  webName?: string;
  webPlatform?: string;
  webPub?: PublicIdentity;
  expiresAt: number;
}

export class PairError extends Error {
  constructor(readonly code: 'not-found' | 'expired' | 'used' | 'invalid' | 'forbidden') {
    super(`pairing: ${code}`);
  }
}

/** 31 symbols, no ambiguous glyphs (I/L/O/0/1); 8 chars ≈ 2^39.7. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_TTL_MS = 5 * 60_000;

function toBase64Url(buf: Uint8Array): string {
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomCode(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const deviceKey = (accountId: string, deviceId: string) => `device:${accountId}:${deviceId}`;
const codeKey = (code: string) => `pair:${code}`;

/** Creates a pairing code for a desktop asking to be paired. Single-use, 5-minute TTL. */
export async function startPairing(
  store: RelayStore,
  input: { accountId: string; hostName: string; hostPlatform: string; hostPub: PublicIdentity },
  now: number
): Promise<{ code: string; expiresAt: number }> {
  const record: PairingRecord = {
    code: randomCode(),
    accountId: input.accountId,
    hostName: input.hostName,
    hostPlatform: input.hostPlatform,
    hostPub: input.hostPub,
    status: 'pending',
    expiresAt: now + PAIRING_TTL_MS
  };
  await store.put(codeKey(record.code), record);
  await sweepExpired(store, now);
  return { code: record.code, expiresAt: record.expiresAt };
}

/** The web client claims a code with its identity key; the desktop is then asked to confirm. */
export async function claimPairing(
  store: RelayStore,
  input: { code: string; webName: string; webPlatform: string; webPub: PublicIdentity },
  now: number
): Promise<{ ok: true }> {
  const key = codeKey(input.code);
  const record = await store.get<PairingRecord>(key);
  if (!record) throw new PairError('not-found');
  if (record.status !== 'pending') throw new PairError('used');
  if (now >= record.expiresAt) {
    await store.delete(key);
    throw new PairError('expired');
  }
  record.status = 'claimed';
  record.webName = input.webName;
  record.webPlatform = input.webPlatform;
  record.webPub = input.webPub;
  await store.put(key, record);
  return { ok: true };
}

/** The web client polls its claim: pending/claimed → approved(+webToken, host identity) / denied / expired. */
export async function pollPairing(store: RelayStore, code: string, now: number): Promise<{ status: 'pending' | 'claimed' | 'denied' } | { status: 'approved'; webToken: string; webDeviceId: string; hostPub: PublicIdentity; hostDeviceId: string } | { status: 'expired' }> {
  const live = await store.get<PairingRecord>(codeKey(code));
  if (live) {
    if (now >= live.expiresAt) {
      await store.delete(codeKey(code));
      return { status: 'expired' };
    }
    return { status: live.status === 'denied' ? 'denied' : live.status === 'claimed' ? 'claimed' : 'pending' };
  }
  const settled = await store.get<{ status: string; webToken?: string; webDeviceId?: string; hostPub?: PublicIdentity; hostDeviceId?: string; expiresAt: number }>(codeKey(`${code}:done`));
  if (settled && settled.status === 'approved' && settled.webToken && settled.webDeviceId && settled.hostPub && settled.hostDeviceId) {
    if (now >= settled.expiresAt) {
      await store.delete(codeKey(`${code}:done`));
      return { status: 'expired' };
    }
    return { status: 'approved', webToken: settled.webToken, webDeviceId: settled.webDeviceId, hostPub: settled.hostPub, hostDeviceId: settled.hostDeviceId };
  }
  return { status: 'expired' };
}

/** Desktop decision. On approve, BOTH devices are minted: the host (token returned here,
 *  shown once) and the web client (token delivered via its claim poll). */
export async function resolvePairing(
  store: RelayStore,
  input: { code: string; decision: 'approve' | 'deny' },
  now: number
): Promise<
  | {
      denied: true;
    }
  | { hostToken: string; hostDeviceId: string; webToken: string; webDeviceId: string; webPub: PublicIdentity; hostPub: PublicIdentity }
> {
  const key = codeKey(input.code);
  const record = await store.get<PairingRecord>(key);
  if (!record) throw new PairError('invalid');
  if (now >= record.expiresAt) {
    await store.delete(key);
    throw new PairError('expired');
  }
  if (record.status !== 'claimed' || !record.webPub) throw new PairError('used');
  if (input.decision === 'deny') {
    record.status = 'denied';
    await store.put(key, record);
    return { denied: true };
  }
  const host = await registerHostDevice(store, { accountId: record.accountId, name: record.hostName, platform: record.hostPlatform, pub: record.hostPub }, now);
  const web = await registerWebDevice(store, { accountId: record.accountId, name: record.webName ?? 'web', platform: record.webPlatform ?? 'web', pub: record.webPub }, now);
  record.status = 'approved';
  await store.put(codeKey(`${record.code}:done`), { code: record.code, status: 'approved', webToken: web.webToken, webDeviceId: web.deviceId, hostPub: record.hostPub, hostDeviceId: host.deviceId, expiresAt: now + PAIRING_TTL_MS });
  await store.delete(key);
  return { hostToken: host.hostToken, hostDeviceId: host.deviceId, webToken: web.webToken, webDeviceId: web.deviceId, webPub: record.webPub, hostPub: record.hostPub };
}

/** Registers a web device directly (used when the desktop approves via its control socket). */
export async function registerWebDevice(store: RelayStore, input: { accountId: string; name: string; platform: string; pub: PublicIdentity }, now: number): Promise<{ webToken: string; deviceId: string }> {
  const webToken = randomToken();
  const id = `w_${toBase64Url(crypto.getRandomValues(new Uint8Array(8)))}`;
  const device: DeviceRecord = {
    deviceId: id,
    kind: 'web',
    name: input.name,
    platform: input.platform,
    pub: input.pub,
    tokenHash: await hashToken(webToken),
    createdAt: now,
    lastSeen: now
  };
  await store.put(deviceKey(input.accountId, id), device);
  return { webToken, deviceId: id };
}

/** Mints the host's device record + one-time token after the human approves. */
export async function registerHostDevice(store: RelayStore, input: { accountId: string; name: string; platform: string; pub: PublicIdentity }, now: number): Promise<{ hostToken: string; deviceId: string }> {
  const hostToken = randomToken();
  const id = `h_${toBase64Url(crypto.getRandomValues(new Uint8Array(8)))}`;
  const device: DeviceRecord = {
    deviceId: id,
    kind: 'host',
    name: input.name,
    platform: input.platform,
    pub: input.pub,
    tokenHash: await hashToken(hostToken),
    createdAt: now,
    lastSeen: now
  };
  await store.put(deviceKey(input.accountId, id), device);
  return { hostToken, deviceId: id };
}

export async function verifyDeviceToken(store: RelayStore, input: { accountId: string; deviceId: string; token: string }, now: number): Promise<DeviceRecord> {
  const device = await store.get<DeviceRecord>(deviceKey(input.accountId, input.deviceId));
  if (!device) throw new PairError('invalid');
  if (device.tokenHash !== (await hashToken(input.token))) throw new PairError('invalid');
  device.lastSeen = now;
  await store.put(deviceKey(input.accountId, input.deviceId), device);
  return device;
}

export async function listDevices(store: RelayStore, accountId: string): Promise<DeviceRecord[]> {
  const entries = await store.list<DeviceRecord>(`device:${accountId}:`);
  return entries.map(([, d]) => d);
}

export async function revokeDevice(store: RelayStore, accountId: string, deviceId: string): Promise<void> {
  await store.delete(deviceKey(accountId, deviceId));
}

async function sweepExpired(store: RelayStore, now: number): Promise<void> {
  const pairs = await store.list<PairingRecord>('pair:');
  for (const [key, record] of pairs) {
    if (now >= record.expiresAt) await store.delete(key);
  }
}
