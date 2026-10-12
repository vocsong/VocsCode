/** Integration test for P2 (docs/REMOTE-ACCESS.md): the real RemoteHost against a fake
 *  relay implementing the hub protocol with the real relay core, driven by a fake web
 *  client. Full loop: enable → pair/start → claim → desktop approve → handshake →
 *  filtered invoke over e2e → push fan-out → disallowed channel refused. */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type WebSocket as WsLike } from 'ws';
import { REMOTE_CHANNELS, REMOTE_PUSH_CHANNELS, REMOTE_READ_CHANNELS, REMOTE_WRITE_CHANNELS, RemoteHost } from '../src/main/remote/host';
import { pollPairing } from '../relay/src/core';
import { clientFinish, createHello, generateIdentity, openFrame, openSealedToKey, pairingTokenContext, publicOf, sealFrame, type PublicIdentity } from '../src/shared/crypto';
import type { HandlerRegistry } from '../src/main/handlers';
import type { TerminalWatcher } from '../src/main/terminal';
import type { RemoteAuditAction } from '../src/shared/types';

import { ENROLL, FakeRelay } from './fake-relay';
import { accessOverHttp } from './support/relay-auth';

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
      channels: () => ['sessions:list', 'sessions:send', 'secrets:has', 'desktop:focus'],
      invoke: async (channel: string) => {
        calls.push(channel);
        if (channel === 'sessions:send') return undefined;
        if (channel === 'sessions:list') return [{ id: 's1', title: 'T' }];
        if (channel === 'desktop:focus') return { sessionId: 's1', at: 5, windowFocused: true };
        if (channel === 'secrets:has') return 'LEAK';
        throw new Error('unknown');
      }
    } as unknown as HandlerRegistry;
    let viewOnly = false;
    const host = new RemoteHost({
      registry: () => registry,
      secrets: { get: async () => undefined, set: async () => undefined },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined,
      viewOnly: () => viewOnly
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
    expect(approved!.hostPub.sig).toBeDefined();
    expect((await fetch(`http://127.0.0.1:${port}/v1/pair/poll?code=${code}`)).status).toBe(401);
    // The browser credential arrives sealed to the claim key; only this browser opens it.
    const refresh = await openSealedToKey(web.enc, approved!.sealedToken, pairingTokenContext(code, approved!.webDeviceId));
    expect(JSON.stringify(approved)).not.toContain(refresh);
    // The refresh credential alone buys no ticket: proof of possession comes first.
    const withRefresh = await fetch(`http://127.0.0.1:${port}/v1/ws/ticket?device=${encodeURIComponent(approved!.webDeviceId)}`, { method: 'POST', headers: { authorization: `Bearer ${refresh}` } });
    expect(withRefresh.status).toBe(401);
    const access = await accessOverHttp(`http://127.0.0.1:${port}`, { deviceId: approved!.webDeviceId, refresh, identity: web });

    // The host reconnected under its new device token; exchange the access token in an
    // Authorization header for a one-use upgrade ticket.
    await sleep(300);
    const ticketResponse = await fetch(`http://127.0.0.1:${port}/v1/ws/ticket?device=${encodeURIComponent(approved!.webDeviceId)}`, {
      method: 'POST', headers: { authorization: `Bearer ${access}` }
    });
    expect(ticketResponse.status).toBe(200);
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    const socketUrl = `ws://127.0.0.1:${port}/v1/ws/client?device=${encodeURIComponent(approved!.webDeviceId)}&ticket=${encodeURIComponent(ticket)}`;
    expect(socketUrl.includes(access) || socketUrl.includes(refresh) || socketUrl.includes('token=')).toBe(false);
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

    // The desktop's session focus is readable, and stays readable in view-only mode.
    await send({ type: 'invoke', id: 7, channel: 'desktop:focus', request: null });
    const focusRead = await openFrame<{ ok: boolean; value: unknown }>(session.key, ((await waitFrame(ws, (m) => m.t === 'd')) as { payload: never }).payload);
    expect(focusRead).toEqual({ type: 'result', id: 7, ok: true, value: { sessionId: 's1', at: 5, windowFocused: true } });
    // Writing it is desktop-only: a browser follows the desktop, it does not steer it.
    await send({ type: 'invoke', id: 8, channel: 'desktop:setFocus', request: { sessionId: 's1' } });
    const focusWrite = await openFrame<{ ok: boolean; error?: string }>(session.key, ((await waitFrame(ws, (m) => m.t === 'd')) as { payload: never }).payload);
    expect(focusWrite).toMatchObject({ ok: false, error: 'channel not available remotely' });
    expect(calls).toEqual(['sessions:list', 'sessions:send', 'sessions:send', 'sessions:send', 'desktop:focus']);
    viewOnly = true;
    await send({ type: 'invoke', id: 9, channel: 'desktop:focus', request: null });
    expect(await openFrame<{ ok: boolean }>(session.key, ((await waitFrame(ws, (m) => m.t === 'd')) as { payload: never }).payload)).toMatchObject({ ok: true });
    // The write half stays refused before dispatch, so no registry call is made.
    await send({ type: 'invoke', id: 10, channel: 'sessions:send', request: { id: 's1', input: { text: 'view-only' } } });
    const blocked = await openFrame<{ ok: boolean; error?: string }>(session.key, ((await waitFrame(ws, (m) => m.t === 'd')) as { payload: never }).payload);
    expect(blocked).toMatchObject({ ok: false, error: 'remote access is in view-only mode' });
    viewOnly = false;

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
    // The desktop's focus reaches a browser as its own push, so it can follow along.
    const focusPush = waitFrame(ws, (m) => m.t === 'd');
    await host.broadcastPush('push:desktopFocus', { sessionId: 's1', at: 9, windowFocused: true });
    expect(await openFrame(session.key, (await focusPush).payload as never)).toEqual({ type: 'push', channel: 'push:desktopFocus', payload: { sessionId: 's1', at: 9, windowFocused: true } });
    expect([...REMOTE_PUSH_CHANNELS].sort()).toEqual(['push:desktopFocus', 'push:missionsChanged', 'push:remotePolicy', 'push:sessionEvent', 'push:sessionsChanged', 'push:settingsChanged']);

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

  it('lets a paired browser watch and type into terminals, but never resize, attach, kill or close them (P3.5)', () => {
    for (const channel of ['terminal:list', 'terminal:screen', 'terminal:watch', 'terminal:unwatch', 'terminal:watchAck'] as const) {
      expect(REMOTE_CHANNELS.has(channel)).toBe(true);
      expect(REMOTE_READ_CHANNELS.has(channel)).toBe(true);
    }
    // Typing and opening a shell are writes: view-only mode refuses them.
    for (const channel of ['terminal:input', 'terminal:create'] as const) {
      expect(REMOTE_WRITE_CHANNELS.has(channel)).toBe(true);
      expect(REMOTE_READ_CHANNELS.has(channel)).toBe(false);
    }
    // The desktop owns its terminals' geometry and lifetime, and its own renderer's attach.
    for (const channel of ['terminal:resize', 'terminal:attach', 'terminal:detach', 'terminal:ack', 'terminal:kill', 'terminal:close', 'terminal:restart', 'terminal:clear', 'terminal:rename'] as const) {
      expect(REMOTE_CHANNELS.has(channel)).toBe(false);
    }
    // Raw PTY output is never broadcast; a watched terminal is sealed to its watcher alone.
    expect(REMOTE_PUSH_CHANNELS.has('push:terminalData')).toBe(false);
    expect(REMOTE_PUSH_CHANNELS.has('push:remoteTerminal')).toBe(false);
  });

  it('classifies every write control as write, not read', () => {
    for (const channel of ['sessions:send', 'sessions:interrupt', 'sessions:stop', 'sessions:create', 'sessions:rename', 'sessions:setModel', 'sessions:setEffort', 'sessions:setPermissionMode', 'approvals:respond'] as const) {
      expect(REMOTE_WRITE_CHANNELS.has(channel)).toBe(true);
      expect(REMOTE_READ_CHANNELS.has(channel)).toBe(false);
    }
  });
});

