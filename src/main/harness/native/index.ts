/** Built-in agent loop adapter: drives a provider directly and runs the local tool set, with approvals gated in-process. */
import path from 'node:path';
import type { EffortLevel, ModelInfo, ModelRef, PermissionMode, ProviderConfig, TranscriptItem, UserInput } from '../../../shared/types';
import { errorMessage, shortId, truncate } from '../../util/async';
import { TurnUsageTracker } from '../../util/turn-usage';
import { estimateCostUsd, findContextWindow, findPricing, STATIC_MODELS_BY_PROVIDER } from '../../models/static-models';
import { resolveProviderApiKey } from '../../models/providers';
import { gateAction, isOutsideWorkspace, OPTIONS_ALLOW_DENY, PLAN_MODE_DENIAL } from '../permissions';
import type { HarnessAdapter, HarnessContext } from '../types';
import { anthropicStep, isAnthropicProvider, openaiStep, type NativeMessage, type StepResult } from './drivers';
import { buildSystemPrompt } from './prompt';
import {
  NATIVE_TOOLS,
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  previewEdit,
  previewWrite,
  readFileTool,
  runBash,
  writeFileTool,
  MAX_OUTPUT,
  type ToolExecResult
} from './tools';

const HISTORY_FILE = 'native-history.json';
const MAX_STEPS = 120;

interface PersistedHistory {
  version: 1 | 2;
  messages: NativeMessage[];
  /** A history snapshot immediately before each app user message, keyed by transcript item id. */
  boundaries?: Record<string, NativeMessage[]>;
}

export class NativeAdapter implements HarnessAdapter {
  readonly id = 'native' as const;
  private history: NativeMessage[] = [];
  private boundaries: Record<string, NativeMessage[]> = {};
  private _busy = false;
  private abort: AbortController | null = null;
  private queue: UserInput[] = [];
  private steer: UserInput[] = [];
  private model: ModelRef | null = null;
  private effort: EffortLevel | undefined;
  private sessionAllowed = new Set<string>();
  private readonly usage: TurnUsageTracker;
  private started = false;

  constructor(private readonly ctx: HarnessContext) {
    this.usage = new TurnUsageTracker(ctx.session().usage);
  }

  get busy(): boolean {
    return this._busy;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const meta = this.ctx.session();
    const saved = await this.ctx.readJson<PersistedHistory>(HISTORY_FILE);
    if (saved?.messages) {
      this.history = saved.messages;
      this.boundaries = saved.boundaries ?? {};
      // A crash or kill mid-tool-run can leave tool calls without results, which every provider rejects.
      if (this.repairDanglingToolCalls('The app was closed before this tool finished.')) await this.persist();
    }
    this.model = meta.activeModel ?? meta.config.model ?? this.defaultModel();
    this.effort = this.ctx.effort();
    if (this.model) this.ctx.updateMeta({ activeModel: this.model });
    this.ctx.updateRef({ nativeHistory: true });
    this.ctx.emit({ type: 'status', status: 'idle' });
    this.ctx.emit({ type: 'models', models: await this.listModels() });
  }

  private defaultModel(): ModelRef | null {
    const s = this.ctx.settings();
    for (const p of s.providers.filter((p) => p.enabled)) {
      const models = p.models.length ? p.models : STATIC_MODELS_BY_PROVIDER[p.id] ?? [];
      const def = models.find((m) => m.isDefault) ?? models[0];
      if (def && (p.hasApiKey || (p.envKey && process.env[p.envKey]) || p.kind === 'ollama' || p.kind === 'lmstudio')) return { provider: p.id, model: def.id };
    }
    return null;
  }

  private provider(): ProviderConfig {
    const s = this.ctx.settings();
    const id = this.model?.provider;
    const p = s.providers.find((x) => x.id === id);
    if (!p) throw new Error(`Unknown provider "${id}". Configure it under Settings → Providers.`);
    return p;
  }

