import { DEFAULT_REMOTE_ORIGIN } from '../../shared/pairing';

/** The relay this desktop connects to: code.vocs.io, which serves the web client, the API and the
 *  sockets on one origin, so there is no setting for it. VOCS_CODE_RELAY_URL points a development
 *  build or a test at another relay (a local `wrangler dev`, the test relay). */
export function relayUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.VOCS_CODE_RELAY_URL?.trim().replace(/\/+$/, '') || DEFAULT_REMOTE_ORIGIN;
}
