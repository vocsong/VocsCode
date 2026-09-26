/** The landing's signed-in session, when there is one (docs/REMOTE-ACCESS.md §6.3.1). The account
 *  id partitions the browser vault, so an identity is resolved before the RelayClient exists:
 *  503/404 is the local or pre-gate preview (the legacy dev account), a 401 or a network failure is
 *  no identity at all, and only a 200 with a login and a valid account id is signed in. */
import { isAccountId, LEGACY_ACCOUNT_ID } from '../../../relay/src/account';

export interface Account {
  login: string;
  /** The relay account id; also the vault partition. */
  accountId: string;
}

export type AccountState = { status: 'anonymous' } | { status: 'signed-in'; account: Account };

export interface AccountResolution {
  /** The vault partition, or null when the visitor has no identity (401/network). */
  accountId: string | null;
  /** True only for a real landing session; the legacy preview account is not authenticated. */
  authenticated: boolean;
  /** `state:<accountId>` may inherit the pre-account vault for the incumbent account only. */
  allowLegacyMigration: boolean;
  /** The GitHub login, for the signed-in UI only. */
  login?: string;
}

export async function resolveAccount(): Promise<AccountResolution> {
  try {
    const response = await fetch('/v1/me', { credentials: 'same-origin', cache: 'no-store' });
    // An explicit 503/404 is the local or pre-gate preview: preserve the legacy dev account.
    // A 401 or network failure is not an identity and must not load another user's vault.
    if (response.status === 503 || response.status === 404) return { accountId: LEGACY_ACCOUNT_ID, authenticated: false, allowLegacyMigration: true };
    if (!response.ok) return { accountId: null, authenticated: false, allowLegacyMigration: false };
    const body = (await response.json()) as { login?: unknown; accountId?: unknown };
    if (typeof body.login !== 'string' || !body.login || !isAccountId(body.accountId)) {
      return { accountId: null, authenticated: false, allowLegacyMigration: false };
    }
    return { accountId: body.accountId, authenticated: true, allowLegacyMigration: body.accountId === LEGACY_ACCOUNT_ID, login: body.login };
  } catch {
    return { accountId: null, authenticated: false, allowLegacyMigration: false };
  }
}

/** The UI view of a resolution: signed out for both no-identity and the legacy preview. */
export function accountStateOf(resolution: AccountResolution): AccountState {
  return resolution.authenticated && resolution.login
    ? { status: 'signed-in', account: { login: resolution.login, accountId: resolution.accountId! } }
    : { status: 'anonymous' };
}