  async listModels(): Promise<ModelInfo[]> {
    const s = this.ctx.settings();
    const out: ModelInfo[] = [];
    for (const p of s.providers.filter((p) => p.enabled)) {
      const models = p.models.length ? p.models : STATIC_MODELS_BY_PROVIDER[p.id] ?? [];
      out.push(...models.map((m) => ({ ...m, provider: p.id })));
    }
    return out;
  }

  async send(input: UserInput): Promise<void> {
    if (!this.started) await this.start();
    if (this._busy) {
      if (input.mode === 'steer') this.steer.push(input);
      else this.queue.push(input);
      this.ctx.updateMeta({ queued: this.queue.length + this.steer.length });
      return;
    }
    if (!this.model) throw new Error('No model selected. Add a provider API key in Settings and pick a model.');
    if (input.transcriptItemId) this.boundaries[input.transcriptItemId] = structuredClone(this.history);
    this.history.push({ role: 'user', text: input.text, images: input.images });
    void this.runTurn();
  }

  async rewindToUserMessage(itemId: string): Promise<boolean> {
    if (this._busy) return false;
    const boundary = this.boundaries[itemId];
    if (!boundary) return false;
    this.history = structuredClone(boundary);
    // Boundaries from the discarded branch might otherwise restore context that no longer exists.
    this.boundaries = {};
    this.queue = [];
    this.steer = [];
    this.ctx.updateMeta({ queued: 0 });
    await this.persist();
    return true;
  }

