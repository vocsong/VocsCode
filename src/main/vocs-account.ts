/**
 * Vocs account broker. A temporary sign-in lives in memory; "Keep me signed in" enrolls a device
 * grant whose refresh token is kept in the OS vault (`SecretStore`). No resource grants or harness
 * configuration writes. Tokens never leave the main process and are never logged.
 */
import { z } from 'zod';
import type { VocsAccountRealm, VocsAccountSignInRequest, VocsAccountState } from '../shared/vocs-account';
import { createNativeMcpOAuth, DEVICE_ID, DEVICE_MAX_LIFETIME_MS, DEVICE_REFRESH_TOKEN, NativeOAuthError, parseDeviceGrant, type NativeDeviceGrant, type NativeMcpOAuth, type NativeMcpOAuthOptions } from './mcp/oauth';
/** The public client that enrolls a kept ("Keep me signed in") device. */
export const VOCS_DEVICE_CLIENT_ID = 'vocs-code-device';
interface RealmConfig {
  issuer: string;
  identityIssuer: string;
  hub: string;
  resource: string;
  clientId: string;
  /** Set only where the issuer offers device grants (`NATIVE_DEVICE_GRANTS_ENABLED`). Without it the
   *  realm offers no "Keep me signed in" and always uses the temporary `clientId` flow. */
  deviceClientId?: typeof VOCS_DEVICE_CLIENT_ID;
}
export const VOCS_REALMS: Readonly<Record<VocsAccountRealm, Readonly<RealmConfig>>> = Object.freeze({
  production: Object.freeze({
    issuer: 'https://auth.vocs.io/api/auth',
    identityIssuer: 'https://auth.vocs.io',
    hub: 'https://mcp.vocs.io',
    resource: 'https://mcp.vocs.io/api/connections',
    clientId: 'vocs-code'
    // No deviceClientId yet: production has device grants off. Set it to VOCS_DEVICE_CLIENT_ID only
    // once the owner turns NATIVE_DEVICE_GRANTS_ENABLED on in production (docs/ARCHITECTURE.md).
  }),
  staging: Object.freeze({
    issuer: 'https://vocs-login-staging.vocs.workers.dev/api/auth',
    identityIssuer: 'https://vocs-login-staging.vocs.workers.dev',
    hub: 'https://vocs-mcp-staging.vocs.workers.dev',
    resource: 'https://vocs-mcp-staging.vocs.workers.dev/api/connections',
    clientId: 'vocs-code',
    deviceClientId: VOCS_DEVICE_CLIENT_ID
  })
});
export const VOCS_STAGING = VOCS_REALMS.staging;
/** Main-process choice only: the renderer can never pick an issuer. Production unless a
 *  developer launches with `VOCS_CODE_ACCOUNT_REALM=staging`. */
