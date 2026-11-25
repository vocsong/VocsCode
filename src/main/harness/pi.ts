import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { parseQuestionPayload, QUESTION_MARKER, QUESTION_RESPONSE_LIMIT, QUESTION_TOOL } from '../../../resources/pi/question-tool';
import { PI_FAST_MODE_COMMAND, PI_FAST_MODE_MARKER } from '../../../resources/pi/vocs-code-fast-mode';
import { isEffortLevel } from '../../shared/harness-meta';
import { questionResponse } from '../../shared/question-response';
import type { EffortLevel, FileChange, ModelInfo, ModelRef, PermissionMode, TranscriptItem, UserInput } from '../../shared/types';
import { mergePiCatalog } from '../models/pi-catalog';
import { LineSplitter, deferred, errorMessage, shortId, truncate, withTimeout, type Deferred } from '../util/async';
import { reportHarnessCommands } from './commands';
import { OPTIONS_ALLOW_DENY } from './permissions';
import { checkMissingPiSessionDir, preparePiLaunch, writePiEffortConfig, writePiPermissionMode } from './pi-launch';
import { listPiModels, PI_ENV_KEYS, piHarnessCommands, piModelToInfo, piThinkingLevel, type PiModel } from './pi-models';
import { PI_SUBAGENT_MARKER, PiSubagentTracker, SUBAGENT_TOOLS } from './pi-subagents';
import { PiUsageAndFastMode } from './pi-usage';
import { shutdownChild, spawnTool } from './spawn';
import type { HarnessAdapter, HarnessContext } from './types';

export { listPiModels, PI_ENV_KEYS, piHarnessCommands, piModelToInfo };

export const PI_APPROVAL_MARKER = 'VCODE_APPROVAL::';
const PI_BLOCK_MARKER = 'VCODE_TOOL_BLOCKED::';
const PI_READY_MARKER = 'VCODE_PI_READY::';
const PI_EXTENSION_ERROR_MARKER = 'VCODE_PI_ERROR::';
const PI_TOOL_INPUT_MARKER = 'VCODE_PI_TOOL_INPUT::';

function toolPath(input: Record<string, unknown> | undefined): string | undefined {
  return typeof input?.path === 'string' ? input.path : typeof input?.file_path === 'string' ? input.file_path : undefined;
}

