import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { EffortLevel, FileChange, ModelInfo, ModelRef, PermissionMode, SubagentCompletion, SubagentCost, TranscriptItem, UsageTotals, UserInput } from '../../shared/types';
import { EFFORT_LEVELS, isEffortLevel } from '../../shared/harness-meta';
import { modelName } from '../../shared/model-names';
import { LineSplitter, deferred, errorMessage, shortId, truncate, withTimeout, type Deferred } from '../util/async';
import { shutdownChild, spawnTool } from './spawn';
import type { HarnessAdapter, HarnessContext } from './types';
import { OPTIONS_ALLOW_DENY } from './permissions';
import { TurnUsageTracker } from '../util/turn-usage';
import { UsageReporter } from '../util/usage-reporter';
import { installPiAgentOverrides } from '../pi-agents';

export const PI_APPROVAL_MARKER = 'VCODE_APPROVAL::';
const PI_BLOCK_MARKER = 'VCODE_TOOL_BLOCKED::';
const PI_READY_MARKER = 'VCODE_PI_READY::';
const PI_EXTENSION_ERROR_MARKER = 'VCODE_PI_ERROR::';
const PI_TOOL_INPUT_MARKER = 'VCODE_PI_TOOL_INPUT::';

/** pi-subagents' completion payload, as it reaches us on the tool result or the custom notification. */
interface PiSubagentDetails {
  id?: string;
  agentId?: string;
  description?: string;
  status?: string;
  modelName?: string;
  toolUses?: number;
  /** Foreground tool-result name for the cost. */
  cost?: number;
  /** Background notification name for the cost. */
  totalCost?: number;
  totalTokens?: number;
  durationMs?: number;
  error?: string;
  others?: PiSubagentDetails[];
}

/** A pi-subagents run is only counted once its own status is terminal. */
function isTerminalSubagentStatus(status: string | undefined): status is string {
  return status === 'completed' || status === 'error' || status === 'stopped' || status === 'aborted';
}
const PI_TOOL_PROMPT = 'Pi tools: prefer path (file_path is accepted). edit uses edits[]; a single old_string/new_string pair is accepted, including empty new_string. replace_all:true is unsupported: use unique non-overlapping edits. bash timeout is seconds; timeout_ms explicitly means milliseconds. Never send both timeout fields or guess their units.';

function toolPath(input: Record<string, unknown> | undefined): string | undefined {
  return typeof input?.path === 'string' ? input.path : typeof input?.file_path === 'string' ? input.file_path : undefined;
}

/** Env var names pi understands for each of our provider ids. */
export const PI_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  gemini: 'GEMINI_API_KEY'
};

interface PiModel {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  thinkingLevelMap?: Record<string, string | null>;
}

export function piModelToInfo(m: PiModel): ModelInfo {
  const efforts = piSupportedEfforts(m);
  return {
    id: m.id,
    provider: m.provider,
    displayName: m.name || m.id,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxTokens,
    supportsImages: (m.input ?? []).includes('image'),
    supportsReasoning: !!m.reasoning,
    supportedEfforts: efforts && efforts.length ? efforts : undefined,
    pricing: m.cost ? { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite } : undefined
  };
}

/**
 * Mirrors pi's own getSupportedThinkingLevels: a level is hidden only by an explicit `null`, a
 * missing standard level keeps the provider's default mapping, and the extended `xhigh`/`max`
 * levels need an explicit mapping. `off` is dropped — leaving effort unset already runs the model
 * default. Without a map we keep the full list; pi clamps anything the model cannot use.
 */
function piSupportedEfforts(m: PiModel): EffortLevel[] | undefined {
  const map = m.thinkingLevelMap;
  if (!m.reasoning || !map) return undefined;
  return EFFORT_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

function piThinkingLevel(effort: EffortLevel | undefined): string | undefined {
  return effort;
}

interface PiStreamUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
}

function finiteCounter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function piStreamUsage(value: unknown): PiStreamUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const cost = raw.cost && typeof raw.cost === 'object' && !Array.isArray(raw.cost) ? (raw.cost as Record<string, unknown>) : undefined;
  return {
    input: finiteCounter(raw.input),
    output: finiteCounter(raw.output),
    cacheRead: finiteCounter(raw.cacheRead),
    cacheWrite: finiteCounter(raw.cacheWrite),
    reasoning: finiteCounter(raw.reasoning),
    cost: finiteCounter(cost?.total)
  };
}

