/**
 * Vocs Code subagents extension for pi (loaded with `pi -e <this file>`).
 *
 * Registers three tools — `subagent`, `subagent_result`, `subagent_steer` — and runs each request
 * as a real child agent session in this same pi process. Children inherit the session model, the
 * workspace, and the parent's permission mode: every child tool call is decided by
 * `subagent-gate.ts` and, when it needs approval, asks through the parent's RPC UI so the desktop
 * app renders its normal approval card.
 *
 * The app observes runs two ways: live `VCODE_SUBAGENT::` notifications (activity, per-call usage,
 * terminal status) and the run files under `VOCS_CODE_SUBAGENT_DIR`, which survive a restart.
 * A finished background run wakes the parent with one debounced follow-up message.
 *
 * Names deliberately avoid the third-party `@tintinweb/pi-subagents` tools: both extensions can be
 * installed at once, and this one is the one the Vocs Code prompt tells the model to prefer.
 * No pi SDK imports at module scope: the running Pi supplies execution code and this file stays
 * loadable by jiti.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_MARKER,
  APPROVAL_OPTIONS,
  BLOCK_MARKER,
  DECLINED_REASON,
  GRANT_EVENT,
  decideToolCall,
  readModeFile,
  trimInput,
  type ApprovalChoice,
  type GateDecision,
  type Mode
} from './subagent-gate';
import {
  BUILTIN_AGENTS,
  buildSystemPrompt,
  discoverAgents,
  findAgent,
  resolveAgentDir,
  toolNamesFor,
  type AgentType
} from './subagent-agents';
import { RunStore, addUsage, emptyCall, emptyTotals, type RunItem, type RunStatus, type RunCall, type RunTotals, type UsageLike } from './subagent-runs';
import { mcpReadOnlyToolNames, mcpToolNames, registerMcpTools } from './vocs-code-mcp';

/** Tools that must never exist inside a child, whether ours or the third-party extension's. */
const EXCLUDED_CHILD_TOOLS = ['subagent', 'subagent_result', 'subagent_steer', 'Agent', 'SubagentWorkflow', 'get_subagent_result', 'steer_subagent'];
export const SUBAGENT_TOOL_NAMES = ['subagent', 'subagent_result', 'subagent_steer'] as const;

/** Live event prefix the desktop app parses out of a `notify` request. */
const NOTIFY_MARKER = 'VCODE_SUBAGENT::';
/** Custom message that carries a finished background run back into the parent's context. */
const COMPLETION_TYPE = 'vocs-code-subagent-done';
const COMPLETION_DEBOUNCE_MS = 2_000;
const BACKGROUND_LIMIT = 4;
const SESSION_LIMIT = 8;
const RESULT_CHARS = 200_000;

/** What the extension needs from the running Pi runtime. Injectable so the gate and run manager
 * can be exercised offline against a scripted child session instead of a live model. */
export interface SubagentDeps {
  Type: {
    Object(fields: Record<string, unknown>): unknown;
    String(options?: unknown): unknown;
    Optional(value: unknown): unknown;
    Boolean(options?: unknown): unknown;
  };
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> };
  SessionManager: { inMemory(cwd?: string): unknown };
  createAgentSession: (options: Record<string, unknown>) => Promise<{ session: ChildSession }>;
}

interface UiLike {
  select(title: string, options: readonly string[], opts?: Record<string, unknown>): Promise<string | undefined>;
  notify(message: string, type?: string): void;
}

interface EventsLike {
  on(channel: string, handler: (payload: unknown) => void): void;
  emit(channel: string, payload: unknown): void;
}

interface ModelLike {
  provider?: string;
  id?: string;
}

interface CtxLike {
  ui?: UiLike;
  hasUI?: boolean;
  cwd: string;
  model?: ModelLike;
  thinkingLevel?: string;
  modelRegistry?: ModelRegistryLike;
  getSystemPrompt?(): string;
  isIdle?(): boolean;
}

interface ModelRegistryLike {
  find?(provider: string, modelId: string): unknown;
  getRegisteredProviderIds?(): readonly string[];
  getRegisteredProviderConfig?(providerId: string): unknown;
}

