import { assertEndpointUrl } from '../../shared/endpoint-policy';
import { isBuiltinTrustedTool } from '../../shared/builtin-tools';
import { isEffortLevel } from '../../shared/harness-meta';
import type { EffortLevel, FileChange, ModelInfo, ModelRef, PermissionMode, UserInput } from '../../shared/types';
import { toCodex, type CodexMcpConfig } from '../mcp/effective';
import { VOCS_MISSION_SERVER_ID } from '../mcp/mission';
import { isMissionToolFor } from '../mission-mode/tools';
import { codexProviderModels } from '../models/codex-catalog';
import { CODEX_STATIC_MODELS } from '../models/static-models';
import { deferred, errorMessage, shortId, withTimeout, type Deferred } from '../util/async';
import { CodexChildThreadTracker, CodexItemTracker, mapCodexFileChanges, type FileChangeThreadItem, type ThreadItem } from './codex-items';
import { applyCodexMcpSuppression, getCodexMcpServers } from './codex-mcp-config';
import { codexModelSpeedTiers, codexModelToInfo, listCodexModels, readCodexModelCatalog } from './codex-models';
import {
  codexFastModeCapability,
  codexFastModeStatus,
  codexFastServiceTier,
  isCodexFastTier,
  isCodexFastUnavailableStderr,
  resolveCodexProvider,
  writeCodexSessionImage
} from './codex-provider';
import { codexSkillCommands, codexSkillInvocation, listCodexSkills, type CodexSkill } from './codex-skills';
import { CodexUsageTracker, type CodexTokenUsageNotification } from './codex-usage';
import { reportHarnessCommands } from './commands';
import { JsonRpcStdioClient } from './jsonrpc';
import { gateAction, OPTIONS_ALLOW_DENY, requiresPathApproval } from './permissions';
import { questionAnswerWithNote } from './question-answers';
import { spawnTool } from './spawn';
import { missionPrompt } from './system-prompt';
import type { HarnessAdapter, HarnessContext } from './types';

export { codexModelToInfo, listCodexModels };

/* ---- Minimal protocol shapes (from `codex app-server generate-ts`) ---- */
type AskForApproval = 'untrusted' | 'on-request' | 'never';
type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

/**
 * Codex approval policies. Below Full every tier uses `untrusted`: Codex runs only its known-safe
 * read-only commands unasked and sends an approval request for every other command and every
 * patch, so the app's tier gate (`gateAction`) decides each one. `on-request` is never used: under
 * it Codex runs any command that stays inside the sandbox without asking, which would let a
 * dangerous command run silently in Auto. `never` is Full access.
 */
function approvalPolicyFor(mode: PermissionMode, missionBuilder = false): AskForApproval {
  // A Mission Builder hands publish/elevation commands to the user in every tier, so even its Full
  // access keeps Codex asking; the gate then allows everything else at once.
  return mode === 'full-auto' && !missionBuilder ? 'never' : 'untrusted';
}

/**
 * Codex's per-server MCP tool approval mode (`AppToolApproval`, codex 0.153: auto | prompt | writes |
 * approve). `approve` runs the server's tools without an approval request, which is what lets a
 * Lead in Plan (read-only sandbox, `untrusted`) and a Builder below Full access use the Mission
 * tools: other MCP approvals are declined (a Builder's go to the app). Checked against codex
 * 0.153.4 with a scripted model: the mode alone runs an unannotated tool in a Plan thread, the
 * tools' read-only hints alone do too, and the elicitation fallback below covers a runtime that
 * asks anyway.
 */
const MISSION_TOOLS_APPROVAL_MODE = 'approve';

/** Codex's `_meta.codex_approval_kind` on the elicitation it sends to approve an MCP tool call. */
const MCP_TOOL_APPROVAL_KIND = 'mcp_tool_call';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One MCP tool approval Codex asks for, as far as it can be read; undefined for any other elicitation. */
interface McpToolApproval {
  server: string;
  /** Codex 0.153 names it only in the message: `Allow the <server> MCP server to run tool "<tool>"?`. */
  tool?: string;
  params?: unknown;
  message?: string;
}

function mcpToolApproval(p: unknown): McpToolApproval | undefined {
  const n = isRecord(p) ? p : undefined;
  const meta = isRecord(n?._meta) ? n._meta : undefined;
  if (typeof n?.serverName !== 'string' || meta?.codex_approval_kind !== MCP_TOOL_APPROVAL_KIND) return undefined;
  const message = typeof n.message === 'string' ? n.message : undefined;
  const tool = typeof meta.tool_name === 'string' ? meta.tool_name : message ? /\brun tool "([^"]+)"/.exec(message)?.[1] : undefined;
  return { server: n.serverName, ...(tool ? { tool } : {}), ...(meta.tool_params !== undefined ? { params: meta.tool_params } : {}), ...(message ? { message } : {}) };
}

/**
 * A Mission Builder's Codex asks before every MCP tool but the Mission server's, in every tier:
 * Codex otherwise runs a tool its server annotates read-only (or that the user's config approves)
 * without asking, and a third-party tool may publish. Covers the servers Codex loads from its own
 * config as well as the injected ones; a server switched off stays off.
 */
