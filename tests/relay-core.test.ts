/** Unit tests for the relay core (relay/src/core.ts): pairing lifecycle, tokens, revocation.
 *  Runs in plain Node against an in-memory store — the DO is a thin binding over this. */
import { beforeAll, describe, expect, it } from 'vitest';
import { enrollTokenContext, generateIdentity, openSealedToKey, pairingDecisionPayload, pairingTokenContext, publicOf, sign, tokenProofPayload, type Identity } from '../src/shared/crypto';
import { ACCESS_TTL_MS, CHALLENGE_TTL_MS, claimPairing, ENROLL_GRANT_TTL_MS, enrollmentStatus, grantEnrollment, redeemEnrollment, requestPairing, consumeSocketTicket, deleteMirrorSession, deviceInfos, hashToken, issueAccessToken, issueChallenge, issueSocketTicket, listDevices, listMirrorSessions, MAX_HOST_DEVICES, MAX_WEB_DEVICES, MIRROR_MAX_BLOB_CHARS, MirrorError, PAIRING_TTL_MS, revokeAllExcept, pollPairing, putMirrorIndex, putMirrorSession, getMirrorIndex, getMirrorSession, clearMirror, registerHostDevice, registerWebDevice, resolvePairing, revokeDevice, SOCKET_TICKET_TTL_MS, startPairing, verifyAccessToken, verifyRefreshToken, PairError, type RelayStorage, type RelayStore } from '../relay/src/core';
import { accessFor, testDevice } from './support/relay-auth';
import type { PublicIdentity } from '../src/shared/crypto';

function memStore(failWrite?: (key: string) => boolean): RelayStore {
  const map = new Map<string, unknown>();
  let tail = Promise.resolve();
  const adapt = (target: Map<string, unknown>): RelayStorage => ({
    // DO storage deserializes on read. Returning the same object would mask competing claims.
    get: async <T,>(k: string) => target.has(k) ? structuredClone(target.get(k)) as T : undefined,
    put: async (k, v) => {
      if (failWrite?.(k)) throw new Error('injected storage failure');
      target.set(k, structuredClone(v));
    },
    delete: async (k) => {
      if (failWrite?.(k)) throw new Error('injected storage failure');
      target.delete(k);
    },
    list: async <T,>(prefix: string) => [...target.entries()].filter(([k]) => k.startsWith(prefix)) as Array<[string, T]>
  });
  return {
    ...adapt(map),
    transaction: async (work) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const staged = new Map(structuredClone([...map]));
        const result = await work(adapt(staged));
        map.clear();
        for (const [key, value] of staged) map.set(key, value);
        return result;
      } finally {
        release();
      }
    }
  };
}

let hostIdentity: Identity;
let HOST_PUB: PublicIdentity;
let WEB_PUB: PublicIdentity;
const T0 = 1_700_000_000_000;
beforeAll(async () => {
  hostIdentity = await generateIdentity();
  HOST_PUB = publicOf(hostIdentity);
  WEB_PUB = publicOf(await generateIdentity());
});
const approval = async (code: string, decision: 'approve' | 'deny') => ({ code, decision, signature: await sign(hostIdentity, pairingDecisionPayload(code, decision, WEB_PUB)) });

