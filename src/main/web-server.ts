/** Localhost web server: serves the built renderer over HTTP and bridges the handler
 *  registry to browser clients over WebSocket (docs/REMOTE-ACCESS.md P1 dogfood).
 *  Dev-gated by VOCS_CODE_WEB=1; localhost-only — a per-boot token authorizes the
 *  WebSocket and a Host check blocks DNS rebinding. Electron-free: tested in plain Node. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HandlerRegistry } from './handlers';
import { HARNESS_CLIENT_JS } from './web-client';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.ico': 'image/x-icon'
};

export interface WebServerOptions {
  registry: HandlerRegistry;
  staticDir: string;
  port: number;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

type InvokeFrame = { type: 'invoke'; id: number; channel: string; request: unknown };

export class WebServer {
  private readonly opts: WebServerOptions;
  private server: Server | null = null;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Set<WebSocket>();
  private token = '';
  private indexHtml = '';
  private port = 0;

  constructor(opts: WebServerOptions) {
    this.opts = opts;
  }

  /** http://localhost:<port>/?token=… — the token authorizes the WebSocket. */
  url(): string {
    return `http://localhost:${this.port}/?token=${this.token}`;
  }

  async start(): Promise<void> {
    this.token = randomBytes(24).toString('base64url');
    this.indexHtml = await this.loadIndexHtml();
    const server = createServer((req, res) => void this.serve(req, res));
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    this.opts.log('info', `web client ready: ${this.url()}`);
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.close();
    this.sockets.clear();
    this.wss.close();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Fan-out an async event to every connected browser client. */
  broadcast(channel: string, payload: unknown): void {
    const frame = JSON.stringify({ type: 'push', channel, payload });
    for (const ws of this.sockets) {
      if (ws.readyState === 1) ws.send(frame);
    }
  }

  private async loadIndexHtml(): Promise<string> {
    let html: string;
    try {
      html = await fs.readFile(path.join(this.opts.staticDir, 'index.html'), 'utf8');
    } catch {
      return '';
    }
    if (html.includes('/harness-client.js')) return html;
    return html.replace('<head>', '<head><script src="/harness-client.js"></script>');
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only the loopback host: a rebound DNS name must not reach the API.
    const hostname = this.hostnameOf(req.headers.host ?? '');
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (urlPath === '/harness-client.js') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      res.end(HARNESS_CLIENT_JS);
      return;
    }
    const root = path.resolve(this.opts.staticDir);
    const target = path.normalize(path.join(root, urlPath));
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const stat = await fs.stat(target);
      if (stat.isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream' });
        res.end(await fs.readFile(target));
        return;
      }
    } catch {
      /* fall through to the SPA fallback */
    }
    // SPA fallback: unknown paths render the app.
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(this.indexHtml);
  }

  private upgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/harness' || url.searchParams.get('token') !== this.token) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connected(ws));
  }

  private connected(ws: WebSocket): void {
    this.sockets.add(ws);
    this.opts.log('info', `web client connected (${this.sockets.size} connected)`);
    ws.on('message', (data) => {
      let frame: InvokeFrame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!frame || frame.type !== 'invoke' || typeof frame.channel !== 'string' || typeof frame.id !== 'number') return;
      void this.opts.registry
        .invoke(frame.channel, frame.request)
        .then(
          (value) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value }));
          },
          (e: unknown) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: false, error: e instanceof Error ? e.message : String(e) }));
          }
        );
    });
    ws.on('close', () => {
      this.sockets.delete(ws);
      this.opts.log('info', `web client disconnected (${this.sockets.size} connected)`);
    });
    ws.on('error', () => this.sockets.delete(ws));
  }

  private hostnameOf(host: string): string {
    if (!host) return '';
    if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
    return host.split(':')[0].toLowerCase();
  }
}