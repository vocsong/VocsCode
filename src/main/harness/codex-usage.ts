/** Codex cumulative token usage accounting, uncached-input normalization, and per-model/Fast-mode cost estimation. */
import type { ModelInfo, SessionEvent, UsageTotals } from '../../shared/types';
import { estimateCostUsd, findPricing } from '../models/static-models';
import { TurnUsageTracker } from '../util/turn-usage';
import { CODEX_FAST_PRICING_UNAVAILABLE_MSG, isCodexFastTier } from './codex-provider';
import { fastModePricing } from './native/fast-mode-pricing';

export interface CodexTokenUsageNotification {
  tokenUsage: {
    total: {
      inputTokens: number;
      cachedInputTokens: number;
      cacheWriteInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
      totalTokens: number;
    };
    last: { totalTokens: number };
    modelContextWindow: number | null;
  };
}

/** Codex counts cached input inside input tokens (OpenAI convention); return the uncached remainder. */
export function normalizeCodexInputTokens(inputTokens: number, cachedInputTokens: number): number {
  return Math.max(0, inputTokens - cachedInputTokens);
}

export class CodexUsageTracker {
  private readonly usage: TurnUsageTracker;
  private unknownFastCostReported = false;

  constructor(
    initialUsage: UsageTotals,
    private readonly deps: {
      emit: (event: SessionEvent) => void;
      warn: (message: string) => void;
      pricingContext: () => { fastMode: boolean; serviceTier: string; model: string; provider: string; models: ModelInfo[] };
    }
  ) {
    this.usage = new TurnUsageTracker(initialUsage);
  }

  beginTurn(): void {
    this.usage.beginTurn();
  }

  resetFastWarning(): void {
    this.unknownFastCostReported = false;
  }

  finishTurn(): { totals: UsageTotals; usage?: Partial<UsageTotals> } {
    return this.usage.finishTurn();
  }

  applyNotification(n: CodexTokenUsageNotification): void {
    const t = n.tokenUsage.total;
    const before = this.usage.snapshot();
    // Codex counts cached input inside its input tokens (OpenAI convention); store the uncached
    // remainder so cache reads are not counted twice in rates and cost estimates.
    const cumulative = {
      inputTokens: normalizeCodexInputTokens(t.inputTokens, t.cachedInputTokens),
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cachedInputTokens,
      cacheWriteTokens: t.cacheWriteInputTokens,
      reasoningTokens: t.reasoningOutputTokens,
      contextWindow: n.tokenUsage.modelContextWindow ?? before.contextWindow,
      contextTokens: n.tokenUsage.last?.totalTokens ?? before.contextTokens
    };
    this.usage.setCumulative(cumulative);
    // Codex reports these counters but no price, and a rate belongs to the model that produced
    // each sample: the increment this sample added is priced at the current model's rates, while
    // pricing the running totals would re-bill everything a mid-session model switch already
    // counted at the previous model's rate. How much was added is the tracker's own epoch handling
    // to decide — a reset counter contributes nothing rather than a negative.
    const after = this.usage.snapshot();
    const added = {
      inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
      outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
      cacheReadTokens: Math.max(0, after.cacheReadTokens - before.cacheReadTokens),
      cacheWriteTokens: Math.max(0, after.cacheWriteTokens - before.cacheWriteTokens)
    };
    // Spend is additive and never reconciled: Codex reports no cost to reconcile it against, and
    // money spent at an earlier model's rate stays spent.
    const ctx = this.deps.pricingContext();
    const fast = ctx.fastMode && isCodexFastTier(ctx.serviceTier);
    const pricing = fast
      ? fastModePricing(ctx.model, added.inputTokens + added.cacheReadTokens + added.cacheWriteTokens)
      : findPricing(ctx.provider, ctx.model, ctx.models);
    if (fast && !pricing && !this.unknownFastCostReported) {
      this.unknownFastCostReported = true;
      this.deps.warn(CODEX_FAST_PRICING_UNAVAILABLE_MSG);
    }
    this.usage.addUsage({ costUsd: estimateCostUsd(pricing, added) });
    this.deps.emit({ type: 'usage', totals: this.usage.snapshot() });
  }
}
