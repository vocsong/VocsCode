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

import { enrollTokenContext, pairingDecisionPayload, pairingTokenContext, sealToKey, stable, tokenProofPayload, verify, type PublicIdentity, type SealedToKey } from '../../src/shared/crypto';
import { createDeviceId } from './account';

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
  now: number,
  deviceRouteSecret?: string
): Promise<{ denied: true } | PairingApproval> {
  return withPairCode(store, input.code, () => resolvePairingUnlocked(store, input, now, deviceRouteSecret));
}

async function resolvePairingUnlocked(
  store: RelayStore,
  input: { code: string; decision: 'approve' | 'deny'; signature: string },
  now: number,
  deviceRouteSecret?: string
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
  const webDeviceId = await newDeviceId('w', record.accountId, deviceRouteSecret);
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
      const minted = await registerHostDevice(tx, { accountId: record.accountId, name: record.hostName, platform: record.hostPlatform, pub: record.hostPub, deviceRouteSecret }, now);
      hostDeviceId = minted.deviceId;
      hostToken = minted.hostToken;
    }
    await registerWebDevice(tx, { accountId: record.accountId, name: record.webName ?? 'web', platform: record.webPlatform ?? 'web', pub: record.webPub!, hostDeviceId, deviceId: webDeviceId, token: webToken, deviceRouteSecret }, now);
    await tx.put(codeKey(`${record.code}:done`), { code: record.code, status: 'approved', sealedToken, webDeviceId, hostPub: record.hostPub, hostDeviceId, hostName: record.hostName, pollTokenHash: record.pollTokenHash!, expiresAt: now + PAIRING_TTL_MS } satisfies ApprovedRecord);
    await tx.delete(key);
    return { ...(hostToken ? { hostToken } : {}), hostDeviceId, webToken, webDeviceId, webPub: record.webPub!, hostPub: record.hostPub };
  });
}

