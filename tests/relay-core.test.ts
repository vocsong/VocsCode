/** Unit tests for the relay core (relay/src/core.ts): pairing lifecycle, tokens, revocation.
 *  Runs in plain Node against an in-memory store — the DO is a thin binding over this. */
import { describe, expect, it } from 'vitest';
import { claimPairing, hashToken, listDevices, PAIRING_TTL_MS, pollPairing, registerHostDevice, registerWebDevice, resolvePairing, revokeDevice, startPairing, verifyDeviceToken, PairError, type RelayStore } from '../relay/src/core';
import type { PublicIdentity } from '../src/shared/crypto';

function memStore(): RelayStore {
  const map = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => map.get(k) as T | undefined,
    put: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    list: async <T,>(prefix: string) => [...map.entries()].filter(([k]) => k.startsWith(prefix)) as Array<[string, T]>
  };
}

const HOST_PUB = { sig: { kty: "EC", crv: "P-256", x: "a", y: "b" }, enc: { kty: "EC", crv: "P-256", x: "c", y: "d" } } as PublicIdentity;
const WEB_PUB = { sig: { kty: 'EC', crv: 'P-256', x: 'e', y: 'f' }, enc: { kty: 'EC', crv: 'P-256', x: 'g', y: 'h' } } as PublicIdentity;
const T0 = 1_700_000_000_000;

describe('relay pairing', () => {
  it('runs the full pairing lifecycle: start → claim → approve → tokens', async () => {
    const store = memStore();
    const { code, expiresAt } = await startPairing(store, { accountId: 'vocs-v1', hostName: 'Work PC', hostPlatform: 'win32', hostPub: HOST_PUB }, T0);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(expiresAt).toBe(T0 + PAIRING_TTL_MS);

    expect(await pollPairing(store, code, T0)).toEqual({ status: 'pending' });
    await claimPairing(store, { code, webName: 'Chrome', webPlatform: 'mac', webPub: WEB_PUB }, T0);
    expect(await pollPairing(store, code, T0)).toEqual({ status: 'claimed' });

    const resolved = await resolvePairing(store, { code, decision: 'approve' }, T0 + 1);
    if ('denied' in resolved) throw new Error('expected approval');
    expect(resolved.hostToken).toHaveLength(43); // 32 bytes base64url
    expect(resolved.webDeviceId.startsWith('w_')).toBe(true);

    const poll = await pollPairing(store, code, T0 + 2);
    expect(poll.status).toBe('approved');
    if (poll.status !== 'approved') throw new Error('unreachable');
    expect(poll.webToken).toBe(resolved.webToken);
    expect(poll.webDeviceId).toBe(resolved.webDeviceId);
    expect(poll.hostPub).toEqual(HOST_PUB);

    const devices = await listDevices(store, 'vocs-v1');
    expect(devices.map((d) => d.kind).sort()).toEqual(['host', 'web']);
    expect(devices.find((d) => d.kind === 'host')?.pub).toEqual(HOST_PUB);
  });

  it('rejects a denied code and reports denial to the web poll', async () => {
    const store = memStore();
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'h', hostPlatform: '', hostPub: HOST_PUB }, T0);
    await claimPairing(store, { code, webName: 'w', webPlatform: '', webPub: WEB_PUB }, T0);
    const resolved = await resolvePairing(store, { code, decision: 'deny' }, T0 + 1);
    expect(resolved).toEqual({ denied: true });
    expect(await pollPairing(store, code, T0 + 2)).toEqual({ status: 'denied' });
    expect(await listDevices(store, 'a')).toEqual([]);
  });

  it('expires codes after the TTL and reports expired to both sides', async () => {
    const store = memStore();
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'h', hostPlatform: '', hostPub: HOST_PUB }, T0);
    const late = T0 + PAIRING_TTL_MS + 1;
    await expect(claimPairing(store, { code, webName: 'w', webPlatform: '', webPub: WEB_PUB }, late)).rejects.toMatchObject({ code: 'expired' });
    expect(await pollPairing(store, code, late)).toEqual({ status: 'expired' });
  });

  it('refuses double claims and double resolutions', async () => {
    const store = memStore();
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'h', hostPlatform: '', hostPub: HOST_PUB }, T0);
    await claimPairing(store, { code, webName: 'w', webPlatform: '', webPub: WEB_PUB }, T0);
    await expect(claimPairing(store, { code, webName: 'w2', webPlatform: '', webPub: WEB_PUB }, T0)).rejects.toBeInstanceOf(PairError);
    await resolvePairing(store, { code, decision: 'approve' }, T0 + 1);
    await expect(resolvePairing(store, { code, decision: 'approve' }, T0 + 2)).rejects.toBeInstanceOf(PairError);
  });

  it('verifies device tokens and rejects wrong ones', async () => {
    const store = memStore();
    const { hostToken, deviceId } = await registerHostDevice(store, { accountId: 'a', name: 'h', platform: 'win', pub: HOST_PUB }, T0);
    const device = await verifyDeviceToken(store, { accountId: 'a', deviceId, token: hostToken }, T0 + 1);
    expect(device.name).toBe('h');
    await expect(verifyDeviceToken(store, { accountId: 'a', deviceId, token: 'wrong' }, T0 + 1)).rejects.toBeInstanceOf(PairError);
    await expect(verifyDeviceToken(store, { accountId: 'a', deviceId: 'nope', token: hostToken }, T0 + 1)).rejects.toBeInstanceOf(PairError);
  });

  it('revokes devices so their tokens stop verifying', async () => {
    const store = memStore();
    const { webToken, deviceId } = await registerWebDevice(store, { accountId: 'a', name: 'w', platform: 'web', pub: WEB_PUB }, T0);
    await verifyDeviceToken(store, { accountId: 'a', deviceId, token: webToken }, T0 + 1);
    await revokeDevice(store, 'a', deviceId);
    await expect(verifyDeviceToken(store, { accountId: 'a', deviceId, token: webToken }, T0 + 2)).rejects.toBeInstanceOf(PairError);
  });

  it('hashes tokens with sha-256 and never stores plaintext', async () => {
    const store = memStore();
    const { hostToken } = await registerHostDevice(store, { accountId: 'a', name: 'h', platform: '', pub: HOST_PUB }, T0);
    const entries = await store.list('device:a:');
    expect(JSON.stringify([...entries])).not.toContain(hostToken);
    expect(await hashToken(hostToken)).toMatch(/^[0-9a-f]{64}$/);
  });
});
