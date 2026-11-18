/** Safe, descriptive account state only. Credentials never cross this contract. */
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
  error?: string;
  /** A non-fatal problem worth saying, e.g. the sign-in could not be saved on this computer. */
  notice?: string;
}

/** The only sign-in option the renderer can pass; main picks the client, issuer and device name. */
export interface VocsAccountSignInRequest {
  persist: boolean;
}
