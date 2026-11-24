/** Safe, descriptive account state only. Credentials never cross this contract. */

/** Every scope a Hub catalog connection may carry; `models:read` is always among them. */
export const VOCS_HUB_SCOPES = ['models:read', 'speech:write', 'audio:read'] as const;
export type VocsHubScope = typeof VOCS_HUB_SCOPES[number];
/** The Hub catalog connections this app knows how to connect (the catalog schema pins the id). */
export const VOCS_HUB_CONNECTION_IDS = ['openrouter'] as const;
export type VocsHubConnectionId = typeof VOCS_HUB_CONNECTION_IDS[number];
/** The MCP server name sessions see for a connected Hub connection (`mcp__vocs-openrouter__…`). */
export function vocsHubServerId(connectionId: VocsHubConnectionId): `vocs-${VocsHubConnectionId}` {
  return `vocs-${connectionId}`;
}
/**
 * One Hub connection as the settings page sees it. `connected` means a grant is kept (in the OS
 * keychain, or for this run only when `saved` is false) and new agent sessions get its tools.
 */
export interface VocsHubConnectionState {
  id: VocsHubConnectionId;
  serverId: string;
  status: 'disconnected' | 'connecting' | 'connected';
  /** Connected: the scopes the Hub granted. */
  scopes?: string[];
  /** Connected: false when the grant lasts only until Vocs Code closes (no keychain, or a failed write). */
  saved?: boolean;
  /** Why the connection ended or could not be made, e.g. revoked on mcp.vocs.io. */
  error?: string;
}

export interface VocsAccountConnection {
  id: string;
  name: string;
  transport: 'streamable-http';
  resource: string;
  authorizationServer: string | null;
  accountScopes: string[];
  authorization: 'oauth_required' | 'unavailable';
  executionReadiness: 'not_checked';
}
/** Production by default; staging only when main is launched with VOCS_CODE_ACCOUNT_REALM=staging. */
export type VocsAccountRealm = 'production' | 'staging';
/**
 * `restoring`: a sign-in kept on this computer is being renewed at startup or on Retry.
 * `offline`: the kept sign-in could not reach Vocs before anything was sent; it is still kept.
 */
export type VocsAccountStatus = 'signed_out' | 'signing_in' | 'restoring' | 'offline' | 'signed_in';
export interface VocsAccountState {
  realm: VocsAccountRealm;
  status: VocsAccountStatus;
  refreshing: boolean;
  revision: number;
  accountId?: string;
  /** Temporary (five-minute) sign-in only: when it ends. */
  expiresAt?: number;
  /** Signed in with "Keep me signed in on this computer". */
  persistent?: boolean;
  /** Persistent sign-in: the device's absolute end (ms epoch). */
  deviceExpiresAt?: number;
  /** False when this computer has no OS keychain, so a kept sign-in lasts until the app closes. */
  keychain?: boolean;
  /** This realm offers "Keep me signed in" (its issuer has device grants on). Absent/false: hidden. */
  deviceSignIn?: boolean;
  connections: VocsAccountConnection[];
  /** Hub connections this computer holds. Independent of the account sign-in: a connection stays
   *  usable after a temporary sign-in ends, and ends on sign-out or an account switch. */
  hub?: VocsHubConnectionState[];
  error?: string;
  /** A non-fatal problem worth saying, e.g. the sign-in could not be saved on this computer. */
  notice?: string;
}

/** The only sign-in option the renderer can pass; main picks the client, issuer and device name. */
export interface VocsAccountSignInRequest {
  persist: boolean;
}

/** The only Hub connection input the renderer can pass; main takes resource, issuer and scopes
 *  from the catalog it verified itself. */
export interface VocsHubConnectionRequest {
  connectionId: VocsHubConnectionId;
}
