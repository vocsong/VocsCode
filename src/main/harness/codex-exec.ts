/** Codex exec SDK adapter. It cannot ask for approval, so the sandbox mode is the only boundary; prefer the app-server adapter for interactive work. */
import { Codex, type CodexOptions, type ModelReasoningEffort, type SandboxMode, type Thread, type ThreadEvent, type ThreadItem, type UserInput as CodexInput } from '@openai/codex-sdk';
import type { EffortLevel, ModelInfo, ModelRef, PermissionMode, TranscriptItem, UserInput } from '../../shared/types';
import { errorMessage, shortId, truncate } from '../util/async';
import { toCodex } from '../mcp/effective';
import { bundledCodexPath, spawnableCodex, type ResolvedBinary } from '../runtime';
import { applyCodexMcpSuppression, readCodexMcpServers } from './codex-mcp-config';
import { codexModelSpeedTiers, listCodexModels } from './codex-models';
import { CODEX_FAST_PRICING_UNAVAILABLE_MSG, codexFastModeCapability, codexFastModeStatus, codexFastServiceTier, writeCodexSessionImage } from './codex-provider';
import { normalizeCodexInputTokens } from './codex-usage';
import { TurnUsageTracker } from '../util/turn-usage';
import type { HarnessAdapter, HarnessContext } from './types';
import { reportHarnessCommands } from './commands';
import { codexSkillCommands, codexSkillInvocation, readCodexSkills, type CodexSkill } from './codex-skills';
import { fastModePricing } from './native/fast-mode-pricing';
import { CODEX_STATIC_MODELS, estimateCostUsd, findPricing, modelsForProvider } from '../models/static-models';

function sandboxFor(mode: PermissionMode): SandboxMode {
  switch (mode) {
    case 'plan':
      return 'read-only';
    case 'full-auto':
      return 'danger-full-access';
    default:
      return 'workspace-write';
  }
}

function effortFor(e: EffortLevel | undefined): ModelReasoningEffort | undefined {
  return e as ModelReasoningEffort | undefined;
}

/**
 * Codex through the official SDK (codex exec). Non-interactive: there are no approvals,
 * the sandbox mode is the safety boundary. Queue-only (one turn at a time).
 */
export class CodexExecAdapter implements HarnessAdapter {
  readonly id = 'codex-exec' as const;
  private codex: Codex | null = null;
  private codexOptions: CodexOptions | null = null;
  private fastMode = false;
  private models: ModelInfo[] = [];
  /** This cwd's enabled skills, from a one-shot `skills/list`; empty until it answers. */
  private skills: CodexSkill[] = [];
  private speedTiers = new Map<string, string[]>();
  private thread: Thread | null = null;
  private _busy = false;
  private abort: AbortController | null = null;
  private model: string | undefined;
  /** The provider the session's model ref names; Codex's own models arrive as 'openai'/'codex'. */
  private modelProvider: string | undefined;
  private effort: EffortLevel | undefined;
  private items = new Map<string, TranscriptItem>();
  private turnStartedAt = 0;
  private usage: TurnUsageTracker;

  constructor(private readonly ctx: HarnessContext) {
    this.usage = new TurnUsageTracker(ctx.session().usage);
  }

  get busy(): boolean {
    return this._busy;
  }

  async start(): Promise<void> {
    const meta = this.ctx.session();
    // The SDK spawns codexPathOverride directly, which fails with EINVAL for npm .cmd shims on
    // Windows, so a shim is replaced by the native binary behind it. Falling back to the SDK's
    // bundled binary here once ran an older Codex than the one the model picker listed.
    const bin = this.ctx.runtime.resolve('codex');
    const exe = this.executable();
    const override = exe?.path;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    const key = await this.ctx.getApiKey('openai');
    if (key && !env.CODEX_API_KEY && !env.OPENAI_API_KEY) env.OPENAI_API_KEY = key;
    // The exec SDK flattens `config` into `--config key=value` argv, which any process listing
    // can read, so resolved secrets travel in the environment instead (docs/MCP.md §8).
    const mcp = await this.ctx.mcpServers().catch((e) => {
      this.ctx.log('warn', `mcp: ${errorMessage(e)}`);
      return [];
    });
    const { config: mcpServers, env: mcpEnv } = toCodex(mcp, 'env-ref');
    await applyCodexMcpSuppression(mcpServers, this.ctx.ownedMcpIds(), () => {
      const executable = override ?? bundledCodexPath(this.ctx.runtime.runtimePaths.appRoot);
      if (!executable) throw new Error('Codex SDK runtime not found. Select a native Codex executable in Settings.');
      return readCodexMcpServers(executable, meta.cwd, env);
    });
    Object.assign(env, mcpEnv);
    this.model = (meta.config.model ?? meta.activeModel)?.model;
    this.modelProvider = (meta.config.model ?? meta.activeModel)?.provider;
    this.fastMode = meta.config.fastMode === true;
    if (this.fastMode) {
      await this.listModels();
      if (!this.model) {
        this.model = this.models.find((entry) => entry.isDefault)?.id;
        if (this.model) this.modelProvider = 'openai';
      }
    }
    const config = Object.keys(mcpServers).length ? { mcp_servers: mcpServers } : undefined;
    this.ctx.log('info', `codex exec SDK: ${exe ? `${exe.path} (${exe.source} runtime${bin && bin.path !== exe.path ? `, in place of the shim ${bin.path}` : ''})` : 'SDK-bundled binary'}${config ? `, ${mcp.length} MCP server(s)` : ''}`);
    this.codexOptions = { codexPathOverride: override, env, config };
    this.configureFastMode(this.fastMode);
    this.effort = this.ctx.effort();
    this.usage = new TurnUsageTracker(meta.usage);
    this.ensureThread();
    this.ctx.emit({ type: 'status', status: 'idle' });
    const appRoot = this.ctx.runtime.runtimePaths?.appRoot;
    const skillsBin = override ?? (appRoot ? bundledCodexPath(appRoot) : undefined);
    if (skillsBin) this.refreshSkills(skillsBin, meta.cwd, env);
  }

