/**
 * Vocs MCP Hub connections (mcp.vocs.io). Connect authorizes one catalog connection in the system
 * browser (dynamic public client, S256 PKCE, loopback callback) and keeps only its rotating refresh
 * token, in the OS keychain (`SecretStore`, keychain-only id `vocs-hub:<realm>:<connection>`).
 * Access tokens stay in this process's memory. Agent sessions reach the Hub through a loopback MCP
 * proxy that checks an app-minted bearer and forwards each POST to the exact Hub resource with the
 * real token, so no harness, config file or argv ever carries a Hub token. Tokens are never logged.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import { z } from 'zod';
import { VOCS_HUB_CONNECTION_IDS, VOCS_HUB_SCOPES, vocsHubServerId, type VocsAccountConnection, type VocsAccountRealm, type VocsHubConnectionId, type VocsHubConnectionState, type VocsHubScope } from '../shared/vocs-account';
import { createNativeMcpOAuth, NativeOAuthError, REFRESH_TOKEN, type NativeMcpOAuth, type NativeMcpOAuthOptions, type NativeRefreshGrant } from './mcp/oauth';
import type { ResolvedServer } from './mcp/effective';
import { VOCS_REALMS, type VocsAccountVault } from './vocs-account-config';

/** One keychain slot per realm and connection, so a staging grant never restores as production. */
export function vocsHubVaultId(realm: VocsAccountRealm, connectionId: VocsHubConnectionId): `vocs-hub:${VocsAccountRealm}:${VocsHubConnectionId}` {
  return `vocs-hub:${realm}:${connectionId}`;
}
/** The `SecretStore` ids that must never fall back to obfuscated storage on disk. */
export const VOCS_HUB_VAULT_IDS: readonly string[] = (['production', 'staging'] as const).flatMap((realm) => VOCS_HUB_CONNECTION_IDS.map((id) => vocsHubVaultId(realm, id)));

/** The Hub issues 15-minute access tokens; a longer one is refused. */
export const VOCS_HUB_MAX_TOKEN_SECONDS = 900;
/** A proxied call renews first when the access token has less than this left. */
const REFRESH_MARGIN_MS = 60_000;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 32 * 1_048_576;
const PROXY_TIMEOUT_MS = 120_000;

const REVOKED = 'Disconnected on mcp.vocs.io — connect again';
const ENDED = 'The mcp.vocs.io connection ended. Connect again.';
const ACCOUNT_SWITCHED = 'Disconnected because a different Vocs account signed in. Connect again to use it with this account.';
const REMOVED = 'Disconnected because this connection is no longer in your Hub catalog.';
const NOT_IN_CATALOG = 'This connection is not available in your Hub catalog right now. Refresh connections and try again.';
const NEEDS_SIGN_IN = 'Sign in to your Vocs account to connect.';
const CONNECT_FAILED = 'Connecting to mcp.vocs.io did not complete. Try again.';
const CONNECT_DENIED = 'Connecting was not approved on mcp.vocs.io.';
const UNREACHABLE = 'mcp.vocs.io could not be reached. Try again in a moment.';
const REVOKE_UNCONFIRMED = 'Disconnected on this computer. mcp.vocs.io did not confirm it; you can also revoke Vocs Code on mcp.vocs.io.';
const VAULT_NOT_CLEARED = 'Disconnected, but Vocs Code could not remove the saved connection from this computer.';
export const VOCS_HUB_MESSAGES = { REVOKED, ENDED, ACCOUNT_SWITCHED, REMOVED, NOT_IN_CATALOG, NEEDS_SIGN_IN } as const;

const scopesSchema = z.array(z.enum(VOCS_HUB_SCOPES)).min(1).max(VOCS_HUB_SCOPES.length)
  .refine((scopes) => scopes.includes('models:read') && new Set(scopes).size === scopes.length);
/** The vault record. Checked against the pinned realm on load: it never chooses where tokens go. */
const recordSchema = z.strictObject({
  v: z.literal(1), issuer: z.string(), resource: z.string(), clientId: z.string().regex(/^[\x21-\x7e]{1,256}$/),
  scopes: scopesSchema, refreshToken: z.string().regex(REFRESH_TOKEN), accountId: z.string().regex(/^[a-f0-9]{64}$/)
});
type HubRecord = z.infer<typeof recordSchema>;
const tokenSchema = z.object({
  access_token: z.string().min(1).max(16384), token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive().max(VOCS_HUB_MAX_TOKEN_SECONDS),
  refresh_token: z.string().regex(REFRESH_TOKEN).optional(), scope: z.string().max(512).optional()
});