export class PiAdapter implements HarnessAdapter {
  readonly id = 'pi' as const;
  private child: ChildProcess | null = null;
  private pending = new Map<string, Deferred<unknown>>();
  private _busy = false;
  private currentAssistant: Extract<TranscriptItem, { kind: 'assistant' }> | null = null;
  private toolItems = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  private declinedTools = new Set<string>();
  private turnStartedAt = 0;
  private readonly usage: PiUsageAndFastMode;
  private readonly subagents: PiSubagentTracker;
  /** stopReason/errorMessage of the last assistant message — pi reports turn failures here, not as events. */
  private lastStopReason: string | null = null;
  private lastErrorMessage: string | null = null;
  private models: ModelInfo[] = [];
  private nextId = 1;
  private exited = false;
  private transportError: Error | null = null;
  private modeFile: string | null = null;
  /** This launch is a Mission session's: no subagent extension, so its readiness is not required. */
  private missionLaunch = false;
  private extensionNonce = '';
  private extensionCapabilities = new Set<string>();
  private extensionFailure: string | null = null;
  private effortFile: string | null = null;
  private settling = false;
  private turnFinishing: Promise<void> | null = null;
  private statsOverlapped = false;
  private readonly deferredLines: string[] = [];
  /** Keep user input outside Pi's queues: 0.85.1 can consume queued input under an aborted signal. */
  private readonly followUps: UserInput[] = [];
  private inputDispatch: Promise<void> = Promise.resolve();
  private pendingInputs = 0;
  private pendingSteers = 0;
  private inputRevision = 0;
  private runtimeQueued = 0;
  private steeringInterrupt = false;
  private idleReported = true;
  private disposal: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly ctx: HarnessContext) {
    this.usage = new PiUsageAndFastMode(ctx.session().usage, {
      emit: (event) => this.ctx.emit(event),
      updateMeta: (patch) => this.ctx.updateMeta(patch),
      info: (text, level) => this.info(text, level)
    });
    this.subagents = new PiSubagentTracker({
      emit: (event) => this.ctx.emit(event),
      info: (text, level) => this.info(text, level),
      log: (level, message) => this.ctx.log(level, message),
      getModels: () => this.models
    });
  }

  get busy(): boolean {
    return this._busy || this.pendingInputs > 0;
  }

  async start(): Promise<void> {
    if (this.child || this.disposal) throw new Error('The previous Pi process must stop before restart.');
    this.stopping = false;
    return this.startRuntime();
  }

  private async startRuntime(): Promise<void> {
    this.extensionNonce = randomUUID();
    this.extensionCapabilities.clear();
    this.extensionFailure = null;
    this.exited = false;
    this.transportError = null;
    this.subagents.reset();
    const meta = this.ctx.session();
    this.usage.initLaunch(meta.config.fastMode === true);

    const launch = await preparePiLaunch(this.ctx, {
      extensionNonce: this.extensionNonce,
      fastModeRequested: this.usage.requested
    });
    this.missionLaunch = launch.missionLaunch;
    this.modeFile = launch.modeFile;
    this.effortFile = launch.effortFile;

    // Which binary answered is the first question when pi misbehaves; the args carry no secrets (env does).
    this.ctx.log('info', `spawning pi: ${launch.bin.path} (${launch.bin.source} runtime) in ${meta.cwd}`);
    if (this.stopping) throw new Error('Pi startup was canceled before launch.');
    const child = spawnTool(launch.bin.path, launch.args, { cwd: meta.cwd, env: launch.env });
    this.child = child;
    let ready = false;
    let startupErrno: string | undefined;
    const splitter = new LineSplitter((line) => { if (this.child === child) this.handleLine(line); });
    child.stdout?.on('data', (d: Buffer) => splitter.push(d));
    const err = new LineSplitter((line) => this.ctx.log('debug', `[pi] ${line}`));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.exited = true;
      this.extensionCapabilities.clear();
      this._busy = false;
      const detail = `pi exited (${code})`;
      this.rejectPending(new Error(detail));
      if (ready && !this.transportError) this.ctx.emit({ type: 'status', status: 'stopped', detail });
    });
    const onTransportError = (e: NodeJS.ErrnoException) => {
      if (this.child !== child || this.exited || this.transportError) return;
      const message = `${ready ? 'pi process failed' : 'pi failed to start'}: ${errorMessage(e)}`;
      this.transportError = new Error(message);
      this.extensionCapabilities.clear();
      this._busy = false;
      // Settle RPC before anything can retire the child. During startup the rejected start owns
      // reporting.
      this.rejectPending(this.transportError);
      if (ready) this.ctx.emit({ type: 'error', message, fatal: true });
      else startupErrno = e.code;
    };
    child.on('error', onTransportError);
    // stdin is a separate EventEmitter; a write to a dead pipe (EPIPE) after the child exits
    // would otherwise be an uncaught exception that kills the process.
    child.stdin?.on('error', onTransportError);

    try {
      const state = await withTimeout(this.request<{ model?: PiModel; thinkingLevel?: string; sessionFile?: string }>('get_state'), 60_000, 'pi get_state');
      if (this.transportError) throw this.transportError;
      // session_start notifications are emitted before get_state is handled in RPC mode.
      this.assertExtensionsReady();
      if (state.sessionFile) this.ctx.updateRef({ piSessionFile: state.sessionFile });
      if (state.model) this.ctx.updateMeta({ activeModel: { provider: state.model.provider, model: state.model.id }, activeEffort: isEffortLevel(state.thinkingLevel) ? state.thinkingLevel : undefined });
      // A resumed session can report a different model than the one on the session config; keep the
      // effort file pointed at whatever pi actually loaded.
      await writePiEffortConfig(this.ctx, this.effortFile, launch.intendedEffort, state.model ? { provider: state.model.provider, model: state.model.id } : meta.config.model);
      if (this.transportError) throw this.transportError;
      if (this.child !== child || this.exited || this.stopping) throw new Error('Pi startup was canceled.');
      this.refreshCommands();
    } catch (error) {
      const checkFolder = startupErrno === 'ENOENT' && error === this.transportError;
      await this.dispose();
      if (checkFolder && await checkMissingPiSessionDir(meta.cwd)) {
        throw new Error(`Pi could not start: session folder is missing or not a directory: ${meta.cwd}. Restore the folder or use an existing worktree.`);
      }
      throw error;
    }
    ready = true;
    this.ctx.emit({ type: 'status', status: 'idle' });
    void this.listModels().then((models) => models.length && this.ctx.emit({ type: 'models', models }));
  }

  private assertExtensionsReady(): void {
    const required = this.missionLaunch ? ['approvals', 'tools'] : ['approvals', 'tools', 'subagents'];
    if (this.usage.requested) required.push('fast-mode');
    const missing = required.filter((capability) => !this.extensionCapabilities.has(capability));
    if (this.extensionFailure || missing.length) {
      throw new Error(`Incompatible Pi runtime: Vocs Code requires working approvals and tool compatibility extensions (Pi 0.85.1 APIs). ${this.extensionFailure ?? `Missing readiness: ${missing.join(', ')}.`} Update Pi or disable conflicting extensions; no prompt was sent.`);
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.usage.rejectFastModeChange(error);
  }

  private write(cmd: Record<string, unknown>): void {
    if (this.transportError) throw this.transportError;
    if (!this.child?.stdin?.writable || this.exited || this.stopping) throw new Error('pi process is not running');
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

  private handleLine(line: string): void {
    if (this.transportError) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.ctx.log('debug', `[pi stdout] ${line}`);
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
      } else if (ev.success === false) this.ctx.log('warn', `[pi] ${ev.command}: ${ev.error}`);
      return;
    }
    if (this.stopping) return;
    // A new extension-started run can arrive while the old run's stats are in flight. Do not
    // mix its usage/stop reason into the old turn or let old bookkeeping publish a stale idle.
    const customMessage = (type === 'message_start' || type === 'message_end') && (ev.message as { role?: string } | undefined)?.role === 'custom';
    // Out-of-band child completions still belong to the pending accounting report.
    if (this.turnFinishing && type !== 'extension_ui_request' && type !== 'queue_update' && !customMessage) {
      if (type === 'agent_start' || type === 'message_start' || type === 'message_update') this.statsOverlapped = true;
      this.deferredLines.push(line);
      return;
    }
    switch (type) {
      case 'agent_start':
        this.settling = false;
        this.idleReported = false;
        this._busy = true;
        this.subagents.clearWakeup();
        if (!this.turnStartedAt) this.usage.beginTurn();
        this.turnStartedAt = this.turnStartedAt || Date.now();
        this.ctx.emit({ type: 'status', status: 'running' });
        return;
      case 'agent_end':
        // This is only a low-level run boundary. Retry, compaction or extension work may follow.
        return;
      case 'agent_settled': {
        if (this.settling) return;
        this.settling = true;
        const finishing = this.finishTurn();
        this.turnFinishing = finishing;
        void finishing.finally(() => {
          if (this.turnFinishing !== finishing) return;
          this.turnFinishing = null;
          // After the turn's own stats request, never alongside it.
          this.refreshCommands();
          for (const deferredLine of this.deferredLines.splice(0)) this.handleLine(deferredLine);
          this.advanceInputs();
        }).catch((error) => this.ctx.log('warn', `Pi turn finalization failed: ${errorMessage(error)}`));
        return;
      }
      case 'turn_start':
      case 'turn_end':
        return;
      case 'message_start': {
        const msg = ev.message as { role?: string; provider?: string; model?: string };
        if (msg?.role === 'assistant') {
          this.usage.onAssistantStart(msg.provider, msg.model);
          this.currentAssistant = { id: shortId('a_'), kind: 'assistant', ts: Date.now(), text: '', thinking: '', streaming: true, model: msg.model };
          this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
        }
        return;
      }
      case 'message_update': {
        // The RPC stream carries the provider's latest usage alongside each content delta. Turn it
        // into a per-message delta so the session totals can move while the model is still working.
        this.usage.reportUsage(ev.usage);
        const ame = ev.assistantMessageEvent as { type: string; delta?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } } | undefined;
        if (!ame) return;
        // Tool-call start/delta events can arrive after startTool has closed the text bubble. Only
        // text/thinking deltas may create a bubble; an empty one would be filled with the whole
        // message by message_end and repeat text already shown before the tool call.
        if (ame.type === 'text_delta' && ame.delta) {
          const a = this.ensureAssistant();
          a.text += ame.delta;
          this.ctx.emit({ type: 'item.delta', id: a.id, textDelta: ame.delta });
        } else if (ame.type === 'thinking_delta' && ame.delta) {
          const a = this.ensureAssistant();
          a.thinking = (a.thinking ?? '') + ame.delta;
          this.ctx.emit({ type: 'item.delta', id: a.id, thinkingDelta: ame.delta });
        } else if (ame.type === 'toolcall_end' && ame.toolCall) {
          this.startTool(ame.toolCall.id, ame.toolCall.name, ame.toolCall.arguments);
        }
        return;
      }
      case 'message_end': {
        const msg = ev.message as { role?: string; customType?: string; details?: unknown; content?: { type: string; text?: string; thinking?: string }[]; model?: string; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };
        if (msg?.role === 'custom') {
          // pi-subagents reports each finished background run as a custom message; without this the
          // run's spend and tool uses were dropped on the floor.
          if (msg.customType === 'subagent-notification') this.subagents.handleSubagentNotification(msg.details);
          return;
        }
        if (msg?.role === 'assistant') {
          this.usage.onAssistantEnd(msg.usage);
          this.lastStopReason = msg.stopReason ?? null;
          this.lastErrorMessage = msg.errorMessage ?? null;
        }
        if (msg?.role === 'assistant' && this.currentAssistant) {
          const a = this.currentAssistant;
          const text = (msg.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
          const thinking = (msg.content ?? []).filter((c) => c.type === 'thinking').map((c) => c.thinking ?? '').join('\n');
          a.text = text || a.text;
          a.thinking = thinking || a.thinking;
          a.streaming = false;
          a.model = msg.model ?? a.model;
          this.ctx.emit({ type: 'item.upsert', item: { ...a } });
          this.currentAssistant = null;
        }
        return;
      }
      case 'tool_execution_start': {
        const e = ev as { toolCallId: string; toolName: string; args: Record<string, unknown> };
        this.startTool(e.toolCallId, e.toolName, e.args);
        return;
      }
      case 'tool_execution_update': {
        const e = ev as { toolCallId: string; partialResult?: { content?: { type: string; text?: string }[] } };
        const item = this.toolItems.get(e.toolCallId);
        if (item && e.partialResult?.content) {
          const text = e.partialResult.content.map((c) => c.text ?? '').join('');
          if (text.length > (item.output ?? '').length) {
            const delta = text.slice((item.output ?? '').length);
            item.output = text;
            this.ctx.emit({ type: 'item.delta', id: item.id, outputDelta: delta });
          }
        }
        return;
      }
      case 'tool_execution_end': {
        const e = ev as { toolCallId: string; toolName: string; result?: { content?: { type: string; text?: string }[]; details?: Record<string, unknown> }; isError: boolean };
        const item = this.toolItems.get(e.toolCallId);
        if (!item || item.status !== 'running') return;
        const declined = this.declinedTools.delete(e.toolCallId);
        const text = (e.result?.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : '[image]')).join('\n');
        item.output = truncate(text, 40_000);
        item.status = e.isError ? declined ? 'declined' : 'error' : 'done';
        const details = e.result?.details;
        if (!e.isError && details && typeof details.diff === 'string') {
          const file = toolPath(item.input as Record<string, unknown>) ?? item.summary ?? '';
          const changes: FileChange[] = [{ path: file, kind: 'update', diff: details.diff }];
          item.changes = changes;
        } else if (!e.isError && item.name === 'write') {
          item.changes = [{ path: toolPath(item.input as Record<string, unknown>) ?? '', kind: 'update' }];
        }
        if (typeof details?.exitCode === 'number') item.exitCode = details.exitCode;
        // Our subagent tools report the run id on the result, which is what the panel links on.
        if (SUBAGENT_TOOLS.has(e.toolName) && typeof details?.runId === 'string') item.runId = details.runId;
        if (e.toolName === 'Agent' || e.toolName === 'get_subagent_result') this.subagents.captureSubagentResult(details);
        this.ctx.emit({ type: 'item.upsert', item: { ...item } });
        return;
      }
      case 'extension_ui_request':
        void this.handleUiRequest(ev as { id: string; method: string; title?: string; message?: string; options?: string[]; notifyType?: string });
        return;
      case 'queue_update': {
        const e = ev as { steering?: unknown[]; followUp?: unknown[] };
        this.runtimeQueued = (e.steering?.length ?? 0) + (e.followUp?.length ?? 0);
        this.updateQueued();
        return;
      }
      case 'compaction_start':
        this.info('Compacting context…');
        return;
      case 'compaction_end': {
        const e = ev as { aborted?: boolean; errorMessage?: string; result?: { tokensBefore?: number; estimatedTokensAfter?: number } };
        if (e.aborted) this.info('Compaction aborted.');
        else if (e.errorMessage) this.info(e.errorMessage, 'error');
        else this.info(`Context compacted${e.result ? ` (${e.result.tokensBefore} → ~${e.result.estimatedTokensAfter} tokens)` : ''}.`);
        return;
      }
      case 'auto_retry_start': {
        const e = ev as { attempt: number; maxAttempts: number; errorMessage: string };
        this.info(`Retrying (${e.attempt}/${e.maxAttempts}): ${e.errorMessage}`, 'warn');
        return;
      }
      case 'extension_error': {
        const e = ev as { extensionPath?: string; error?: string };
        if (e.extensionPath === `command:${PI_FAST_MODE_COMMAND}` || e.extensionPath && /vocs-code-fast-mode\.[cm]?[jt]s$/.test(e.extensionPath)) {
          this.usage.onFastModeExtensionError(e.error);
        }
        if (!e.extensionPath || /vocs-code-(?:tools|approvals|subagents|mcp)\.[cm]?[jt]s$/.test(e.extensionPath)) {
          this.extensionFailure = e.error ?? 'Required Pi extension failed.';
          this.extensionCapabilities.clear();
        }
        this.info(`Extension error (${e.extensionPath}): ${e.error}`, 'error');
        return;
      }
      default:
        return;
    }
  }

  private ensureAssistant(): Extract<TranscriptItem, { kind: 'assistant' }> {
    if (!this.currentAssistant) {
      this.currentAssistant = { id: shortId('a_'), kind: 'assistant', ts: Date.now(), text: '', thinking: '', streaming: true };
      this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
    }
    return this.currentAssistant;
  }

  private startTool(id: string, name: string, args: Record<string, unknown>): void {
    if (this.toolItems.has(id)) return;
    const hint = name === 'bash' || name === 'powershell' ? 'execute' : name === 'edit' || name === 'write' ? 'edit' : name === 'read' ? 'read' : name === 'grep' || name === 'find' || name === 'rg' || name === 'glob' || name === 'ls' ? 'search' : SUBAGENT_TOOLS.has(name) ? 'agent' : 'other';
    const summary =
      typeof args?.command === 'string' ? (args.command as string) : typeof args?.description === 'string' ? (args.description as string) : toolPath(args) !== undefined ? toolPath(args) : typeof args?.pattern === 'string' ? (args.pattern as string) : truncate(JSON.stringify(args ?? {}), 200, '…');
    const item: Extract<TranscriptItem, { kind: 'tool' }> = { id, kind: 'tool', ts: Date.now(), name, hint, input: args, summary, status: 'running' };
    this.toolItems.set(id, item);
    this.ctx.emit({ type: 'item.upsert', item });
    // Close the current text bubble so later text appears after the tool card.
    if (this.currentAssistant && this.currentAssistant.text) {
      this.currentAssistant.streaming = false;
      this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
      this.currentAssistant = null;
    }
  }

  private handleSubagentEvent(raw: string): void {
    this.subagents.handleSubagentEvent(raw, this.extensionNonce);
  }

  private async handleUiRequest(req: { id: string; method: string; title?: string; message?: string; options?: string[]; notifyType?: string }): Promise<void> {
    const respond = (payload: Record<string, unknown>) => {
      try {
        this.write({ type: 'extension_ui_response', id: req.id, ...payload });
      } catch {
        /* process gone */
      }
    };
    // A dialog emitted by the retiring run must not wedge cancellation or acquire a new grant.
    if ((this.steeringInterrupt || this.pendingSteers > 0) && ['select', 'confirm', 'input', 'editor'].includes(req.method)) {
      respond({ cancelled: true });
      return;
    }
    switch (req.method) {
      case 'select': {
        const title = req.title ?? '';
        if (title.startsWith(QUESTION_MARKER)) {
          try {
            const question = parseQuestionPayload(title.slice(QUESTION_MARKER.length), this.extensionNonce);
            const decision = await this.ctx.requestApproval({
              kind: 'question', title: 'Pi has a question', toolName: QUESTION_TOOL, toolItemId: question.toolCallId,
              supportsQuestionComment: true, maxQuestionResponseLength: QUESTION_RESPONSE_LIMIT,
              options: [{ id: 'allow', label: 'Answer', kind: 'allow' }, { id: 'deny', label: 'Skip', kind: 'deny' }],
              questions: [{ id: 'answer', header: question.header, question: question.question, options: question.options, allowOther: question.allowOther }],
            });
            respond({ value: JSON.stringify(questionResponse(decision, 'answer')) });
          } catch {
            // Malformed/stale dialogs and an interrupted host request must always unblock Pi,
            // without turning model text or a missing response into a fabricated user answer.
            this.ctx.log('warn', 'pi: structured question was invalid or interrupted');
            respond({ cancelled: true });
          }
          return;
        }
        if (title.startsWith(PI_APPROVAL_MARKER)) {
          let payload: { tool: string; toolCallId?: string; input: Record<string, unknown>; summary?: string } = { tool: 'tool', input: {} };
          try {
            payload = JSON.parse(title.slice(PI_APPROVAL_MARKER.length));
          } catch {
            /* keep default */
          }
          const command = typeof payload.input?.command === 'string' ? (payload.input.command as string) : undefined;
          const isEdit = payload.tool === 'edit' || payload.tool === 'write';
          const decision = await this.ctx.requestApproval({
            kind: command ? 'command' : isEdit ? 'file_change' : 'tool',
            title: command ? 'pi wants to run a command' : `pi wants to use ${payload.tool}`,
            toolName: payload.tool,
            toolItemId: payload.toolCallId,
            command,
            cwd: this.ctx.session().cwd,
            input: payload.input,
            description: payload.summary,
            changes: isEdit ? [{ path: toolPath(payload.input) ?? '', kind: 'update' }] : undefined,
            options: OPTIONS_ALLOW_DENY
          });
          const map: Record<string, string> = { allow: 'Allow once', allow_session: 'Allow for session', deny: 'Deny' };
          const value = map[decision.optionId] ?? 'Deny';
          if (value === 'Deny') this.markToolDeclined(payload.toolCallId, payload.tool);
          respond({ value });
          return;
        }
        const decision = await this.ctx.requestApproval({
          kind: 'question',
          title: title || 'pi asks',
          supportsQuestionComment: false,
          options: [
            { id: 'allow', label: 'Choose', kind: 'allow' },
            { id: 'deny', label: 'Cancel', kind: 'cancel' }
          ],
          questions: [{ id: 'choice', question: title || 'Select an option', options: (req.options ?? []).map((o) => ({ label: o })) }]
        });
        if (decision.optionId === 'allow' && decision.answers?.choice) respond({ value: decision.answers.choice });
        else respond({ cancelled: true });
        return;
      }
      case 'confirm': {
        const decision = await this.ctx.requestApproval({
          kind: 'permission',
          title: req.title ?? 'Confirm',
          description: req.message,
          options: [
            { id: 'allow', label: 'Yes', kind: 'allow' },
            { id: 'deny', label: 'No', kind: 'deny' }
          ]
        });
        respond({ confirmed: decision.optionId === 'allow' });
        return;
      }
      case 'input':
      case 'editor': {
        const decision = await this.ctx.requestApproval({
          kind: 'question',
          title: req.title ?? 'Input requested',
          supportsQuestionComment: false,
          options: [
            { id: 'allow', label: 'Submit', kind: 'allow' },
            { id: 'deny', label: 'Cancel', kind: 'cancel' }
          ],
          questions: [{ id: 'value', question: req.title ?? 'Enter a value', allowOther: true }]
        });
        if (decision.optionId === 'allow') respond({ value: decision.answers?.value ?? '' });
        else respond({ cancelled: true });
        return;
      }
      case 'notify':
        if (req.message && this.handleExtensionNotification(req.message)) return;
        if (req.message?.startsWith(PI_BLOCK_MARKER)) {
          try {
            const block = JSON.parse(req.message.slice(PI_BLOCK_MARKER.length)) as { toolCallId?: unknown; toolName?: unknown };
            this.markToolDeclined(block.toolCallId, block.toolName);
          } catch {
            this.ctx.log('warn', 'pi: malformed tool-block notification');
          }
          return;
        }
        if (req.message) this.info(req.message, req.notifyType === 'error' ? 'error' : req.notifyType === 'warning' ? 'warn' : 'info');
        return;
      default:
        return; // setStatus / setWidget / setTitle / set_editor_text are TUI-only
    }
  }

  private handleExtensionNotification(message: string): boolean {
    if (message.startsWith(PI_SUBAGENT_MARKER)) {
      this.handleSubagentEvent(message.slice(PI_SUBAGENT_MARKER.length));
      return true;
    }
    const marker = [PI_READY_MARKER, PI_EXTENSION_ERROR_MARKER, PI_TOOL_INPUT_MARKER, PI_FAST_MODE_MARKER].find((prefix) => message.startsWith(prefix));
    if (!marker) return false;
    try {
      const payload = JSON.parse(message.slice(marker.length)) as Record<string, unknown>;
      if (!payload || payload.version !== 1 || !this.extensionNonce || payload.nonce !== this.extensionNonce) return true;
      if (marker === PI_FAST_MODE_MARKER) {
        this.usage.handleFastModeNotification(payload);
      } else if (marker === PI_READY_MARKER && (payload.capability === 'approvals' || payload.capability === 'tools' || payload.capability === 'subagents' || payload.capability === 'mcp' || payload.capability === 'fast-mode')) {
        if (payload.ready === false) this.extensionCapabilities.delete(payload.capability);
        else this.extensionCapabilities.add(payload.capability);
      } else if (marker === PI_EXTENSION_ERROR_MARKER) {
        this.extensionFailure = typeof payload.message === 'string' ? payload.message : 'Required Pi extension failed.';
        this.extensionCapabilities.clear();
      } else if (marker === PI_TOOL_INPUT_MARKER) {
        this.updateToolInput(payload.toolCallId, payload.toolName, payload.input);
      }
    } catch {
      this.ctx.log('warn', 'pi: malformed extension capability notification');
    }
    return true;
  }

  private updateToolInput(id: unknown, name: unknown, input: unknown): void {
    if (typeof id !== 'string' || typeof name !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) return;
    const item = this.toolItems.get(id);
    if (!item || item.name !== name || item.status !== 'running') return;
    const args = input as Record<string, unknown>;
    item.input = args;
    item.summary = typeof args.command === 'string' ? args.command : toolPath(args) ?? item.summary;
    this.ctx.emit({ type: 'item.upsert', item: { ...item } });
  }

  private markToolDeclined(id: unknown, name: unknown): void {
    if (typeof id !== 'string' || typeof name !== 'string') return;
    const item = this.toolItems.get(id);
    if (item?.status === 'running' && item.name === name) this.declinedTools.add(id);
  }

  private async finishTurn(): Promise<void> {
    const child = this.child;
    this.statsOverlapped = false;
    this.declinedTools.clear();
    // The turn ends now, but the stats round-trip below is app bookkeeping rather than model work:
    // measuring the wall time after it would fold a stalled request (up to the 10s timeout) into the
    // turn's duration and depress the speed the panel derives from it. A turn that ends after
    // turnStartedAt was reset (or before a start was seen) carries no duration at all, since
    // measuring from 0 would report an epoch-long wall time.
    const wallMs = this.turnStartedAt > 0 ? Date.now() - this.turnStartedAt : undefined;
    if (this.currentAssistant) {
      this.currentAssistant.streaming = false;
      this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
      this.currentAssistant = null;
    }
    try {
      const stats = await withTimeout(
        this.request<{ tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; cost?: number; contextUsage?: { tokens?: number; contextWindow?: number } | null; sessionFile?: string }>('get_session_stats'),
        10_000,
        'get_session_stats'
      );
      if (stats.sessionFile) this.ctx.updateRef({ piSessionFile: stats.sessionFile });
      // A snapshot that overlaps a newer run already includes its deferred samples. Keep this
      // turn's streamed usage; the next non-overlapping cumulative snapshot reconciles both.
      if (!this.statsOverlapped) this.usage.applySessionStats(stats);
    } catch (e) {
      // A failed or timed-out stats request must not skip the turn's own accounting: pi reports
      // tokens cumulatively, so the samples it already streamed for this turn are all the app has.
      // Closing the turn outside the try keeps the session's turn count in step with the transcript
      // and lets those samples be the turn's usage. They stay pending in the tracker, so the next
      // cumulative snapshot still reconciles them rather than counting them twice.
      this.ctx.log('debug', `get_session_stats failed: ${errorMessage(e)}`);
    }
    // Accounting cannot publish a completed turn after a transport error or during teardown.
    if (this.child !== child || this.transportError || this.stopping) return;
    // Subagent spend accrued since the last report, so analytics can put it on the model that ran it.
    const { turnCost, turnUsage } = this.usage.finishTurn(this.subagents.drainPendingCost());
    // pi ends a failed turn with an assistant message (stopReason 'error'), not an error event.
    const stopReason = this.steeringInterrupt ? 'aborted' : this.lastStopReason;
    const errorMsg = this.lastErrorMessage;
    this.lastStopReason = null;
    this.lastErrorMessage = null;
    const failed = stopReason === 'error' && errorMsg;
    if (failed) this.info(`Turn failed: ${errorMsg}`, 'error');
    this._busy = false;
    this.ctx.emit({
      type: 'item.upsert',
      item: {
        id: shortId('turn_'),
        kind: 'turn',
        ts: Date.now(),
        status: failed ? 'failed' : stopReason === 'aborted' ? 'interrupted' : 'completed',
        durationMs: wallMs,
        costUsd: turnCost,
        usage: turnUsage,
        error: failed ? errorMsg : undefined
      }
    });
    this.turnStartedAt = 0;
  }

  private updateQueued(): void {
    this.ctx.updateMeta({ queued: this.runtimeQueued + this.followUps.length + this.pendingInputs });
  }

  private advanceInputs(): void {
    if (this._busy || this.pendingInputs || this.turnFinishing || this.stopping || this.exited || this.transportError) return;
    const next = this.followUps.shift();
    this.updateQueued();
    if (next) {
      void this.send({ ...next, mode: 'queue' }).catch((error) => this.ctx.emit({ type: 'error', message: `Pi queued input failed: ${errorMessage(error)}`, fatal: false }));
    } else if (!this.idleReported) {
      this.idleReported = true;
      this.ctx.emit({ type: 'status', status: 'idle' });
    }
  }

  private info(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level, text } });
  }

  async send(input: UserInput): Promise<void> {
    if (!this.child) await this.start();
    this.assertExtensionsReady();
    if (input.mode === 'queue' && this.busy) {
      this.followUps.push(input);
      this.updateQueued();
      return;
    }
    const child = this.child;
    const revision = this.inputRevision;
    const assertCurrent = () => {
      if (this.child !== child || this.exited || this.stopping || revision !== this.inputRevision) throw new Error('Pi stopped before the message could be sent.');
    };
    let steeringPending = this.busy;
    if (steeringPending) this.pendingSteers++;
    this.pendingInputs++;
    this.updateQueued();
    // Serialize only cancellation/admission, never a whole model response. Rapid steers each
    // enter once, in order, and queued follow-ups cannot overtake an urgent directive.
    const dispatch = this.inputDispatch.then(async () => {
      assertCurrent();
      await this.turnFinishing;
      if (this._busy && input.mode === 'queue') {
        // An extension can start work between selecting a follow-up and admitting it.
        // Queue must still wait, preserving its place ahead of later follow-ups.
        this.followUps.unshift(input);
        return;
      }
      if (this._busy) {
        this.steeringInterrupt = true;
        try {
          await withTimeout(this.request('abort'), 15_000, 'Pi steering cancellation');
          await this.turnFinishing;
          assertCurrent();
          if (this._busy) throw new Error('Pi did not settle after cancellation; stop the session before retrying.');
        } finally {
          this.steeringInterrupt = false;
        }
      }
      assertCurrent();
      if (steeringPending) { this.pendingSteers--; steeringPending = false; }
      await this.promptInput(input);
    });
    const completed = dispatch.finally(() => {
      if (steeringPending) this.pendingSteers--;
      this.pendingInputs--;
      this.updateQueued();
      this.advanceInputs();
    });
    this.inputDispatch = completed.catch(() => undefined);
    await completed;
  }

  private images(input: UserInput): { type: string; data: string; mimeType: string }[] {
    return (input.images ?? []).map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }));
  }

  private async promptInput(input: UserInput): Promise<void> {
    const child = this.child;
    this.idleReported = false;
    this._busy = true;
    this.settling = false;
    this.turnStartedAt = Date.now();
    // Arm the turn here: send() sets turnStartedAt before pi emits agent_start, so the guard in
    // agent_start never fires for a normal prompt and the turn would never be counted.
    this.usage.beginTurn();
    this.ctx.emit({ type: 'status', status: 'running' });
    try {
      await this.request('prompt', { message: input.text, images: this.images(input) });
    } catch (e) {
      if (this.child === child && !this.exited && !this.stopping) this._busy = false;
      throw e;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.child) return;
    await this.request('abort').catch((e) => this.ctx.log('warn', `abort failed: ${errorMessage(e)}`));
  }

  async setModel(model: ModelRef): Promise<void> {
    await this.request('set_model', { provider: model.provider, modelId: model.model });
    this.ctx.updateMeta({ activeModel: model });
    await writePiEffortConfig(this.ctx, this.effortFile, this.ctx.effort(), model);
  }

  async setFastMode(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Pi Fast mode must be a boolean.');
    if (this._busy || this.usage.changing) throw new Error('Pi Fast mode can only change while idle.');
    if (!this.child || this.exited) throw new Error('pi process is not running');
    if (!this.extensionCapabilities.has('fast-mode')) throw new Error('Pi Fast mode extension is unavailable. Update Pi and restart the session.');
    const change = this.usage.beginFastModeChange(enabled);
    try {
      // prompt executes an extension command without adding a user/model turn. RPC success alone
      // is insufficient: require the exact nonce/revision acknowledgement from our extension.
      await withTimeout(Promise.all([
        this.request('prompt', { message: `/${PI_FAST_MODE_COMMAND} ${JSON.stringify({ nonce: this.extensionNonce, requestId: change.requestId, revision: change.revision, enabled })}` }),
        change.ack.promise
      ]), 10_000, 'Pi Fast mode acknowledgement');
    } catch (error) {
      this.ctx.updateMeta({ fastModeStatus: { state: 'unavailable', detail: 'Pi Fast mode change was not confirmed. Restart the session before retrying.' } });
      // An acknowledgement can be lost after mutation. Never let an unconfirmed paid tier serve
      // another turn; the next launch reconstructs the last committed preference from config.
      await this.dispose();
      throw error;
    } finally {
      this.usage.clearFastModeChange();
    }
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    await this.request('set_thinking_level', { level: piThinkingLevel(effort) });
    this.ctx.updateMeta({ activeEffort: effort });
    await writePiEffortConfig(this.ctx, this.effortFile, effort, this.ctx.session().activeModel);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await writePiPermissionMode(this.ctx, this.modeFile, mode);
  }

  async compact(): Promise<void> {
    await this.request('compact', {});
  }

  /**
   * Publishes Pi's extension commands, prompt templates and skills. Pi has no change event — an
   * extension can reload its resources mid-session — so this runs at start and after each settled
   * turn; an unchanged list is not re-sent. A failure only costs the composer its suggestions.
   */
  private refreshCommands(): void {
    if (!this.child) return;
    const child = this.child;
    void withTimeout(this.request<{ commands?: unknown }>('get_commands'), 20_000, 'pi get_commands')
      .then((res) => {
        if (this.child === child && !this.exited) reportHarnessCommands(this.ctx, piHarnessCommands(res?.commands));
      })
      .catch((e) => this.ctx.log('debug', `pi get_commands failed: ${errorMessage(e)}`));
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.child) return [];
    try {
      const res = await withTimeout(this.request<{ models: PiModel[] }>('get_available_models'), 20_000, 'get_available_models');
      this.models = mergePiCatalog(res.models.map(piModelToInfo), this.ctx.settings());
      return this.models;
    } catch (e) {
      this.ctx.log('warn', `get_available_models failed: ${errorMessage(e)}`);
      return this.models;
    }
  }

  async dispose(): Promise<void> {
    this.inputRevision++;
    this.followUps.length = 0;
    this.deferredLines.length = 0;
    this.runtimeQueued = 0;
    this.subagents.clearWakeup();
    this.updateQueued();
    this.usage.close();
    this.extensionCapabilities.clear();
    this.declinedTools.clear();
    // Disposal can detach the runtime before close arrives (and close need not arrive at all).
    this.rejectPending(new Error('Pi stopped before its RPC requests completed.'));
    const child = this.child;
    this.stopping = true;
    if (this.disposal) return this.disposal;
    const operation = Promise.resolve().then(async () => {
      // The graceful stdin-EOF shutdown.
      if (child) await shutdownChild(child, 1500);
      this.child = null;
      this.exited = true;
      this._busy = false;
    });
    this.disposal = operation;
    try { await operation; } finally { this.disposal = null; }
  }
}
