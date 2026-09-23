/** Opt-in deployed-relay smoke. No fake relay: this catches Durable Object WebSocket routing
 *  failures that the in-memory fake cannot model. Never put tokens or key material in output.
 *
 *  REMOTE_LIVE=1 REMOTE_LIVE_ORIGIN=https://your-origin.example  *    REMOTE_LIVE_TOKEN_FILE=/absolute/path/to/enroll-token npm run test:remote-live
 *
 *  Uses a fresh in-memory host and browser identity. The token file is read, never written. The same
 *  flow runs against the real Worker in local workerd on every `npm test` (remote-workerd.test.ts).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { it } from 'vitest';
import { remoteSmoke } from './support/remote-smoke';

function originFromEnv(): string {
  if (process.env.REMOTE_LIVE !== '1') throw new Error('Set REMOTE_LIVE=1 to authorize the remote live smoke.');
  const raw = process.env.REMOTE_LIVE_ORIGIN;
  if (!raw) throw new Error('REMOTE_LIVE_ORIGIN is required for the remote live smoke.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('REMOTE_LIVE_ORIGIN must be an HTTP(S) origin.');
  }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('REMOTE_LIVE_ORIGIN must be a bare HTTPS origin (HTTP only for loopback).');
  }
  return url.origin;
}

async function tokenFromEnv(): Promise<string> {
  const file = process.env.REMOTE_LIVE_TOKEN_FILE;
  if (!file || !path.isAbsolute(file)) throw new Error('REMOTE_LIVE_TOKEN_FILE must be an absolute path to the enrollment token file.');
  let token: string;
  try {
    token = (await readFile(file, 'utf8')).trim();
  } catch {
    throw new Error('REMOTE_LIVE_TOKEN_FILE could not be read.');
  }
  if (!token) throw new Error('REMOTE_LIVE_TOKEN_FILE is empty.');
  return token;
}

it.skipIf(process.env.REMOTE_LIVE !== '1')('mints, claims, approves, handshakes, invokes, shares the mirror key and revokes through the deployed relay', async () => {
  // Validate both opt-in and credentials before any network request or socket exists.
  const origin = originFromEnv();
  const enrollToken = await tokenFromEnv();
  await remoteSmoke({ origin, enrollToken });
}, 240_000);
