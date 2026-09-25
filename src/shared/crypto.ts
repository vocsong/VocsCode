/** End-to-end crypto for remote access (docs/REMOTE-ACCESS.md §6): P-256 identities,
 *  an ECDH handshake whose signatures bind the full transcript, HKDF-SHA-256 →
 *  AES-256-GCM frames with per-direction counters. WebCrypto only, so the same module
 *  runs in the desktop main process (Node's global crypto) and in the browser. */
const subtle = (globalThis as unknown as { crypto: Crypto }).crypto.subtle;
const enc = new TextEncoder();

/** A long-term device identity: an ECDSA signing key pair + an ECDH key-agreement pair, as
 *  exportable JWKs. The desktop keeps this shape, sealed by the OS keychain (safeStorage). */
export interface Identity {
  sig: { pub: JsonWebKey; priv: JsonWebKey };
  enc: { pub: JsonWebKey; priv: JsonWebKey };
}

/** A browser identity whose private halves are non-extractable CryptoKeys: script on the page can
 *  use them but never read them out, and IndexedDB stores them by structured clone. */
export interface KeyIdentity {
  sig: { pub: JsonWebKey; priv: CryptoKey };
  enc: { pub: JsonWebKey; priv: CryptoKey };
}

/** Either identity shape; every signing and key-agreement function accepts both. */
export type AnyIdentity = Identity | KeyIdentity;

/** The public half, as stored in the relay's device registry. */
export interface PublicIdentity {
  sig: JsonWebKey;
  enc: JsonWebKey;
}

export function publicOf(identity: AnyIdentity): PublicIdentity {
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

/** A fresh browser identity: the private keys are created non-extractable and never exist as
 *  bytes script could read. Public keys stay exportable (WebCrypto always allows that). */
export async function generateKeyIdentity(): Promise<KeyIdentity> {
  const sig = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const ecdh = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair;
  return {
    sig: { pub: (await subtle.exportKey('jwk', sig.publicKey)) as JsonWebKey, priv: sig.privateKey },
    enc: { pub: (await subtle.exportKey('jwk', ecdh.publicKey)) as JsonWebKey, priv: ecdh.privateKey }
  };
}

/** Re-imports an exportable identity with non-extractable private keys (the one-way migration
 *  for browsers paired before keys moved out of localStorage). */
export async function lockIdentity(identity: Identity): Promise<KeyIdentity> {
  return {
    sig: { pub: identity.sig.pub, priv: await subtle.importKey('jwk', identity.sig.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) },
    enc: { pub: identity.enc.pub, priv: await subtle.importKey('jwk', identity.enc.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) }
  };
}

function isJwk(key: JsonWebKey | CryptoKey): key is JsonWebKey {
  return typeof (key as JsonWebKey).kty === 'string';
}

async function signingKey(priv: JsonWebKey | CryptoKey): Promise<CryptoKey> {
  return isJwk(priv) ? subtle.importKey('jwk', priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) : priv;
}

async function agreementKey(priv: JsonWebKey | CryptoKey): Promise<CryptoKey> {
  return isJwk(priv) ? subtle.importKey('jwk', priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) : priv;
}

/** Domain-separated pairing approval: bind one code and decision to the identity that claimed it. */
export function pairingDecisionPayload(code: string, decision: 'approve' | 'deny', webPub: PublicIdentity): unknown[] {
  return ['pair.respond', code, decision, webPub];
}

/** Domain-separated proof of possession for a relay access token: the device signs the relay's
 *  one-time challenge for its own device id. Arrays with a distinct tag can never collide with a
 *  handshake (`hs1`), a pairing decision or a signed approval request object. */
export function tokenProofPayload(deviceId: string, challenge: string): unknown[] {
  return ['relay.token', deviceId, challenge];
}

/** Authenticated context of a browser's sealed pairing credential: it opens only as the
 *  credential of this code's approved device. */
export function pairingTokenContext(code: string, webDeviceId: string): unknown[] {
  return ['relay.pair-token', code, webDeviceId];
}

/** Authenticated context of a desktop's sealed credential from a signed-in owner's approval
 *  ("Connect with GitHub"): it opens only for this one-time secret's hash and the device it minted. */
export function enrollTokenContext(nonceHash: string, hostDeviceId: string): unknown[] {
  return ['relay.enroll-token', nonceHash, hostDeviceId];
}

export async function sign(identity: AnyIdentity, data: unknown): Promise<string> {
  const key = await signingKey(identity.sig.priv);
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
export async function createHello(identity: AnyIdentity): Promise<{ hello: HelloFrame; ephPriv: JsonWebKey }> {
  const eph = await freshEph();
  const hello: HelloFrame = { t: 'hs1', eph: eph.pub, id: publicOf(identity), ts: Date.now(), sig: '' };
  hello.sig = await sign(identity, helloPayload(hello));
  return { hello, ephPriv: eph.priv };
}

/** Host: verifies the hello against the registry's client identity, answers, derives the key. */
export async function hostAccept(identity: AnyIdentity, hello: HelloFrame, expectedClient: PublicIdentity): Promise<{ reply: ReplyFrame; key: CryptoKey; salt: Uint8Array }> {
  if (stable(hello.id) !== stable(expectedClient)) throw new Error('handshake: unknown client identity');
  if (!(await verify(expectedClient, helloPayload(hello), hello.sig))) throw new Error('handshake: bad client signature');
  const eph = await freshEph();
  const reply: ReplyFrame = { t: 'hs2', eph: eph.pub, id: publicOf(identity), ts: Date.now(), sig: '' };
  reply.sig = await sign(identity, replyPayload(hello, reply));
  const key = await deriveSessionKey({ ephPriv: eph.priv, peerEph: hello.eph, authPriv: identity.enc.priv, peerAuthPub: hello.id.enc, transcript: [hello, reply] });
  return { reply, key, salt: newSalt() };
}

/** Client: verifies the host reply against the registry's host identity, derives the key. */
export async function clientFinish(hello: HelloFrame, ephPriv: JsonWebKey, reply: ReplyFrame, expectedHost: PublicIdentity, clientIdentity: AnyIdentity): Promise<{ key: CryptoKey; salt: Uint8Array }> {
  if (stable(reply.id) !== stable(expectedHost)) throw new Error('handshake: unknown host identity');
  if (!(await verify(expectedHost, replyPayload(hello, reply), reply.sig))) throw new Error('handshake: bad host signature');
  const key = await deriveSessionKey({ ephPriv, peerEph: reply.eph, authPriv: clientIdentity.enc.priv, peerAuthPub: reply.id.enc, transcript: [hello, reply] });
  return { key, salt: newSalt() };
}

async function freshEph(): Promise<{ pub: JsonWebKey; priv: JsonWebKey }> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  return { pub: (await subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey, priv: (await subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey };
}

async function ecdh(privKey: JsonWebKey | CryptoKey, peerPubJwk: JsonWebKey): Promise<Uint8Array> {
  const priv = await agreementKey(privKey);
  const peer = await subtle.importKey('jwk', peerPubJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer } as never, priv, 256));
}

async function deriveSessionKey(input: { ephPriv: JsonWebKey; peerEph: JsonWebKey; authPriv: JsonWebKey | CryptoKey; peerAuthPub: JsonWebKey; transcript: unknown[] }): Promise<CryptoKey> {
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

/** Stable JSON: key order normalized, undefined dropped like JSON.stringify, so both
 *  sides sign and parse identical bytes. */
export function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
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

/** Fresh symmetric key material as base64url — for keys that travel sealed and never reach the relay. */
export function randomKeyB64(bytes = 32): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Imports a raw base64url AES-256 key (non-extractable). */
export async function importAesKey(b64: string): Promise<CryptoKey> {
  return subtle.importKey('raw', fromB64Url(b64) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** A blob sealed to a symmetric key: random 96-bit IV + AES-256-GCM ciphertext, both base64url.
 *  Used for the offline transcript mirror, where the relay stores the ciphertext and can never
 *  open it (docs/REMOTE-ACCESS.md P4). */
export interface SealedBlob {
  iv: string;
  ct: string;
}

export async function sealBlob(key: CryptoKey, plaintext: unknown): Promise<SealedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 }, key, canonical(plaintext) as BufferSource);
  return { iv: toB64Url(iv), ct: toB64Url(ct) };
}

export async function openBlob<T>(key: CryptoKey, blob: SealedBlob): Promise<T> {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64Url(blob.iv) as BufferSource, tagLength: 128 }, key, fromB64Url(blob.ct) as BufferSource);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