describe('relay pairing', () => {
  it('requires the claiming browser poll capability and the owning desktop signature before minting', async () => {
    const store = memStore();
    const host = await generateIdentity();
    const stranger = await generateIdentity();
    const web = await generateIdentity();
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'owner', hostPlatform: '', hostPub: publicOf(host) }, T0);
    const claim = await claimPairing(store, { code, webName: 'browser', webPlatform: '', webPub: publicOf(web) }, T0);
    expect(claim).toHaveProperty('pollToken');
    const pollToken = (claim as { pollToken: string }).pollToken;
    expect(JSON.stringify(await store.list('pair:'))).not.toContain(pollToken);
    await expect(pollPairing(store, code, '', T0)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(pollPairing(store, code, 'wrong', T0)).rejects.toMatchObject({ code: 'forbidden' });
    const payload = pairingDecisionPayload(code, 'approve', publicOf(web));
    const wrongSignature = await sign(stranger, payload);
    await expect(resolvePairing(store, { code, decision: 'approve', signature: wrongSignature }, T0)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolvePairing(store, { code, decision: undefined, signature: await sign(host, payload) } as never, T0)).rejects.toMatchObject({ code: 'invalid' });
    expect(await listDevices(store, 'a')).toEqual([]);
    const signature = await sign(host, payload);
    const approved = await resolvePairing(store, { code, decision: 'approve', signature }, T0 + 1);
    expect('denied' in approved).toBe(false);
    await expect(pollPairing(store, code, '', T0 + 2)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(pollPairing(store, code, 'wrong', T0 + 2)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await pollPairing(store, code, pollToken, T0 + 2)).toMatchObject({ status: 'approved' });
  });
  it('serializes competing claims so only one browser obtains the poll capability', async () => {
    const store = memStore();
    const first = await generateIdentity();
    const second = await generateIdentity();
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'owner', hostPlatform: '', hostPub: HOST_PUB }, T0);
    const results = await Promise.all([
      claimPairing(store, { code, webName: 'first', webPlatform: '', webPub: publicOf(first) }, T0).then((value) => ({ ok: true as const, value, webPub: publicOf(first) }), (error: unknown) => ({ ok: false as const, error })),
      claimPairing(store, { code, webName: 'second', webPlatform: '', webPub: publicOf(second) }, T0).then((value) => ({ ok: true as const, value, webPub: publicOf(second) }), (error: unknown) => ({ ok: false as const, error }))
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect((results.find((result) => !result.ok) as { error: unknown }).error).toMatchObject({ code: 'used' });
    const winner = results.find((result) => result.ok) as { value: { pollToken: string }; webPub: PublicIdentity };
    expect(await pollPairing(store, code, winner.value.pollToken, T0)).toEqual({ status: 'claimed' });
    const signature = await sign(hostIdentity, pairingDecisionPayload(code, 'approve', winner.webPub));
    const resolved = await resolvePairing(store, { code, decision: 'approve', signature }, T0 + 1);
    expect('denied' in resolved).toBe(false);
    expect((await listDevices(store, 'a')).find((device) => device.kind === 'web')?.pub).toEqual(winner.webPub);
  });

  it('serializes two concurrent signed approvals so exactly one pair is minted', async () => {
    const store = memStore();
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'owner', hostPlatform: '', hostPub: HOST_PUB }, T0);
    const { pollToken } = await claimPairing(store, { code, webName: 'web', webPlatform: '', webPub: WEB_PUB }, T0);
    const input = await approval(code, 'approve');
    const results = await Promise.all([
      resolvePairing(store, input, T0 + 1).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })),
      resolvePairing(store, input, T0 + 1).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect((results.find((result) => !result.ok) as { error: unknown }).error).toBeInstanceOf(PairError);
    const minted = results.find((result) => result.ok) as { value: { webToken: string; webDeviceId: string; hostDeviceId: string } };
    expect((await listDevices(store, 'a')).map((device) => device.kind).sort()).toEqual(['host', 'web']);
    expect(await pollPairing(store, code, pollToken, T0 + 2)).toMatchObject({ status: 'approved', webDeviceId: minted.value.webDeviceId, hostDeviceId: minted.value.hostDeviceId });
  });

  it.each(['device:a:w_', 'pair:done'])('rolls back an approval when %s cannot be stored', async (failure) => {
    let failOnce = true;
    const store = memStore((key) => {
      const matches = failure === 'pair:done' ? key.endsWith(':done') : key.startsWith(failure);
      if (!matches || !failOnce) return false;
      failOnce = false;
      return true;
    });
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'owner', hostPlatform: '', hostPub: HOST_PUB }, T0);
    const { pollToken } = await claimPairing(store, { code, webName: 'web', webPlatform: '', webPub: WEB_PUB }, T0);
    const input = await approval(code, 'approve');
    await expect(resolvePairing(store, input, T0 + 1)).rejects.toThrow('injected storage failure');
    expect(await listDevices(store, 'a')).toEqual([]);
    expect(await pollPairing(store, code, pollToken, T0 + 2)).toEqual({ status: 'claimed' });
    await resolvePairing(store, input, T0 + 3);
    expect((await listDevices(store, 'a')).map((device) => device.kind).sort()).toEqual(['host', 'web']);
  });

  it('rejects unsigned or incorrectly signed denial without consuming the claim', async () => {
    const store = memStore();
    const stranger = await generateIdentity();
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'owner', hostPlatform: '', hostPub: HOST_PUB }, T0);
    const { pollToken } = await claimPairing(store, { code, webName: 'web', webPlatform: '', webPub: WEB_PUB }, T0);
    await expect(resolvePairing(store, { code, decision: 'deny', signature: '' }, T0)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolvePairing(store, { code, decision: 'deny', signature: await sign(stranger, pairingDecisionPayload(code, 'deny', WEB_PUB)) }, T0)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolvePairing(store, { code, decision: 'deny', signature: await sign(hostIdentity, pairingDecisionPayload(code, 'approve', WEB_PUB)) }, T0)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await pollPairing(store, code, pollToken, T0)).toEqual({ status: 'claimed' });
    expect(await listDevices(store, 'a')).toEqual([]);
    expect(await resolvePairing(store, await approval(code, 'deny'), T0 + 1)).toEqual({ denied: true });
    expect(await pollPairing(store, code, pollToken, T0 + 2)).toEqual({ status: 'denied' });
  });

  it('runs the full pairing lifecycle: start → claim → approve → tokens', async () => {
    const store = memStore();
    const web = await generateIdentity();
    const { code, expiresAt } = await startPairing(store, { accountId: 'vocs-v1', hostName: 'Work PC', hostPlatform: 'win32', hostPub: HOST_PUB }, T0);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(expiresAt).toBe(T0 + PAIRING_TTL_MS);

    const { pollToken } = await claimPairing(store, { code, webName: 'Chrome', webPlatform: 'mac', webPub: publicOf(web) }, T0);
    expect(await pollPairing(store, code, pollToken, T0)).toEqual({ status: 'claimed' });

    const resolved = await resolvePairing(store, { code, decision: 'approve', signature: await sign(hostIdentity, pairingDecisionPayload(code, 'approve', publicOf(web))) }, T0 + 1);
    if ('denied' in resolved) throw new Error('expected approval');
    expect(resolved.hostToken).toHaveLength(43); // 32 bytes base64url
    expect(resolved.webDeviceId.startsWith('w_')).toBe(true);

    const poll = await pollPairing(store, code, pollToken, T0 + 2);
    expect(poll.status).toBe('approved');
    if (poll.status !== 'approved') throw new Error('unreachable');
    // The browser credential travels sealed to the key the browser claimed with.
    expect(JSON.stringify(poll)).not.toContain(resolved.webToken);
    expect(await openSealedToKey(web.enc, poll.sealedToken, pairingTokenContext(code, poll.webDeviceId))).toBe(resolved.webToken);
    expect(poll.webDeviceId).toBe(resolved.webDeviceId);
    expect(poll.hostPub).toEqual(HOST_PUB);
    expect(poll.hostName).toBe('Work PC');

    const devices = await listDevices(store, 'vocs-v1');
    expect(devices.map((d) => d.kind).sort()).toEqual(['host', 'web']);
    expect(devices.find((d) => d.kind === 'host')?.pub).toEqual(HOST_PUB);
  });

  it('reuses an enrolled desktop on its next pairing instead of minting a second host identity', async () => {
    const store = memStore();
    const pairWith = async (webPub: PublicIdentity, hostDeviceId?: string) => {
      const { code } = await startPairing(store, { accountId: 'a', hostName: 'Work PC', hostPlatform: 'win32', hostPub: HOST_PUB, hostDeviceId }, T0);
      const { pollToken } = await claimPairing(store, { code, webName: 'browser', webPlatform: '', webPub }, T0);
      const resolved = await resolvePairing(store, { code, decision: 'approve', signature: await sign(hostIdentity, pairingDecisionPayload(code, 'approve', webPub)) }, T0 + 1);
      if ('denied' in resolved) throw new Error('expected approval');
      return { resolved, poll: await pollPairing(store, code, pollToken, T0 + 2) };
    };
    const first = await pairWith(WEB_PUB);
    expect(first.resolved.hostToken).toHaveLength(43);
    const hostId = first.resolved.hostDeviceId;
    // Started with its own device credential: it keeps both its host id and its credential.
    const second = await pairWith(publicOf(await generateIdentity()), hostId);
    expect(second.resolved.hostDeviceId).toBe(hostId);
    expect(second.resolved.hostToken).toBeUndefined();
    expect(second.poll).toMatchObject({ status: 'approved', hostDeviceId: hostId, hostName: 'Work PC' });
    await expect(verifyRefreshToken(store, { accountId: 'a', deviceId: hostId, token: first.resolved.hostToken! })).resolves.toMatchObject({ kind: 'host' });
    // Started with the enrollment secret: the signing key identifies the same desktop, which
    // evidently lost its credential. It keeps its host id; the credential is rotated.
    const third = await pairWith(publicOf(await generateIdentity()));
    expect(third.resolved.hostDeviceId).toBe(hostId);
    expect(third.resolved.hostToken).toHaveLength(43);
    expect(third.resolved.hostToken).not.toBe(first.resolved.hostToken);
    await expect(verifyRefreshToken(store, { accountId: 'a', deviceId: hostId, token: first.resolved.hostToken! })).rejects.toMatchObject({ code: 'invalid' });
    await expect(verifyRefreshToken(store, { accountId: 'a', deviceId: hostId, token: third.resolved.hostToken! })).resolves.toMatchObject({ kind: 'host' });
    const devices = await listDevices(store, 'a');
    expect(devices.filter((d) => d.kind === 'host')).toHaveLength(1);
    expect(devices.filter((d) => d.kind === 'web').map((d) => d.hostDeviceId)).toEqual([hostId, hostId, hostId]);
  });

  it('drops outstanding access tokens when a re-registration rotates the credential', async () => {
    const store = memStore();
    const host = await testDevice(store, 'host', { identity: hostIdentity, now: T0 });
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'Work PC', hostPlatform: '', hostPub: HOST_PUB }, T0);
    await claimPairing(store, { code, webName: 'w', webPlatform: '', webPub: WEB_PUB }, T0);
    const resolved = await resolvePairing(store, await approval(code, 'approve'), T0 + 1);
    expect(resolved).toMatchObject({ hostDeviceId: host.deviceId, hostToken: expect.any(String) });
    await expect(verifyAccessToken(store, { accountId: 'a', deviceId: host.deviceId, token: host.access }, T0 + 2)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('refuses to approve for an enrolled desktop revoked while its code was pending', async () => {
    const store = memStore();
    const host = await registerHostDevice(store, { accountId: 'a', name: 'PC', platform: '', pub: HOST_PUB }, T0);
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'PC', hostPlatform: '', hostPub: HOST_PUB, hostDeviceId: host.deviceId }, T0);
    await claimPairing(store, { code, webName: 'w', webPlatform: '', webPub: WEB_PUB }, T0);
    await revokeDevice(store, 'a', host.deviceId);
    await expect(resolvePairing(store, await approval(code, 'approve'), T0 + 1)).rejects.toMatchObject({ code: 'invalid' });
    expect(await listDevices(store, 'a')).toEqual([]);
  });

  it('caps paired browsers at claim time and again inside the approval transaction', async () => {
    const store = memStore();
    for (let i = 0; i < MAX_WEB_DEVICES - 1; i++) await registerWebDevice(store, { accountId: 'a', name: `w${i}`, platform: '', pub: WEB_PUB }, T0);
    // Both claims pass the pre-check while one slot remains; only one approval may fill it.
    const codes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { code } = await startPairing(store, { accountId: 'a', hostName: 'h', hostPlatform: '', hostPub: HOST_PUB }, T0);
      await claimPairing(store, { code, webName: `late${i}`, webPlatform: '', webPub: WEB_PUB }, T0);
      codes.push(code);
    }
    await expect(resolvePairing(store, await approval(codes[0], 'approve'), T0 + 1)).resolves.toMatchObject({ webDeviceId: expect.stringMatching(/^w_/) });
    await expect(resolvePairing(store, await approval(codes[1], 'approve'), T0 + 1)).rejects.toMatchObject({ code: 'limit' });
    // A full account refuses the claim before any desktop is asked.
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'h', hostPlatform: '', hostPub: HOST_PUB }, T0);
    await expect(claimPairing(store, { code, webName: 'over', webPlatform: '', webPub: WEB_PUB }, T0)).rejects.toMatchObject({ code: 'limit' });
    expect((await listDevices(store, 'a')).filter((d) => d.kind === 'web')).toHaveLength(MAX_WEB_DEVICES);
  });

  it('caps paired computers but still lets an enrolled one pair more browsers', async () => {
    const store = memStore();
    for (let i = 0; i < MAX_HOST_DEVICES - 1; i++) await registerHostDevice(store, { accountId: 'a', name: `h${i}`, platform: '', pub: publicOf(await generateIdentity()) }, T0);
    await registerHostDevice(store, { accountId: 'a', name: 'enrolled', platform: '', pub: HOST_PUB }, T0);
    const other = await generateIdentity();
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'new', hostPlatform: '', hostPub: publicOf(other) }, T0);
    await claimPairing(store, { code, webName: 'w', webPlatform: '', webPub: WEB_PUB }, T0);
    await expect(resolvePairing(store, { code, decision: 'approve', signature: await sign(other, pairingDecisionPayload(code, 'approve', WEB_PUB)) }, T0 + 1)).rejects.toMatchObject({ code: 'limit' });
    const again = await startPairing(store, { accountId: 'a', hostName: 'enrolled', hostPlatform: '', hostPub: HOST_PUB }, T0);
    await claimPairing(store, { code: again.code, webName: 'w', webPlatform: '', webPub: WEB_PUB }, T0);
    await expect(resolvePairing(store, await approval(again.code, 'approve'), T0 + 1)).resolves.toMatchObject({ hostToken: expect.any(String) });
    expect((await listDevices(store, 'a')).filter((d) => d.kind === 'host')).toHaveLength(MAX_HOST_DEVICES);
  });

  it('rejects a denied code and reports denial to the web poll', async () => {
    const store = memStore();
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'h', hostPlatform: '', hostPub: HOST_PUB }, T0);
    const { pollToken } = await claimPairing(store, { code, webName: 'w', webPlatform: '', webPub: WEB_PUB }, T0);
    const resolved = await resolvePairing(store, await approval(code, 'deny'), T0 + 1);
    expect(resolved).toEqual({ denied: true });
    expect(await pollPairing(store, code, pollToken, T0 + 2)).toEqual({ status: 'denied' });
    expect(await listDevices(store, 'a')).toEqual([]);
  });

  it('expires codes after the TTL and reports expired to both sides', async () => {
    const store = memStore();
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'h', hostPlatform: '', hostPub: HOST_PUB }, T0);
    const late = T0 + PAIRING_TTL_MS + 1;
    await expect(claimPairing(store, { code, webName: 'w', webPlatform: '', webPub: WEB_PUB }, late)).rejects.toMatchObject({ code: 'expired' });
    await expect(pollPairing(store, code, 'no-claim', late)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses double claims and double resolutions', async () => {
    const store = memStore();
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'h', hostPlatform: '', hostPub: HOST_PUB }, T0);
    await claimPairing(store, { code, webName: 'w', webPlatform: '', webPub: WEB_PUB }, T0);
    await expect(claimPairing(store, { code, webName: 'w2', webPlatform: '', webPub: WEB_PUB }, T0)).rejects.toBeInstanceOf(PairError);
    await resolvePairing(store, await approval(code, 'approve'), T0 + 1);
    await expect(resolvePairing(store, await approval(code, 'approve'), T0 + 2)).rejects.toBeInstanceOf(PairError);
  });

  it('verifies refresh credentials and rejects wrong ones', async () => {
    const store = memStore();
    const { hostToken, deviceId } = await registerHostDevice(store, { accountId: 'a', name: 'h', platform: 'win', pub: HOST_PUB }, T0);
    const device = await verifyRefreshToken(store, { accountId: 'a', deviceId, token: hostToken });
    expect(device.name).toBe('h');
    await expect(verifyRefreshToken(store, { accountId: 'a', deviceId, token: 'wrong' })).rejects.toBeInstanceOf(PairError);
    await expect(verifyRefreshToken(store, { accountId: 'a', deviceId: 'nope', token: hostToken })).rejects.toBeInstanceOf(PairError);
    await expect(verifyRefreshToken(store, { accountId: 'a', deviceId, token: '' })).rejects.toBeInstanceOf(PairError);
  });

  it('revokes devices so neither their access tokens nor their refresh credentials work', async () => {
    const store = memStore();
    const web = await testDevice(store, 'web', { now: T0 });
    await expect(verifyAccessToken(store, { accountId: 'a', deviceId: web.deviceId, token: web.access }, T0 + 1)).resolves.toMatchObject({ kind: 'web' });
    expect(await revokeDevice(store, 'a', web.deviceId)).toEqual([web.deviceId]);
    await expect(verifyAccessToken(store, { accountId: 'a', deviceId: web.deviceId, token: web.access }, T0 + 2)).rejects.toBeInstanceOf(PairError);
    await expect(issueChallenge(store, { accountId: 'a', deviceId: web.deviceId, token: web.refresh }, T0 + 2)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('revoking a desktop revokes the browsers paired through it, and only those', async () => {
    const store = memStore();
    const host = await testDevice(store, 'host', { now: T0 });
    const other = await testDevice(store, 'host', { now: T0 });
    const mine = await testDevice(store, 'web', { hostDeviceId: host.deviceId, now: T0 });
    const theirs = await testDevice(store, 'web', { hostDeviceId: other.deviceId, now: T0 });
    await store.put(`q:${mine.deviceId}`, [{ t: 'd', seq: 1, payload: {} }]);
    await issueSocketTicket(store, { accountId: 'a', deviceId: mine.deviceId, token: mine.access }, T0);
    expect((await revokeDevice(store, 'a', host.deviceId)).sort()).toEqual([host.deviceId, mine.deviceId].sort());
    expect((await listDevices(store, 'a')).map((d) => d.deviceId).sort()).toEqual([other.deviceId, theirs.deviceId].sort());
    expect(await store.get(`q:${mine.deviceId}`)).toBeUndefined();
    expect(await store.list('ws-ticket:')).toHaveLength(0);
    // Revoking a browser never takes its desktop with it.
    expect(await revokeDevice(store, 'a', theirs.deviceId)).toEqual([theirs.deviceId]);
    expect((await listDevices(store, 'a')).map((d) => d.deviceId)).toEqual([other.deviceId]);
  });

  it('never resurrects a revoked device when verification races with deletion', async () => {
    const store = memStore();
    const web = await testDevice(store, 'web', { now: T0 });
    const deviceId = web.deviceId;
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    const resume = new Promise<void>((resolve) => { releaseRead = resolve; });
    const key = `device:a:${deviceId}`;
    const slowStore: RelayStore = {
      ...store,
      // The old read-then-write path captures a record before revoke, then resumes.
      get: async <T,>(k: string) => {
        const value = await store.get<T>(k);
        if (k === key) { signalRead(); await resume; }
        return value;
      },
      transaction: (work) => store.transaction((tx) => work({
        ...tx,
        // A transactional read observes the deletion when it resumes; a failed
        // transaction must not commit the prior snapshot.
        get: async <T,>(k: string) => {
          if (k === key) { signalRead(); await resume; return store.get<T>(k); }
          return tx.get<T>(k);
        }
      }))
    };
    // Late enough that verification refreshes lastSeen: the path that writes the record back.
    const verification = verifyAccessToken(slowStore, { accountId: 'a', deviceId, token: web.access }, T0 + 120_000)
      .then(() => 'authorized', () => 'denied');
    await readStarted;
    const revocation = revokeDevice(store, 'a', deviceId);
    releaseRead();
    // Whichever transaction wins first, the final state must be revoked, never
    // resurrected by a last-seen write from an earlier verification.
    await verification;
    await revocation;
    expect(await listDevices(store, 'a')).toHaveLength(0);
    await expect(verifyAccessToken(store, { accountId: 'a', deviceId, token: web.access }, T0 + 120_001)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('hashes tokens with sha-256 and never stores plaintext', async () => {
    const store = memStore();
    const { hostToken } = await registerHostDevice(store, { accountId: 'a', name: 'h', platform: '', pub: HOST_PUB }, T0);
    const entries = await store.list('device:a:');
    expect(JSON.stringify([...entries])).not.toContain(hostToken);
    expect(await hashToken(hostToken)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exposes only public device metadata, never token hashes or keys', async () => {
    const store = memStore();
    const { hostToken } = await registerHostDevice(store, { accountId: 'a', name: 'Work PC', platform: 'win32', pub: HOST_PUB }, T0);
    await registerWebDevice(store, { accountId: 'a', name: 'Chrome', platform: 'web', pub: WEB_PUB }, T0);
    const infos = await deviceInfos(store, 'a');
    expect(infos.map((d) => d.kind).sort()).toEqual(['host', 'web']);
    expect(infos.find((d) => d.kind === 'host')).toMatchObject({ name: 'Work PC', platform: 'win32' });
    // The serialized response must not carry the token hash, the public key or the raw token.
    const shape = JSON.stringify(infos);
    expect(shape).not.toContain('tokenHash');
    expect(shape).not.toContain(hostToken);
    // And each record is exactly the public shape, so a new private field cannot sneak out.
    for (const info of infos) expect(Object.keys(info).sort()).toEqual(['deviceId', 'kind', 'lastSeen', 'name', 'online', 'platform']);
    // Presence comes from the caller (the Hub's open sockets), never from storage.
    const hostId = infos.find((d) => d.kind === 'host')!.deviceId;
    expect((await deviceInfos(store, 'a', (d) => d.deviceId === hostId)).map((d) => [d.kind, d.online]).sort()).toEqual([['host', true], ['web', false]]);
  });
});

describe('revoke all (the kill switch)', () => {
  it('revokes every other device, pending pairings and the other hosts\' mirrors, and keeps the caller', async () => {
    const store = memStore();
    const me = await testDevice(store, 'host', { now: T0 });
    const other = await testDevice(store, 'host', { now: T0 });
    const browsers = [await testDevice(store, 'web', { hostDeviceId: me.deviceId, now: T0 }), await testDevice(store, 'web', { hostDeviceId: other.deviceId, now: T0 })];
    await issueSocketTicket(store, { accountId: 'a', deviceId: browsers[0].deviceId, token: browsers[0].access }, T0);
    await store.put(`q:${browsers[1].deviceId}`, [{ t: 'd', seq: 1, payload: {} }]);
    await putMirrorIndex(store, { accountId: 'a', hostId: me.deviceId, blob: { iv: 'AAAA', ct: 'MINE' } }, T0);
    await putMirrorIndex(store, { accountId: 'a', hostId: other.deviceId, blob: { iv: 'AAAA', ct: 'THEIRS' } }, T0);
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'h', hostPlatform: '', hostPub: HOST_PUB }, T0);
    await claimPairing(store, { code, webName: 'late', webPlatform: '', webPub: WEB_PUB }, T0);

    const revoked = await revokeAllExcept(store, 'a', me.deviceId);
    expect(revoked.sort()).toEqual([other.deviceId, ...browsers.map((b) => b.deviceId)].sort());
    expect((await listDevices(store, 'a')).map((d) => d.deviceId)).toEqual([me.deviceId]);
    await expect(verifyAccessToken(store, { accountId: 'a', deviceId: me.deviceId, token: me.access }, T0 + 1)).resolves.toMatchObject({ kind: 'host' });
    expect(await store.list('pair:')).toEqual([]);
    expect(await store.list('ws-ticket:')).toEqual([]);
    expect(await store.list('q:')).toEqual([]);
    expect((await getMirrorIndex(store, 'a', me.deviceId, T0))?.blob.ct).toBe('MINE');
    expect(await getMirrorIndex(store, 'a', other.deviceId, T0)).toBeUndefined();
    await expect(resolvePairing(store, await approval(code, 'approve'), T0 + 1)).rejects.toBeInstanceOf(PairError);
  });
});

describe('access tokens (proof of possession)', () => {
  it('buys an access token only with the refresh credential AND a signature by the device key', async () => {
    const store = memStore();
    const identity = await generateIdentity();
    const { deviceId, webToken: refresh } = await registerWebDevice(store, { accountId: 'a', name: 'w', platform: 'web', pub: publicOf(identity) }, T0);
    await expect(issueChallenge(store, { accountId: 'a', deviceId, token: 'stolen-guess' }, T0)).rejects.toMatchObject({ code: 'invalid' });
    // The refresh credential alone authorizes no API call.
    await expect(verifyAccessToken(store, { accountId: 'a', deviceId, token: refresh }, T0)).rejects.toMatchObject({ code: 'invalid' });

    // A thief with the refresh credential but not the key: the signature fails and the
    // challenge is spent, so even the right signature cannot reuse it afterwards.
    const thief = await generateIdentity();
    const { challenge } = await issueChallenge(store, { accountId: 'a', deviceId, token: refresh }, T0);
    await expect(issueAccessToken(store, { accountId: 'a', deviceId, token: refresh, challenge, signature: await sign(thief, tokenProofPayload(deviceId, challenge)) }, T0)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(issueAccessToken(store, { accountId: 'a', deviceId, token: refresh, challenge, signature: await sign(identity, tokenProofPayload(deviceId, challenge)) }, T0)).rejects.toMatchObject({ code: 'invalid' });
    // A signature over another device id is not a proof for this one.
    const second = await issueChallenge(store, { accountId: 'a', deviceId, token: refresh }, T0);
    await expect(issueAccessToken(store, { accountId: 'a', deviceId, token: refresh, challenge: second.challenge, signature: await sign(identity, tokenProofPayload('w_other', second.challenge)) }, T0)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(issueAccessToken(store, { accountId: 'a', deviceId, token: refresh, challenge: 'x', signature: 'not-base64!' }, T0)).rejects.toBeInstanceOf(PairError);

    const access = await accessFor(store, { deviceId, refresh, identity }, { now: T0 });
    await expect(verifyAccessToken(store, { accountId: 'a', deviceId, token: access }, T0 + 1)).resolves.toMatchObject({ deviceId });
    await expect(verifyAccessToken(store, { accountId: 'a', deviceId: 'w_other', token: access }, T0 + 1)).rejects.toMatchObject({ code: 'invalid' });
    const stored = JSON.stringify(await store.list('device:'));
    expect(stored).not.toContain(access);
    expect(stored).not.toContain(refresh);
  });

  it('expires challenges and access tokens, and a newer challenge replaces the pending one', async () => {
    const store = memStore();
    const identity = await generateIdentity();
    const { deviceId, webToken: refresh } = await registerWebDevice(store, { accountId: 'a', name: 'w', platform: 'web', pub: publicOf(identity) }, T0);
    const proof = async (challenge: string) => sign(identity, tokenProofPayload(deviceId, challenge));
    const late = await issueChallenge(store, { accountId: 'a', deviceId, token: refresh }, T0);
    expect(late.expiresAt).toBe(T0 + CHALLENGE_TTL_MS);
    await expect(issueAccessToken(store, { accountId: 'a', deviceId, token: refresh, challenge: late.challenge, signature: await proof(late.challenge) }, T0 + CHALLENGE_TTL_MS)).rejects.toMatchObject({ code: 'forbidden' });
    const older = await issueChallenge(store, { accountId: 'a', deviceId, token: refresh }, T0);
    const newer = await issueChallenge(store, { accountId: 'a', deviceId, token: refresh }, T0);
    await expect(issueAccessToken(store, { accountId: 'a', deviceId, token: refresh, challenge: older.challenge, signature: await proof(older.challenge) }, T0)).rejects.toMatchObject({ code: 'invalid' });
    const issued = await issueAccessToken(store, { accountId: 'a', deviceId, token: refresh, challenge: newer.challenge, signature: await proof(newer.challenge) }, T0);
    expect(issued.expiresAt).toBe(T0 + ACCESS_TTL_MS);
    expect(ACCESS_TTL_MS).toBe(60 * 60_000);
    await expect(verifyAccessToken(store, { accountId: 'a', deviceId, token: issued.accessToken }, T0 + ACCESS_TTL_MS - 1)).resolves.toMatchObject({ deviceId });
    await expect(verifyAccessToken(store, { accountId: 'a', deviceId, token: issued.accessToken }, T0 + ACCESS_TTL_MS)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('keeps a bounded set of concurrent access tokens per device', async () => {
    const store = memStore();
    const identity = await generateIdentity();
    const { deviceId, webToken: refresh } = await registerWebDevice(store, { accountId: 'a', name: 'w', platform: 'web', pub: publicOf(identity) }, T0);
    const tokens: string[] = [];
    for (let i = 0; i < 6; i++) tokens.push(await accessFor(store, { deviceId, refresh, identity }, { now: T0 + i }));
    const verdicts = await Promise.all(tokens.map((token) => verifyAccessToken(store, { accountId: 'a', deviceId, token }, T0 + 10).then(() => true, () => false)));
    expect(verdicts).toEqual([false, false, true, true, true, true]);
    expect((await store.get<{ access: unknown[] }>(`device:a:${deviceId}`))?.access).toHaveLength(4);
  });

  it('seals the browser credential to its claim key: nothing else opens it, and storage holds only ciphertext', async () => {
    const store = memStore();
    const web = await generateIdentity();
    const { code } = await startPairing(store, { accountId: 'a', hostName: 'PC', hostPlatform: '', hostPub: HOST_PUB }, T0);
    const { pollToken } = await claimPairing(store, { code, webName: 'w', webPlatform: '', webPub: publicOf(web) }, T0);
    const resolved = await resolvePairing(store, { code, decision: 'approve', signature: await sign(hostIdentity, pairingDecisionPayload(code, 'approve', publicOf(web))) }, T0 + 1);
    if ('denied' in resolved) throw new Error('expected approval');
    const everything = JSON.stringify(await store.list(''));
    expect(everything).not.toContain(resolved.webToken);
    expect(everything).not.toContain(resolved.hostToken!);
    const poll = await pollPairing(store, code, pollToken, T0 + 2);
    if (poll.status !== 'approved') throw new Error('expected approval');
    const stranger = await generateIdentity();
    await expect(openSealedToKey(stranger.enc, poll.sealedToken, pairingTokenContext(code, poll.webDeviceId))).rejects.toThrow();
    await expect(openSealedToKey(web.enc, poll.sealedToken, pairingTokenContext(code, 'w_other'))).rejects.toThrow();
    const refresh = await openSealedToKey(web.enc, poll.sealedToken, pairingTokenContext(code, poll.webDeviceId));
    // The browser completes the proof of possession with the identity it claimed with.
    const access = await accessFor(store, { deviceId: poll.webDeviceId, refresh, identity: web }, { now: T0 + 3 });
    await expect(verifyAccessToken(store, { accountId: 'a', deviceId: poll.webDeviceId, token: access }, T0 + 4)).resolves.toMatchObject({ hostDeviceId: resolved.hostDeviceId });
  });
});

describe('browser WebSocket upgrade tickets', () => {
  it('stores only hashes, consumes once across competing upgrades and expires at 30 seconds', async () => {
    const store = memStore();
    const web = await testDevice(store, 'web', { now: T0 });
    const { deviceId, access: webToken } = web;
    const { ticket, expiresAt } = await issueSocketTicket(store, { accountId: 'a', deviceId, token: webToken }, T0);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(T0 + 30_000);
    expect(SOCKET_TICKET_TTL_MS).toBe(30_000);
    expect(JSON.stringify(await store.list('ws-ticket:'))).not.toContain(ticket);
    expect(JSON.stringify(await store.list('ws-ticket:'))).not.toContain(webToken);
    // A refresh credential is not an access token.
    await expect(issueSocketTicket(store, { accountId: 'a', deviceId, token: web.refresh }, T0)).rejects.toMatchObject({ code: 'invalid' });
    const settled = await Promise.allSettled([
      consumeSocketTicket(store, { accountId: 'a', deviceId, ticket }, T0 + 1),
      consumeSocketTicket(store, { accountId: 'a', deviceId, ticket }, T0 + 1)
    ]);
    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    expect(await store.list('ws-ticket:')).toHaveLength(0);
    const next = await issueSocketTicket(store, { accountId: 'a', deviceId, token: webToken }, T0 + 2);
    await expect(consumeSocketTicket(store, { accountId: 'a', deviceId, ticket: next.ticket }, next.expiresAt)).rejects.toMatchObject({ code: 'invalid' });
    expect(await store.list('ws-ticket:')).toHaveLength(0);
  });

  it('replaces a prior ticket on issue and keeps exactly one bounded record per web device', async () => {
    const store = memStore();
    const { deviceId, access: webToken } = await testDevice(store, 'web', { now: T0 });
    const first = await issueSocketTicket(store, { accountId: 'a', deviceId, token: webToken }, T0);
    const second = await issueSocketTicket(store, { accountId: 'a', deviceId, token: webToken }, T0 + 1);
    expect(await store.list('ws-ticket:')).toHaveLength(1);
    await expect(consumeSocketTicket(store, { accountId: 'a', deviceId, ticket: first.ticket }, T0 + 2)).rejects.toMatchObject({ code: 'invalid' });
    expect(await consumeSocketTicket(store, { accountId: 'a', deviceId, ticket: second.ticket }, T0 + 2)).toBe(deviceId);
    for (let i = 0; i < 20; i++) await issueSocketTicket(store, { accountId: 'a', deviceId, token: webToken }, T0 + i);
    expect(await store.list('ws-ticket:')).toHaveLength(1);
  });

  it('rejects wrong account, device, token and host; revocation removes every outstanding ticket', async () => {
    const store = memStore();
    const web = await testDevice(store, 'web', { now: T0 });
    const other = await testDevice(store, 'web', { now: T0 });
    const host = await testDevice(store, 'host', { now: T0 });
    await expect(issueSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, token: 'wrong' }, T0)).rejects.toMatchObject({ code: 'invalid' });
    await expect(issueSocketTicket(store, { accountId: 'a', deviceId: host.deviceId, token: host.access }, T0)).rejects.toMatchObject({ code: 'invalid' });
    const one = await issueSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, token: web.access }, T0);
    await expect(consumeSocketTicket(store, { accountId: 'b', deviceId: web.deviceId, ticket: one.ticket }, T0)).rejects.toMatchObject({ code: 'invalid' });
    await expect(consumeSocketTicket(store, { accountId: 'a', deviceId: other.deviceId, ticket: one.ticket }, T0)).rejects.toMatchObject({ code: 'invalid' });
    await revokeDevice(store, 'a', web.deviceId);
    expect(await store.list('ws-ticket:')).toHaveLength(0);
    await expect(consumeSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, ticket: one.ticket }, T0)).rejects.toMatchObject({ code: 'invalid' });
    await expect(issueSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, token: web.access }, T0)).rejects.toMatchObject({ code: 'invalid' });
  });

  it.each(['issue', 'consume', 'revoke'])('rolls back a %s storage failure and recovers', async (operation) => {
    let failure = '';
    const store = memStore((key) => key.startsWith('ws-ticket:') && failure === operation);
    const web = await testDevice(store, 'web', { now: T0 });
    if (operation === 'issue') {
      failure = operation;
      await expect(issueSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, token: web.access }, T0)).rejects.toThrow('injected storage failure');
      expect(await store.list('ws-ticket:')).toHaveLength(0);
      failure = '';
    }
    const { ticket } = await issueSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, token: web.access }, T0);
    if (operation === 'consume') {
      // The transaction must roll back even if deletion or the last-seen write fails.
      failure = operation;
      await expect(consumeSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, ticket }, T0 + 1)).rejects.toThrow('injected storage failure');
      expect(await store.list('ws-ticket:')).toHaveLength(1);
      failure = '';
    }
    if (operation === 'revoke') {
      failure = operation;
      await expect(revokeDevice(store, 'a', web.deviceId)).rejects.toThrow('injected storage failure');
      expect(await listDevices(store, 'a')).toHaveLength(1);
      failure = '';
      await revokeDevice(store, 'a', web.deviceId);
      await expect(consumeSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, ticket }, T0 + 1)).rejects.toMatchObject({ code: 'invalid' });
    } else {
      expect(await consumeSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, ticket }, T0 + 1)).toBe(web.deviceId);
      expect(await store.list('ws-ticket:')).toHaveLength(0);
    }
  });
});

