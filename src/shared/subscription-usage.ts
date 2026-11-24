/** Provider-account quota, not session spend or evidence of how a session was billed. */
export const SUBSCRIPTION_PROVIDERS = ['codex', 'claude', 'antigravity', 'cursor'] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

/** Only these providers expose an account read suitable for the desktop dashboard. */
export const INLINE_SUBSCRIPTION_PROVIDERS = ['codex'] as const satisfies readonly SubscriptionProvider[];
export type InlineSubscriptionProvider = (typeof INLINE_SUBSCRIPTION_PROVIDERS)[number];

export interface SubscriptionLimitGroup {
  name: string;
  buckets: { name: string; remainingFraction: number; resetAt?: string }[];
}

export interface SubscriptionLimits {
  groups: SubscriptionLimitGroup[];
}

/** A window reported during a normal turn. Times are epoch milliseconds except the reset ISO string. */
export interface ObservedSubscriptionWindow {
  name: string;
  remainingFraction: number;
  resetAt?: string;
  observedAt: number;
  expiresAt: number;
}

export interface OpenSubscriptionUsageResult {
  kind: 'browser' | 'terminal';
}
