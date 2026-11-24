import { EVIDENCE_PROVIDERS } from './intelligence';

export const KNOWLEDGE_USAGE_SOURCES = [...EVIDENCE_PROVIDERS, 'passive'] as const;
export type KnowledgeUsageSource = (typeof KNOWLEDGE_USAGE_SOURCES)[number];
export const KNOWLEDGE_USAGE_LOOKUPS = [
  'intelligence_search', 'context_compile', 'memory_recall', 'intelligence_trace',
  'knowledge_search', 'knowledge_read', 'knowledge_related', 'session_history_search'
] as const;
export type KnowledgeUsageLookup = (typeof KNOWLEDGE_USAGE_LOOKUPS)[number];
export const KNOWLEDGE_USAGE_WINDOWS = [7, 30] as const;
export type KnowledgeUsageDays = (typeof KNOWLEDGE_USAGE_WINDOWS)[number];
export type KnowledgeUsageSurface = 'desktop' | 'agent';
export type KnowledgeUsageOutcome = 'hit' | 'empty' | 'failed';
export type KnowledgeUsageVote = 'helped' | 'not-helpful';

/** Histogram boundaries, not individually logged timings. */
export const KNOWLEDGE_USAGE_LATENCY_MS = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
export type KnowledgeUsageLatency = (typeof KNOWLEDGE_USAGE_LATENCY_MS)[number] | 'overflow' | null;

export interface KnowledgeUsageTotals {
  hit: number;
  empty: number;
  failed: number;
  helped: number;
  notHelpful: number;
  staleGraph: number;
  truncated: number;
  /** Number of lookups that returned each source, not number of rows. Sources can overlap. */
  sources: Partial<Record<KnowledgeUsageSource, number>>;
  p50: KnowledgeUsageLatency;
  p95: KnowledgeUsageLatency;
  /** Successful agent tool responses only. Bytes of local tool text, not provider input tokens. */
  meanResponseBytes: number | null;
}

/** A main-process-issued, short-lived feedback handle, never sent to MCP. */
export interface RecentKnowledgeLookup {
  receipt: string;
  lookup: KnowledgeUsageLookup;
  outcome: KnowledgeUsageOutcome;
  sources: KnowledgeUsageSource[];
  endedAt: number;
  vote?: KnowledgeUsageVote;
}

export interface KnowledgeUsageReport {
  enabled: boolean;
  days: KnowledgeUsageDays;
  desktop: KnowledgeUsageTotals;
  agent: KnowledgeUsageTotals;
  /** Last observed agent lookup for the selected session, during this app run only. */
  recentAgent?: RecentKnowledgeLookup;
}
