/** A stand-in for the code.vocs.io landing Worker (vocs.io code/worker) in front of a local relay,
 *  for suites that drive the signed-in owner flow. A caller holding TEST_SESSION_COOKIE is a
 *  signed-in, allowlisted login: `/v1/me` names it, and `/v1/owner/*` is forwarded with the relay's
 *  enrollment secret in place of any Authorization it sent. Without the cookie both answer 401, as
 *  the real gate does for a desktop. Everything else passes through untouched, WebSocket upgrades
 *  included. The real Worker's session, OAuth and origin checks are tested in the vocs.io repo. */
import http from 'node:http';
import net from 'node:net';

/** Stands in for the landing's signed session cookie. */
export const TEST_SESSION_COOKIE = 'vocs_test_session=signed-in';

export interface TestLanding {
  origin: string;
  /** Owner requests forwarded, as `METHOD /path`, in order. */
  ownerCalls: string[];
  stop(): Promise<void>;
}

export async function startTestLanding(relayOrigin: string, enrollToken: string, login = 'e2e-owner'): Promise<TestLanding> {
  const target = new URL(relayOrigin);
  const ownerCalls: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://landing');
      const signedIn = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).includes(TEST_SESSION_COOKIE);
      if (url.pathname === '/v1/me' || (url.pathname.startsWith('/v1/owner/') && !signedIn)) {
        if (!signedIn || url.pathname !== '/v1/me') {
          res.writeHead(401, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
          res.end('Not authenticated');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ login }));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || name === 'host' || name === 'connection' || name === 'content-length') continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      if (url.pathname.startsWith('/v1/owner/')) {
        ownerCalls.push(`${req.method} ${url.pathname}`);
        headers.set('authorization', `Bearer ${enrollToken}`);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const upstream = await fetch(`${relayOrigin}${url.pathname}${url.search}`, { method: req.method, headers, body, redirect: 'manual' });
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
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, `host: ${target.host}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() !== 'host') lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
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
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    ownerCalls,
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
