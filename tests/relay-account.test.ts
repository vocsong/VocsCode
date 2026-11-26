import { describe, expect, it } from 'vitest';
import { accountIdFromDeviceId, ACCOUNT_ASSERTION_HEADER, createAccountAssertion, createDeviceId, LEGACY_ACCOUNT_ID, verifyAccountAssertion } from '../relay/src/account';

const SECRET = 'test-account-assertion-secret-with-32-bytes-min';
const DEVICE_SECRET = 'test-device-route-secret-with-32-bytes-minimum';
const NOW = 1_800_000_000_000;

const request = (path: string, method = 'GET', assertion?: string) => new Request(`https://relay.test${path}`, {
  method,
  headers: assertion ? { [ACCOUNT_ASSERTION_HEADER]: assertion } : undefined
});

describe('relay account routing assertions', () => {
  it('binds the signed account to method and pathname for a short lifetime', async () => {
    const assertion = await createAccountAssertion('github:12345', 'POST', '/v1/pair/claim', SECRET, NOW);
    expect(await verifyAccountAssertion(request('/v1/pair/claim', 'POST', assertion), SECRET, NOW + 1)).toBe('github:12345');
    expect(await verifyAccountAssertion(request('/v1/pair/claim', 'POST', assertion), SECRET, NOW + 60_000)).toBeNull();
    expect(await verifyAccountAssertion(request('/v1/pair/claim', 'GET', assertion), SECRET, NOW + 1)).toBeNull();
    expect(await verifyAccountAssertion(request('/v1/pair/poll', 'POST', assertion), SECRET, NOW + 1)).toBeNull();
    expect(await verifyAccountAssertion(request('/v1/pair/claim', 'POST', assertion), `${SECRET}!`, NOW + 1)).toBeNull();
  });

  it('accepts the self-service namespace only with valid account and device proofs', async () => {
    const id = `vocs:${'a'.repeat(42)}A`;
    const path = '/v1/owner/analytics';
    const assertion = await createAccountAssertion(id, 'GET', path, SECRET, NOW);
    expect(await verifyAccountAssertion(request(path, 'GET', assertion), SECRET, NOW + 1)).toBe(id);
    const other = `vocs:${'b'.repeat(42)}A`;
    expect(await verifyAccountAssertion(request(path, 'GET', assertion.replace(id, other)), SECRET, NOW + 1)).toBeNull();
    const deviceId = await createDeviceId('h', id, DEVICE_SECRET);
    expect(deviceId.length).toBeLessThanOrEqual(128);
    expect(await accountIdFromDeviceId(deviceId, DEVICE_SECRET)).toBe(id);
    for (const invalid of ['vocs:', 'vocs:owner', `vocs:${'A'.repeat(64)}`, `${id.slice(0, -1)}B`, `${id}.extra`]) {
      await expect(createAccountAssertion(invalid, 'GET', path, SECRET, NOW)).rejects.toThrow('invalid account assertion input');
    }
  });

  it('MAC-binds device routing hints to exactly one account and preserves legacy ids', async () => {
    const idA = await createDeviceId('h', 'github:12345', DEVICE_SECRET);
    const idB = await createDeviceId('w', 'github:67890', DEVICE_SECRET);
    expect(idA).toMatch(/^h_/);
    expect(await accountIdFromDeviceId(idA, DEVICE_SECRET)).toBe('github:12345');
    expect(await accountIdFromDeviceId(idB, DEVICE_SECRET)).toBe('github:67890');
    expect(await accountIdFromDeviceId(idA, `${DEVICE_SECRET}!`)).toBeNull();
    const [prefix, routeTag, random] = idA.split('.');
    const changedTag = `${routeTag![0] === 'A' ? 'B' : 'A'}${routeTag!.slice(1)}`;
    expect(await accountIdFromDeviceId(`${prefix}.${changedTag}.${random}`, DEVICE_SECRET)).toBeNull();
    expect(await accountIdFromDeviceId('h_abcdefghijk', DEVICE_SECRET)).toBe(LEGACY_ACCOUNT_ID);
    expect(await accountIdFromDeviceId('w_bad', DEVICE_SECRET)).toBeNull();
  });
});
