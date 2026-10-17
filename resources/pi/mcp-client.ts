/**
 * A dependency-free MCP (Model Context Protocol) client for the pi bridge extension.
 *
 * Only `node:` builtins and the global `fetch` are used, so the file loads under jiti (pi)
 * and vitest without reaching into the app's node_modules. Transports: `stdio` (newline
 * delimited JSON-RPC 2.0 over a child process) and `http` (JSON-RPC over POST, including an
 * SSE-framed response body). `sse` is not supported and throws from `connect`.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface PiMcpServerConfig {
  id: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface PiMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  readOnly?: boolean;
}

/** Pi's model-facing tool result content: text or base64 image blocks. */
export interface PiMcpCallResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string; text?: never })[];
  isError?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'vocs-code-pi', version: '1.0.0' };
const STDERR_TAIL = 2000;

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface Pending {
  method: string;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type MessageHandler = (message: unknown) => void;

interface PiTransport {
  send(message: JsonRpcMessage): void;
  close(): void;
  diagnostics(): string;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorText(error));
}

/** Newline-delimited JSON-RPC 2.0 over a child process's stdin/stdout. */
class StdioTransport implements PiTransport {
  private readonly child: ChildProcess;
  private buffer = '';
  private stderrTail = '';
  private exited = false;
  private closed = false;

  constructor(
    private readonly cfg: PiMcpServerConfig,
    private readonly onMessage: MessageHandler,
    private readonly onExit: (error: Error) => void
  ) {
    if (!cfg.command) throw new Error(`MCP server "${cfg.id}" has no command`);
    this.child = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.push(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
    });
    this.child.on('error', (error) => this.exit(`MCP server "${cfg.id}" failed to start: ${errorText(error)}`));
    this.child.on('exit', (code, signal) => {
      this.exit(`MCP server "${cfg.id}" exited with ${signal ? `signal ${signal}` : `code ${code ?? 'null'}`}`);
    });
  }

  send(message: JsonRpcMessage): void {
    if (this.exited || this.closed) throw new Error(`MCP stdio transport for "${this.cfg.id}" is closed`);
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw new Error(`MCP stdio transport for "${this.cfg.id}" has no stdin`);
    stdin.write(JSON.stringify(message) + '\n');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.kill();
    } catch {
      /* the child is already gone */
    }
  }

  diagnostics(): string {
    return this.stderrTail.trim();
  }

  private push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // servers are allowed to log non-JSON noise on stdout
      }
      this.onMessage(parsed);
    }
  }

  private exit(message: string): void {
    if (this.exited) return;
    this.exited = true;
    const stderr = this.stderrTail.trim();
    this.onExit(new Error(stderr ? `${message}: ${stderr}` : message));
  }
}

/** JSON-RPC 2.0 over HTTP POST, accepting a plain JSON or SSE-framed response. */
class HttpTransport implements PiTransport {
  private closed = false;

  constructor(
    private readonly cfg: PiMcpServerConfig,
    private readonly onMessage: MessageHandler,
    private readonly onFailure: (id: number | undefined, error: Error) => void
  ) {}

  send(message: JsonRpcMessage): void {
    const id = typeof message.id === 'number' ? message.id : undefined;
    // post() is async by construction, so the catch is the only place a rejection can land.
    void this.post(message).catch((error) => this.onFailure(id, asError(error)));
  }

  close(): void {
    this.closed = true;
  }

  diagnostics(): string {
    return '';
  }

  private async post(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error(`MCP http transport for "${this.cfg.id}" is closed`);
    if (!this.cfg.url) throw new Error(`MCP server "${this.cfg.id}" has no url`);
    const response = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.cfg.headers ?? {})
      },
      body: JSON.stringify(message)
    });
    if (!response.ok) throw new Error(`MCP server "${this.cfg.id}" returned HTTP ${response.status}`);
    const body = await response.text();
    if (!body.trim()) return;
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
      for (const line of body.split(/\r?\n/)) {
        const match = /^data:\s?(.*)$/.exec(line);
        const data = match?.[1]?.trim();
        if (!data || data === '[DONE]') continue;
        try {
          this.onMessage(JSON.parse(data));
        } catch {
          /* ignore SSE frames that are not JSON-RPC */
        }
      }
      return;
    }
    try {
      this.onMessage(JSON.parse(body));
    } catch {
      throw new Error(`MCP server "${this.cfg.id}" returned a non-JSON response`);
    }
  }
}