describe('relay offline mirror (opaque sealed blobs)', () => {
  const blob = (ct: string) => ({ iv: 'AAAAAAAAAAAAAAAA', ct });

  it('round-trips the sealed index and per-session snapshots', async () => {
    const store = memStore();
    await putMirrorIndex(store, { accountId: 'a', hostId: 'h_1', blob: blob('INDEX') }, T0);
    await putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: 's_1', blob: blob('SNAP1') }, T0 + 1);
    expect((await getMirrorIndex(store, 'a', 'h_1', T0 + 2))?.blob.ct).toBe('INDEX');
    expect((await getMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: 's_1' }, T0 + 2))?.ct).toBe('SNAP1');
    expect(await listMirrorSessions(store, 'a', 'h_1', T0 + 2)).toEqual([{ sessionId: 's_1', updatedAt: T0 + 1, bytes: expect.any(Number) }]);
  });

  it('keeps the mirror per host, never shared across hosts', async () => {
    const store = memStore();
    await putMirrorIndex(store, { accountId: 'a', hostId: 'h_1', blob: blob('ONE') }, T0);
    await putMirrorIndex(store, { accountId: 'a', hostId: 'h_2', blob: blob('TWO') }, T0);
    expect((await getMirrorIndex(store, 'a', 'h_1', T0))?.blob.ct).toBe('ONE');
    expect((await getMirrorIndex(store, 'a', 'h_2', T0))?.blob.ct).toBe('TWO');
    expect(await getMirrorIndex(store, 'a', 'h_3', T0)).toBeUndefined();
  });

  it('rejects a malformed session id and any blob too large to store in a Durable Object value', async () => {
    const store = memStore();
    await expect(putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: '../../etc', blob: blob('X') }, T0)).rejects.toBeInstanceOf(MirrorError);
    const huge = { iv: 'AAAAAAAAAAAAAAAA', ct: 'a'.repeat(12 * 1024 * 1024) };
    await expect(putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: 's_1', blob: huge }, T0)).rejects.toMatchObject({ code: 'too-large' });
    // SQLite-backed Durable Objects cap key + value at 2 MB: a 3 MB blob used to reach put() and 500.
    await expect(putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: 's_1', blob: blob('a'.repeat(MIRROR_MAX_BLOB_CHARS + 1)) }, T0)).rejects.toMatchObject({ code: 'too-large' });
    await expect(putMirrorIndex(store, { accountId: 'a', hostId: 'h_1', blob: blob('a'.repeat(3_000_000)) }, T0)).rejects.toMatchObject({ code: 'too-large' });
    await expect(putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: 's_1', blob: { iv: 'A'.repeat(64), ct: 'AAAA' } }, T0)).rejects.toMatchObject({ code: 'too-large' });
    expect(MIRROR_MAX_BLOB_CHARS).toBeLessThan(2_000_000);
    expect(await listMirrorSessions(store, 'a', 'h_1', T0)).toEqual([]);
    await putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: 's_1', blob: blob('a'.repeat(MIRROR_MAX_BLOB_CHARS)) }, T0);
    expect(await listMirrorSessions(store, 'a', 'h_1', T0)).toHaveLength(1);
  });

  it('prunes, lists and clears from the catalogue without reading a single blob', async () => {
    const base = memStore();
    let blobReads = 0;
    const isBlob = (key: string) => key.includes(':s:');
    const counting = (storage: RelayStorage): RelayStorage => ({
      ...storage,
      get: async <T,>(key: string) => {
        if (isBlob(key)) blobReads++;
        return storage.get<T>(key);
      },
      list: async <T,>(prefix: string) => {
        const entries = await storage.list<T>(prefix);
        blobReads += entries.filter(([key]) => isBlob(key)).length;
        return entries;
      }
    });
    const store: RelayStore = { ...counting(base), transaction: (work) => base.transaction((tx) => work(counting(tx))) };
    await putMirrorIndex(store, { accountId: 'a', hostId: 'h_1', blob: blob('I') }, T0); // creates the catalogue
    for (let i = 0; i < 205; i++) await putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: `s_${i}`, blob: blob(`S${i}`) }, T0 + i);
    expect((await listMirrorSessions(store, 'a', 'h_1', T0 + 1000)).map((m) => m.sessionId).slice(0, 2)).toEqual(['s_204', 's_203']);
    await deleteMirrorSession(store, 'a', 'h_1', 's_204');
    expect((await listMirrorSessions(store, 'a', 'h_1', T0 + 1000))[0].sessionId).toBe('s_203');
    await clearMirror(store, 'a', 'h_1');
    expect(blobReads).toBe(0);
    expect(await base.list('mirror:')).toEqual([]);
  });

  it('builds the catalogue once from mirror records written before it existed', async () => {
    const store = memStore();
    await store.put('mirror:a:h_1:s:old_1', { blob: blob('A'), updatedAt: T0, bytes: 3 });
    await store.put('mirror:a:h_1:s:old_2', { blob: blob('B'), updatedAt: T0 + 5, bytes: 3 });
    expect((await listMirrorSessions(store, 'a', 'h_1', T0 + 10)).map((m) => m.sessionId)).toEqual(['old_2', 'old_1']);
    await putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: 'new_1', blob: blob('C') }, T0 + 20);
    expect((await listMirrorSessions(store, 'a', 'h_1', T0 + 30)).map((m) => m.sessionId)).toEqual(['new_1', 'old_2', 'old_1']);
    await clearMirror(store, 'a', 'h_1');
    expect(await store.list('mirror:')).toEqual([]);
  });

  it('drops a desktop\'s mirror when the desktop is revoked', async () => {
    const store = memStore();
    const host = await testDevice(store, 'host', { now: T0 });
    await putMirrorIndex(store, { accountId: 'a', hostId: host.deviceId, blob: blob('I') }, T0);
    await putMirrorSession(store, { accountId: 'a', hostId: host.deviceId, sessionId: 's_1', blob: blob('S') }, T0);
    await putMirrorIndex(store, { accountId: 'a', hostId: 'h_other', blob: blob('KEEP') }, T0);
    await revokeDevice(store, 'a', host.deviceId);
    expect((await store.list<unknown>('mirror:')).map(([key]) => key)).toEqual(['mirror:a:h_other:index', 'mirror:a:h_other:meta']);
  });

  it('caps the number of mirrored sessions, dropping the oldest', async () => {
    const store = memStore();
    for (let i = 0; i < 205; i++) await putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: `s_${i}`, blob: blob(`S${i}`) }, T0 + i);
    const metas = await listMirrorSessions(store, 'a', 'h_1', T0 + 1000);
    expect(metas).toHaveLength(200);
    expect(metas[0].sessionId).toBe('s_204');
    expect(metas.at(-1)?.sessionId).toBe('s_5');
  });

  it('expires mirror entries after the TTL and clears on demand', async () => {
    const store = memStore();
    await putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: 's_1', blob: blob('S') }, T0);
    await putMirrorIndex(store, { accountId: 'a', hostId: 'h_1', blob: blob('I') }, T0);
    const later = T0 + 31 * 24 * 60 * 60 * 1000;
    expect(await getMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: 's_1' }, later)).toBeUndefined();
    expect(await getMirrorIndex(store, 'a', 'h_1', later)).toBeUndefined();

    await putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: 's_2', blob: blob('S2') }, T0);
    await putMirrorIndex(store, { accountId: 'a', hostId: 'h_1', blob: blob('I2') }, T0);
    await clearMirror(store, 'a', 'h_1');
    expect(await listMirrorSessions(store, 'a', 'h_1', T0)).toEqual([]);
    expect(await getMirrorIndex(store, 'a', 'h_1', T0)).toBeUndefined();
  });
});

