/** Relay core: pairing state machine and device registry (docs/REMOTE-ACCESS.md §6).
 *  Storage-agnostic — the Durable Object implements RelayStore over DO storage, tests
 *  over an in-memory map. The relay never sees private keys or plaintext session
 *  payloads; it stores public keys, token hashes, pairing codes and sealed blobs.
 *
 *  Tokens (§6.2): pairing gives each device a long-lived refresh credential, stored here only as
 *  a hash. It authorizes nothing by itself. Holding it, a device asks for a one-time challenge and
 *  signs it with its device key; only then does it get a short-lived access token, which is what
 *  every REST route and desktop socket requires. A stolen refresh credential without the private
 *  key is useless, and a leaked access token expires within the hour. A browser's refresh
 *  credential reaches it sealed to the key it claimed with, so none is ever stored in plaintext. */

export type Json = Record<string, unknown>;

import { pairingDecisionPayload, pairingTokenContext, sealToKey, stable, tokenProofPayload, verify, type PublicIdentity, type SealedToKey } from '../../src/shared/crypto';

/** Implemented by Durable Object storage (worker) and in-memory maps (tests). */
export interface RelayStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** All entries whose key starts with `prefix`, with the full key. */
  list<T>(prefix: string): Promise<Array<[string, T]>>;
}

export interface RelayStore extends RelayStorage {
  /** Atomic multi-key commit for device minting; never publish a partially approved pair. */
  transaction<T>(work: (tx: RelayStorage) => Promise<T>): Promise<T>;
}

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

export interface PairingRecord {
  code: string;
  accountId: string;
  hostName: string;
  hostPlatform: string;
  /** The desktop's long-term public key, registered at pair/start. */
  hostPub: PublicIdentity;
  /** Set when an already-enrolled desktop started the pairing with its own device credential:
   *  approval then reuses that device instead of minting a second host identity. */
  hostDeviceId?: string;
  status: 'pending' | 'claimed' | 'approved' | 'denied';
  /** Filled by the web client at claim. */
  webName?: string;
  webPlatform?: string;
  webPub?: PublicIdentity;
  /** SHA-256 of the claim's private poll capability, never the plaintext capability. */
  pollTokenHash?: string;
  expiresAt: number;
}

export class PairError extends Error {
  constructor(readonly code: 'not-found' | 'expired' | 'used' | 'invalid' | 'forbidden' | 'limit') {
    super(`pairing: ${code}`);
  }
}

/** 31 symbols, no ambiguous glyphs (I/L/O/0/1); 8 chars ≈ 2^39.7. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_TTL_MS = 5 * 60_000;
/** Per-account device cap (docs/REMOTE-ACCESS.md §6.5): bounds what one leaked pairing flow or
 *  enrollment secret can add. A browser paired with two computers holds two web devices. */
export const MAX_WEB_DEVICES = 10;
export const MAX_HOST_DEVICES = 5;

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
const socketTicketKey = (accountId: string, deviceId: string) => `ws-ticket:${accountId}:${deviceId}`;

export const SOCKET_TICKET_TTL_MS = 30_000;
interface SocketTicketRecord {
  ticketHash: string;
  expiresAt: number;
}

/** Access tokens last about an hour (§6.2); challenges only long enough to sign one. */
export const ACCESS_TTL_MS = 60 * 60_000;
export const CHALLENGE_TTL_MS = 60_000;
/** Concurrent tabs of one browser each hold a token; the oldest beyond this are dropped. */
const MAX_ACCESS_GRANTS = 4;
/** `lastSeen` is display metadata: refresh it at most this often, not on every request. */
const LAST_SEEN_RESOLUTION_MS = 60_000;

