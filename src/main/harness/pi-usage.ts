/** Streaming token/cost accounting and Fast-mode premium estimation & revision-acked state for Pi. */
import { randomUUID } from 'node:crypto';
import type { ModelRef, SessionEvent, SessionMeta, SubagentCost, UsageTotals } from '../../shared/types';
import { estimateCostUsd } from '../models/static-models';
import { deferred, type Deferred } from '../util/async';
import { TurnUsageTracker } from '../util/turn-usage';
import { UsageReporter } from '../util/usage-reporter';
import { fastModePricing } from './native/fast-mode-pricing';

const PI_FAST_FALLBACK_MULTIPLIER = 2;
const PI_FAST_FALLBACK_ESTIMATE = `${PI_FAST_FALLBACK_MULTIPLIER}x Pi's standard cost estimate`;

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

export interface FastModeChangeHandle {
  requestId: string;
  revision: number;
  enabled: boolean;
  ack: Deferred<void>;
}

export class PiUsageAndFastMode {
  private readonly usage: TurnUsageTracker;
  private readonly reporter: UsageReporter;
  /** Latest cumulative usage in the current assistant stream, used to derive per-update deltas. */
  private streamUsage: PiStreamUsage | null = null;
  private fastModeRequested = false;
  /** Only the nonce-bound extension's endpoint-checked runtime model can select Fast pricing. */
  private fastModeEffectiveModel: ModelRef | undefined;
  private streamFastModeModel: ModelRef | undefined;
  /** Additive premium above Pi's standard-rate cumulative session cost, including earlier turns. */
  private fastModeCostAdjustment = 0;
  private readonly unknownFastCostReported = new Set<string>();
  private fastModeRevision = 0;
  private fastModeChange: FastModeChangeHandle | null = null;

  constructor(
    initialUsage: UsageTotals,
    private readonly deps: {
      emit: (event: SessionEvent) => void;
      updateMeta: (patch: Partial<Pick<SessionMeta, 'fastModeStatus'>>) => void;
      info: (text: string, level?: 'info' | 'warn' | 'error') => void;
    }
  ) {
    this.usage = new TurnUsageTracker(initialUsage);
    this.reporter = new UsageReporter(deps.emit);
  }

  get requested(): boolean {
    return this.fastModeRequested;
  }

  get changing(): boolean {
    return this.fastModeChange !== null;
  }

  initLaunch(requested: boolean): void {
    this.fastModeRequested = requested;
    this.fastModeRevision = 0;
    this.fastModeChange = null;
    this.deps.updateMeta({ fastModeStatus: { state: this.fastModeRequested ? 'requested' : 'off' } });
  }

  beginTurn(): void {
    this.usage.beginTurn();
  }

  onAssistantStart(provider?: string, model?: string): void {
    // Pi's streaming usage is cumulative for one assistant message, not the whole session.
    this.streamUsage = null;
    const effective = this.fastModeRequested ? this.fastModeEffectiveModel : undefined;
    this.streamFastModeModel = effective && (!provider || provider === effective.provider) && (!model || model === effective.model) ? effective : undefined;
  }

  onAssistantEnd(rawUsage: unknown): void {
    this.reportUsage(rawUsage, true);
    this.streamUsage = null;
    this.streamFastModeModel = undefined;
  }

  /** Applies the latest per-assistant usage snapshot and publishes a throttled live session update. */
  reportUsage(raw: unknown, final = false): void {
    const current = piStreamUsage(raw);
    if (!current) return;
    // Price the completed request, not growing partial input (long-context rates can differ).
    // Pi exposes no response tier; this is a requested-service estimate, not confirmed billing.
    const model = final ? this.streamFastModeModel : undefined;
    if (model) {
      const pricing = model.provider === 'openai' || model.provider === 'anthropic'
        ? fastModePricing(model.model, current.input + current.cacheRead + current.cacheWrite) : undefined;
      // Pi does not expose cache TTL; Anthropic cache writes use the five-minute estimate.
      const hasFastRates = pricing && (!current.cacheWrite || pricing.cacheWrite !== undefined);
      const estimate = hasFastRates
        ? estimateCostUsd(pricing, { inputTokens: current.input, outputTokens: current.output, cacheReadTokens: current.cacheRead, cacheWriteTokens: current.cacheWrite })
        : current.cost * PI_FAST_FALLBACK_MULTIPLIER;
      const premium = Math.max(0, estimate - current.cost);
      current.cost += premium;
      this.fastModeCostAdjustment += premium;
      if (!hasFastRates) {
        const key = `${model.provider}/${model.model}`;
        if (!this.unknownFastCostReported.has(key)) {
          this.unknownFastCostReported.add(key);
          this.deps.info(`Pi Fast pricing is unavailable for this model or context. Analytics estimates spend at ${PI_FAST_FALLBACK_ESTIMATE} when available. Check provider billing for actual charges.`, 'warn');
        }
      }
    }
    const delta = piUsageDelta(this.streamUsage, current);
    this.streamUsage = current;
    if (!hasPiUsage(delta)) return;
    this.usage.addUsage({ inputTokens: delta.input, outputTokens: delta.output, cacheReadTokens: delta.cacheRead, cacheWriteTokens: delta.cacheWrite, reasoningTokens: delta.reasoning, costUsd: delta.cost });
    this.reporter.report(this.usage.snapshot());
  }

