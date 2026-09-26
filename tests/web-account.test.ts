/** @vitest-environment jsdom */
/** Account resolution and the account-partitioned vault (src/web/shell/account.ts,
 *  src/web/transport/vault.ts): a signed-in GitHub subject gets its own IndexedDB bucket, the
 *  legacy dev account keeps the pre-account vault, and an unauthenticated visitor gets nothing. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_ACCOUNT_ID } from '../relay/src/account';
import { accountStateOf, resolveAccount } from '../src/web/shell/account';
import { indexedDbVault } from '../src/web/transport/vault';
import { fakeIndexedDB } from './support/fake-indexeddb';

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

  it('only shows the signed-in UI for an authenticated identity', () => {
    expect(accountStateOf({ accountId: 'github:710003', authenticated: true, allowLegacyMigration: false, login: 'vocs' })).toEqual({ status: 'signed-in', account: { login: 'vocs', accountId: 'github:710003' } });
    expect(accountStateOf({ accountId: LEGACY_ACCOUNT_ID, authenticated: false, allowLegacyMigration: true })).toEqual({ status: 'anonymous' });
  });
});

describe('account-partitioned vault', () => {
  const state = (hostDeviceId: string) => ({ pairings: [{ hostDeviceId }], active: hostDeviceId }) as never;

  it('keeps each account in its own IndexedDB bucket', async () => {
    Object.assign(window, { indexedDB: fakeIndexedDB() });
    const a = indexedDbVault('github:710003');
    const b = indexedDbVault('github:710004');
    await a.save(state('h_a'));
    expect((await a.load())?.pairings).toHaveLength(1);
    expect(await b.load()).toBeNull();
    await b.save(state('h_b'));
    expect((await a.load())?.pairings[0]).toMatchObject({ hostDeviceId: 'h_a' });
    expect((await b.load())?.pairings[0]).toMatchObject({ hostDeviceId: 'h_b' });
    await a.clear();
    expect(await a.load()).toBeNull();
    expect((await b.load())?.pairings[0]).toMatchObject({ hostDeviceId: 'h_b' });
  });

  it('moves the pre-account vault into the legacy account exactly once', async () => {
    Object.assign(window, { indexedDB: fakeIndexedDB({ 'vocs-code-remote': { vault: { state: state('h_old') } } }) });
    const legacy = indexedDbVault(LEGACY_ACCOUNT_ID, true);
    expect((await legacy.load())?.pairings[0]).toMatchObject({ hostDeviceId: 'h_old' });
    // Moved, not copied: a second read finds it under the account key.
    expect((await legacy.load())?.pairings[0]).toMatchObject({ hostDeviceId: 'h_old' });
  });

  it('never imports the pre-account vault for another account or an unauthenticated visitor', async () => {
    Object.assign(window, { indexedDB: fakeIndexedDB({ 'vocs-code-remote': { vault: { state: state('h_old') } } }) });
    expect(await indexedDbVault('github:710003', true).load()).toBeNull();
    expect(await indexedDbVault(LEGACY_ACCOUNT_ID, false).load()).toBeNull();
    const none = indexedDbVault(null);
    expect(await none.load()).toBeNull();
    await expect(none.save(state('h_x'))).rejects.toThrow('no account');
  });
});
