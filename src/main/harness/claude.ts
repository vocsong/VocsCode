/** Claude Agent SDK adapter: streaming query() turns, canUseTool approvals and file-change hooks, normalized to SessionEvents. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  query,
  createSdkMcpServer,
  type CanUseTool,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type ModelUsage,
  type Options,
  type PermissionMode as SdkPermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SettingSource,
  type SlashCommand
} from '@anthropic-ai/claude-agent-sdk';
import type { AppSettings, EffortLevel, FileChange, McpServerDef, ModelInfo, ModelRef, OngoingItem, PermissionMode, ProviderConfig, TranscriptItem, UsageTotals, UserInput } from '../../shared/types';
import { fastModeSupport } from '../../shared/fast-mode';
import { assertEndpointUrl } from '../../shared/endpoint-policy';
import { hasClaudeAgentPins } from '../claude-agents';
import { toClaude } from '../mcp/effective';
import { MEMORY_GATEWAY_TOKEN_ENV, MEMORY_GATEWAY_URL_ENV, VOCS_MEMORY_SERVER_ID } from '../mcp/memory';
import { claudeSdkCatalog } from '../models/claude-catalog';
import { resolveProviderApiKey } from '../models/providers';
import { estimateCostUsd, findContextWindow, findPricing, modelsForProvider } from '../models/static-models';
import { subagentDir } from '../subagents';
import { subagentSupport, type AgentTypeInfo } from '../../shared/subagents';
import { anthropicAuthFor, anthropicBaseUrlFor, ANTHROPIC_DEFAULT_BASE_URL, isClaudeCapableProvider, isClaudeGatewayProvider } from '../../shared/providers';
import { AsyncQueue, deferred, errorMessage, shortId, truncate, withTimeout, type Deferred } from '../util/async';
import { makeFileChange } from '../util/file-changes';
import { exists } from '../util/fs';
import { TurnUsageTracker } from '../util/turn-usage';
import { UsageReporter } from '../util/usage-reporter';
import { SUBAGENT_TOOLS, ClaudeSubagentRuns, type NestedAssistantLike, type TaskNotificationLike, type TaskProgressLike, type TaskStartedLike, type TaskUpdatedLike } from './claude-subagents';
import { gateAction, OPTIONS_ALLOW_DENY, PLAN_MODE_DENIAL, requiresPathApproval, type GateVerdict } from './permissions';
import { isBuiltinReadOnlyMcpName } from '../../shared/builtin-tools';
import { projectInstructionBlock } from './project-instructions';
import { questionAnswerWithNote } from './question-answers';
import { sessionAppendPrompt } from './system-prompt';
import type { HarnessAdapter, HarnessContext } from './types';
import { reportHarnessCommands } from './commands';
import type { HarnessCommand } from '../../shared/harness-commands';

/** Delay before surfacing a Claude hook as ongoing work, so fast hooks never flicker in the UI. */
const HOOK_VISIBILITY_DELAY_MS = 250;

/** Records a live Claude background task (from `background_tasks_changed` or edge fallback). */
interface LiveBackgroundTask {
  taskId: string;
  taskType: string;
  description: string;
  startedAt: number;
}

/** Records a live user/project Claude hook between `hook_started` and `hook_response`. */
interface LiveHookRun {
  hookId: string;
  hookName: string;
  hookEvent: string;
  startedAt: number;
  visible: boolean;
  timer?: NodeJS.Timeout;
}

function isInternalHookName(hookName: string | undefined): boolean {
  if (!hookName) return true;
  return hookName === 'callback' || hookName.endsWith(':callback');
}
const APP_ID = 'vocs-code/0.1.0';
/**
 * How many subagents one session may run at once. Claude Code's own default is 20, a number tuned
 * for a single terminal; a session here fans out deliberately (a review spread across thirty
 * areas), and a spawn past the cap is refused outright, so the tail of that fan-out is lost. Each
 * concurrent run is its own conversation, so cost is the real brake, not this number.
 */
const MAX_CONCURRENT_SUBAGENTS = 32;

/**
 * Claude Code's own project-document names. With `'project'` in `settingSources` its engine
 * discovers these itself (following `@` imports), so the adapter must leave them to it: handing the
 * same instructions over again costs context and buries the file that was actually missing. The
 * bundled CLI reads no other instruction file, so a project whose rules live only in `AGENTS.md` —
 * the convention pi, Codex and the native loop follow — would otherwise run unprimed.
 */
const CLAUDE_PROJECT_DOC_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];

/**
 * The project instructions the Claude engine does not read. `AGENTS.md` is added only where the
 * directory has no Claude document, matching the engine's own fallback rule (never both for one
 * directory) so a repo that maintains `CLAUDE.md` — e.g. `@AGENTS.md` — is not duplicated.
 * `.vocs-code/INSTRUCTIONS.md` has no engine equivalent, so it is added whenever it exists.
 */
export async function claudeProjectInstructions(cwd: string): Promise<string | undefined> {
  let agents = true;
  for (const name of CLAUDE_PROJECT_DOC_FILES) {
    if (await exists(path.join(cwd, name))) {
      agents = false;
      break;
    }
  }
  const names = [...(agents ? ['AGENTS.md'] : []), '.vocs-code/INSTRUCTIONS.md'];
  return (await projectInstructionBlock(cwd, names)) || undefined;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'TodoRead',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'ToolSearch',
  'AskUserQuestion',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'Skill'
]);
/**
 * Tools that steer the Claude session itself (questions, subagents, plan mode, background-task
 * control) rather than the project, the shell or the network. The PreToolUse gate leaves them to
 * Claude Code's own pipeline, which reaches canUseTool when it would ask: AskUserQuestion needs
 * canUseTool to collect its answers, and what a subagent does is gated call by call in its own run.
 */
