/** Integration test for P2 (docs/REMOTE-ACCESS.md): the real RemoteHost against a fake
 *  relay implementing the hub protocol with the real relay core, driven by a fake web
 *  client. Full loop: enable → pair/start → claim → desktop approve → handshake →
 *  filtered invoke over e2e → push fan-out → disallowed channel refused. */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type WebSocket as WsLike } from 'ws';
import { REMOTE_CHANNELS, REMOTE_PUSH_CHANNELS, REMOTE_READ_CHANNELS, REMOTE_WRITE_CHANNELS, RemoteHost } from '../src/main/remote/host';
import { claimPairing, pollPairing, resolvePairing, startPairing, verifyDeviceToken, type RelayStore } from '../relay/src/core';
import { clientFinish, createHello, generateIdentity, openFrame, publicOf, sealFrame, type PublicIdentity } from '../src/shared/crypto';
import type { HandlerRegistry } from '../src/main/handlers';

import { ENROLL, FakeRelay } from './fake-relay';

function waitFrame(ws: WsLike, match: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const on = (data: unknown): void => {
      const m = JSON.parse(String(data)) as Record<string, unknown>;
      if (match(m)) {
        ws.off('message', on);
        resolve(m);
      }
    };
    ws.on('message', on);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('remote host end-to-end (fake relay, real core)', () => {
  it('shows a claimed request only on the desktop that minted its code', async () => {
    const relay = new FakeRelay();
    const port = await relay.start();
    const host = () => new RemoteHost({
      registry: () => ({ channels: () => [], invoke: async () => undefined } as unknown as HandlerRegistry),
      secrets: { get: async () => undefined, set: async () => undefined },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined
    });
    const owner = host();
    const stranger = host();
    try {
      await owner.enable(`http://127.0.0.1:${port}`, ENROLL);
      await stranger.enable(`http://127.0.0.1:${port}`, ENROLL);
      const { code } = await owner.startPairing('Owner');
      const other = await stranger.startPairing('Other');
      expect(other.code).not.toBe(code);
      const webPub = publicOf(await generateIdentity());
      const claim = await fetch(`http://127.0.0.1:${port}/v1/pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, webPub, name: 'Browser' }) });
      const { pollToken } = (await claim.json()) as { pollToken: string };
      for (let i = 0; i < 40 && !owner.state().pendingRequest; i++) await sleep(50);
      expect(owner.state().pendingRequest?.code).toBe(code);
      expect(stranger.state().pendingRequest).toBeUndefined();
      await stranger.respondPairing('approve');
      const poll = () => fetch(`http://127.0.0.1:${port}/v1/pair/poll?code=${code}`, { headers: { authorization: `Bearer ${pollToken}` } });
      expect(await (await poll()).json()).toEqual({ status: 'claimed' });
      await owner.respondPairing('approve');
      for (let i = 0; i < 40; i++) {
        if (((await (await poll()).json()) as { status: string }).status === 'approved') return;
        await sleep(50);
      }
      throw new Error('owning desktop did not approve');
    } finally {
      await owner.disable();
      await stranger.disable();
      await relay.stop();
    }
  });

  let relay: FakeRelay;
  let port = 0;

  beforeAll(async () => {
    relay = new FakeRelay();
    port = await relay.start();
  });

  afterAll(async () => {
    await relay.stop();
  });

  it('pairs, handshakes, serves filtered invokes and pushes over e2e', async () => {
    const calls: string[] = [];
    const registry = {
      channels: () => ['sessions:list', 'sessions:send', 'secrets:has'],
      invoke: async (channel: string) => {
        calls.push(channel);
        if (channel === 'sessions:send') return undefined;
        if (channel === 'sessions:list') return [{ id: 's1', title: 'T' }];
        if (channel === 'secrets:has') return 'LEAK';
        throw new Error('unknown');
      }
    } as unknown as HandlerRegistry;
    const host = new RemoteHost({
      registry: () => registry,
      secrets: { get: async () => undefined, set: async () => undefined },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined
    });

    // Desktop: enable with the enrollment secret, request a pairing code.
    await host.enable(`http://127.0.0.1:${port}`, ENROLL);
    const { code } = await host.startPairing('Test PC');
    expect(code).toMatch(/^[A-Z2-9]{8}$/);

    // Web client claims the code with its identity key.
    const web = await generateIdentity();
    const claim = await fetch(`http://127.0.0.1:${port}/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, webPub: publicOf(web), name: 'Test Browser' })
    });
    expect(claim.status).toBe(200);
    const { pollToken } = (await claim.json()) as { pollToken: string };
    expect(pollToken).toBeTruthy();
    // A code exposed on the pairing screen cannot be used to steal the approved web token.
    expect((await fetch(`http://127.0.0.1:${port}/v1/pair/poll?code=${code}`)).status).toBe(401);

    // The desktop (enrolling socket) sees the request; the human approves.
    for (let i = 0; i < 40 && !host.state().pendingRequest; i++) await sleep(100);
    host.respondPairing('approve');

    // The web client polls until approved, learning its token and the host identity.
    let approved: Extract<Awaited<ReturnType<typeof pollPairing>>, { status: 'approved' }> | null = null;
    for (let i = 0; i < 40 && !approved; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/pair/poll?code=${code}`, { headers: { authorization: `Bearer ${pollToken}` } });
      expect(response.status).toBe(200);
      const poll = (await response.json()) as Awaited<ReturnType<typeof pollPairing>>;
      if (poll.status === 'approved') approved = poll;
      else await sleep(100);
    }
    expect(approved).not.toBeNull();
    expect(approved!.webToken).toBeTruthy();
    expect(approved!.hostPub.sig).toBeDefined();
    expect((await fetch(`http://127.0.0.1:${port}/v1/pair/poll?code=${code}`)).status).toBe(401);

    // The host reconnected under its new device token; exchange the browser bearer
    // in an Authorization header for a one-use upgrade ticket.
    await sleep(300);
    const ticketResponse = await fetch(`http://127.0.0.1:${port}/v1/ws/ticket?device=${encodeURIComponent(approved!.webDeviceId)}`, {
      method: 'POST', headers: { authorization: `Bearer ${approved!.webToken}` }
    });
    expect(ticketResponse.status).toBe(200);
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    const socketUrl = `ws://127.0.0.1:${port}/v1/ws/client?device=${encodeURIComponent(approved!.webDeviceId)}&ticket=${encodeURIComponent(ticket)}`;
    expect(socketUrl.includes(approved!.webToken) || socketUrl.includes('token=')).toBe(false);
    const ws = new WebSocket(socketUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', () => reject(new Error('browser upgrade failed')));
    });
    ws.send(JSON.stringify({ t: 'hello', host: approved!.hostDeviceId }));

    // Handshake over the relay (public values only), then sealed traffic.
    const { hello, ephPriv } = await createHello(web);
    ws.send(JSON.stringify({ t: 'hs', seq: 0, payload: hello }));
    const hsReply = await waitFrame(ws, (m) => m.t === 'hs');
    const session = await clientFinish(hello, ephPriv, hsReply.payload as never, approved!.hostPub, web);
    expect(session.key).toBeDefined();

    const send = async (inner: unknown, salt = session.salt) => {
      const sealed = await sealFrame(session.key, salt, sealedSeq(), inner);
      ws.send(JSON.stringify({ t: 'd', seq: sealed.seq, payload: sealed }));
      return sealed;
    };

    // Allowed channel: an e2e invoke reaches the real registry.
    send({ type: 'invoke', id: 1, channel: 'sessions:list', request: null });
    const result1 = await openFrame<{ type: string; id: number; ok: boolean; value: unknown }>(session.key, ((await waitFrame(ws, (m) => m.t === 'd')) as { payload: never }).payload);
    expect(result1.ok).toBe(true);
    expect(result1.value).toEqual([{ id: 's1', title: 'T' }]);
    expect(calls).toEqual(['sessions:list']);

    // Disallowed channel: refused before the registry is ever consulted.
    send({ type: 'invoke', id: 2, channel: 'secrets:has', request: { providerId: 'anthropic' } });
    const result2 = await openFrame<{ ok: boolean; error?: string }>(session.key, ((await waitFrame(ws, (m) => m.t === 'd')) as { payload: never }).payload);
    expect(result2.ok).toBe(false);
    expect(calls).toEqual(['sessions:list']); // no leak call reached the registry

    // A captured, valid ciphertext cannot execute a send twice, even if replayed while
    // the first async handler is still decrypting, or after another frame advanced the counter.
    const firstReply = waitFrame(ws, (m) => m.t === 'd');
    const captured = await send({ type: 'invoke', id: 3, channel: 'sessions:send', request: { id: 's1', input: { text: 'once' } } });
    ws.send(JSON.stringify({ t: 'd', seq: captured.seq, payload: captured }));
    expect((await openFrame<{ id: number; ok: boolean }>(session.key, (await firstReply).payload as never))).toMatchObject({ id: 3, ok: true });
    await sleep(100);
    expect(calls.filter((channel) => channel === 'sessions:send')).toHaveLength(1);
    const secondReply = waitFrame(ws, (m) => m.t === 'd');
    await send({ type: 'invoke', id: 4, channel: 'sessions:send', request: { id: 's1', input: { text: 'twice' } } });
    expect((await openFrame<{ id: number; ok: boolean }>(session.key, (await secondReply).payload as never))).toMatchObject({ id: 4, ok: true });
    ws.send(JSON.stringify({ t: 'd', seq: captured.seq, payload: captured }));

    // Only the first authenticated inbound salt is valid for this session. Changing the
    // unused tail keeps the GCM nonce/ciphertext valid, but must not invoke the registry.
    const otherSalt = Uint8Array.from(session.salt);
    otherSalt[15] ^= 1;
    await send({ type: 'invoke', id: 5, channel: 'sessions:send', request: { id: 's1', input: { text: 'wrong salt' } } }, otherSalt);
    const finalReply = waitFrame(ws, (m) => m.t === 'd');
    await send({ type: 'invoke', id: 6, channel: 'sessions:send', request: { id: 's1', input: { text: 'third' } } });
    expect((await openFrame<{ id: number; ok: boolean }>(session.key, (await finalReply).payload as never))).toMatchObject({ id: 6, ok: true });
    expect(calls).toEqual(['sessions:list', 'sessions:send', 'sessions:send', 'sessions:send']);

    // Local pushes fan out sealed.
    await host.broadcastPush('push:settingsChanged', { notifications: false });
    const push = await openFrame<{ type: string; channel: string; payload: unknown }>(session.key, ((await waitFrame(ws, (m) => m.t === 'd')) as { payload: never }).payload);
    expect(push).toEqual({ type: 'push', channel: 'push:settingsChanged', payload: { notifications: false } });

    // Only the remote push surface leaves the machine. The desktop fans every push through here,
    // including push:remoteState (the live pairing code), PTY output and the assistant panel.
    // Listen first: frames are delivered in order, so the first one must be the allowed push.
    const firstAfter = waitFrame(ws, (m) => m.t === 'd');
    await host.broadcastPush('push:remoteState', { status: 'online', pairing: { code: 'SECRET22', expiresAt: 1 }, onlineClients: [], viewOnly: false });
    await host.broadcastPush('push:terminalData', { terminalId: 't1', seq: 1, data: 'terminal secret' });
    await host.broadcastPush('push:agentState', { messages: [{ text: 'assistant secret' }] });
    await host.broadcastPush('push:sessionEvent', { sessionId: 's1', event: { type: 'status', status: 'idle' } });
    const allowed = await openFrame<{ type: string; channel: string; payload: unknown }>(session.key, ((await firstAfter) as { payload: never }).payload);
    expect(allowed).toEqual({ type: 'push', channel: 'push:sessionEvent', payload: { sessionId: 's1', event: { type: 'status', status: 'idle' } } });
    expect([...REMOTE_PUSH_CHANNELS].sort()).toEqual(['push:remotePolicy', 'push:sessionEvent', 'push:sessionsChanged', 'push:settingsChanged']);

    ws.close();
    await host.disable();
  });
});

/** P4 guard: view-only mode decides by set membership, so every remotely invocable channel must
 *  be classified. An unclassified channel would either be silently writable in view-only mode or
 *  silently unreachable — both are bugs, so this fails the build when a channel is added. */
describe('remote channel classification (view-only partition)', () => {
  it('partitions REMOTE_CHANNELS into read and write halves', () => {
    const all = [...REMOTE_CHANNELS].sort();
    const partition = [...REMOTE_READ_CHANNELS, ...REMOTE_WRITE_CHANNELS].sort();
    expect(partition).toEqual(all);
    for (const channel of REMOTE_READ_CHANNELS) expect(REMOTE_WRITE_CHANNELS.has(channel)).toBe(false);
  });

  it('classifies every write control as write, not read', () => {
    for (const channel of ['sessions:send', 'sessions:interrupt', 'sessions:stop', 'sessions:create', 'sessions:rename', 'sessions:setModel', 'sessions:setEffort', 'sessions:setPermissionMode', 'approvals:respond']) {
      expect(REMOTE_WRITE_CHANNELS.has(channel)).toBe(true);
      expect(REMOTE_READ_CHANNELS.has(channel)).toBe(false);
    }
  });
});

let sealedCounter = 0;
function sealedSeq(): number {
  return ++sealedCounter;
}