export function vocsAccountRealm(env: NodeJS.ProcessEnv = process.env): VocsAccountRealm {
  return env.VOCS_CODE_ACCOUNT_REALM === 'staging' ? 'staging' : 'production';
}
/** One vault slot per realm, so a staging sign-in never replaces (or restores as) production. */
export function vocsAccountVaultId(realm: VocsAccountRealm): `vocs-account:${VocsAccountRealm}` {
  return `vocs-account:${realm}`;
}
/** The `SecretStore` ids that must never fall back to obfuscated storage on disk. */
export const VOCS_ACCOUNT_VAULT_IDS = [vocsAccountVaultId('production'), vocsAccountVaultId('staging')] as const;
/** The device label the issuer shows on the account page (no hostname, by owner decision). */
export function vocsDeviceName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'Vocs Code on Windows' : platform === 'darwin' ? 'Vocs Code on macOS' : 'Vocs Code on Linux';
}
/** The subset of `SecretStore` the broker uses. */
export interface VocsAccountVault {
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  clear(id: string): Promise<void>;
  /** True when the value is held for this run only (no OS keychain). */
  isMemoryOnly?(id: string): boolean;
}
function catalogSchema(target: RealmConfig) {
  return z.strictObject({
    version: z.literal(1),
    account: z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/), identityIssuer: z.literal(target.identityIssuer) }),
    connections: z.array(z.strictObject({
      id: z.literal('openrouter'), name: z.literal('OpenRouter'), transport: z.literal('streamable-http'),
      resource: z.literal(`${target.hub}/openrouter`), authorizationServer: z.union([z.literal(target.hub), z.null()]),
      accountScopes: z.array(z.literal('models:read')).min(1).max(1), authorization: z.enum(['oauth_required', 'unavailable']), executionReadiness: z.literal('not_checked')
    }).refine(c => (c.authorization === 'oauth_required') === (c.authorizationServer !== null))).max(1),
    policy: z.strictObject({ authorizationRequiredPerResource: z.literal(true), localServersSynced: z.literal(false), offlineCloudAccess: z.literal(false) })
  });
}
/** The vault record. It is checked against the pinned realm on load: it never chooses where tokens go. */
const recordSchema = z.strictObject({
  v: z.literal(1), issuer: z.string(), clientId: z.string(), resource: z.string(),
  deviceId: z.string().regex(DEVICE_ID), refreshToken: z.string().regex(DEVICE_REFRESH_TOKEN), deviceExpiresAt: z.number().int()
});
type VaultRecord = z.infer<typeof recordSchema>;
const accessTokenSchema = z.object({ access_token: z.string().min(1).max(16384), token_type: z.string().regex(/^bearer$/i), expires_in: z.number().int().positive().max(300), scope: z.literal('catalog:read') });
class CatalogAccessDenied extends Error {}
class CatalogUnauthorized extends Error {}
class AccountChanged extends Error {}
const ENDED = 'Your sign-in ended. Sign in again.';
const NOT_SAVED = 'Vocs Code could not save your sign-in on this computer. You stay signed in until Vocs Code closes.';
const UNAVAILABLE = 'Vocs sign-in is temporarily unavailable. Your sign-in is still kept on this computer; retry in a moment.';
const CATALOG_UNVERIFIED = 'Hub connections could not be loaded. Refresh to try again.';
const DEVICE_UNAVAILABLE = 'Staying signed in is not available for this Vocs account yet. Turn off “Keep me signed in on this computer” and sign in again.';
const FRESH_SIGN_IN = 'Vocs Login needs a fresh sign-in before it keeps this computer signed in. Sign in again; if this repeats, sign out of Vocs Login in your browser first.';
const REVOKE_UNCONFIRMED = 'Signed out on this computer. Vocs could not confirm that this computer’s sign-in was revoked; remove it under Account & security on Vocs Login.';
const VAULT_NOT_CLEARED = 'Signed out, but Vocs Code could not remove the saved sign-in from this computer. It no longer works once Vocs confirms the revocation.';
/** Connection failures that happen before a byte of the request is sent: the refresh token was not
 *  presented, so it is still good. Anything else is an unknown outcome (owner decision 8). */
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT']);
function notSent(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    // TLS fails during the handshake, before the request is written.
    if (typeof code === 'string' && (NOT_SENT.has(code) || /^(ERR_TLS_|CERT_|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT)/.test(code))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
interface Options {
  /** Defaults to production. Chosen by main (see `vocsAccountRealm`), never by the renderer. */
  realm?: VocsAccountRealm;
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
  /** Test seam only; production always uses the real SDK controller. */
  createOAuth?: (options: NativeMcpOAuthOptions) => NativeMcpOAuth;
  timeoutMs?: number;
  /** Where a kept sign-in lives. Absent: a kept sign-in lasts for this run only. */
  vault?: VocsAccountVault;
  /** Electron's `net.isOnline()`. False means a refresh is never sent, so the sign-in stays kept. */
  isOnline?: () => boolean;
  /** Device label source; defaults to this process's platform. */
  platform?: NodeJS.Platform;
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
  if (!response.body) throw new Error('Missing body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await bounded(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new Error('Body too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { void reader.cancel().catch(() => undefined); }
}
/** One signed-in identity. Only main holds it; the renderer sees `VocsAccountState`. */
interface Session {
  persistent: boolean;
  accessToken?: string;
  accessExpiresAt: number;
  /** Persistent only: the newest refresh token, also in the vault unless that write failed. */
  record?: VaultRecord;
  /** Ended on purpose (sign-out, ended, replaced): a late answer revokes whatever it carries. */
  ended: boolean;
  /** The newest refresh token is not in the vault (its write failed): revoked when the app quits,
   *  so a device that cannot come back is not left live on the account. */
  unsaved?: boolean;
  /** Single flight for everything that may renew this session (restore, Retry, Refresh). */
  op?: Promise<VocsAccountState>;
}
type Renewal = { kind: 'ok' } | { kind: 'offline' } | { kind: 'unavailable' } | { kind: 'ended'; revoke?: string } | { kind: 'stale' };
export function createVocsAccount(options: Options) {
  const realm: VocsAccountRealm = options.realm ?? 'production';
  const target = VOCS_REALMS[realm];
  const schema = catalogSchema(target);
  const vaultId = vocsAccountVaultId(realm);
  const send = (input: string, init: RequestInit) => (options.fetch ?? fetch)(input, init);
  const missingAccess = realm === 'staging'
    ? 'This account has no staging Hub catalog access. Ask the staging administrator to enable it, then sign in again.'
    : 'This Vocs account has no Hub catalog access yet. Ask the Vocs administrator to enable it, then sign in again.';
  const keychain = () => { try { return !!options.vault && !options.vault.isMemoryOnly?.(vaultId); } catch { return false; } };
  /** A device is enrolled only where it can be kept: the realm offers it and the OS keychain works. */
  const canKeep = () => !!target.deviceClientId && keychain();
  const base = (): Omit<VocsAccountState, 'revision'> => ({ realm, status: 'signed_out', refreshing: false, connections: [], keychain: keychain(), deviceSignIn: !!target.deviceClientId });
  let state: VocsAccountState = { ...base(), revision: 0 };
  let oauth: NativeMcpOAuth | undefined;
  let session: Session | undefined;
  let generation = 0;
  let active: AbortController | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const update = (patch: Partial<VocsAccountState>) => { state = { ...state, ...patch, revision: state.revision + 1 }; };
  /** Forgets everything in memory. The vault is left alone: quitting keeps a kept sign-in. */
  function clear(error?: string) {
    generation++;
    active?.abort(); active = undefined;
    oauth?.clear(); oauth = undefined;
    session = undefined;
    clearTimeout(expiry); expiry = undefined;
    state = { ...base(), revision: state.revision + 1, ...(error ? { error } : {}) };
  }
  function parseRecord(raw: string | undefined): VaultRecord | undefined {
    if (!raw) return undefined;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return undefined; }
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success) return undefined;
    const record = parsed.data, now = Date.now();
    if (record.issuer !== target.issuer || record.clientId !== target.deviceClientId || record.resource !== target.resource) return undefined;
    if (record.deviceExpiresAt <= now || record.deviceExpiresAt > now + DEVICE_MAX_LIFETIME_MS) return undefined;
    return record;
  }
  async function readVault(): Promise<{ raw?: string; record?: VaultRecord }> {
    try { const raw = await options.vault?.get(vaultId); return { raw, record: parseRecord(raw) }; }
    catch { return {}; }
  }
  async function writeVault(record: VaultRecord): Promise<boolean> {
    try { await options.vault?.set(vaultId, JSON.stringify(record)); return true; }
    catch { return false; }
  }
  async function eraseVault(): Promise<boolean> {
    try { await options.vault?.clear(vaultId); return true; }
    catch { return false; }
  }
  /** Clears the vault only if it still holds this device, so a newer sign-in is never erased. */
  async function forget(deviceId: string): Promise<void> {
    const { raw, record } = await readVault();
    if (raw !== undefined && record?.deviceId === deviceId) await eraseVault();
  }
  /** RFC 7009 revocation of a whole device grant. Always bounded; never throws. */
  async function revokeDevice(refreshToken: string): Promise<boolean> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await bounded(send(`${target.issuer}/oauth2/revoke`, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: VOCS_DEVICE_CLIENT_ID, token: refreshToken, token_type_hint: 'refresh_token' })
      }), controller.signal);
      void response.body?.cancel().catch(() => undefined);
      return response.status === 200 && !response.redirected;
    } catch { return false; }
    finally { clearTimeout(timer); }
  }
  /** Ends the current sign-in for good: memory now, vault next, and the grant if it may still live. */
  function end(message: string, revoke?: string) {
    if (session) session.ended = true;
    clear(message);
    void eraseVault();
    if (revoke) void revokeDevice(revoke);
  }
  function get(): VocsAccountState {
    if (state.expiresAt && state.expiresAt <= Date.now()) clear('Session expired. Sign in again.');
    if (session?.record && session.record.deviceExpiresAt <= Date.now()) end(ENDED);
    return structuredClone(state);
  }
  function online(): boolean {
    try { return options.isOnline?.() ?? true; } catch { return true; }
  }
  /** The refresh grant. The rotated token reaches the vault before the new access token is used. */
  async function renewOnce(s: Session): Promise<Renewal> {
    const record = s.record!;
    if (!online()) return { kind: 'offline' };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
    let status: number, body: unknown;
    try {
      let response: Response;
      try {
        response = await bounded(send(`${target.issuer}/oauth2/token`, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: record.clientId, resource: record.resource, refresh_token: record.refreshToken })
        }), controller.signal);
      } catch (error) {
        if (s.ended) return { kind: 'stale' };
        return notSent(error) ? { kind: 'offline' } : { kind: 'ended', revoke: record.refreshToken };
      }
      status = response.status;
      try { body = response.redirected ? undefined : await json(response, controller.signal); } catch { body = undefined; }
    } finally { clearTimeout(timer); }
    const fields = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
    const grant = status === 200 && fields ? parseDeviceGrant(fields) : undefined;
    if (grant) {
      const access = accessTokenSchema.safeParse(fields);
      if (s.ended) { void revokeDevice(grant.refreshToken); return { kind: 'stale' }; }
      if (!access.success || grant.deviceId !== record.deviceId) return { kind: 'ended', revoke: grant.refreshToken };
      const next: VaultRecord = { ...record, refreshToken: grant.refreshToken, deviceExpiresAt: Math.min(record.deviceExpiresAt, grant.deviceExpiresAt) };
      // Memory holds the newest token even if the vault write fails, so this run stays signed in.
      s.record = next;
      const saved = await writeVault(next);
      if (s.ended) { void revokeDevice(next.refreshToken); void forget(next.deviceId); return { kind: 'stale' }; }
      // Cancelled or quitting: the rotated token is saved for the next start, but not used now.
      if (s !== session) return { kind: 'stale' };
      s.unsaved = !saved;
      if (!saved) update({ notice: NOT_SAVED });
      s.accessToken = access.data.access_token;
      s.accessExpiresAt = Date.now() + access.data.expires_in * 1000;
      return { kind: 'ok' };
    }
    if (s.ended) return { kind: 'stale' };
    if (status === 400 && fields?.error === 'invalid_grant') return { kind: 'ended' };
    // Rate limited (429) or the issuer's storage failed inside its atomic batch (503): nothing was
    // consumed, the token is still good. Any status: the error code is what says so.
    if (fields?.error === 'temporarily_unavailable') return { kind: 'unavailable' };
    // Anything else (including invalid_request once device grants are switched off again) ends it.
    return { kind: 'ended', revoke: record.refreshToken };
  }
  function renew(s: Session): Promise<Renewal> {
    return renewOnce(s).catch((): Renewal => ({ kind: 'ended', revoke: s.record?.refreshToken }));
  }
  /** Runs `work` unless this session already has one running, in which case the caller joins it. */
  function single(s: Session, work: () => Promise<VocsAccountState>): Promise<VocsAccountState> {
    if (s.op) return s.op;
    const op = work().finally(() => { if (s.op === op) s.op = undefined; });
    s.op = op;
    return op;
  }
  /** Applies a renewal to the current session; true when a fresh access token is ready. */
  function settle(s: Session, outcome: Renewal, epoch: number): boolean {
    if (epoch !== generation || s !== session) return false;
    switch (outcome.kind) {
      case 'ok': return true;
      case 'offline': update({ status: 'offline', refreshing: false, connections: [], error: undefined }); return false;
      case 'unavailable': update({ status: 'offline', refreshing: false, connections: [], error: UNAVAILABLE }); return false;
      case 'ended': end(ENDED, outcome.revoke); return false;
      default: return false;
    }
  }
  async function catalog(s: Session, controller: AbortController, epoch: number) {
    const token = s.accessToken;
    if (!token || s.accessExpiresAt <= Date.now()) throw new Error('Account token expired');
    const response = await bounded(send(target.resource, { method: 'GET', redirect: 'manual', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: controller.signal }), controller.signal);
    if (response.status !== 200 || response.redirected) { void response.body?.cancel().catch(() => undefined); if (response.status === 403) throw new CatalogAccessDenied(); if (response.status === 401 && !response.redirected) throw new CatalogUnauthorized(); throw new Error('Account catalog denied'); }
    const value = schema.parse(await json(response, controller.signal));
    if (epoch !== generation || controller.signal.aborted) throw new Error('Account operation interrupted');
    if (state.accountId && state.accountId !== value.account.id) throw new AccountChanged();
    update({ accountId: value.account.id, connections: value.connections });
  }
  /** Catalog read for a kept sign-in: a failure is reported, but does not end the device. A Hub
   *  401 renews the access token once and reads again. False when the session did not survive. */
  async function keptCatalog(s: Session, epoch: number): Promise<boolean> {
    const controller = new AbortController(); active = controller;
    update({ refreshing: true, connections: [], error: undefined });
    let timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      try { await catalog(s, controller, epoch); }
      catch (error) {
        if (!(error instanceof CatalogUnauthorized) || epoch !== generation) throw error;
        clearTimeout(timeout);
        if (!settle(s, await renew(s), epoch)) return false;
        timeout = setTimeout(() => controller.abort(), 10_000);
        await catalog(s, controller, epoch);
      }
      return true;
    } catch (error) {
      if (epoch !== generation) return false;
      if (error instanceof AccountChanged) { end(ENDED, s.record?.refreshToken); return false; }
      update({ connections: [], error: error instanceof CatalogAccessDenied ? missingAccess : CATALOG_UNVERIFIED });
      return true;
    } finally {
      clearTimeout(timeout);
      if (epoch === generation) { active = undefined; update({ refreshing: false }); }
    }
  }
  /** Renews a kept sign-in (startup or Retry) and reads the catalog before showing it connected. */
  async function resume(s: Session, epoch: number): Promise<VocsAccountState> {
    update({ status: 'restoring', refreshing: false, connections: [], error: undefined });
    if (!settle(s, await renew(s), epoch)) return get();
    if (!(await keptCatalog(s, epoch)) || epoch !== generation || s !== session) return get();
    update({ status: 'signed_in', persistent: true, deviceExpiresAt: s.record!.deviceExpiresAt });
    return get();
  }
  /** Startup: picks up a sign-in kept on this computer. Never blocks; the window shows `restoring`.
   *  A Refresh/Retry or second restore while it runs joins it. */
  let restoring: Promise<VocsAccountState> | undefined;
  function restore(): Promise<VocsAccountState> {
    if (restoring) return restoring;
    if (state.status !== 'signed_out' || session) return Promise.resolve(get());
    const run = restoreOnce().finally(() => { if (restoring === run) restoring = undefined; });
    restoring = run;
    return run;
  }
  async function restoreOnce(): Promise<VocsAccountState> {
    const epoch = generation;
    update({ status: 'restoring', error: undefined });
    const { raw, record } = await readVault();
    if (epoch !== generation) return get();
    if (!record) {
      // Unreadable, tampered or another realm's: ignored and removed, never used.
      if (raw !== undefined) void eraseVault();
      update({ status: 'signed_out' });
      return get();
    }
    if (!keychain()) {
      // Held in memory only (no keychain any more): it cannot survive this run, so it ends now
      // rather than living on as a device nobody can sign out.
      void eraseVault(); void revokeDevice(record.refreshToken);
      update({ status: 'signed_out' });
      return get();
    }
    const s: Session = { persistent: true, record, accessExpiresAt: 0, ended: false };
    session = s;
    return single(s, () => resume(s, epoch));
  }
  function signInFailure(error: unknown, persist: boolean): string {
    if (error instanceof CatalogAccessDenied) return missingAccess;
    if (!persist) return 'Sign-in or catalog access could not be completed. Try again.';
    if (error instanceof NativeOAuthError) {
      if (error.code === 'invalid_grant' && error.description === 'fresh_sign_in_required') return FRESH_SIGN_IN;
      if (error.code === 'invalid_client' || error.code === 'unauthorized_client' || error.code === 'unsupported_grant_type') return DEVICE_UNAVAILABLE;
    }
    return 'Sign-in could not be completed. Try again, or turn off “Keep me signed in on this computer”.';
  }
  async function signIn(request?: VocsAccountSignInRequest): Promise<VocsAccountState> {
    if (state.status === 'signing_in') return get();
    // Only where a device can be kept; otherwise this is the temporary sign-in, as the UI shows.
    const persist = request?.persist === true && canKeep();
    const deviceClientId = target.deviceClientId;
    // Kept sign-ins this one replaces (in memory: offline, restoring, or one whose vault write
    // failed; in the vault: read below). Revoked once the new sign-in has succeeded. One still
    // renewing is ended now, so its late rotation is revoked instead of overwriting the vault.
    const superseded = new Map<string, string>();
    if (session?.record) { session.ended = true; superseded.set(session.record.deviceId, session.record.refreshToken); }
    clear();
    const epoch = generation;
    const controller = new AbortController(); active = controller;
    update({ status: 'signing_in', error: undefined });
    let enrolled: Session | undefined;
    try {
      const client = (options.createOAuth ?? createNativeMcpOAuth)({
        resource: target.resource, issuer: target.issuer, scopes: ['catalog:read'], clientId: persist && deviceClientId ? deviceClientId : target.clientId, callbackPath: '/oauth/vocs', maxTokenAgeSeconds: 300,
        openExternal: options.openExternal, fetch: options.fetch, timeoutMs: options.timeoutMs,
        ...(persist ? { deviceName: vocsDeviceName(options.platform), onAbandonedDeviceGrant: (abandoned: NativeDeviceGrant) => void revokeDevice(abandoned.refreshToken) } : {})
      });
      oauth = client;
      await bounded(client.authorize(controller.signal), controller.signal);
      const grant = persist ? client.takeDeviceGrant() : undefined;
      if (epoch !== generation || controller.signal.aborted) { if (grant) void revokeDevice(grant.refreshToken); return get(); }
      const snapshot = client.credentialSnapshot();
      const token = snapshot?.token;
      if (!snapshot || !token?.expires_in || token.expires_in > 300 || token.scope !== 'catalog:read') { if (grant) void revokeDevice(grant.refreshToken); throw new Error('Invalid account token'); }
      const s: Session = { persistent: persist, accessToken: token.access_token, accessExpiresAt: snapshot.expiresAt, ended: false };
      enrolled = s;
      if (persist) {
        if (!grant) throw new Error('Invalid device grant');
        const before = await readVault();
        if (before.record) superseded.set(before.record.deviceId, before.record.refreshToken);
        s.record = { v: 1, issuer: target.issuer, clientId: VOCS_DEVICE_CLIENT_ID, resource: target.resource, ...grant };
        // Kept before the access token is used: a crash after this point still restores.
        const saved = await writeVault(s.record);
        if (epoch !== generation || controller.signal.aborted) throw new Error('Account operation interrupted');
        s.unsaved = !saved;
        if (!saved) update({ notice: NOT_SAVED });
      }
      // The SDK provider forgets its copy; from here the token lives only in this session.
      client.clear(); oauth = undefined;
      session = s;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try { await catalog(s, controller, epoch); } finally { clearTimeout(timeout); }
      if (epoch !== generation || controller.signal.aborted) throw new Error('Account operation interrupted');
      if (!persist && s.accessExpiresAt <= Date.now()) throw new Error('Account token expired');
      if (persist) update({ status: 'signed_in', persistent: true, deviceExpiresAt: s.record!.deviceExpiresAt });
      else {
        // A temporary sign-in replaces any kept one: it must not come back at the next start.
        const before = await readVault();
        if (epoch !== generation) throw new Error('Account operation interrupted');
        if (before.raw !== undefined) void eraseVault();
        if (before.record) superseded.set(before.record.deviceId, before.record.refreshToken);
        const expiresAt = s.accessExpiresAt;
        update({ status: 'signed_in', expiresAt });
        expiry = setTimeout(() => { if (epoch === generation) clear('Session expired. Sign in again.'); }, Math.max(0, expiresAt - Date.now()));
        expiry.unref?.();
      }
      for (const [deviceId, refreshToken] of superseded) if (deviceId !== s.record?.deviceId) void revokeDevice(refreshToken);
    } catch (error) {
      // An enrolled device that did not become the signed-in session is ended, not left behind.
      if (enrolled?.record && !enrolled.ended) {
        enrolled.ended = true;
        void revokeDevice(enrolled.record.refreshToken);
        void forget(enrolled.record.deviceId);
      }
      if (epoch === generation) clear(signInFailure(error, persist));
    } finally { if (epoch === generation) active = undefined; }
    return get();
  }
  async function refresh(): Promise<VocsAccountState> {
    if (restoring) return restoring;
    get();
    const s = session;
    if (s?.persistent) {
      // Restore, Retry and Refresh share one flight: a second click joins the first and gets its result.
      if (s.op) return s.op;
      const epoch = generation;
      // Retry from offline: renew the kept sign-in again.
      if (state.status === 'offline') return single(s, () => resume(s, epoch));
      if (state.status !== 'signed_in') return get();
      return single(s, async () => {
        if (!s.accessToken || s.accessExpiresAt - Date.now() < 30_000) {
          update({ refreshing: true, connections: [], error: undefined });
          if (!settle(s, await renew(s), epoch)) return get();
          update({ deviceExpiresAt: s.record!.deviceExpiresAt });
        }
        await keptCatalog(s, epoch);
        return get();
      });
    }
    if (state.status !== 'signed_in' || !s || state.refreshing) return get();
    const epoch = generation;
    const controller = new AbortController(); active = controller;
    // Clear stale permissions while offline/refreshing. Cached entries never authorize use.
    update({ refreshing: true, connections: [], error: undefined });
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try { await catalog(s, controller, epoch); }
    catch (error) { if (epoch === generation) clear(error instanceof CatalogAccessDenied ? missingAccess : 'Account access could not be verified. Sign in again.'); }
    finally {
      clearTimeout(timeout);
      if (epoch === generation) { active = undefined; update({ refreshing: false }); }
    }
    return get();
  }
  async function signOut(): Promise<VocsAccountState> {
    const s = session;
    if (s) s.ended = true;
    const temporary = s && !s.persistent ? s.accessToken : undefined;
    clear(); const epoch = generation;
    // The vault is cleared first, so signing out works offline; revocation follows.
    let record = s?.record;
    if (!record) record = (await readVault()).record;
    const erased = await eraseVault();
    let error = erased ? undefined : VAULT_NOT_CLEARED;
    if (record) {
      if (!(await revokeDevice(record.refreshToken))) error ??= REVOKE_UNCONFIRMED;
    } else if (temporary) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await bounded(send(`${target.issuer}/oauth2/revoke`, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: target.clientId, token: temporary, token_type_hint: 'access_token' })
        }), controller.signal);
        void response.body?.cancel().catch(() => undefined);
        if (response.status !== 200 || response.redirected) throw new Error('Revocation unavailable');
      } catch { error ??= 'Signed out locally. Remote revocation was not confirmed; the token expires within five minutes.'; }
      finally { clearTimeout(timer); }
    }
    if (error && epoch === generation) update({ error });
    return get();
  }
  /** App quit: memory goes, the vault stays. A device whose token never reached the vault cannot
   *  come back, so it is revoked (bounded; the quit does not wait on the network for long). */
  async function dispose(timeoutMs = 2000): Promise<void> {
    const s = session;
    clear();
    if (!s?.record || !s.unsaved || s.ended) return;
    s.ended = true;
    const record = s.record;
    await Promise.race([
      Promise.all([eraseVault(), revokeDevice(record.refreshToken)]),
      new Promise<void>(resolve => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })
    ]);
  }
  return { get, restore, signIn, refresh, signOut, cancel: () => { clear(); return get(); }, dispose };
}
export type VocsAccountBroker = ReturnType<typeof createVocsAccount>;