async function newDeviceId(prefix: 'h' | 'w', accountId: string, deviceRouteSecret?: string): Promise<string> {
  // Production routes pass the relay-only secret so account ids are MACed before they become
  // routing hints. Pure core tests without a Worker keep the historical opaque format.
  if (deviceRouteSecret) return createDeviceId(prefix, accountId, deviceRouteSecret);
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
export async function registerHostDevice(store: RelayStorage, input: { accountId: string; name: string; platform: string; pub: PublicIdentity; deviceId?: string; token?: string; deviceRouteSecret?: string }, now: number): Promise<{ hostToken: string; deviceId: string }> {
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

// --- Owner actions: "Connect with GitHub" enrollment and browser-initiated pairing ---
//
// The owner is whoever holds the enrollment secret: in production the landing Worker, acting for
// a GitHub session on its allowlist. A desktop that clicked Connect with GitHub holds a one-time
// secret (the nonce) and opens the web client with only its SHA-256; the owner grants that hash,
// and the desktop redeems the nonce for its credential, sealed to its own key.

/** How long an owner's grant waits for the desktop to redeem it. */
export const ENROLL_GRANT_TTL_MS = 10 * 60_000;
const NONCE_HASH = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;

interface EnrollGrantRecord {
  nonceHash: string;
  status: 'granted' | 'redeemed';
  /** Filled at redemption; the sealed credential stays so a desktop whose response was lost can
   *  redeem again, until the grant expires. */
  hostDeviceId?: string;
  hostName?: string;
  sealedToken?: SealedToKey;
  expiresAt: number;
}

const enrollKey = (accountId: string, nonceHash: string) => `enroll:${accountId}:${nonceHash}`;

/** The owner approves the desktop that holds the nonce behind `nonceHash`. */
export async function grantEnrollment(store: RelayStore, input: { accountId: string; nonceHash: string }, now: number): Promise<{ expiresAt: number }> {
  if (typeof input.nonceHash !== 'string' || !NONCE_HASH.test(input.nonceHash)) throw new PairError('invalid');
  const key = enrollKey(input.accountId, input.nonceHash);
  const existing = await store.get<EnrollGrantRecord>(key);
  if (existing?.status === 'redeemed' && now < existing.expiresAt) throw new PairError('used');
  const record: EnrollGrantRecord = { nonceHash: input.nonceHash, status: 'granted', expiresAt: now + ENROLL_GRANT_TTL_MS };
  await store.put(key, record);
  for (const [stale, grant] of await store.list<EnrollGrantRecord>(`enroll:${input.accountId}:`)) {
    if (now >= grant.expiresAt) await store.delete(stale);
  }
  return { expiresAt: record.expiresAt };
}

/** Where an owner's grant stands, so the page that granted it can pair with the new computer. */
export async function enrollmentStatus(store: RelayStore, input: { accountId: string; nonceHash: string }, now: number): Promise<{ status: 'missing' | 'granted' | 'redeemed'; hostDeviceId?: string; hostName?: string }> {
  if (typeof input.nonceHash !== 'string' || !NONCE_HASH.test(input.nonceHash)) throw new PairError('invalid');
  const record = await store.get<EnrollGrantRecord>(enrollKey(input.accountId, input.nonceHash));
  if (!record || now >= record.expiresAt) return { status: 'missing' };
  return record.status === 'redeemed' ? { status: 'redeemed', hostDeviceId: record.hostDeviceId, hostName: record.hostName } : { status: 'granted' };
}

export type Redemption = { status: 'pending' } | { status: 'registered'; hostDeviceId: string; sealedToken: SealedToKey };

/** The desktop proves it holds the granted nonce and receives its refresh credential, sealed to the
 *  encryption key it registers. Before the owner grants it the answer is `pending`, which is also
 *  what an unknown or expired nonce gets: the endpoint is public and reveals nothing. A desktop key
 *  the relay already knows keeps its host id (every browser paired with it greets that id); only
 *  its credential is rotated. */
export async function redeemEnrollment(
  store: RelayStore,
  input: { accountId: string; nonce: string; hostPub: PublicIdentity; name: string; platform: string; deviceRouteSecret?: string },
  now: number
): Promise<Redemption> {
  if (typeof input.nonce !== 'string' || !NONCE.test(input.nonce)) throw new PairError('invalid');
  const nonceHash = await hashToken(input.nonce);
  const key = enrollKey(input.accountId, nonceHash);
  return withPairCode(store, key, async () => {
    const record = await store.get<EnrollGrantRecord>(key);
    if (!record || now >= record.expiresAt) return { status: 'pending' };
    if (record.status === 'redeemed') {
      if (!record.sealedToken || !record.hostDeviceId) return { status: 'pending' };
      // Same nonce, same sealed credential: only the key that registered can open it.
      const device = await store.get<DeviceRecord>(deviceKey(input.accountId, record.hostDeviceId));
      if (!device || stable(device.pub) !== stable(input.hostPub)) throw new PairError('forbidden');
      return { status: 'registered', hostDeviceId: record.hostDeviceId, sealedToken: record.sealedToken };
    }
    const hostKey = stable(input.hostPub);
    const known = (await listDevices(store, input.accountId)).find((d) => d.kind === 'host' && stable(d.pub) === hostKey);
    const hostDeviceId = known?.deviceId ?? await newDeviceId('h', input.accountId, input.deviceRouteSecret);
    const hostToken = randomToken();
    // Sealed before the transaction, like a browser's credential: the plaintext never reaches storage.
    const sealedToken = await sealToKey(input.hostPub.enc, hostToken, enrollTokenContext(nonceHash, hostDeviceId));
    await store.transaction(async (tx) => {
      const devices = (await tx.list<DeviceRecord>(`device:${input.accountId}:`)).map(([, d]) => d);
      const existing = devices.find((d) => d.deviceId === hostDeviceId);
      if (existing) {
        await tx.put(deviceKey(input.accountId, hostDeviceId), { ...withoutGrants(existing), tokenHash: await hashToken(hostToken), lastSeen: now });
      } else {
        if (devices.filter((d) => d.kind === 'host').length >= MAX_HOST_DEVICES) throw new PairError('limit');
        await registerHostDevice(tx, { accountId: input.accountId, name: input.name, platform: input.platform, pub: input.hostPub, deviceId: hostDeviceId, token: hostToken, deviceRouteSecret: input.deviceRouteSecret }, now);
      }
      await tx.put(key, { ...record, status: 'redeemed', hostDeviceId, hostName: existing?.name ?? input.name, sealedToken } satisfies EnrollGrantRecord);
    });
    return { status: 'registered', hostDeviceId, sealedToken };
  });
}

/** A signed-in owner asks a registered desktop to pair this browser: the claim step of a code
 *  pairing, started from the browser. The desktop still shows the request and signs Allow or Deny;
 *  the browser then polls with its capability exactly as after a claim. */
export async function requestPairing(
  store: RelayStore,
  input: { accountId: string; hostDeviceId: string; webName: string; webPlatform: string; webPub: PublicIdentity },
  now: number
): Promise<{ code: string; pollToken: string; hostPub: PublicIdentity; hostName: string }> {
  const host = await store.get<DeviceRecord>(deviceKey(input.accountId, input.hostDeviceId));
  if (!host || host.kind !== 'host') throw new PairError('not-found');
  if ((await listDevices(store, input.accountId)).filter((d) => d.kind === 'web').length >= MAX_WEB_DEVICES) throw new PairError('limit');
  const pollToken = randomToken();
  const record: PairingRecord = {
    code: randomCode(),
    accountId: input.accountId,
    hostName: host.name,
    hostPlatform: host.platform,
    hostPub: host.pub,
    hostDeviceId: host.deviceId,
    status: 'claimed',
    webName: input.webName,
    webPlatform: input.webPlatform,
    webPub: input.webPub,
    pollTokenHash: await hashToken(pollToken),
    expiresAt: now + PAIRING_TTL_MS
  };
  await store.put(codeKey(record.code), record);
  await sweepExpired(store, now);
  return { code: record.code, pollToken, hostPub: host.pub, hostName: host.name };
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
 *  revoked desktop's offline mirror goes too. */
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
  for (const host of hosts) await clearMirror(store, accountId, host);
  return victims;
}

/** The kill switch (§6.5): every device of the account except the desktop pulling it — each
 *  browser and every other computer — plus pending pairings and the mirrors of revoked hosts. The
 *  caller keeps its identity and its own mirror, which it re-keys. */
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
    for (const [key] of await tx.list<PairingRecord>('pair:')) await tx.delete(key);
    return { victims, hosts };
  });
  for (const host of hosts) await clearMirror(store, accountId, host);
  return victims;
}

async function deleteDevice(tx: RelayStorage, accountId: string, id: string): Promise<void> {
  await tx.delete(deviceKey(accountId, id));
  await tx.delete(socketTicketKey(accountId, id));
  // A revoked browser must not leave an offline ciphertext queue behind or receive it after a
  // hibernated Hub wakes. Enqueue validates the device in a transaction.
  await tx.delete(`q:${id}`);
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

async function sweepExpired(store: RelayStore, now: number): Promise<void> {
  const pairs = await store.list<PairingRecord>('pair:');
  for (const [key, record] of pairs) {
    if (now >= record.expiresAt) await store.delete(key);
  }
}