export interface VocsHubOptions {
  /** Same realm as the account broker; chosen by main, never by the renderer. */
  realm?: VocsAccountRealm;
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
  /** Test seam only; production always uses the real SDK controller. */
  createOAuth?: (options: NativeMcpOAuthOptions) => NativeMcpOAuth;
  timeoutMs?: number;
  /** Where a connection's refresh token lives. Absent: it lasts for this run only. */
  vault?: VocsAccountVault;
  /** Electron's `net.isOnline()`. False means a refresh is never sent. */
  isOnline?: () => boolean;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Upper bound for one proxied Hub call. */
  proxyTimeoutMs?: number;
}

/** One connection instance. Only main holds it; the renderer sees `VocsHubConnectionState`. */
interface Entry {
  id: VocsHubConnectionId;
  status: 'connecting' | 'connected';
  /** The Vocs account it was connected under; a different account ends it. */
  accountId: string;
  record?: HubRecord;
  accessToken?: string;
  accessExpiresAt: number;
  /** Ended on purpose: a late answer revokes whatever it carries. */
  ended: boolean;
  /** The newest refresh token is not in a lasting vault (failed write, or no OS keychain). */
  unsaved?: boolean;
  controller?: AbortController;
  oauth?: NativeMcpOAuth;
  /** The app-minted proxy bearer of this instance; a new connection gets a new one. */
  bearer?: string;
  /** Single flight for the refresh grant. */
  refreshing?: Promise<Renewal>;
}
type Renewal = 'ok' | 'offline' | 'unavailable' | 'revoked' | 'ended' | 'stale';

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const isHubId = (id: string): id is VocsHubConnectionId => (VOCS_HUB_CONNECTION_IDS as readonly string[]).includes(id);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

async function race<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('Hub operation interrupted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await race(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new Error('Body too large');
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => undefined); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

class TooLarge extends Error {}
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk as Buffer);
    size += data.length;
    if (size > limit) throw new TooLarge();
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

