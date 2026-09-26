/** Tenant identity and relay-only account assertions (docs/REMOTE-ACCESS.md). The landing Worker
 *  proves the logged-in GitHub subject with a short-lived HMAC assertion; device ids carry a
 *  separately keyed account routing tag so an unauthenticated caller cannot create arbitrary
 *  Durable Objects by choosing account names. Neither value replaces device-token proof of
 *  possession inside the selected Hub. */

export const LEGACY_ACCOUNT_ID = 'vocs-v1';
export const ACCOUNT_ASSERTION_HEADER = 'x-vocs-account-assertion';
/** Internal headers are removed at the public Worker boundary before trusted values are added. */
export const INTERNAL_ACCOUNT_ID_HEADER = 'x-vocs-internal-account-id';
export const INTERNAL_ACCOUNT_AUTH_HEADER = 'x-vocs-internal-account-auth';
export const ACCOUNT_ASSERTION_TTL_MS = 60_000;

const ASSERTION_PURPOSE = 'vocs.account.assertion.v1';
const DEVICE_ROUTE_PURPOSE = 'vocs.device-route.v1';
const encoder = new TextEncoder();

export function isAccountId(value: unknown): value is string {
  return value === LEGACY_ACCOUNT_ID || (typeof value === 'string' && /^github:[1-9]\d{0,19}$/.test(value));
}

function base64url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
    return base64url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function arrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  if (encoder.encode(secret).byteLength < 32) throw new Error('account assertion secret is not configured');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

function assertionPayload(accountId: string, expiresAt: number, method: string, pathname: string): string {
  return `${ASSERTION_PURPOSE}\n${accountId}\n${expiresAt}\n${method.toUpperCase()}\n${pathname}`;
}

/** Creates the exact header the landing Worker forwards to the relay. */
export async function createAccountAssertion(
  accountId: string,
  method: string,
  pathname: string,
  secret: string,
  now = Date.now()
): Promise<string> {
  if (!isAccountId(accountId) || !pathname.startsWith('/v1/') || !/^[A-Z]+$/i.test(method)) throw new TypeError('invalid account assertion input');
  const expiresAt = now + ACCOUNT_ASSERTION_TTL_MS;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(assertionPayload(accountId, expiresAt, method, pathname)));
  return `${accountId}.${expiresAt}.${base64url(new Uint8Array(signature))}`;
}

/** Returns the asserted account only when the signature, request target and lifetime all match. */
export async function verifyAccountAssertion(request: Request, secret: string | undefined, now = Date.now()): Promise<string | null> {
  const value = request.headers.get(ACCOUNT_ASSERTION_HEADER);
  if (!value || !secret || value.length > 256) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [accountId, expiresText, signatureText] = parts;
  if (!isAccountId(accountId) || !/^\d{13}$/.test(expiresText) || !signatureText) return null;
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + ACCOUNT_ASSERTION_TTL_MS) return null;
  const signature = decodeBase64url(signatureText);
  if (!signature || signature.byteLength !== 32) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      arrayBufferBytes(signature),
      encoder.encode(assertionPayload(accountId, expiresAt, request.method, new URL(request.url).pathname))
    );
    return valid ? accountId : null;
  } catch {
    return null;
  }
}

/** Creates a routing hint that only this relay's secret can mint. It is not authorization: the
 *  selected Hub still verifies the device's refresh/access credential and key proof. */
export async function createDeviceId(prefix: 'h' | 'w', accountId: string, secret: string): Promise<string> {
  if (!isAccountId(accountId)) throw new TypeError('invalid account id');
  const routeTag = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(`${DEVICE_ROUTE_PURPOSE}\n${accountId}`));
  const random = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${base64url(encoder.encode(accountId))}.${base64url(new Uint8Array(routeTag))}.${base64url(random)}`;
}

/** Resolves only legacy ids or a correctly MACed account hint. Invalid/forged ids return null so
 *  the public Worker can fall back to the already-provisioned legacy Hub, never create a new one. */
export async function accountIdFromDeviceId(deviceId: string, secret: string | undefined, legacyAccountId = LEGACY_ACCOUNT_ID): Promise<string | null> {
  if (/^[hw]_[A-Za-z0-9_-]{11}$/.test(deviceId)) return legacyAccountId;
  if (!secret) return null;
  const match = /^[hw]_([A-Za-z0-9_-]{1,96})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{11})$/.exec(deviceId);
  if (!match) return null;
  const accountBytes = decodeBase64url(match[1]!);
  const routeTag = decodeBase64url(match[2]!);
  if (!accountBytes || !routeTag || routeTag.byteLength !== 32) return null;
  let accountId: string;
  try {
    accountId = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(accountBytes);
  } catch {
    return null;
  }
  if (!isAccountId(accountId) || base64url(encoder.encode(accountId)) !== match[1]) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      arrayBufferBytes(routeTag),
      encoder.encode(`${DEVICE_ROUTE_PURPOSE}\n${accountId}`)
    );
    return valid ? accountId : null;
  } catch {
    return null;
  }
}
