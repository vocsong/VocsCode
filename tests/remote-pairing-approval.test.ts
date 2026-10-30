/** A hostile relay must not turn a pending prompt into local trust. Exercise the real host and
 *  secret-store boundary; inject only at the socket message/send boundary, not at pairing helpers. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { HandlerRegistry } from '../src/main/handlers';
import { RemoteHost } from '../src/main/remote/host';
import { generateIdentity, publicOf, type Identity, type PublicIdentity } from '../src/shared/crypto';
import { ACCOUNT, ENROLL, FakeRelay } from './fake-relay';

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Access the transport boundary only. Authorization state is deliberately not exposed here. */
type HostWire = { ws: WebSocket | null; onMessage(raw: string, socket: WebSocket): Promise<void> };
type Stored = { identity: Identity; deviceId?: string; deviceToken?: string; clients: Record<string, PublicIdentity> };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function rig(registered = true) {
  const relay = new FakeRelay();
  const base = `http://127.0.0.1:${await relay.start()}`;
  const secrets = new Map<string, string>();
  const set = vi.fn(async (key: string, value: string) => void secrets.set(key, value));
  const host = new RemoteHost({
    registry: () => ({ channels: () => [], invoke: async () => null } as unknown as HandlerRegistry),
    secrets: { get: async (key) => secrets.get(key), set },
    pushState: () => undefined,
    log: () => undefined,
    broadcast: () => undefined
  });
  cleanups.push(async () => { await host.disable(); await relay.stop(); });
  const wire = host as unknown as HostWire;
  const stored = () => JSON.parse(secrets.get('remote-host')!) as Stored;
  const deliver = (message: unknown, socket = wire.ws!) => wire.onMessage(JSON.stringify(message), socket);
  const request = async () => {
    const { code } = await host.startPairing('Approval PC');
    const webPub = publicOf(await generateIdentity());
    const res = await fetch(`${base}/v1/pair/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, webPub, name: 'Approval browser' })
    });
    expect(res.status).toBe(200);
    const { pollToken } = (await res.json()) as { pollToken: string };
    await until(() => host.state().pendingRequest?.code === code, 'the production pairing request');
    return { code, webPub, pollToken };
  };
  await host.enable(base, ENROLL);
  await until(() => wire.ws?.readyState === WebSocket.OPEN, 'the enrolling socket');
  if (registered) {
    const first = await request();
    await host.respondPairing('approve');
    await until(() => host.state().status === 'online' && Object.values(stored().clients).some((pub) => pub.sig.x === first.webPub.sig.x), 'honest enrollment');
    // Let the real reconnect/reconciliation finish before counting writes in the attack.
    await host.listDevices();
  }
  const pending = await request();
  const socket = wire.ws!;
  // Suppress the honest relay response so the test controls its ordering and content. The
  // response still runs through RemoteHost.onMessage and the production persistence boundary.
  const send = vi.spyOn(socket, 'send').mockImplementation(() => undefined);
  const result = {
    t: 'pair.result', decision: 'approve', code: pending.code,
    hostDeviceId: stored().deviceId ?? 'h_forged', webDeviceId: 'w_forged', webPub: pending.webPub,
    ...(!registered ? { hostToken: 'forged-refresh-credential' } : {})
  };
  const before = secrets.get('remote-host');
  set.mockClear();
  const unchanged = () => {
    expect(set).toHaveBeenCalledTimes(0);
    expect(secrets.get('remote-host')).toBe(before);
  };
  return { host, wire, socket, base, relay, request, stored, pending, result, send, set, deliver, unchanged };
}

describe('remote pairing requires the exact local approval', () => {
  it.each([false, true])('refuses a correlated approve result before Allow (registered=%s)', async (registered) => {
    const r = await rig(registered);
    await r.deliver(r.result);
    r.unchanged();
    expect(r.host.state().pendingRequest?.code).toBe(r.pending.code);
  });

  it('refuses approval after a local Deny even before the relay acknowledges it', async () => {
    const r = await rig();
    await r.host.respondPairing('deny');
    await r.deliver(r.result);
    r.unchanged();
    await r.deliver({ t: 'pair.result', code: r.pending.code, decision: 'deny' });
    expect(r.host.state().pendingRequest).toBeUndefined();
    await r.deliver(r.result);
    r.unchanged();
  });

  it('preserves honest Deny through the production relay without a credential write', async () => {
    const r = await rig();
    r.send.mockRestore();
    await r.host.respondPairing('deny');
    await until(() => r.host.state().pendingRequest === undefined, 'the honest denial response');
    const res = await fetch(`${r.base}/v1/pair/poll?code=${r.pending.code}`, { headers: { authorization: `Bearer ${r.pending.pollToken}` } });
    expect(await res.json()).toEqual({ status: 'denied' });
    r.unchanged();
  });

  it.each(['sig', 'enc'] as const)('refuses a substituted %s key after Allow', async (half) => {
    const r = await rig();
    await r.host.respondPairing('approve');
    const other = publicOf(await generateIdentity());
    await r.deliver({ ...r.result, webPub: { ...r.pending.webPub, [half]: other[half] } });
    r.unchanged();
  });

  it.each(['hostDeviceId', 'hostToken', 'code'] as const)('refuses a changed %s after Allow', async (field) => {
    const r = await rig();
    await r.host.respondPairing('approve');
    await r.deliver({ ...r.result, [field]: 'changed-by-relay' });
    r.unchanged();
  });

  it('does not overwrite an existing paired device with a newly approved key', async () => {
    const r = await rig();
    await r.host.respondPairing('approve');
    await r.deliver({ ...r.result, webDeviceId: Object.keys(r.stored().clients)[0] });
    r.unchanged();
  });

  it('requires a new Allow when the relay replaces a request with the same code and another key', async () => {
    const r = await rig();
    await r.host.respondPairing('approve');
    const replacement = publicOf(await generateIdentity());
    await r.deliver({ t: 'pair.request', code: r.pending.code, hostPub: publicOf(r.stored().identity), webPub: replacement, name: 'Replacement' });
    await r.deliver({ ...r.result, webPub: replacement });
    r.unchanged();
    expect(r.host.state().pendingRequest?.name).toBe('Replacement');
  });

  it.each(['name', 'platform'] as const)('requires a new Allow if the request changes its %s', async (field) => {
    const r = await rig();
    await r.host.respondPairing('approve');
    await r.deliver({ t: 'pair.request', ...r.pending, hostPub: publicOf(r.stored().identity), [field]: 'Changed' });
    await r.deliver(r.result);
    r.unchanged();
  });

  it('invalidates Allow after the relay refuses the decision', async () => {
    const r = await rig();
    await r.host.respondPairing('approve');
    await r.deliver({ t: 'pair.error', code: r.pending.code, error: 'forbidden' });
    await r.deliver(r.result);
    r.unchanged();
  });

  it('invalidates an earlier Allow as soon as a new pairing code is requested', async () => {
    const r = await rig();
    await r.host.respondPairing('approve');
    await r.host.startPairing('New attempt');
    await r.deliver(r.result);
    r.unchanged();
  });

  it('refuses expired requests both at Allow and when the result arrives', async () => {
    const r = await rig();
    await r.host.respondPairing('approve');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    await r.deliver(r.result);
    r.unchanged();
    await r.host.respondPairing('approve');
    expect(r.send).toHaveBeenCalledTimes(1);
  });

  it('expires owner-requested pairings that have no locally minted code', async () => {
    const r = await rig();
    const code = 'owner-request';
    await r.deliver({ t: 'pair.request', requested: true, code, webPub: r.pending.webPub, hostPub: publicOf(r.stored().identity) });
    await r.host.respondPairing('approve');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    await r.deliver({ ...r.result, code });
    r.unchanged();
  });

  it('forgets an Allow on socket loss instead of accepting its stale result after reconnect', async () => {
    const r = await rig();
    await r.host.respondPairing('approve');
    r.socket.close();
    await until(() => r.wire.ws !== r.socket && r.host.state().status === 'online', 'reconnection');
    await r.deliver(r.result);
    r.unchanged();
    expect(r.host.state().pendingRequest).toBeUndefined();
  });

  it('forgets an Allow across disabling and re-enabling remote access', async () => {
    const r = await rig();
    await r.host.respondPairing('approve');
    await r.host.disable();
    await r.host.enable(r.base, ENROLL);
    await until(() => r.host.state().status === 'online', 're-enabled socket');
    r.set.mockClear();
    const before = JSON.stringify(r.stored());
    await r.deliver(r.result, r.socket);
    await r.deliver(r.result);
    expect(r.set).toHaveBeenCalledTimes(0);
    expect(JSON.stringify(r.stored())).toBe(before);
  });

  it('Deny cancels an Allow whose signature is still being computed', async () => {
    const r = await rig();
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const signing = vi.spyOn(crypto.subtle, 'sign').mockImplementationOnce(async (...args) => { await paused; return sign(...args); });
    const approving = r.host.respondPairing('approve');
    await until(() => signing.mock.calls.length === 1, 'the blocked signature');
    await r.host.respondPairing('deny');
    release();
    await approving;
    expect(r.send.mock.calls.map(([raw]) => JSON.parse(String(raw)).decision)).toEqual(['deny']);
    await r.deliver(r.result);
    r.unchanged();
  });

  it('does not arm an approval whose send failed', async () => {
    const r = await rig();
    r.send.mockImplementationOnce(() => { throw new Error('socket send failed'); });
    await expect(r.host.respondPairing('approve')).rejects.toThrow('socket send failed');
    await r.deliver(r.result);
    r.unchanged();
  });

  it('consumes one Allow even when persistence fails, and recovers with a fresh honest pairing', async () => {
    const r = await rig();
    await r.host.respondPairing('approve');
    r.set.mockImplementationOnce(async () => { throw new Error('store write failed'); });
    await expect(r.deliver(r.result)).rejects.toThrow('store write failed');
    expect(r.stored().clients.w_forged).toBeUndefined();
    await r.deliver(r.result);
    expect(r.set).toHaveBeenCalledTimes(1);
    await r.host.disable();
    await r.host.enable(r.base, ENROLL);
    await until(() => r.host.state().status === 'online', 'recovery connection');
    const fresh = await r.request();
    await r.host.respondPairing('approve');
    await until(() => Object.values(r.stored().clients).some((pub) => pub.sig.x === fresh.webPub.sig.x), 'fresh honest pairing');
    expect(r.stored().clients.w_forged).toBeUndefined();
  });

  it('keeps the honest enrollment fallback when a credential is rejected during pair/start', async () => {
    const r = await rig();
    await r.relay.store.delete(`device:${ACCOUNT}:${r.stored().deviceId}`);
    const fresh = await r.host.startPairing('Credential rejected on the way');
    expect(r.host.state().pairing?.code).toBe(fresh.code);
    expect(r.host.state().pendingRequest).toBeUndefined();
    expect(r.stored().deviceToken).toBeUndefined();
  });

  it('keeps a fresh fallback code when the revoked socket closes after pair/start returns', async () => {
    const r = await rig();
    await r.relay.store.delete(`device:${ACCOUNT}:${r.stored().deviceId}`);
    // Hold the obsolete socket open until HTTP has published the new fallback code.
    const close = r.socket.close.bind(r.socket);
    const closing = vi.spyOn(r.socket, 'close').mockImplementationOnce(() => undefined);
    const fresh = await r.host.startPairing('Delayed revoked socket');
    expect(closing).toHaveBeenCalledTimes(1);
    expect(r.host.state().pairing?.code).toBe(fresh.code);
    close();
    await until(() => r.wire.ws !== null && r.wire.ws !== r.socket && r.wire.ws.readyState === WebSocket.OPEN, 'fallback reconnect');
    expect(r.host.state().pairing?.code).toBe(fresh.code);
    const webPub = publicOf(await generateIdentity());
    const claim = await fetch(`${r.base}/v1/pair/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: fresh.code, webPub, name: 'Recovered browser' })
    });
    expect(claim.status).toBe(200);
    await until(() => r.host.state().pendingRequest?.code === fresh.code, 'fallback claim');
    await r.host.respondPairing('approve');
    await until(() => Object.values(r.stored().clients).some((pub) => pub.sig.x === webPub.sig.x), 'fallback approval');
  });

  it('accepts an immediate matching result during send exactly once, without waiting for respondPairing to return', async () => {
    const r = await rig();
    let delivered: Promise<void> | undefined;
    // Model the fastest possible relay: delivery starts synchronously inside send. Sorting of
    // JSON properties must not change identity comparison, but the approved snapshot is stored.
    const reordered = { enc: r.pending.webPub.enc, sig: r.pending.webPub.sig };
    r.send.mockImplementation(() => { delivered = r.deliver({ ...r.result, webPub: reordered }); });
    await r.host.respondPairing('approve');
    await delivered;
    expect(r.set).toHaveBeenCalledTimes(1);
    expect(r.stored().clients.w_forged).toEqual(r.pending.webPub);
    expect(r.host.state().pendingRequest).toBeUndefined();
    await r.deliver(r.result);
    expect(r.set).toHaveBeenCalledTimes(1);
    // A replayed request is not another local Allow, even if it has the spent code/key.
    await r.deliver({ t: 'pair.request', requested: true, code: r.pending.code, hostPub: publicOf(r.stored().identity), webPub: r.pending.webPub });
    await r.deliver(r.result);
    expect(r.set).toHaveBeenCalledTimes(1);
  });
});
