/** Test devices that authenticate to the relay the way real clients do (docs/REMOTE-ACCESS.md
 *  §6.2): a registered identity, its refresh credential, and an access token obtained by signing
 *  the relay's one-time challenge. Nothing here reaches around the proof of possession. */
import { issueAccessToken, issueChallenge, registerHostDevice, registerWebDevice, type RelayStore } from '../../relay/src/core';
import { generateIdentity, publicOf, sign, tokenProofPayload, type AnyIdentity, type Identity } from '../../src/shared/crypto';

export interface TestDevice {
  deviceId: string;
  /** The long-lived refresh credential. It must never authorize an API call by itself. */
  refresh: string;
  /** A short-lived access token, bought with the refresh credential plus a signed challenge. */
  access: string;
  identity: Identity;
}

export async function accessFor(store: RelayStore, device: { deviceId: string; refresh: string; identity: Identity }, options: { accountId?: string; now?: number } = {}): Promise<string> {
  const accountId = options.accountId ?? 'a';
  const now = options.now ?? Date.now();
  const { challenge } = await issueChallenge(store, { accountId, deviceId: device.deviceId, token: device.refresh }, now);
  const signature = await sign(device.identity, tokenProofPayload(device.deviceId, challenge));
  return (await issueAccessToken(store, { accountId, deviceId: device.deviceId, token: device.refresh, challenge, signature }, now)).accessToken;
}

/** The same proof of possession over HTTP, against a running relay (fake or real). */
export async function accessOverHttp(origin: string, device: { deviceId: string; refresh: string; identity: AnyIdentity }): Promise<string> {
  const query = `?device=${encodeURIComponent(device.deviceId)}`;
  const challengeRes = await fetch(`${origin}/v1/token/challenge${query}`, { method: 'POST', headers: { authorization: `Bearer ${device.refresh}` } });
  if (!challengeRes.ok) throw new Error(`token challenge failed: ${challengeRes.status}`);
  const { challenge } = (await challengeRes.json()) as { challenge: string };
  const tokenRes = await fetch(`${origin}/v1/token${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${device.refresh}`, 'content-type': 'application/json' },
    body: JSON.stringify({ challenge, signature: await sign(device.identity, tokenProofPayload(device.deviceId, challenge)) })
  });
  if (!tokenRes.ok) throw new Error(`token request failed: ${tokenRes.status}`);
  return ((await tokenRes.json()) as { accessToken: string }).accessToken;
}

export async function testDevice(
  store: RelayStore,
  kind: 'host' | 'web',
  options: { accountId?: string; name?: string; now?: number; identity?: Identity; hostDeviceId?: string } = {}
): Promise<TestDevice> {
  const accountId = options.accountId ?? 'a';
  const now = options.now ?? Date.now();
  const identity = options.identity ?? (await generateIdentity());
  const registered = kind === 'host'
    ? await registerHostDevice(store, { accountId, name: options.name ?? 'Work PC', platform: 'test', pub: publicOf(identity) }, now).then((r) => ({ deviceId: r.deviceId, refresh: r.hostToken }))
    : await registerWebDevice(store, { accountId, name: options.name ?? 'Chrome', platform: 'test', pub: publicOf(identity), hostDeviceId: options.hostDeviceId }, now).then((r) => ({ deviceId: r.deviceId, refresh: r.webToken }));
  const access = await accessFor(store, { ...registered, identity }, { accountId, now });
  return { ...registered, access, identity };
}
