/** Cleanup-only recovery for an approved pair whose browser response was lost. The claim
 *  capability comes from this run's claim response, and the credential it returns is sealed to
 *  the identity that claimed: neither the pairing code nor the capability alone is authority. */
import { openSealedToKey, pairingTokenContext, type AnyIdentity, type SealedToKey } from '../../src/shared/crypto';

export async function recoverApprovedClaim(
  origin: string,
  code: string,
  pollToken: string,
  identity: AnyIdentity,
  fetchImpl: typeof fetch = fetch
): Promise<{ webToken: string; webDeviceId: string; hostDeviceId: string } | null> {
  const response = await fetchImpl(`${origin}/v1/pair/poll?code=${encodeURIComponent(code)}`, {
    headers: { authorization: `Bearer ${pollToken}` }
  });
  if (!response.ok) return null;
  const poll = (await response.json()) as { status?: string; sealedToken?: SealedToKey; webDeviceId?: string; hostDeviceId?: string };
  if (poll.status !== 'approved' || !poll.sealedToken || !poll.webDeviceId || !poll.hostDeviceId) return null;
  const webToken = await openSealedToKey(identity.enc, poll.sealedToken, pairingTokenContext(code, poll.webDeviceId));
  return { webToken, webDeviceId: poll.webDeviceId, hostDeviceId: poll.hostDeviceId };
}