  /**
   * Exec has no listing of its own, so one short-lived app-server answers `skills/list` in the
   * background; the session is usable before it does. A failure only costs the composer its
   * suggestions — a typed `$skill` still works.
   */
  private refreshSkills(bin: string, cwd: string, env: NodeJS.ProcessEnv): void {
    const codex = this.codex;
    void readCodexSkills(bin, cwd, env)
      .then((skills) => {
        if (this.codex !== codex) return;
        this.skills = skills;
        reportHarnessCommands(this.ctx, codexSkillCommands(skills));
      })
      .catch((e) => this.ctx.log('debug', `codex skills/list failed: ${errorMessage(e)}`));
  }

  private ensureThread(): Thread {
    if (this.thread) return this.thread;
    const meta = this.ctx.session();
    const opts = {
      model: this.model,
      workingDirectory: meta.cwd,
      skipGitRepoCheck: true,
      sandboxMode: sandboxFor(this.ctx.permissionMode()),
      approvalPolicy: 'never' as const,
      modelReasoningEffort: effortFor(this.effort)
    };
    this.thread = meta.harnessRef.codexThreadId ? this.codex!.resumeThread(meta.harnessRef.codexThreadId, opts) : this.codex!.startThread(opts);
    return this.thread;
  }
  async send(input: UserInput): Promise<void> {
    if (!this.codex) await this.start();
    if (this._busy) throw new Error('Codex exec runs one turn at a time; wait for the current turn to finish.');
    let thread = this.ensureThread();
    const parts: CodexInput[] = [];
    // `codex exec` takes text only; Codex resolves the `$skill` it names (./codex-skills.ts).
    if (input.text) parts.push({ type: 'text', text: codexSkillInvocation(input.text, this.skills.length ? this.skills : this.ctx.session().harnessCommandList ?? []).text });
    for (const img of input.images ?? []) {
      const file = await writeCodexSessionImage(this.ctx.sessionDir, img);
      parts.push({ type: 'local_image', path: file });
    }
    this._busy = true;
    this.abort = new AbortController();
    const startedAt = Date.now();
    this.turnStartedAt = startedAt;
    this.usage.beginTurn();
    if (this.fastMode) {
      const support = this.fastModeCapability();
      this.ctx.updateMeta({ fastModeStatus: support.supported ? { state: 'requested' } : { state: 'unavailable', detail: support.reason } });
    }
    this.ctx.emit({ type: 'status', status: 'running' });
    void (async () => {
      try {
        try {
          await this.streamTurn(thread, parts, startedAt);
        } catch (e) {
          if (this.abort?.signal.aborted || thread !== this.thread || !this.ctx.session().harnessRef.codexThreadId) throw e;
          // A refused/stale resume must not leave the broken thread cached: drop it (and the
          // stored thread id) and retry once with a fresh thread.
          this.thread = null;
          this.ctx.updateRef({ codexThreadId: undefined });
          this.ctx.log('warn', `codex resume failed (${errorMessage(e)}); retrying with a new thread.`);
          thread = this.ensureThread();
          await this.streamTurn(thread, parts, startedAt);
        }
      } catch (e) {
        const aborted = this.abort?.signal.aborted;
        if (this.fastMode && !aborted) this.ctx.updateMeta({ fastModeStatus: { state: 'unavailable', detail: errorMessage(e) } });
        const completed = this.usage.finishTurn();
        this.ctx.emit({ type: 'usage', totals: completed.totals });
        this.ctx.emit({ type: 'item.upsert', item: { id: shortId('turn_'), kind: 'turn', ts: Date.now(), status: aborted ? 'interrupted' : 'failed', durationMs: Date.now() - startedAt, usage: completed.usage, error: aborted ? undefined : errorMessage(e) } });
      } finally {
        this._busy = false;
        this.abort = null;
        this.ctx.emit({ type: 'status', status: 'idle' });
      }
    })();
  }

