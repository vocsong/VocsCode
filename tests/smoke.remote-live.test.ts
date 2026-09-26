/** Opt-in deployed-relay smoke. No fake relay: this catches Durable Object WebSocket routing
 *  failures that the in-memory fake cannot model. Never put tokens or key material in output.
 *
 *  REMOTE_LIVE=1 REMOTE_LIVE_ORIGIN=https://code.vocs.io \
 *    REMOTE_LIVE_TOKEN_FILE=/absolute/path/to/enroll-token \
 *    REMOTE_LIVE_SESSION_COOKIE_FILE=/absolute/path/to/session-cookie npm run test:remote-live
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

async function sessionCookieFromEnv(): Promise<string> {
  const file = process.env.REMOTE_LIVE_SESSION_COOKIE_FILE;
  if (!file || !path.isAbsolute(file)) throw new Error('REMOTE_LIVE_SESSION_COOKIE_FILE must be an absolute path to a signed-in session cookie file.');
  let cookie: string;
  try {
    cookie = (await readFile(file, 'utf8')).trim();
  } catch {
    throw new Error('REMOTE_LIVE_SESSION_COOKIE_FILE could not be read.');
  }
  if (!/^__Host-vocs_session=[A-Za-z0-9_.-]+$/.test(cookie)) throw new Error('REMOTE_LIVE_SESSION_COOKIE_FILE does not contain one valid session cookie.');
  return cookie;
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
  const sessionCookie = await sessionCookieFromEnv();
  // The live smoke pairs through the incumbent account, preserving its existing devices and
  // proving that the signed-in landing session is mapped to that same Hub.
  const me = await fetch(`${origin}/v1/me`, { headers: { cookie: sessionCookie }, signal: AbortSignal.timeout(8_000) });
  if (!me.ok) throw new Error('REMOTE_LIVE_SESSION_COOKIE_FILE is not a valid signed-in session.');
  const identity = await me.json() as { accountId?: unknown };
  if (identity.accountId !== 'vocs-v1') throw new Error('The live smoke session must belong to the incumbent v1 account.');
  await remoteSmoke({ origin, enrollToken, sessionCookie, accountId: 'vocs-v1' });
}, 240_000);
