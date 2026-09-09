import type { ChildProcess } from 'node:child_process';
import { LineSplitter, deferred, type Deferred } from '../util/async';

/**
 * Minimal newline-delimited JSON-RPC client used for the Codex app-server.
 * Codex omits the "jsonrpc" version field, so this client tolerates its absence.
 */
export type RpcId = number | string;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcRemoteError extends Error {
  constructor(
    public readonly rpc: RpcError,
    method: string
  ) {
    super(`${method} failed: ${rpc.message} (code ${rpc.code})`);
  }
}

type NotificationHandler = (params: unknown, method: string) => void;
type ServerRequestHandler = (params: unknown, method: string) => Promise<unknown>;

export class JsonRpcStdioClient {
  private nextId = 1;
  private pending = new Map<RpcId, { d: Deferred<unknown>; method: string }>();
  private notificationHandlers = new Map<string, NotificationHandler[]>();
  private wildcard: NotificationHandler[] = [];
  private serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private closed = false;
  private readonly splitter: LineSplitter;
  onClose: ((code: number | null) => void) | null = null;
  onStderr: ((line: string) => void) | null = null;

  constructor(
    private readonly child: ChildProcess,
    private readonly includeJsonRpcField = false
  ) {
    this.splitter = new LineSplitter((line) => this.handleLine(line));
    child.stdout?.on('data', (d: Buffer) => this.splitter.push(d));
    const errSplitter = new LineSplitter((line) => this.onStderr?.(line));
    child.stderr?.on('data', (d: Buffer) => errSplitter.push(d));
    child.on('close', (code) => {
      this.closed = true;
      for (const [, p] of this.pending) p.d.reject(new Error(`process exited (code ${code}) before ${p.method} completed`));
      this.pending.clear();
      this.onClose?.(code);
    });
    child.on('error', (e) => {
      for (const [, p] of this.pending) p.d.reject(e);
      this.pending.clear();
    });
  }

  private write(msg: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin?.writable) throw new Error('RPC transport is closed');
    const payload = this.includeJsonRpcField ? { jsonrpc: '2.0', ...msg } : msg;
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const d = deferred<unknown>();
    this.pending.set(id, { d, method });
    try {
      this.write({ id, method, params: params ?? {} });
    } catch (e) {
      this.pending.delete(id);
      return Promise.reject(e);
    }
    return d.promise as Promise<T>;
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params: params ?? {} });
  }

  onNotification(method: string, handler: NotificationHandler): void {
    const list = this.notificationHandlers.get(method) ?? [];
    list.push(handler);
    this.notificationHandlers.set(method, list);
  }

  onAnyNotification(handler: NotificationHandler): void {
    this.wildcard.push(handler);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.onStderr?.(`[non-json stdout] ${line}`);
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    if (hasId && !method) {
      const p = this.pending.get(msg.id as RpcId);
      if (!p) return;
      this.pending.delete(msg.id as RpcId);
      if (msg.error) p.d.reject(new RpcRemoteError(msg.error as RpcError, p.method));
      else p.d.resolve(msg.result);
      return;
    }
    if (hasId && method) {
      const handler = this.serverRequestHandlers.get(method);
      if (!handler) {
        this.write({ id: msg.id as RpcId, error: { code: -32601, message: `Unsupported server request: ${method}` } });
        return;
      }
      handler(msg.params, method)
        .then((result) => this.write({ id: msg.id as RpcId, result: result ?? {} }))
        .catch((e: unknown) => {
          try {
            this.write({ id: msg.id as RpcId, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
          } catch {
            /* transport closed */
          }
        });
      return;
    }
    if (method) {
      for (const h of this.notificationHandlers.get(method) ?? []) h(msg.params, method);
      for (const h of this.wildcard) h(msg.params, method);
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        if (this.child.exitCode === null) this.child.kill();
      } catch {
        /* ignore */
      }
    }, 1500);
  }
}
