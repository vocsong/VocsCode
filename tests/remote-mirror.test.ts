/** Unit tests for the offline mirror builder (src/main/remote/mirror.ts): debounced snapshot
 *  uploads, index refresh, size capping, clearing when the policy is turned off, and fencing a
 *  publication that is still in progress when mirroring is disabled, stopped, re-keyed or loses its
 *  host. The builder talks to a stub host, so no relay is involved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capItems, MAX_SNAPSHOT_BYTES, RemoteMirror } from '../src/main/remote/mirror';
import { MIRROR_MAX_BLOB_CHARS } from '../relay/src/core';
import { importAesKey, openBlob, randomKeyB64 } from '../src/shared/crypto';
import type { MirrorIndex, MirrorSnapshot } from '../src/shared/mirror';
import type { RemoteHost } from '../src/main/remote/host';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Holds a snapshot right after it is sealed, so a test can change the policy, key or host while
 *  the ciphertext exists but has not been handed to the host yet. Index blobs pass straight through. */
const sealHold = vi.hoisted(() => ({ snapshot: null as null | (() => Promise<void>) }));
vi.mock('../src/shared/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/crypto')>();
  return {
    ...actual,
    sealBlob: async (key: CryptoKey, plaintext: unknown) => {
      const sealed = await actual.sealBlob(key, plaintext);
      if (plaintext && typeof plaintext === 'object' && 'items' in plaintext) await sealHold.snapshot?.();
      return sealed;
    }
  };
});

function session(id: string, updatedAt: number): SessionMeta {
  return { id, title: `Title ${id}`, status: 'idle', updatedAt, config: { harness: 'native', projectRoot: '/repo' } } as unknown as SessionMeta;
}

function item(id: string, text = `text ${id}`): TranscriptItem {
  return { id, kind: 'user', ts: 1, text } as TranscriptItem;
}

interface Put {
  kind: 'index' | 'session';
  id?: string;
  blob: { iv: string; ct: string };
}

function harness(opts: { secret: string; puts: Put[]; cleared: () => void; relayHas?: string[]; deleted?: string[] }) {
  return {
    mirrorSecret: () => opts.secret,
    putMirror: async (kind: 'index' | 'session', id: string | undefined, blob: { iv: string; ct: string }) => {
      opts.puts.push({ kind, id, blob });
      return true;
    },
    clearMirror: async () => opts.cleared(),
    mirroredSessions: async () => opts.relayHas ?? [],
    deleteMirrorSession: async (id: string) => void opts.deleted?.push(id)
  } as unknown as RemoteHost;
}

