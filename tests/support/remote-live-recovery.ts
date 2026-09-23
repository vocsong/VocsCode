/** Cleanup-only recovery for an approved pair whose browser response was lost. The claim
 *  capability comes from this run's claim response; the pairing code alone is not authority. */
export async function recoverApprovedClaim(
  origin: string,
  code: string,
  pollToken: string
): Promise<{ webToken: string; webDeviceId: string; hostDeviceId: string } | null> {
  const response = await fetch(`${origin}/v1/pair/poll?code=${encodeURIComponent(code)}`, {
    headers: { authorization: `Bearer ${pollToken}` }
  });
  if (!response.ok) return null;
  const poll = (await response.json()) as { status?: string; webToken?: string; webDeviceId?: string; hostDeviceId?: string };
  if (poll.status !== 'approved' || !poll.webToken || !poll.webDeviceId || !poll.hostDeviceId) return null;
  return { webToken: poll.webToken, webDeviceId: poll.webDeviceId, hostDeviceId: poll.hostDeviceId };
}