/** Pairs one browser with `host` over the fake relay and opens its e2e session. */
async function pairBrowser(host: RemoteHost, port: number, name: string) {
  const { code } = await host.startPairing('Test PC');
  const web = await generateIdentity();
  const claim = await fetch(`http://127.0.0.1:${port}/v1/pair/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, webPub: publicOf(web), name })
  });
  const { pollToken } = (await claim.json()) as { pollToken: string };
  for (let i = 0; i < 40 && host.state().pendingRequest?.name !== name; i++) await sleep(100);
  await host.respondPairing('approve');
  let approved: Extract<Awaited<ReturnType<typeof pollPairing>>, { status: 'approved' }> | null = null;
  for (let i = 0; i < 40 && !approved; i++) {
    const poll = (await (await fetch(`http://127.0.0.1:${port}/v1/pair/poll?code=${code}`, { headers: { authorization: `Bearer ${pollToken}` } })).json()) as Awaited<ReturnType<typeof pollPairing>>;
    if (poll.status === 'approved') approved = poll;
    else await sleep(100);
  }
  if (!approved) throw new Error(`${name} was not approved`);
  const refresh = await openSealedToKey(web.enc, approved.sealedToken, pairingTokenContext(code, approved.webDeviceId));
  const access = await accessOverHttp(`http://127.0.0.1:${port}`, { deviceId: approved.webDeviceId, refresh, identity: web });
  await sleep(300);
  const { ticket } = (await (await fetch(`http://127.0.0.1:${port}/v1/ws/ticket?device=${encodeURIComponent(approved.webDeviceId)}`, {
    method: 'POST', headers: { authorization: `Bearer ${access}` }
  })).json()) as { ticket: string };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws/client?device=${encodeURIComponent(approved.webDeviceId)}&ticket=${encodeURIComponent(ticket)}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', () => reject(new Error('browser upgrade failed')));
  });
  ws.send(JSON.stringify({ t: 'hello', host: approved.hostDeviceId }));
  const { hello, ephPriv } = await createHello(web);
  ws.send(JSON.stringify({ t: 'hs', seq: 0, payload: hello }));
  const hsReply = await waitFrame(ws, (m) => m.t === 'hs');
  const session = await clientFinish(hello, ephPriv, hsReply.payload as never, approved.hostPub, web);
  // Every sealed frame this browser receives, opened in order.
  const inbox: Record<string, unknown>[] = [];
  let opening = Promise.resolve();
  ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as { t: string; payload?: unknown };
    if (m.t !== 'd') return;
    opening = opening.then(async () => void inbox.push(await openFrame<Record<string, unknown>>(session.key, m.payload as never)));
  });
  let out = 0;
  let id = 0;
  const invoke = async (channel: string, request: unknown): Promise<Record<string, unknown>> => {
    const callId = ++id;
    const sealed = await sealFrame(session.key, session.salt, ++out, { type: 'invoke', id: callId, channel, request });
    ws.send(JSON.stringify({ t: 'd', seq: sealed.seq, payload: sealed }));
    for (let i = 0; i < 150; i++) {
      const result = inbox.find((m) => m.type === 'result' && m.id === callId);
      if (result) return result;
      await sleep(20);
    }
    throw new Error(`${channel} got no answer`);
  };
  const pushes = (channel: string) => inbox.filter((m) => m.type === 'push' && m.channel === channel).map((m) => m.payload as Record<string, unknown>);
  return { ws, invoke, pushes, deviceId: approved.webDeviceId };
}

