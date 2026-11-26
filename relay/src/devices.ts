/** Device registry, refresh/access token proof-of-possession, socket tickets, and revocation. */
import { stable, tokenProofPayload, verify, type PublicIdentity } from '../../src/shared/crypto';
import { createDeviceId } from './account';
import { clearAnalytics } from './analytics';
import { clearMirror } from './mirror-store';
import type { RelayStorage, RelayStore } from './storage';

export type Json = Record<string, unknown>;

export interface DeviceRecord {
  deviceId: string;
  /** 'host' = a paired desktop; 'web' = a paired browser. */
  kind: 'host' | 'web';
  name: string;
  platform: string;
  /** Public identity key (JWK, P-256). Handshake signatures and token proofs bind to this key. */
  pub: PublicIdentity;
  /** SHA-256 hex of the refresh credential; the plaintext is delivered once, at pairing. */
  tokenHash: string;
  /** Outstanding short-lived access tokens, as hashes. Bounded; expired entries are pruned. */
  access?: AccessGrant[];
  /** The one pending token challenge, if any: single-use and short-lived. */
  challenge?: { value: string; expiresAt: number };
  /** For a browser: the desktop it paired with. Revoking that desktop revokes this browser. */
  hostDeviceId?: string;
  createdAt: number;
  lastSeen: number;
}

export interface AccessGrant {
  hash: string;
  expiresAt: number;
}

export class PairError extends Error {
  constructor(readonly code: 'not-found' | 'expired' | 'used' | 'invalid' | 'forbidden' | 'limit') {
    super(`pairing: ${code}`);
  }
}

/** Per-account device cap (docs/REMOTE-ACCESS.md §6.5): bounds what one leaked pairing flow or
 *  enrollment secret can add. A browser paired with two computers holds two web devices. */
export const MAX_WEB_DEVICES = 10;
export const MAX_HOST_DEVICES = 5;

export const SOCKET_TICKET_TTL_MS = 30_000;
/** Access tokens last about an hour (§6.2); challenges only long enough to sign one. */
export const ACCESS_TTL_MS = 60 * 60_000;
export const CHALLENGE_TTL_MS = 60_000;
/** Concurrent tabs of one browser each hold a token; the oldest beyond this are dropped. */
const MAX_ACCESS_GRANTS = 4;
/** `lastSeen` is display metadata: refresh it at most this often, not on every request. */
const LAST_SEEN_RESOLUTION_MS = 60_000;

interface SocketTicketRecord {
  ticketHash: string;
  expiresAt: number;
}

export function toBase64Url(buf: Uint8Array): string {
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

export const deviceKey = (accountId: string, deviceId: string) => `device:${accountId}:${deviceId}`;
const socketTicketKey = (accountId: string, deviceId: string) => `ws-ticket:${accountId}:${deviceId}`;
const epochKey = (accountId: string) => `revocation-epoch:${accountId}`;

export function epochValue(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** The account's revocation epoch: revoke all raises it. Every admission (pairing approval,
 *  enrollment redemption) carries the epoch its authority was issued under and re-checks it inside
 *  the transaction that mints the device, so authority issued before a revoke all cannot mint after
 *  it. Accounts and records from before the epoch existed read as 0. */
export async function revocationEpoch(store: RelayStorage, accountId: string): Promise<number> {
  return epochValue(await store.get<unknown>(epochKey(accountId)));
}

function liveGrants(device: DeviceRecord, now: number): AccessGrant[] {
  return (device.access ?? []).filter((grant) => grant.expiresAt > now);
}

/** A device record with every outstanding access token and challenge dropped. */
export function withoutGrants(device: DeviceRecord): DeviceRecord {
  const { access: _access, challenge: _challenge, ...rest } = device;
  return rest;
}

export async function newDeviceId(prefix: 'h' | 'w', accountId: string, deviceRouteSecret?: string): Promise<string> {
  // Production routes pass the relay-only secret so account ids are MACed before they become
  // routing hints. Pure core tests without a Worker keep the historical opaque format.
  if (deviceRouteSecret) return createDeviceId(prefix, accountId, deviceRouteSecret);
  return `${prefix}_${toBase64Url(crypto.getRandomValues(new Uint8Array(8)))}`;
}

/** One Hub owns each account: serialize state transitions per key across async storage and
 *  crypto calls. DO storage returns separate copies, so a status check alone cannot be a lock. */
const storeLocks = new WeakMap<RelayStore, Map<string, Promise<void>>>();
export async function withStoreKeyLock<T>(store: RelayStore, key: string, work: () => Promise<T>): Promise<T> {
  let locks = storeLocks.get(store);
  if (!locks) {
    locks = new Map();
    storeLocks.set(store, locks);
  }
  const previous = locks.get(key);
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, turn);
  if (previous) await previous;
  try {
    return await work();
  } finally {
    if (locks.get(key) === turn) locks.delete(key);
    if (!locks.size) storeLocks.delete(store);
    release();
  }
}