interface ToolCallEventLike {
  type: 'tool_call';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

interface PiLike {
  registerTool(definition: object): void;
  registerCommand?(name: string, options: { description?: string; handler: (args: string, ctx: CtxLike) => Promise<void> | void }): void;
  on(event: string, handler: (event: Record<string, unknown>, ctx: CtxLike) => Promise<unknown> | unknown): void;
  sendMessage?(message: Record<string, unknown>, options?: Record<string, unknown>): void;
  events?: EventsLike;
}

/** The slice of `AgentSession` this extension drives. */
interface ChildSession {
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  readonly messages: Array<Record<string, unknown>>;
  readonly model?: ModelLike;
  readonly modelRuntime?: { registerProvider(id: string, config: unknown): void };
}

interface ActiveRun {
  id: string;
  agent: AgentType;
  description: string;
  prompt: string;
  mode: 'foreground' | 'background';
  status: RunStatus;
  startedAt: number;
  session: ChildSession | null;
  output: string;
  error?: string;
  totals: RunTotals;
  callIndex: number;
  calls: RunCall[];
  pendingCall: { call: RunCall; startedAt: number } | null;
  assistantStartedAt: number;
  toolsThisTurn: string[];
  aborted: boolean;
  settled: Promise<void>;
  settle: () => void;
}

/** The run's usage in pi's `Usage` shape, so a foreground result folds child spend into the
 * session totals the way any nested model call does. */
function usageForPi(totals: RunTotals): Record<string, unknown> {
  return {
    input: totals.inputTokens,
    output: totals.outputTokens,
    cacheRead: totals.cacheReadTokens,
    cacheWrite: totals.cacheWriteTokens,
    reasoning: totals.reasoningTokens,
    totalTokens: totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totals.costUsd },
  };
}

function textOf(message: Record<string, unknown> | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('');
}

function toolCallsOf(message: Record<string, unknown> | undefined): { id: string; name: string }[] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part && typeof part === 'object' && (part as { type?: string }).type === 'toolCall')
    .map((part) => {
      const call = part as { toolCallId?: string; id?: string; name?: string; toolName?: string };
      return { id: String(call.toolCallId ?? call.id ?? ''), name: String(call.name ?? call.toolName ?? 'tool') };
    });
}

