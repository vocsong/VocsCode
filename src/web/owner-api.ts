/**
 * The signed-in owner's calls (docs/WEB-DASHBOARD.md §4). The landing Worker gates every
 * `/v1/owner/*` request on the Vocs session cookie and adds the owner credential, so the page holds
 * no secret of its own: same-origin fetches with the cookie are the whole client.
 */
import type { AnalyticsHost, AnalyticsPartBody } from '@shared/analytics/snapshot-wire';

export class OwnerApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function ownerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const detail = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new OwnerApiError(response.status === 401 ? 'You are signed out. Sign in again to continue.' : detail, response.status);
  }
  return response;
}

/** Every computer on the account, with its committed analytics manifest (null before it shares). */
export async function analyticsOverview(): Promise<AnalyticsHost[]> {
  const body = (await (await ownerFetch('/v1/owner/analytics')).json()) as { hosts?: unknown };
  if (!Array.isArray(body.hosts)) throw new OwnerApiError('the relay returned no computer list', 502);
  return body.hosts.filter((h): h is AnalyticsHost => !!h && typeof h === 'object' && typeof (h as AnalyticsHost).hostId === 'string' && typeof (h as AnalyticsHost).name === 'string');
}

/** One committed part. Content-addressed by hash, so the browser may serve it from its cache. */
export async function analyticsPart(hostId: string, partId: string): Promise<AnalyticsPartBody> {
  const query = `host=${encodeURIComponent(hostId)}&id=${encodeURIComponent(partId)}`;
  const response = await fetch(`/v1/owner/analytics/part?${query}`, { credentials: 'same-origin' });
  if (!response.ok) throw new OwnerApiError(`part ${partId} unavailable (HTTP ${response.status})`, response.status);
  return (await response.json()) as AnalyticsPartBody;
}

/** Connect with Vocs: add the computer that opened this page, known only by its connect hash. */
export async function addComputer(nonceHash: string): Promise<void> {
  await ownerFetch('/v1/owner/enroll-grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonceHash }) });
}

/** Whether that computer has collected its credential yet. */
export async function addedComputer(nonceHash: string): Promise<{ status: 'missing' | 'granted' | 'redeemed'; hostDeviceId?: string }> {
  return (await (await ownerFetch(`/v1/owner/enroll-grant?h=${encodeURIComponent(nonceHash)}`)).json()) as { status: 'missing' | 'granted' | 'redeemed'; hostDeviceId?: string };
}
