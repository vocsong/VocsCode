import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { assertPermissionModeOffered, isEffortLevel } from '../../shared/harness-meta';
import type { AcpAgentPreset, ApprovalOption, EffortLevel, FileChange, ModelInfo, ModelRef, PermissionMode, TranscriptItem, UserInput } from '../../shared/types';
import { errorMessage, shortId, withTimeout } from '../util/async';
import { makeFileChange } from '../util/file-changes';
import { TurnUsageTracker, type TurnUsage } from '../util/turn-usage';
import { acpModelCatalog, decodeAcpModelValue, findEffortOption, findModelOption, flattenSelect, type ConfigOptionLike } from './acp-config';
import { buildAcpElicitationResponse, planAcpFormElicitation } from './acp-elicitation';
import {
  acpChangesFromContent,
  acpHarnessCommands,
  acpToolHint,
  acpTurnUsage,
  applyAcpToolUpdate,
  buildAcpPromptBlocks,
  mapAcpStopReason,
  type AcpToolCallUpdate
} from './acp-events';
import { resolveAcpLaunch, resolveAcpMcpServers } from './acp-launch';
import { AcpOngoingTracker } from './acp-ongoing';
import { ANTIGRAVITY_SIGN_IN_MESSAGE, connectAcp, isAntigravityAuthRequired } from './antigravity';
import { reportHarnessCommands } from './commands';
import { requiresPathApproval } from './permissions';
import { shutdownChild, spawnTool } from './spawn';
import { isDangerousCommand, isMissionUserCommand, type HarnessAdapter, type HarnessContext } from './types';

export { acpHarnessCommands };

/** ACP's tool kinds (`ToolKind`), minus `other`. */
const ACP_TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode']);

// The ACP prompt result is the only proof of completion. Recover a quiet Antigravity
// stream as failed, not completed, and allow an explicit interrupt even without prose.
export const ANTIGRAVITY_PROMPT_QUIET_MS = 180_000;
export const ANTIGRAVITY_CANCEL_GRACE_MS = 5_000;

type ActivePrompt = {
  startedAt: number;
  quietTimer?: NodeJS.Timeout;
  cancelTimer?: NodeJS.Timeout;
  recovering?: boolean;
};

export class AcpAdapter implements HarnessAdapter {
  private child: ChildProcess | null = null;
  private childShutdown: Promise<void> | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private prompt: ActivePrompt | null = null;
  private pendingPermissions = 0;
  private queue: UserInput[] = [];
  private currentAssistant: Extract<TranscriptItem, { kind: 'assistant' }> | null = null;
  private toolItems = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  private configOptions: ConfigOptionLike[] = [];
  private caps: Record<string, unknown> = {};
  private readonly usage: TurnUsageTracker;
  private sessionAllowedKinds = new Set<string>();
  private preset: AcpAgentPreset | null = null;
  private sessionModes?: acp.SessionModeState | null;
  private applyingMode = false;
  /** Clean ModelRef -> the agent's raw option value (tuple-advertising agents key choices by it). */
  private modelValues = new Map<string, string>();
  private readonly ongoing: AcpOngoingTracker;

  constructor(private readonly ctx: HarnessContext, readonly id: 'acp' | 'antigravity' = 'acp') {
    this.usage = new TurnUsageTracker(ctx.session().usage);
    this.ongoing = new AcpOngoingTracker({
      emit: (event) => this.ctx.emit(event),
      log: (level, message) => this.ctx.log(level, message),
      isTurnActive: () => this.prompt !== null,
      sessionId: () => this.sessionId,
      agentTag: () => this.preset?.id ?? this.id
    });
  }

  get busy(): boolean {
    return this.prompt !== null;
  }

  private async killChild(): Promise<void> {
    if (this.childShutdown) return this.childShutdown;
    const child = this.child;
    this.conn = null;
    this.child = null;
    this.pendingPermissions = 0;
    this.ongoing.clear();
    if (!child) return;
    this.childShutdown = shutdownChild(child, 2000);
    try {
      await this.childShutdown;
    } finally {
      this.childShutdown = null;
    }
  }