  private async runTurn(): Promise<void> {
    this._busy = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const startedAt = Date.now();
    this.usage.beginTurn();
    const turnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    let turnCost = 0;
    let status: 'completed' | 'interrupted' | 'failed' = 'completed';
    let error: string | undefined;
    this.ctx.emit({ type: 'status', status: 'running' });
    try {
      const provider = this.provider();
      const apiKey = await resolveProviderApiKey(provider, (id) => this.ctx.getApiKey(id));
      if (!apiKey && !['ollama', 'lmstudio'].includes(provider.kind)) throw new Error(`No API key for ${provider.name}. Add one under Settings → Providers or set ${provider.envKey ?? 'the API key env var'}.`);
      const model = this.model!;
      const pricing = findPricing(provider.id, model.model, provider.models);

      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) break;
        // Steering messages are injected between steps.
        while (this.steer.length) {
          const s = this.steer.shift()!;
          if (s.transcriptItemId) this.boundaries[s.transcriptItemId] = structuredClone(this.history);
          this.history.push({ role: 'user', text: `[steer] ${s.text}`, images: s.images });
          this.ctx.updateMeta({ queued: this.queue.length + this.steer.length });
        }
        const system = await buildSystemPrompt(this.ctx.session().cwd, { planMode: this.ctx.permissionMode() === 'plan', append: this.ctx.session().config.appendSystemPrompt, model: model.model });
        const assistant: Extract<TranscriptItem, { kind: 'assistant' }> = { id: shortId('a_'), kind: 'assistant', ts: Date.now(), text: '', thinking: '', streaming: true, model: model.model };
        let emitted = false;
        const ensure = () => {
          if (!emitted) {
            emitted = true;
            this.ctx.emit({ type: 'item.upsert', item: { ...assistant } });
          }
        };
        const params = {
          provider,
          apiKey,
          model: model.model,
          system,
          history: this.history,
          tools: this.ctx.permissionMode() === 'plan' ? NATIVE_TOOLS.filter((t) => !t.mutating) : NATIVE_TOOLS,
          effort: this.effort,
          signal,
          onText: (d: string) => {
            ensure();
            assistant.text += d;
            this.ctx.emit({ type: 'item.delta', id: assistant.id, textDelta: d });
          },
          onReasoning: (d: string) => {
            ensure();
            assistant.thinking = (assistant.thinking ?? '') + d;
            this.ctx.emit({ type: 'item.delta', id: assistant.id, thinkingDelta: d });
          }
        };
        const result: StepResult = isAnthropicProvider(provider) ? await anthropicStep(params) : await openaiStep(params);
        assistant.text = result.text || assistant.text;
        assistant.thinking = result.reasoning || assistant.thinking;
        assistant.streaming = false;
        if (assistant.text || assistant.thinking) {
          ensure();
          this.ctx.emit({ type: 'item.upsert', item: { ...assistant } });
        }
        turnUsage.inputTokens += result.usage.inputTokens;
        turnUsage.outputTokens += result.usage.outputTokens;
        turnUsage.cacheReadTokens += result.usage.cacheReadTokens;
        turnUsage.cacheWriteTokens += result.usage.cacheWriteTokens;
        turnUsage.reasoningTokens += result.usage.reasoningTokens;
        const stepCost = estimateCostUsd(pricing, { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, cacheWriteTokens: result.usage.cacheWriteTokens });
        turnCost += stepCost;
        this.usage.addUsage({ ...result.usage, costUsd: stepCost });
        this.usage.setCumulative({ contextTokens: result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens + result.usage.outputTokens });
        const info = provider.models.find((m) => m.id === model.model) ?? (STATIC_MODELS_BY_PROVIDER[provider.id] ?? []).find((m) => m.id === model.model);
        const contextWindow = info?.contextWindow ?? findContextWindow(provider.id, model.model, provider.models);
        if (contextWindow) this.usage.setCumulative({ contextWindow });
        this.ctx.emit({ type: 'usage', totals: this.usage.snapshot() });

        this.history.push({
          role: 'assistant',
          text: result.text,
          reasoning: result.reasoning || undefined,
          toolCalls: result.toolCalls,
          anthropicContent: isAnthropicProvider(provider) ? result.rawContent : undefined,
          anthropicModel: isAnthropicProvider(provider) ? model.model : undefined
        });
        await this.persist();
        if (!result.toolCalls.length) break;

        for (const call of result.toolCalls) {
          if (signal.aborted) break;
          const res = await this.executeTool(call, signal);
          this.history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: res.output, isError: res.isError });
        }
        await this.persist();
      }
      if (signal.aborted) status = 'interrupted';
    } catch (e) {
      if (signal.aborted) status = 'interrupted';
      else {
        status = 'failed';
        error = errorMessage(e);
        this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'error', text: error } });
      }
    } finally {
      // Every tool_use must be answered before the next request, even after an interrupt or error.
      this.repairDanglingToolCalls(status === 'interrupted' ? 'Interrupted by the user before this tool ran.' : 'The tool did not run because the turn failed.');
      const completed = this.usage.finishTurn();
      const completedUsage = completed.usage;
      this.ctx.emit({ type: 'usage', totals: completed.totals });
      this.ctx.emit({ type: 'item.upsert', item: { id: shortId('turn_'), kind: 'turn', ts: Date.now(), status, durationMs: Date.now() - startedAt, costUsd: completedUsage?.costUsd ?? turnCost, usage: completedUsage ? { inputTokens: completedUsage.inputTokens, outputTokens: completedUsage.outputTokens, cacheReadTokens: completedUsage.cacheReadTokens, cacheWriteTokens: completedUsage.cacheWriteTokens, reasoningTokens: completedUsage.reasoningTokens } : turnUsage, error } });
      this._busy = false;
      this.abort = null;
      try {
        await this.persist();
      } catch (e) {
        this.ctx.log('warn', `native: persist failed: ${errorMessage(e)}`);
      }
      this.ctx.emit({ type: 'status', status: 'idle' });
      const next = this.queue.shift();
      this.ctx.updateMeta({ queued: this.queue.length + this.steer.length });
      if (next) void this.send({ ...next, mode: 'now' });
    }
  }

  private async executeTool(call: { id: string; name: string; args: Record<string, unknown> }, signal: AbortSignal): Promise<ToolExecResult> {
    const def = NATIVE_TOOLS.find((t) => t.name === call.name);
    const cwd = this.ctx.session().cwd;
    const args = call.args ?? {};
    const summary =
      typeof args.command === 'string' ? (args.command as string) : typeof args.path === 'string' ? (args.path as string) : typeof args.pattern === 'string' ? (args.pattern as string) : truncate(JSON.stringify(args), 200, '…');
    const item: Extract<TranscriptItem, { kind: 'tool' }> = {
      id: call.id || shortId('t_'),
      kind: 'tool',
      ts: Date.now(),
      name: call.name,
      hint: call.name === 'bash' ? 'execute' : def?.isEdit ? 'edit' : call.name === 'read_file' ? 'read' : call.name === 'glob' || call.name === 'grep' || call.name === 'list_dir' ? 'search' : 'other',
      input: args,
      summary,
      status: 'running'
    };
    this.ctx.emit({ type: 'item.upsert', item: { ...item } });
    const finish = (res: ToolExecResult): ToolExecResult => {
      item.output = res.output;
      item.status = res.isError ? 'error' : 'done';
      item.exitCode = res.exitCode;
      item.changes = res.changes;
      this.ctx.emit({ type: 'item.upsert', item: { ...item } });
      return res;
    };
    const parseError = (args as { __parseError?: unknown }).__parseError;
    if (typeof parseError === 'string') {
      return finish({ output: `Tool-call arguments failed to parse; the tool did not run. Raw arguments: ${truncate(parseError, 500, '…')}`, isError: true });
    }
    if (!def) return finish({ output: `Unknown tool: ${call.name}`, isError: true });

    // Permission gate
    if (def.mutating) {
      const mode: PermissionMode = this.ctx.permissionMode();
      const command = typeof args.command === 'string' ? (args.command as string) : undefined;
      const outsideCwd = def.isEdit && typeof args.path === 'string' && isOutsideWorkspace(cwd, args.path as string, path);
      let verdict = gateAction(mode, { mutating: true, isEdit: def.isEdit, command, sessionAllowed: this.sessionAllowed.has(call.name) });
      if (outsideCwd && mode !== 'full-auto' && verdict === 'allow') verdict = 'ask';
      if (verdict === 'deny') {
        item.status = 'declined';
        item.output = PLAN_MODE_DENIAL;
        this.ctx.emit({ type: 'item.upsert', item: { ...item } });
        return { output: PLAN_MODE_DENIAL, isError: true };
      }
      if (verdict === 'ask') {
        let changes;
        try {
          if (call.name === 'write_file') changes = await previewWrite(cwd, args as { path: string; content: string });
          else if (call.name === 'edit_file') changes = (await previewEdit(cwd, args as { path: string; old_string: string; new_string: string; replace_all?: boolean })).changes;
        } catch {
          /* ignore preview failures */
        }
        const decision = await this.ctx.requestApproval({
          kind: command ? 'command' : def.isEdit ? 'file_change' : 'tool',
          title: command ? 'Run command?' : `Allow ${call.name}?`,
          toolName: call.name,
          command,
          cwd,
          input: args,
          changes,
          description: outsideCwd ? 'This path is outside the project directory.' : undefined,
          toolItemId: item.id,
          options: OPTIONS_ALLOW_DENY
        });
        if (decision.optionId === 'allow_session') this.sessionAllowed.add(call.name);
        else if (decision.optionId !== 'allow') {
          item.status = 'declined';
          item.output = `Declined by user${decision.note ? `: ${decision.note}` : ''}.`;
          this.ctx.emit({ type: 'item.upsert', item: { ...item } });
          return { output: item.output, isError: true };
        }
        if (decision.updatedInput && typeof decision.updatedInput === 'object') Object.assign(args, decision.updatedInput as Record<string, unknown>);
      }
    }

    try {
      switch (call.name) {
        case 'bash':
          return finish(
            await runBash(cwd, String(args.command ?? ''), Number(args.timeout_ms ?? 120_000), signal, (chunk) => {
              const streamed = item.output ?? '';
              if (streamed.length >= MAX_OUTPUT) return;
              const capped = chunk.slice(0, MAX_OUTPUT - streamed.length);
              item.output = streamed + capped;
              this.ctx.emit({ type: 'item.delta', id: item.id, outputDelta: capped });
              if (capped.length < chunk.length) {
                item.output += '\n[output truncated]';
                this.ctx.emit({ type: 'item.delta', id: item.id, outputDelta: '\n[output truncated]' });
              }
            })
          );
        case 'read_file':
          return finish(await readFileTool(cwd, args as { path: string; offset?: number; limit?: number }));
        case 'write_file':
          return finish(await writeFileTool(cwd, args as { path: string; content: string }));
        case 'edit_file':
          return finish(await editFileTool(cwd, args as { path: string; old_string: string; new_string: string; replace_all?: boolean }));
        case 'list_dir':
          return finish(await listDirTool(cwd, args as { path?: string }));
        case 'glob':
          return finish(await globTool(cwd, args as { pattern: string; path?: string }));
        case 'grep':
          return finish(await grepTool(cwd, args as { pattern: string; path?: string; glob?: string; max_results?: number }, signal));
        default:
          return finish({ output: `Unknown tool: ${call.name}`, isError: true });
      }
    } catch (e) {
      return finish({ output: `Tool error: ${errorMessage(e)}`, isError: true });
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.writeJson(HISTORY_FILE, { version: 2, messages: this.history, boundaries: this.boundaries } satisfies PersistedHistory);
  }

  /** Appends synthetic error results for tool calls that never received one. Returns true if anything changed. */
  private repairDanglingToolCalls(reason: string): boolean {
    let changed = false;
    for (let i = 0; i < this.history.length; i++) {
      const m = this.history[i];
      if (m.role !== 'assistant' || !m.toolCalls.length) continue;
      const answered = new Set<string>();
      let j = i + 1;
      for (; j < this.history.length && this.history[j].role === 'tool'; j++) answered.add((this.history[j] as { toolCallId: string }).toolCallId);
      const missing = m.toolCalls.filter((tc) => !answered.has(tc.id));
      if (!missing.length) continue;
      this.history.splice(j, 0, ...missing.map((tc) => ({ role: 'tool' as const, toolCallId: tc.id, name: tc.name, content: reason, isError: true })));
      changed = true;
    }
    return changed;
  }

  async interrupt(): Promise<void> {
    this.abort?.abort();
  }

  async setModel(model: ModelRef): Promise<void> {
    this.model = model;
    this.ctx.updateMeta({ activeModel: model });
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.effort = effort;
    this.ctx.updateMeta({ activeEffort: effort });
  }

  async setPermissionMode(): Promise<void> {
    /* read live from ctx */
    // Tightening the mode must not keep earlier session-wide grants alive.
    this.sessionAllowed.clear();
  }

  async compact(): Promise<boolean> {
    // Keep the last ~12 messages verbatim (cut only at a user message so tool_use/tool_result pairs stay
    // together) and summarize the rest into a single note.
    if (this.history.length <= 14) return false;
    let cut = this.history.length - 12;
    while (cut > 0 && this.history[cut].role !== 'user') cut--;
    if (cut <= 1) return false;
    const keep = this.history.slice(cut);
    const dropped = this.history.slice(0, cut);
    const summary = dropped
      .map((m) => (m.role === 'user' ? `User: ${truncate(m.text, 300, '…')}` : m.role === 'assistant' ? `Assistant: ${truncate(m.text, 300, '…')}${m.toolCalls.length ? ` [${m.toolCalls.map((t) => t.name).join(', ')}]` : ''}` : `Tool ${m.name}: ${truncate(m.content, 120, '…')}`))
      .join('\n');
    this.history = [{ role: 'user', text: `Context summary of earlier conversation (compacted):\n${summary}` }, { role: 'assistant', text: 'Understood, continuing from the compacted context.', toolCalls: [] }, ...keep];
    await this.persist();
    this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level: 'info', text: `Compacted ${dropped.length} earlier messages.` } });
    return true;
  }

  async dispose(): Promise<void> {
    this.abort?.abort();
  }
}
