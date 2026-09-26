/** The browser Transport (src/web/transport): the local capability gate, view-only writes, the
 *  offline mirror backend, reconnect backoff and the visibility probe. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayTransport } from '../src/web/transport/relay-transport';
import { importAesKey, openBlob, randomKeyB64, sealBlob } from '../src/shared/crypto';
import type { MirrorIndex, MirrorSnapshot } from '../src/shared/mirror';
import type { DesktopFocus, SessionMeta, TranscriptItem } from '../src/shared/types';
import type { RelayClient } from '../relay/src/web-client';


/** The RelayClient surface RelayTransport actually uses. */
class FakeClient {
  connected = false;
  credentials: { hostDeviceId: string; hostName: string } | null = { hostDeviceId: 'h1', hostName: 'Work PC' };
  connectCalls = 0;
  invokes: Array<[string, unknown]> = [];
  mirrorAvailable = false;
  index: MirrorIndex | null = null;
  snapshots = new Map<string, MirrorSnapshot>();
  pushes: ((channel: string, payload: unknown) => void) | null = null;

  hasCredentials() {
    return !!this.credentials;
  }

  isConnected() {
    return this.connected;
  }

  onPush(listener: (channel: string, payload: unknown) => void) {
    this.pushes = listener;
    return () => (this.pushes = null);
  }

  async connect(onClose?: () => void) {
    this.connectCalls++;
    if (!this.connected) throw new Error('relay unreachable');
    void onClose;
  }

  async invoke(channel: string, request: unknown) {
    this.invokes.push([channel, request]);
    return `answered:${channel}`;
  }

  hasMirror() {
    return this.mirrorAvailable;
  }

  async mirrorIndex() {
    return this.index;
  }

  async mirrorSession(id: string) {
    return this.snapshots.get(id) ?? null;
  }
}

const client = () => new FakeClient();
const transportFor = (fake: FakeClient) => new RelayTransport(fake as unknown as RelayClient);

const textItem: TranscriptItem = { id: 'm1', kind: 'assistant', ts: 1, text: 'from the mirror' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RelayTransport gate', () => {
  it('refuses a channel off the remote allowlist without calling the client', async () => {
    const fake = client();
    const transport = transportFor(fake);
    await expect(transport.invoke('secrets:has', { providerId: 'anthropic' })).rejects.toThrow('channel not available remotely');
    expect(fake.invokes).toEqual([]);
    // The gate is exact: a read channel passes and reaches the client.
    fake.connected = true;
    await transport.connect();
    await expect(transport.invoke('sessions:list', undefined)).resolves.toBe('answered:sessions:list');
  });

  it('refuses writes in view-only mode but serves reads, and takes the policy from the push', async () => {
    const fake = client();
    fake.connected = true;
    const transport = transportFor(fake);
    await transport.connect();
    fake.pushes!('push:remotePolicy', { viewOnly: true });
    expect(transport.can('sessions:send')).toBe(false);
    await expect(transport.invoke('sessions:send', { id: 's1', input: { text: 'x' } })).rejects.toThrow('channel not available remotely');
    expect(fake.invokes).toEqual([]);
    await expect(transport.invoke('sessions:list', undefined)).resolves.toBe('answered:sessions:list');
    fake.pushes!('push:remotePolicy', { viewOnly: false });
    expect(transport.can('sessions:send')).toBe(true);
  });

  it('fails fast when there is no connection at all', async () => {
    const transport = transportFor(client());
    await expect(transport.invoke('sessions:list', undefined)).rejects.toThrow('not connected');
  });
});

describe('RelayTransport offline mirror', () => {
  it('serves sessions and transcripts from the sealed snapshot when the desktop is unreachable', async () => {
    // A real seal/open round trip, so the shape the desktop uploads is the shape answered here.
    const key = await importAesKey(randomKeyB64());
    const index: MirrorIndex = {
      hostName: 'Work PC',
      updatedAt: 42,
      focus: 's1',
      sessions: [{ id: 's1', title: 'Mirrored', status: 'idle', harness: 'claude', projectRoot: '/repo', updatedAt: 42 }]
    };
    const snapshot: MirrorSnapshot = { id: 's1', title: 'Mirrored', status: 'idle', harness: 'claude', updatedAt: 42, items: [textItem] };
    const openedIndex = (await openBlob<MirrorIndex>(key, await sealBlob(key, index)))!;
    const openedSnapshot = (await openBlob<MirrorSnapshot>(key, await sealBlob(key, snapshot)))!;
    const fake = client();
    fake.mirrorAvailable = true;
    fake.index = openedIndex;
    fake.snapshots.set('s1', openedSnapshot);

    const transport = transportFor(fake);
    await transport.connect(); // fails: the client is not connected
    expect(transport.state()).toBe('mirror');

    const sessions = (await transport.invoke('sessions:list', undefined)) as SessionMeta[];
    expect(sessions).toEqual([expect.objectContaining({ id: 's1', title: 'Mirrored', cwd: '/repo', status: 'idle' })]);
    const page = (await transport.invoke('sessions:transcriptPage', { id: 's1' })) as { items: TranscriptItem[]; start: number; total: number };
    expect(page.items).toEqual([textItem]);
    expect(page.total).toBe(1);
    const focus = (await transport.invoke('desktop:focus', undefined)) as DesktopFocus;
    expect(focus).toMatchObject({ sessionId: 's1' });
    // A write is still refused even though the mirror answers reads.
    await expect(transport.invoke('sessions:send', { id: 's1', input: { text: 'x' } })).rejects.toThrow('channel not available remotely');
    expect(fake.invokes).toEqual([]);
  });

  it('lands on offline, not mirror, when the browser has no mirror key', async () => {
    const fake = client();
    const transport = transportFor(fake);
    await transport.connect();
    expect(transport.state()).toBe('offline');
  });
});

describe('RelayTransport reconnect', () => {
  it('backs off from one second to fifteen and wakes immediately on visibility or online', async () => {
    const fake = client();
    const transport = transportFor(fake);
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      addEventListener: (name: string, handler: () => void) => listeners.set(name, handler),
      removeEventListener: () => undefined
    });
    vi.stubGlobal('window', {
      innerHeight: 800,
      addEventListener: (name: string, handler: () => void) => listeners.set(name, handler)
    });

    transport.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.connectCalls).toBe(1);
    // First backoff is one second; the second failure schedules two.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.connectCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.connectCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.connectCalls).toBe(3);

    // The wake probe does not wait for the backoff.
    (document as unknown as { visibilityState: string }).visibilityState = 'visible';
    listeners.get('visibilitychange')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.connectCalls).toBe(4);
  });

  it('does not reconnect when there is no pairing at all', async () => {
    const fake = client();
    fake.credentials = null;
    const transport = transportFor(fake);
    await transport.connect();
    expect(transport.state()).toBe('unpaired');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.connectCalls).toBe(0);
  });
});
