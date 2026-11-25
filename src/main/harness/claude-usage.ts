/** Streaming token accounting, catalog cost repricing for unknown models, and turn usage settlement for Claude Code. */
import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderConfig, SessionEvent, UsageTotals } from '../../shared/types';
import { estimateCostUsd, findContextWindow, findPricing, modelsForProvider } from '../models/static-models';
import { TurnUsageTracker } from '../util/turn-usage';
import { UsageReporter } from '../util/usage-reporter';

function finiteCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function counterDelta(previous: number, current: number): number {
  return current >= previous ? current - previous : current;
}

export class ClaudeUsageTracker {
  private readonly usage: TurnUsageTracker;
  private readonly reporter: UsageReporter;
  /** Output usage is cumulative within the current Anthropic streaming response. */
  private streamOutputTokens = 0;
  private streamReasoningTokens = 0;
  private streamInputReported = false;

  constructor(
    initialUsage: UsageTotals,
    private readonly deps: {
      emit: (event: SessionEvent) => void;
      providerId: () => string | undefined;
      activeModel: () => string | undefined;
      providers: () => ProviderConfig[];
    }
  ) {
    this.usage = new TurnUsageTracker(initialUsage);
    this.reporter = new UsageReporter(deps.emit);
  }

  beginProcess(): void {
    this.usage.beginProcess();
  }

  beginTurn(): void {
    this.usage.beginTurn();
  }

  reportStreamUsage(ev: {
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
      const model = ev.message?.model ?? this.deps.activeModel();
      const contextWindow = model ? findContextWindow(this.deps.providerId() ?? 'anthropic', model) : undefined;
      if (contextTokens > 0 || contextWindow) this.usage.setCumulative({ contextTokens: contextTokens > 0 ? contextTokens : undefined, contextWindow });
      this.reporter.report(this.usage.snapshot());
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
      this.reporter.report(this.usage.snapshot());
    }
  }

  settleResult(msg: {
    modelUsage?: Record<string, ModelUsage>;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  }): { usage: Partial<UsageTotals> | undefined; turnCost: number } {
    let usage: Partial<UsageTotals> | undefined;
    const mu = msg.modelUsage;
    const cumulative = mu && Object.keys(mu).length > 0 ? this.modelUsageTotals(mu) : undefined;
    // Cost is settled in one step: the CLI's `total_cost_usd` is the same figure modelUsage breaks
    // down, and reporting the guess first would seed the tracker with exactly the value the catalog
    // override replaces — its counters only move up, so the higher number would stick.
    const costUsd = cumulative ? cumulative.costUsd : typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined;
    if (costUsd !== undefined) this.usage.setCumulative({ costUsd });
    if (cumulative) {
      const u = msg.usage;
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
    this.reporter.report(trackerTurn.totals);
    this.reporter.flush();
    return { usage, turnCost: turnUsage?.costUsd ?? 0 };
  }

  settleInterrupted(): { usage: Partial<UsageTotals> | undefined; costUsd: number } {
    const trackerTurn = this.usage.finishTurn();
    this.reporter.report(trackerTurn.totals);
    this.reporter.flush();
    const u = trackerTurn.usage;
    return {
      costUsd: u?.costUsd ?? 0,
      usage: u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens } : undefined
    };
  }

  close(): void {
    this.reporter.close();
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
    const providerId = this.deps.providerId();
    const provider = providerId ?? 'anthropic';
    // The gateway's own cached list first: a vendor-named id like OpenRouter's `z-ai/glm-5.3-flash`
    // exists only there, so without it a model this app can price perfectly well falls back to the
    // CLI's default rate — the exact overstatement this method exists to undo.
    const models = modelsForProvider(this.deps.providers(), providerId);
    const pricing = findPricing(provider, model, models) ?? (v.canonicalModel ? findPricing(provider, v.canonicalModel, models) : undefined);
    if (!pricing) return undefined;
    return estimateCostUsd(pricing, {
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      cacheReadTokens: v.cacheReadInputTokens,
      cacheWriteTokens: v.cacheCreationInputTokens
    });
  }
}