  async start(): Promise<void> {
    const meta = this.ctx.session();
    const { preset, command, args, env } = await resolveAcpLaunch(this.ctx, this.id);
    this.preset = preset;
    // Preset args are user-visible configuration, not secrets (keys travel in env).
    this.ctx.log('info', `spawning ACP agent ${preset.id}: ${command} ${args.join(' ')} in ${meta.cwd}`);
    const child = spawnTool(command, args, { cwd: meta.cwd, env });
    this.child = child;
    if (this.id === 'antigravity') child.stderr?.resume();
    else child.stderr?.on('data', (d: Buffer) => this.ctx.log('debug', `[acp:${preset.id}] ${d.toString().trimEnd()}`));
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.conn = null;
      this.pendingPermissions = 0;
      this.ongoing.clear();
      const detail = `${preset.name} exited (${code})`;
      if (this.prompt) this.finishPrompt(this.prompt, 'failed', detail, false);
      this.discardQueue();
      this.ctx.emit({ type: 'status', status: 'stopped', detail });
    });
    child.on('error', (e) => {
      if (this.child === child) this.ctx.emit({ type: 'error', message: `${preset.name} failed to start: ${errorMessage(e)}`, fatal: true });
    });

    try {
      this.conn = connectAcp(child, () => this.clientHandlers(child));

      const init = await withTimeout(
        this.conn.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, elicitation: { form: {} } },
          clientInfo: { name: 'vocs-code', title: 'Vocs Code', version: '0.1.0' }
        } as unknown as acp.InitializeRequest),
        120_000,
        `${preset.name} initialize`
      );
      this.caps = (init.agentCapabilities ?? {}) as Record<string, unknown>;

      const sessionCaps = (this.caps.sessionCapabilities ?? {}) as { resume?: unknown; list?: unknown };
      // HTTP and SSE entries are dropped unless the agent said it understands them.
      const mcpCaps = (this.caps.mcpCapabilities ?? {}) as { http?: boolean; sse?: boolean };
      const mcpServers = await resolveAcpMcpServers(this.ctx, mcpCaps, (msg) => this.info(msg, 'warn'));
      let res: { sessionId: string; configOptions?: unknown[] | null; modes?: acp.SessionModeState | null } | null = null;
      if (meta.harnessRef.acpSessionId && sessionCaps.resume) {
        try {
          const r = await withTimeout(this.conn.resumeSession({ sessionId: meta.harnessRef.acpSessionId, cwd: meta.cwd, mcpServers } as acp.ResumeSessionRequest), 120_000, 'session/resume');
          res = { sessionId: meta.harnessRef.acpSessionId, configOptions: r.configOptions ?? null, modes: r.modes };
        } catch (e) {
          if (this.id === 'antigravity' && isAntigravityAuthRequired(e)) throw e;
          this.info(`Could not resume ACP session (${errorMessage(e)}); starting a new one.`, 'warn');
        }
      }
      if (!res) {
        const r = await withTimeout(this.conn.newSession({ cwd: meta.cwd, mcpServers }), 180_000, 'session/new');
        res = { sessionId: r.sessionId, configOptions: r.configOptions ?? null, modes: r.modes };
      }
      this.sessionId = res.sessionId;
      this.sessionModes = res.modes;
      this.configOptions = (res.configOptions ?? []) as ConfigOptionLike[];
      await this.setPermissionMode(this.ctx.permissionMode());
      this.ctx.updateRef({ acpSessionId: this.sessionId });
      this.publishModels();

      // Apply the configured model / effort if the agent exposes them.
      if (meta.config.model?.model) await this.setModel(meta.config.model).catch((e) => this.ctx.log('warn', `setModel: ${errorMessage(e)}`));
      const effort = this.ctx.effort();
      if (effort) await this.setEffort(effort).catch((e) => this.ctx.log('debug', `setEffort(${effort}) not applied: ${errorMessage(e)}`));
    } catch (e) {
      // Handshake failed: tear the agent down so it cannot linger holding injected API keys.
      await this.killChild();
      if (this.id === 'antigravity' && isAntigravityAuthRequired(e)) throw new Error(ANTIGRAVITY_SIGN_IN_MESSAGE);
      throw e;
    }
    this.ctx.emit({ type: 'status', status: 'idle' });
  }

  private modelOption(): ConfigOptionLike | undefined {
    return findModelOption(this.configOptions);
  }

  private effortOption(): ConfigOptionLike | undefined {
    return findEffortOption(this.configOptions);
  }

  private publishModels(): void {
    const opt = this.modelOption();
    if (!opt) return;
    const eff = this.effortOption();
    this.modelValues.clear();
    const models: ModelInfo[] = acpModelCatalog(this.configOptions, this.preset?.id ?? 'acp').map(({ model, value }) => {
      this.modelValues.set(`${model.provider}\u0000${model.id}`, value);
      return model;
    });
    this.ctx.emit({ type: 'models', models });
    const currentValue = typeof opt.currentValue === 'string' ? opt.currentValue : undefined;
    const currentDecoded = currentValue ? decodeAcpModelValue(currentValue) : null;
    const current = models.find((m) => (currentDecoded ? m.provider === currentDecoded.provider && m.id === currentDecoded.model : m.id === currentValue));
    if (current) this.ctx.updateMeta({ activeModel: { provider: current.provider, model: current.id } });
    if (eff && isEffortLevel(eff.currentValue)) this.ctx.updateMeta({ activeEffort: eff.currentValue });
  }

  private clientHandlers(child: ChildProcess): acp.Client {
    const cwd = () => this.ctx.session().cwd;
    return {
      requestPermission: async (params: acp.RequestPermissionRequest) => {
        if (this.child !== child || this.prompt?.recovering) return { outcome: { outcome: 'cancelled' } };
        this.pendingPermissions++;
        this.armQuietTimer();
        try {
          return await this.onRequestPermission(params);
        } finally {
          if (this.child === child) {
            this.pendingPermissions--;
            this.armQuietTimer();
          }
        }
      },
      createElicitation: async (params: acp.CreateElicitationRequest) => {
        if (this.child !== child || this.prompt?.recovering) return { action: 'cancel' };
        this.pendingPermissions++;
        this.armQuietTimer();
        try {
          return await this.onCreateElicitation(params, child);
        } catch (e) {
          this.ctx.log('warn', `acp elicitation cancelled: ${errorMessage(e)}`);
          return { action: 'cancel' };
        } finally {
          if (this.child === child) {
            this.pendingPermissions--;
            this.armQuietTimer();
          }
        }
      },
      sessionUpdate: async (params: acp.SessionNotification) => {
        if (this.child !== child || this.prompt?.recovering) return;
        this.onSessionUpdate(params);
        this.armQuietTimer();
      },
      extNotification: async (method: string, params: Record<string, unknown>) => {
        if (this.child !== child || this.prompt?.recovering) return;
        this.ongoing.onExtNotification(method, params);
      },
      // ACP reads intentionally retain the adapter-wide read policy: an absolute path is allowed
      // even when it is outside the session workspace. Writes and commands still go through the
      // permission gate; callers should only use ACP with an agent they trust.
      readTextFile: async (params: acp.ReadTextFileRequest) => {
        const p = params as { path: string; line?: number | null; limit?: number | null };
        const abs = path.isAbsolute(p.path) ? p.path : path.join(cwd(), p.path);
        let content = await fs.readFile(abs, 'utf8');
        if (p.line || p.limit) {
          const lines = content.split('\n');
          const start = Math.max(0, (p.line ?? 1) - 1);
          content = lines.slice(start, p.limit ? start + p.limit : undefined).join('\n');
        }
        return { content };
      },
      writeTextFile: async (params: acp.WriteTextFileRequest) => {
        const p = params as { path: string; content: string };
        const abs = path.isAbsolute(p.path) ? p.path : path.join(cwd(), p.path);
        const mode = this.ctx.permissionMode();
        if (mode === 'plan') throw new Error('Plan mode: writes are disabled');
        const outside = mode !== 'full-auto' && mode !== 'ask' && await requiresPathApproval(cwd(), abs);
        if (mode === 'ask' || outside) {
          let before = '';
          try {
            before = await fs.readFile(abs, 'utf8');
          } catch {
            /* new file */
          }
          const rel = path.relative(cwd(), abs) || p.path;
          const d = await this.ctx.requestApproval({
            kind: 'file_change',
            title: `Write ${rel}?`,
            changes: [makeFileChange(cwd(), rel, before || null, p.content, { addWhenEmpty: true })],
            options: [
              { id: 'allow', label: 'Allow', kind: 'allow' },
              { id: 'deny', label: 'Deny', kind: 'deny' }
            ]
          });
          if (d.optionId !== 'allow') throw new Error('User declined the write');
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, p.content, 'utf8');
        return {};
      }
    } as unknown as acp.Client;
  }

  private async onRequestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const tc = params.toolCall as unknown as { toolCallId: string; title?: string | null; kind?: string | null; rawInput?: unknown; content?: unknown[] | null; locations?: { path: string }[] | null };
    const options = params.options as { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[];
    const pick = (kinds: string[]): string | undefined => {
      for (const k of kinds) {
        const o = options.find((x) => x.kind === k);
        if (o) return o.optionId;
      }
      return undefined;
    };
    const mode = this.ctx.permissionMode();
    const kind = tc.kind ?? 'other';
    const isEdit = kind === 'edit' || kind === 'delete' || kind === 'move';
    const isRead = kind === 'read' || kind === 'search' || kind === 'fetch' || kind === 'think';
    const raw = (tc.rawInput ?? {}) as Record<string, unknown>;
    const command = typeof raw.command === 'string' ? raw.command : Array.isArray(raw.command) ? raw.command.join(' ') : undefined;
    const dangerous = !!command && isDangerousCommand(command);
    const cwd = this.ctx.session().cwd;

    const selected = (optionId: string): acp.RequestPermissionResponse => ({ outcome: { outcome: 'selected', optionId } });
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    // Every grant the agent receives is one-time: an "always" answer would let the agent stop asking,
    // and a later, stricter Vocs Code tier could no longer gate that tool. A generic agent that offers
    // no allow_once option still gets its allow_always one, or it could never run anything.
    const allow = () => {
      const id = pick(this.id === 'antigravity' ? ['allow_once'] : ['allow_once', 'allow_always']);
      return id ? selected(id) : cancelled;
    };
    const reject = () => {
      const id = pick(['reject_once', 'reject_always']);
      return id ? selected(id) : cancelled; // no reject option → cancel rather than accidentally allow
    };
    const builder = this.ctx.session().mission?.role === 'builder';
    // ACP does not say which tool a request is for. For a Mission Builder, anything the agent files
    // as `other` (or a kind ACP does not define), or titles as an MCP tool, may be a third-party MCP
    // tool that publishes, so it is asked about in every tier — the Builder's own Mission tools
    // included, since a server-chosen title could claim to be one of them.
    const opaque = builder && (!ACP_TOOL_KINDS.has(kind) || /^mcp__/i.test(tc.title ?? ''));
    if (isRead && !opaque) return allow();
    if (mode === 'plan') return reject();
    // A Mission Builder never publishes or elevates on its own, in any tier (gateAction's
    // `missionBuilder` rule): the request goes to the Lead and on to the user.
    const missionUser = opaque || (builder && !!command && isMissionUserCommand(command));
    if (mode === 'full-auto' && !missionUser) return allow();
    // Real-path check: a symlink or junction inside the project that leads out of it counts as outside.
    const outsideWorkspace = (await Promise.all((tc.locations ?? []).map((l) => requiresPathApproval(cwd, l.path)))).some(Boolean);
    if (!dangerous && !outsideWorkspace && !missionUser) {
      if (mode === 'auto') return allow();
      if (mode === 'accept-edits' && isEdit) return allow();
      if (this.sessionAllowedKinds.has(kind)) return allow();
    }

    const offered = this.id === 'antigravity' ? options.filter((option) => option.kind === 'allow_once' || option.kind === 'reject_once') : options;
    if (!offered.length) return cancelled;
    // The agent's "always allow" becomes an app-side "Allow for session": it is kept here, cleared on
    // any tier change, and never forwarded to the agent as a persistent rule.
    const ourOptions: ApprovalOption[] = offered.map((o) =>
      o.kind === 'allow_always'
        ? { id: o.optionId, label: 'Allow for session', kind: 'allow_session', description: `Do not ask again for ${kind} actions in this session.` }
        : { id: o.optionId, label: o.name, kind: o.kind === 'allow_once' ? 'allow' : o.kind === 'reject_once' ? 'deny' : 'deny_always' }
    );
    const changes = this.changesFromContent(tc.content ?? undefined);
    const decision = await this.ctx.requestApproval({
      kind: command ? 'command' : isEdit ? 'file_change' : 'tool',
      title: tc.title ?? `Allow ${kind}?`,
      description: outsideWorkspace ? 'Touches paths outside the project directory.' : undefined,
      toolName: kind,
      command,
      cwd,
      input: tc.rawInput,
      changes: changes?.length ? changes : tc.locations?.length ? tc.locations.map((l) => ({ path: l.path, kind: 'update' as const })) : undefined,
      toolItemId: tc.toolCallId,
      options: ourOptions
    });
    const chosen = offered.find((o) => o.optionId === decision.optionId);
    if (!chosen) return { outcome: { outcome: 'cancelled' } };
    if (chosen.kind === 'allow_always') {
      this.sessionAllowedKinds.add(kind);
      // Answer with the agent's one-time option. Only when it offered none is the chosen option sent,
      // since cancelling would refuse an action the user just allowed.
      return selected(pick(['allow_once']) ?? chosen.optionId);
    }
    return selected(chosen.optionId);
  }

  private async onCreateElicitation(params: acp.CreateElicitationRequest, child: ChildProcess): Promise<acp.CreateElicitationResponse> {
    if ('sessionId' in params && typeof params.sessionId === 'string' && this.sessionId && params.sessionId !== this.sessionId) {
      return { action: 'cancel' };
    }
    const agentName = this.id === 'antigravity' ? 'Antigravity' : this.preset?.name ?? 'ACP agent';
    const plan = planAcpFormElicitation(params, agentName);
    if (!plan) return { action: 'decline' };
    const decision = await this.ctx.requestApproval({
      kind: 'question',
      title: plan.title,
      description: plan.description,
      toolItemId: plan.toolItemId,
      supportsQuestionComment: plan.supportsQuestionComment,
      options: [
        { id: 'allow', label: 'Answer', kind: 'allow' },
        { id: 'deny', label: 'Skip', kind: 'deny' }
      ],
      questions: plan.questions
    });
    if (this.child !== child || this.prompt?.recovering) return { action: 'cancel' };
    return buildAcpElicitationResponse(plan, decision);
  }

  private changesFromContent(content: unknown[] | undefined): FileChange[] | undefined {
    return acpChangesFromContent(this.ctx.session().cwd, content);
  }

  private onSessionUpdate(params: acp.SessionNotification): void {
    const u = params.update as unknown as Record<string, unknown> & { sessionUpdate: string };
    if (this.sessionId && params.sessionId && params.sessionId !== this.sessionId) {
      this.ongoing.onChildSessionUpdate(params.sessionId, u);
      return;
    }
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const block = u.content as { type: string; text?: string };
        if (block.type === 'text' && block.text) {
          const a = this.ensureAssistant();
          a.text += block.text;
          this.ctx.emit({ type: 'item.delta', id: a.id, textDelta: block.text });
        }
        return;
      }
      case 'agent_thought_chunk': {
        const block = u.content as { type: string; text?: string };
        if (block.type === 'text' && block.text) {
          const a = this.ensureAssistant();
          a.thinking = (a.thinking ?? '') + block.text;
          this.ctx.emit({ type: 'item.delta', id: a.id, thinkingDelta: block.text });
        }
        return;
      }
      case 'user_message_chunk':
        return;
      case 'tool_call':
      case 'tool_call_update': {
        const t = u as unknown as AcpToolCallUpdate;
        let item = this.toolItems.get(t.toolCallId);
        if (!item) {
          this.closeAssistant();
          item = { id: t.toolCallId, kind: 'tool', ts: Date.now(), name: t.kind ?? 'tool', title: t.title ?? undefined, hint: acpToolHint(t.kind), status: 'running', input: t.rawInput, summary: t.title ?? undefined };
          this.toolItems.set(t.toolCallId, item);
        }
        applyAcpToolUpdate(this.ctx.session().cwd, item, t);
        this.ctx.emit({ type: 'item.upsert', item: { ...item } });
        this.ongoing.syncBackgroundTool(item, t);
        return;
      }
      case 'terminal_update':
        this.ongoing.onTerminalUpdate(u);
        return;
      case 'background_tasks_changed':
        this.ongoing.applyBackgroundTasksSnapshot(u.tasks ?? u.items);
        return;
      case 'background_task_update':
      case 'subagent_update':
      case 'schedule_update':
        this.ongoing.applyOngoingEdgeUpdate(u.sessionUpdate, u);
        return;
      case 'plan': {
        const p = u as unknown as { entries: { content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: string }[] };
        this.ctx.emit({ type: 'item.upsert', item: { id: 'plan', kind: 'plan', ts: Date.now(), entries: p.entries } });
        return;
      }
      case 'usage_update': {
        const p = u as unknown as { used: number; size: number; cost?: { amount?: number; total?: number; value?: number } | null };
        const cost = p.cost?.amount ?? p.cost?.total ?? p.cost?.value;
        this.usage.setCumulative({ contextTokens: p.used, contextWindow: p.size, costUsd: typeof cost === 'number' ? cost : undefined });
        this.ctx.emit({ type: 'usage', totals: this.usage.snapshot() });
        return;
      }
      case 'config_option_update': {
        const p = u as unknown as { configOptions: ConfigOptionLike[] };
        this.configOptions = p.configOptions;
        this.publishModels();
        return;
      }
      case 'session_info_update': {
        const p = u as unknown as { title?: string | null };
        if (p.title && /^New session|^Untitled/i.test(this.ctx.session().title)) this.ctx.updateMeta({ title: p.title });
        return;
      }
      case 'available_commands_update': {
        // The agent re-sends its whole list whenever it changes; a command runs as `/name args`
        // prompt text, which is what the composer already sends.
        reportHarnessCommands(this.ctx, acpHarnessCommands((u as unknown as { availableCommands?: unknown }).availableCommands));
        return;
      }
      case 'current_mode_update':
      case 'plan_update':
      case 'plan_removed':
      case 'state_update':
      case 'terminal_output_chunk':
        return;
      case 'compaction_update':
        this.info('The agent compacted its context.');
        return;
      default:
        this.ctx.log('debug', `[acp:${this.preset?.id ?? this.id}] unhandled sessionUpdate: ${u.sessionUpdate}`);
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

  private closeAssistant(): void {
    if (!this.currentAssistant) return;
    this.currentAssistant.streaming = false;
    if (this.currentAssistant.text || this.currentAssistant.thinking) this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
    this.currentAssistant = null;
  }

  private info(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level, text } });
  }

  async send(input: UserInput): Promise<void> {
    if (this.prompt?.recovering || this.childShutdown) throw new Error('The ACP agent is stopping. Retry once it stops.');
    if (!this.conn) await this.start();
    if (!this.conn || !this.sessionId) throw new Error('ACP session is not ready');
    if (this.applyingMode) throw new Error('Wait for the Antigravity permission update to finish.');
    if (this.prompt) {
      this.queue.push(input);
      this.ctx.updateMeta({ queued: this.queue.length });
      return;
    }
    const promptCaps = (this.caps.promptCapabilities ?? {}) as { image?: boolean };
    const blocks = buildAcpPromptBlocks(input, promptCaps, (msg) => this.info(msg, 'warn'));
    this.toolItems.clear();
    const turn: ActivePrompt = { startedAt: Date.now() };
    this.prompt = turn;
    this.usage.beginTurn();
    this.ongoing.emitTasks();
    this.ctx.emit({ type: 'status', status: 'running' });
    void this.conn.prompt({ sessionId: this.sessionId, prompt: blocks } as acp.PromptRequest).then(
      (res) => {
        if (this.prompt !== turn || turn.recovering) return;
        const { status, error } = mapAcpStopReason(res.stopReason);
        this.finishPrompt(turn, status, error, true, acpTurnUsage(res.usage));
        this.drainQueue();
      },
      (e) => {
        if (this.prompt !== turn || turn.recovering) return;
        const error = this.id === 'antigravity' && isAntigravityAuthRequired(e) ? ANTIGRAVITY_SIGN_IN_MESSAGE : errorMessage(e);
        this.finishPrompt(turn, 'failed', error, false);
        this.drainQueue();
      }
    );
  }

  private finishPrompt(turn: ActivePrompt, status: Extract<TranscriptItem, { kind: 'turn' }>['status'], error?: string, count = true, reported?: TurnUsage): void {
    clearTimeout(turn.quietTimer);
    clearTimeout(turn.cancelTimer);
    this.closeAssistant();
    if (!count) {
      for (const item of this.toolItems.values()) {
        if (item.status === 'running') this.ctx.emit({ type: 'item.upsert', item: { ...item, status: 'error' } });
      }
    }
    if (reported) this.usage.addUsage(reported);
    const completed = this.usage.finishTurn(count);
    if (count) this.ctx.emit({ type: 'usage', totals: completed.totals });
    // Only a turn the agent reported tokens for carries them, so an agent that reports none never
    // shows a 0-token turn or contributes a speed sample.
    const usage = reported ? completed.usage : undefined;
    this.ctx.emit({ type: 'item.upsert', item: { id: shortId('turn_'), kind: 'turn', ts: Date.now(), status, durationMs: Date.now() - turn.startedAt, usage, error } });
    this.prompt = null;
    this.ongoing.emitTasks();
  }

  private drainQueue(): void {
    if (!this.conn) return;
    this.ctx.emit({ type: 'status', status: 'idle' });
    const next = this.queue.shift();
    this.ctx.updateMeta({ queued: this.queue.length });
    if (next) void this.send(next);
  }

  private discardQueue(): void {
    if (!this.queue.length) return;
    this.queue = [];
    this.ctx.updateMeta({ queued: 0 });
    this.info('Queued messages were not sent. Resend them after checking the workspace.', 'warn');
  }

  private armQuietTimer(): void {
    const turn = this.prompt;
    if (this.id !== 'antigravity' || !turn || turn.recovering || turn.cancelTimer) return;
    clearTimeout(turn.quietTimer);
    if (!this.currentAssistant?.text.trim() || this.pendingPermissions || [...this.toolItems.values()].some((item) => item.status === 'running')) return;
    turn.quietTimer = setTimeout(() => {
      void this.recoverPrompt(turn, 'failed', 'Antigravity stopped sending updates without confirming the turn ended. The reply was kept; check the workspace before retrying.');
    }, ANTIGRAVITY_PROMPT_QUIET_MS).unref();
  }

  private async recoverPrompt(turn: ActivePrompt, status: 'failed' | 'interrupted', detail: string): Promise<void> {
    if (this.prompt !== turn || turn.recovering) return;
    turn.recovering = true;
    clearTimeout(turn.quietTimer);
    clearTimeout(turn.cancelTimer);
    // A prompt cannot be retried safely on a connection that may still be doing work.
    await this.killChild();
    if (this.prompt !== turn) return;
    this.finishPrompt(turn, status, detail, false);
    this.discardQueue();
    this.ctx.emit({ type: 'status', status: 'stopped', detail });
  }

  async interrupt(): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    const turn = this.prompt;
    if (this.id === 'antigravity' && turn && !turn.cancelTimer) {
      clearTimeout(turn.quietTimer);
      turn.cancelTimer = setTimeout(() => {
        void this.recoverPrompt(turn, 'interrupted', 'Antigravity did not acknowledge the interrupt. Its CLI was stopped; check the workspace before retrying.');
      }, ANTIGRAVITY_CANCEL_GRACE_MS).unref();
    }
    const cancel = this.conn.cancel({ sessionId: this.sessionId }).catch((e) => {
      this.ctx.log('warn', `cancel failed: ${errorMessage(e)}`);
    });
    // A stuck write must not hold the caller open; recovery is tied to the prompt result.
    if (this.id !== 'antigravity') await cancel;
  }

  async setModel(model: ModelRef): Promise<void> {
    const opt = this.modelOption();
    if (!this.conn || !this.sessionId || !opt) throw new Error('This agent does not expose a model option.');
    // Send the agent's raw option value: tuple-advertising agents (dsh) key their choices by it.
    const raw =
      this.modelValues.get(`${model.provider}\u0000${model.model}`) ??
      [...this.modelValues.entries()].find(([k]) => k.endsWith(`\u0000${model.model}`))?.[1] ??
      model.model;
    const res = await this.conn.setSessionConfigOption({ sessionId: this.sessionId, configId: opt.id, value: raw } as acp.SetSessionConfigOptionRequest);
    this.configOptions = (res.configOptions ?? this.configOptions) as ConfigOptionLike[];
    this.ctx.updateMeta({ activeModel: model });
    this.publishModels();
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    const opt = this.effortOption();
    if (!this.conn || !this.sessionId || !opt) return;
    const values = flattenSelect(opt).map((o) => o.value);
    if (!values.includes(effort)) return;
    const res = await this.conn.setSessionConfigOption({ sessionId: this.sessionId, configId: opt.id, value: effort } as acp.SetSessionConfigOptionRequest);
    this.configOptions = (res.configOptions ?? this.configOptions) as ConfigOptionLike[];
    this.ctx.updateMeta({ activeEffort: effort });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // A grant made under one tier must not outlive it, for every ACP agent.
    this.sessionAllowedKinds.clear();
    if (this.id !== 'antigravity') return; // Other ACP agents use client-side policy.
    assertPermissionModeOffered(this.id, mode);
    if (!this.conn || !this.sessionId) return;
    if (this.busy || this.applyingMode) throw new Error('Wait for the current Antigravity activity before changing permissions.');
    // Every mode but Plan runs the CLI in `default` under its strict tool policy, so each tool call
    // reaches onRequestPermission and Accept edits / Auto / Full access are enforced client-side.
    const modeId = mode === 'plan' ? 'plan' : 'default';
    if (!this.sessionModes?.availableModes.some((value) => value.id === modeId)) {
      throw new Error('Antigravity CLI did not offer the requested permission mode. Update the CLI and retry.');
    }
    this.applyingMode = true;
    try {
      await withTimeout(this.conn.setSessionMode({ sessionId: this.sessionId, modeId }), 10_000, 'Antigravity permission mode');
    } catch (error) {
      // The server may have applied the mode even though the acknowledgement was lost.
      // Reconnect and apply the saved mode before accepting another prompt.
      await this.killChild();
      throw error;
    } finally {
      this.applyingMode = false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const opt = this.modelOption();
    if (!opt) return [];
    return flattenSelect(opt).map((o) => {
      const decoded = decodeAcpModelValue(o.value);
      return {
        id: decoded?.model ?? o.value,
        provider: decoded?.provider ?? this.preset?.id ?? 'acp',
        displayName: o.name || decoded?.model || o.value,
        description: o.description ?? undefined
      };
    });
  }

  async dispose(): Promise<void> {
    const conn = this.conn;
    const turn = this.prompt;
    if (turn) {
      turn.recovering = true;
      clearTimeout(turn.quietTimer);
      clearTimeout(turn.cancelTimer);
    }
    this.conn = null;
    this.queue = [];
    if (conn && !turn && this.sessionId) {
      const sessionCaps = (this.caps.sessionCapabilities ?? {}) as { close?: unknown };
      if (sessionCaps.close) await withTimeout(conn.closeSession({ sessionId: this.sessionId } as acp.CloseSessionRequest), 5000, 'session/close').catch(() => undefined);
    }
    await this.killChild();
    if (this.prompt) this.finishPrompt(this.prompt, 'interrupted', undefined, false);
  }
}
