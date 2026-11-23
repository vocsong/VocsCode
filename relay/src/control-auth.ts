/** Controller assertions are NOT browser account assertions. The landing attests an OAuth
 *  controller, bound to exact body bytes and one fixed audience/method/path. */
import { z } from 'zod';
import { CONTROL_MAX_BYTES, controlPrincipalSchema, type ControllerPrincipal } from '../../src/shared/control';
import type { RelayStore } from './core';

export const CONTROL_PATH = '/v1/control/mcp';
export const CONTROL_INTERNAL_PATH = '/__internal/control/mcp';
export const CONTROLLER_ASSERTION_HEADER = 'x-vocs-controller-assertion';
export const CONTROL_ASSERTION_TTL_MS = 30_000;
export const CONTROL_NONCE_LIMIT = 2048;
const NONCES_KEY = '__control_nonces__';
const encoder = new TextEncoder();
const assertionSchema = controlPrincipalSchema.omit({ validUntil: true }).extend({
  v: z.literal(1), expiresAt: z.number().int().positive(), nonce: z.string().uuid(),
  bodyHash: z.string().regex(/^[0-9a-f]{64}$/)
});
export interface VerifiedController {
  principal: ControllerPrincipal;
  nonce: string;
  expiresAt: number;
}

export class ControlHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function controlHttpError(error: unknown): Response {
  return controlJson({ error: error instanceof ControlHttpError ? error.code : 'unavailable' }, error instanceof ControlHttpError ? error.status : 503);
}

export function controlJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/** Never buffer an unbounded stream, including chunked bodies and SDK responses. A small,
 *  bounded overflow is drained without buffering: cancelling a nearly-finished upload races
 *  workerd's HTTP keep-alive reuse. Larger/slow uploads are still cancelled, never fully drained. */
export async function readControlBytes(source: { body: ReadableStream<Uint8Array> | null; headers: Headers }): Promise<Uint8Array<ArrayBuffer>> {
  const length = source.headers.get('content-length');
  const drainLimit = CONTROL_MAX_BYTES + 64 * 1024;
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > drainLimit)) {
    await source.body?.cancel().catch(() => undefined);
    throw new ControlHttpError(413, 'too_large');
  }
  let oversized = length !== null && Number(length) > CONTROL_MAX_BYTES;
  const reader = source.body?.getReader();
  if (!reader) {
    if (oversized) throw new ControlHttpError(413, 'too_large');
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 5000);
  try {
    for (;;) {
      const next = await reader.read();
      if (timedOut) throw new ControlHttpError(408, 'request_timeout');
      if (next.done) break;
      size += next.value.byteLength;
      if (size > CONTROL_MAX_BYTES) { oversized = true; chunks.length = 0; }
      if (size > drainLimit) {
        await reader.cancel().catch(() => undefined);
        throw new ControlHttpError(413, 'too_large');
      }
      if (!oversized) chunks.push(next.value);
    }
    if (oversized) throw new ControlHttpError(413, 'too_large');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

function base64url(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    return base64url(bytes) === value ? bytes : null;
  } catch { return null; }
}

/** Only the private Hub dispatch may use the rewritten path. The signed audience stays fixed. */
export async function verifyControllerAssertion(request: Request, body: Uint8Array<ArrayBuffer>, secret: string | undefined, internal = false): Promise<VerifiedController | null> {
  const url = new URL(request.url);
  const value = request.headers.get(CONTROLLER_ASSERTION_HEADER);
  if (request.method !== 'POST' || url.pathname !== (internal ? CONTROL_INTERNAL_PATH : CONTROL_PATH) || url.search ||
      request.headers.has('content-encoding') || !value || value.length > 2048 || !secret || encoder.encode(secret).byteLength < 32 || body.byteLength > CONTROL_MAX_BYTES) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const payload = decode(parts[0]);
  const signature = decode(parts[1]);
  if (!payload || !signature || signature.byteLength !== 32) return null;
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`vocs.controller.assertion.v1\nPOST\n${CONTROL_PATH}\n${parts[0]}`)))) return null;
    const parsed = assertionSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload)));
    if (!parsed.success) return null;
    const { v: _v, bodyHash, nonce, expiresAt, ...principal } = parsed.data;
    const now = Date.now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + CONTROL_ASSERTION_TTL_MS ||
        principal.scopes.length === 0 || principal.scopes.some((scope, i) => i > 0 && principal.scopes[i - 1] >= scope)) return null;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hash !== bodyHash || expiresAt <= Date.now()) return null;
    return { principal: { ...principal, validUntil: expiresAt }, nonce, expiresAt };
  } catch { return null; }
}

/** Durable replay metadata survives hibernation; never persist assertions, principals or content.
 *  The fixed-size collection expires logically at expiresAt and is pruned on every admission. */
export async function consumeControlNonce(store: RelayStore, assertion: VerifiedController): Promise<void> {
  await store.transaction(async (tx) => {
    const now = Date.now();
    if (assertion.expiresAt <= now) throw new ControlHttpError(401, 'invalid_controller_assertion');
    const live = ((await tx.get<Array<{ nonce: string; expiresAt: number }>>(NONCES_KEY)) ?? []).filter((item) => item.expiresAt > now);
    if (live.some((item) => item.nonce === assertion.nonce)) throw new ControlHttpError(401, 'invalid_controller_assertion');
    if (live.length >= CONTROL_NONCE_LIMIT) throw new ControlHttpError(429, 'busy');
    live.push({ nonce: assertion.nonce, expiresAt: assertion.expiresAt });
    await tx.put(NONCES_KEY, live);
  });
}
