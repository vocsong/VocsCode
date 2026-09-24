import { expect, it } from 'vitest';
import { listDevices } from '../relay/src/core';
import { RemoteHost } from '../src/main/remote/host';
import { generateIdentity, publicOf } from '../src/shared/crypto';
import type { HandlerRegistry } from '../src/main/handlers';
import { ENROLL, FakeRelay } from './fake-relay';
import { accessOverHttp } from './support/relay-auth';
import { recoverApprovedClaim } from './support/remote-live-recovery';

it('recovers a lost approval poll only with the claimant capability and identity, and removes both minted devices', async () => {
  const relay = new FakeRelay();
  const port = await relay.start();
  const origin = `http://127.0.0.1:${port}`;
  const host = new RemoteHost({
    registry: () => ({ channels: () => [], invoke: async () => undefined } as unknown as HandlerRegistry),
    secrets: { get: async () => undefined, set: async () => undefined },
    pushState: () => undefined,
    log: () => undefined,
    broadcast: () => undefined
  });
  try {
    await host.enable(origin, ENROLL);
    const { code } = await host.startPairing('Recovery host');
    const identity = await generateIdentity();
    const claim = await fetch(`${origin}/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, webPub: publicOf(identity), name: 'Recovery browser' })
    });
    expect(claim.status).toBe(200);
    const { pollToken } = (await claim.json()) as { pollToken: string };
    for (let i = 0; i < 40 && !host.state().pendingRequest; i++) await new Promise((r) => setTimeout(r, 50));
    expect(host.state().pendingRequest?.code).toBe(code);
    await host.respondPairing('approve');

    // Simulate losing both the browser's first approved poll and the host result: use only
    // the privately captured claim capability and the claim identity, not saved credentials.
    expect((await fetch(`${origin}/v1/pair/poll?code=${code}`)).status).toBe(401);
    expect(await recoverApprovedClaim(origin, code, 'wrong-capability', identity)).toBeNull();
    await expect(recoverApprovedClaim(origin, code, pollToken, await generateIdentity())).rejects.toThrow();
    let recovered: Awaited<ReturnType<typeof recoverApprovedClaim>> = null;
    for (let i = 0; i < 40 && !recovered; i++) {
      recovered = await recoverApprovedClaim(origin, code, pollToken, identity);
      if (!recovered) await new Promise((r) => setTimeout(r, 50));
    }
    expect(recovered).not.toBeNull();
    expect((await listDevices(relay.store, 'a')).map((device) => device.deviceId).sort())
      .toEqual([recovered!.hostDeviceId, recovered!.webDeviceId].sort());

    // Revoking the minted desktop takes the browser paired through it along.
    const access = await accessOverHttp(origin, { deviceId: recovered!.webDeviceId, refresh: recovered!.webToken, identity });
    const res = await fetch(`${origin}/v1/devices?device=${recovered!.webDeviceId}&target=${recovered!.hostDeviceId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${access}` }
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revoked: string[] }).revoked.sort()).toEqual([recovered!.hostDeviceId, recovered!.webDeviceId].sort());
    expect(await listDevices(relay.store, 'a')).toHaveLength(0);
  } finally {
    await host.disable();
    await relay.stop();
  }
});