export class PiMcpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private disposed = false;
  private tools: PiMcpTool[] | null = null;

  private constructor(
    private readonly cfg: PiMcpServerConfig,
    private readonly transport: PiTransport
  ) {}

  static async connect(cfg: PiMcpServerConfig): Promise<PiMcpConnection> {
    if (cfg.transport === 'sse') {
      throw new Error(`MCP server "${cfg.id}" uses the sse transport, which the pi MCP bridge does not support; use stdio or http.`);
    }
    if (cfg.transport === 'stdio' && !cfg.command) throw new Error(`MCP server "${cfg.id}" has no command`);
    if (cfg.transport === 'http' && !cfg.url) throw new Error(`MCP server "${cfg.id}" has no url`);

    let connection: PiMcpConnection | undefined;
    try {
      const onMessage: MessageHandler = (message) => connection?.handleMessage(message);
      const transport: PiTransport =
        cfg.transport === 'stdio'
          ? new StdioTransport(cfg, onMessage, (error) => connection?.failAll(error))
          : new HttpTransport(cfg, onMessage, (id, error) => connection?.failRequest(id, error));
      connection = new PiMcpConnection(cfg, transport);
      await connection.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientInfo: CLIENT_INFO, capabilities: {} });
      connection.notify('notifications/initialized');
      await connection.listTools();
      return connection;
    } catch (error) {
      connection?.close();
      throw asError(error);
    }
  }

  async listTools(): Promise<PiMcpTool[]> {
    if (this.tools) return this.tools.map((tool) => ({ ...tool }));
    const result = (await this.request('tools/list', {})) as { tools?: unknown } | undefined;
    const raw = Array.isArray(result?.tools) ? result.tools : [];
    this.tools = raw.flatMap((entry): PiMcpTool[] => {
      if (!entry || typeof entry !== 'object') return [];
      const tool = entry as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
      if (typeof tool.name !== 'string' || !tool.name) return [];
      return [
        {
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : undefined,
          inputSchema: tool.inputSchema,
          readOnly: tool.annotations?.readOnlyHint === true
        }
      ];
    });
    return this.tools.map((tool) => ({ ...tool }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<PiMcpCallResult> {
    const result = (await this.request('tools/call', { name, arguments: args ?? {} })) as { content?: unknown; isError?: unknown } | undefined;
    const raw = Array.isArray(result?.content) ? result.content : [];
    const content = raw.map((entry): PiMcpCallResult['content'][number] => {
      const source = `MCP tool "${name}" from "${this.cfg.id}"`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${source} returned an invalid content block`);
      const item = entry as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
      if (item.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text };
      if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
        return { type: 'image', data: item.data, mimeType: item.mimeType };
      }
      if (item.type === 'text' || item.type === 'image') throw new Error(`${source} returned a malformed ${item.type} content block`);
      throw new Error(`${source} returned unsupported content type "${String(item.type)}"; the pi MCP bridge supports only text and image blocks`);
    });
    return { content, isError: !!result?.isError };
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP connection to "${this.cfg.id}" closed`));
    }
    this.pending.clear();
    try {
      this.transport.close();
    } catch {
      /* a transport that is already gone is fine */
    }
  }

  private notify(method: string): void {
    try {
      this.transport.send({ jsonrpc: '2.0', method });
    } catch {
      /* notifications are best-effort */
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed || this.disposed) return Promise.reject(new Error(`MCP connection to "${this.cfg.id}" is closed`));
    const id = this.nextId++;
    const timeoutMs = typeof this.cfg.timeoutMs === 'number' && this.cfg.timeoutMs > 0 ? this.cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" to "${this.cfg.id}" timed out after ${timeoutMs}ms${this.diagnostics()}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { method, timer, resolve, reject });
      try {
        this.transport.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
    // Every caller still sees the rejection, but a rejection nobody awaits must not crash the host.
    promise.catch(() => {});
    return promise;
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const response = message as { id?: unknown; result?: unknown; error?: { message?: string } };
    if (response.id === undefined || response.id === null) return;
    const id = typeof response.id === 'number' ? response.id : Number(response.id);
    if (!Number.isFinite(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (response.error) {
      const detail = response.error.message ?? errorText(response.error);
      pending.reject(new Error(`MCP request "${pending.method}" to "${this.cfg.id}" failed: ${detail}`));
      return;
    }
    pending.resolve(response.result);
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private failRequest(id: number | undefined, error: Error): void {
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private diagnostics(): string {
    const stderr = this.transport.diagnostics().trim();
    return stderr ? ` (server stderr: ${stderr})` : '';
  }
}
