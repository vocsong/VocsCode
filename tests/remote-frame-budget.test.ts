/** The remote surface must never hand the relay a frame it will silently drop: relay/src/hub.ts
 *  discards anything over MAX_WS_FRAME_BYTES, which leaves a client waiting out its invoke timeout.
 *  These tests pair a browser for real (fake relay, real crypto) and check the three guards: the
 *  server-side refusal, the transcript page budget, and the SessionMeta projection. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RemoteHost } from '../src/main/remote/host';
import type { HandlerRegistry } from '../src/main/handlers';
import { emptyUsage } from '../src/main/models/static-models';
import { clientFinish, createHello, generateIdentity, importAesKey, openFrame, openSealedToKey, pairingTokenContext, publicOf, randomKeyB64, sealFrame, type PublicIdentity, type SealedToKey } from '../src/shared/crypto';
import { REMOTE_FRAME_MAX_BYTES } from '../src/shared/remote-channels';
import { transcriptPage } from '../src/shared/transcript-page';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { ENROLL, FakeRelay } from './fake-relay';
import { accessOverHttp } from './support/relay-auth';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the host may put inside one frame, as far as these tests care. */
interface Inner {
  type: string;
  id?: number;
  ok?: boolean;
  value?: unknown;
  error?: string;
  channel?: string;
  payload?: unknown;
}

interface Approved {
  hostPub: PublicIdentity;
  hostDeviceId: string;
  webDeviceId: string;
  sealedToken: SealedToKey;
}

/** The full pairing dance, reduced to what a test needs: a connected, handshaken browser. */
async function pairBrowser(host: RemoteHost, base: string) {
  const { code } = await host.startPairing('Test PC');
  const web = await generateIdentity();
  const claim = await fetch(`${base}/v1/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, webPub: publicOf(web), name: 'Test Browser' })
  });
  const { pollToken } = (await claim.json()) as { pollToken: string };
  for (let i = 0; i < 40 && !host.state().pendingRequest; i++) await sleep(100);
  await host.respondPairing('approve');
  let approved: Approved | null = null;
  for (let i = 0; i < 40 && !approved; i++) {
    const response = await fetch(`${base}/v1/pair/poll?code=${code}`, { headers: { authorization: `Bearer ${pollToken}` } });
    const poll = (await response.json()) as { status: string } & Partial<Approved>;
    if (poll.status === 'approved') approved = poll as Approved;
    else await sleep(100);
  }
  if (!approved) throw new Error('pairing was never approved');
  const refresh = await openSealedToKey(web.enc, approved.sealedToken, pairingTokenContext(code, approved.webDeviceId));
  const access = await accessOverHttp(base, { deviceId: approved.webDeviceId, refresh, identity: web });
  // The host reconnects under its new device token; give it a moment before the browser connects.
  await sleep(300);
  const ticketResponse = await fetch(`${base}/v1/ws/ticket?device=${encodeURIComponent(approved.webDeviceId)}`, {
    method: 'POST', headers: { authorization: `Bearer ${access}` }
  });
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/ws/client?device=${encodeURIComponent(approved.webDeviceId)}&ticket=${encodeURIComponent(ticket)}`);

  // A queue listener from the start: the handshake reply and the mirror key the host sends
  // immediately after it must not race the call that reads them.
  const inbox: Record<string, unknown>[] = [];
  let waiting: (() => void) | null = null;
  ws.on('message', (data) => {
    inbox.push(JSON.parse(String(data)) as Record<string, unknown>);
    waiting?.();
    waiting = null;
  });
  const nextFrame = async (): Promise<Record<string, unknown>> => {
    while (!inbox.length) await new Promise<void>((resolve) => { waiting = resolve; });
    return inbox.shift()!;
  };
  const nextData = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const frame = await nextFrame();
      if (frame.t === 'd') return frame;
    }
  };

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', () => reject(new Error('browser upgrade failed')));
  });
  ws.send(JSON.stringify({ t: 'hello', host: approved.hostDeviceId }));
  const { hello, ephPriv } = await createHello(web);
  ws.send(JSON.stringify({ t: 'hs', seq: 0, payload: hello }));
  let hsReply: Record<string, unknown> | null = null;
  while (!hsReply) {
    const frame = await nextFrame();
    if (frame.t === 'hs') hsReply = frame;
  }
  const session = await clientFinish(hello, ephPriv, hsReply.payload as never, approved.hostPub, web);
  const next = async (): Promise<Inner> => openFrame<Inner>(session.key, (await nextData()).payload as never);

  // Drain the mirror key handed over right after the handshake, so tests see only their frames.
  if ((await next()).type !== 'mirror.key') throw new Error('expected the mirror key after the handshake');

  let id = 0;
  const invoke = async (channel: string, request: unknown) => {
    const requestId = ++id;
    const sealed = await sealFrame(session.key, session.salt, requestId, { type: 'invoke', id: requestId, channel, request });
    ws.send(JSON.stringify({ t: 'd', seq: sealed.seq, payload: sealed }));
    return next();
  };
  return { web, invoke, next, close: () => ws.close() };
}