async function promptOtherMcpServers(config: CodexMcpConfig['config'], read: () => Promise<unknown>): Promise<void> {
  const inherited = await read();
  if (!isRecord(inherited)) throw new Error('Unexpected Codex MCP configuration.');
  for (const id of new Set([...Object.keys(config), ...Object.keys(inherited)])) {
    if (id === VOCS_MISSION_SERVER_ID) continue;
    const native = inherited[id];
    if (config[id]?.enabled === false || (!config[id] && (!isRecord(native) || native.enabled === false))) continue;
    const entry: Record<string, unknown> = (config[id] ??= {});
    entry.default_tools_approval_mode = 'prompt';
    // A per-tool approval mode in the user's config outranks the server's; prompt those too.
    const tools = isRecord(native) && isRecord(native.tools) ? Object.keys(native.tools) : [];
    if (tools.length) entry.tools = Object.fromEntries(tools.map((tool) => [tool, { approval_mode: 'prompt' }]));
  }
}

/** Session grants are keyed per tool, never per command line: one for shell, one for patches. */
type SessionGrant = 'command' | 'file_change';

/**
 * True when a command approval asks to run outside the sandbox. Codex attaches a reason only to
 * those: the model's `justification` is accepted only with `sandbox_permissions:
 * "require_escalated"`, and a sandbox-denied run is retried with "Command failed; retry without
 * sandbox?". A managed-network approval carries its own context and stays an ordinary command.
 * Escaping the sandbox reaches beyond the project, so the gate treats it as an outside action.
 */
function requestsUnsandboxedRun(n: { reason?: string | null; networkApprovalContext?: unknown }): boolean {
  return !n.networkApprovalContext && !!n.reason?.trim();
}