function piUsageDelta(previous: PiStreamUsage | null, current: PiStreamUsage): PiStreamUsage {
  const delta = (before: number | null, after: number) => before === null || after < before ? after : after - before;
  return {
    input: delta(previous?.input ?? null, current.input),
    output: delta(previous?.output ?? null, current.output),
    cacheRead: delta(previous?.cacheRead ?? null, current.cacheRead),
    cacheWrite: delta(previous?.cacheWrite ?? null, current.cacheWrite),
    reasoning: delta(previous?.reasoning ?? null, current.reasoning),
    cost: delta(previous?.cost ?? null, current.cost)
  };
}

function hasPiUsage(usage: PiStreamUsage): boolean {
  return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || usage.reasoning > 0 || usage.cost > 0;
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
  private readonly usage: TurnUsageTracker;
  private readonly usageReporter: UsageReporter;
  /** Latest cumulative usage in the current assistant stream, used to derive per-update deltas. */
  private streamUsage: PiStreamUsage | null = null;
  /** stopReason/errorMessage of the last assistant message — pi reports turn failures here, not as events. */
  private lastStopReason: string | null = null;
  private lastErrorMessage: string | null = null;
  private models: ModelInfo[] = [];
  private nextId = 1;
  /** agentId -> the model name its Agent call reported, for attributing the completion notification. */
  private readonly subagentModelNames = new Map<string, string>();
  /** agentIds already counted, so a background run's tool result and notification are not both recorded. */
  private readonly recordedSubagents = new Set<string>();
  /** Subagent spend since the last usage report, keyed `provider/model`, for model re-attribution. */
  private readonly pendingSubagentCost = new Map<string, SubagentCost>();
  private exited = false;
  private modeFile: string | null = null;
  private extensionNonce = '';
  private extensionCapabilities = new Set<string>();
  private extensionFailure: string | null = null;
  private effortFile: string | null = null;

  constructor(private readonly ctx: HarnessContext) {
    this.usage = new TurnUsageTracker(ctx.session().usage);
    this.usageReporter = new UsageReporter((event) => this.ctx.emit(event));
  }

  get busy(): boolean {
    return this._busy;
  }

  async start(): Promise<void> {
    this.extensionNonce = randomUUID();
    this.extensionCapabilities.clear();
    this.extensionFailure = null;
    this.exited = false;
    this.subagentModelNames.clear();
    this.recordedSubagents.clear();
    this.pendingSubagentCost.clear();
    const meta = this.ctx.session();
    const s = this.ctx.settings();
    const intendedEffort = this.ctx.effort();
    const bin = this.ctx.runtime.resolve('pi');
    if (!bin) throw new Error('pi is not installed. Run `npm install -g @earendil-works/pi-coding-agent` or set the path in Settings.');
    const ext = this.ctx.runtime.resource('pi', 'vocs-code-approvals.ts');
    const toolsExt = this.ctx.runtime.resource('pi', 'vocs-code-tools.ts');
    const mcpExt = this.ctx.runtime.resource('pi', 'vocs-code-mcp.ts');
    const sessionDir = path.join(this.ctx.sessionDir, 'pi');
    await fs.mkdir(sessionDir, { recursive: true });

    // Subagents inherit the session model: override pi-subagents' pinned Explore agent in pi's
    // global agent dir, without clobbering a user's file there. The same pass drops a legacy
    // project copy and turns on usage reporting so subagent spend reaches the session totals and
    // analytics.
    await installPiAgentOverrides({
      cwd: meta.cwd,
      log: (level, message) => this.ctx.log(level, `[pi] ${message}`)
    });

    // The MCP bridge extension reads this file and registers each server's tools with pi.
    const mcpServers = await this.ctx.mcpServers();
    const args = ['--mode', 'rpc', '-e', ext, '-e', toolsExt, '--session-dir', sessionDir];
    let mcpConfigFile: string | null = null;
    if (mcpServers.length) {
      args.push('-e', mcpExt);
      mcpConfigFile = path.join(sessionDir, 'mcp.json');
      await fs.writeFile(mcpConfigFile, JSON.stringify({ servers: mcpServers.map((r) => r.def) }, null, 2) + '\n', 'utf8');
    }
    if (meta.harnessRef.piSessionFile) args.push('--session', meta.harnessRef.piSessionFile);
    if (meta.config.model) {
      if (meta.config.model.provider) args.push('--provider', meta.config.model.provider);
      args.push('--model', meta.config.model.model);
    }
    const level = piThinkingLevel(intendedEffort);
    if (level) args.push('--thinking', level);
    // Pi accumulates this flag; separate arguments avoid introducing newlines into Windows cmd shims.
    if (meta.config.appendSystemPrompt) args.push('--append-system-prompt', meta.config.appendSystemPrompt);
    args.push('--append-system-prompt', PI_TOOL_PROMPT);
    args.push(...(s.pi.extraArgs ?? []));

    this.modeFile = path.join(sessionDir, 'permission-mode.txt');
    await fs.writeFile(this.modeFile, this.ctx.permissionMode(), 'utf8');
    this.effortFile = path.join(sessionDir, 'reasoning-effort.json');
    await this.writeEffortConfig(intendedEffort, meta.config.model);
    const env: NodeJS.ProcessEnv = { ...process.env, VOCS_CODE_PERMISSION_MODE: this.ctx.permissionMode(), VOCS_CODE_MODE_FILE: this.modeFile, VOCS_CODE_PI_NONCE: this.extensionNonce, VOCS_CODE_EFFORT_FILE: this.effortFile, VOCS_CODE: '1' };
    if (mcpConfigFile) env.VOCS_CODE_MCP_CONFIG = mcpConfigFile;
    for (const [pid, envKey] of Object.entries(PI_ENV_KEYS)) {
      if (!env[envKey]) {
        const key = await this.ctx.getApiKey(pid);
        if (key) env[envKey] = key;
      }
    }

    // Which binary answered is the first question when pi misbehaves; the args carry no secrets (env does).
    this.ctx.log('info', `spawning pi: ${bin.path} (${bin.source} runtime) in ${meta.cwd}`);
    const child = spawnTool(bin.path, args, { cwd: meta.cwd, env });
    this.child = child;
    const splitter = new LineSplitter((line) => this.handleLine(line));
    child.stdout?.on('data', (d: Buffer) => splitter.push(d));
    const err = new LineSplitter((line) => this.ctx.log('debug', `[pi] ${line}`));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    child.on('close', (code) => {
      this.exited = true;
      this.extensionCapabilities.clear();
      this._busy = false;
      for (const d of this.pending.values()) d.reject(new Error(`pi exited (${code})`));
      this.pending.clear();
      this.ctx.emit({ type: 'status', status: 'stopped', detail: `pi exited (${code})` });
    });
    child.on('error', (e) => this.ctx.emit({ type: 'error', message: `pi failed to start: ${errorMessage(e)}`, fatal: true }));

    let state: { model?: PiModel; thinkingLevel?: string; sessionFile?: string; sessionId?: string };
    try {
      state = await withTimeout(this.request<typeof state>('get_state'), 60_000, 'pi get_state');
      // session_start notifications are emitted before get_state is handled in RPC mode.
      this.assertExtensionsReady();
    } catch (error) {
      await this.dispose();
      throw error;
    }
    if (state.sessionFile) this.ctx.updateRef({ piSessionFile: state.sessionFile });
    if (state.model) this.ctx.updateMeta({ activeModel: { provider: state.model.provider, model: state.model.id }, activeEffort: isEffortLevel(state.thinkingLevel) ? state.thinkingLevel : undefined });
    // A resumed session can report a different model than the one on the session config; keep the
    // effort file pointed at whatever pi actually loaded.
    await this.writeEffortConfig(intendedEffort, state.model ? { provider: state.model.provider, model: state.model.id } : meta.config.model);
    this.ctx.emit({ type: 'status', status: 'idle' });
    void this.listModels().then((models) => models.length && this.ctx.emit({ type: 'models', models }));
  }

  private assertExtensionsReady(): void {
    const missing = ['approvals', 'tools'].filter((capability) => !this.extensionCapabilities.has(capability));
    if (this.extensionFailure || missing.length) {
      throw new Error(`Incompatible Pi runtime: Vocs Code requires working approvals and tool compatibility extensions (Pi 0.85.1 APIs). ${this.extensionFailure ?? `Missing readiness: ${missing.join(', ')}.`} Update Pi or disable conflicting extensions; no prompt was sent.`);
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

  private handleLine(line: string): void {
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
    switch (type) {
      case 'agent_start':
        this._busy = true;
        if (!this.turnStartedAt) this.usage.beginTurn();
        this.turnStartedAt = this.turnStartedAt || Date.now();
        this.ctx.emit({ type: 'status', status: 'running' });
        return;
      case 'agent_end': {
        // A retry (or compaction) follows this run; wait for the final agent_end so the
        // turn item reflects the whole prompt, not the failed attempt.
        if ((ev as { willRetry?: boolean }).willRetry) return;
        void this.finishTurn();
        return;
      }
      case 'turn_start':
      case 'turn_end':
        return;
      case 'message_start': {
        const msg = ev.message as { role?: string; provider?: string; model?: string };
        if (msg?.role === 'assistant') {
          // Pi's streaming usage is cumulative for one assistant message, not the whole session.
          this.streamUsage = null;
          this.currentAssistant = { id: shortId('a_'), kind: 'assistant', ts: Date.now(), text: '', thinking: '', streaming: true, model: msg.model };
          this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
        }
        return;
      }
      case 'message_update': {
        // The RPC stream carries the provider's latest usage alongside each content delta. Turn it
        // into a per-message delta so the session totals can move while the model is still working.
        this.reportPiUsage(ev.usage);
        const ame = ev.assistantMessageEvent as { type: string; delta?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } } | undefined;
        if (!ame) return;
        const a = this.ensureAssistant();
        if (ame.type === 'text_delta' && ame.delta) {
          a.text += ame.delta;
          this.ctx.emit({ type: 'item.delta', id: a.id, textDelta: ame.delta });
        } else if (ame.type === 'thinking_delta' && ame.delta) {
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
          if (msg.customType === 'subagent-notification') this.handleSubagentNotification(msg.details);
          return;
        }
        if (msg?.role === 'assistant') {
          this.reportPiUsage(msg.usage);
          this.streamUsage = null;
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
        if (e.toolName === 'Agent' || e.toolName === 'get_subagent_result') this.captureSubagentResult(details);
        this.ctx.emit({ type: 'item.upsert', item: { ...item } });
        return;
      }
      case 'extension_ui_request':
        void this.handleUiRequest(ev as { id: string; method: string; title?: string; message?: string; options?: string[]; notifyType?: string });
        return;
      case 'queue_update': {
        const e = ev as { steering?: unknown[]; followUp?: unknown[] };
        this.ctx.updateMeta({ queued: (e.steering?.length ?? 0) + (e.followUp?.length ?? 0) });
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
        if (!e.extensionPath || /vocs-code-(?:tools|approvals)\.[cm]?[jt]s$/.test(e.extensionPath)) {
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
    const summary =
      typeof args?.command === 'string' ? (args.command as string) : toolPath(args) !== undefined ? toolPath(args) : typeof args?.pattern === 'string' ? (args.pattern as string) : truncate(JSON.stringify(args ?? {}), 200, '…');
    const hint = name === 'bash' || name === 'powershell' ? 'execute' : name === 'edit' || name === 'write' ? 'edit' : name === 'read' ? 'read' : name === 'grep' || name === 'find' || name === 'ls' ? 'search' : 'other';
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

  /** Captures the model and terminal stats pi-subagents puts on an Agent / get_subagent_result tool result. */
  private captureSubagentResult(details: unknown): void {
    const d = details as PiSubagentDetails | undefined;
    if (!d || typeof d !== 'object') return;
    const agentId = d.agentId ?? d.id;
    if (!agentId) return;
    if (d.modelName) this.subagentModelNames.set(agentId, d.modelName);
    // Foreground runs return their full stats here; a background spawn's result is zeros.
    if (isTerminalSubagentStatus(d.status)) this.recordSubagent(d, agentId);
  }

  /** Handles a background completion, including a group notification's `others`. */
  private handleSubagentNotification(details: unknown): void {
    const d = details as PiSubagentDetails | undefined;
    if (!d || typeof d !== 'object') return;
    for (const rec of [d, ...(Array.isArray(d.others) ? d.others : [])]) {
      const agentId = rec.id ?? rec.agentId;
      if (agentId && isTerminalSubagentStatus(rec.status)) this.recordSubagent(rec, agentId);
    }
  }

  /** Records one finished run once: tool uses go to analytics, spend to the model that actually ran it. */
  private recordSubagent(d: PiSubagentDetails, agentId: string): void {
    if (this.recordedSubagents.has(agentId)) return;
    this.recordedSubagents.add(agentId);
    const costUsd = typeof d.cost === 'number' ? d.cost : typeof d.totalCost === 'number' ? d.totalCost : undefined;
    const model = this.resolveSubagentModel(this.subagentModelNames.get(agentId));
    if (costUsd && costUsd > 0) {
      const ref = model ?? this.ctx.session().activeModel;
      if (ref?.provider && ref.model) {
        const key = `${ref.provider}/${ref.model}`;
        const cur = this.pendingSubagentCost.get(key) ?? { provider: ref.provider, model: ref.model, costUsd: 0 };
        cur.costUsd += costUsd;
        this.pendingSubagentCost.set(key, cur);
      }
    }
    const completion: SubagentCompletion = {
      agentId,
      description: d.description,
      status: d.status ?? 'completed',
      model: model ?? undefined,
      toolUses: typeof d.toolUses === 'number' ? d.toolUses : 0,
      costUsd,
      tokens: typeof d.totalTokens === 'number' ? d.totalTokens : undefined,
      durationMs: d.durationMs,
      error: d.error
    };
    this.ctx.emit({ type: 'subagent', completion });
    const bits: string[] = [completion.status === 'error' ? 'failed' : 'finished'];
    if (model) bits.push(`${model.provider}/${model.model}`);
    if (completion.toolUses) bits.push(`${completion.toolUses} tool ${completion.toolUses === 1 ? 'use' : 'uses'}`);
    if (completion.tokens) bits.push(`${completion.tokens.toLocaleString()} tokens`);
    if (costUsd) bits.push(`$${costUsd.toFixed(4)}`);
    this.info(`Subagent${d.description ? ` "${d.description}"` : ''}: ${bits.join(' · ')}`, completion.status === 'error' ? 'error' : 'info');
  }

  /** Best-effort match of a pi-subagents display name to a known model, for spend attribution. */
  private resolveSubagentModel(name?: string): ModelRef | null {
    if (!name || !this.models.length) return null;
    const norm = (s: string) => s.toLowerCase().replace(/^claude\s+/, '').replace(/[^a-z0-9]/g, '');
    const target = norm(name);
    if (!target) return null;
    for (const m of this.models) {
      if (norm(m.displayName) === target || norm(m.id) === target || norm(modelName(m.provider, m.id)) === target) return { provider: m.provider, model: m.id };
    }
    for (const m of this.models) {
      if (norm(m.displayName).includes(target) || target.includes(norm(m.id))) return { provider: m.provider, model: m.id };
    }
    return null;
  }

  /** Applies the latest per-assistant usage snapshot and publishes a throttled live session update. */
  private reportPiUsage(raw: unknown): void {
    const current = piStreamUsage(raw);
    if (!current) return;
    const delta = piUsageDelta(this.streamUsage, current);
    this.streamUsage = current;
    if (!hasPiUsage(delta)) return;
    this.usage.addUsage({ inputTokens: delta.input, outputTokens: delta.output, cacheReadTokens: delta.cacheRead, cacheWriteTokens: delta.cacheWrite, reasoningTokens: delta.reasoning, costUsd: delta.cost });
    this.usageReporter.report(this.usage.snapshot());
  }

  private async handleUiRequest(req: { id: string; method: string; title?: string; message?: string; options?: string[]; notifyType?: string }): Promise<void> {
    const respond = (payload: Record<string, unknown>) => {
      try {
        this.write({ type: 'extension_ui_response', id: req.id, ...payload });
      } catch {
        /* process gone */
      }
    };
    switch (req.method) {
      case 'select': {
        const title = req.title ?? '';
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
    const marker = [PI_READY_MARKER, PI_EXTENSION_ERROR_MARKER, PI_TOOL_INPUT_MARKER].find((prefix) => message.startsWith(prefix));
    if (!marker) return false;
    try {
      const payload = JSON.parse(message.slice(marker.length)) as Record<string, unknown>;
      if (!payload || payload.version !== 1 || !this.extensionNonce || payload.nonce !== this.extensionNonce) return true;
      if (marker === PI_READY_MARKER && (payload.capability === 'approvals' || payload.capability === 'tools')) {
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
    this.declinedTools.clear();
    this._busy = false;
    if (this.currentAssistant) {
      this.currentAssistant.streaming = false;
      this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
      this.currentAssistant = null;
    }
    let turnCost = 0;
    let turnUsage: Partial<UsageTotals> | undefined;
    try {
      const stats = await withTimeout(
        this.request<{ tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; cost?: number; contextUsage?: { tokens?: number; contextWindow?: number } | null; sessionFile?: string }>('get_session_stats'),
        10_000,
        'get_session_stats'
      );
      if (stats.sessionFile) this.ctx.updateRef({ piSessionFile: stats.sessionFile });
      const t = stats.tokens ?? {};
      this.usage.setCumulative({
        inputTokens: t.input,
        outputTokens: t.output,
        cacheReadTokens: t.cacheRead,
        cacheWriteTokens: t.cacheWrite,
        costUsd: stats.cost,
        contextTokens: stats.contextUsage?.tokens,
        contextWindow: stats.contextUsage?.contextWindow
      });
      const completed = this.usage.finishTurn();
      turnCost = completed.usage?.costUsd ?? 0;
      turnUsage = completed.usage ? { inputTokens: completed.usage.inputTokens, outputTokens: completed.usage.outputTokens } : undefined;
      // Subagent spend accrued since the last report, so analytics can put it on the model that ran it.
      const subagentCostByModel = this.pendingSubagentCost.size ? [...this.pendingSubagentCost.values()] : undefined;
      this.pendingSubagentCost.clear();
      this.usageReporter.report(completed.totals, subagentCostByModel);
      this.usageReporter.flush();
    } catch (e) {
      this.ctx.log('debug', `get_session_stats failed: ${errorMessage(e)}`);
      // Do not leave a throttled live snapshot waiting after a failed stats request.
      this.usageReporter.flush();
    }
    // pi ends a failed turn with an assistant message (stopReason 'error'), not an error event.
    const stopReason = this.lastStopReason;
    const errorMsg = this.lastErrorMessage;
    this.lastStopReason = null;
    this.lastErrorMessage = null;
    const failed = stopReason === 'error' && errorMsg;
    if (failed) this.info(`Turn failed: ${errorMsg}`, 'error');
    this.ctx.emit({
      type: 'item.upsert',
      item: {
        id: shortId('turn_'),
        kind: 'turn',
        ts: Date.now(),
        status: failed ? 'failed' : stopReason === 'aborted' ? 'interrupted' : 'completed',
        // A turn can end after turnStartedAt was reset (or before a start was seen): measuring from
        // 0 would report an epoch-long wall time, so that case carries no duration at all.
        durationMs: this.turnStartedAt > 0 ? Date.now() - this.turnStartedAt : undefined,
        costUsd: turnCost,
        usage: turnUsage,
        error: failed ? errorMsg : undefined
      }
    });
    this.turnStartedAt = 0;
    this.ctx.emit({ type: 'status', status: 'idle' });
  }

  private info(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level, text } });
  }

  async send(input: UserInput): Promise<void> {
    if (!this.child) await this.start();
    this.assertExtensionsReady();
    const images = (input.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }));
    if (this._busy) {
      const type = input.mode === 'queue' ? 'follow_up' : 'steer';
      await this.request(type, { message: input.text, images });
      return;
    }
    this._busy = true;
    this.turnStartedAt = Date.now();
    // Arm the turn here: send() sets turnStartedAt before pi emits agent_start, so the guard in
    // agent_start never fires for a normal prompt and the turn would never be counted.
    this.usage.beginTurn();
    this.ctx.emit({ type: 'status', status: 'running' });
    try {
      await this.request('prompt', { message: input.text, images });
    } catch (e) {
      this._busy = false;
      this.ctx.emit({ type: 'status', status: 'idle' });
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
    await this.writeEffortConfig(this.ctx.effort(), model);
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    await this.request('set_thinking_level', { level: piThinkingLevel(effort) });
    this.ctx.updateMeta({ activeEffort: effort });
    await this.writeEffortConfig(effort, this.ctx.session().activeModel);
  }

  /**
   * Persist the effort the user chose so the bundled extension can forward it to OpenRouter. pi
   * clamps a level against the model's bundled map before each request, and that map can lag
   * OpenRouter's live catalog (it hides `low`/`max` and promotes `max` to `xhigh` for DeepSeek).
   * Only levels the live catalog advertises are written; anything else clears the file so pi's own
   * mapping stands.
   */
  private async writeEffortConfig(effort: EffortLevel | undefined, model: ModelRef | undefined): Promise<void> {
    if (!this.effortFile) return;
    const provider = model ? this.ctx.settings().providers.find((p) => p.kind === 'openrouter' && p.id === model.provider) : undefined;
    const supported = provider?.models.find((m) => m.id === model?.model)?.supportedEfforts;
    const payload = model && effort && supported?.includes(effort) ? { provider: model.provider, model: model.model, effort } : null;
    try {
      await fs.writeFile(this.effortFile, JSON.stringify(payload), 'utf8');
    } catch (e) {
      this.ctx.log('warn', `failed to write pi reasoning effort file: ${errorMessage(e)}`);
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // The approvals extension re-reads this file before every tool call.
    if (!this.modeFile) return;
    try {
      await fs.writeFile(this.modeFile, mode, 'utf8');
    } catch (e) {
      // Surface the failure: silently keeping the old mode active would grant or withhold
      // permissions behind the user's back.
      this.ctx.log('warn', `failed to write permission mode file: ${errorMessage(e)}`);
    }
  }

  async compact(): Promise<void> {
    await this.request('compact', {});
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.child) return [];
    try {
      const res = await withTimeout(this.request<{ models: PiModel[] }>('get_available_models'), 20_000, 'get_available_models');
      this.models = res.models.map(piModelToInfo);
      return this.models;
    } catch (e) {
      this.ctx.log('warn', `get_available_models failed: ${errorMessage(e)}`);
      return this.models;
    }
  }

  async dispose(): Promise<void> {
    this.usageReporter.close();
    this.extensionCapabilities.clear();
    this.declinedTools.clear();
    const child = this.child;
    this.child = null;
    if (!child) return;
    await shutdownChild(child, 1500);
  }
}

/** One-shot model listing: `pi --mode rpc --no-session` + get_available_models. */
export async function listPiModels(piPath: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<ModelInfo[]> {
  const child = spawnTool(piPath, ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills'], { env: { ...process.env, ...extraEnv } });
  const d = deferred<ModelInfo[]>();
  const splitter = new LineSplitter((line) => {
    try {
      const ev = JSON.parse(line) as { type: string; command?: string; success?: boolean; data?: { models: PiModel[] }; error?: string };
      if (ev.type === 'response' && ev.command === 'get_available_models') {
        if (ev.success && ev.data) d.resolve(ev.data.models.map(piModelToInfo));
        else d.reject(new Error(ev.error ?? 'get_available_models failed'));
      }
    } catch {
      /* ignore non-json */
    }
  });
  child.stdout?.on('data', (b: Buffer) => splitter.push(b));
  child.on('error', (e) => d.reject(e));
  child.on('close', () => d.reject(new Error('pi exited before answering')));
  child.stdin?.write(JSON.stringify({ id: 'm1', type: 'get_available_models' }) + '\n');
  try {
    return await withTimeout(d.promise, 45_000, 'pi model list');
  } finally {
    await shutdownChild(child, 1000);
  }
}