function summaryOf(args: Record<string, unknown>): string {
  const pick = ['command', 'path', 'pattern', 'query', 'url'];
  for (const key of pick) {
    const value = args?.[key];
    if (typeof value === 'string' && value) return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  try {
    const json = JSON.stringify(args ?? {});
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return '';
  }
}

export default async function vocsCodeSubagents(pi: PiLike): Promise<void> {
  // Bare specifiers resolved by the running Pi's own node_modules, like vocs-code-tools.ts does.
  const typeboxName = 'typebox';
  const packageName = '@earendil-works/pi-coding-agent';
  const typebox = (await import(typeboxName)) as unknown as SubagentDeps['Type'];
  const sdk = (await import(packageName)) as unknown as Omit<SubagentDeps, 'Type'>;
  await createVocsCodeSubagents(pi, { Type: typebox, DefaultResourceLoader: sdk.DefaultResourceLoader, SessionManager: sdk.SessionManager, createAgentSession: sdk.createAgentSession });
}

/** The extension body. `pi -e` calls the default export; tests call this with scripted deps. */
export async function createVocsCodeSubagents(pi: PiLike, deps: SubagentDeps): Promise<void> {
  const { Type } = deps;
  const sdk = deps;

  const agentDir = resolveAgentDir(process.env);
  const runDir = process.env.VOCS_CODE_SUBAGENT_DIR?.trim() || null;
  /** The repo's main checkout: its .pi/agents is the project's managed set. */
  const projectRoot = process.env.VOCS_CODE_PROJECT_ROOT?.trim() || undefined;
  /** The shipped templates live beside this file; a stray copy falls back to the compiled-in ones. */
  const templateDir = (() => {
    try {
      return fileURLToPath(new URL('agents/', import.meta.url));
    } catch {
      return undefined;
    }
  })();
  const store = runDir ? new RunStore(runDir, (message) => process.stderr.write(`[vocs-code-subagents] ${message}\n`)) : null;
  const configuredCompletionMs = Number(process.env.VOCS_CODE_SUBAGENT_COMPLETION_MS ?? COMPLETION_DEBOUNCE_MS);
  const completionMs = Number.isFinite(configuredCompletionMs) && configuredCompletionMs >= 0 ? configuredCompletionMs : COMPLETION_DEBOUNCE_MS;
  const runs = new Map<string, ActiveRun>();
  const sessionAllowed = new Set<string>();
  let agents: AgentType[] = [...BUILTIN_AGENTS];
  /** Resolves when the current session's agent discovery has landed, so the first tool call never sees a stale set. */
  let agentsReady: Promise<void> = Promise.resolve();
  let mode: Mode = 'ask';
  let modeFile: string | undefined;
  let parentCtx: CtxLike | null = null;
  let approvalChain: Promise<unknown> = Promise.resolve();
  let pendingCompletions: ActiveRun[] = [];
  let completionTimer: NodeJS.Timeout | null = null;

  pi.events?.on(GRANT_EVENT, (payload) => {
    const tool = (payload as { tool?: unknown } | null)?.tool;
    if (typeof tool === 'string' && tool) sessionAllowed.add(tool);
  });

  const notify = (payload: Record<string, unknown>): void => {
    parentCtx?.ui?.notify(NOTIFY_MARKER + JSON.stringify(payload), 'info');
  };

  const emitItem = (run: ActiveRun, item: RunItem): void => {
    void store?.item(run.id, item);
    notify({ kind: 'item', runId: run.id, item });
  };

  const refreshMode = async (): Promise<void> => {
    const next = await readModeFile(modeFile);
    if (next !== mode) {
      sessionAllowed.clear(); // grants do not survive a mode change
      mode = next;
    }
  };

  /** One approval card at a time: four parallel children must not flood the UI. */
  const askApproval = (run: ActiveRun, decision: Extract<GateDecision, { action: 'ask' }>, event: ToolCallEventLike): Promise<ApprovalChoice> => {
    const ctx = parentCtx;
    const ask = async (): Promise<ApprovalChoice> => {
      if (!ctx?.ui || typeof ctx.ui.select !== 'function') return 'Deny';
      const payload = JSON.stringify({
        tool: event.toolName,
        toolCallId: event.toolCallId,
        input: trimInput(event.input),
        summary: decision.summary,
        runId: run.id,
        agent: run.agent.name,
      });
      const choice = (await ctx.ui.select(APPROVAL_MARKER + payload, APPROVAL_OPTIONS)) as ApprovalChoice | undefined;
      return choice === 'Allow once' || choice === 'Allow for session' ? choice : 'Deny';
    };
    const queued = approvalChain.then(ask, ask);
    approvalChain = queued.catch(() => undefined);
    return queued;
  };

  /** The permission gate every child runs with. Identical rules to the parent's, by construction. */
  const gateFactoryFor = (run: ActiveRun) => (childPi: PiLike): void => {
    childPi.on('tool_call', async (event) => {
      const call = event as unknown as ToolCallEventLike;
      await refreshMode();
      const decision = await decideToolCall({ tool: call.toolName, input: call.input, cwd: parentCtx?.cwd ?? process.cwd(), mode, sessionAllowed, readOnlyMcp: await mcpReadOnlyToolNames() });
      if (decision.action === 'allow') return undefined;
      const blocked = (reason: string) => {
        parentCtx?.ui?.notify(BLOCK_MARKER + JSON.stringify({ toolCallId: call.toolCallId, toolName: call.toolName, runId: run.id }), 'info');
        return { block: true, reason };
      };
      if (decision.action === 'block') return blocked(decision.reason);
      const choice = await askApproval(run, decision, call);
      if (choice === 'Allow once') return undefined;
      if (choice === 'Allow for session') {
        sessionAllowed.add(call.toolName);
        pi.events?.emit(GRANT_EVENT, { tool: call.toolName });
        return undefined;
      }
      return blocked(DECLINED_REASON);
    });
  };

  /**
   * Registers the session's MCP tools into a child session over the parent's connections. Children
   * are in-process agent sessions, so this is a registration, not a second set of servers.
   */
  const mcpFactoryFor = () => async (childPi: PiLike): Promise<void> => {
    try {
      await registerMcpTools(childPi);
    } catch (error) {
      console.error(`[vocs-code-subagents] MCP tools unavailable for a child: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const registerProviderForChild = (ctx: CtxLike, session: ChildSession): void => {
    // Providers registered in-process (an extension's proxy or a test fixture) are not on disk, so
    // the child's own runtime would not find them. Copy the configs the parent knows about.
    try {
      const registry = ctx.modelRegistry;
      for (const id of registry?.getRegisteredProviderIds?.() ?? []) {
        const config = registry?.getRegisteredProviderConfig?.(id);
        if (config) session.modelRuntime?.registerProvider(id, config);
      }
    } catch {
      /* best effort: a child that cannot resolve an in-process provider still reports its error */
    }
  };

  const settleRun = async (run: ActiveRun, status: RunStatus, error?: string): Promise<void> => {
    if (run.status !== 'running') return;
    run.status = status;
    run.error = error;
    run.session?.dispose();
    run.session = null;
    const item: RunItem = {
      id: `${run.id}-end`,
      ts: Date.now(),
      kind: 'info',
      summary: error ? `Run ${status}: ${error}` : `Run ${status}`,
      status: status === 'completed' ? 'done' : status === 'error' ? 'error' : 'declined',
    };
    await store?.item(run.id, item);
    await store?.end(run.id, status, run.totals, error);
    notify({ kind: 'end', runId: run.id, status, totals: run.totals, error, endedAt: Date.now(), output: run.output.slice(-4_000) });
    if (run.mode === 'background') scheduleCompletion(run);
    run.settle();
    // Keep finished runs addressable for `subagent_result`; the map is bounded by the session cap.
  };

  const scheduleCompletion = (run: ActiveRun): void => {
    pendingCompletions.push(run);
    if (completionTimer) clearTimeout(completionTimer);
    completionTimer = setTimeout(() => {
      completionTimer = null;
      const finished = pendingCompletions;
      pendingCompletions = [];
      if (!finished.length || !pi.sendMessage) return;
      const lines = finished.map((r) => {
        const where = runDir ? ` Full transcript: ${path.join(runDir, `${r.id}.jsonl`)}` : '';
        const head = r.output ? r.output.slice(0, 1_500) : (r.error ?? '');
        return `- ${r.agent.name} (${r.id}) — ${r.status}: ${r.description}\n${head}${where}`;
      });
      pi.sendMessage(
        {
          customType: COMPLETION_TYPE,
          content: `Background subagent ${finished.length === 1 ? 'run' : 'runs'} finished:\n\n${lines.join('\n\n')}\n\nUse subagent_result for the full output.`,
          display: false,
          details: { runs: finished.map((r) => ({ runId: r.id, agent: r.agent.name, status: r.status, description: r.description, totals: r.totals, error: r.error })) },
        },
        { deliverAs: 'followUp', triggerTurn: true }
      );
    }, completionMs);
    completionTimer.unref?.();
  };

  const activeCount = (kind?: 'background' | 'foreground'): number => [...runs.values()].filter((r) => r.status === 'running' && (!kind || r.mode === kind)).length;

  const startRun = async (params: { description: string; prompt: string; type?: string; background?: boolean; model?: string }, ctx: CtxLike, signal: AbortSignal | undefined): Promise<ActiveRun> => {
    const agent = findAgent(agents, params.type) ?? findAgent(agents, 'general-purpose') ?? BUILTIN_AGENTS[0]!;
    if (params.type && !findAgent(agents, params.type)) {
      const names = agents.map((a) => a.name).join(', ');
      throw new Error(`Unknown subagent type "${params.type}". Available: ${names}. Omit type to use general-purpose.`);
    }
    if (activeCount() >= SESSION_LIMIT) throw new Error(`Vocs Code allows ${SESSION_LIMIT} active subagent runs per session; wait for one to finish or stop one first.`);
    if (params.background && activeCount('background') >= BACKGROUND_LIMIT) throw new Error(`Vocs Code allows ${BACKGROUND_LIMIT} background subagent runs at once; wait for one to finish or run this one in the foreground.`);

    const runId = `agent_${randomUUID().slice(0, 8)}`;
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const run: ActiveRun = {
      id: runId,
      agent,
      description: params.description,
      prompt: params.prompt,
      mode: params.background ? 'background' : 'foreground',
      status: 'running',
      startedAt: Date.now(),
      session: null,
      output: '',
      totals: emptyTotals(),
      callIndex: 0,
      calls: [],
      pendingCall: null,
      assistantStartedAt: 0,
      toolsThisTurn: [],
      aborted: false,
      settled,
      settle,
    };
    runs.set(runId, run);
    signal?.addEventListener('abort', () => {
      run.aborted = true;
      void run.session?.abort();
    }, { once: true });

    const cwd = ctx.cwd ?? process.cwd();
    const parentPrompt = (() => {
      try {
        return ctx.getSystemPrompt?.() ?? '';
      } catch {
        return '';
      }
    })();
    let model: unknown;
    if (params.model) {
      const slash = params.model.indexOf('/');
      if (slash > 0) model = ctx.modelRegistry?.find?.(params.model.slice(0, slash), params.model.slice(slash + 1));
      if (!model) throw new Error(`Model "${params.model}" is not available; use provider/model-id or omit it to inherit the session model.`);
    } else if (agent.model) {
      model = ctx.modelRegistry?.find?.(agent.model.provider, agent.model.model);
      if (!model) throw new Error(`Model "${agent.model.provider}/${agent.model.model}" pinned by agent "${agent.name}" is not available.`);
    } else {
      model = ctx.model;
    }

    await store?.start({
      runId,
      agent: agent.name,
      description: params.description,
      mode: run.mode,
      provider: (model as ModelLike | undefined)?.provider,
      model: (model as ModelLike | undefined)?.id,
      cwd,
      startedAt: run.startedAt,
    });
    notify({ kind: 'start', runId, agent: agent.name, description: params.description, mode: run.mode, provider: (model as ModelLike | undefined)?.provider, model: (model as ModelLike | undefined)?.id, startedAt: run.startedAt, cwd });

    // A child gets the session's MCP tools unless its agent definition opts out (`mcp: false`),
    // the same opt-out the app's own templates use for its read-only Explore and Plan agents.
    const childMcpTools = agent.mcp ? await mcpToolNames() : [];
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: false,
      extensionFactories: [gateFactoryFor(run), ...(childMcpTools.length ? [mcpFactoryFor()] : [])],
      systemPromptOverride: () => buildSystemPrompt(agent, parentPrompt),
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const created = await sdk.createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      tools: [...toolNamesFor(agent), ...childMcpTools],
      excludeTools: [...EXCLUDED_CHILD_TOOLS],
      ...(model ? { model } : {}),
      ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
    });
    run.session = created.session;
    registerProviderForChild(ctx, run.session);

    run.session.subscribe((event) => {
      void handleChildEvent(run, event);
    });

    void run.session
      .prompt(params.prompt)
      .then(async () => {
        const status: RunStatus = run.aborted ? 'stopped' : lastError(run) ? 'error' : 'completed';
        await settleRun(run, status, lastError(run));
      })
      .catch(async (error: unknown) => {
        await settleRun(run, run.aborted ? 'stopped' : 'error', error instanceof Error ? error.message : String(error));
      });
    return run;
  };

  const lastError = (run: ActiveRun): string | undefined => {
    const messages = run.session?.messages;
    if (!Array.isArray(messages)) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== 'assistant') continue;
      const stop = message.stopReason;
      const error = message.errorMessage;
      if (typeof error === 'string' && error) return error;
      if (stop === 'error') return 'The model returned an error.';
      return undefined;
    }
    return undefined;
  };

  const handleChildEvent = async (run: ActiveRun, event: Record<string, unknown>): Promise<void> => {
    switch (event.type) {
      case 'message_start': {
        run.assistantStartedAt = Date.now();
        return;
      }
      case 'message_end': {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.role === 'assistant') {
          const usage = message.usage as Record<string, unknown> | undefined;
          const model = message.model as string | undefined;
          const provider = message.provider as string | undefined;
          const calls = toolCallsOf(message);
          const call = emptyCall(run.callIndex++);
          call.provider = provider;
          call.model = model;
          call.toolsInvoked = calls.map((c) => c.name);
          call.stopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined;
          addUsage(call, run.totals, usage as UsageLike | undefined, run.assistantStartedAt ? Date.now() - run.assistantStartedAt : 0);
          run.assistantStartedAt = 0;
          run.calls.push(call);
          await store?.call(run.id, call);
          notify({ kind: 'call', runId: run.id, call });
          run.totals.turns += 1;
          const text = textOf(message);
          if (text) {
            run.output = text;
            emitItem(run, { id: `${run.id}-m${run.callIndex}`, ts: Date.now(), kind: 'assistant', text: text.slice(0, 20_000) });
          }
          run.toolsThisTurn = [];
        }
        return;
      }
      case 'tool_execution_start': {
        const toolName = String(event.toolName ?? 'tool');
        const args = (event.args ?? {}) as Record<string, unknown>;
        run.toolsThisTurn.push(toolName);
        emitItem(run, { id: String(event.toolCallId ?? randomUUID()), ts: Date.now(), kind: 'tool', name: toolName, summary: summaryOf(args), status: 'running', input: trimInput(args, 1_000) });
        return;
      }
      case 'tool_execution_end': {
        const toolName = String(event.toolName ?? 'tool');
        const result = event.result as Record<string, unknown> | undefined;
        const isError = event.isError === true;
        const content = Array.isArray(result?.content) ? (result!.content as Array<Record<string, unknown>>) : [];
        const output = content.map((part) => (part.type === 'text' ? String(part.text ?? '') : '[image]')).join('\n');
        run.totals.toolUses += 1;
        emitItem(run, {
          id: String(event.toolCallId ?? randomUUID()),
          ts: Date.now(),
          kind: 'tool',
          name: toolName,
          status: isError ? 'error' : 'done',
          output: output.slice(0, 20_000),
        });
        return;
      }
      default:
        return;
    }
  };

  const runSummary = (run: ActiveRun): Record<string, unknown> => ({
    runId: run.id,
    agent: run.agent.name,
    description: run.description,
    mode: run.mode,
    status: run.status,
    model: run.calls.at(-1)?.model ?? undefined,
    provider: run.calls.at(-1)?.provider ?? undefined,
    turns: run.totals.turns,
    toolUses: run.totals.toolUses,
    costUsd: run.totals.costUsd,
    durationMs: run.totals.durationMs,
    output: run.output.slice(0, RESULT_CHARS),
    error: run.error,
  });

  const describeTypes = (): string => agents.map((agent) => `${agent.name}: ${agent.description}`).join('\n');

  const registerTools = (): void => {
    pi.registerTool({
      name: 'subagent',
      label: 'Subagent',
      description: `Run a task in a separate agent with its own context and tools. Available types:\n${describeTypes()}`,
      promptSnippet: 'Run a self-contained task in a child agent (foreground or background)',
      promptGuidelines: [
        'Use subagent to delegate a self-contained search or multi-step task to a child agent instead of doing everything inline; prefer it over any other delegation tool such as Agent or Task when both are available.',
        'Use subagent_result to read a background run\'s output by id, and subagent_steer to redirect a run that went the wrong way.',
        'Vocs Code subagent runs inherit this session\'s permission mode: a child that needs approval asks through the same approval card, so do not avoid subagents to "avoid prompts".',
      ],
      parameters: Type.Object({
        description: Type.String({ description: 'A short (3-5 word) description of the task, shown in the UI.' }),
        prompt: Type.String({ description: 'The task for the subagent. Self-contained: it cannot see this conversation.' }),
        type: Type.Optional(Type.String({ description: `Agent type. One of: ${agents.map((a) => a.name).join(', ')}. Defaults to general-purpose.` })),
        background: Type.Optional(Type.Boolean({ description: 'Run detached and report back when finished. Defaults to false (foreground: this turn waits for the result).' })),
        model: Type.Optional(Type.String({ description: 'Override the model as provider/model-id. Defaults to the agent type\'s pin, else this session\'s model.' })),
      }),
      execute: async (_toolCallId: string, params: { description: string; prompt: string; type?: string; background?: boolean; model?: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: CtxLike) => {
        parentCtx = ctx;
        await agentsReady;
        await refreshMode();
        const run = await startRun(params, ctx, signal);
        if (run.mode === 'background') {
          return {
            content: [{ type: 'text', text: `Started ${run.agent.name} in the background as ${run.id}. It will report back when finished; use subagent_result ${run.id} for its output.` }],
            details: runSummary(run),
          };
        }
        await run.settled;
        const statusLine = `${run.agent.name} ${run.status} — ${run.totals.turns} turn(s), ${run.totals.toolUses} tool call(s), ${(run.totals.durationMs / 1000).toFixed(1)}s${run.totals.costUsd ? `, $${run.totals.costUsd.toFixed(4)}` : ''}`;
        const body = run.output || run.error || '(no output)';
        return { content: [{ type: 'text', text: `${body}\n\n[${statusLine}]` }], details: runSummary(run), usage: usageForPi(run.totals) };
      },
    });

    pi.registerTool({
      name: 'subagent_result',
      label: 'Subagent result',
      description: 'Read a subagent run\'s output and stats. Omit runId to list every run in this session.',
      promptSnippet: 'Read a subagent run\'s output by id',
      parameters: Type.Object({
        runId: Type.Optional(Type.String({ description: 'Run id returned by subagent, e.g. agent_1a2b3c4d. Omit to list all runs.' })),
      }),
      execute: async (_toolCallId: string, params: { runId?: string }) => {
        if (params.runId) {
          const run = runs.get(params.runId);
          if (!run) throw new Error(`No subagent run "${params.runId}" in this session. Omit runId to list the runs.`);
          return { content: [{ type: 'text', text: JSON.stringify(runSummary(run), null, 2) }], details: runSummary(run) };
        }
        const list = [...runs.values()].map((run) => ({ runId: run.id, agent: run.agent.name, status: run.status, description: run.description, mode: run.mode }));
        return { content: [{ type: 'text', text: list.length ? JSON.stringify(list, null, 2) : 'No subagent runs in this session.' }], details: { runs: list } };
      },
    });

    pi.registerTool({
      name: 'subagent_steer',
      label: 'Steer subagent',
      description: 'Send a mid-run instruction to a running subagent.',
      promptSnippet: 'Redirect a running subagent',
      parameters: Type.Object({
        runId: Type.String({ description: 'Run id returned by subagent.' }),
        message: Type.String({ description: 'The instruction to deliver to the run.' }),
      }),
      execute: async (_toolCallId: string, params: { runId: string; message: string }) => {
        const run = runs.get(params.runId);
        if (!run || run.status !== 'running' || !run.session) throw new Error(`Subagent run "${params.runId}" is not running.`);
        await run.session.steer(params.message);
        return { content: [{ type: 'text', text: `Steered ${params.runId}.` }], details: { runId: params.runId } };
      },
    });
  };

  pi.registerCommand?.('vocs-subagent-stop', {
    description: 'Stop a Vocs Code subagent run by id',
    handler: async (args: string) => {
      const runId = args.trim().split(/\s+/)[0] ?? '';
      const run = runs.get(runId);
      if (!run || run.status !== 'running') return;
      run.aborted = true;
      await run.session?.abort();
    },
  });

  pi.on('session_start', (_event, ctx) => {
    parentCtx = ctx;
    modeFile = process.env.VOCS_CODE_MODE_FILE;
    // Readiness is emitted synchronously: the host checks it right after get_state, before any
    // await we start here could resolve. Discovery below only refines the tool description.
    ctx.ui?.notify('VCODE_PI_READY::' + JSON.stringify({ version: 1, nonce: process.env.VOCS_CODE_PI_NONCE, capability: 'subagents', ready: true }), 'info');
    agentsReady = (async () => {
      mode = await readModeFile(modeFile);
      agents = await discoverAgents({ cwd: ctx.cwd ?? process.cwd(), projectRoot, agentDir, templateDir });
      registerTools(); // refresh the tool description with the discovered types
    })();
  });

  pi.on('session_shutdown', (_event, ctx) => {
    ctx.ui?.notify('VCODE_PI_READY::' + JSON.stringify({ version: 1, nonce: process.env.VOCS_CODE_PI_NONCE, capability: 'subagents', ready: false }), 'info');
    for (const run of runs.values()) {
      if (run.status !== 'running') continue;
      run.aborted = true;
      void run.session?.abort();
      void settleRun(run, 'interrupted');
    }
  });

  // A user-pressed stop aborts the parent turn; every child of that turn stops with it.
  pi.on('message_end', (event) => {
    const message = event.message as Record<string, unknown> | undefined;
    if (message?.role !== 'assistant' || message.stopReason !== 'aborted') return undefined;
    for (const run of runs.values()) {
      if (run.status !== 'running') continue;
      run.aborted = true;
      void run.session?.abort();
    }
    return undefined;
  });

  registerTools();
}
