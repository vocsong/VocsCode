/** Drives one pi coding-agent process over its JSON-RPC stdio protocol for Vesta.
 *
 *  Vesta's tools are app capabilities rather than file tools, so pi is started with a dedicated
 *  extension (resources/pi/vocs-code-vesta.ts) that forwards every tool call back here over the
 *  extension-UI channel — the same round trip the approvals extension uses. This class owns the
 *  child process, the turn lifecycle and the transcript callbacks; the allowlist and the
 *  approve-before-anything-changes gate stay with the caller (see ./index.ts). */
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImageAttachment, ModelRef } from '../../shared/types';
import { deferred, errorMessage, LineSplitter, withTimeout, type Deferred } from '../util/async';
import { shutdownChild, spawnTool } from '../harness/spawn';
import { withProcessOwner } from '../process-context';

/** Marker the bridge extension puts in the `select` title; the resource holds its own copy. */
const VESTA_CALL_MARKER = 'VCODE_VESTA_CALL::';
const VESTA_READY_MARKER = 'VCODE_VESTA_READY::';
const VESTA_ERROR_MARKER = 'VCODE_VESTA_ERROR::';

/** One capability call the model asked for. `id` is pi's tool-call id. */
export interface VestaToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** What the app did with a call, in the shape the model sees. */
export interface CapabilityOutcome {
  ok: boolean;
  detail: string;
}

export interface PiAgentEvents {
  /** A new assistant step began (a fresh text bubble). */
  stepStart(): void;
  /** Streaming text for the current step. */
  text(delta: string): void;
  /** The assistant step finished; `calls` are its tool calls in order. */
  stepEnd(text: string, calls: VestaToolCall[]): void;
  /** The whole turn settled: no retry, compaction or queued continuation is left. */
  settled(error: string | undefined): void;
  /** The pi process ended on its own (crash, kill) rather than through quit(). */
  exited(detail: string): void;
  /** The extension asked the app to run one capability; the result goes back to the model. */
  run(call: VestaToolCall): Promise<CapabilityOutcome>;
}

export interface PiAgentOptions {
  /** Resolved pi binary. */
  bin: string;
  /** The capability bridge extension (resources/pi/vocs-code-vesta.ts). */
  extension: string;
  /** Plain tool definitions written for the extension to register. */
  tools: { name: string; description: string; parameters: Record<string, unknown> }[];
  model?: ModelRef;
  cwd: string;
  /** Extra provider credentials pi should inherit (name -> value). */
  env: NodeJS.ProcessEnv;
  nonce: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  events: PiAgentEvents;
  /** Test seam: how the pi process is started (the offline integration test runs the CLI under node). */
  spawn?(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess;
}

/** What the orchestrator needs from a runtime, so tests can script one without a child process. */
export interface VestaRuntime {
  readonly model: string | undefined;
  readonly busy: boolean;
  /** True once the process died; the orchestrator replaces the runtime rather than reviving it. */
  readonly dead: boolean;
  prompt(message: string, systemPrompt: string, images?: ImageAttachment[]): Promise<void>;
  abort(): void;
  dispose(): Promise<void>;
}

interface AssistantMessage {
  role?: string;
  content?: { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[];
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface UiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
}

export class PiAgentRuntime implements VestaRuntime {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<string, Deferred<unknown>>();
  private nextId = 1;
  private ready: Deferred<void> | null = null;
  private extensionReady = false;
  private extensionFailure: string | null = null;
  private exited = false;
  private _busy = false;
  private _model?: string;
  private lastError: string | undefined;
  /** Whether the current prompt produced at least one assistant message. */
  private sawMessage = false;
  /** Open bridge requests, answered on abort so pi's tool calls do not hang. */
  private readonly openCalls = new Set<string>();
  private dir: string | null = null;
  private disposed = false;
  private closing = false;

  constructor(private readonly opts: PiAgentOptions) {}

  get model(): string | undefined {
    return this._model;
  }

  get busy(): boolean {
    return this._busy;
  }

  /** True once the process died; the caller replaces the runtime rather than reviving it. */
  get dead(): boolean {
    return this.exited;
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (!this.starting) this.starting = this.launch().finally(() => (this.starting = null));
    return this.starting;
  }

  /** Sends one user message; resolves when pi accepts it, not when the turn finishes. */
  async prompt(message: string, systemPrompt: string, images?: ImageAttachment[]): Promise<void> {
    await this.start();
    if (this.extensionFailure) throw new Error(this.extensionFailure);
    // The persona and the app context are rewritten every turn; the extension reads this file in
    // before_agent_start, so the context stays fresh without respawning pi.
    const promptFile = path.join(this.ensureDir(), 'system-prompt.txt');
    await fs.writeFile(promptFile, systemPrompt, 'utf8');
    this._busy = true;
    this.lastError = undefined;
    this.sawMessage = false;
    await this.request('prompt', { message, images: (images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType })) });
  }