/** One short-lived pending upgrade capability per browser. A new issue replaces the old
 *  capability. The access-token check and hash write share a transaction with revocation. */
export async function issueSocketTicket(
  store: RelayStore,
  input: { accountId: string; deviceId: string; token: string },
  now: number
): Promise<{ ticket: string; expiresAt: number }> {
  const ticket = randomToken();
  const [tokenHash, ticketHash] = await Promise.all([hashToken(input.token), hashToken(ticket)]);
  const expiresAt = now + SOCKET_TICKET_TTL_MS;
  await store.transaction(async (tx) => {
    const key = deviceKey(input.accountId, input.deviceId);
    const device = await tx.get<DeviceRecord>(key);
    if (!device || device.kind !== 'web' || !liveGrants(device, now).some((grant) => grant.hash === tokenHash)) throw new PairError('invalid');
    device.lastSeen = now;
    await tx.put(key, device);
    await tx.put(socketTicketKey(input.accountId, input.deviceId), { ticketHash, expiresAt } satisfies SocketTicketRecord);
  });
  return { ticket, expiresAt };
}

/** Consume atomically with device existence: neither a replay nor a concurrent revocation
 *  can authorize a later upgrade. Expired capabilities are removed, not renewed. */
export async function consumeSocketTicket(
  store: RelayStore,
  input: { accountId: string; deviceId: string; ticket: string },
  now: number
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.ticket)) throw new PairError('invalid');
  const ticketHash = await hashToken(input.ticket);
  const valid = await store.transaction(async (tx) => {
    const key = socketTicketKey(input.accountId, input.deviceId);
    const record = await tx.get<SocketTicketRecord>(key);
    if (!record || record.ticketHash !== ticketHash) return false;
    const device = await tx.get<DeviceRecord>(deviceKey(input.accountId, input.deviceId));
    if (!device || device.kind !== 'web' || now >= record.expiresAt) {
      await tx.delete(key);
      return false;
    }
    await tx.delete(key);
    device.lastSeen = now;
    await tx.put(deviceKey(input.accountId, input.deviceId), device);
    return true;
  });
  if (!valid) throw new PairError('invalid');
  return input.deviceId;
}

/** Registers a web device and its refresh credential (pairing approval, and tests). */
export async function registerWebDevice(
  store: RelayStorage,
  input: { accountId: string; name: string; platform: string; pub: PublicIdentity; hostDeviceId?: string; deviceId?: string; token?: string; deviceRouteSecret?: string },
  now: number
): Promise<{ webToken: string; deviceId: string }> {
  const webToken = input.token ?? randomToken();
  const id = input.deviceId ?? await newDeviceId('w', input.accountId, input.deviceRouteSecret);
  const device: DeviceRecord = {
    deviceId: id,
    kind: 'web',
    name: input.name,
    platform: input.platform,
    pub: input.pub,
    tokenHash: await hashToken(webToken),
    ...(input.hostDeviceId ? { hostDeviceId: input.hostDeviceId } : {}),
    createdAt: now,
    lastSeen: now
  };
  await store.put(deviceKey(input.accountId, id), device);
  return { webToken, deviceId: id };
}