function liveGrants(device: DeviceRecord, now: number): AccessGrant[] {
  return (device.access ?? []).filter((grant) => grant.expiresAt > now);
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

/** One Hub owns each account: serialize state transitions per code across async storage and
 *  crypto calls. DO storage returns separate copies, so a status check alone cannot be a lock. */
const pairLocks = new WeakMap<RelayStore, Map<string, Promise<void>>>();
async function withPairCode<T>(store: RelayStore, code: string, work: () => Promise<T>): Promise<T> {
  let locks = pairLocks.get(store);
  if (!locks) {
    locks = new Map();
    pairLocks.set(store, locks);
  }
  const previous = locks.get(code);
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  locks.set(code, turn);
  if (previous) await previous;
  try {
    return await work();
  } finally {
    if (locks.get(code) === turn) locks.delete(code);
    if (!locks.size) pairLocks.delete(store);
    release();
  }
}

/** Creates a pairing code for a desktop asking to be paired. Single-use, 5-minute TTL. */
export async function startPairing(
  store: RelayStore,
  input: { accountId: string; hostName: string; hostPlatform: string; hostPub: PublicIdentity; hostDeviceId?: string },
  now: number
): Promise<{ code: string; expiresAt: number }> {
  const record: PairingRecord = {
    code: randomCode(),
    accountId: input.accountId,
    hostName: input.hostName,
    hostPlatform: input.hostPlatform,
    hostPub: input.hostPub,
    ...(input.hostDeviceId ? { hostDeviceId: input.hostDeviceId } : {}),
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
): Promise<{ pollToken: string; hostPub: PublicIdentity }> {
  return withPairCode(store, input.code, () => claimPairingUnlocked(store, input, now));
}

async function claimPairingUnlocked(store: RelayStore, input: { code: string; webName: string; webPlatform: string; webPub: PublicIdentity }, now: number): Promise<{ pollToken: string; hostPub: PublicIdentity }> {
  const key = codeKey(input.code);
  const record = await store.get<PairingRecord>(key);
  if (!record) throw new PairError('not-found');
  if (record.status !== 'pending') throw new PairError('used');
  if (now >= record.expiresAt) {
    await store.delete(key);
    throw new PairError('expired');
  }
  // Fail before the desktop is asked: approval re-checks the cap inside its transaction.
  if ((await listDevices(store, record.accountId)).filter((d) => d.kind === 'web').length >= MAX_WEB_DEVICES) throw new PairError('limit');
  record.status = 'claimed';
  record.webName = input.webName;
  record.webPlatform = input.webPlatform;
  record.webPub = input.webPub;
  const pollToken = randomToken();
  record.pollTokenHash = await hashToken(pollToken);
  await store.put(key, record);
  return { pollToken, hostPub: record.hostPub };
}

/** The approved pairing as the claimant's poll sees it. The browser's refresh credential is sealed
 *  to the ECDH key it claimed with: the relay keeps only that ciphertext until the record expires. */
export interface ApprovedPoll {
  status: 'approved';
  sealedToken: SealedToKey;
  webDeviceId: string;
  hostPub: PublicIdentity;
  hostDeviceId: string;
  hostName: string;
}

interface ApprovedRecord extends Omit<ApprovedPoll, 'status'> {
  code: string;
  status: 'approved';
  pollTokenHash: string;
  expiresAt: number;
}

/** Only the claimant's private capability can read pairing state or its sealed credential. */
export async function pollPairing(store: RelayStore, code: string, pollToken: string, now: number): Promise<{ status: 'claimed' | 'denied' } | ApprovedPoll | { status: 'expired' }> {
  const live = await store.get<PairingRecord>(codeKey(code));
  const settled = live ? undefined : await store.get<ApprovedRecord>(codeKey(`${code}:done`));
  const record = live ?? settled;
  if (!record || !pollToken || !record.pollTokenHash || record.pollTokenHash !== (await hashToken(pollToken))) throw new PairError('forbidden');
  if (now >= record.expiresAt || (settled && !settled.sealedToken)) {
    await store.delete(live ? codeKey(code) : codeKey(`${code}:done`));
    return { status: 'expired' };
  }
  if (live) return { status: live.status === 'denied' ? 'denied' : 'claimed' };
  const done = settled!;
  return { status: 'approved', sealedToken: done.sealedToken, webDeviceId: done.webDeviceId, hostPub: done.hostPub, hostDeviceId: done.hostDeviceId, hostName: done.hostName };
}

export type PairingApproval = {
  /** The desktop's refresh credential, present only when this approval (re-)registered it. A
   *  desktop that authenticated as its device keeps the credential it has. */
  hostToken?: string;
  hostDeviceId: string;
  /** In memory only: the claimant receives it sealed through its poll; it is never stored. */
  webToken: string;
  webDeviceId: string;
  webPub: PublicIdentity;
  hostPub: PublicIdentity;
};

/** Desktop decision. On approve the web client is minted (its credential delivered sealed via its
 *  claim poll) and so is the desktop, unless it is already registered: a second browser must not
 *  give the desktop a new host id, or every browser paired before it would greet a host that is
 *  gone. */
export async function resolvePairing(
  store: RelayStore,
  input: { code: string; decision: 'approve' | 'deny'; signature: string },
  now: number
): Promise<{ denied: true } | PairingApproval> {
  return withPairCode(store, input.code, () => resolvePairingUnlocked(store, input, now));
}

async function resolvePairingUnlocked(
  store: RelayStore,
  input: { code: string; decision: 'approve' | 'deny'; signature: string },
  now: number
): Promise<{ denied: true } | PairingApproval> {
  const key = codeKey(input.code);
  const record = await store.get<PairingRecord>(key);
  if (!record) throw new PairError('invalid');
  if (now >= record.expiresAt) {
    await store.delete(key);
    throw new PairError('expired');
  }
  if (record.status !== 'claimed' || !record.webPub || !record.pollTokenHash) throw new PairError('used');
  if (input.decision !== 'approve' && input.decision !== 'deny') throw new PairError('invalid');
  if (typeof input.signature !== 'string' || !input.signature) throw new PairError('forbidden');
  try {
    if (!(await verify(record.hostPub, pairingDecisionPayload(input.code, input.decision, record.webPub), input.signature))) throw new PairError('forbidden');
  } catch {
    // Bad JWKs and malformed signatures are auth failures, not internal errors.
    throw new PairError('forbidden');
  }
  if (input.decision === 'deny') {
    record.status = 'denied';
    await store.put(key, record);
    return { denied: true };
  }
  // Mint and seal the browser credential before the transaction: its plaintext never reaches
  // storage, only the hash and the ciphertext the claimant alone can open.
  const webDeviceId = newDeviceId('w');
  const webToken = randomToken();
  const sealedToken = await sealToKey(record.webPub.enc, webToken, pairingTokenContext(record.code, webDeviceId));
  return store.transaction(async (tx) => {
    const devices = (await tx.list<DeviceRecord>(`device:${record.accountId}:`)).map(([, d]) => d);
    // The signature above proves the approver holds hostPub's private key, so a registered host
    // with that key is this desktop. A pairing started with a device credential names it exactly.
    const hostKey = stable(record.hostPub);
    const existing = devices.find((d) => d.kind === 'host' && stable(d.pub) === hostKey && (!record.hostDeviceId || d.deviceId === record.hostDeviceId));
    // The enrolled desktop that started this pairing was revoked while it was pending.
    if (record.hostDeviceId && !existing) throw new PairError('invalid');
    if (devices.filter((d) => d.kind === 'web').length >= MAX_WEB_DEVICES) throw new PairError('limit');
    if (!existing && devices.filter((d) => d.kind === 'host').length >= MAX_HOST_DEVICES) throw new PairError('limit');
    let hostDeviceId: string;
    let hostToken: string | undefined;
    if (existing && record.hostDeviceId) {
      // Authenticated as this device: it keeps the credential it already holds.
      hostDeviceId = existing.deviceId;
    } else if (existing) {
      // Proved the key but came in with the enrollment secret, so it no longer holds this
      // device's credential (a reinstall that kept the keychain, a relay switched back). Keep
      // the host id every earlier browser greets; rotate the credential.
      hostDeviceId = existing.deviceId;
      hostToken = randomToken();
      await tx.put(deviceKey(record.accountId, existing.deviceId), { ...withoutGrants(existing), tokenHash: await hashToken(hostToken), lastSeen: now });
    } else {
      const minted = await registerHostDevice(tx, { accountId: record.accountId, name: record.hostName, platform: record.hostPlatform, pub: record.hostPub }, now);
      hostDeviceId = minted.deviceId;
      hostToken = minted.hostToken;
    }
    await registerWebDevice(tx, { accountId: record.accountId, name: record.webName ?? 'web', platform: record.webPlatform ?? 'web', pub: record.webPub!, hostDeviceId, deviceId: webDeviceId, token: webToken }, now);
    await tx.put(codeKey(`${record.code}:done`), { code: record.code, status: 'approved', sealedToken, webDeviceId, hostPub: record.hostPub, hostDeviceId, hostName: record.hostName, pollTokenHash: record.pollTokenHash!, expiresAt: now + PAIRING_TTL_MS } satisfies ApprovedRecord);
    await tx.delete(key);
    return { ...(hostToken ? { hostToken } : {}), hostDeviceId, webToken, webDeviceId, webPub: record.webPub!, hostPub: record.hostPub };
  });
}

function newDeviceId(prefix: 'h' | 'w'): string {
  return `${prefix}_${toBase64Url(crypto.getRandomValues(new Uint8Array(8)))}`;
}

/** A device record with every outstanding access token and challenge dropped. */
function withoutGrants(device: DeviceRecord): DeviceRecord {
  const { access: _access, challenge: _challenge, ...rest } = device;
  return rest;
}

/** Registers a web device and its refresh credential (pairing approval, and tests). */
export async function registerWebDevice(
  store: RelayStorage,
  input: { accountId: string; name: string; platform: string; pub: PublicIdentity; hostDeviceId?: string; deviceId?: string; token?: string },
  now: number
): Promise<{ webToken: string; deviceId: string }> {
  const webToken = input.token ?? randomToken();
  const id = input.deviceId ?? newDeviceId('w');
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
export async function registerHostDevice(store: RelayStorage, input: { accountId: string; name: string; platform: string; pub: PublicIdentity }, now: number): Promise<{ hostToken: string; deviceId: string }> {
  const hostToken = randomToken();
  const id = newDeviceId('h');
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
}

export async function deviceInfos(store: RelayStore, accountId: string): Promise<DeviceInfo[]> {
  return (await listDevices(store, accountId)).map((d) => ({
    deviceId: d.deviceId,
    kind: d.kind,
    name: d.name,
    platform: d.platform,
    lastSeen: d.lastSeen
  }));
}

/** Revokes a device and returns every device id that stopped existing. Revoking a desktop also
 *  revokes the browsers paired with it: they route to that host id alone, so their credentials
 *  would otherwise outlive the only thing they could reach (the lost-desktop case, §6.5). */
export async function revokeDevice(store: RelayStore, accountId: string, deviceId: string): Promise<string[]> {
  return store.transaction(async (tx) => {
    const target = await tx.get<DeviceRecord>(deviceKey(accountId, deviceId));
    const victims = [deviceId];
    if (target?.kind === 'host') {
      for (const [, device] of await tx.list<DeviceRecord>(`device:${accountId}:`)) {
        if (device.kind === 'web' && device.hostDeviceId === deviceId) victims.push(device.deviceId);
      }
    }
    for (const id of victims) {
      await tx.delete(deviceKey(accountId, id));
      await tx.delete(socketTicketKey(accountId, id));
      // A revoked browser must not leave an offline ciphertext queue behind or receive
      // it after a hibernated Hub wakes. Enqueue validates the device in a transaction.
      await tx.delete(`q:${id}`);
    }
    return victims;
  });
}

// --- offline transcript mirror (docs/REMOTE-ACCESS.md P4) ---
// The relay stores opaque sealed blobs so a paired browser can read history while the desktop is
// off. It never holds the key: only the IV, the ciphertext and plaintext routing metadata
// (session id, size, timestamp). Every entry is bounded and TTL'd so one host cannot fill the DO.

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
/** Per-blob cap, so a single transcript cannot exhaust Durable Object storage. */
const MIRROR_MAX_BYTES = 8 * 1024 * 1024;
const MIRROR_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const mirrorIndexKey = (accountId: string, hostId: string) => `mirror:${accountId}:${hostId}:index`;
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

/** base64 length → decoded byte length, without decoding. */
function sealedBytes(blob: MirrorBlob): number {
  return Math.floor((blob.ct.length * 3) / 4);
}

/** Stores the sealed session index the browser's offline sidebar renders. */
export async function putMirrorIndex(store: RelayStore, input: { accountId: string; hostId: string; blob: MirrorBlob }, now: number): Promise<void> {
  if (sealedBytes(input.blob) > MIRROR_MAX_BYTES) throw new MirrorError('too-large');
  await store.put<MirrorIndexRecord>(mirrorIndexKey(input.accountId, input.hostId), { blob: input.blob, updatedAt: now });
  await pruneMirror(store, input.accountId, input.hostId, now);
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
  if (sealedBytes(input.blob) > MIRROR_MAX_BYTES) throw new MirrorError('too-large');
  await store.put<MirrorSessionRecord>(mirrorSessionKey(input.accountId, input.hostId, input.sessionId), {
    blob: input.blob,
    updatedAt: now,
    bytes: sealedBytes(input.blob)
  });
  await pruneMirror(store, input.accountId, input.hostId, now);
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
    await store.delete(mirrorSessionKey(input.accountId, input.hostId, input.sessionId));
    return undefined;
  }
  return record.blob;
}

/** Plaintext routing metadata only: the session id, when it last changed and its size. */
export async function listMirrorSessions(store: RelayStore, accountId: string, hostId: string, now: number): Promise<MirrorSessionMeta[]> {
  const entries = await store.list<MirrorSessionRecord>(mirrorPrefix(accountId, hostId));
  const prefixLength = mirrorPrefix(accountId, hostId).length;
  const out: MirrorSessionMeta[] = [];
  for (const [key, record] of entries) {
    if (now - record.updatedAt > MIRROR_TTL_MS) {
      await store.delete(key);
      continue;
    }
    out.push({ sessionId: key.slice(prefixLength), updatedAt: record.updatedAt, bytes: record.bytes });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteMirrorSession(store: RelayStore, accountId: string, hostId: string, sessionId: string): Promise<void> {
  await store.delete(mirrorSessionKey(accountId, hostId, sessionId));
}

/** Drops the whole mirror for a host — used when the user disables mirroring. */
export async function clearMirror(store: RelayStore, accountId: string, hostId: string): Promise<void> {
  const entries = await store.list<MirrorSessionRecord>(mirrorPrefix(accountId, hostId));
  for (const [key] of entries) await store.delete(key);
  await store.delete(mirrorIndexKey(accountId, hostId));
}

/** Deletes expired entries and trims the oldest sessions past the budget. */
async function pruneMirror(store: RelayStore, accountId: string, hostId: string, now: number): Promise<void> {
  const entries = await store.list<MirrorSessionRecord>(mirrorPrefix(accountId, hostId));
  const live: Array<[string, MirrorSessionRecord]> = [];
  for (const [key, record] of entries) {
    if (now - record.updatedAt > MIRROR_TTL_MS) await store.delete(key);
    else live.push([key, record]);
  }
  if (live.length > MIRROR_MAX_SESSIONS) {
    live.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [key] of live.slice(0, live.length - MIRROR_MAX_SESSIONS)) await store.delete(key);
  }
  const index = await store.get<MirrorIndexRecord>(mirrorIndexKey(accountId, hostId));
  if (index && now - index.updatedAt > MIRROR_TTL_MS) await store.delete(mirrorIndexKey(accountId, hostId));
}

async function sweepExpired(store: RelayStore, now: number): Promise<void> {
  const pairs = await store.list<PairingRecord>('pair:');
  for (const [key, record] of pairs) {
    if (now >= record.expiresAt) await store.delete(key);
  }
}
