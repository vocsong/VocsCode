/** Shared realm definitions and vault contract for Vocs account and Hub brokers. */
import type { VocsAccountRealm } from '../shared/vocs-account';

/** The public client that enrolls a kept ("Keep me signed in") device. */
export const VOCS_DEVICE_CLIENT_ID = 'vocs-code-device';

export interface RealmConfig {
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
    clientId: 'vocs-code',
    deviceClientId: VOCS_DEVICE_CLIENT_ID
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

/** The subset of `SecretStore` the account and Hub brokers use. */
export interface VocsAccountVault {
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  clear(id: string): Promise<void>;
  /** True when the value is held for this run only (no OS keychain). */
  isMemoryOnly?(id: string): boolean;
}
