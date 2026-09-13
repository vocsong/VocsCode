/** Unit tests for the e2e crypto core (src/shared/crypto.ts): handshake signatures and
 *  identity binding, session-key agreement, and the AEAD frame layer. Runs in Node
 *  (global WebCrypto) — the identical module also runs in the browser. */
import { describe, expect, it } from 'vitest';
import { clientFinish, createHello, generateIdentity, hostAccept, newSalt, openFrame, publicOf, sealFrame, stable } from '../src/shared/crypto';

describe('e2e crypto', () => {
  it('completes the handshake and derives matching keys', async () => {
    const client = await generateIdentity();
    const host = await generateIdentity();
    const { hello, ephPriv } = await createHello(client);
    const accepted = await hostAccept(host, hello, publicOf(client));
    const finished = await clientFinish(hello, ephPriv, accepted.reply, publicOf(host), client);
    expect(finished.key).toBeDefined();

    // A frame sealed by the client opens on the host and vice versa.
    const seq = 1;
    const sealed = await sealFrame(finished.key, finished.salt, seq, { hello: 'world' });
    expect(await openFrame(accepted.key, sealed)).toEqual({ hello: 'world' });
    const back = await sealFrame(accepted.key, accepted.salt, 1, { answer: 42 });
    expect(await openFrame(finished.key, back)).toEqual({ answer: 42 });
  });

  it('rejects a host identity that does not match the registry', async () => {
    const client = await generateIdentity();
    const host = await generateIdentity();
    const impostor = await generateIdentity();
    const { hello, ephPriv } = await createHello(client);
    const accepted = await hostAccept(host, hello, publicOf(client));
    await expect(clientFinish(hello, ephPriv, accepted.reply, publicOf(impostor), client)).rejects.toThrow('unknown host identity');
  });

  it('rejects tampered handshake transcripts', async () => {
    const client = await generateIdentity();
    const host = await generateIdentity();
    const { hello, ephPriv } = await createHello(client);
    const accepted = await hostAccept(host, hello, publicOf(client));
    const tampered = { ...accepted.reply, ts: accepted.reply.ts + 1 };
    await expect(clientFinish(hello, ephPriv, tampered, publicOf(host), client)).rejects.toThrow('bad host signature');
  });

  it('rejects frames sealed under a different key or replayed counters', async () => {
    const client = await generateIdentity();
    const host = await generateIdentity();
    const { hello, ephPriv } = await createHello(client);
    const accepted = await hostAccept(host, hello, publicOf(client));
    const finished = await clientFinish(hello, ephPriv, accepted.reply, publicOf(host), client);

    const frame = await sealFrame(finished.key, finished.salt, 5, { n: 1 });
    await expect(openFrame(accepted.key, frame)).resolves.toEqual({ n: 1 });
    const stranger = await hostAccept(host, hello, publicOf(client)); // different keys, same identities
    await expect(openFrame(stranger.key, frame)).rejects.toThrow();
  });

  it('produces stable JSON so both sides sign identical bytes', () => {
    expect(stable({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });
});