function sandboxPolicyFor(mode: PermissionMode, cwd: string): SandboxPolicy {
  switch (mode) {
    case 'plan':
      return { type: 'readOnly', networkAccess: false };
    case 'full-auto':
      return { type: 'dangerFullAccess' };
    case 'auto':
      return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    default:
      return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
}

function sandboxModeFor(mode: PermissionMode): 'read-only' | 'workspace-write' | 'danger-full-access' {
  return mode === 'plan' ? 'read-only' : mode === 'full-auto' ? 'danger-full-access' : 'workspace-write';
}

export class CodexAppServerAdapter implements HarnessAdapter {
  readonly id = 'codex' as const;
  private rpc: JsonRpcStdioClient | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private _busy = false;
  private model: string | undefined;
  private modelProvider: string | undefined;
  private effort: EffortLevel | undefined;
  private fastMode = false;
  private fastModeModel: ModelRef | undefined;
  private speedTiers = new Map<string, string[]>();
  private serviceTier = 'default';
  private fileChangeItems = new Map<string, FileChange[]>();
  /**
   * Tools the user allowed "for session". Kept only here: Codex is always sent a one-time accept,
   * so no grant outlives a tier change inside Codex's own approval memory.
   */
  private sessionGrants = new Set<SessionGrant>();
  private queue: UserInput[] = [];
  private turnStartedAt = 0;
  private readonly usage: CodexUsageTracker;
  private readonly items: CodexItemTracker;
  private readonly childThreads: CodexChildThreadTracker;
  private models: ModelInfo[] = [];
  /** This cwd's enabled skills, from `skills/list`; empty until it answers. */
  private skills: CodexSkill[] = [];
  private compactionWaiter: Deferred<void> | null = null;

  constructor(private readonly ctx: HarnessContext) {
    this.childThreads = new CodexChildThreadTracker((event) => this.ctx.emit(event));
    this.items = new CodexItemTracker({
      emit: (event) => this.ctx.emit(event),
      activeModel: () => this.model,
      onFileChanges: (item) => this.rememberFileChanges(item),
      onSubagentLabel: (label) => this.childThreads.noteSubagentLabel(label)
    });
    this.usage = new CodexUsageTracker(ctx.session().usage, {
      emit: (event) => this.ctx.emit(event),
      warn: (message) => this.info(message, 'warn'),
      pricingContext: () => ({
        fastMode: this.fastMode,
        serviceTier: this.serviceTier,
        model: this.model ?? this.fastModeModel?.model ?? '',
        provider: this.modelProvider ?? 'openai',
        models: this.models
      })
    });
  }

  get busy(): boolean {
    return this._busy;
  }

  /** App built-in servers this thread was handed with the provenance the app set. */
  private injectedBuiltins = new Set<string>();

  private missionBuilder(): boolean {
    return this.ctx.session().mission?.role === 'builder';
  }

  /**
   * Codex asks to approve an MCP tool call through an elicitation (codex 0.153: `_meta` is
   * `{ codex_approval_kind: 'mcp_tool_call', persist, tool_description, tool_params, … }`). An
   * ordinary session and a Lead decline every one, as before, except a Mission tool of the session's
   * own role from the Mission server (the gateway still refuses anything the token's role does not
   * hold). A Builder, whose Codex asks before every other MCP tool (`promptOtherMcpServers`), runs a
   * trusted tool of an app built-in at once and asks the app about everything else.
   */
  private async answerElicitation(p: unknown): Promise<boolean> {
    const approval = mcpToolApproval(p);
    const role = this.ctx.session().mission?.role;
    if (!approval || !role) return false;
    if (approval.server === VOCS_MISSION_SERVER_ID) return approval.tool === undefined || isMissionToolFor(role, approval.tool);
    if (role !== 'builder') return false;
    if (approval.tool && this.injectedBuiltins.has(approval.server) && isBuiltinTrustedTool(approval.server, approval.tool)) return true;
    if (this.ctx.permissionMode() === 'plan') return false;
    const name = approval.tool ? `${approval.server}.${approval.tool}` : approval.server;
    const decision = await this.ctx.requestApproval({
      kind: 'tool',
      title: `Allow ${name}?`,
      toolName: name,
      input: approval.params,
      description: approval.message,
      options: OPTIONS_ALLOW_DENY
    });
    return decision.optionId === 'allow' || decision.optionId === 'allow_session';
  }

  private resolveCodexProvider() {
    return resolveCodexProvider(this.ctx.session(), this.ctx.settings());
  }

  async start(): Promise<void> {
    const meta = this.ctx.session();
    const provider = this.resolveCodexProvider();
    if (provider) assertEndpointUrl(provider.baseUrl);
    const bin = this.ctx.runtime.resolve('codex');
    if (!bin) throw new Error('Codex CLI not found. Install it with `npm install -g @openai/codex` or set the path in Settings.');
    const env: NodeJS.ProcessEnv = { ...process.env };
    const key = await this.ctx.getApiKey('openai');
    if (key && !env.OPENAI_API_KEY && !env.CODEX_API_KEY) env.OPENAI_API_KEY = key;
    if (provider?.envKey) {
      const custom = await this.ctx.getApiKey(provider.id);
      if (custom) env[provider.envKey] = custom;
    }
    this.ctx.log('info', `spawning codex app-server: ${bin.path} (${bin.source} runtime) in ${meta.cwd}`);
    // Enable the protocol feature, not paid service: each thread/turn explicitly chooses its tier.
    const child = spawnTool(bin.path, ['app-server', '-c', 'features.fast_mode=true'], { cwd: meta.cwd, env });
    this.rpc = new JsonRpcStdioClient(child);
    try {
      this.rpc.onStderr = (l) => {
        this.ctx.log('debug', `[codex] ${l}`);
        if (this.fastMode && isCodexFastUnavailableStderr(l)) {
          this.serviceTier = 'default';
          this.ctx.updateMeta({ fastModeStatus: { state: 'unavailable', detail: l } });
        }
      };
      this.rpc.onClose = (code) => {
        this.compactionWaiter?.reject(new Error(`Codex stopped during context compaction (${code}).`));
        this._busy = false;
        this.childThreads.clear();
        this.ctx.emit({ type: 'status', status: 'stopped', detail: `codex app-server exited (${code})` });
      };
      this.wireNotifications(this.rpc);
      this.wireServerRequests(this.rpc);

      await withTimeout(
        this.rpc.request('initialize', {
          clientInfo: { name: 'vocs-code', title: 'Vocs Code', version: '0.1.0' },
          capabilities: { experimentalApi: true, requestAttestation: false }
        }),
        30_000,
        'codex initialize'
      );

      this.model = meta.config.model?.model || meta.activeModel?.model;
      this.modelProvider = provider?.id;
      this.effort = this.ctx.effort();
      this.fastModeModel = meta.config.model ?? meta.activeModel;
      this.fastMode = meta.config.fastMode === true;
      // Prefer the runtime's exact advertised capabilities over our conservative model candidates.
      if (this.fastMode && !provider) {
        await this.listModels();
        if (!this.model) {
          this.model = this.models.find((entry) => entry.isDefault)?.id;
          if (this.model) this.fastModeModel = { provider: 'openai', model: this.model };
        }
      }
      this.reportFastMode();
      const fast = this.fastMode && this.fastModeCapability().supported;
      const mode = this.ctx.permissionMode();
      const common: Record<string, unknown> = {
        model: this.model ?? null,
        modelProvider: this.modelProvider ?? null,
        serviceTier: fast ? this.fastServiceTier() : 'default',
        cwd: meta.cwd,
        approvalPolicy: approvalPolicyFor(mode, this.missionBuilder()),
        sandbox: sandboxModeFor(mode)
      };
      // A mission session delegates through its Builders, never Codex's own agents.
      const config: Record<string, unknown> = { features: { fast_mode: true, ...(meta.mission ? { multi_agent: false } : {}) }, service_tier: fast ? this.fastServiceTier() : 'default' };
      // The role prompt rides as developer instructions; Codex takes them only at thread start/resume.
      const missionText = (await missionPrompt(this.ctx))?.trim();
      if (missionText) common.developerInstructions = missionText;
      if (provider) {
        config.model_providers = {
          [provider.id]: { name: provider.name, base_url: provider.baseUrl, env_key: provider.envKey, wire_api: provider.wireApi }
        };
      }
      // The app-server takes `config` over JSON-RPC, not argv, so resolved values may be inlined.
      const mcp = await this.ctx.mcpServers().catch((e) => {
        this.ctx.log('warn', `mcp: ${errorMessage(e)}`);
        return [];
      });
      const mcpServers = toCodex(mcp, 'inline').config;
      // Only the definition the app built (by its provenance) gets the Mission tools' approval mode.
      const mission = mcp.find(({ def }) => def.id === VOCS_MISSION_SERVER_ID && def.builtin === VOCS_MISSION_SERVER_ID);
      if (meta.mission && mission && mcpServers[VOCS_MISSION_SERVER_ID]) mcpServers[VOCS_MISSION_SERVER_ID].default_tools_approval_mode = MISSION_TOOLS_APPROVAL_MODE;
      this.injectedBuiltins = new Set(mcp.filter(({ def }) => def.builtin === def.id).map(({ def }) => def.id));
      let inherited: Promise<unknown> | undefined;
      const readInherited = () => inherited ??= getCodexMcpServers(this.rpc!, meta.cwd);
      await applyCodexMcpSuppression(mcpServers, this.ctx.ownedMcpIds(), readInherited);
      if (this.missionBuilder()) await promptOtherMcpServers(mcpServers, readInherited);
      if (Object.keys(mcpServers).length) config.mcp_servers = mcpServers;
      if (Object.keys(config).length) common.config = config;
      let res: { thread: { id: string }; model: string; modelProvider: string; reasoningEffort: string | null; serviceTier?: string | null };
      if (meta.harnessRef.codexThreadId) {
        // Restored usage can arrive in the same stdout chunk as the resume response.
        this.threadId = meta.harnessRef.codexThreadId;
        try {
          res = await withTimeout(this.rpc.request('thread/resume', { threadId: this.threadId, ...common }), 30_000, 'thread/resume');
        } catch (e) {
          this.threadId = null;
          this.info(`Could not resume Codex thread (${errorMessage(e)}); starting a new one.`, 'warn');
          res = await withTimeout(this.rpc.request('thread/start', { ...common, sessionStartSource: null }), 30_000, 'thread/start');
        }
      } else {
        res = await withTimeout(this.rpc.request('thread/start', common), 30_000, 'thread/start');
      }
      this.threadId = res.thread.id;
      this.serviceTier = res.serviceTier ?? (fast ? this.fastServiceTier() : 'default');
      this.fastModeModel = { provider: res.modelProvider || 'openai', model: res.model };
      this.reportFastMode();
      if (fast && res.serviceTier !== undefined && !isCodexFastTier(res.serviceTier)) {
        this.ctx.updateMeta({ fastModeStatus: { state: 'unavailable', detail: 'Codex did not accept a Fast service tier.' } });
      }
      this.ctx.updateRef({ codexThreadId: this.threadId });
      this.ctx.updateMeta({
        activeModel: { provider: res.modelProvider || 'openai', model: res.model },
        activeEffort: isEffortLevel(res.reasoningEffort) ? res.reasoningEffort : undefined
      });
      this.ctx.emit({ type: 'status', status: 'idle' });
      void this.listModels().then((models) => models.length && this.ctx.emit({ type: 'models', models }));
      this.refreshSkills();
    } catch (e) {
      // Handshake failed after spawn: tear the transport down so no app-server (with its
      // injected API keys) is orphaned, then rethrow. close() awaits the tree kill.
      const rpc = this.rpc;
      this.rpc = null;
      await rpc?.close();
      throw e;
    }
  }

  /** Lists this cwd's skills for the composer and for `/skill` translation; a failure only costs the suggestions. */
  private refreshSkills(): void {
    const rpc = this.rpc;
    if (!rpc) return;
    void listCodexSkills(rpc, this.ctx.session().cwd)
      .then((skills) => {
        if (this.rpc !== rpc) return;
        this.skills = skills;
        reportHarnessCommands(this.ctx, codexSkillCommands(skills));
      })
      .catch((e) => this.ctx.log('debug', `codex skills/list failed: ${errorMessage(e)}`));
  }

  private wireNotifications(rpc: JsonRpcStdioClient): void {
    // An invalidation signal for the whole process, so it carries no thread id: list again.
    rpc.onNotification('skills/changed', () => this.refreshSkills());
    // Codex also streams spawned threads on this connection. Only this session's thread
    // owns its turn, transcript and usage. Parent-thread subagent activity still arrives here.
    const onThreadNotification = (method: string, handle: (params: unknown) => void): void => {
      rpc.onNotification(method, (params) => {
        if (this.threadId && (params as { threadId?: string } | undefined)?.threadId === this.threadId) handle(params);
      });
    };
    // Settings acknowledge the configured tier, not the tier actually served by the API.
    onThreadNotification('thread/settings/updated', (p) => {
      const tier = (p as { threadSettings?: { serviceTier?: string | null } }).threadSettings?.serviceTier;
      if (tier === undefined) return;
      this.serviceTier = tier ?? 'default';
      if (this.fastMode && !isCodexFastTier(tier)) {
        this.ctx.updateMeta({ fastModeStatus: { state: 'unavailable', detail: `Codex selected service tier: ${this.serviceTier}` } });
      }
    });
    rpc.onNotification('thread/closed', (p) => this.childThreads.onChildThreadEnded((p as { threadId?: string }).threadId));
    rpc.onNotification('turn/started', (p) => {
      const n = p as { threadId?: string; turn: { id: string } };
      if (!this.threadId) return;
      if (n.threadId !== this.threadId) {
        this.childThreads.onChildTurnStarted(n.threadId);
        return;
      }
      this.turnId = n.turn.id;
      this._busy = true;
      if (!this.turnStartedAt) this.usage.beginTurn();
      this.turnStartedAt = this.turnStartedAt || Date.now();
      this.ctx.emit({ type: 'status', status: 'running' });
    });
    rpc.onNotification('item/started', (p) => {
      const { threadId, item } = p as { threadId: string; item: ThreadItem };
      if (threadId === this.threadId) this.items.upsertItem(item, false);
      // Child approvals can still reach this client. The approval request refers to this item's patch.
      else if (item.type === 'fileChange') this.rememberFileChanges(item as FileChangeThreadItem);
    });
    onThreadNotification('item/completed', (p) => this.items.upsertItem((p as { item: ThreadItem }).item, true));
    onThreadNotification('item/agentMessage/delta', (p) => {
      const n = p as { itemId: string; delta: string };
      this.items.applyTextDelta(n.itemId, n.delta);
    });
    onThreadNotification('item/plan/delta', (p) => {
      const n = p as { itemId: string; delta: string };
      this.items.applyTextDelta(n.itemId, n.delta);
    });
    const reasoningDelta = (p: unknown) => {
      const n = p as { itemId: string; delta: string };
      this.items.applyReasoningDelta(n.itemId, n.delta);
    };
    onThreadNotification('item/reasoning/summaryTextDelta', reasoningDelta);
    onThreadNotification('item/reasoning/textDelta', reasoningDelta);
    onThreadNotification('item/reasoning/summaryPartAdded', (p) => this.items.applyReasoningSummaryPartAdded((p as { itemId: string }).itemId));
    onThreadNotification('item/commandExecution/outputDelta', (p) => {
      const n = p as { itemId: string; delta: string };
      this.items.applyToolOutputDelta(n.itemId, n.delta);
    });
    onThreadNotification('item/fileChange/outputDelta', (p) => {
      const n = p as { itemId: string; delta: string };
      this.items.applyToolOutputDelta(n.itemId, n.delta);
    });
    rpc.onNotification('turn/completed', (p) => {
      const n = p as { threadId?: string; turn: { id: string; status: 'completed' | 'interrupted' | 'failed' | 'inProgress'; error: { message: string } | null; durationMs: number | null } };
      if (!this.threadId) return;
      if (n.threadId !== this.threadId) {
        this.childThreads.onChildThreadEnded(n.threadId);
        return;
      }
      this._busy = false;
      this.turnId = null;
      this.items.finishStreaming();
      const status = n.turn.status === 'failed' ? 'failed' : n.turn.status === 'interrupted' ? 'interrupted' : 'completed';
      if (this.fastMode && status === 'failed') this.ctx.updateMeta({ fastModeStatus: { state: 'unavailable', detail: n.turn.error?.message ?? 'Codex turn failed.' } });
      const completed = this.usage.finishTurn();
      this.ctx.emit({ type: 'usage', totals: completed.totals });
      const usage = completed.usage;
      const turnCost = usage?.costUsd;
      this.ctx.emit({
        type: 'item.upsert',
        item: { id: shortId('turn_'), kind: 'turn', ts: Date.now(), status, durationMs: n.turn.durationMs ?? Date.now() - this.turnStartedAt, usage, costUsd: turnCost, error: n.turn.error?.message }
      });
      this.turnStartedAt = 0;
      this.ctx.emit({ type: 'status', status: 'idle' });
      const next = this.queue.shift();
      this.ctx.updateMeta({ queued: this.queue.length });
      if (next) void this.send({ ...next, mode: 'now' }).catch((e) => this.info(errorMessage(e), 'error'));
    });
    onThreadNotification('thread/tokenUsage/updated', (p) => this.usage.applyNotification(p as CodexTokenUsageNotification));
    onThreadNotification('error', (p) => {
      const n = p as { error: { message: string }; willRetry: boolean };
      if (this.fastMode && !n.willRetry) this.ctx.updateMeta({ fastModeStatus: { state: 'unavailable', detail: n.error.message } });
      this.info(`${n.error.message}${n.willRetry ? ' (retrying)' : ''}`, n.willRetry ? 'warn' : 'error');
    });
    rpc.onNotification('warning', (p) => this.ctx.log('warn', `[codex] ${JSON.stringify(p)}`));
    rpc.onNotification('configWarning', (p) => this.ctx.log('warn', `[codex config] ${JSON.stringify(p)}`));
    onThreadNotification('thread/name/updated', (p) => {
      const n = p as { name?: string | null };
      if (n.name && /^New session|^Untitled/i.test(this.ctx.session().title)) this.ctx.updateMeta({ title: n.name });
    });
    onThreadNotification('thread/compacted', () => {
      this.info('Codex compacted the conversation context.');
      this.compactionWaiter?.resolve();
    });
    onThreadNotification('model/rerouted', (p) => this.info(`Model rerouted: ${JSON.stringify(p)}`, 'warn'));
    rpc.onNotification('account/rateLimits/updated', (p) => this.ctx.log('debug', `[codex rate limits] ${JSON.stringify(p)}`));
  }

  private wireServerRequests(rpc: JsonRpcStdioClient): void {
    // Every grant goes back to Codex as a one-time accept; "allow for session" lives in sessionGrants.
    rpc.onServerRequest('item/commandExecution/requestApproval', async (p) => {
      const n = p as { itemId: string; command?: string | null; cwd?: string | null; reason?: string | null; networkApprovalContext?: unknown };
      const verdict = await this.approveCommand({
        command: n.command ?? '(command)',
        cwd: n.cwd ?? undefined,
        reason: n.reason ?? undefined,
        unsandboxed: requestsUnsandboxedRun(n),
        toolItemId: n.itemId
      });
      return { decision: verdict.allowed ? 'accept' : 'decline' };
    });
    rpc.onServerRequest('item/fileChange/requestApproval', async (p) => {
      const n = p as { itemId: string; reason?: string | null; grantRoot?: string | null };
      const changes = this.fileChangeItems.get(n.itemId);
      // The item/started notification names the patch's paths; without it the paths are unknown,
      // and an unknown target is treated as outside the project.
      const verdict = await this.approveFileChange({
        paths: changes ? changes.flatMap((c) => [c.path, c.oldPath]) : undefined,
        grantRoot: n.grantRoot ?? undefined,
        title: changes?.length ? `Apply changes to ${changes.length} file${changes.length === 1 ? '' : 's'}?` : 'Apply file changes?',
        description: n.reason ?? (n.grantRoot ? `Requests write access under ${n.grantRoot}` : undefined),
        changes,
        toolItemId: n.itemId
      });
      return { decision: verdict.allowed ? 'accept' : 'decline' };
    });
    rpc.onServerRequest('item/tool/requestUserInput', async (p) => {
      const n = p as { questions: { id: string; header: string; question: string; isOther: boolean; isSecret: boolean; options: { label: string; description: string }[] | null }[] };
      const decision = await this.ctx.requestApproval({
        kind: 'question',
        title: 'Codex has a question',
        options: [
          { id: 'allow', label: 'Answer', kind: 'allow' },
          { id: 'deny', label: 'Skip', kind: 'deny' }
        ],
        questions: n.questions.map((q) => ({ id: q.id, header: q.header, question: q.question, options: q.options ?? undefined, allowOther: q.isOther, secret: q.isSecret }))
      });
      const answers: Record<string, { answers: string[] }> = {};
      const note = decision.note?.trim();
      for (const q of n.questions) {
        // Skip must never leak stale selections; this protocol has no separate denial-note field.
        const a = decision.optionId === 'allow'
          ? questionAnswerWithNote(decision.answers?.[q.id], note)
          : note ? questionAnswerWithNote('The user skipped the question.', note) : undefined;
        answers[q.id] = { answers: a ? [a] : [] };
      }
      return { answers };
    });
    rpc.onServerRequest('mcpServer/elicitation/request', async (p) => await this.answerElicitation(p)
      ? { action: 'accept', content: {}, _meta: null }
      : { action: 'decline', content: null, _meta: null });
    rpc.onServerRequest('execCommandApproval', async (p) => {
      const n = p as { command?: string[] | string; cwd?: string; reason?: string | null };
      const verdict = await this.approveCommand({
        command: Array.isArray(n.command) ? n.command.join(' ') : (n.command ?? '(command)'),
        cwd: n.cwd,
        reason: n.reason ?? undefined,
        unsandboxed: requestsUnsandboxedRun(n)
      });
      return { decision: verdict.allowed ? 'approved' : { denied: { rejection: verdict.rejection } } };
    });
    rpc.onServerRequest('applyPatchApproval', async (p) => {
      const n = p as { reason?: string; fileChanges?: Record<string, unknown>; grantRoot?: string | null };
      const files = Object.keys(n.fileChanges ?? {});
      // This legacy request carries no item id, so resolve the affected paths here: the keys are
      // the written paths and an update may also move a file to a new path.
      const moves = Object.values(n.fileChanges ?? {}).map((change) => (change as { move_path?: unknown } | null)?.move_path);
      const verdict = await this.approveFileChange({
        paths: [...files, ...moves.filter((m): m is string => typeof m === 'string')],
        grantRoot: n.grantRoot ?? undefined,
        title: 'Apply file changes?',
        description: n.reason ?? (n.grantRoot ? `Requests write access under ${n.grantRoot}` : files.join(', ')),
        changes: files.map((f) => ({ path: f, kind: 'update' as const }))
      });
      return { decision: verdict.allowed ? 'approved' : { denied: { rejection: verdict.rejection } } };
    });
  }

  /** True when any target resolves outside the project once symlinks and junctions are followed. */
  private async leavesProject(targets: (string | undefined)[]): Promise<boolean> {
    const cwd = this.ctx.session().cwd;
    const checks = targets.filter((t): t is string => !!t).map((t) => requiresPathApproval(cwd, t));
    return (await Promise.all(checks)).some(Boolean);
  }

  /** The Vocs Code tier gate for one Codex shell approval; prompts only when the tier says ask. */
  private async approveCommand(req: { command: string; cwd?: string; reason?: string; unsandboxed: boolean; toolItemId?: string }): Promise<{ allowed: boolean; rejection: string }> {
    const mode = this.ctx.permissionMode();
    if (mode === 'plan') return { allowed: false, rejection: 'Plan mode' };
    const outsideWorkspace = mode !== 'full-auto' && (req.unsandboxed || (await this.leavesProject([req.cwd])));
    const verdict = gateAction(mode, { mutating: true, isEdit: false, command: req.command, sessionAllowed: this.sessionGrants.has('command'), outsideWorkspace, missionBuilder: this.missionBuilder() });
    if (verdict === 'allow') return { allowed: true, rejection: '' };
    if (verdict === 'deny') return { allowed: false, rejection: 'Denied by the permission mode' };
    const decision = await this.ctx.requestApproval({
      kind: 'command',
      title: 'Codex wants to run a command',
      description: req.reason,
      command: req.command,
      cwd: req.cwd ?? this.ctx.session().cwd,
      toolItemId: req.toolItemId,
      options: OPTIONS_ALLOW_DENY
    });
    if (decision.optionId === 'allow_session') this.sessionGrants.add('command');
    if (decision.optionId === 'allow' || decision.optionId === 'allow_session') return { allowed: true, rejection: '' };
    return { allowed: false, rejection: decision.note || 'User declined' };
  }

  /**
   * The tier gate for one Codex patch. `paths` undefined means the targets are unknown, which
   * counts as outside the project; so does a grantRoot that leaves it.
   */
  private async approveFileChange(req: {
    paths: (string | undefined)[] | undefined;
    grantRoot?: string;
    title: string;
    description?: string;
    changes?: FileChange[];
    toolItemId?: string;
  }): Promise<{ allowed: boolean; rejection: string }> {
    const mode = this.ctx.permissionMode();
    if (mode === 'plan') return { allowed: false, rejection: 'Plan mode' };
    const outsideWorkspace = mode !== 'full-auto' && (!req.paths || (await this.leavesProject([...req.paths, req.grantRoot])));
    const verdict = gateAction(mode, { mutating: true, isEdit: true, sessionAllowed: this.sessionGrants.has('file_change'), outsideWorkspace });
    if (verdict === 'allow') return { allowed: true, rejection: '' };
    if (verdict === 'deny') return { allowed: false, rejection: 'Denied by the permission mode' };
    const decision = await this.ctx.requestApproval({
      kind: 'file_change',
      title: req.title,
      description: req.description,
      changes: req.changes,
      toolItemId: req.toolItemId,
      options: OPTIONS_ALLOW_DENY
    });
    if (decision.optionId === 'allow_session') this.sessionGrants.add('file_change');
    if (decision.optionId === 'allow' || decision.optionId === 'allow_session') return { allowed: true, rejection: '' };
    return { allowed: false, rejection: decision.note || 'User declined' };
  }

  private rememberFileChanges(item: FileChangeThreadItem): FileChange[] {
    const changes = mapCodexFileChanges(item);
    this.fileChangeItems.set(item.id, changes);
    return changes;
  }

  private info(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level, text } });
  }

  async send(input: UserInput): Promise<void> {
    if (!this.rpc) await this.start();
    if (!this.rpc || !this.threadId) throw new Error('Codex thread is not ready');
    const content: unknown[] = [];
    // A picked `/skill args` goes out as Codex's `$skill args` plus the skill item, so app-server runs
    // that SKILL.md instead of passing the slash to the model as text (./codex-skills.ts).
    const invocation = codexSkillInvocation(input.text ?? '', this.skills.length ? this.skills : this.ctx.session().harnessCommandList ?? []);
    if (input.text) content.push({ type: 'text', text: invocation.text, text_elements: [] });
    const skill = invocation.skill as Partial<CodexSkill> | undefined;
    if (skill?.path) content.push({ type: 'skill', name: skill.name, path: skill.path });
    for (const img of input.images ?? []) {
      const file = await writeCodexSessionImage(this.ctx.sessionDir, img);
      content.push({ type: 'localImage', path: file });
    }
    if (this._busy && this.turnId) {
      if (input.mode === 'steer') {
        await withTimeout(this.rpc.request('turn/steer', { threadId: this.threadId, input: content, expectedTurnId: this.turnId }), 30_000, 'turn/steer');
        return;
      }
      this.queue.push({ ...input, mode: 'now' });
      this.ctx.updateMeta({ queued: this.queue.length });
      return;
    }
    const mode = this.ctx.permissionMode();
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: content,
      cwd: this.ctx.session().cwd,
      approvalPolicy: approvalPolicyFor(mode, this.missionBuilder()),
      sandboxPolicy: sandboxPolicyFor(mode, this.ctx.session().cwd),
      model: this.model ?? null,
      effort: this.effort ?? null,
      serviceTier: this.fastMode && this.fastModeCapability().supported ? this.fastServiceTier() : 'default'
    };
    this.reportFastMode();
    this.serviceTier = String(params.serviceTier);
    this.usage.resetFastWarning();
    this._busy = true;
    this.turnStartedAt = Date.now();
    this.usage.beginTurn();
    this.ctx.emit({ type: 'status', status: 'running' });
    try {
      // turn/start resolves when the server accepts the turn; the turn itself runs on and streams
      // through notifications. No timeout: agentic turns routinely exceed five minutes, and the
      // transport already rejects pending requests when the process exits.
      const res = await this.rpc.request<{ turn: { id: string } }>('turn/start', params);
      // A late response must not resurrect turnId after turn/completed cleared it.
      if (this._busy) this.turnId = res.turn.id;
    } catch (e) {
      this._busy = false;
      if (this.fastMode) this.ctx.updateMeta({ fastModeStatus: { state: 'unavailable', detail: errorMessage(e) } });
      this.ctx.emit({ type: 'status', status: 'idle' });
      throw e;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.rpc || !this.threadId || !this.turnId) return;
    try {
      await withTimeout(this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }), 30_000, 'turn/interrupt');
    } catch (e) {
      this.ctx.log('warn', `interrupt failed: ${errorMessage(e)}`);
    }
  }

  private fastModeCapability() {
    return codexFastModeCapability({
      harness: this.id,
      hasCustomProvider: Boolean(this.resolveCodexProvider()),
      modelRef: this.fastModeModel,
      models: this.models,
      speedTiers: this.speedTiers,
      providers: this.ctx.settings().providers
    });
  }

  private fastServiceTier(): string {
    return codexFastServiceTier(this.fastModeModel?.model, this.models, this.speedTiers);
  }

  private reportFastMode(): void {
    this.ctx.updateMeta({ fastModeStatus: codexFastModeStatus(this.fastMode, this.fastMode ? this.fastModeCapability() : { supported: false }) });
  }

  async setFastMode(enabled: boolean): Promise<void> {
    if (enabled) await this.listModels();
    const support = this.fastModeCapability();
    if (enabled && !support.supported) throw new Error(support.reason);
    if (!this.rpc || !this.threadId) throw new Error('Codex thread is not ready.');
    this.fastMode = enabled;
    this.ctx.updateMeta({ fastModeStatus: { state: enabled ? 'requested' : 'off' } });
  }

  async setModel(model: ModelRef): Promise<void> {
    this.model = model.model;
    if (model.provider && model.provider !== 'openai' && model.provider !== 'codex') this.modelProvider = model.provider;
    this.fastModeModel = model;
    this.ctx.updateMeta({ activeModel: model });
    this.reportFastMode();
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.effort = effort;
    this.ctx.updateMeta({ activeEffort: effort });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // Session grants made under a looser mode must not carry into a stricter one.
    this.sessionGrants.clear();
    if (this._busy) this.info(`Permission mode "${mode}" applies to Codex from the next turn; the running turn keeps its current sandbox.`, 'warn');
  }

  async compact(): Promise<void> {
    if (!this.rpc || !this.threadId) throw new Error('Codex thread is not ready');
    if (this.compactionWaiter) return withTimeout(this.compactionWaiter.promise, 180_000, 'Codex context compaction');
    const waiter = deferred<void>();
    // Process shutdown can reject this before compact/start's request rejects; mark it observed now.
    void waiter.promise.catch(() => undefined);
    this.compactionWaiter = waiter;
    try {
      await withTimeout(this.rpc.request('thread/compact/start', { threadId: this.threadId }), 30_000, 'thread/compact/start');
      await withTimeout(waiter.promise, 180_000, 'Codex context compaction');
    } finally {
      if (this.compactionWaiter === waiter) this.compactionWaiter = null;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // The thread is pinned to its provider, so only that provider's models are switchable.
    const provider = this.resolveCodexProvider();
    if (provider) {
      this.models = codexProviderModels(this.ctx.settings(), provider.id);
      return this.models;
    }
    if (!this.rpc) return CODEX_STATIC_MODELS;
    try {
      this.models = await readCodexModelCatalog(this.rpc, (model) => {
        const tiers = codexModelSpeedTiers(model);
        if (tiers) this.speedTiers.set(model.model, tiers);
      });
      return this.models.length ? this.models : CODEX_STATIC_MODELS;
    } catch (e) {
      this.ctx.log('warn', `model/list failed: ${errorMessage(e)}`);
      return CODEX_STATIC_MODELS;
    }
  }

  async dispose(): Promise<void> {
    this.compactionWaiter?.reject(new Error('Codex stopped during context compaction.'));
    this.childThreads.clear();
    const rpc = this.rpc;
    this.rpc = null;
    if (!rpc) return;
    try {
      if (this.threadId) await withTimeout(rpc.request('thread/unsubscribe', { threadId: this.threadId }), 2000, 'unsubscribe').catch(() => undefined);
    } finally {
      await rpc.close();
    }
  }
}