/** A secret sealed to one recipient's ECDH public key (ECIES: ephemeral P-256 ECDH →
 *  HKDF-SHA-256 → AES-256-GCM). The relay seals a freshly minted browser credential this way,
 *  so what it keeps until the claimant polls is ciphertext only that key's holder can open. */
export interface SealedToKey {
  eph: JsonWebKey;
  iv: string;
  ct: string;
}

async function sealingKey(shared: Uint8Array, ephPub: JsonWebKey, recipientPub: JsonWebKey): Promise<CryptoKey> {
  // Bind both public keys: the key only exists for this ephemeral/recipient pair.
  const salt = await subtle.digest('SHA-256', enc.encode(stable([ephPub, recipientPub])) as BufferSource);
  const ikm = await subtle.importKey('raw', shared as BufferSource, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: enc.encode('vocs-remote/sealed-to-key/v1') as BufferSource },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Seals `plaintext` to `recipientPub`. `context` is authenticated (not encrypted): the opener
 *  must present the same value, so a sealed secret cannot be replayed into another context. */
export async function sealToKey(recipientPub: JsonWebKey, plaintext: string, context: unknown): Promise<SealedToKey> {
  const eph = await freshEph();
  const key = await sealingKey(await ecdh(eph.priv, recipientPub), eph.pub, recipientPub);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: canonical(context) as BufferSource, tagLength: 128 }, key, enc.encode(plaintext) as BufferSource);
  return { eph: eph.pub, iv: toB64Url(iv), ct: toB64Url(ct) };
}

export async function openSealedToKey(recipient: { pub: JsonWebKey; priv: JsonWebKey | CryptoKey }, sealed: SealedToKey, context: unknown): Promise<string> {
  const key = await sealingKey(await ecdh(recipient.priv, sealed.eph), sealed.eph, recipient.pub);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64Url(sealed.iv) as BufferSource, additionalData: canonical(context) as BufferSource, tagLength: 128 }, key, fromB64Url(sealed.ct) as BufferSource);
  return new TextDecoder().decode(pt);
}