/** Mints the host's device record + refresh credential after the human approves. */
export async function registerHostDevice(
  store: RelayStorage,
  input: { accountId: string; name: string; platform: string; pub: PublicIdentity; deviceId?: string; token?: string; deviceRouteSecret?: string },
  now: number
): Promise<{ hostToken: string; deviceId: string }> {
  const hostToken = input.token ?? randomToken();
  const id = input.deviceId ?? await newDeviceId('h', input.accountId, input.deviceRouteSecret);
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

/** Checks a refresh credential. It is accepted only by the token endpoints, never by an API
 *  route, so on its own it cannot read or change anything. */
export async function verifyRefreshToken(store: RelayStore, input: { accountId: string; deviceId: string; token: string }): Promise<DeviceRecord> {
  if (!input.deviceId || !input.token) throw new PairError('invalid');
  const device = await store.get<DeviceRecord>(deviceKey(input.accountId, input.deviceId));
  if (!device || device.tokenHash !== (await hashToken(input.token))) throw new PairError('invalid');
  return device;
}

/** Token step 1: the refresh-credential holder gets a one-time challenge to sign. A new
 *  challenge replaces the pending one; only the credential holder can ask, so nobody else can
 *  keep displacing it. */
export async function issueChallenge(store: RelayStore, input: { accountId: string; deviceId: string; token: string }, now: number): Promise<{ challenge: string; expiresAt: number }> {
  if (!input.deviceId || !input.token) throw new PairError('invalid');
  const key = deviceKey(input.accountId, input.deviceId);
  const tokenHash = await hashToken(input.token);
  const challenge = randomToken();
  const expiresAt = now + CHALLENGE_TTL_MS;
  await store.transaction(async (tx) => {
    const device = await tx.get<DeviceRecord>(key);
    if (!device || device.tokenHash !== tokenHash) throw new PairError('invalid');
    device.challenge = { value: challenge, expiresAt };
    await tx.put(key, device);
  });
  return { challenge, expiresAt };
}

/** Token step 2 — proof of possession: the device signs the challenge with the key it paired
 *  with. The challenge is spent by any attempt, so a failed signature cannot be retried. */
export async function issueAccessToken(
  store: RelayStore,
  input: { accountId: string; deviceId: string; token: string; challenge: unknown; signature: unknown },
  now: number
): Promise<{ accessToken: string; expiresAt: number }> {
  if (!input.deviceId || !input.token || typeof input.challenge !== 'string' || !input.challenge || typeof input.signature !== 'string' || !input.signature) throw new PairError('invalid');
  const challenge = input.challenge;
  const key = deviceKey(input.accountId, input.deviceId);
  const tokenHash = await hashToken(input.token);
  const device = await store.get<DeviceRecord>(key);
  if (!device || device.tokenHash !== tokenHash) throw new PairError('invalid');
  let proven = false;
  try {
    proven = await verify(device.pub, tokenProofPayload(input.deviceId, challenge), input.signature);
  } catch {
    // A malformed signature is a failed proof, not a server error.
  }
  const accessToken = randomToken();
  const accessHash = await hashToken(accessToken);
  const expiresAt = now + ACCESS_TTL_MS;
  const outcome = await store.transaction(async (tx) => {
    const current = await tx.get<DeviceRecord>(key);
    // Revocation, credential rotation or a newer challenge may have landed since the read above.
    if (!current || current.tokenHash !== tokenHash || stable(current.pub) !== stable(device.pub)) return 'invalid' as const;
    const pending = current.challenge;
    if (!pending || pending.value !== challenge) return 'invalid' as const;
    delete current.challenge;
    if (now >= pending.expiresAt || !proven) {
      await tx.put(key, current);
      return 'forbidden' as const;
    }
    current.access = [...liveGrants(current, now), { hash: accessHash, expiresAt }].slice(-MAX_ACCESS_GRANTS);
    current.lastSeen = now;
    await tx.put(key, current);
    return 'ok' as const;
  });
  if (outcome !== 'ok') throw new PairError(outcome);
  return { accessToken, expiresAt };
}

/** Checks a short-lived access token: what every authenticated route and desktop socket needs. */
export async function verifyAccessToken(store: RelayStore, input: { accountId: string; deviceId: string; token: string }, now: number): Promise<DeviceRecord> {
  if (!input.deviceId || !input.token) throw new PairError('invalid');
  const key = deviceKey(input.accountId, input.deviceId);
  const hash = await hashToken(input.token);
  const device = await store.get<DeviceRecord>(key);
  if (!device || !liveGrants(device, now).some((grant) => grant.hash === hash)) throw new PairError('invalid');
  if (now - device.lastSeen < LAST_SEEN_RESOLUTION_MS) return device;
  // The last-seen write must be atomic with the existence/token check. A concurrent
  // revoke must never be undone by a stale authentication write.
  return store.transaction(async (tx) => {
    const current = await tx.get<DeviceRecord>(key);
    if (!current || !liveGrants(current, now).some((grant) => grant.hash === hash)) throw new PairError('invalid');
    current.lastSeen = now;
    await tx.put(key, current);
    return current;
  });
}

export async function listDevices(store: RelayStore, accountId: string): Promise<DeviceRecord[]> {
  const entries = await store.list<DeviceRecord>(`device:${accountId}:`);
  return entries.map(([, d]) => d);
}

/** Public device metadata (P4 device management): the shape a paired client may see. Never
 *  token hashes or key material — those stay inside the relay. */
export interface DeviceInfo {
  deviceId: string;
  kind: 'host' | 'web';
  name: string;
  platform: string;
  lastSeen: number;
  /** A socket is connected for this device right now: a browser's host switcher shows which
   *  computers are reachable before it tries one. */
  online: boolean;
}

export async function deviceInfos(store: RelayStore, accountId: string, online: (device: Pick<DeviceRecord, 'deviceId' | 'kind'>) => boolean = () => false): Promise<DeviceInfo[]> {
  return (await listDevices(store, accountId)).map((d) => ({
    deviceId: d.deviceId,
    kind: d.kind,
    name: d.name,
    platform: d.platform,
    lastSeen: d.lastSeen,
    online: online(d)
  }));
}

/** Revokes a device and returns every device id that stopped existing. Revoking a desktop also
 *  revokes the browsers paired with it: they route to that host id alone, so their credentials
 *  would otherwise outlive the only thing they could reach (the lost-desktop case, §6.5). A
 *  revoked desktop's offline mirror and analytics snapshot go too. */
export async function revokeDevice(store: RelayStore, accountId: string, deviceId: string): Promise<string[]> {
  const { victims, hosts } = await store.transaction(async (tx) => {
    const target = await tx.get<DeviceRecord>(deviceKey(accountId, deviceId));
    const victims = [deviceId];
    if (target?.kind === 'host') {
      for (const [, device] of await tx.list<DeviceRecord>(`device:${accountId}:`)) {
        if (device.kind === 'web' && device.hostDeviceId === deviceId) victims.push(device.deviceId);
      }
    }
    for (const id of victims) await deleteDevice(tx, accountId, id);
    return { victims, hosts: target?.kind === 'host' ? [deviceId] : [] };
  });
  for (const host of hosts) {
    await clearMirror(store, accountId, host);
    await clearAnalytics(store, accountId, host);
  }
  return victims;
}

/** The kill switch (§6.5): every device of the account except the desktop pulling it — each
 *  browser and every other computer — plus pending pairings, outstanding enrollment grants and the
 *  mirrors and analytics snapshots of revoked hosts. It raises the account's revocation epoch in the same commit, so an
 *  approval or redemption already past its own checks cannot mint afterwards. The caller keeps its
 *  identity and its own mirror, which it re-keys. */
export async function revokeAllExcept(store: RelayStore, accountId: string, keepDeviceId: string): Promise<string[]> {
  const { victims, hosts } = await store.transaction(async (tx) => {
    const victims: string[] = [];
    const hosts: string[] = [];
    for (const [, device] of await tx.list<DeviceRecord>(`device:${accountId}:`)) {
      if (device.deviceId === keepDeviceId) continue;
      victims.push(device.deviceId);
      if (device.kind === 'host') hosts.push(device.deviceId);
      await deleteDevice(tx, accountId, device.deviceId);
    }
    // In-flight pairings die with it: a code shown a minute ago must not mint a new device. One
    // Hub holds exactly one account, so every pairing record here is this account's.
    for (const [key] of await tx.list<unknown>('pair:')) await tx.delete(key);
    // So do enrollment grants the owner approved but no desktop redeemed yet. The enrollment
    // directory's pointers to them were bound under the old epoch, which this Hub now refuses.
    for (const [key] of await tx.list<unknown>(`enroll:${accountId}:`)) await tx.delete(key);
    await tx.put(epochKey(accountId), (await revocationEpoch(tx, accountId)) + 1);
    return { victims, hosts };
  });
  for (const host of hosts) {
    await clearMirror(store, accountId, host);
    await clearAnalytics(store, accountId, host);
  }
  return victims;
}

async function deleteDevice(tx: RelayStorage, accountId: string, id: string): Promise<void> {
  await tx.delete(deviceKey(accountId, id));
  await tx.delete(socketTicketKey(accountId, id));
  // A revoked browser must not leave an offline ciphertext queue behind or receive it after a
  // hibernated Hub wakes. Enqueue validates the device in a transaction.
  await tx.delete(`q:${id}`);
}