function hostWith(registry: HandlerRegistry, log: (level: string, message: string) => void = () => undefined): RemoteHost {
  return new RemoteHost({
    registry: () => registry,
    secrets: { get: async () => undefined, set: async () => undefined },
    pushState: () => undefined,
    log: log as never,
    broadcast: () => undefined
  });
}

const meta = (): SessionMeta => ({
  id: 's1', title: 'T', createdAt: 0, updatedAt: 0,
  config: { harness: 'native', permissionMode: 'ask', projectRoot: '/' },
  cwd: '/', status: 'idle', harnessRef: {}, usage: emptyUsage(),
  knowledgeDigest: 'SECRET DIGEST', pendingKnowledgeDigest: true, pendingForkContext: true, harnessCommands: ['/goal']
});

let relay: FakeRelay;
let base = '';

beforeAll(async () => {
  relay = new FakeRelay();
  base = `http://127.0.0.1:${await relay.start()}`;
});

afterAll(async () => {
  await relay.stop();
});

describe('remote frame budget', () => {
  it('fails an oversized result fast instead of letting the relay drop it', async () => {
    const registry = {
      channels: () => ['sessions:transcript'],
      invoke: async () => [{ id: 'big', kind: 'assistant', ts: 1, text: 'x'.repeat(2 * 1024 * 1024) } as TranscriptItem]
    } as unknown as HandlerRegistry;
    const host = hostWith(registry);
    try {
      await host.enable(base, ENROLL);
      const browser = await pairBrowser(host, base);
      const started = Date.now();
      const result = await browser.invoke('sessions:transcript', { id: 's1' });
      expect(result).toMatchObject({ type: 'result', ok: false, error: 'response too large' });
      // Fast means far below the 30 s timeout the old silent drop produced.
      expect(Date.now() - started).toBeLessThan(10_000);
      browser.close();
    } finally {
      await host.disable();
    }
  });

  it('seals a full transcript page under the relay frame limit', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, kind: 'tool', ts: i, name: 'Bash', status: 'done', output: 'x'.repeat(30 * 1024) }) as TranscriptItem);
    const page = transcriptPage(many, {});
    expect(page.items.length).toBeLessThan(many.length);
    expect(page.items.length).toBeGreaterThan(1);
    // Seal exactly the way RemoteHost.sendTo does, and measure the frame the relay would see.
    const sealed = await sealFrame(await importAesKey(randomKeyB64()), crypto.getRandomValues(new Uint8Array(16)), 1, { type: 'result', id: 1, ok: true, value: page });
    const wire = JSON.stringify({ t: 'd', to: 'web', seq: sealed.seq, payload: sealed });
    const bytes = Buffer.byteLength(wire, 'utf8');
    expect(bytes).toBeLessThan(REMOTE_FRAME_MAX_BYTES);
    // A full page, not a trivially small one: the budget is doing real work near the limit.
    expect(bytes).toBeGreaterThan(REMOTE_FRAME_MAX_BYTES / 2);
  });

  it('strips desktop-only SessionMeta fields from results and session pushes', async () => {
    const registry = {
      channels: () => ['sessions:list'],
      invoke: async () => [meta()]
    } as unknown as HandlerRegistry;
    const host = hostWith(registry);
    try {
      await host.enable(base, ENROLL);
      const browser = await pairBrowser(host, base);
      const result = await browser.invoke('sessions:list', null);
      expect(result.ok).toBe(true);
      const first = (result.value as SessionMeta[])[0];
      for (const key of ['knowledgeDigest', 'pendingKnowledgeDigest', 'pendingForkContext', 'harnessCommands']) {
        expect(first, `${key} reached the browser`).not.toHaveProperty(key);
      }
      expect(JSON.stringify(result.value)).not.toContain('SECRET DIGEST');
      expect(first).toMatchObject({ id: 's1', title: 'T', status: 'idle' });

      await host.broadcastPush('push:sessionsChanged', [meta()]);
      const pushed = await browser.next();
      expect(pushed).toMatchObject({ type: 'push', channel: 'push:sessionsChanged' });
      expect(JSON.stringify(pushed.payload)).not.toContain('SECRET DIGEST');
      expect((pushed.payload as SessionMeta[])[0]).not.toHaveProperty('knowledgeDigest');
      browser.close();
    } finally {
      await host.disable();
    }
  });
});
