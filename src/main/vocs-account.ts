/** Staging-only account broker. No persistence, resource grants or harness configuration writes. */
import { z } from 'zod';
import type { VocsAccountState } from '../shared/vocs-account';
import { createNativeMcpOAuth, type NativeMcpOAuth, type NativeMcpOAuthOptions } from './mcp/oauth';
export const VOCS_STAGING = Object.freeze({
  issuer: 'https://vocs-login-staging.vocs.workers.dev/api/auth',
  identityIssuer: 'https://vocs-login-staging.vocs.workers.dev',
  hub: 'https://vocs-mcp-staging.vocs.workers.dev',
  resource: 'https://vocs-mcp-staging.vocs.workers.dev/api/connections'
});
const catalogSchema = z.strictObject({
  version: z.literal(1),
  account: z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/), identityIssuer: z.literal(VOCS_STAGING.identityIssuer) }),
  connections: z.array(z.strictObject({
    id: z.literal('openrouter'), name: z.literal('OpenRouter'), transport: z.literal('streamable-http'),
    resource: z.literal(`${VOCS_STAGING.hub}/openrouter`), authorizationServer: z.union([z.literal(VOCS_STAGING.hub), z.null()]),
    accountScopes: z.array(z.literal('models:read')).min(1).max(1), authorization: z.enum(['oauth_required', 'unavailable']), executionReadiness: z.literal('not_checked')
  }).refine(c => (c.authorization === 'oauth_required') === (c.authorizationServer !== null))).max(1),
  policy: z.strictObject({ authorizationRequiredPerResource: z.literal(true), localServersSynced: z.literal(false), offlineCloudAccess: z.literal(false) })
});
class CatalogAccessDenied extends Error {}
const missingAccess = 'This account has no staging Hub catalog access. Ask the staging administrator to enable it, then sign in again.';
interface Options {
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
  /** Test seam only; production always uses the real SDK controller. */
  createOAuth?: (options: NativeMcpOAuthOptions) => NativeMcpOAuth;
  timeoutMs?: number;
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('Account operation interrupted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error('Missing catalog');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await bounded(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new Error('Catalog too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { void reader.cancel().catch(() => undefined); }
}
export function createVocsAccount(options: Options) {
  let state: VocsAccountState = { realm: 'staging', status: 'signed_out', refreshing: false, revision: 0, connections: [] };
  let oauth: NativeMcpOAuth | undefined;
  let generation = 0;
  let active: AbortController | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const update = (patch: Partial<VocsAccountState>) => { state = { ...state, ...patch, revision: state.revision + 1 }; };
  function clear(error?: string) {
    generation++;
    active?.abort(); active = undefined;
    oauth?.clear(); oauth = undefined;
    clearTimeout(expiry); expiry = undefined;
    state = { realm: 'staging', status: 'signed_out', refreshing: false, revision: state.revision + 1, connections: [], ...(error ? { error } : {}) };
  }
  function get(): VocsAccountState {
    if (state.expiresAt && state.expiresAt <= Date.now()) clear('Session expired. Sign in again.');
    return structuredClone(state);
  }
  async function catalog(client: NativeMcpOAuth, controller: AbortController, epoch: number) {
    const token = client.credentialSnapshot()?.token;
    if (!token || token.scope !== 'catalog:read' || !token.expires_in || token.expires_in > 300) throw new Error('Invalid account token');
    const context = client.transport();
    const response = await bounded(context.fetch(VOCS_STAGING.resource, { method: 'GET', headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' }, signal: controller.signal }), controller.signal);
    if (response.status !== 200 || response.redirected) { void response.body?.cancel().catch(() => undefined); if (response.status === 403) throw new CatalogAccessDenied(); throw new Error('Account catalog denied'); }
    const value = catalogSchema.parse(await json(response, controller.signal));
    if (epoch !== generation || controller.signal.aborted) throw new Error('Account operation interrupted');
    if (state.accountId && state.accountId !== value.account.id) throw new Error('Account changed unexpectedly');
    update({ accountId: value.account.id, connections: value.connections });
  }
  async function signIn(): Promise<VocsAccountState> {
    if (state.status === 'signing_in') return get();
    clear();
    const epoch = generation;
    const controller = new AbortController(); active = controller;
    update({ status: 'signing_in', error: undefined });
    try {
      const client = (options.createOAuth ?? createNativeMcpOAuth)({
        resource: VOCS_STAGING.resource, issuer: VOCS_STAGING.issuer, scopes: ['catalog:read'], clientId: 'vocs-code', callbackPath: '/oauth/vocs', maxTokenAgeSeconds: 300,
        openExternal: options.openExternal, fetch: options.fetch, timeoutMs: options.timeoutMs
      });
      oauth = client;
      await bounded(client.authorize(controller.signal), controller.signal);
      if (epoch !== generation || controller.signal.aborted) return get();
      const token = client.credentialSnapshot()?.token;
      if (!token?.expires_in || token.expires_in > 300 || token.scope !== 'catalog:read') throw new Error('Invalid account token');
      const expiresAt = client.credentialSnapshot()!.expiresAt;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try { await catalog(client, controller, epoch); } finally { clearTimeout(timeout); }
      if (epoch !== generation || controller.signal.aborted) return get();
      if (!client.credentialSnapshot() || expiresAt <= Date.now()) throw new Error('Account token expired');
      update({ status: 'signed_in', expiresAt });
      expiry = setTimeout(() => { if (epoch === generation) clear('Session expired. Sign in again.'); }, Math.max(0, expiresAt - Date.now()));
      expiry.unref?.();
    } catch (error) {
      if (epoch === generation) clear(error instanceof CatalogAccessDenied ? missingAccess : 'Sign-in or catalog access could not be completed. Try again.');
    } finally { if (epoch === generation) active = undefined; }
    return get();
  }
  async function refresh(): Promise<VocsAccountState> {
    get();
    if (state.status !== 'signed_in' || !oauth || state.refreshing) return get();
    const epoch = generation, client = oauth, controller = new AbortController(); active = controller;
    // Clear stale permissions while offline/refreshing. Cached entries never authorize use.
    update({ refreshing: true, connections: [], error: undefined });
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try { await catalog(client, controller, epoch); }
    catch (error) { if (epoch === generation) clear(error instanceof CatalogAccessDenied ? missingAccess : 'Account access could not be verified. Sign in again.'); }
    finally {
      clearTimeout(timeout);
      if (epoch === generation) { active = undefined; update({ refreshing: false }); }
    }
    return get();
  }
  async function signOut(): Promise<VocsAccountState> {
    const token = oauth?.credentialSnapshot()?.token.access_token;
    clear(); const epoch = generation;
    if (token) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await bounded((options.fetch ?? fetch)(`${VOCS_STAGING.issuer}/oauth2/revoke`, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: 'vocs-code', token, token_type_hint: 'access_token' })
        }), controller.signal);
        void response.body?.cancel().catch(() => undefined);
        if (response.status !== 200 || response.redirected) throw new Error('Revocation unavailable');
      } catch { if (epoch === generation) update({ error: 'Signed out locally. Remote revocation was not confirmed; the token expires within five minutes.' }); }
      finally { clearTimeout(timer); }
    }
    return get();
  }
  return { get, signIn, refresh, signOut, cancel: () => { clear(); return get(); }, dispose: () => clear() };
}
export type VocsAccountBroker = ReturnType<typeof createVocsAccount>;