export function createVocsHub(options: VocsHubOptions) {
  const realm: VocsAccountRealm = options.realm ?? 'production';
  const target = VOCS_REALMS[realm];
  const tokenEndpoint = `${target.hub}/oauth/token`;
  const send = (input: string, init: RequestInit) => (options.fetch ?? fetch)(input, init);
  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => { try { options.log?.(level, `vocs hub: ${message}`); } catch { /* logging never fails a call */ } };
  const resourceFor = (id: VocsHubConnectionId) => `${target.hub}/${id}`;
  const vaultId = (id: VocsHubConnectionId) => vocsHubVaultId(realm, id);
  const keychain = (id: VocsHubConnectionId) => { try { return !!options.vault && !options.vault.isMemoryOnly?.(vaultId(id)); } catch { return false; } };
  const online = () => { try { return options.isOnline?.() ?? true; } catch { return true; } };

  const entries = new Map<VocsHubConnectionId, Entry>();
  /** Why a connection is not connected, shown until the next attempt. */
  const errors = new Map<VocsHubConnectionId, string>();
  /** sha256(proxy bearer) → the connection instance it authorizes. */
  const capabilities = new Map<string, Entry>();
  let restoring: Promise<void> | undefined;
  let proxy: { server: Server; base: string; host: string } | undefined;
  let starting: Promise<string> | undefined;
  const sockets = new Set<Socket>();
  let disposed = false;

  function parseRecord(id: VocsHubConnectionId, raw: string | undefined): HubRecord | undefined {
    if (!raw) return undefined;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return undefined; }
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success || parsed.data.issuer !== target.hub || parsed.data.resource !== resourceFor(id)) return undefined;
    return parsed.data;
  }
  async function readVault(id: VocsHubConnectionId): Promise<{ raw?: string; record?: HubRecord }> {
    try { const raw = await options.vault?.get(vaultId(id)); return { raw, record: parseRecord(id, raw) }; }
    catch { return {}; }
  }
  async function writeVault(id: VocsHubConnectionId, record: HubRecord): Promise<boolean> {
    if (!options.vault) return false;
    try { await options.vault.set(vaultId(id), JSON.stringify(record)); return true; }
    catch { return false; }
  }
  async function eraseVault(id: VocsHubConnectionId): Promise<boolean> {
    try { await options.vault?.clear(vaultId(id)); return true; }
    catch { return false; }
  }
  /** Clears the vault only while it still holds this connection instance (its registered client),
   *  so a newer connection is never erased. */
  async function forget(id: VocsHubConnectionId, clientId: string): Promise<boolean> {
    const { raw, record } = await readVault(id);
    if (raw === undefined) return true;
    if (record && record.clientId !== clientId) return true;
    return eraseVault(id);
  }
  /** RFC 7009 at the Hub: its token endpoint, without grant_type. Bounded; never throws. */
  async function revoke(grant: { clientId: string; refreshToken: string }): Promise<boolean> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await race(send(tokenEndpoint, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: grant.refreshToken, client_id: grant.clientId })
      }), controller.signal);
      void response.body?.cancel().catch(() => undefined);
      return response.status === 200;
    } catch { return false; }
    finally { clearTimeout(timer); }
  }

  function mint(entry: Entry) {
    const bearer = randomBytes(32).toString('base64url');
    capabilities.set(digest(bearer), entry);
    entry.bearer = bearer;
  }
  /** Memory only, at once: stops injection, refuses the proxy bearer and cancels a pending sign-in. */
  function end(entry: Entry) {
    entry.ended = true;
    if (entries.get(entry.id) === entry) entries.delete(entry.id);
    entry.controller?.abort(); entry.controller = undefined;
    entry.oauth?.clear(); entry.oauth = undefined;
    if (entry.bearer) capabilities.delete(digest(entry.bearer));
    entry.bearer = undefined; entry.accessToken = undefined; entry.accessExpiresAt = 0;
  }

  function states(): VocsHubConnectionState[] {
    return VOCS_HUB_CONNECTION_IDS.map((id): VocsHubConnectionState => {
      const entry = entries.get(id);
      const base = { id, serverId: vocsHubServerId(id) };
      if (entry?.status === 'connected') return { ...base, status: 'connected', scopes: [...entry.record!.scopes], saved: !entry.unsaved };
      if (entry?.status === 'connecting') return { ...base, status: 'connecting' };
      const error = errors.get(id);
      return { ...base, status: 'disconnected', ...(error ? { error } : {}) };
    });
  }

  /** Startup: picks up connections kept on this computer. Reads the vault only; the first proxied
   *  call renews the access token, so nothing is sent at launch. */
  function restore(): Promise<void> {
    restoring ??= (async () => {
      for (const id of VOCS_HUB_CONNECTION_IDS) {
        const { raw, record } = await readVault(id);
        if (disposed || entries.has(id)) continue;
        if (!record) {
          // Unreadable, tampered or another realm's: removed, never used.
          if (raw !== undefined) void eraseVault(id);
          continue;
        }
        const entry: Entry = { id, status: 'connected', accountId: record.accountId, record, accessExpiresAt: 0, ended: false, unsaved: !keychain(id) };
        entries.set(id, entry);
        mint(entry);
        log('info', `${id} restored from this computer`);
      }
    })().catch(() => undefined);
    return restoring;
  }

  function connectFailure(error: unknown): string {
    if (error instanceof NativeOAuthError && error.code === 'access_denied') return CONNECT_DENIED;
    return CONNECT_FAILED;
  }

  /** Explicit Connect for one verified catalog connection, under the signed-in account. */
  async function connect(connection: VocsAccountConnection, accountId: string): Promise<void> {
    await restore();
    const id = connection.id;
    if (disposed || !isHubId(id) || entries.has(id)) return;
    errors.delete(id);
    const scopes = connection.accountScopes.filter((scope): scope is VocsHubScope => (VOCS_HUB_SCOPES as readonly string[]).includes(scope));
    if (connection.authorization !== 'oauth_required' || connection.authorizationServer !== target.hub || connection.resource !== resourceFor(id) || !scopes.includes('models:read')) {
      errors.set(id, NOT_IN_CATALOG);
      return;
    }
    const controller = new AbortController();
    const entry: Entry = { id, status: 'connecting', accountId, accessExpiresAt: 0, ended: false, controller };
    entries.set(id, entry);
    const abandoned = (grant: NativeRefreshGrant) => void revoke(grant);
    try {
      const client = (options.createOAuth ?? createNativeMcpOAuth)({
        resource: connection.resource, issuer: target.hub, scopes, maxTokenAgeSeconds: VOCS_HUB_MAX_TOKEN_SECONDS,
        keepRefreshToken: true, onAbandonedRefreshGrant: abandoned,
        openExternal: options.openExternal, fetch: options.fetch, timeoutMs: options.timeoutMs
      });
      entry.oauth = client;
      await race(client.authorize(controller.signal), controller.signal);
      const grant = client.takeRefreshGrant();
      const snapshot = client.credentialSnapshot();
      // The SDK provider forgets its copy; from here the access token lives only in this entry.
      client.clear(); entry.oauth = undefined;
      if (entry.ended || entries.get(id) !== entry) { if (grant) abandoned(grant); return; }
      const token = snapshot?.token;
      const granted = token?.scope ? [...new Set(token.scope.split(' ').filter(Boolean))] : [...scopes];
      if (!grant || !snapshot || !token?.expires_in || token.expires_in > VOCS_HUB_MAX_TOKEN_SECONDS || !granted.includes('models:read') || granted.some((scope) => !(scopes as string[]).includes(scope))) {
        if (grant) abandoned(grant);
        throw new Error('Invalid Hub grant');
      }
      const record: HubRecord = { v: 1, issuer: target.hub, resource: connection.resource, clientId: grant.clientId, scopes: granted as VocsHubScope[], refreshToken: grant.refreshToken, accountId };
      entry.record = record;
      // Kept before the access token is used: a crash after this point still restores.
      const saved = await writeVault(id, record);
      if (entry.ended || entries.get(id) !== entry) { void revoke(record); void forget(id, record.clientId); return; }
      entry.unsaved = !saved || !keychain(id);
      if (!saved) log('warn', `${id} could not be saved on this computer; it lasts until Vocs Code closes`);
      entry.accessToken = token.access_token;
      entry.accessExpiresAt = snapshot.expiresAt;
      entry.status = 'connected'; entry.controller = undefined;
      mint(entry);
      log('info', `${id} connected (${granted.join(' ')})`);
    } catch (error) {
      entry.oauth?.clear(); entry.oauth = undefined;
      if (entries.get(id) === entry) entries.delete(id);
      if (entry.record && !entry.ended) { void revoke(entry.record); void forget(id, entry.record.clientId); }
      if (!entry.ended) { errors.set(id, connectFailure(error)); log('warn', `${id} connect did not complete`); }
      entry.ended = true;
    }
  }

  function cancel(id: VocsHubConnectionId): void {
    const entry = entries.get(id);
    if (entry?.status !== 'connecting') return;
    end(entry);
    errors.delete(id);
  }

  /** Ends a connection: memory (and injection) at once, then best-effort revocation at the Hub,
   *  then the vault. `reason` is what the page says afterwards. */
  async function disconnect(id: VocsHubConnectionId, reason?: string): Promise<void> {
    await restore();
    const entry = entries.get(id);
    if (entry) end(entry);
    if (reason) errors.set(id, reason); else errors.delete(id);
    let record = entry?.record;
    let raw: string | undefined;
    if (!record) ({ raw, record } = await readVault(id));
    if (!record) {
      if (raw !== undefined && !(await eraseVault(id)) && !entries.has(id)) errors.set(id, VAULT_NOT_CLEARED);
      return;
    }
    const revoked = await revoke(record);
    const erased = await forget(id, record.clientId);
    if (entries.has(id)) return; // A newer connection owns the page now.
    if (!erased) errors.set(id, VAULT_NOT_CLEARED);
    else if (!revoked && !reason) errors.set(id, REVOKE_UNCONFIRMED);
    log('info', `${id} disconnected${revoked ? '' : ' (revocation not confirmed)'}`);
  }

  /** A verified catalog read: a connection made under another account, or one the catalog no longer
   *  lists as authorizable here, is disconnected (and revoked, best effort). */
  async function accountSeen(accountId: string, connections: readonly VocsAccountConnection[]): Promise<void> {
    await restore();
    const work: Promise<void>[] = [];
    for (const entry of [...entries.values()]) {
      if (entry.accountId !== accountId) { work.push(disconnect(entry.id, ACCOUNT_SWITCHED)); continue; }
      if (entry.status !== 'connected') continue;
      const listed = connections.find((c) => c.id === entry.id);
      if (!listed || listed.authorization !== 'oauth_required' || listed.authorizationServer !== entry.record!.issuer || listed.resource !== entry.record!.resource) work.push(disconnect(entry.id, REMOVED));
    }
    await Promise.all(work);
  }

  /** Vocs account sign-out: every connection on this computer ends (revoked, best effort). */
  async function accountSignedOut(): Promise<void> {
    await Promise.all(VOCS_HUB_CONNECTION_IDS.map((id) => disconnect(id)));
  }

  /** Connect asked for while it cannot start: not signed in, or not in the verified catalog. */
  function refuse(id: VocsHubConnectionId, reason: 'signed_out' | 'not_listed'): void {
    if (!entries.has(id)) errors.set(id, reason === 'signed_out' ? NEEDS_SIGN_IN : NOT_IN_CATALOG);
  }

  // ---------------------------------------------------------------------------------------------
  // Access tokens
  // ---------------------------------------------------------------------------------------------

  /** The refresh grant. The rotated token reaches the vault before the new access token is used. */
  async function renewOnce(entry: Entry): Promise<Renewal> {
    const record = entry.record!;
    if (!online()) return 'offline';
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
    let status: number, body: unknown;
    try {
      let response: Response;
      try {
        response = await race(send(tokenEndpoint, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: record.refreshToken, client_id: record.clientId })
        }), controller.signal);
      } catch {
        // Lost or never sent: the previous refresh token stays valid until a new one is used.
        return entry.ended ? 'stale' : 'offline';
      }
      status = response.status;
      try { body = status >= 300 && status < 400 ? undefined : await boundedJson(response, controller.signal); } catch { body = undefined; }
    } finally { clearTimeout(timer); }
    const fields = isObject(body) ? body : undefined;
    if (status === 200 && fields) {
      const parsed = tokenSchema.safeParse(fields);
      if (entry.ended) {
        const late = typeof fields.refresh_token === 'string' && REFRESH_TOKEN.test(fields.refresh_token) ? fields.refresh_token : undefined;
        if (late) void revoke({ clientId: record.clientId, refreshToken: late });
        return 'stale';
      }
      // Malformed: a rotated token was never used, so the one we hold is still good.
      if (!parsed.success) return 'unavailable';
      const scopes = parsed.data.scope ? [...new Set(parsed.data.scope.split(' ').filter(Boolean))] : record.scopes;
      if (!scopes.includes('models:read') || scopes.some((scope) => !(record.scopes as string[]).includes(scope))) return 'ended';
      const next: HubRecord = { ...record, refreshToken: parsed.data.refresh_token ?? record.refreshToken, scopes: scopes as VocsHubScope[] };
      // Memory holds the newest token even if the vault write fails, so this run stays connected.
      entry.record = next;
      const unchanged = next.refreshToken === record.refreshToken && next.scopes.join(' ') === record.scopes.join(' ');
      const saved = unchanged ? !entry.unsaved : await writeVault(entry.id, next);
      if (entry.ended) { void revoke(next); void forget(entry.id, next.clientId); return 'stale'; }
      if (entries.get(entry.id) !== entry) return 'stale';
      entry.unsaved = !saved || !keychain(entry.id);
      if (!saved) log('warn', `${entry.id} renewal could not be saved on this computer`);
      entry.accessToken = parsed.data.access_token;
      entry.accessExpiresAt = Date.now() + parsed.data.expires_in * 1000;
      return 'ok';
    }
    if (entry.ended) return 'stale';
    if (fields?.error === 'invalid_grant') return 'revoked';
    if (fields?.error === 'invalid_client' || fields?.error === 'unauthorized_client') return 'ended';
    return 'unavailable';
  }
  function settle(entry: Entry, outcome: Renewal): void {
    if (entry.ended || entries.get(entry.id) !== entry) return;
    const record = entry.record!;
    if (outcome === 'revoked') {
      // The user revoked it on the dashboard (or the account or a scope grant went away).
      end(entry);
      errors.set(entry.id, REVOKED);
      void forget(entry.id, record.clientId);
      log('info', `${entry.id} was revoked on mcp.vocs.io`);
    } else if (outcome === 'ended') {
      end(entry);
      errors.set(entry.id, ENDED);
      void revoke(record);
      void forget(entry.id, record.clientId);
      log('warn', `${entry.id} renewal was refused`);
    } else if (outcome !== 'ok' && outcome !== 'stale') log('warn', `${entry.id} renewal unavailable (${outcome})`);
  }
  /** A usable access token, renewing when it is missing, within a minute of expiry, or the one the
   *  Hub just refused. Concurrent callers share one refresh. */
  async function access(entry: Entry, rejected?: string): Promise<string | undefined> {
    const usable = (margin: number) => entry.accessToken && entry.accessToken !== rejected && entry.accessExpiresAt - Date.now() > margin ? entry.accessToken : undefined;
    const ready = usable(REFRESH_MARGIN_MS);
    if (ready) return ready;
    if (entry.ended || entries.get(entry.id) !== entry || !entry.record) return undefined;
    entry.refreshing ??= renewOnce(entry)
      .catch((): Renewal => 'unavailable')
      .then((outcome) => { settle(entry, outcome); return outcome; })
      .finally(() => { entry.refreshing = undefined; });
    await entry.refreshing;
    if (entry.ended || entries.get(entry.id) !== entry) return undefined;
    // Renewed, or (offline/unavailable) the current token still has a little life left.
    return usable(0);
  }

  // ---------------------------------------------------------------------------------------------
  // Loopback proxy
  // ---------------------------------------------------------------------------------------------

  function reply(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
    if (res.headersSent || res.destroyed) { res.destroy(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
  }

  function startProxy(): Promise<string> {
    if (proxy) return Promise.resolve(proxy.base);
    starting ??= new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => { void handle(req, res); });
      // Receiving a request is bounded; the Hub's answer may take as long as the proxy timeout.
      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;
      server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const port = (server.address() as AddressInfo).port;
        if (disposed) { server.close(); reject(new Error('Hub proxy closed')); return; }
        proxy = { server, base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
        resolve(proxy.base);
      });
    }).finally(() => { starting = undefined; });
    return starting;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const current = proxy;
    // No browser-originated calls or DNS-rebinding aliases, even with a guessed URL.
    if (!current || req.headers.host !== current.host || req.headers.origin !== undefined) { req.resume(); reply(res, 403, 'Forbidden'); return; }
    const id = /^\/hub\/([a-z0-9-]{1,64})$/.exec(req.url ?? '')?.[1];
    if (!id || !isHubId(id)) { req.resume(); reply(res, 404, 'Not found'); return; }
    const presented = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const entry = presented ? capabilities.get(digest(presented)) : undefined;
    if (!entry || entry.id !== id || entry.ended || entries.get(id) !== entry || entry.status !== 'connected') {
      req.resume();
      reply(res, 401, 'This Vocs MCP Hub connection is no longer active here. Connect it again in Settings → Vocs account, then start a new session.');
      return;
    }
    if (req.method !== 'POST') { req.resume(); reply(res, 405, 'The Vocs MCP Hub accepts POST only.', { Allow: 'POST' }); return; }
    const contentType = req.headers['content-type'];
    if (!contentType || !/^application\/json\b/i.test(contentType)) { req.resume(); reply(res, 415, 'Expected a JSON POST.'); return; }
    let body: Buffer;
    try { body = await readBody(req, MAX_REQUEST_BYTES); }
    catch (error) {
      if (error instanceof TooLarge) { req.resume(); reply(res, 413, 'Request too large.', { Connection: 'close' }); }
      else res.destroy();
      return;
    }
    const accept = req.headers.accept && req.headers.accept.length <= 256 ? req.headers.accept : 'application/json, text/event-stream';
    const protocol = req.headers['mcp-protocol-version'];
    const headers: Record<string, string> = { 'Content-Type': contentType, Accept: accept, ...(typeof protocol === 'string' && /^[\w.-]{1,32}$/.test(protocol) ? { 'MCP-Protocol-Version': protocol } : {}) };
    const controller = new AbortController();
    let timedOut = false;
    const onClose = () => { if (!res.writableFinished) controller.abort(); };
    res.on('close', onClose);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.proxyTimeoutMs ?? PROXY_TIMEOUT_MS);
    try { await forward(entry, body, headers, res, controller.signal); }
    catch {
      if (res.headersSent || res.destroyed) res.destroy();
      else reply(res, timedOut ? 504 : 502, timedOut ? 'mcp.vocs.io did not answer in time.' : UNREACHABLE);
    }
    finally { clearTimeout(timer); res.off('close', onClose); }
  }

  /** One POST to the exact Hub resource, redirects refused. */
  function post(entry: Entry, token: string, body: Buffer, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    return race(send(entry.record!.resource, { method: 'POST', redirect: 'manual', signal, body: new Uint8Array(body), headers: { ...headers, Authorization: `Bearer ${token}` } }), signal);
  }

  async function forward(entry: Entry, body: Buffer, headers: Record<string, string>, res: ServerResponse, signal: AbortSignal): Promise<void> {
    const unavailable = () => reply(res, 503, entry.ended ? errors.get(entry.id) ?? ENDED : UNREACHABLE);
    let token = await access(entry);
    if (!token) { unavailable(); return; }
    let upstream = await post(entry, token, body, headers, signal);
    if (upstream.status === 401) {
      // Renew once (unless another call already did) and retry once.
      void upstream.body?.cancel().catch(() => undefined);
      token = await access(entry, token);
      if (!token) { unavailable(); return; }
      upstream = await post(entry, token, body, headers, signal);
      if (upstream.status === 401) {
        void upstream.body?.cancel().catch(() => undefined);
        // Never a 401 here: the harness would start an OAuth flow against this loopback proxy.
        reply(res, 502, 'mcp.vocs.io refused this connection. Disconnect and connect it again in Settings → Vocs account.');
        return;
      }
    }
    if (upstream.status >= 300 && upstream.status < 400) { void upstream.body?.cancel().catch(() => undefined); reply(res, 502, 'mcp.vocs.io answered with a redirect, which is not followed.'); return; }
    const out: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const type = upstream.headers.get('content-type');
    if (type) out['Content-Type'] = type;
    if (!upstream.body) { res.writeHead(upstream.status, out); res.end(); return; }
    const reader = upstream.body.getReader();
    let size = 0;
    try {
      res.writeHead(upstream.status, out);
      for (;;) {
        const { done, value } = await race(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { res.destroy(); return; }
        if (!res.write(value)) await new Promise<void>((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
      }
      res.end();
    } finally { void reader.cancel().catch(() => undefined); }
  }

  /** What a new session gets while connected: the proxy URL and this instance's proxy bearer,
   *  marked secret so an adapter that flattens config into argv hands it over another way. */
  async function servers(): Promise<ResolvedServer[]> {
    await restore();
    if (disposed || ![...entries.values()].some((entry) => entry.status === 'connected')) return [];
    const base = await startProxy();
    return [...entries.values()].filter((entry) => entry.status === 'connected' && entry.bearer && !entry.ended).map((entry): ResolvedServer => {
      const id = vocsHubServerId(entry.id);
      return {
        def: { id, transport: 'http', url: `${base}/hub/${entry.id}`, headers: { Authorization: `Bearer ${entry.bearer}` }, builtin: id, description: `Vocs MCP Hub (${target.hub.replace(/^https:\/\//, '')}): ${entry.id}` },
        missing: [], secretEnvKeys: [], secretHeaderKeys: ['Authorization']
      };
    });
  }

  /** App quit: memory and the proxy go, the vault stays. A connection whose token never reached a
   *  lasting vault cannot come back, so it is revoked (bounded). */
  async function dispose(timeoutMs = 2000): Promise<void> {
    disposed = true;
    const unsaved = [...entries.values()].filter((entry) => entry.status === 'connected' && entry.unsaved && entry.record).map((entry) => ({ id: entry.id, record: entry.record! }));
    for (const entry of [...entries.values()]) end(entry);
    capabilities.clear();
    const server = proxy?.server;
    proxy = undefined;
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!unsaved.length) return;
    await Promise.race([
      Promise.all(unsaved.map(({ id, record }) => Promise.all([forget(id, record.clientId), revoke(record)]))),
      new Promise<void>((resolve) => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })
    ]);
  }

  return { restore, states, connect, cancel, disconnect, accountSeen, accountSignedOut, refuse, servers, dispose };
}
export type VocsHubBroker = ReturnType<typeof createVocsHub>;