  /** Cancels the running turn. The pending tool call is answered so pi can settle. */
  abort(): void {
    if (this._busy) this.lastError = 'Stopped.';
    this._busy = false;
    for (const id of [...this.openCalls]) this.respond(id, { cancelled: true });
    this.openCalls.clear();
    try {
      this.write({ type: 'abort' });
    } catch {
      /* the process is already gone; nothing to abort */
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.closing = true;
    this.exited = true;
    const child = this.child;
    this.child = null;
    for (const d of this.pending.values()) d.reject(new Error('pi process stopped'));
    this.pending.clear();
    this.openCalls.clear();
    if (child) await shutdownChild(child, 1500);
    if (this.dir) {
      const dir = this.dir;
      this.dir = null;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------- */

  private ensureDir(): string {
    if (!this.dir) this.dir = path.join(os.tmpdir(), `vocs-code-vesta-${process.pid}-${this.opts.nonce.slice(0, 8)}`);
    return this.dir;
  }

  private async launch(): Promise<void> {
    if (this.disposed) throw new Error('This Vesta runtime was disposed.');
    this.exited = false;
    this.extensionReady = false;
    this.extensionFailure = null;
    const dir = this.ensureDir();
    await fs.mkdir(dir, { recursive: true });
    const toolsFile = path.join(dir, 'tools.json');
    await fs.writeFile(toolsFile, JSON.stringify(this.opts.tools), 'utf8');
    const promptFile = path.join(dir, 'system-prompt.txt');
    if (!(await fs.stat(promptFile).catch(() => null))) await fs.writeFile(promptFile, '', 'utf8');

    const args = [
      '--mode', 'rpc',
      // Vesta is hermetic: no session file, no built-in tools, and none of the user's own
      // extensions, skills, prompt templates or context files — only its capability bridge.
      '--no-session',
      '--no-builtin-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-themes',
      '-e', this.opts.extension
    ];
    if (this.opts.model?.provider) args.push('--provider', this.opts.model.provider);
    if (this.opts.model?.model) args.push('--model', this.opts.model.model);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.opts.env,
      VOCS_CODE: '1',
      VOCS_CODE_PI_NONCE: this.opts.nonce,
      VOCS_CODE_VESTA_TOOLS: toolsFile,
      VOCS_CODE_VESTA_PROMPT: promptFile
    };
    this.opts.log('info', `spawning pi for Vesta: ${this.opts.bin} in ${this.opts.cwd}`);
    const child = withProcessOwner({ label: 'Vesta' }, () => (this.opts.spawn ?? spawnTool)(this.opts.bin, args, { cwd: this.opts.cwd, env }));
    this.child = child;
    const splitter = new LineSplitter((line) => this.handleLine(line));
    child.stdout?.on('data', (d: Buffer) => splitter.push(d));
    const err = new LineSplitter((line) => {
      const marker = line.indexOf(VESTA_ERROR_MARKER);
      if (marker >= 0) {
        this.extensionFailure = `The Vesta capability bridge failed to load. ${line.slice(marker + VESTA_ERROR_MARKER.length)}`;
        this.ready?.reject(new Error(this.extensionFailure));
        return;
      }
      this.opts.log('debug', `[vesta pi] ${line}`);
    });
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    child.on('close', (code) => {
      this.exited = true;
      this._busy = false;
      this.child = null;
      this.extensionReady = false;
      for (const d of this.pending.values()) d.reject(new Error(`pi exited (${code})`));
      this.pending.clear();
      this.openCalls.clear();
      if (!this.closing) this.opts.events.exited(`pi exited (${code})`);
    });
    child.on('error', (e) => {
      this.exited = true;
      this.child = null;
      this.extensionFailure = `pi failed to start: ${errorMessage(e)}`;
      this.ready?.reject(new Error(this.extensionFailure));
    });

    this.ready = deferred<void>();
    try {
      const state = await withTimeout(this.request<{ model?: { provider?: string; id?: string } }>('get_state'), 60_000, 'pi get_state');
      // pi handles get_state after session_start, so readiness is already on stdout by now.
      if (!this.extensionReady) await withTimeout(this.ready.promise, 30_000, 'pi Vesta extension');
      if (this.extensionFailure) throw new Error(this.extensionFailure);
      if (state.model?.id) this._model = state.model.provider ? `${state.model.provider}/${state.model.id}` : state.model.id;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  private write(cmd: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable || this.exited) throw new Error('pi process is not running');
    this.child.stdin.write(JSON.stringify(cmd) + '\n');
  }

  private request<T = unknown>(type: string, extra: Record<string, unknown> = {}): Promise<T> {
    const id = `r${this.nextId++}`;
    const d = deferred<unknown>();
    this.pending.set(id, d);
    try {
      this.write({ id, type, ...extra });
    } catch (e) {
      this.pending.delete(id);
      return Promise.reject(e);
    }
    return d.promise as Promise<T>;
  }

  private respond(id: string, payload: Record<string, unknown>): void {
    try {
      this.write({ type: 'extension_ui_response', id, ...payload });
    } catch {
      /* the process is gone */
    }
  }

  private handleLine(line: string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.opts.log('debug', `[vesta pi] ${line}`);
      return;
    }
    const type = ev.type as string;
    if (type === 'response') {
      const id = ev.id as string | undefined;
      const d = id ? this.pending.get(id) : undefined;
      if (d && id) {
        this.pending.delete(id);
        if (ev.success) d.resolve(ev.data);
        else d.reject(new Error(String(ev.error ?? `${ev.command} failed`)));
      }
      return;
    }
    switch (type) {
      case 'agent_start':
        this._busy = true;
        return;
      case 'agent_settled': {
        const error = this.lastError ?? (this.sawMessage ? undefined : 'The turn ended without a reply.');
        this._busy = false;
        this.opts.events.settled(error);
        return;
      }
      case 'message_start': {
        if ((ev.message as { role?: string } | undefined)?.role === 'assistant') this.opts.events.stepStart();
        return;
      }
      case 'message_end': {
        const msg = ev.message as AssistantMessage | undefined;
        if (msg?.role !== 'assistant') return;
        this.sawMessage = true;
        const blocks = msg.content ?? [];
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        const calls: VestaToolCall[] = blocks
          .filter((b) => b.type === 'toolCall')
          .map((b) => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), args: (b.arguments ?? {}) as Record<string, unknown> }));
        this.lastError =
          msg.stopReason === 'error' ? (msg.errorMessage ?? `${this._model ?? 'pi'} failed`) : msg.stopReason === 'aborted' ? 'Stopped.' : undefined;
        if (msg.model) this._model = msg.provider ? `${msg.provider}/${msg.model}` : msg.model;
        // The streamed deltas already rendered the text; `stepEnd` settles the bubble with the
        // provider's final copy so nothing is lost if a delta was dropped.
        this.opts.events.stepEnd(text, calls);
        return;
      }
      case 'extension_ui_request':
        void this.handleUiRequest(ev as unknown as UiRequest);
        return;
      case 'extension_error': {
        const detail = `${ev.extensionPath ?? 'extension'}: ${ev.error ?? 'failed'}`;
        this.extensionFailure = `The Vesta capability bridge failed to load. ${detail}`;
        this.ready?.reject(new Error(this.extensionFailure));
        this.opts.log('error', `[vesta pi] ${detail}`);
        return;
      }
      case 'auto_retry_start':
        this.opts.log('info', `Vesta retrying (${ev.attempt}/${ev.maxAttempts}): ${ev.errorMessage}`);
        return;
      case 'compaction_end':
        if (ev.errorMessage) this.opts.log('warn', `Vesta context compaction failed: ${ev.errorMessage}`);
        return;
      default:
        return;
    }
  }

  private async handleUiRequest(req: UiRequest): Promise<void> {
    if (req.method === 'notify') {
      if (req.message?.startsWith(VESTA_READY_MARKER)) {
        this.extensionReady = true;
        this.ready?.resolve();
      } else if (req.message?.startsWith(VESTA_ERROR_MARKER)) {
        this.extensionFailure = `The Vesta capability bridge failed to load. ${req.message.slice(VESTA_ERROR_MARKER.length)}`;
        this.ready?.reject(new Error(this.extensionFailure));
      }
      return;
    }
    if (req.method === 'select' && req.title?.startsWith(VESTA_CALL_MARKER)) {
      let call: VestaToolCall | null = null;
      try {
        const parsed = JSON.parse(req.title.slice(VESTA_CALL_MARKER.length)) as VestaToolCall;
        if (parsed && typeof parsed.name === 'string') call = { id: String(parsed.id ?? ''), name: parsed.name, args: (parsed.args ?? {}) as Record<string, unknown> };
      } catch {
        /* answered below as an unreadable call */
      }
      if (!call) {
        this.respond(req.id, { value: JSON.stringify({ ok: false, detail: 'The tool call was unreadable.' } satisfies CapabilityOutcome) });
        return;
      }
      this.openCalls.add(req.id);
      try {
        const outcome = await this.opts.events.run(call);
        this.respond(req.id, { value: JSON.stringify(outcome) });
      } catch (e) {
        this.respond(req.id, { value: JSON.stringify({ ok: false, detail: errorMessage(e) } satisfies CapabilityOutcome) });
      } finally {
        this.openCalls.delete(req.id);
      }
      return;
    }
    // Vesta's tools are the only ones pi can call, so any other dialog is stray; answer it so pi
    // never blocks, without granting anything.
    if (req.method === 'select' || req.method === 'input' || req.method === 'editor' || req.method === 'custom') this.respond(req.id, { cancelled: true });
    else if (req.method === 'confirm') this.respond(req.id, { confirmed: false });
  }
}