  /**
   * Rates for the model this session is pinned to. Codex reports tokens but never a price, so a turn
   * with no lookup here reads as $0.00 however much it used. The SDK thread is created without a
   * `model_providers` entry, so only Codex's own models can run: they arrive as 'openai'/'codex'
   * and resolve from the bundled catalogs.
   */
  private pricing(): ModelInfo['pricing'] | undefined {
    const models = modelsForProvider(this.ctx.settings().providers, this.modelProvider);
    return findPricing(this.modelProvider ?? 'openai', this.model ?? '', models);
  }

  private async streamTurn(thread: Thread, parts: CodexInput[], startedAt: number): Promise<void> {
    const { events } = await thread.runStreamed(parts, { signal: this.abort!.signal });
    for await (const ev of events) this.handle(ev);
    if (thread.id) this.ctx.updateRef({ codexThreadId: thread.id });
  }

  private handle(ev: ThreadEvent): void {
    switch (ev.type) {
      case 'thread.started':
        this.ctx.updateRef({ codexThreadId: ev.thread_id });
        return;
      case 'turn.started':
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.upsertItem(ev.item, ev.type === 'item.completed');
        return;
      case 'turn.completed': {
        const u = ev.usage;
        // input_tokens includes cached_input_tokens (OpenAI convention); count the uncached
        // remainder as input so cache reads are not counted twice in rates and cost estimates.
        const delta = { inputTokens: normalizeCodexInputTokens(u.input_tokens, u.cached_input_tokens), outputTokens: u.output_tokens, cacheReadTokens: u.cached_input_tokens, cacheWriteTokens: u.cache_write_input_tokens, reasoningTokens: u.reasoning_output_tokens };
        // Codex reports tokens but no price, so the turn's spend is priced here from the same
        // catalog the rest of the app bills through; without it the session reads $0.00 however
        // much it used. The delta is per-turn usage, so the rates apply to this turn alone.
        const fast = this.fastMode && this.fastModeCapability().supported;
        const pricing = fast ? fastModePricing(this.model ?? '', u.input_tokens) : this.pricing();
        if (fast && !pricing) this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'warn', text: CODEX_FAST_PRICING_UNAVAILABLE_MSG } });
        const turnCost = estimateCostUsd(pricing, delta);
        this.usage.addUsage({ ...delta, costUsd: turnCost });
        const completed = this.usage.finishTurn();
        this.ctx.emit({ type: 'usage', totals: completed.totals });
        this.ctx.emit({
          type: 'item.upsert',
          item: {
            id: shortId('turn_'),
            kind: 'turn',
            ts: Date.now(),
            status: 'completed',
            durationMs: Date.now() - this.turnStartedAt,
            usage: completed.usage,
            costUsd: turnCost
          }
        });
        return;
      }
      case 'turn.failed': {
        if (this.fastMode && !this.abort?.signal.aborted) this.ctx.updateMeta({ fastModeStatus: { state: 'unavailable', detail: ev.error.message } });
        const completed = this.usage.finishTurn();
        this.ctx.emit({ type: 'usage', totals: completed.totals });
        this.ctx.emit({ type: 'item.upsert', item: { id: shortId('turn_'), kind: 'turn', ts: Date.now(), status: 'failed', durationMs: Date.now() - this.turnStartedAt, usage: completed.usage, error: ev.error.message } });
        return;
      }
      case 'error':
        if (this.fastMode && !this.abort?.signal.aborted) this.ctx.updateMeta({ fastModeStatus: { state: 'unavailable', detail: ev.message } });
        this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'error', text: ev.message } });
        return;
    }
  }

  private upsertItem(item: ThreadItem, completed: boolean): void {
    const existing = this.items.get(item.id);
    const ts = existing?.ts ?? Date.now();
    let out: TranscriptItem | null = null;
    switch (item.type) {
      case 'agent_message':
        out = { id: item.id, kind: 'assistant', ts, text: item.text, streaming: !completed, model: this.model, phase: 'final' };
        break;
      case 'reasoning':
        out = { id: item.id, kind: 'assistant', ts, text: '', thinking: item.text, streaming: !completed, phase: 'commentary' };
        break;
      case 'command_execution':
        out = { id: item.id, kind: 'tool', ts, name: 'bash', hint: 'execute', summary: item.command, input: { command: item.command }, output: truncate(item.aggregated_output ?? '', 40_000), status: item.status === 'in_progress' ? 'running' : item.status === 'failed' ? 'error' : 'done', exitCode: item.exit_code ?? null };
        break;
      case 'file_change':
        out = { id: item.id, kind: 'tool', ts, name: 'apply_patch', hint: 'edit', summary: item.changes.map((c) => c.path).join(', '), status: item.status === 'failed' ? 'error' : 'done', changes: item.changes.map((c) => ({ path: c.path, kind: c.kind })) };
        break;
      case 'mcp_tool_call':
        out = { id: item.id, kind: 'tool', ts, name: `${item.server}.${item.tool}`, hint: 'mcp', input: item.arguments, summary: JSON.stringify(item.arguments).slice(0, 200), output: item.error ? item.error.message : item.result ? truncate(JSON.stringify(item.result.content ?? item.result.structured_content ?? '', null, 2), 40_000) : undefined, status: item.status === 'in_progress' ? 'running' : item.status === 'failed' ? 'error' : 'done' };
        break;
      case 'web_search':
        out = { id: item.id, kind: 'tool', ts, name: 'web_search', hint: 'fetch', summary: item.query, status: completed ? 'done' : 'running' };
        break;
      case 'todo_list':
        out = { id: item.id, kind: 'plan', ts, entries: item.items.map((t) => ({ content: t.text, status: t.completed ? 'completed' : 'pending' })) };
        break;
      case 'error':
        out = { id: item.id, kind: 'info', ts, level: 'error', text: item.message };
        break;
    }
    if (out) {
      this.items.set(item.id, out);
      this.ctx.emit({ type: 'item.upsert', item: out });
    }
  }

  async interrupt(): Promise<void> {
    this.abort?.abort();
  }

  private fastModeCapability() {
    return codexFastModeCapability({
      harness: this.id,
      hasCustomProvider: Boolean(this.ctx.session().config.codexModelProvider),
      modelRef: this.model ? { provider: this.modelProvider ?? 'openai', model: this.model } : undefined,
      models: this.models,
      speedTiers: this.speedTiers,
      providers: this.ctx.settings().providers
    });
  }

  private configureFastMode(enabled: boolean): void {
    if (!this.codexOptions) throw new Error('Codex exec is not ready.');
    const support = this.fastModeCapability();
    const fast = enabled && support.supported;
    const tier = codexFastServiceTier(this.model, this.models, this.speedTiers);
    const options = { ...this.codexOptions, config: { ...this.codexOptions.config, features: { fast_mode: fast }, service_tier: fast ? tier : 'default' } };
    const codex = new Codex(options);
    this.codexOptions = options;
    this.codex = codex;
    this.thread = null; // The next turn resumes the existing id with the new CLI config.
    this.fastMode = enabled;
    this.ctx.updateMeta({ fastModeStatus: codexFastModeStatus(enabled, support) });
  }

  async setFastMode(enabled: boolean): Promise<void> {
    if (enabled) await this.listModels();
    const support = this.fastModeCapability();
    if (enabled && !support.supported) throw new Error(support.reason);
    this.configureFastMode(enabled);
  }

  async setModel(model: ModelRef): Promise<void> {
    this.model = model.model;
    this.modelProvider = model.provider;
    this.thread = null; // rebuilt with the new model on the next turn (resumes the same thread id)
    if (this.codexOptions) this.configureFastMode(this.fastMode);
    this.ctx.updateMeta({ activeModel: model });
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.effort = effort;
    this.thread = null;
    this.ctx.updateMeta({ activeEffort: effort });
  }

  async setPermissionMode(): Promise<void> {
    this.thread = null;
  }

  /** The binary this adapter runs; its model catalog is the one turns are sent to. */
  private executable(): ResolvedBinary | null {
    return spawnableCodex(this.ctx.runtime.resolve('codex'), this.ctx.runtime.runtimePaths?.appRoot);
  }

  async listModels(): Promise<ModelInfo[]> {
    const bin = this.executable();
    if (!bin) return CODEX_STATIC_MODELS;
    try {
      const models = await listCodexModels(bin.path, (model) => {
        const tiers = codexModelSpeedTiers(model);
        if (tiers) this.speedTiers.set(model.model, tiers);
      });
      this.models = models;
      return models.length ? models : CODEX_STATIC_MODELS;
    } catch (e) {
      this.ctx.log('warn', `model/list failed: ${errorMessage(e)}`);
      return CODEX_STATIC_MODELS;
    }
  }

  async dispose(): Promise<void> {
    this.abort?.abort();
    this.thread = null;
    this.codex = null;
  }
}
