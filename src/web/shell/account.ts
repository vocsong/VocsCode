/** The landing's signed-in session, when there is one. A local or ungated preview has no `/v1/me`,
 *  so account controls (sign out, the computer list) stay hidden there rather than failing open. */
export interface Account {
  login: string;
}

export type AccountState = { status: 'loading' } | { status: 'anonymous' } | { status: 'signed-in'; account: Account };

export async function loadAccount(): Promise<AccountState> {
  try {
    const response = await fetch('/v1/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return { status: 'anonymous' };
    const body = (await response.json()) as { login?: unknown };
    if (typeof body.login !== 'string' || !body.login) return { status: 'anonymous' };
    return { status: 'signed-in', account: { login: body.login } };
  } catch {
    // Pre-gate deployments do not have /v1/me. Never expose an account control without it.
    return { status: 'anonymous' };
  }
}
