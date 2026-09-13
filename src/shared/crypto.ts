/** End-to-end crypto for remote access (docs/REMOTE-ACCESS.md §6): P-256 identities,
 *  an ECDH handshake whose signatures bind the full transcript, HKDF-SHA-256 →
 *  AES-256-GCM frames with per-direction counters. WebCrypto only, so the same module
 *  runs in the desktop main process (Node's global crypto) and in the browser. */
const subtle = (globalThis as unknown as { crypto: Crypto }).crypto.subtle;
const enc = new TextEncoder();

/** A long-term device identity: an ECDSA signing key pair + an ECDH key-agreement pair. */
export interface Identity {
  sig: { pub: JsonWebKey; priv: JsonWebKey };
  enc: { pub: JsonWebKey; priv: JsonWebKey };
}

/** The public half, as stored in the relay's device registry. */
export interface PublicIdentity {
  sig: JsonWebKey;
  enc: JsonWebKey;
}

export function publicOf(identity: Identity): PublicIdentity {
  return { sig: identity.sig.pub, enc: identity.enc.pub };
}

export async function generateIdentity(): Promise<Identity> {
  const sig = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const ecdh = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  return {
    sig: { pub: (await subtle.exportKey('jwk', sig.publicKey)) as JsonWebKey, priv: (await subtle.exportKey('jwk', sig.privateKey)) as JsonWebKey },
    enc: { pub: (await subtle.exportKey('jwk', ecdh.publicKey)) as JsonWebKey, priv: (await subtle.exportKey('jwk', ecdh.privateKey)) as JsonWebKey }
  };
}

export async function sign(identity: Identity, data: unknown): Promise<string> {
  const key = await subtle.importKey('jwk', identity.sig.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, canonical(data) as BufferSource);
  return toB64Url(sig);
}

export async function verify(peer: PublicIdentity, data: unknown, sigB64: string): Promise<boolean> {
  const key = await subtle.importKey('jwk', peer.sig, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64Url(sigB64) as BufferSource, canonical(data) as BufferSource);
}

export interface HelloFrame {
  t: 'hs1';
  eph: JsonWebKey;
  id: PublicIdentity;
  ts: number;
  sig: string;
}

export interface ReplyFrame {
  t: 'hs2';
  eph: JsonWebKey;
  id: PublicIdentity;
  ts: number;
  sig: string;
}

function helloPayload(hello: HelloFrame): unknown[] {
  return ['hs1', hello.eph, hello.id, hello.ts];
}

function replyPayload(hello: HelloFrame, reply: ReplyFrame): unknown[] {
  return ['hs1', hello.eph, hello.id, hello.ts, 'hs2', reply.eph, reply.id, reply.ts];
}

/** Client: builds the hello (sent through the relay; it carries public values only).
 *  The caller must keep `ephPriv` until it calls clientFinish with the host's reply. */
export async function createHello(identity: Identity): Promise<{ hello: HelloFrame; ephPriv: JsonWebKey }> {
  const eph = await freshEph();
  const hello: HelloFrame = { t: 'hs1', eph: eph.pub, id: publicOf(identity), ts: Date.now(), sig: '' };
  hello.sig = await sign(identity, helloPayload(hello));
  return { hello, ephPriv: eph.priv };
}

/** Host: verifies the hello against the registry's client identity, answers, derives the key. */
export async function hostAccept(identity: Identity, hello: HelloFrame, expectedClient: PublicIdentity): Promise<{ reply: ReplyFrame; key: CryptoKey; salt: Uint8Array }> {
  if (stable(hello.id) !== stable(expectedClient)) throw new Error('handshake: unknown client identity');
  if (!(await verify(expectedClient, helloPayload(hello), hello.sig))) throw new Error('handshake: bad client signature');
  const eph = await freshEph();
  const reply: ReplyFrame = { t: 'hs2', eph: eph.pub, id: publicOf(identity), ts: Date.now(), sig: '' };
  reply.sig = await sign(identity, replyPayload(hello, reply));
  const key = await deriveSessionKey({ ephPriv: eph.priv, peerEph: hello.eph, authPriv: identity.enc.priv, peerAuthPub: hello.id.enc, transcript: [hello, reply] });
  return { reply, key, salt: newSalt() };
}

/** Client: verifies the host reply against the registry's host identity, derives the key. */
export async function clientFinish(hello: HelloFrame, ephPriv: JsonWebKey, reply: ReplyFrame, expectedHost: PublicIdentity, clientIdentity: Identity): Promise<{ key: CryptoKey; salt: Uint8Array }> {
  if (stable(reply.id) !== stable(expectedHost)) throw new Error('handshake: unknown host identity');
  if (!(await verify(expectedHost, replyPayload(hello, reply), reply.sig))) throw new Error('handshake: bad host signature');
  const key = await deriveSessionKey({ ephPriv, peerEph: reply.eph, authPriv: clientIdentity.enc.priv, peerAuthPub: reply.id.enc, transcript: [hello, reply] });
  return { key, salt: newSalt() };
}

async function freshEph(): Promise<{ pub: JsonWebKey; priv: JsonWebKey }> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  return { pub: (await subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey, priv: (await subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey };
}

async function ecdh(privJwk: JsonWebKey, peerPubJwk: JsonWebKey): Promise<Uint8Array> {
  const priv = await subtle.importKey('jwk', privJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const peer = await subtle.importKey('jwk', peerPubJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer } as never, priv, 256));
}

async function deriveSessionKey(input: { ephPriv: JsonWebKey; peerEph: JsonWebKey; authPriv: JsonWebKey; peerAuthPub: JsonWebKey; transcript: unknown[] }): Promise<CryptoKey> {
  const ephBits = await ecdh(input.ephPriv, input.peerEph);
  const authBits = await ecdh(input.authPriv, input.peerAuthPub);
  const material = new Uint8Array(64);
  material.set(ephBits, 0);
  material.set(authBits, 32);
  // HKDF info must stay small: bind the full transcript by its digest instead of raw bytes.
  const info = await subtle.digest('SHA-256', enc.encode(stable(input.transcript)) as BufferSource);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32) as BufferSource, info: info as BufferSource }, (await subtle.importKey('raw', material as BufferSource, 'HKDF', false, ['deriveBits'])) as never, 256);
  return subtle.importKey('raw', bits as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function canonical(data: unknown): Uint8Array {
  return enc.encode(stable(data));
}

/** Stable JSON: key order normalized so both sides sign identical bytes. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function toB64Url(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export function newSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** Seals one frame. Nonce = 4 bytes of the per-direction salt ‖ 8-byte counter. */
export async function sealFrame(key: CryptoKey, salt: Uint8Array, seq: number, plaintext: unknown): Promise<{ salt: string; seq: number; ct: string }> {
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonceOf(salt, seq) as BufferSource, tagLength: 128 }, key, canonical(plaintext) as BufferSource);
  return { salt: toB64Url(salt), seq, ct: toB64Url(ct) };
}

export async function openFrame<T>(key: CryptoKey, frame: { salt: string; seq: number; ct: string }): Promise<T> {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: nonceOf(fromB64Url(frame.salt), frame.seq) as BufferSource, tagLength: 128 }, key, fromB64Url(frame.ct) as BufferSource);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

function nonceOf(salt: Uint8Array, seq: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(salt.subarray(0, 4), 0);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(seq));
  return nonce;
}
