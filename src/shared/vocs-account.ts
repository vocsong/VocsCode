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
export interface VocsAccountState {
  realm: 'staging';
  status: 'signed_out' | 'signing_in' | 'signed_in';
  refreshing: boolean;
  revision: number;
  accountId?: string;
  expiresAt?: number;
  connections: VocsAccountConnection[];
  error?: string;
}