describe('offline mirror builder', () => {
  it('debounces a session snapshot and seals it under the host key', async () => {
    const secret = randomKeyB64();
    const puts: Put[] = [];
    const metas = [session('s1', 5)];
    const items = [item('m1'), item('m2')];
    const mirror = new RemoteMirror({
      host: () => harness({ secret, puts, cleared: () => undefined }),
      sessions: () => metas,
      transcript: async () => items,
      enabled: () => true,
      debounceMs: 5,
      log: () => undefined
    });

    mirror.notify('s1');
    mirror.notify('s1'); // second edit inside the window must not double-upload
    expect(puts).toHaveLength(0);
    await sleep(40);
    const sessionPuts = puts.filter((p) => p.kind === 'session');
    expect(sessionPuts).toHaveLength(1);

    const key = await importAesKey(secret);
    const snapshot = await openBlob<MirrorSnapshot>(key, sessionPuts[0].blob);
    expect(snapshot.title).toBe('Title s1');
    expect(snapshot.items).toEqual(items);
    expect(snapshot.truncated).toBeUndefined();

    // The index rides alongside the snapshot so the sidebar can render offline.
    const index = await openBlob<MirrorIndex>(key, puts.find((p) => p.kind === 'index')!.blob);
    expect(index.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('keeps a bounded tail when the transcript is too large', async () => {
    const secret = randomKeyB64();
    const puts: Put[] = [];
    const big = Array.from({ length: 40 }, (_, i) => item(`m${i}`, 'x'.repeat(100_000)));
    const mirror = new RemoteMirror({
      host: () => harness({ secret, puts, cleared: () => undefined }),
      sessions: () => [session('s1', 1)],
      transcript: async () => big,
      enabled: () => true,
      debounceMs: 5,
      log: () => undefined
    });
    mirror.notify('s1');
    await sleep(500);

    const key = await importAesKey(secret);
    const sealed = puts.find((p) => p.kind === 'session')!.blob;
    const snapshot = await openBlob<MirrorSnapshot>(key, sealed);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.items.at(-1)?.id).toBe('m39');
    expect(new TextEncoder().encode(JSON.stringify(snapshot.items)).byteLength).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    // What the relay will actually be asked to store must fit a Durable Object value.
    expect(sealed.ct.length).toBeLessThanOrEqual(MIRROR_MAX_BLOB_CHARS);
  });

  it('measures the cap in UTF-8 bytes, so multi-byte transcripts still fit the relay', async () => {
    // 3-byte characters: the old UTF-16 length check let these through at three times the size.
    const wide = Array.from({ length: 12 }, (_, i) => item(`w${i}`, 'ペ'.repeat(100_000)));
    const { items, truncated } = capItems(wide);
    expect(truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(items)).byteLength).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect(items.at(-1)?.id).toBe('w11');
    expect(capItems([item('a'), item('b')])).toEqual({ items: [item('a'), item('b')], truncated: false });
    const long = Array.from({ length: 900 }, (_, i) => item(`n${i}`));
    expect(capItems(long)).toMatchObject({ truncated: true, items: expect.arrayContaining([item('n899')]) });
    expect(capItems(long).items).toHaveLength(800);
  });

  it('deletes relay copies of sessions the index no longer lists', async () => {
    const secret = randomKeyB64();
    const puts: Put[] = [];
    const deleted: string[] = [];
    const mirror = new RemoteMirror({
      host: () => harness({ secret, puts, cleared: () => undefined, relayHas: ['s1', 'deleted-session', 'old-session'], deleted }),
      sessions: () => [session('s1', 5)],
      transcript: async () => [item('m1')],
      enabled: () => true,
      debounceMs: 5,
      log: () => undefined
    });
    mirror.notifyIndex();
    await sleep(40);
    expect(deleted.sort()).toEqual(['deleted-session', 'old-session']);
  });

  it('does nothing while disabled and clears the relay copy when turned off', async () => {
    const secret = randomKeyB64();
    const puts: Put[] = [];
    let cleared = 0;
    let enabled = false;
    const mirror = new RemoteMirror({
      host: () => harness({ secret, puts, cleared: () => cleared++ }),
      sessions: () => [session('s1', 1)],
      transcript: async () => [item('m1')],
      enabled: () => enabled,
      debounceMs: 5,
      log: () => undefined
    });

    mirror.notify('s1');
    mirror.sync();
    await sleep(30);
    expect(puts).toHaveLength(0);

    enabled = true;
    mirror.sync();
    await sleep(40);
    expect(puts.length).toBeGreaterThan(0);

    await mirror.disable();
    expect(cleared).toBe(1);
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function until(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

async function opens(secret: string, blob: { iv: string; ct: string }): Promise<boolean> {
  try {
    await openBlob(await importAesKey(secret), blob);
    return true;
  } catch {
    return false;
  }
}

type Pause = 'transcript' | 'seal' | 'put';

/** One snapshot upload held at `pause` (the transcript read, right after sealing, or on its way
 *  to the relay) while the test changes the policy, the key or the host. The stub relay records
 *  each write in the order it applies them. */
function heldUpload(pause: Pause) {
  const state = { enabled: true, secret: randomKeyB64(), hostPresent: true };
  const reached = deferred();
  const release = deferred();
  let held = false;
  const hold = async () => {
    if (held) return;
    held = true;
    reached.resolve();
    await release.promise;
  };
  const blobs = new Map<string, { iv: string; ct: string }>();
  const events: string[] = [];
  const writes: Array<{ at: string; blob: { iv: string; ct: string } }> = [];
  const host = {
    mirrorSecret: () => state.secret,
    putMirror: async (kind: 'index' | 'session', id: string | undefined, blob: { iv: string; ct: string }) => {
      if (kind === 'session' && pause === 'put') await hold();
      const at = kind === 'index' ? 'index' : `session:${id}`;
      blobs.set(at, blob);
      writes.push({ at, blob });
      events.push(`put:${at}`);
      return true;
    },
    clearMirror: async () => {
      blobs.clear();
      events.push('clear');
      return true;
    },
    mirroredSessions: async () => [...blobs.keys()].filter((k) => k.startsWith('session:')).map((k) => k.slice('session:'.length)),
    deleteMirrorSession: async (id: string) => {
      blobs.delete(`session:${id}`);
      events.push(`delete:session:${id}`);
    }
  } as unknown as RemoteHost;
  sealHold.snapshot = pause === 'seal' ? hold : null;
  const mirror = new RemoteMirror({
    host: () => (state.hostPresent ? host : null),
    sessions: () => [session('s1', 1)],
    transcript: async () => {
      if (pause === 'transcript') await hold();
      return [item('m1', 'mirrored text')];
    },
    enabled: () => state.enabled,
    debounceMs: 5,
    log: () => undefined
  });
  return {
    state,
    host,
    blobs,
    events,
    writes,
    mirror,
    release: () => release.resolve(),
    /** Starts the upload and returns once it is held, with the index already published. */
    start: async () => {
      mirror.notify('s1');
      await reached.promise;
      await until(() => events.includes('put:index'), 'the index upload');
    }
  };
}

/** Lets a released upload run to completion (transcript, sealing, the stub put). */
const settle = () => sleep(60);

describe('offline mirror publication fencing', () => {
  afterEach(() => {
    sealHold.snapshot = null;
  });

  for (const pause of ['transcript', 'seal'] as const) {
    it(`publishes nothing once mirroring is disabled while a snapshot is held at the ${pause} step`, async () => {
      const t = heldUpload(pause);
      await t.start();
      t.state.enabled = false;
      await t.mirror.disable();
      t.release();
      await settle();
      expect(t.events).toEqual(['put:index', 'clear']);
      expect(t.blobs.size).toBe(0);
    });

    it(`never sends ciphertext under a rotated key when the key changes at the ${pause} step`, async () => {
      const t = heldUpload(pause);
      await t.start();
      const oldSecret = t.state.secret;
      // What RemoteHost does on rotation: swap the key, drop the relay copy, then re-sync.
      t.state.secret = randomKeyB64();
      await t.host.clearMirror();
      t.mirror.sync();
      t.release();
      await settle();
      expect(t.events.slice(0, 2)).toEqual(['put:index', 'clear']);
      // Only the re-sync publishes after the clear: one index and one snapshot, both new-key.
      expect(t.events.slice(2).sort()).toEqual(['put:index', 'put:session:s1']);
      const afterClear = t.writes.slice(1);
      for (const write of afterClear) {
        expect(await opens(oldSecret, write.blob)).toBe(false);
        expect(await opens(t.state.secret, write.blob)).toBe(true);
      }
      expect([...t.blobs.keys()].sort()).toEqual(['index', 'session:s1']);
    });
  }

  it('waits for a snapshot already on its way to the relay before clearing, so the clear removes it', async () => {
    const t = heldUpload('put');
    await t.start();
    t.state.enabled = false;
    const disabling = t.mirror.disable();
    await sleep(20);
    // The clear must not overtake the write in flight.
    expect(t.events).toEqual(['put:index']);
    t.release();
    await disabling;
    await settle();
    expect(t.events).toEqual(['put:index', 'put:session:s1', 'clear']);
    expect(t.blobs.size).toBe(0);
  });

  it('publishes nothing to a host that went away while a sealed snapshot was held', async () => {
    const t = heldUpload('seal');
    await t.start();
    t.state.hostPresent = false;
    t.release();
    await settle();
    expect(t.events).toEqual(['put:index']);
  });

  it('publishes nothing after the mirror is stopped while the transcript is being read', async () => {
    const t = heldUpload('transcript');
    await t.start();
    t.mirror.stop();
    t.release();
    await settle();
    expect(t.events).toEqual(['put:index']);
  });
});
