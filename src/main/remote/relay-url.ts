import { DEFAULT_REMOTE_ORIGIN } from '../../shared/pairing';

/** The relay this desktop connects to: code.vocs.io, which serves the web client, the API and the
 *  sockets on one origin, so there is no setting for it. VOCS_CODE_RELAY_URL points a development
 *  build or a test at another relay (a local `wrangler dev`, the test relay). */
export function relayUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.VOCS_CODE_RELAY_URL?.trim().replace(/\/+$/, '') || DEFAULT_REMOTE_ORIGIN;
}

const PROBE_TTL_MS = 60_000;
const probes = new Map<string, { at: number; value: boolean; pending?: Promise<void> }>();

/** Whether the relay's origin offers Connect with GitHub. The landing's login gate answers
 *  `/v1/me` with 401 for a signed-out caller; while the gate is off it answers 503, and a bare
 *  relay (a local `wrangler dev`, the test relay) has no such route. Never blocks: it returns the
 *  last answer (false until the first probe lands) and refreshes it in the background at most
 *  once a minute, since the Settings panel asks every few seconds. */
export function signInAvailable(relay: string, fetchImpl: typeof fetch = fetch): boolean {
  const entry = probes.get(relay);
  if (!entry?.pending && (!entry || Date.now() - entry.at > PROBE_TTL_MS)) {
    const next = { at: entry?.at ?? 0, value: entry?.value ?? false } as { at: number; value: boolean; pending?: Promise<void> };
    next.pending = fetchImpl(`${relay}/v1/me`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      .then((res) => res.status === 401, () => false)
      .then((value) => {
        probes.set(relay, { at: Date.now(), value });
      });
    probes.set(relay, next);
  }
  return entry?.value ?? false;
}

/** The probe in flight for `relay`, for callers (tests) that need its answer now. */
export function signInProbe(relay: string): Promise<void> {
  return probes.get(relay)?.pending ?? Promise.resolve();
}