describe('remote terminal over e2e (P3.5 read/write)', () => {
  let relay: FakeRelay;
  let port = 0;

  beforeAll(async () => {
    relay = new FakeRelay();
    port = await relay.start();
  });

  afterAll(async () => {
    await relay.stop();
  });

  it('keeps the socket enrollment reconnected on instead of replacing it a few seconds later', async () => {
    const registry = { channels: () => [], invoke: async () => [{ id: 's1' }] } as unknown as HandlerRegistry;
    const host = new RemoteHost({
      registry: () => registry,
      secrets: { get: async () => undefined, set: async () => undefined },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined
    });
    const socket = () => (host as unknown as { ws: unknown }).ws;
    await host.enable(`http://127.0.0.1:${port}`, ENROLL);
    // The first approval enrolls the desktop: it reconnects under its device token at once, while
    // the enrolling socket's close also schedules the routine reconnect.
    const browser = await pairBrowser(host, port, 'Fresh');
    try {
      const live = socket();
      expect(await browser.invoke('sessions:list', null)).toMatchObject({ ok: true });
      await sleep(3500); // past RECONNECT_MS
      // That late reconnect must not replace a healthy socket: it would strand the browser.
      expect(socket()).toBe(live);
      expect(await browser.invoke('sessions:list', null)).toMatchObject({ ok: true, value: [{ id: 's1' }] });
    } finally {
      browser.ws.close();
      await host.disable();
    }
  });

  it('streams a watched terminal to its watcher alone, types through the registry, and honors view-only', async () => {
    const registryCalls: { channel: string; request: unknown }[] = [];
    const registry = {
      channels: () => [],
      invoke: async (channel: string, request: unknown) => {
        registryCalls.push({ channel, request });
        if (channel === 'terminal:create') return { id: 't_new', sessionId: 's1' };
        return undefined;
      }
    } as unknown as HandlerRegistry;
    const watchers = new Set<TerminalWatcher>();
    let seq = 2;
    const info = (id: string, patch: Record<string, unknown> = {}) => ({ id, sessionId: 's1', title: 'bash', shell: 'bash' as const, shellName: 'bash', cwd: '/', createdAt: 1, pid: 77, ...patch });
    const terminals = {
      // A running shell, a tab restored from the last run whose shell has not started, and one that exited.
      list: () => [info('t1'), info('t_restored', { pid: undefined, restored: true }), info('t_exited', { pid: undefined, exit: { code: 1 } })],
      watch: (_id: string, watcher: TerminalWatcher) => {
        watchers.add(watcher);
        return () => void watchers.delete(watcher);
      },
      snapshot: async (id: string) => {
        if (id !== 't1') throw new Error('Terminal not found');
        return { snapshot: '$ make\r\n', seq, cols: 90, rows: 20, info: info('t1') };
      }
    };
    const emit = (data: string) => {
      seq++;
      for (const w of [...watchers]) w.data(seq, data);
    };
    const audit: RemoteAuditAction[] = [];
    let viewOnly = false;
    const host = new RemoteHost({
      registry: () => registry,
      secrets: { get: async () => undefined, set: async () => undefined },
      pushState: () => undefined,
      log: () => undefined,
      broadcast: () => undefined,
      viewOnly: () => viewOnly,
      terminals: () => terminals,
      audit: { record: (action: RemoteAuditAction) => void audit.push(action), list: () => [], clear: () => undefined } as never
    });
    await host.enable(`http://127.0.0.1:${port}`, ENROLL);
    const watcher = await pairBrowser(host, port, 'Watcher');
    const other = await pairBrowser(host, port, 'Other');
    try {
      // Watch: the snapshot arrives as the answer, at the desktop's geometry.
      const watched = await watcher.invoke('terminal:watch', { terminalId: 't1' });
      expect(watched).toMatchObject({ ok: true, value: { terminalId: 't1', snapshot: '$ make\r\n', seq: 2, cols: 90, rows: 20 } });
      emit('compiling…');
      await expect.poll(() => watcher.pushes('push:remoteTerminal')).toEqual([{ terminalId: 't1', kind: 'data', seq: 3, data: 'compiling…' }]);
      // The other browser never asked, so it never receives this terminal.
      await sleep(100);
      expect(other.pushes('push:remoteTerminal')).toEqual([]);
      // Even a broadcast of the frame (a desktop bug) is dropped before sealing.
      await host.broadcastPush('push:remoteTerminal', { terminalId: 't1', kind: 'data', seq: 99, data: 'broadcast' });
      await sleep(100);
      expect(other.pushes('push:remoteTerminal')).toEqual([]);

      // Typing reaches the registry (and its Mission terminal guards); the first keystroke is audited once.
      expect(await watcher.invoke('terminal:input', { terminalId: 't1', data: 'ls\r' })).toMatchObject({ ok: true });
      expect(await watcher.invoke('terminal:input', { terminalId: 't1', data: 'pwd\r' })).toMatchObject({ ok: true });
      expect(registryCalls.filter((c) => c.channel === 'terminal:input').map((c) => c.request)).toEqual([
        { terminalId: 't1', data: 'ls\r' }, { terminalId: 't1', data: 'pwd\r' }
      ]);
      expect(audit.filter((a) => a === 'terminal-input')).toHaveLength(1);
      // An oversized input is refused before the registry.
      expect(await watcher.invoke('terminal:input', { terminalId: 't1', data: 'x'.repeat(64 * 1024 + 1) })).toMatchObject({ ok: false, error: 'input too large' });
      // Only a running shell takes keystrokes: an unknown id, a restored tab that would queue them
      // unseen until the desktop opens it, and an exited shell are all refused before the registry.
      expect(await watcher.invoke('terminal:input', { terminalId: 't_made_up', data: 'x' })).toMatchObject({ ok: false, error: 'Terminal not found' });
      expect(await watcher.invoke('terminal:input', { terminalId: 't_restored', data: 'rm -rf build\r' })).toMatchObject({ ok: false, error: "This terminal's shell starts when it is opened on the computer" });
      expect(await watcher.invoke('terminal:input', { terminalId: 't_exited', data: 'x' })).toMatchObject({ ok: false, error: "This terminal's shell has exited" });
      expect(registryCalls.filter((c) => c.channel === 'terminal:input')).toHaveLength(2);
      expect(audit.filter((a) => a === 'terminal-input')).toHaveLength(1);
      // Resizing stays the desktop's.
      expect(await watcher.invoke('terminal:resize', { terminalId: 't1', cols: 10, rows: 5 })).toMatchObject({ ok: false, error: 'channel not available remotely' });
      // Opening a shell for the session is a write, audited.
      expect(await watcher.invoke('terminal:create', { sessionId: 's1' })).toMatchObject({ ok: true, value: { id: 't_new' } });
      expect(audit).toContain('terminal-create');

      // View-only: watching still works, typing and opening shells never reach the registry.
      viewOnly = true;
      const before = registryCalls.length;
      expect(await other.invoke('terminal:watch', { terminalId: 't1' })).toMatchObject({ ok: true });
      expect(await other.invoke('terminal:input', { terminalId: 't1', data: 'rm -rf /\r' })).toMatchObject({ ok: false, error: 'remote access is in view-only mode' });
      expect(await other.invoke('terminal:create', { sessionId: 's1' })).toMatchObject({ ok: false, error: 'remote access is in view-only mode' });
      expect(registryCalls.length).toBe(before);
      emit('both see this');
      await expect.poll(() => other.pushes('push:remoteTerminal').length).toBe(1);
      viewOnly = false;

      // A browser that leaves stops its stream; the other keeps its own.
      expect(watchers.size).toBe(2);
      watcher.ws.close();
      await expect.poll(() => watchers.size, { timeout: 5000 }).toBe(1);
      expect(await other.invoke('terminal:unwatch', { terminalId: 't1' })).toMatchObject({ ok: true });
      expect(watchers.size).toBe(0);
      // Watching a terminal that does not exist is an error, not a hang.
      expect(await other.invoke('terminal:watch', { terminalId: 't_gone' })).toMatchObject({ ok: false, error: 'Terminal not found' });
      expect(watchers.size).toBe(0);
    } finally {
      watcher.ws.close();
      other.ws.close();
      await host.disable();
    }
  });
});

let sealedCounter = 0;
function sealedSeq(): number {
  return ++sealedCounter;
}