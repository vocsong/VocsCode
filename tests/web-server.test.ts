/** Unit tests for the localhost web server: client-script injection, static serving, SPA
 *  fallback, Host guard, and the WebSocket transport (invoke round-trip, broadcast,
 *  token gate). Runs in plain Node — no Electron. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type WebSocket as WsClient } from 'ws';
import { WebServer, type WebServerOptions } from '../src/main/web-server';
import type { HandlerRegistry } from '../src/main/handlers';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function tmpDir(): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vocs-web-'));
  dirs.push(d);
  return d;
}

function stubRegistry(): HandlerRegistry {
  return {
    channels: () => ['sessions:list'],
    invoke: async (channel: string) => {
      if (channel === 'sessions:list') return [{ id: 's1' }];
      if (channel === 'boom') throw new Error('boom');
      throw new Error(`Unknown channel: ${channel}`);
    }
  };
}

function httpGet(port: number, reqPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path: reqPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, contentType: String(res.headers['content-type'] ?? '') }));
    });
    req.on('error', reject);
  });
}

function open(ws: WsClient): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function nextFrame(ws: WsClient): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(String(data)))));
}

function connectWs(port: number, token: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/harness?token=${encodeURIComponent(token)}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('web server', () => {
  let server: WebServer;
  let port = 0;
  let token = '';

  beforeAll(async () => {
    const staticDir = tmpDir();
    fsSync.writeFileSync(path.join(staticDir, 'index.html'), '<html><head><title>Vocs Code</title></head><body><div id="root"></div></body></html>', 'utf8');
    fsSync.mkdirSync(path.join(staticDir, 'assets'));
    fsSync.writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'console.log("app")', 'utf8');
    const opts: WebServerOptions = { registry: stubRegistry(), staticDir, port: 0, log: () => undefined };
    const server = new WebServer(opts);
    await server.start();
    const url = new URL(server.url());
    port = Number(url.port);
    token = url.searchParams.get('token') ?? '';
    (globalThis as { __webServer?: WebServer }).__webServer = server;
  });

  afterAll(async () => {
    await ((globalThis as { __webServer?: WebServer }).__webServer ?? null)?.stop();
  });

  it('serves the client script injected into index.html', async () => {
    const res = await httpGet(port, '/');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('<script src="/harness-client.js"></script>');
    const client = await httpGet(port, '/harness-client.js');
    expect(client.contentType).toContain('javascript');
    expect(client.body).toContain('window.harness');
  });

  it('serves static assets and falls back to the SPA for unknown routes', async () => {
    const asset = await httpGet(port, '/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.body).toBe('console.log("app")');
    const fallback = await httpGet(port, '/some/deep/route');
    expect(fallback.status).toBe(200);
    expect(fallback.body).toContain('id="root"');
  });

  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    const res = await httpGet(port, '/', { host: 'evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('round-trips invokes over the WebSocket and fans out pushes', async () => {
    const server = (globalThis as { __webServer?: WebServer }).__webServer!;
    const a = await connectWs(port, token);
    const b = await connectWs(port, token);
    a.send(JSON.stringify({ type: 'invoke', id: 1, channel: 'sessions:list', request: null }));
    const result = await nextFrame(a);
    expect(result).toMatchObject({ type: 'result', id: 1, ok: true });
    expect(result.value).toEqual([{ id: 's1' }]);

    server.broadcast('push:settingsChanged', { notifications: false });
    expect(await nextFrame(a)).toEqual({ type: 'push', channel: 'push:settingsChanged', payload: { notifications: false } });
    expect(await nextFrame(b)).toEqual({ type: 'push', channel: 'push:settingsChanged', payload: { notifications: false } });

    a.send(JSON.stringify({ type: 'invoke', id: 2, channel: 'nope:channel', request: null }));
    const failed = await nextFrame(a);
    expect(failed.ok).toBe(false);
    expect(String(failed.error)).toContain('Unknown channel');

    a.close();
    b.close();
  });

  it('rejects WebSocket connections without the token', async () => {
    await new Promise<void>((resolve) => {
      const bad = new WebSocket(`ws://127.0.0.1:${port}/harness?token=wrong`);
      bad.once('error', () => resolve());
      bad.once('close', () => resolve());
      expect(bad.readyState).not.toBe(WebSocket.OPEN);
    });
  });
});