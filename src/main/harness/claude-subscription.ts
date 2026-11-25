/** Passive subscription rate-limit window observation and provenance verification for Claude Code sessions. */
import type { Options, Query, SDKRateLimitEvent } from '@anthropic-ai/claude-agent-sdk';
import { ANTHROPIC_DEFAULT_BASE_URL } from '../../shared/providers';
import type { ObservedSubscriptionWindow } from '../../shared/subscription-usage';

const SUBSCRIPTION_WINDOW_TTL_MS = 10 * 60_000;
const SUBSCRIPTION_WINDOWS = {
  five_hour: { name: '5-hour limit', durationMs: 5 * 60 * 60_000 },
  seven_day: { name: 'Weekly limit', durationMs: 7 * 24 * 60 * 60_000 }
} as const;
type SubscriptionWindowType = keyof typeof SUBSCRIPTION_WINDOWS;

const NON_SUBSCRIPTION_ENV = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL'
]);

/** The final launch env after the app's provider overlay, not a second source of credentials. */
export function allowsSubscriptionObservation(env: NonNullable<Options['env']>): boolean {
  return Object.entries(env).every(([key, value]) => {
    if (!value) return true;
    const name = process.platform === 'win32' ? key.toUpperCase() : key;
    if (name === 'ANTHROPIC_BASE_URL') return value.replace(/\/+$/, '') === ANTHROPIC_DEFAULT_BASE_URL;
    return !NON_SUBSCRIPTION_ENV.has(name);
  });
}

interface ClaudeSubscriptionObservation {
  query: Query;
  sessionId?: string;
  account: 'unchecked' | 'checking' | 'verified' | 'refused';
  windows: Map<SubscriptionWindowType, ObservedSubscriptionWindow>;
}

/** Tracks verified in-memory subscription rate-limit readings observed during normal Claude turns. */
export class ClaudeSubscriptionTracker {
  private observation: ClaudeSubscriptionObservation | undefined;

  attach(query: Query): void {
    this.observation = { query, account: 'unchecked', windows: new Map() };
  }

  detach(query?: Query): void {
    if (!query || this.observation?.query === query) this.observation = undefined;
  }

  onInit(query: Query, apiKeySource: string | undefined, rawSessionId: string): void {
    const observation = this.observation;
    if (observation?.query !== query) return;
    // 'none' is not proof of subscription, but anything else may be a key (including
    // one from the CLI's own settings). Do not carry readings across /clear or a new ID.
    const sessionId = apiKeySource === 'none' ? rawSessionId : undefined;
    if (observation.sessionId !== sessionId) observation.windows.clear();
    observation.sessionId = sessionId;
  }

  observedWindows(): ObservedSubscriptionWindow[] {
    const observation = this.observation;
    if (observation?.account !== 'verified') return [];
    const now = Date.now();
    const fresh: ObservedSubscriptionWindow[] = [];
    for (const type of ['five_hour', 'seven_day'] as const) {
      const window = observation.windows.get(type);
      if (!window) continue;
      if (window.observedAt <= now && now < window.expiresAt) fresh.push({ ...window });
      else observation.windows.delete(type);
    }
    return fresh;
  }

  observe(msg: SDKRateLimitEvent, q: Query): void {
    const observation = this.observation;
    if (observation?.query !== q || observation.account === 'refused' || !observation.sessionId || observation.sessionId !== msg.session_id) return;
    const info = msg.rate_limit_info;
    const type = info?.rateLimitType;
    if (type !== 'five_hour' && type !== 'seven_day') return;
    // A newer report for this window without usable plan data supersedes the old reading.
    observation.windows.delete(type);
    if (info.isUsingOverage || info.overageInUse || info.limitScope !== undefined || info.errorCode !== undefined) return;
    if (info.status !== 'allowed' && info.status !== 'allowed_warning' && info.status !== 'rejected') return;
    const { utilization, resetsAt } = info;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0 || utilization > 1) return;
    const { name, durationMs } = SUBSCRIPTION_WINDOWS[type];
    const now = Date.now();
    let resetMs: number | undefined;
    if (resetsAt !== undefined) {
      if (typeof resetsAt !== 'number') return;
      resetMs = Math.trunc(resetsAt * 1_000); // The SDK reports Unix seconds.
      if (!Number.isFinite(resetMs) || resetMs <= now || resetMs > now + durationMs) return;
    }
    observation.windows.set(type, {
      name, remainingFraction: 1 - utilization,
      ...(resetMs !== undefined ? { resetAt: new Date(resetMs).toISOString() } : {}),
      observedAt: now, expiresAt: Math.min(now + SUBSCRIPTION_WINDOW_TTL_MS, resetMs ?? Infinity)
    });
    if (observation.account === 'unchecked') {
      observation.account = 'checking';
      void this.verifyAccount(q);
    }
  }

  private async verifyAccount(q: Query): Promise<void> {
    let verified = false;
    try {
      // accountInfo() only reads the SDK's cached initialization response. The rate-limit event
      // is subscription-only; the cache supplies independent evidence of the login and backend.
      const account = await q.accountInfo();
      verified = account?.apiProvider === 'firstParty' && !!account.subscriptionType?.trim()
        && (account.apiKeySource === undefined || account.apiKeySource === 'none');
    } catch {
      // Missing or unreadable provenance must not affect the turn or be published.
    }
    const observation = this.observation;
    if (observation?.query !== q) return;
    observation.account = verified ? 'verified' : 'refused';
    if (!verified) observation.windows.clear();
  }
}
