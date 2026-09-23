/** Unit tests for the relay core (relay/src/core.ts): pairing lifecycle, tokens, revocation.
 *  Runs in plain Node against an in-memory store — the DO is a thin binding over this. */
import { beforeAll, describe, expect, it } from 'vitest';
import { generateIdentity, pairingDecisionPayload, publicOf, sign, type Identity } from '../src/shared/crypto';
import { claimPairing, consumeSocketTicket, deviceInfos, hashToken, issueSocketTicket, listDevices, listMirrorSessions, MirrorError, PAIRING_TTL_MS, pollPairing, putMirrorIndex, putMirrorSession, getMirrorIndex, getMirrorSession, clearMirror, registerHostDevice, registerWebDevice, resolvePairing, revokeDevice, SOCKET_TICKET_TTL_MS, startPairing, verifyDeviceToken, PairError, type RelayStorage, type RelayStore } from '../relay/src/core';
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
    expect(await pollPairing(store, code, pollToken, T0 + 2)).toMatchObject({ status: 'approved', webToken: minted.value.webToken, webDeviceId: minted.value.webDeviceId, hostDeviceId: minted.value.hostDeviceId });
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
    const { code, expiresAt } = await startPairing(store, { accountId: 'vocs-v1', hostName: 'Work PC', hostPlatform: 'win32', hostPub: HOST_PUB }, T0);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(expiresAt).toBe(T0 + PAIRING_TTL_MS);

    const { pollToken } = await claimPairing(store, { code, webName: 'Chrome', webPlatform: 'mac', webPub: WEB_PUB }, T0);
    expect(await pollPairing(store, code, pollToken, T0)).toEqual({ status: 'claimed' });

    const resolved = await resolvePairing(store, await approval(code, 'approve'), T0 + 1);
    if ('denied' in resolved) throw new Error('expected approval');
    expect(resolved.hostToken).toHaveLength(43); // 32 bytes base64url
    expect(resolved.webDeviceId.startsWith('w_')).toBe(true);

    const poll = await pollPairing(store, code, pollToken, T0 + 2);
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

  it('never resurrects a revoked device when verification races with deletion', async () => {
    const store = memStore();
    const { webToken, deviceId } = await registerWebDevice(store, { accountId: 'a', name: 'w', platform: 'web', pub: WEB_PUB }, T0);
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
    const verification = verifyDeviceToken(slowStore, { accountId: 'a', deviceId, token: webToken }, T0 + 1)
      .then(() => 'authorized', () => 'denied');
    await readStarted;
    const revocation = revokeDevice(store, 'a', deviceId);
    releaseRead();
    // Whichever transaction wins first, the final state must be revoked, never
    // resurrected by a last-seen write from an earlier verification.
    await verification;
    await revocation;
    expect(await listDevices(store, 'a')).toHaveLength(0);
    await expect(verifyDeviceToken(store, { accountId: 'a', deviceId, token: webToken }, T0 + 2)).rejects.toMatchObject({ code: 'invalid' });
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
    for (const info of infos) expect(Object.keys(info).sort()).toEqual(['deviceId', 'kind', 'lastSeen', 'name', 'platform']);
  });
});

describe('browser WebSocket upgrade tickets', () => {
  it('stores only hashes, consumes once across competing upgrades and expires at 30 seconds', async () => {
    const store = memStore();
    const { deviceId, webToken } = await registerWebDevice(store, { accountId: 'a', name: 'browser', platform: 'web', pub: WEB_PUB }, T0);
    const { ticket, expiresAt } = await issueSocketTicket(store, { accountId: 'a', deviceId, token: webToken }, T0);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(T0 + 30_000);
    expect(SOCKET_TICKET_TTL_MS).toBe(30_000);
    expect(JSON.stringify(await store.list('ws-ticket:'))).not.toContain(ticket);
    expect(JSON.stringify(await store.list('ws-ticket:'))).not.toContain(webToken);
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
    const { deviceId, webToken } = await registerWebDevice(store, { accountId: 'a', name: 'browser', platform: 'web', pub: WEB_PUB }, T0);
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
    const web = await registerWebDevice(store, { accountId: 'a', name: 'browser', platform: 'web', pub: WEB_PUB }, T0);
    const other = await registerWebDevice(store, { accountId: 'a', name: 'other', platform: 'web', pub: WEB_PUB }, T0);
    const host = await registerHostDevice(store, { accountId: 'a', name: 'host', platform: 'win', pub: HOST_PUB }, T0);
    await expect(issueSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, token: 'wrong' }, T0)).rejects.toMatchObject({ code: 'invalid' });
    await expect(issueSocketTicket(store, { accountId: 'a', deviceId: host.deviceId, token: host.hostToken }, T0)).rejects.toMatchObject({ code: 'invalid' });
    const one = await issueSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, token: web.webToken }, T0);
    await expect(consumeSocketTicket(store, { accountId: 'b', deviceId: web.deviceId, ticket: one.ticket }, T0)).rejects.toMatchObject({ code: 'invalid' });
    await expect(consumeSocketTicket(store, { accountId: 'a', deviceId: other.deviceId, ticket: one.ticket }, T0)).rejects.toMatchObject({ code: 'invalid' });
    await revokeDevice(store, 'a', web.deviceId);
    expect(await store.list('ws-ticket:')).toHaveLength(0);
    await expect(consumeSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, ticket: one.ticket }, T0)).rejects.toMatchObject({ code: 'invalid' });
    await expect(issueSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, token: web.webToken }, T0)).rejects.toMatchObject({ code: 'invalid' });
  });

  it.each(['issue', 'consume', 'revoke'])('rolls back a %s storage failure and recovers', async (operation) => {
    let failure = '';
    const store = memStore((key) => key.startsWith('ws-ticket:') && failure === operation);
    const web = await registerWebDevice(store, { accountId: 'a', name: 'browser', platform: 'web', pub: WEB_PUB }, T0);
    if (operation === 'issue') {
      failure = operation;
      await expect(issueSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, token: web.webToken }, T0)).rejects.toThrow('injected storage failure');
      expect(await store.list('ws-ticket:')).toHaveLength(0);
      failure = '';
    }
    const { ticket } = await issueSocketTicket(store, { accountId: 'a', deviceId: web.deviceId, token: web.webToken }, T0);
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

  it('rejects a malformed session id and an oversized blob', async () => {
    const store = memStore();
    await expect(putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: '../../etc', blob: blob('X') }, T0)).rejects.toBeInstanceOf(MirrorError);
    const huge = { iv: 'AAAAAAAAAAAAAAAA', ct: 'a'.repeat(12 * 1024 * 1024) };
    await expect(putMirrorSession(store, { accountId: 'a', hostId: 'h_1', sessionId: 's_1', blob: huge }, T0)).rejects.toMatchObject({ code: 'too-large' });
    expect(await listMirrorSessions(store, 'a', 'h_1', T0)).toEqual([]);
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
