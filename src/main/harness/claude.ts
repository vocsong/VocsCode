/** Claude Agent SDK adapter: streaming query() turns, canUseTool approvals and file-change hooks, normalized to SessionEvents. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  query,
  type CanUseTool,
  type HookCallback,
  type ModelUsage,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand
} from '@anthropic-ai/claude-agent-sdk';
import { isBuiltinMissionMcpName, isBuiltinTrustedMcpName } from '../../shared/builtin-tools';
import { fastModeSupport } from '../../shared/fast-mode';
import { isClaudeGatewayProvider } from '../../shared/providers';
import { subagentSupport, type AgentTypeInfo } from '../../shared/subagents';
import type { ObservedSubscriptionWindow } from '../../shared/subscription-usage';
import type { EffortLevel, ModelInfo, ModelRef, PermissionMode, TranscriptItem, UserInput } from '../../shared/types';
import { toClaude } from '../mcp/effective';
import { claudeSdkCatalog } from '../models/claude-catalog';
import { modelsForProvider } from '../models/static-models';
import { subagentDir } from '../subagents';
import { AsyncQueue, deferred, errorMessage, shortId, truncate, withTimeout, type Deferred } from '../util/async';
import { makeFileChange } from '../util/file-changes';
import { ClaudeGatewayBridges, GATEWAY_BRIDGES, GATEWAY_ENV_NAMES, gatewayBridgeFor } from './claude-gateway-mcp';
import { ClaudeOngoingTracker } from './claude-ongoing';
import {
  claudeHarnessCommands,
  claudeProjectInstructions,
  claudeProviderEnv,
  claudeProviderFor,
  listClaudeModels,
  MAX_CONCURRENT_SUBAGENTS,
  resolveClaudeProviderEnv,
  scrubClaudeLaunchEnv,
  subagentModelEnv
} from './claude-provider';
import { SUBAGENT_TOOLS, ClaudeSubagentRuns, type NestedAssistantLike, type TaskNotificationLike, type TaskProgressLike, type TaskStartedLike, type TaskUpdatedLike } from './claude-subagents';
import { allowsSubscriptionObservation, ClaudeSubscriptionTracker } from './claude-subscription';
import {
  askClaudeUserQuestion,
  DELEGATION_TOOLS,
  EDIT_TOOLS,
  extractText,
  previewClaudeChange,
  READ_ONLY_TOOLS,
  SESSION_CONTROL_TOOLS,
  summarizeInput,
  toolHint,
  toSdkMode
} from './claude-tools';
import { ClaudeUsageTracker } from './claude-usage';
import { reportHarnessCommands } from './commands';
import { gateAction, OPTIONS_ALLOW_DENY, PLAN_MODE_DENIAL, requiresPathApproval, type GateVerdict } from './permissions';
import { missionPrompt, sessionAppendPrompt } from './system-prompt';
import type { HarnessAdapter, HarnessContext } from './types';

export { claudeHarnessCommands, claudeProjectInstructions, claudeProviderEnv, claudeProviderFor, listClaudeModels, resolveClaudeProviderEnv };

interface ContentBlockLike {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly id = 'claude' as const;
  private q: Query | null = null;
  private readonly subscription = new ClaudeSubscriptionTracker();
  private fastMode = false;
  private fastModeModel: ModelRef | undefined;
  private input = new AsyncQueue<SDKUserMessage>();
  private abort = new AbortController();
  private pump: Promise<void> | null = null;
  private _busy = false;
  private sessionId: string | undefined;
  /** Anthropic-compatible provider this process was started against; its endpoint is fixed for the process lifetime. */
  private providerId: string | undefined;
  /** True when the endpoint is a third-party gateway, whose catalog the settings own — the SDK's
   *  Anthropic model list must not replace it. */
  private gateway = false;
  private sessionAllowed = new Set<string>();
  /** Built-in MCP servers this process was handed through `options.mcpServers`; only their
   * read-only tools run on every tier. */
  private builtinServers = new Map<string, 'dynamic' | 'sdk'>();
  private currentAssistant: { id: string; text: string; thinking: string } | null = null;
  private toolItems = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  private fileSnapshots = new Map<string, string | null>();
  private turnStartedAt = 0;
  private readonly usage: ClaudeUsageTracker;
  private started = false;
  private modelsEmitted = false;
  private compactionWaiter: Deferred<void> | null = null;
  /** Token window the app wants the CLI to compact at; undefined until configured, null for the CLI's own default. */
  private autoCompactionWindow: number | null | undefined;
  /** Records the delegated runs Claude Code spawns, so the Subagents panel can show them. */
  private readonly subagents: ClaudeSubagentRuns;
  private readonly ongoing: ClaudeOngoingTracker;
  /** Manages in-process gateway bridges (memory, Mission) opened for this launch. */
  private readonly gatewayBridges = new ClaudeGatewayBridges();

  constructor(private readonly ctx: HarnessContext) {
    this.usage = new ClaudeUsageTracker(ctx.session().usage, {
      emit: (event) => this.ctx.emit(event),
      providerId: () => this.providerId,
      activeModel: () => this.ctx.session().activeModel?.model,
      providers: () => this.ctx.settings().providers
    });
    this.subagents = new ClaudeSubagentRuns({
      // Recording is a side feature: a context without a session directory turns it off rather
      // than making the adapter unconstructible.
      dir: ctx.sessionDir && subagentSupport('claude').runs ? subagentDir(ctx.sessionDir, 'claude') : null,
      cwd: ctx.session().cwd,
      providerId: () => this.providerId,
      models: () => modelsForProvider(this.ctx.settings().providers, this.providerId),
      emit: (event) => this.ctx.emit(event),
      log: (level, message) => this.ctx.log(level, message)
    });
    this.ongoing = new ClaudeOngoingTracker({
      emit: (event) => this.ctx.emit(event),
      lookupSubagentByTaskId: (taskId) => this.subagents.lookupByTaskId(taskId)
    });
  }

  get busy(): boolean {
    return this._busy;
  }

  private async buildOptions(): Promise<Options> {
    const s = this.ctx.settings();
    const meta = this.ctx.session();
    const cfg = meta.config;
    // The engine reads the project's own CLAUDE.md through `settingSources`; everything it does not
    // read is appended here, so every harness starts from the same instruction files.
    const project = s.claude.settingSources.includes('project') ? await claudeProjectInstructions(meta.cwd) : undefined;
    const append = [project, sessionAppendPrompt(meta, await this.ctx.appInstructions?.(), await missionPrompt(this.ctx))].filter(Boolean).join('\n\n') || undefined;
    const mode = this.ctx.permissionMode();
    const bin = this.ctx.runtime.resolve('claude');
    // Windows cannot launch a batch shim through the SDK's shell-free spawn. If the resolver
    // found no native executable, fail before query() instead of falling into an opaque SDK error.
    if (process.platform === 'win32' && !bin) throw new Error('Claude Agent SDK needs a native Claude Code executable. Reinstall Vocs Code (or run npm install --include=dev in a dev checkout), or select a native .exe; npm .cmd/.bat shims cannot be spawned.');
    const env = scrubClaudeLaunchEnv(process.env, GATEWAY_ENV_NAMES);
    // After the scrub, which would otherwise drop it with every other CLAUDE_CODE_* variable. The
    // SDK reads the cap from the child's environment and, left alone, applies its own default.
    env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(MAX_CONCURRENT_SUBAGENTS);

    const options: Options = {
      cwd: meta.cwd,
      model: cfg.model?.model || meta.activeModel?.model,
      permissionMode: toSdkMode(mode),
      canUseTool: this.canUseTool,
      includePartialMessages: true,
      includeHookEvents: true,
      // Without this the SDK forwards only a subagent's tool_use/tool_result blocks, so a delegated
      // run reaches the Subagents panel with no transcript of its own.
      forwardSubagentText: true,
      persistSession: true,
      env,
      abortController: this.abort,
      settingSources: s.claude.settingSources,
      // Flag-tier settings are an explicit SDK opt-in; never inherit a paid user preference.
      settings: { fastMode: this.fastMode && fastModeSupport(this.id, this.fastModeModel, s.providers).supported },
      systemPrompt: append
        ? { type: 'preset', preset: 'claude_code', append }
        : { type: 'preset', preset: 'claude_code' },
      maxBudgetUsd: cfg.maxBudgetUsd,
      enableFileCheckpointing: true,
      stderr: (line: string) => this.ctx.log('debug', `[claude] ${line}`),
      hooks: {
        PreToolUse: [{ hooks: [this.preToolUse] }],
        PostToolUse: [{ hooks: [this.postToolUse] }]
      }
    };
    // A mission session hands work to Builders, never to Claude Code's own subagents.
    if (meta.mission) options.disallowedTools = [...DELEGATION_TOOLS];
    const effort = this.ctx.effort();
    if (effort && effort !== 'minimal') options.effort = effort;
    if (bin) options.pathToClaudeCodeExecutable = bin.path;
    if (meta.harnessRef.claudeSessionId) {
      options.resume = meta.harnessRef.claudeSessionId;
      if (meta.harnessRef.forkOnResume) {
        options.forkSession = true;
        this.ctx.updateRef({ forkOnResume: false });
      }
    }
    return options;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const meta = this.ctx.session();
    this.fastModeModel = meta.config.model ?? meta.activeModel;
    this.fastMode = meta.config.fastMode === true;
    const support = fastModeSupport(this.id, this.fastModeModel, this.ctx.settings().providers);
    this.ctx.updateMeta({ fastModeStatus: !this.fastMode ? { state: 'off' } : support.supported ? { state: 'requested' } : { state: 'unavailable', detail: support.reason } });
    const options = await this.buildOptions();
    // `strictMcpConfig` stays unset on purpose: the user's own ~/.claude.json and plugin servers
    // must keep working alongside the ones this app injects. With 'project' in settingSources
    // Claude also reads <cwd>/.mcp.json itself, so a repo server this app passes is declared
    // twice under one name; injecting it is still the reliable route, because Claude's
    // project-scope trust prompt has no interactive path in SDK mode (docs/MCP.md §11).
    const mcp = (await this.ctx.mcpServers().catch((e) => {
      this.ctx.log('warn', `mcp: ${errorMessage(e)}`);
      return [];
    })).map(({ def }) => def);
    // The SDK serializes process MCP configs (including stdio env) into --mcp-config argv.
    const gatewayDefs = mcp.filter((def) => gatewayBridgeFor(def));
    const processServers = mcp.filter((def) => !gatewayDefs.includes(def));
    // Built-in servers this process hands Claude, keyed to the source Claude reports for them:
    // `dynamic` for --mcp-config; the in-process gateway bridges below register as `sdk`.
    this.builtinServers = new Map(processServers.filter((def) => def.builtin === def.id).map((def) => [def.id, 'dynamic' as const]));
    if (processServers.length) options.mcpServers = toClaude(processServers);
    const s = this.ctx.settings();
    const provider = claudeProviderFor(s, this.ctx.session().config.model ?? this.ctx.session().activeModel);
    if (provider) this.providerId = provider.id;
    this.gateway = isClaudeGatewayProvider(provider);
    const overlay = await resolveClaudeProviderEnv(s, provider, (id) => this.ctx.getApiKey(id));
    let auth = 'login';
    if (Object.keys(overlay).length) {
      options.env = { ...(options.env ?? {}), ...overlay };
      auth = overlay.ANTHROPIC_BASE_URL ? 'configured-endpoint' : 'stored-key';
    }
    options.env = { ...(options.env ?? {}), ...(await subagentModelEnv(meta.config.projectRoot, options.model)) };
    this.ctx.log('info', `claude runtime: ${options.pathToClaudeCodeExecutable ?? 'SDK-bundled'}; model=${options.model ?? 'default'} mode=${options.permissionMode}${options.resume ? ` resume=${options.resume}${options.forkSession ? ' (fork)' : ''}` : ''}${mcp.length ? ` mcp=${mcp.length}` : ''}${provider ? ` auth=${auth} provider=${provider.id}` : ''}`);
    for (const kind of GATEWAY_BRIDGES) {
      const defs = gatewayDefs.filter((def) => def.id === kind.id);
      if (!defs.length) continue;
      const bridge = defs.length === 1 ? await this.gatewayBridges.open(defs[0]!, kind, meta.cwd, this.abort.signal) : undefined;
      this.abort.signal.throwIfAborted();
      if (bridge) {
        options.mcpServers = { ...options.mcpServers, [kind.id]: bridge };
        if (defs[0]!.builtin === kind.id) this.builtinServers.set(kind.id, 'sdk');
      } else this.ctx.log('warn', `[claude] ${kind.label} gateway MCP unavailable; skipping it for this launch`);
    }
    try {
      this.q = query({ prompt: this.input, options });
    } catch (error) {
      await this.gatewayBridges.closeAll();
      throw error;
    }
    if (!this.abort.signal.aborted && !s.claude.useProviderKey && !this.gateway && allowsSubscriptionObservation(options.env)) {
      this.subscription.attach(this.q);
    }
    // This CLI counts the tokens and dollars of the process that is starting, not of the session:
    // a resumed process opens at zero, so without this the first turn after every resume would be
    // measured against the totals already recorded and thrown away.
    this.usage.beginProcess();
    // The app can configure a window before the process exists; hand it over as soon as it does.
    if (this.autoCompactionWindow !== undefined) {
      void this.applyAutoCompactionWindow().catch((e) => this.ctx.log('warn', `claude auto-compaction window rejected: ${errorMessage(e)}`));
    }
    this.pump = this.consume(this.q).catch((e) => {
      this.compactionWaiter?.reject(e instanceof Error ? e : new Error(errorMessage(e)));
      if (this.fastMode) this.ctx.updateMeta({ fastModeStatus: { state: 'unavailable', detail: errorMessage(e) } });
      this.ctx.emit({ type: 'error', message: `Claude harness stopped: ${errorMessage(e)}`, fatal: true });
      this.ctx.emit({ type: 'status', status: 'error', detail: errorMessage(e) });
    });
    if (this.gatewayBridges.hasOpen) this.pump = this.pump.finally(() => this.gatewayBridges.closeAll());
    this.ctx.emit({ type: 'status', status: 'idle' });
  }

  private canUseTool: CanUseTool = (toolName, input, { mcpServer }) => this.authorizeTool(toolName, input, mcpServer);

  /** A read-only tool of a built-in server this process was handed, reported by Claude with the
   * source it was handed under (`dynamic` or `sdk`), or a Mission tool of the in-process Mission
   * bridge. A user or project server reusing a built-in name gets nothing. */
  private builtinTrusted(toolName: string, mcpServer?: { name: string; source: string }): boolean {
    if (!isBuiltinTrustedMcpName(toolName)) return false;
    const server = toolName.slice('mcp__'.length, toolName.indexOf('__', 'mcp__'.length));
    const source = this.builtinServers.get(server);
    if (!source) return false;
    // Only this host can register an `sdk` server, so that reported source is the provenance: a
    // configured server under the same name (any other source), or no report at all, gets nothing.
    if (isBuiltinMissionMcpName(toolName)) return source === 'sdk' && mcpServer?.name === server && mcpServer.source === 'sdk';
    return !mcpServer || mcpServer.name === server && mcpServer.source === source;
  }

  /** The tier's verdict for one call, without asking anyone. */
  private async gateTool(toolName: string, input: Record<string, unknown>, mcpServer?: { name: string; source: string }): Promise<{ verdict: GateVerdict; isEdit: boolean; command?: string; outsideWorkspace: boolean }> {
    const mode = this.ctx.permissionMode();
    const isEdit = EDIT_TOOLS.has(toolName);
    const trusted = this.builtinTrusted(toolName, mcpServer);
    const mutating = !READ_ONLY_TOOLS.has(toolName) && !trusted;
    const command = typeof input.command === 'string' ? input.command : undefined;
    const editTarget = isEdit ? String(input.file_path ?? input.notebook_path ?? '') : '';
    // Real-path check: a symlink or junction inside the project that leads out of it counts as outside.
    const outsideWorkspace = !!editTarget && await requiresPathApproval(this.ctx.session().cwd, editTarget);
    const missionBuilder = this.ctx.session().mission?.role === 'builder';
    let verdict = gateAction(mode, { mutating, isEdit, command, sessionAllowed: this.sessionAllowed.has(toolName), outsideWorkspace, missionBuilder });
    // A Builder never runs an MCP tool the app cannot vouch for unasked, in any tier: it may publish.
    if (missionBuilder && verdict === 'allow' && toolName.startsWith('mcp__') && !trusted) verdict = 'ask';
    return { verdict, isEdit, command, outsideWorkspace };
  }

  private async authorizeTool(toolName: string, input: Record<string, unknown>, mcpServer?: { name: string; source: string }): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') return askClaudeUserQuestion(this.ctx, input);

    const cwd = this.ctx.session().cwd;
    const { verdict, isEdit, command, outsideWorkspace } = await this.gateTool(toolName, input, mcpServer);
    if (verdict === 'allow') return { behavior: 'allow', updatedInput: input };
    if (verdict === 'deny') return { behavior: 'deny', message: PLAN_MODE_DENIAL };

    const changes = isEdit ? await previewClaudeChange(cwd, toolName, input) : undefined;
    const decision = await this.ctx.requestApproval({
      kind: command ? 'command' : isEdit ? 'file_change' : 'tool',
      title: command ? 'Run command?' : isEdit ? `Allow ${toolName}?` : `Allow ${toolName}?`,
      toolName,
      command,
      cwd,
      input,
      changes,
      description: command ? undefined : outsideWorkspace ? `${summarizeInput(toolName, input)} (outside the project directory)` : summarizeInput(toolName, input),
      options: OPTIONS_ALLOW_DENY
    });
    if (decision.optionId === 'allow') return { behavior: 'allow', updatedInput: (decision.updatedInput as Record<string, unknown>) ?? input };
    if (decision.optionId === 'allow_session') {
      this.sessionAllowed.add(toolName);
      // Keep the grant in-process only. Returning the SDK's suggestions would install a CLI-side
      // session rule that skips canUseTool for later calls, bypassing the host-side dangerous
      // command and outside-workspace checks in gateAction.
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: decision.note?.trim() || 'The user declined this action.' };
  }

  private preToolUse: HookCallback = (input) => this.ongoing.withInternalHook(() => this.runPreToolUse(input));

  private async runPreToolUse(input: Parameters<HookCallback>[0]): Promise<Awaited<ReturnType<HookCallback>>> {
    let tierDecision: 'allow' | 'ask' | undefined;
    if (input.hook_event_name === 'PreToolUse' && !SESSION_CONTROL_TOOLS.has(input.tool_name)) {
      // The tier overrides Claude settings: an allow rule there would skip canUseTool, so every call
      // is re-gated here first. The hook never prompts — 'ask' makes Claude Code route the call to
      // canUseTool even past an allow rule, which shows the one approval card; 'allow' also lifts
      // the CLI's plan-mode block for the built-in read-only tools. A settings deny rule still wins.
      const { verdict } = await this.gateTool(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, input.mcp_server);
      if (verdict === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PLAN_MODE_DENIAL } };
      tierDecision = verdict;
    }
    if (input.hook_event_name === 'PreToolUse' && EDIT_TOOLS.has(input.tool_name)) {
      const ti = input.tool_input as Record<string, unknown>;
      const file = String(ti?.file_path ?? ti?.notebook_path ?? '');
      if (file) {
        const abs = path.isAbsolute(file) ? file : path.join(this.ctx.session().cwd, file);
        try {
          this.fileSnapshots.set(input.tool_use_id, await fs.readFile(abs, 'utf8'));
        } catch {
          this.fileSnapshots.set(input.tool_use_id, null);
        }
      }
    }
    if (tierDecision) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: tierDecision, ...(tierDecision === 'ask' ? { permissionDecisionReason: 'Vocs Code permission tier requires approval.' } : {}) } };
    return { continue: true };
  }

  private postToolUse: HookCallback = (input) => this.ongoing.withInternalHook(() => this.runPostToolUse(input));

  private async runPostToolUse(input: Parameters<HookCallback>[0]): Promise<Awaited<ReturnType<HookCallback>>> {
    if (input.hook_event_name === 'PostToolUse' && EDIT_TOOLS.has(input.tool_name)) {
      const ti = input.tool_input as Record<string, unknown>;
      const file = String(ti?.file_path ?? ti?.notebook_path ?? '');
      if (file) {
        const abs = path.isAbsolute(file) ? file : path.join(this.ctx.session().cwd, file);
        const before = this.fileSnapshots.get(input.tool_use_id);
        this.fileSnapshots.delete(input.tool_use_id);
        try {
          const after = await fs.readFile(abs, 'utf8');
          const change = makeFileChange(this.ctx.session().cwd, file, before, after);
          const item = this.toolItems.get(input.tool_use_id);
          if (item) {
            item.changes = [change];
            this.ctx.emit({ type: 'item.upsert', item: { ...item } });
          }
        } catch (e) {
          // The edit itself succeeded (Claude ran it); only the diff preview is lost.
          this.ctx.log('debug', `no diff preview for ${file}: ${errorMessage(e)}`);
        }
      }
    }
    return { continue: true };
  }

  /**
   * Publishes the slash commands this CLI accepts, so `/goal` can be handed to the harness when it has
   * a goal of its own (see shared/goal-driver.ts). Init reports the list on every process start and
   * `commands_changed` re-reports it when skills appear mid-session; an unchanged list is not re-sent.
   */
  private reportCommands(commands: readonly SlashCommand[]): void {
    reportHarnessCommands(this.ctx, claudeHarnessCommands(commands));
  }

  observedSubscriptionWindows(): ObservedSubscriptionWindow[] {
    return this.subscription.observedWindows();
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.handle(msg, q);
    } finally {
      this.subscription.detach(q);
    }
    this.closeOpenTurn();
    this.ongoing.clear();
    this.compactionWaiter?.reject(new Error('Claude Code stopped during context compaction.'));
    this._busy = false;
    this.ctx.emit({ type: 'status', status: 'stopped', detail: 'Claude Code process ended' });
  }

  private handle(msg: SDKMessage, q: Query): void {
    if (msg.type === 'rate_limit_event') {
      this.subscription.observe(msg, q);
      return;
    }
    // State is reported on init, status and result messages. A request is not proof of activation.
    const fast = msg as { fast_mode_state?: string; fast_mode_disabled_reason?: string; parent_tool_use_id?: string | null };
    if (!fast.parent_tool_use_id && this.fastMode && (fast.fast_mode_state || fast.fast_mode_disabled_reason)) {
      const reason = fast.fast_mode_disabled_reason;
      this.ctx.updateMeta({ fastModeStatus: {
        state: fast.fast_mode_state === 'cooldown' ? 'cooldown' : reason ? reason === 'pending' ? 'requested' : 'unavailable' : fast.fast_mode_state === 'on' ? 'on' : 'off',
        ...(reason ? { detail: reason } : {})
      } });
    }
    switch (msg.type) {
      case 'system':
        this.handleSystem(msg, q);
        return;
      case 'stream_event': {
        this.markTurnStarted();
        if (msg.parent_tool_use_id) return; // nested subagent streams are summarized via tool items
        const ev = msg.event as { type: string; index?: number; content_block?: ContentBlockLike; delta?: { type: string; text?: string; thinking?: string }; message?: { model?: string; usage?: Record<string, unknown> }; usage?: Record<string, unknown>; output_tokens?: number };
        if (!msg.parent_tool_use_id) this.usage.reportStreamUsage(ev);
        // The bubble opens on its first text or thinking: a message can be a bare tool call (its
        // input streams as input_json_delta, omitted thinking as signature_delta) with nothing to show.
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta' && ev.delta.text) {
            const a = this.ensureAssistant();
            a.text += ev.delta.text;
            this.ctx.emit({ type: 'item.delta', id: a.id, textDelta: ev.delta.text });
          } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
            const a = this.ensureAssistant();
            a.thinking += ev.delta.thinking;
            this.ctx.emit({ type: 'item.delta', id: a.id, thinkingDelta: ev.delta.thinking });
          }
        }
        return;
      }
      case 'assistant': {
        this.markTurnStarted();
        const content = (msg.message.content ?? []) as ContentBlockLike[];
        // The child's own transcript lives in its run, never in the parent's: this message is one
        // the subagent produced, so every block belongs to the delegation, not to the answer.
        if (msg.parent_tool_use_id) this.subagents.onNestedAssistant(msg.parent_tool_use_id, msg as unknown as NestedAssistantLike);
        for (const block of content) {
          if (block.type === 'text' && !msg.parent_tool_use_id) {
            if (!block.text && !this.currentAssistant) continue;
            const a = this.ensureAssistant();
            if (block.text && block.text.length >= a.text.length) a.text = block.text;
            this.ctx.emit({ type: 'item.upsert', item: { id: a.id, kind: 'assistant', ts: Date.now(), text: a.text, thinking: a.thinking || undefined, model: msg.message.model, streaming: true } });
          } else if (block.type === 'thinking' && !msg.parent_tool_use_id) {
            if (!block.thinking && !this.currentAssistant) continue;
            const a = this.ensureAssistant();
            if (block.thinking && block.thinking.length >= a.thinking.length) a.thinking = block.thinking;
          } else if (block.type === 'tool_use' && block.id && block.name) {
            const input = (block.input ?? {}) as Record<string, unknown>;
            const item: Extract<TranscriptItem, { kind: 'tool' }> = {
              id: block.id,
              kind: 'tool',
              ts: Date.now(),
              name: block.name,
              hint: toolHint(block.name),
              input,
              summary: summarizeInput(block.name, input),
              status: 'running',
              parentId: msg.parent_tool_use_id ?? null,
              // The generating model: inside a subagent it differs from the session's, and analytics charges the call to it.
              model: msg.message.model
            };
            // A main-thread Agent/Task call *is* a subagent run; recording it here is what lets the
            // transcript's card link into the Subagents panel.
            if (!msg.parent_tool_use_id && SUBAGENT_TOOLS.has(block.name)) {
              const runId = this.subagents.start(block.id, input, msg.message.model);
              if (runId) item.runId = runId;
            }
            this.toolItems.set(block.id, item);
            this.ctx.emit({ type: 'item.upsert', item });
            // A tool call closes the current text bubble so the next text starts fresh below the tool card.
            if (!msg.parent_tool_use_id) this.finishAssistant(msg.message.model);
          }
        }
        return;
      }
      case 'user': {
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content as ContentBlockLike[]) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const output = truncate(extractText(block.content), 40_000);
          if (msg.parent_tool_use_id) this.subagents.onNestedToolResult(msg.parent_tool_use_id, block.tool_use_id, output, !!block.is_error);
          // A foreground Agent call finishes here; a backgrounded one reports through its task
          // notification instead. Only spawning calls are tracked, so this is a no-op for the rest.
          // The result text goes with it: a spawn the CLI refused never runs, so this is the only
          // place the reason it refused can be read from.
          else this.subagents.onCallResult(block.tool_use_id, !!block.is_error, output);
          const item = this.toolItems.get(block.tool_use_id);
          if (!item) continue;
          item.output = output;
          item.status = block.is_error ? 'error' : 'done';
          this.ctx.emit({ type: 'item.upsert', item: { ...item } });
        }
        return;
      }
      case 'tool_progress':
        return;
      case 'result': {
        this.finishAssistant();
        this._busy = false;
        const { usage, turnCost } = this.usage.settleResult(msg as {
          modelUsage?: Record<string, ModelUsage>;
          total_cost_usd?: number;
          usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        });
        const turnMsg = msg as { is_error?: boolean; terminal_reason?: string };
        const isError = turnMsg.is_error || msg.subtype !== 'success';
        const errors = msg as { result?: string; errors?: string[]; fast_mode_state?: string; fast_mode_disabled_reason?: string };
        const detail = [errors.result, ...(errors.errors ?? [])].filter(Boolean).join('; ');
        if (this.fastMode && isError && !errors.fast_mode_state && !errors.fast_mode_disabled_reason && /fast.?mode|service.?tier|fast.*speed|rate.?limit/i.test(detail)) {
          this.ctx.updateMeta({ fastModeStatus: { state: 'unavailable', detail } });
        }
        const interrupted = turnMsg.terminal_reason === 'aborted_streaming' || turnMsg.terminal_reason === 'aborted_tools';
        const status = interrupted ? 'interrupted' : isError ? 'failed' : 'completed';
        // The turn is as long as the app watched it, the way every other harness reports it and the
        // way the Usage panel reads "turn wall time". The SDK's `duration_ms` measures the CLI's own
        // agent loop and drops the wall time a subagent fan-out spends working (9.2s reported against
        // a 343s turn), while the tokens counted for that turn come from the cumulative modelUsage
        // that *does* include the subagents — the mismatch read as 16k tok/s on a single turn.
        const wallMs = this.turnStartedAt > 0 ? Math.max(0, Date.now() - this.turnStartedAt) : 0;
        this.ctx.emit({
          type: 'item.upsert',
          item: {
            id: shortId('turn_'),
            kind: 'turn',
            ts: Date.now(),
            status,
            durationMs: wallMs || msg.duration_ms,
            costUsd: turnCost,
            usage,
            error: isError ? `${msg.subtype}${'result' in msg && msg.result ? `: ${msg.result}` : ''}` : undefined
          }
        });
        this.turnStartedAt = 0;
        this.ctx.emit({ type: 'status', status: 'idle' });
        return;
      }
      default:
        return;
    }
  }

  private handleSystem(msg: Extract<SDKMessage, { type: 'system' }>, q: Query): void {
    const subtype = (msg as { subtype?: string }).subtype;
    if (msg.subtype === 'init') {
      this.subscription.onInit(q, msg.apiKeySource, msg.session_id);
      this.sessionId = msg.session_id;
      this.ctx.updateRef({ claudeSessionId: msg.session_id });
      if (msg.model) this.ctx.updateMeta({ activeModel: { provider: this.providerId ?? 'anthropic', model: msg.model } });
      if (!this.modelsEmitted && !this.gateway) {
        this.modelsEmitted = true;
        q.supportedModels()
          .then((models) => this.ctx.emit({ type: 'models', models: claudeSdkCatalog(models) }))
          .catch((e) => {
            // Retry on the next init so the model picker is not permanently empty.
            this.modelsEmitted = false;
            this.ctx.log('debug', `supportedModels failed (${errorMessage(e)}); retrying on the next init`);
          });
      }
      q.supportedCommands()
        .then((commands) => this.reportCommands(commands))
        .catch((e) => this.ctx.log('debug', `supportedCommands failed: ${errorMessage(e)}`));
    } else if (msg.subtype === 'commands_changed') {
      this.reportCommands(msg.commands);
    } else if (msg.subtype === 'compact_boundary') {
      const { trigger, pre_tokens, post_tokens } = msg.compact_metadata;
      // A manual boundary answers the request this app is waiting on and is reported by the
      // completion message. The CLI's own boundary has no app-side caller, so without a note
      // the context would shrink with nothing in the transcript to explain it.
      if (trigger === 'manual') this.compactionWaiter?.resolve();
      else this.info(`Claude compacted the conversation context (${pre_tokens}${post_tokens ? ` → ${post_tokens}` : ''} tokens).`);
    } else if (subtype === 'status') {
      const m = msg as { compact_result?: 'success' | 'failed'; compact_error?: string };
      if (m.compact_result) {
        this.info(`Context compaction ${m.compact_result}.`, m.compact_result === 'failed' ? 'warn' : 'info');
        if (m.compact_result === 'failed') this.compactionWaiter?.reject(new Error(m.compact_error || 'Claude context compaction failed.'));
        else this.compactionWaiter?.resolve();
      }
    } else if (subtype === 'permission_denied') {
      const m = msg as { tool_name: string };
      this.info(`Tool ${m.tool_name} was auto-denied by the harness.`, 'warn');
    } else if (subtype === 'background_tasks_changed') {
      const m = msg as { tasks?: { task_id: string; task_type?: string; description?: string; ambient?: boolean }[] };
      this.ongoing.onBackgroundTasksChanged(Array.isArray(m.tasks) ? m.tasks : []);
    } else if (subtype === 'hook_started') {
      this.ongoing.onHookStarted(msg as unknown as { hook_id?: string; hook_name?: string; hook_event?: string });
    } else if (subtype === 'hook_response') {
      this.ongoing.onHookResponse(msg as unknown as { hook_id?: string });
    } else if (subtype === 'task_started') {
      const t = msg as unknown as TaskStartedLike & { task_type?: string };
      this.subagents.onTaskStarted(t);
      this.ongoing.onTaskStarted(t);
    } else if (subtype === 'task_progress') {
      this.subagents.onTaskProgress(msg as unknown as TaskProgressLike);
    } else if (subtype === 'task_updated') {
      const t = msg as unknown as TaskUpdatedLike;
      this.subagents.onTaskUpdated(t);
      this.ongoing.onTaskUpdated(t);
    } else if (subtype === 'task_notification') {
      const t = msg as unknown as TaskNotificationLike;
      this.subagents.onTaskNotification(t);
      this.ongoing.onTaskNotification(t);
    }
  }

  private ensureAssistant(): { id: string; text: string; thinking: string } {
    if (!this.currentAssistant) {
      this.currentAssistant = { id: shortId('a_'), text: '', thinking: '' };
      this.ctx.emit({ type: 'item.upsert', item: { id: this.currentAssistant.id, kind: 'assistant', ts: Date.now(), text: '', streaming: true } });
    }
    return this.currentAssistant;
  }

  private finishAssistant(model?: string): void {
    const a = this.currentAssistant;
    if (!a) return;
    this.currentAssistant = null;
    // Settle it even when empty: ensureAssistant already announced it as streaming, and a row left
    // streaming keeps its turn's "Working…" header spinning after the turn has ended.
    this.ctx.emit({ type: 'item.upsert', item: { id: a.id, kind: 'assistant', ts: Date.now(), text: a.text, thinking: a.thinking || undefined, model, streaming: false } });
  }

  /** The CLI can begin a turn on its own — queued/steered messages (e.g. right after an interrupt)
   *  run without a send() call — so turn start must also be observed from the message stream. */
  private markTurnStarted(): void {
    if (this._busy) return;
    this._busy = true;
    this.usage.beginTurn();
    this.turnStartedAt = Date.now();
    this.ctx.emit({ type: 'status', status: 'running' });
  }

  /**
   * Closes a turn the process ended in the middle of — an interrupt, a stop, a CLI crash. No
   * `result` is coming for it, so without this its usage stays in the session totals owned by no
   * turn row: the headline spend then reads higher than the turns under it, and the next turn's
   * delta silently absorbs the abandoned usage instead of starting clean.
   */
  private closeOpenTurn(): void {
    if (!this._busy) return;
    const { usage, costUsd } = this.usage.settleInterrupted();
    this.ctx.emit({
      type: 'item.upsert',
      item: {
        id: shortId('turn_'),
        kind: 'turn',
        ts: Date.now(),
        status: 'interrupted',
        durationMs: this.turnStartedAt > 0 ? Math.max(0, Date.now() - this.turnStartedAt) : 0,
        costUsd,
        usage
      }
    });
    this.turnStartedAt = 0;
    this._busy = false;
  }

  private info(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level, text } });
  }

  async send(input: UserInput): Promise<void> {
    if (!this.q) await this.start();
    const content: unknown[] = [];
    for (const img of input.images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } });
    if (input.text) content.push({ type: 'text', text: input.text });
    const message = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? '',
      priority: input.mode === 'steer' ? 'now' : input.mode === 'queue' ? 'next' : undefined
    } as unknown as SDKUserMessage;
    if (!this._busy) {
      if (this.fastMode) {
        const support = fastModeSupport(this.id, this.fastModeModel, this.ctx.settings().providers);
        this.ctx.updateMeta({ fastModeStatus: support.supported ? { state: 'requested' } : { state: 'unavailable', detail: support.reason } });
      }
      this._busy = true;
      this.usage.beginTurn();
      this.turnStartedAt = Date.now();
      this.ctx.emit({ type: 'status', status: 'running' });
    }
    this.input.push(message);
  }

  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt();
    } catch (e) {
      this.ctx.log('warn', `interrupt failed: ${errorMessage(e)}`);
    }
  }

  async setFastMode(enabled: boolean): Promise<void> {
    const support = fastModeSupport(this.id, this.fastModeModel, this.ctx.settings().providers);
    if (enabled && !support.supported) throw new Error(support.reason);
    if (!this.q || typeof this.q.applyFlagSettings !== 'function') throw new Error('This Claude runtime cannot change Fast mode.');
    await this.q.applyFlagSettings({ fastMode: enabled });
    this.fastMode = enabled;
    this.ctx.updateMeta({ fastModeStatus: { state: enabled ? 'requested' : 'off' } });
  }

  async setModel(model: ModelRef): Promise<void> {
    // The SDK process keeps one endpoint for its lifetime; a model from another provider would be
    // sent to the wrong API. Require a new session instead of silently misrouting it.
    if (this.providerId && model.provider !== this.providerId) {
      throw new Error(`This session runs on the ${this.providerId} endpoint. Start a new session to use models from ${model.provider}.`);
    }
    // Remove a paid flag before moving to an unsupported model, even if the account would ignore it.
    const support = fastModeSupport(this.id, model, this.ctx.settings().providers);
    if (this.fastMode && !support.supported) await this.q?.applyFlagSettings({ fastMode: false });
    await this.q?.setModel(model.model);
    this.fastModeModel = model;
    if (this.fastMode && support.supported) await this.q?.applyFlagSettings({ fastMode: true });
    this.ctx.updateMeta({ activeModel: model, fastModeStatus: !this.fastMode ? { state: 'off' } : support.supported ? { state: 'requested' } : { state: 'unavailable', detail: support.reason } });
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    if (!this.q) return;
    const level = effort === 'minimal' ? 'low' : effort;
    await this.q.applyFlagSettings({ effortLevel: level });
    this.ctx.updateMeta({ activeEffort: effort });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // Per-tool session grants do not survive a mode change. The app gate reads the new tier on the
    // next call; the CLI mode only carries Plan's prompt and read-only workflow, so every tier,
    // Full access included, applies live.
    this.sessionAllowed.clear();
    await this.q?.setPermissionMode(toSdkMode(mode));
  }

  /**
   * Claude compacts itself once told the window: the CLI reduces context from inside the turn it
   * is running, so nothing is interrupted and no extra turn is spent on a summary.
   */
  async setAutoCompactionWindow(tokens: number | undefined): Promise<void> {
    this.autoCompactionWindow = tokens ?? null;
    await this.applyAutoCompactionWindow();
  }

  private async applyAutoCompactionWindow(): Promise<void> {
    const window = this.autoCompactionWindow;
    const q = this.q;
    if (window === undefined || !q) return;
    // null clears the flag layer, which drops the CLI back to its own default rather than to zero.
    await q.applyFlagSettings(window === null ? { autoCompactEnabled: null, autoCompactWindow: null } : { autoCompactEnabled: true, autoCompactWindow: window });
    // Read back what the CLI resolved: a window it silently ignores would look like a fix that works.
    const reported = await q.getContextUsage({ detail: 'summary' }).catch((e) => {
      this.ctx.log('debug', `context usage unavailable after setting the auto-compaction window: ${errorMessage(e)}`);
      return null;
    });
    this.ctx.log('info', `claude auto-compaction window=${window ?? 'harness default'} (enabled=${reported?.isAutoCompactEnabled ?? '?'} threshold=${reported?.autoCompactThreshold ?? '?'} context=${reported?.totalTokens ?? '?'}/${reported?.rawMaxTokens ?? '?'})`);
  }

  async compact(): Promise<void> {
    if (this.compactionWaiter) {
      await withTimeout(this.compactionWaiter.promise, 120_000, 'Claude context compaction');
      return;
    }
    const waiter = deferred<void>();
    // Process shutdown can reject this before send() reaches its next microtask; mark it observed now.
    void waiter.promise.catch(() => undefined);
    this.compactionWaiter = waiter;
    try {
      await this.send({ text: '/compact' });
      await withTimeout(waiter.promise, 120_000, 'Claude context compaction');
    } finally {
      if (this.compactionWaiter === waiter) this.compactionWaiter = null;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.q) return [];
    return claudeSdkCatalog(await this.q.supportedModels());
  }

  /**
   * The agent types Claude Code will delegate to, so the Subagents panel can name them. Only a live
   * query knows them; an idle session reports none and the panel falls back to the project's own
   * definition files, which it can read at any time.
   */
  async listAgents(): Promise<AgentTypeInfo[]> {
    if (!this.q) return [];
    // Older CLI builds answer `supportedModels` but not this; an absent method is "unknown", not a crash.
    if (typeof this.q.supportedAgents !== 'function') return [];
    const agents = await this.q.supportedAgents();
    return agents.map(({ name, description, model }) => ({ name, description, ...(model ? { model } : {}) }));
  }

  async dispose(): Promise<void> {
    this.subscription.detach();
    // Before the reporter closes: the turn being abandoned is reported through it.
    this.closeOpenTurn();
    this.ongoing.clear();
    this.usage.close();
    this.compactionWaiter?.reject(new Error('Claude context compaction was cancelled.'));
    this.input.close();
    this.abort.abort();
    try {
      this.q?.close();
    } catch {
      /* ignore */
    }
    this.q = null;
    await this.gatewayBridges.closeAll();
    // A run still open when the process goes away has no end record and no owner left to write one,
    // so close it as interrupted rather than leaving it spinning as `running` in an open app.
    await this.subagents.settle();
  }
}
