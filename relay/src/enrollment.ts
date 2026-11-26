/** Owner actions: "Connect with Vocs" enrollment grants and redemption.
 *  The owner is whoever holds the enrollment secret: in production the landing Worker, acting for
 *  a GitHub session on its allowlist. A desktop that clicked Connect with Vocs holds a one-time
 *  secret (the nonce) and opens the web client with only its SHA-256; the owner grants that hash,
 *  and the desktop redeems the nonce for its credential, sealed to its own key. */
import { enrollTokenContext, sealToKey, stable, type PublicIdentity, type SealedToKey } from '../../src/shared/crypto';
import {
  deviceKey,
  epochValue,
  hashToken,
  listDevices,
  MAX_HOST_DEVICES,
  newDeviceId,
  PairError,
  randomToken,
  registerHostDevice,
  revocationEpoch,
  withoutGrants,
  withStoreKeyLock,
  type DeviceRecord
} from './devices';
import type { RelayStore } from './storage';

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
  /** The account's revocation epoch when the owner granted it (absent on older records: 0). */
  epoch?: number;
}

const enrollKey = (accountId: string, nonceHash: string) => `enroll:${accountId}:${nonceHash}`;

/** A grant counts only until it expires and only under the epoch it was issued in: one written
 *  across a revoke all is as gone as one revoke all deleted, for redemption and reporting alike. */
function liveGrant(record: EnrollGrantRecord | undefined, epoch: number, now: number): record is EnrollGrantRecord {
  return !!record && now < record.expiresAt && epochValue(record.epoch) === epoch;
}

/** The owner approves the desktop that holds the nonce behind `nonceHash`. `epoch` is the revocation
 *  epoch the caller read before it began granting (and bound the directory pointer under): a
 *  revoke all in between leaves this grant unredeemable, and reported as missing. */
export async function grantEnrollment(store: RelayStore, input: { accountId: string; nonceHash: string; epoch?: number }, now: number): Promise<{ expiresAt: number }> {
  if (typeof input.nonceHash !== 'string' || !NONCE_HASH.test(input.nonceHash)) throw new PairError('invalid');
  const key = enrollKey(input.accountId, input.nonceHash);
  const current = await revocationEpoch(store, input.accountId);
  const existing = await store.get<EnrollGrantRecord>(key);
  if (existing?.status === 'redeemed' && liveGrant(existing, current, now)) throw new PairError('used');
  const epoch = input.epoch ?? current;
  const record: EnrollGrantRecord = { nonceHash: input.nonceHash, status: 'granted', expiresAt: now + ENROLL_GRANT_TTL_MS, epoch };
  await store.put(key, record);
  for (const [stale, grant] of await store.list<EnrollGrantRecord>(`enroll:${input.accountId}:`)) {
    if (stale !== key && !liveGrant(grant, current, now)) await store.delete(stale);
  }
  return { expiresAt: record.expiresAt };
}

/** Where an owner's grant stands, so the page that granted it can pair with the new computer. A
 *  grant from before the last revoke all reads as missing: it can never be redeemed. */
export async function enrollmentStatus(store: RelayStore, input: { accountId: string; nonceHash: string }, now: number): Promise<{ status: 'missing' | 'granted' | 'redeemed'; hostDeviceId?: string; hostName?: string }> {
  if (typeof input.nonceHash !== 'string' || !NONCE_HASH.test(input.nonceHash)) throw new PairError('invalid');
  const record = await store.get<EnrollGrantRecord>(enrollKey(input.accountId, input.nonceHash));
  if (!liveGrant(record, await revocationEpoch(store, input.accountId), now)) return { status: 'missing' };
  return record.status === 'redeemed' ? { status: 'redeemed', hostDeviceId: record.hostDeviceId, hostName: record.hostName } : { status: 'granted' };
}

export type Redemption = { status: 'pending' } | { status: 'registered'; hostDeviceId: string; sealedToken: SealedToKey };

/** The desktop proves it holds the granted nonce and receives its refresh credential, sealed to the
 *  encryption key it registers. Before the owner grants it the answer is `pending`, which is also
 *  what an unknown, expired or revoked nonce gets: the endpoint is public and reveals nothing. A
 *  desktop key the relay already knows keeps its host id (every browser paired with it greets that
 *  id); only its credential is rotated. `bindingEpoch` is the revocation epoch the enrollment
 *  directory's pointer was bound under, when the redemption arrived through the directory. */
export async function redeemEnrollment(
  store: RelayStore,
  input: { accountId: string; nonce: string; hostPub: PublicIdentity; name: string; platform: string; deviceRouteSecret?: string; bindingEpoch?: number },
  now: number
): Promise<Redemption> {
  if (typeof input.nonce !== 'string' || !NONCE.test(input.nonce)) throw new PairError('invalid');
  const nonceHash = await hashToken(input.nonce);
  const key = enrollKey(input.accountId, nonceHash);
  return withStoreKeyLock(store, key, async () => {
    const record = await store.get<EnrollGrantRecord>(key);
    const epoch = await revocationEpoch(store, input.accountId);
    if (!liveGrant(record, epoch, now) || (input.bindingEpoch !== undefined && input.bindingEpoch !== epoch)) return { status: 'pending' };
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
    const minted = await store.transaction(async (tx) => {
      // A revoke all may have retired this grant while the credential was being sealed: mint only
      // from the exact grant read above, still stored and still under the current epoch.
      const current = await tx.get<EnrollGrantRecord>(key);
      if (!current || stable(current) !== stable(record)) return false;
      if ((await revocationEpoch(tx, input.accountId)) !== epoch) return false;
      const devices = (await tx.list<DeviceRecord>(`device:${input.accountId}:`)).map(([, d]) => d);
      const existing = devices.find((d) => d.deviceId === hostDeviceId);
      if (existing) {
        await tx.put(deviceKey(input.accountId, hostDeviceId), { ...withoutGrants(existing), tokenHash: await hashToken(hostToken), lastSeen: now });
      } else {
        if (devices.filter((d) => d.kind === 'host').length >= MAX_HOST_DEVICES) throw new PairError('limit');
        await registerHostDevice(tx, { accountId: input.accountId, name: input.name, platform: input.platform, pub: input.hostPub, deviceId: hostDeviceId, token: hostToken, deviceRouteSecret: input.deviceRouteSecret }, now);
      }
      await tx.put(key, { ...record, status: 'redeemed', hostDeviceId, hostName: existing?.name ?? input.name, sealedToken } satisfies EnrollGrantRecord);
      return true;
    });
    if (!minted) return { status: 'pending' };
    return { status: 'registered', hostDeviceId, sealedToken };
  });
}