  applySessionStats(stats: {
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    cost?: number;
    contextUsage?: { tokens?: number; contextWindow?: number } | null;
  }): void {
    const t = stats.tokens ?? {};
    this.usage.setCumulative({
      inputTokens: t.input,
      outputTokens: t.output,
      cacheReadTokens: t.cacheRead,
      cacheWriteTokens: t.cacheWrite,
      // Pi's stats remain standard-rate. Keep all locally estimated premiums across toggles.
      costUsd: typeof stats.cost === 'number' ? stats.cost + this.fastModeCostAdjustment : undefined,
      contextTokens: stats.contextUsage?.tokens,
      contextWindow: stats.contextUsage?.contextWindow
    });
  }

  finishTurn(subagentCostByModel: SubagentCost[] | undefined): { turnCost: number; turnUsage: Partial<UsageTotals> | undefined } {
    const completed = this.usage.finishTurn();
    this.reporter.report(completed.totals, subagentCostByModel);
    this.reporter.flush();
    const turnCost = completed.usage?.costUsd ?? 0;
    // The whole delta, not just input/output: a turn's cache reads and reasoning tokens are part of
    // what it cost and how fast it ran. A turn with neither a streamed sample nor a stats snapshot
    // has no measured usage at all, so the row stays unknown instead of claiming a measured zero.
    const turnUsage = completed.usage && Object.values(completed.usage).some((value) => (value ?? 0) > 0) ? completed.usage : undefined;
    return { turnCost, turnUsage };
  }

  handleFastModeNotification(payload: Record<string, unknown>): void {
    const change = this.fastModeChange;
    const acknowledged = !!change && payload.requestId === change.requestId && payload.revision === change.revision && payload.enabled === change.enabled;
    const current = payload.revision === this.fastModeRevision && payload.enabled === this.fastModeRequested;
    if ((!acknowledged && !current) || !['off', 'requested', 'unavailable', 'cooldown'].includes(String(payload.state)) ||
        (payload.enabled === false) !== (payload.state === 'off')) return;
    if (acknowledged) {
      this.fastModeRequested = change!.enabled;
      this.fastModeRevision = change!.revision;
      change!.ack.resolve();
    }
    const effective = payload.effectiveModel as Partial<ModelRef> | undefined;
    this.fastModeEffectiveModel = effective && typeof effective.provider === 'string' && typeof effective.model === 'string'
      ? { provider: effective.provider, model: effective.model } : undefined;
    let detail = typeof payload.detail === 'string' ? payload.detail : undefined;
    if (payload.enabled && this.fastModeEffectiveModel) {
      const model = this.fastModeEffectiveModel;
      const priced = (model.provider === 'openai' || model.provider === 'anthropic') && fastModePricing(model.model, 0);
      const pricingDetail = priced
        ? `Analytics uses published Fast rates where available, or ${PI_FAST_FALLBACK_ESTIMATE} otherwise. Anthropic cache writes assume a five-minute TTL.`
        : `Fast pricing is unavailable; analytics estimates spend at ${PI_FAST_FALLBACK_ESTIMATE} when available.`;
      detail = `${detail ?? ''} ${pricingDetail} Check provider billing for actual charges.`.trim();
    }
    this.deps.updateMeta({ fastModeStatus: { state: payload.state as 'off' | 'requested' | 'unavailable' | 'cooldown', ...(detail ? { detail } : {}) } });
  }

  beginFastModeChange(enabled: boolean): FastModeChangeHandle {
    const change: FastModeChangeHandle = { requestId: randomUUID(), revision: this.fastModeRevision + 1, enabled, ack: deferred<void>() };
    this.fastModeChange = change;
    return change;
  }

  clearFastModeChange(): void {
    this.fastModeChange = null;
  }

  rejectFastModeChange(error: Error): void {
    this.fastModeChange?.ack.reject(error);
  }

  onFastModeExtensionError(errorMessageText?: string): void {
    this.fastModeChange?.ack.reject(new Error(errorMessageText ?? 'Pi Fast mode extension failed.'));
    this.deps.updateMeta({ fastModeStatus: { state: 'unavailable', detail: 'Pi Fast mode extension failed.' } });
  }

  close(): void {
    this.reporter.close();
  }
}
