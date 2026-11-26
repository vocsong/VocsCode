/** Pairing state machine: code minting, claiming, browser-initiated requests, polling, and resolution. */
import { pairingDecisionPayload, pairingTokenContext, sealToKey, stable, verify, type PublicIdentity, type SealedToKey } from '../../src/shared/crypto';
import {
  deviceKey,
  epochValue,
  hashToken,
  listDevices,
  MAX_HOST_DEVICES,
  MAX_WEB_DEVICES,
  newDeviceId,
  PairError,
  randomToken,
  registerHostDevice,
  registerWebDevice,
  revocationEpoch,
  withoutGrants,
  withStoreKeyLock,
  type DeviceRecord
} from './devices';
import type { RelayStore } from './storage';

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
  /** The account's revocation epoch when the pairing started (absent on older records: 0). */
  epoch?: number;
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

/** 31 symbols, no ambiguous glyphs (I/L/O/0/1); 8 chars ≈ 2^39.7. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_TTL_MS = 5 * 60_000;

const codeKey = (code: string) => `pair:${code}`;

function randomCode(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

async function sweepExpired(store: RelayStore, now: number): Promise<void> {
  const pairs = await store.list<PairingRecord>('pair:');
  for (const [key, record] of pairs) {
    if (now >= record.expiresAt) await store.delete(key);
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
    expiresAt: now + PAIRING_TTL_MS,
    epoch: await revocationEpoch(store, input.accountId)
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
  return withStoreKeyLock(store, input.code, () => claimPairingUnlocked(store, input, now));
}

async function claimPairingUnlocked(
  store: RelayStore,
  input: { code: string; webName: string; webPlatform: string; webPub: PublicIdentity },
  now: number
): Promise<{ pollToken: string; hostPub: PublicIdentity }> {
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
  return withStoreKeyLock(store, input.code, () => resolvePairingUnlocked(store, input, now, deviceRouteSecret));
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
    // Everything above ran outside this transaction, and a revoke all, an expiry sweep or a
    // replaced claim may have landed since. Mint only from the exact claim that was signed, still
    // stored and still under the account's current revocation epoch; deleting it below is part of
    // this same commit, so it is consumed exactly once.
    const current = await tx.get<PairingRecord>(key);
    if (!current || stable(current) !== stable(record)) throw new PairError('invalid');
    if (epochValue(current.epoch) !== (await revocationEpoch(tx, record.accountId))) throw new PairError('invalid');
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
    expiresAt: now + PAIRING_TTL_MS,
    epoch: await revocationEpoch(store, input.accountId)
  };
  await store.put(codeKey(record.code), record);
  await sweepExpired(store, now);
  return { code: record.code, pollToken, hostPub: host.pub, hostName: host.name };
}
