/** @vitest-environment jsdom */
/** Account resolution for the web dashboard (src/web/shell/account.ts): only a landing session
 *  with a login and a valid account id counts as signed in. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_ACCOUNT_ID } from '../relay/src/account';
import { accountStateOf, resolveAccount } from '../src/web/shell/account';

const response = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('account resolution', () => {
  it('treats a 401 or a network failure as no identity at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(401)));
    await expect(resolveAccount()).resolves.toEqual({ accountId: null, authenticated: false, allowLegacyMigration: false });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(resolveAccount()).resolves.toEqual({ accountId: null, authenticated: false, allowLegacyMigration: false });
  });

  it('treats a 404 or 503 as the legacy preview, and only that page may migrate the old vault', async () => {
    for (const status of [404, 503]) {
      vi.stubGlobal('fetch', vi.fn(async () => response(status)));
      await expect(resolveAccount()).resolves.toEqual({ accountId: LEGACY_ACCOUNT_ID, authenticated: false, allowLegacyMigration: true });
    }
  });

  it('accepts a landing session only with a login and a valid account id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { login: 'vocs', accountId: 'github:710003' })));
    await expect(resolveAccount()).resolves.toMatchObject({ accountId: 'github:710003', authenticated: true, allowLegacyMigration: false, login: 'vocs' });
    for (const body of [{ login: 'vocs', accountId: 'nope' }, { accountId: 'github:1' }, { login: '', accountId: 'github:1' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => response(200, body)));
      await expect(resolveAccount()).resolves.toMatchObject({ accountId: null, authenticated: false });
    }
  });

  it('uses a separate vault partition for self-service accounts, with no legacy migration', async () => {
    const accountId = `vocs:${'a'.repeat(42)}A`;
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { login: 'Vocs account', accountId })));
    await expect(resolveAccount()).resolves.toEqual({ accountId, authenticated: true, allowLegacyMigration: false, login: 'Vocs account' });
  });

  it('only shows the signed-in UI for an authenticated identity', () => {
    expect(accountStateOf({ accountId: 'github:710003', authenticated: true, allowLegacyMigration: false, login: 'vocs' })).toEqual({ status: 'signed-in', account: { login: 'vocs', accountId: 'github:710003' } });
    expect(accountStateOf({ accountId: LEGACY_ACCOUNT_ID, authenticated: false, allowLegacyMigration: true })).toEqual({ status: 'anonymous' });
  });
});
