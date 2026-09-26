import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { ACCOUNT_ASSERTION_HEADER, createAccountAssertion, INTERNAL_ACCOUNT_AUTH_HEADER, INTERNAL_ACCOUNT_ID_HEADER, LEGACY_ACCOUNT_ID } from '../../relay/src/account';

/** A stand-in for the code.vocs.io landing Worker (vocs.io code/worker) in front of a local relay.
 *  It models the signed GitHub session, account assertion, owner credential injection, and the
 *  account gate on pairing claims/polls. The real OAuth, cookie signature and origin checks are
 *  tested in the vocs.io repo. */
export const TEST_SESSION_COOKIE = 'vocs_test_session=signed-in';
export const TEST_ACCOUNT_ASSERTION_SECRET = 'vocs-test-account-assertion-secret-32-bytes-minimum';

interface TestIdentity {
  login: string;
  accountId: string;
}

export interface TestLanding {
  origin: string;
  /** Owner requests forwarded, as `METHOD /path`, in order. */
  ownerCalls: string[];
  /** A separate cookie for simulating another signed-in GitHub subject at the same origin. */
  sessionFor(accountId: string, login?: string): string;
  stop(): Promise<void>;
}

export async function startTestLanding(
  relayOrigin: string,
  enrollToken: string,
  login = 'e2e-owner',
  accountId = LEGACY_ACCOUNT_ID,
  accountAssertionSecret = TEST_ACCOUNT_ASSERTION_SECRET
): Promise<TestLanding> {
  const target = new URL(relayOrigin);
  const ownerCalls: string[] = [];
  const sockets = new Set<net.Socket>();
  let landingOrigin = '';
  const identities = new Map<string, TestIdentity>([[TEST_SESSION_COOKIE, { login, accountId }]]);
  const sessionFor = (nextAccountId: string, nextLogin = 'e2e-user') => {
    const cookie = `vocs_test_session=${randomBytes(18).toString('base64url')}`;
    identities.set(cookie, { login: nextLogin, accountId: nextAccountId });
    return cookie;
  };
  const identityForCookie = (raw: string | undefined): TestIdentity | null => {
    for (const part of (raw ?? '').split(';').map((value) => value.trim())) {
      const identity = identities.get(part);
      if (identity) return identity;
    }
    return null;
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://landing');
      const pathname = url.pathname;
      const identity = identityForCookie(req.headers.cookie);
      const isOwner = pathname.startsWith('/v1/owner/');
      const isAccountRoute = pathname === '/v1/pair/claim' || pathname === '/v1/pair/poll';
      const browserDevice = (url.searchParams.get('device') ?? '').startsWith('w_');
      if (pathname === '/v1/me') {
        if (!identity) {
          res.writeHead(401, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
          res.end('Not authenticated');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ login: identity.login, accountId: identity.accountId }));
        return;
      }
      if ((isOwner || isAccountRoute || browserDevice || pathname === '/app' || pathname.startsWith('/app/')) && !identity) {
        res.writeHead(401, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('Not authenticated');
        return;
      }
      if (isOwner && req.method !== 'GET' && req.headers.origin !== 'https://code.vocs.io' && req.headers.origin !== landingOrigin) {
        res.writeHead(403, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('Forbidden');
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase();
        if (value === undefined || ['host', 'connection', 'content-length', ACCOUNT_ASSERTION_HEADER, INTERNAL_ACCOUNT_ID_HEADER, INTERNAL_ACCOUNT_AUTH_HEADER].includes(lower)) continue;
        if (lower === 'cookie') {
          const remaining = (Array.isArray(value) ? value.join('; ') : value).split(';').map((part) => part.trim())
            .filter((part) => !part.startsWith('vocs_test_session=') && !part.startsWith('__Host-vocs_oauth_nonce='));
          if (remaining.length) headers.set('cookie', remaining.join('; '));
          continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      if (isOwner) {
        ownerCalls.push(`${req.method} ${pathname}`);
        headers.set('authorization', `Bearer ${enrollToken}`);
      }
      if (identity && pathname.startsWith('/v1/')) {
        headers.set(ACCOUNT_ASSERTION_HEADER, await createAccountAssertion(identity.accountId, req.method ?? 'GET', pathname, accountAssertionSecret));
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const upstream = await fetch(`${relayOrigin}${pathname}${url.search}`, { method: req.method, headers, body, redirect: 'manual' });
      const out: Record<string, string> = {};
      // fetch has already decoded the body: its length and encoding no longer apply.
      upstream.headers.forEach((value, name) => {
        if (name !== 'content-encoding' && name !== 'content-length' && name !== 'transfer-encoding') out[name] = value;
      });
      res.writeHead(upstream.status, out);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://landing');
      const identity = identityForCookie(req.headers.cookie);
      if (url.pathname === '/v1/ws/client' && (url.searchParams.get('device') ?? '').startsWith('w_') && !identity) {
        socket.end('HTTP/1.1 401 Unauthorized\\r\\nconnection: close\\r\\ncontent-length: 0\\r\\n\\r\\n');
        return;
      }
      const headers: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i] ?? '';
        const lower = name.toLowerCase();
        const value = req.rawHeaders[i + 1] ?? '';
        if ([
          'host', 'x-vocs-account-assertion', INTERNAL_ACCOUNT_ID_HEADER, INTERNAL_ACCOUNT_AUTH_HEADER
        ].includes(lower)) continue;
        if (lower === 'cookie') {
          const remaining = value.split(';').map((part) => part.trim())
            .filter((part) => !part.startsWith('vocs_test_session=') && !part.startsWith('__Host-vocs_oauth_nonce='));
          if (remaining.length) headers.push(`cookie: ${remaining.join('; ')}`);
          continue;
        }
        headers.push(`${name}: ${value}`);
      }
      if (identity && url.pathname.startsWith('/v1/')) {
        headers.push(`${ACCOUNT_ASSERTION_HEADER}: ${await createAccountAssertion(identity.accountId, req.method ?? 'GET', url.pathname, accountAssertionSecret)}`);
      }
      const upstream = net.connect(Number(target.port), target.hostname, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`, `host: ${target.host}`, ...headers];
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      for (const s of [socket as net.Socket, upstream]) {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
      }
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  landingOrigin = `http://127.0.0.1:${port}`;
  return {
    origin: landingOrigin,
    ownerCalls,
    sessionFor,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