const SESSION_CONTROL_TOOLS = new Set(['AskUserQuestion', 'Agent', 'Task', 'TaskOutput', 'TaskStop', 'KillShell', 'BashOutput', 'EnterPlanMode']);

/**
 * The CLI's command rows as the composer offers them. Rows can share a name; `/name` runs the
 * built-in one when a built-in row has it, so that is the row kept. Anything not built in is a user,
 * project, plugin or MCP command — all of which Claude Code now loads as skills.
 */
export function claudeHarnessCommands(commands: readonly SlashCommand[]): HarnessCommand[] {
  const builtin = new Set(commands.filter((c) => c.builtin).map((c) => c.name.trim().toLowerCase()));
  return commands
    .filter((c) => c.builtin || !builtin.has(c.name.trim().toLowerCase()))
    .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases, kind: c.builtin ? 'command' : 'skill' }));
}

function toSdkMode(mode: PermissionMode): SdkPermissionMode {
  switch (mode) {
    case 'ask':
      return 'default';
    case 'accept-edits':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'auto':
    case 'full-auto':
      // The app gate decides every call (PreToolUse, then canUseTool), so the CLI stays in its
      // prompting mode and is never handed `bypassPermissions`: Full access is the gate allowing
      // everything, which applies live and needs no `allowDangerouslySkipPermissions`.
      return 'default';
  }
}

function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  const i = input as Record<string, unknown>;
  if (typeof i.command === 'string') return i.command;
  if (typeof i.file_path === 'string') return i.file_path as string;
  if (typeof i.path === 'string') return i.path as string;
  if (typeof i.pattern === 'string') return `${i.pattern}${typeof i.path === 'string' ? ` in ${i.path}` : ''}`;
  if (typeof i.url === 'string') return i.url as string;
  if (typeof i.query === 'string') return i.query as string;
  if (typeof i.description === 'string') return i.description as string;
  if (typeof i.prompt === 'string') return truncate(i.prompt as string, 200, '…');
  const s = JSON.stringify(i);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

function toolHint(toolName: string): TranscriptItem extends infer _ ? 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'mcp' | 'agent' | 'other' : never {
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'execute';
  if (EDIT_TOOLS.has(toolName)) return 'edit';
  if (toolName === 'Read') return 'read';
  if (toolName === 'Glob' || toolName === 'Grep' || toolName === 'LS') return 'search';
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'fetch';
  if (toolName === 'Agent' || toolName === 'Task') return 'agent';
  if (toolName.startsWith('mcp__')) return 'mcp';
  return 'other';
}

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

function finiteCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function counterDelta(previous: number, current: number): number {
  return current >= previous ? current - previous : current;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly id = 'claude' as const;
  private q: Query | null = null;
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
  private readonly usage: TurnUsageTracker;
  private readonly usageReporter: UsageReporter;
  /** Output usage is cumulative within the current Anthropic streaming response. */
  private streamOutputTokens = 0;
  private streamReasoningTokens = 0;
  private streamInputReported = false;
  private started = false;
  private modelsEmitted = false;
  private compactionWaiter: Deferred<void> | null = null;
  /** Token window the app wants the CLI to compact at; undefined until configured, null for the CLI's own default. */
  private autoCompactionWindow: number | null | undefined;
  /** Records the delegated runs Claude Code spawns, so the Subagents panel can show them. */
  private readonly subagents: ClaudeSubagentRuns;
  /** Live non-ambient background tasks from `background_tasks_changed` (or edge fallback on older CLIs). */
  private readonly backgroundTasks = new Map<string, LiveBackgroundTask>();
  /** True once this CLI process has emitted the authoritative `background_tasks_changed` level signal. */
  private seenBackgroundTasksSnapshot = false;
  /** Live user/project hooks between `hook_started` and `hook_response`. */
  private readonly activeHooks = new Map<string, LiveHookRun>();
  /** Depth of Vocs Code's own SDK hook callbacks (`preToolUse` / `postToolUse`), never surfaced as user hooks. */
  private internalHookDepth = 0;
  private closeMemoryMcp: (() => Promise<void>) | undefined;

  constructor(private readonly ctx: HarnessContext) {
    this.usage = new TurnUsageTracker(ctx.session().usage);
    this.usageReporter = new UsageReporter((event) => this.ctx.emit(event));
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
    const append = [project, sessionAppendPrompt(meta, await this.ctx.appInstructions?.())].filter(Boolean).join('\n\n') || undefined;
    const mode = this.ctx.permissionMode();
    const bin = this.ctx.runtime.resolve('claude');
    // Windows cannot launch a batch shim through the SDK's shell-free spawn. If the resolver
    // found no native executable, fail before query() instead of falling into an opaque SDK error.
    if (process.platform === 'win32' && !bin) throw new Error('Claude Agent SDK needs a native Claude Code executable. Reinstall Vocs Code (or run npm install --include=dev in a dev checkout), or select a native .exe; npm .cmd/.bat shims cannot be spawned.');
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: APP_ID };
    // Never let this app's own Claude Code host variables leak into a nested session.
    for (const k of Object.keys(env)) {
      if (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_USE_BEDROCK' && k !== 'CLAUDE_CODE_USE_VERTEX' && k !== 'CLAUDE_CODE_USE_FOUNDRY') delete env[k];
      const name = process.platform === 'win32' ? k.toUpperCase() : k;
      if (name === MEMORY_GATEWAY_URL_ENV || name === MEMORY_GATEWAY_TOKEN_ENV
        || name === 'VOCS_CODE_MCP_EPHEMERAL') delete env[k];
    }
    delete env.CLAUDECODE;
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
    const gatewayMemory = mcp.filter((def) => def.id === VOCS_MEMORY_SERVER_ID
      && (def.env?.[MEMORY_GATEWAY_URL_ENV] !== undefined || def.env?.[MEMORY_GATEWAY_TOKEN_ENV] !== undefined));
    const processServers = mcp.filter((def) => !gatewayMemory.includes(def));
    // Built-in servers this process hands Claude, keyed to the source Claude reports for them:
    // `dynamic` for --mcp-config; the in-process memory gateway bridge below registers as `sdk`.
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
    options.env = { ...(options.env ?? {}), ...(await this.subagentModelEnv(options.model)) };
    this.ctx.log('info', `claude runtime: ${options.pathToClaudeCodeExecutable ?? 'SDK-bundled'}; model=${options.model ?? 'default'} mode=${options.permissionMode}${options.resume ? ` resume=${options.resume}${options.forkSession ? ' (fork)' : ''}` : ''}${mcp.length ? ` mcp=${mcp.length}` : ''}${provider ? ` auth=${auth} provider=${provider.id}` : ''}`);
    if (gatewayMemory.length) {
      const bridge = gatewayMemory.length === 1 ? await this.memoryMcpBridge(gatewayMemory[0], meta.cwd) : undefined;
      this.abort.signal.throwIfAborted();
      if (bridge) {
        options.mcpServers = { ...options.mcpServers, [VOCS_MEMORY_SERVER_ID]: bridge };
        if (gatewayMemory[0]!.builtin === VOCS_MEMORY_SERVER_ID) this.builtinServers.set(VOCS_MEMORY_SERVER_ID, 'sdk');
      }
      else this.ctx.log('warn', '[claude] memory gateway MCP unavailable; skipping it for this launch');
    }
    try {
      this.q = query({ prompt: this.input, options });
    } catch (error) {
      if (this.closeMemoryMcp) await this.closeMemoryMcp();
      throw error;
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
    if (this.closeMemoryMcp) this.pump = this.pump.finally(this.closeMemoryMcp);
    this.ctx.emit({ type: 'status', status: 'idle' });
  }

  /** Run the app-owned stdio child from the SDK host, not from Claude Code. */
  private async memoryMcpBridge(def: McpServerDef, cwd: string): Promise<McpSdkServerConfigWithInstance | undefined> {
    if (def.builtin !== VOCS_MEMORY_SERVER_ID || def.transport !== 'stdio' || !def.command
      || !def.env?.[MEMORY_GATEWAY_URL_ENV] || !def.env?.[MEMORY_GATEWAY_TOKEN_ENV]) return;
    try {
      const [{ Client }, { StdioClientTransport }, { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/stdio.js'),
        import('@modelcontextprotocol/sdk/types.js')
      ]);
      this.abort.signal.throwIfAborted();
      const client = new Client({ name: 'vocs-code', version: '0.1.0' });
      // Ignore child stderr: a failed handshake can otherwise surface snippets of launch secrets.
      const transport = new StdioClientTransport({ command: def.command, args: def.args, env: def.env, cwd, stderr: 'ignore' });
      let closing: Promise<void> | undefined;
      this.closeMemoryMcp = () => closing ??= client.close().catch(() => undefined);
      await client.connect(transport, { signal: this.abort.signal, timeout: 10_000 });
      const timeout = def.timeoutMs && def.timeoutMs >= 1000 ? def.timeoutMs : undefined;
      const bridge = createSdkMcpServer({
        name: VOCS_MEMORY_SERVER_ID,
        version: client.getServerVersion()?.version,
        instructions: client.getInstructions(),
        timeout
      });
      // Relay the tool protocol directly: reconstructing via sdkTool() would change the stdio
      // server's JSON Schemas, annotations and returned content.
      bridge.instance.server.registerCapabilities({ tools: {} });
      bridge.instance.server.setRequestHandler(ListToolsRequestSchema, async ({ params }, { signal }) => {
        try { return await client.listTools(params, { signal, timeout: 10_000 }); }
        catch { throw new McpError(ErrorCode.InternalError, 'Memory gateway MCP tool discovery failed.'); }
      });
      bridge.instance.server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
        // The gateway can take up to 90 seconds before local fallback starts.
        try { return await client.callTool(params, undefined, { signal, timeout: timeout ?? 120_000 }); }
        catch { throw new McpError(ErrorCode.InternalError, 'Memory gateway MCP request failed.'); }
      });
      return bridge;
    } catch {
      if (this.closeMemoryMcp) await this.closeMemoryMcp();
      this.closeMemoryMcp = undefined;
      // No inline fallback and no error detail from the credential-bearing child.
      return undefined;
    }
  }

  private canUseTool: CanUseTool = (toolName, input, { mcpServer }) => this.authorizeTool(toolName, input, mcpServer);

  /** A read-only tool of a built-in server this process was handed, reported by Claude with the
   * source it was handed under (`dynamic` or `sdk`). A user or project server reusing a built-in
   * name gets nothing. */
  private builtinReadOnly(toolName: string, mcpServer?: { name: string; source: string }): boolean {
    if (!isBuiltinReadOnlyMcpName(toolName)) return false;
    const server = toolName.slice('mcp__'.length, toolName.indexOf('__', 'mcp__'.length));
    const source = this.builtinServers.get(server);
    return !!source && (!mcpServer || mcpServer.name === server && mcpServer.source === source);
  }

  /** The tier's verdict for one call, without asking anyone. */
  private async gateTool(toolName: string, input: Record<string, unknown>, mcpServer?: { name: string; source: string }): Promise<{ verdict: GateVerdict; isEdit: boolean; command?: string; outsideWorkspace: boolean }> {
    const mode = this.ctx.permissionMode();
    const isEdit = EDIT_TOOLS.has(toolName);
    const mutating = !READ_ONLY_TOOLS.has(toolName) && !this.builtinReadOnly(toolName, mcpServer);
    const command = typeof input.command === 'string' ? input.command : undefined;
    const editTarget = isEdit ? String(input.file_path ?? input.notebook_path ?? '') : '';
    // Real-path check: a symlink or junction inside the project that leads out of it counts as outside.
    const outsideWorkspace = !!editTarget && await requiresPathApproval(this.ctx.session().cwd, editTarget);
    const verdict = gateAction(mode, { mutating, isEdit, command, sessionAllowed: this.sessionAllowed.has(toolName), outsideWorkspace });
    return { verdict, isEdit, command, outsideWorkspace };
  }

  private async authorizeTool(toolName: string, input: Record<string, unknown>, mcpServer?: { name: string; source: string }): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') return this.askUserQuestion(input);

    const cwd = this.ctx.session().cwd;
    const { verdict, isEdit, command, outsideWorkspace } = await this.gateTool(toolName, input, mcpServer);
    if (verdict === 'allow') return { behavior: 'allow', updatedInput: input };
    if (verdict === 'deny') return { behavior: 'deny', message: PLAN_MODE_DENIAL };

    const changes = isEdit ? await this.previewChange(toolName, input) : undefined;
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

  private async askUserQuestion(input: Record<string, unknown>): Promise<PermissionResult> {
    const qs = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
    const decision = await this.ctx.requestApproval({
      kind: 'question',
      title: 'Claude has a question',
      toolName: 'AskUserQuestion',
      input,
      options: [
        { id: 'allow', label: 'Answer', kind: 'allow' },
        { id: 'deny', label: 'Skip', kind: 'deny' }
      ],
      questions: qs.map((q, i) => ({
        id: String(i),
        header: typeof q.header === 'string' ? q.header : undefined,
        question: String(q.question ?? ''),
        options: Array.isArray(q.options)
          ? (q.options as Record<string, unknown>[]).map((o) => ({ label: String(o.label ?? ''), description: typeof o.description === 'string' ? o.description : undefined }))
          : undefined,
        allowOther: true
      }))
    });
    if (decision.optionId !== 'allow') return { behavior: 'deny', message: decision.note?.trim() || 'The user skipped the question.' };
    const answers: Record<string, string> = {};
    qs.forEach((q, i) => {
      const a = questionAnswerWithNote(decision.answers?.[String(i)], decision.note);
      if (a !== undefined) answers[String(q.question ?? '')] = a;
    });
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }

  private async previewChange(toolName: string, input: Record<string, unknown>): Promise<FileChange[] | undefined> {
    try {
      const file = String(input.file_path ?? input.path ?? '');
      if (!file) return undefined;
      const abs = path.isAbsolute(file) ? file : path.join(this.ctx.session().cwd, file);
      let before: string | null = null;
      try {
        before = await fs.readFile(abs, 'utf8');
      } catch {
        before = null;
      }
      let after = before ?? '';
      if (toolName === 'Write') after = String(input.content ?? '');
      else if (toolName === 'Edit') {
        const oldS = String(input.old_string ?? '');
        const newS = String(input.new_string ?? '');
        after = input.replace_all ? (before ?? '').split(oldS).join(newS) : (before ?? '').replace(oldS, newS);
      } else if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
        for (const e of input.edits as Record<string, unknown>[]) {
          const oldS = String(e.old_string ?? '');
          const newS = String(e.new_string ?? '');
          after = e.replace_all ? after.split(oldS).join(newS) : after.replace(oldS, newS);
        }
      } else return undefined;
      return [makeFileChange(this.ctx.session().cwd, file, before, after, { newFileHeader: '(new file)' })];
    } catch {
      return undefined;
    }
  }

  private preToolUse: HookCallback = async (input) => {
    this.internalHookDepth++;
    try {
      return await this.runPreToolUse(input);
    } finally {
      this.internalHookDepth = Math.max(0, this.internalHookDepth - 1);
    }
  };

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

  private postToolUse: HookCallback = async (input) => {
    this.internalHookDepth++;
    try {
      return await this.runPostToolUse(input);
    } finally {
      this.internalHookDepth = Math.max(0, this.internalHookDepth - 1);
    }
  };

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

  private emitBackgroundTasks(): void {
    const items: OngoingItem[] = [];
    for (const task of this.backgroundTasks.values()) {
      const run = this.subagents.lookupByTaskId(task.taskId);
      if (run || task.taskType === 'local_agent') {
        items.push({
          id: run ? `subagent:${run.runId}` : `task:${task.taskId}`,
          kind: 'subagent',
          label: run?.description || task.description || 'Subagent',
          ...(run?.agent ? { agent: run.agent } : {}),
          ...(run?.runId ? { runId: run.runId } : {}),
          ...(run?.turns !== undefined ? { turns: run.turns } : {}),
          ...(run?.toolUses !== undefined ? { toolUses: run.toolUses } : {}),
          startedAt: run?.startedAt ?? task.startedAt,
          canStop: false
        });
      } else {
        items.push({
          id: `task:${task.taskId}`,
          kind: 'task',
          label: task.description || task.taskType || 'Background task',
          ...(task.taskType ? { detail: task.taskType } : {}),
          startedAt: task.startedAt,
          canStop: false
        });
      }
    }
    this.ctx.emit({ type: 'ongoing', source: 'tasks', items });
  }

  private emitHooks(): void {
    const items: OngoingItem[] = [];
    for (const hook of this.activeHooks.values()) {
      if (!hook.visible) continue;
      items.push({
        id: `hook:${hook.hookId}`,
        kind: 'hook',
        label: hook.hookName || hook.hookEvent || 'Hook',
        ...(hook.hookEvent ? { detail: hook.hookEvent } : {}),
        startedAt: hook.startedAt,
        canStop: false
      });
    }
    this.ctx.emit({ type: 'ongoing', source: 'hooks', items });
  }

  private onBackgroundTasksChanged(tasks: readonly { task_id: string; task_type?: string; description?: string; ambient?: boolean }[]): void {
    this.seenBackgroundTasksSnapshot = true;
    const prev = new Map(this.backgroundTasks);
    this.backgroundTasks.clear();
    const now = Date.now();
    for (const t of tasks) {
      if (!t || typeof t.task_id !== 'string' || !t.task_id || t.ambient === true) continue;
      const existing = prev.get(t.task_id);
      this.backgroundTasks.set(t.task_id, {
        taskId: t.task_id,
        taskType: typeof t.task_type === 'string' ? t.task_type : '',
        description: typeof t.description === 'string' ? t.description : '',
        startedAt: existing?.startedAt ?? now
      });
    }
    this.emitBackgroundTasks();
  }

  private onHookStarted(msg: { hook_id?: string; hook_name?: string; hook_event?: string }): void {
    const hookId = typeof msg.hook_id === 'string' ? msg.hook_id : '';
    const hookName = typeof msg.hook_name === 'string' ? msg.hook_name : '';
    const hookEvent = typeof msg.hook_event === 'string' ? msg.hook_event : '';
    if (!hookId) return;
    // Skip Vocs Code's own internal SDK callbacks (permission gating / file snapshots).
    if (isInternalHookName(hookName)) return;
    if (this.internalHookDepth > 0 && (hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse') && !hookName) return;
    const existing = this.activeHooks.get(hookId);
    if (existing?.timer) clearTimeout(existing.timer);
    const entry: LiveHookRun = { hookId, hookName, hookEvent, startedAt: Date.now(), visible: false };
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.activeHooks.get(hookId) !== entry) return;
      entry.visible = true;
      this.emitHooks();
    }, HOOK_VISIBILITY_DELAY_MS);
    entry.timer.unref?.();
    this.activeHooks.set(hookId, entry);
  }

  private onHookResponse(msg: { hook_id?: string }): void {
    const hookId = typeof msg.hook_id === 'string' ? msg.hook_id : '';
    if (!hookId) return;
    const entry = this.activeHooks.get(hookId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.activeHooks.delete(hookId);
    if (entry.visible) this.emitHooks();
  }

  private clearOngoing(): void {
    const hadTasks = this.backgroundTasks.size > 0;
    this.backgroundTasks.clear();
    this.seenBackgroundTasksSnapshot = false;
    let hadVisibleHooks = false;
    for (const entry of this.activeHooks.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.visible) hadVisibleHooks = true;
    }
    this.activeHooks.clear();
    if (hadTasks) this.ctx.emit({ type: 'ongoing', source: 'tasks', items: [] });
    if (hadVisibleHooks) this.ctx.emit({ type: 'ongoing', source: 'hooks', items: [] });
  }

  private reportStreamUsage(ev: {
    type: string;
    message?: { model?: string; usage?: Record<string, unknown> };
    usage?: Record<string, unknown>;
  }): void {
    if (ev.type === 'message_start') {
      this.streamOutputTokens = 0;
      this.streamReasoningTokens = 0;
      this.streamInputReported = false;
      const usage = ev.message?.usage;
      if (!usage) return;
      const input = finiteCounter(usage.input_tokens);
      const cacheRead = finiteCounter(usage.cache_read_input_tokens);
      const cacheWrite = finiteCounter(usage.cache_creation_input_tokens);
      const output = finiteCounter(usage.output_tokens);
      const sample: Partial<UsageTotals> = {
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
        ...(output !== undefined ? { outputTokens: output } : {})
      };
      this.streamInputReported = input !== undefined || cacheRead !== undefined || cacheWrite !== undefined;
      this.streamOutputTokens = output ?? 0;
      if (Object.keys(sample).length === 0) return;
      this.usage.addUsage(sample);
      const contextTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
      const model = ev.message?.model ?? this.ctx.session().activeModel?.model;
      const contextWindow = model ? findContextWindow(this.providerId ?? 'anthropic', model) : undefined;
      if (contextTokens > 0 || contextWindow) this.usage.setCumulative({ contextTokens: contextTokens > 0 ? contextTokens : undefined, contextWindow });
      this.usageReporter.report(this.usage.snapshot());
      return;
    }
    if (ev.type !== 'message_delta' || !ev.usage) return;
    const usage = ev.usage;
    const output = finiteCounter(usage.output_tokens);
    const details = usage.output_tokens_details;
    const reasoning = details && typeof details === 'object' && !Array.isArray(details) ? finiteCounter((details as Record<string, unknown>).thinking_tokens) : undefined;
    const sample: Partial<UsageTotals> = {};
    if (output !== undefined) {
      sample.outputTokens = counterDelta(this.streamOutputTokens, output);
      this.streamOutputTokens = output;
    }
    if (reasoning !== undefined) {
      sample.reasoningTokens = counterDelta(this.streamReasoningTokens, reasoning);
      this.streamReasoningTokens = reasoning;
    }
    // Newer Anthropic-compatible endpoints may send input counters only on message_delta.
    // Prefer message_start when both are present so one request is never counted twice.
    if (!this.streamInputReported) {
      const input = finiteCounter(usage.input_tokens);
      const cacheRead = finiteCounter(usage.cache_read_input_tokens);
      const cacheWrite = finiteCounter(usage.cache_creation_input_tokens);
      if (input !== undefined) sample.inputTokens = input;
      if (cacheRead !== undefined) sample.cacheReadTokens = cacheRead;
      if (cacheWrite !== undefined) sample.cacheWriteTokens = cacheWrite;
      this.streamInputReported = input !== undefined || cacheRead !== undefined || cacheWrite !== undefined;
    }
    if (Object.values(sample).some((value) => typeof value === 'number' && value > 0)) {
      this.usage.addUsage(sample);
      this.usageReporter.report(this.usage.snapshot());
    }
  }

  /**
   * Publishes the slash commands this CLI accepts, so `/goal` can be handed to the harness when it has
   * a goal of its own (see shared/goal-driver.ts). Init reports the list on every process start and
   * `commands_changed` re-reports it when skills appear mid-session; an unchanged list is not re-sent.
   */
  private reportCommands(commands: readonly SlashCommand[]): void {
    reportHarnessCommands(this.ctx, claudeHarnessCommands(commands));
  }

  /**
   * Sums the cumulative per-model counters the CLI reports, re-deriving the cost of every model it
   * could not price itself. Claude Code flags them `costBasis: 'unknown'` and charges its default
   * model's rate — $5/$25/$0.50 per Mtok for a model it has no row for — which overstates a cheap
   * third-party model by two orders of magnitude (a DeepSeek V4.1 Flash session at $203 instead of
   * the catalog's $2.38). List and managed rates are the CLI's own and are kept as reported.
   */
  private modelUsageTotals(mu: Record<string, ModelUsage>): UsageTotals {
    const totals: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };
    for (const [model, v] of Object.entries(mu)) {
      totals.inputTokens += v.inputTokens;
      totals.outputTokens += v.outputTokens;
      totals.cacheReadTokens += v.cacheReadInputTokens;
      totals.cacheWriteTokens += v.cacheCreationInputTokens;
      totals.costUsd += (v.costBasis === 'unknown' ? this.catalogCostUsd(model, v) : undefined) ?? v.costUSD;
      if (v.contextWindow) totals.contextWindow = v.contextWindow;
    }
    return totals;
  }

  /** What this app's catalog says a model costs; undefined when it has no row, leaving the CLI's number. */
  private catalogCostUsd(model: string, v: ModelUsage): number | undefined {
    const provider = this.providerId ?? 'anthropic';
    // The gateway's own cached list first: a vendor-named id like OpenRouter's `z-ai/glm-5.3-flash`
    // exists only there, so without it a model this app can price perfectly well falls back to the
    // CLI's default rate — the exact overstatement this method exists to undo.
    const models = modelsForProvider(this.ctx.settings().providers, this.providerId);
    const pricing = findPricing(provider, model, models) ?? (v.canonicalModel ? findPricing(provider, v.canonicalModel, models) : undefined);
    if (!pricing) return undefined;
    return estimateCostUsd(pricing, {
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      cacheReadTokens: v.cacheReadInputTokens,
      cacheWriteTokens: v.cacheCreationInputTokens
    });
  }

  private async consume(q: Query): Promise<void> {
    for await (const msg of q) this.handle(msg, q);
    this.closeOpenTurn();
    this.clearOngoing();
    this.compactionWaiter?.reject(new Error('Claude Code stopped during context compaction.'));
    this._busy = false;
    this.ctx.emit({ type: 'status', status: 'stopped', detail: 'Claude Code process ended' });
  }

  private handle(msg: SDKMessage, q: Query): void {
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
      case 'system': {
        const subtype = (msg as { subtype?: string }).subtype;
        if (msg.subtype === 'init') {
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
          this.onBackgroundTasksChanged(Array.isArray(m.tasks) ? m.tasks : []);
        } else if (subtype === 'hook_started') {
          this.onHookStarted(msg as unknown as { hook_id?: string; hook_name?: string; hook_event?: string });
        } else if (subtype === 'hook_response') {
          this.onHookResponse(msg as unknown as { hook_id?: string });
        } else if (subtype === 'task_started') {
          const t = msg as unknown as TaskStartedLike & { task_type?: string };
          this.subagents.onTaskStarted(t);
          // Re-enrich if `background_tasks_changed` arrived before this `task_started` bookend.
          if (this.seenBackgroundTasksSnapshot && t.task_id && this.backgroundTasks.has(t.task_id)) {
            this.emitBackgroundTasks();
          } else if (!this.seenBackgroundTasksSnapshot && t.is_backgrounded && !t.ambient && !t.skip_transcript && t.task_type !== 'local_agent' && typeof t.task_id === 'string' && t.task_id) {
            this.backgroundTasks.set(t.task_id, { taskId: t.task_id, taskType: t.task_type ?? '', description: t.description ?? '', startedAt: Date.now() });
            this.emitBackgroundTasks();
          }
        } else if (subtype === 'task_progress') {
          this.subagents.onTaskProgress(msg as unknown as TaskProgressLike);
        } else if (subtype === 'task_updated') {
          const t = msg as unknown as TaskUpdatedLike;
          this.subagents.onTaskUpdated(t);
          if (!this.seenBackgroundTasksSnapshot && t.task_id) {
            const st = t.patch?.status;
            if ((st === 'completed' || st === 'failed' || st === 'killed') && this.backgroundTasks.delete(t.task_id)) {
              this.emitBackgroundTasks();
            }
          }
        } else if (subtype === 'task_notification') {
          const t = msg as unknown as TaskNotificationLike;
          this.subagents.onTaskNotification(t);
          if (!this.seenBackgroundTasksSnapshot && t.task_id && this.backgroundTasks.delete(t.task_id)) {
            this.emitBackgroundTasks();
          }
        }
        return;
      }
      case 'stream_event': {
        this.markTurnStarted();
        if (msg.parent_tool_use_id) return; // nested subagent streams are summarized via tool items
        const ev = msg.event as { type: string; index?: number; content_block?: ContentBlockLike; delta?: { type: string; text?: string; thinking?: string }; message?: { model?: string; usage?: Record<string, unknown> }; usage?: Record<string, unknown>; output_tokens?: number };
        if (!msg.parent_tool_use_id) this.reportStreamUsage(ev);
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
        let usage: Partial<UsageTotals> | undefined;
        const mu = (msg as { modelUsage?: Record<string, ModelUsage> }).modelUsage;
        const cumulative = mu && Object.keys(mu).length > 0 ? this.modelUsageTotals(mu) : undefined;
        // Cost is settled in one step: the CLI's `total_cost_usd` is the same figure modelUsage breaks
        // down, and reporting the guess first would seed the tracker with exactly the value the catalog
        // override replaces — its counters only move up, so the higher number would stick.
        const costUsd = cumulative ? cumulative.costUsd : typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined;
        if (costUsd !== undefined) this.usage.setCumulative({ costUsd });
        if (cumulative) {
          const u = (msg as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
          this.usage.setCumulative({
            inputTokens: cumulative.inputTokens,
            outputTokens: cumulative.outputTokens,
            cacheReadTokens: cumulative.cacheReadTokens,
            cacheWriteTokens: cumulative.cacheWriteTokens,
            contextWindow: cumulative.contextWindow,
            contextTokens: u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined
          });
        }
        // Finish even when the SDK omitted modelUsage: total_cost_usd is still useful, and the
        // tracker must close its baseline so the next streamed turn starts cleanly.
        const trackerTurn = this.usage.finishTurn();
        const turnUsage = trackerTurn.usage;
        if (cumulative) usage = turnUsage ? { inputTokens: turnUsage.inputTokens, outputTokens: turnUsage.outputTokens, cacheReadTokens: turnUsage.cacheReadTokens, cacheWriteTokens: turnUsage.cacheWriteTokens } : undefined;
        this.usageReporter.report(trackerTurn.totals);
        this.usageReporter.flush();
        const turnCost = turnUsage?.costUsd ?? 0;
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
    const trackerTurn = this.usage.finishTurn();
    this.usageReporter.report(trackerTurn.totals);
    this.usageReporter.flush();
    const u = trackerTurn.usage;
    this.ctx.emit({
      type: 'item.upsert',
      item: {
        id: shortId('turn_'),
        kind: 'turn',
        ts: Date.now(),
        status: 'interrupted',
        durationMs: this.turnStartedAt > 0 ? Math.max(0, Date.now() - this.turnStartedAt) : 0,
        costUsd: u?.costUsd ?? 0,
        usage: u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens } : undefined
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

  /**
   * Make a delegated agent run on the session's own model.
   *
   * Claude Code resolves a subagent's model from its definition before anything else, and its
   * built-ins (`Explore`, `Plan`) declare `inherit` — which on a provider that is not Anthropic does
   * not mean the session's model but Claude's own default, an Anthropic id the endpoint answers with
   * a 401. So naming the model here is what makes "a subagent runs on the model this session runs
   * on" true rather than merely intended.
   *
   * `_FORCE` is required as well, not belt-and-braces: the built-ins' `inherit` is resolved before
   * the plain variable and wins over it. It is withheld exactly when the project pins a model of its
   * own, because FORCE outranks a definition's `model:` line too and would silently ignore the pin.
   */
  private async subagentModelEnv(model: string | undefined): Promise<Record<string, string | undefined>> {
    if (!model) return {};
    const env: Record<string, string | undefined> = { CLAUDE_CODE_SUBAGENT_MODEL: model };
    const pinned = await hasClaudeAgentPins(this.ctx.session().config.projectRoot).catch(() => false);
    if (!pinned) env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
    return env;
  }

  async dispose(): Promise<void> {
    // Before the reporter closes: the turn being abandoned is reported through it.
    this.closeOpenTurn();
    this.clearOngoing();
    this.usageReporter.close();
    this.compactionWaiter?.reject(new Error('Claude context compaction was cancelled.'));
    this.input.close();
    this.abort.abort();
    try {
      this.q?.close();
    } catch {
      /* ignore */
    }
    this.q = null;
    if (this.closeMemoryMcp) await this.closeMemoryMcp();
    this.closeMemoryMcp = undefined;
    // A run still open when the process goes away has no end record and no owner left to write one,
    // so close it as interrupted rather than leaving it spinning as `running` in an open app.
    await this.subagents.settle();
  }
}

/** The Claude-capable provider that backs a session: the provider its model came from when that
 *  provider can host Claude Code, else the built-in Anthropic provider. */
export function claudeProviderFor(settings: AppSettings, model: ModelRef | undefined): ProviderConfig | undefined {
  const capable = settings.providers.filter(isClaudeCapableProvider);
  return capable.find((p) => p.id === model?.provider) ?? capable.find((p) => p.id === 'anthropic') ?? capable[0];
}

/**
 * Env overlay that points Claude Code at a provider's Anthropic-format endpoint. Every non-Anthropic
 * route is wired from that base URL automatically, with the stored key sent in the header that route
 * reads (a bearer token for most gateways, `x-api-key` for OpenCode Zen) and an inherited Anthropic
 * x-api-key cleared so it is never sent to the gateway. Anthropic's own endpoint passes the stored
 * key only when the user opted in, and otherwise keeps the login.
 */
export function claudeProviderEnv(settings: AppSettings, provider: ProviderConfig | undefined, apiKey: string | undefined): Record<string, string | undefined> {
  if (!provider) return {};
  const baseUrl = anthropicBaseUrlFor(provider);
  if (baseUrl) assertEndpointUrl(baseUrl);
  if (baseUrl && baseUrl !== ANTHROPIC_DEFAULT_BASE_URL) {
    // Zen's Anthropic route reads x-api-key and answers a bearer token with "Missing API key".
    if (anthropicAuthFor(provider) === 'api-key') {
      return { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: baseUrl };
    }
    const overlay: Record<string, string | undefined> = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: baseUrl };
    if (apiKey) overlay.ANTHROPIC_AUTH_TOKEN = apiKey;
    return overlay;
  }
  return settings.claude.useProviderKey && apiKey ? { ANTHROPIC_API_KEY: apiKey } : {};
}

/**
 * claudeProviderEnv with the provider's stored key or, failing that, the key in its env var. That
 * key still has to be handed over explicitly: the child inherits the process env, but a gateway
 * reads a header this app has to set. Sessions and the pre-session model probe both resolve their
 * credentials here, so the probe starts with the endpoint and key of the session it lists models for.
 */
export async function resolveClaudeProviderEnv(settings: AppSettings, provider: ProviderConfig | undefined, getApiKey: (id: string) => Promise<string | undefined>): Promise<Record<string, string | undefined>> {
  const baseUrl = provider && anthropicBaseUrlFor(provider);
  if (baseUrl) assertEndpointUrl(baseUrl);
  // The default route does not overlay the child's base URL. Before injecting an app key,
  // validate the inherited endpoint too; external CLI-owned config remains the CLI's responsibility.
  if (provider && settings.claude.useProviderKey && baseUrl === ANTHROPIC_DEFAULT_BASE_URL && process.env.ANTHROPIC_BASE_URL) assertEndpointUrl(process.env.ANTHROPIC_BASE_URL);
  const key = provider ? await resolveProviderApiKey(provider, getApiKey) : undefined;
  return claudeProviderEnv(settings, provider, key);
}

/**
 * Discover the models the selected Claude Code runtime offers to its current login. The streaming
 * input stays open only long enough for the SDK initialization handshake; no user turn is sent.
 * `settingSources` are the ones sessions load (`settings.claude.settingSources`).
 */
export async function listClaudeModels(
  pathToClaudeCodeExecutable: string,
  envOverlay: Record<string, string | undefined> = {},
  settingSources: SettingSource[] = []
): Promise<ModelInfo[]> {
  const input = new AsyncQueue<SDKUserMessage>();
  const abortController = new AbortController();
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: APP_ID };
  // A desktop app launched from a Claude terminal must not look like a nested Claude Code process.
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CODE_USE_BEDROCK' && key !== 'CLAUDE_CODE_USE_VERTEX' && key !== 'CLAUDE_CODE_USE_FOUNDRY') delete env[key];
  }
  delete env.CLAUDECODE;
  Object.assign(env, envOverlay);

  const q = query({
    prompt: input,
    options: {
      // Model discovery is global to the runtime/login. Do not let an IPC-provided project path load
      // project settings, hooks or MCP servers into this short-lived process.
      cwd: process.cwd(),
      pathToClaudeCodeExecutable,
      permissionMode: 'plan',
      // ~/.claude/settings.json decides what a session runs against: its env (base URL, Bedrock or
      // Vertex), apiKeyHelper and model. Read it whenever sessions do, or the list describes a
      // different endpoint. Project and local settings resolve against cwd, which here is this app's
      // own directory rather than any project, so they stay out.
      settingSources: settingSources.filter((source) => source === 'user'),
      // User settings also declare hooks and MCP servers; this process only answers supportedModels().
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      persistSession: false,
      env,
      abortController
    }
  });
  try {
    return claudeSdkCatalog(await withTimeout(q.supportedModels(), 20_000, 'Claude supportedModels'));
  } finally {
    input.close();
    abortController.abort();
    q.close();
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          const o = c as { type?: string; text?: string };
          if (o.type === 'text' && o.text) return o.text;
          if (o.type === 'image') return '[image]';
        }
        return '';
      })
      .join('\n');
  }
  return '';
}
