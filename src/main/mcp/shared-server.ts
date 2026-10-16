/**
 * One `gitnexus serve` process for the whole app, serving MCP over Streamable HTTP at
 * `/api/mcp` from the *global* registry. Sessions do not talk to it directly — they get the
 * scope proxy, which pins each call to the session's repo. Started lazily on the first session
 * that needs it and stopped on quit. No Electron imports.
 */
import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import { killTree, spawnTool } from '../harness/spawn';
import { withProcessOwner } from '../process-context';

export interface SharedGitnexusOptions {
  /** `gitnexus`, or a resolved absolute path. */
  command: string;
  /** `['serve']`, or the npx fallback. */
  baseArgs: string[];
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  startupTimeoutMs?: number;
}

/** Picks a free loopback port, then releases it for the server to claim. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** POSTs a minimal MCP initialize until the endpoint answers. */
async function waitForMcp(url: string, timeoutMs: number): Promise<boolean> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'vocs-code', version: '1.0.0' }, capabilities: {} } });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body });
      if (res.ok || res.status < 500) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export class SharedGitnexusServer {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private starting: Promise<string | null> | null = null;
  private stopped = false;

  constructor(private readonly opts: SharedGitnexusOptions) {}

  /** The MCP endpoint, starting the server on first use. Null when it cannot start. */
  async ensure(): Promise<string | null> {
    if (this.stopped) return null;
    if (this.url) return this.url;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  /** Awaits the Windows tree kill, so no cmd.exe-wrapped `gitnexus serve` outlives the app. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.url = null;
    const child = this.child;
    this.child = null;
    if (child) await killTree(child);
  }

  private async start(): Promise<string | null> {
    let port: number;
    try {
      port = await freePort();
    } catch (e) {
      this.opts.log?.('warn', `gitnexus shared: no free port (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
    const args = [...this.opts.baseArgs, '--port', String(port), '--host', '127.0.0.1'];
    let child: ChildProcess;
    try {
      // `gitnexus` on PATH is an npm `.cmd` shim on Windows; a bare spawn of one throws EINVAL.
      // App-wide, even when a session's start is what first asks for it.
      child = withProcessOwner({ label: 'GitNexus server' }, () => spawnTool(this.opts.command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env }));
    } catch (e) {
      this.opts.log?.('warn', `gitnexus shared: could not start (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => this.opts.log?.('debug', `[gitnexus serve] ${String(d).trim()}`));
    child.stderr?.on('data', (d: Buffer) => this.opts.log?.('debug', `[gitnexus serve] ${String(d).trim()}`));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.url = null;
      if (!this.stopped) this.opts.log?.('warn', `gitnexus shared: server exited (${code})`);
    });
    child.on('error', (e) => this.opts.log?.('warn', `gitnexus shared: ${e.message}`));

    const url = `http://127.0.0.1:${port}/api/mcp`;
    const ready = await waitForMcp(url, this.opts.startupTimeoutMs ?? 45_000);
    if (!ready) {
      this.opts.log?.('warn', `gitnexus shared: did not become ready on ${url}`);
      await this.stopChild(child);
      return null;
    }
    if (this.stopped) {
      await this.stopChild(child);
      return null;
    }
    this.url = url;
    this.opts.log?.('info', `gitnexus shared: serving MCP at ${url}`);
    return url;
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (this.child === child) this.child = null;
    await killTree(child);
  }
}