describe('owner actions: Connect with GitHub and pairing from a signed-in browser', () => {
  const newNonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

  it('registers a desktop only after the owner grants its hash, sealing the credential to its key, once', async () => {
    const store = memStore();
    const nonce = newNonce();
    const nonceHash = await hashToken(nonce);
    const redeem = (at: number, hostPub = HOST_PUB) => redeemEnrollment(store, { accountId: 'a', nonce, hostPub, name: 'Work PC', platform: 'win32' }, at);
    // Before the grant the public endpoint says nothing but "pending", and mints nothing.
    expect(await redeem(T0)).toEqual({ status: 'pending' });
    expect(await listDevices(store, 'a')).toEqual([]);
    expect(await enrollmentStatus(store, { accountId: 'a', nonceHash }, T0)).toEqual({ status: 'missing' });

    await grantEnrollment(store, { accountId: 'a', nonceHash }, T0);
    expect(await enrollmentStatus(store, { accountId: 'a', nonceHash }, T0)).toEqual({ status: 'granted' });
    const registered = await redeem(T0 + 1);
    if (registered.status !== 'registered') throw new Error('expected a registration');
    const token = await openSealedToKey(hostIdentity.enc, registered.sealedToken, enrollTokenContext(nonceHash, registered.hostDeviceId));
    await expect(verifyRefreshToken(store, { accountId: 'a', deviceId: registered.hostDeviceId, token })).resolves.toMatchObject({ kind: 'host', name: 'Work PC' });
    // The sealed credential is bound to this grant and device: no other context opens it.
    await expect(openSealedToKey(hostIdentity.enc, registered.sealedToken, enrollTokenContext(nonceHash, 'h_other'))).rejects.toThrow();

    // A desktop whose response was lost redeems again and gets the same ciphertext; nothing new is minted.
    expect(await redeem(T0 + 2)).toEqual(registered);
    await expect(redeem(T0 + 3, publicOf(await generateIdentity()))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await listDevices(store, 'a')).filter((d) => d.kind === 'host')).toHaveLength(1);
    // The page that granted it learns which computer to pair with; a spent grant cannot be granted again.
    expect(await enrollmentStatus(store, { accountId: 'a', nonceHash }, T0 + 4)).toEqual({ status: 'redeemed', hostDeviceId: registered.hostDeviceId, hostName: 'Work PC' });
    await expect(grantEnrollment(store, { accountId: 'a', nonceHash }, T0 + 5)).rejects.toMatchObject({ code: 'used' });
    expect(await enrollmentStatus(store, { accountId: 'a', nonceHash }, T0 + ENROLL_GRANT_TTL_MS + 1)).toEqual({ status: 'missing' });
  });

  it('keeps a known desktop host id, rotating only its credential, and respects the computer cap', async () => {
    const store = memStore();
    const known = await registerHostDevice(store, { accountId: 'a', name: 'Work PC', platform: '', pub: HOST_PUB }, T0);
    const nonce = newNonce();
    await grantEnrollment(store, { accountId: 'a', nonceHash: await hashToken(nonce) }, T0);
    const again = await redeemEnrollment(store, { accountId: 'a', nonce, hostPub: HOST_PUB, name: 'renamed', platform: '' }, T0 + 1);
    expect(again).toMatchObject({ status: 'registered', hostDeviceId: known.deviceId });
    await expect(verifyRefreshToken(store, { accountId: 'a', deviceId: known.deviceId, token: known.hostToken })).rejects.toMatchObject({ code: 'invalid' });
    expect(await enrollmentStatus(store, { accountId: 'a', nonceHash: await hashToken(nonce) }, T0 + 2)).toMatchObject({ hostName: 'Work PC' });

    for (let i = 1; i < MAX_HOST_DEVICES; i++) await registerHostDevice(store, { accountId: 'a', name: `PC ${i}`, platform: '', pub: publicOf(await generateIdentity()) }, T0);
    const late = newNonce();
    await grantEnrollment(store, { accountId: 'a', nonceHash: await hashToken(late) }, T0);
    await expect(redeemEnrollment(store, { accountId: 'a', nonce: late, hostPub: publicOf(await generateIdentity()), name: 'one too many', platform: '' }, T0 + 1)).rejects.toMatchObject({ code: 'limit' });
    expect((await listDevices(store, 'a')).filter((d) => d.kind === 'host')).toHaveLength(MAX_HOST_DEVICES);
  });

  it('refuses malformed nonces and hashes, and grants in another account', async () => {
    const store = memStore();
    for (const nonceHash of ['', 'ABC', 'g'.repeat(64), 'a'.repeat(63)]) {
      await expect(grantEnrollment(store, { accountId: 'a', nonceHash }, T0)).rejects.toMatchObject({ code: 'invalid' });
    }
    for (const nonce of ['', 'short', 'x'.repeat(44), `${'x'.repeat(42)}!`]) {
      await expect(redeemEnrollment(store, { accountId: 'a', nonce, hostPub: HOST_PUB, name: 'PC', platform: '' }, T0)).rejects.toMatchObject({ code: 'invalid' });
    }
    const nonce = newNonce();
    await grantEnrollment(store, { accountId: 'b', nonceHash: await hashToken(nonce) }, T0);
    expect(await redeemEnrollment(store, { accountId: 'a', nonce, hostPub: HOST_PUB, name: 'PC', platform: '' }, T0 + 1)).toEqual({ status: 'pending' });
  });

  it('lets a signed-in owner ask a registered desktop to pair a browser, still decided by the desktop key', async () => {
    const store = memStore();
    const host = await registerHostDevice(store, { accountId: 'a', name: 'Work PC', platform: 'win32', pub: HOST_PUB }, T0);
    await expect(requestPairing(store, { accountId: 'a', hostDeviceId: 'h_missing', webName: 'Phone', webPlatform: '', webPub: WEB_PUB }, T0)).rejects.toMatchObject({ code: 'not-found' });
    const request = await requestPairing(store, { accountId: 'a', hostDeviceId: host.deviceId, webName: 'Phone', webPlatform: 'web', webPub: WEB_PUB }, T0);
    expect(request).toMatchObject({ hostName: 'Work PC', hostPub: HOST_PUB });
    expect(await pollPairing(store, request.code, request.pollToken, T0 + 1)).toEqual({ status: 'claimed' });
    // Only the desktop's own key decides.
    const stranger = await generateIdentity();
    const forged = await sign(stranger, pairingDecisionPayload(request.code, 'approve', WEB_PUB));
    await expect(resolvePairing(store, { code: request.code, decision: 'approve', signature: forged }, T0 + 1)).rejects.toMatchObject({ code: 'forbidden' });
    const resolved = await resolvePairing(store, await approval(request.code, 'approve'), T0 + 2);
    if ('denied' in resolved) throw new Error('expected approval');
    expect(resolved.hostDeviceId).toBe(host.deviceId);
    // The desktop keeps its credential: it asked nothing of the relay.
    expect(resolved.hostToken).toBeUndefined();
    expect(await pollPairing(store, request.code, request.pollToken, T0 + 3)).toMatchObject({ status: 'approved', hostDeviceId: host.deviceId, hostName: 'Work PC' });
    expect((await listDevices(store, 'a')).map((d) => d.kind).sort()).toEqual(['host', 'web']);
  });
});
