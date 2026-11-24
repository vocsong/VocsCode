import type { ContextPacket, IntelligenceEvidence } from '../../shared/intelligence';
import type { KnowledgeUsageSource } from '../../shared/knowledge-usage';
import type { KnowledgeUsageSample } from './usage';

export function usageForEvidence(items: readonly IntelligenceEvidence[]): KnowledgeUsageSample {
  const sources = new Set<KnowledgeUsageSource>();
  let staleGraph = false;
  for (const item of items) {
    sources.add(item.localLearning ? 'passive' : item.provider);
    if (item.provider === 'graph' && item.freshness === 'stale') staleGraph = true;
  }
  return { outcome: items.length ? 'hit' : 'empty', sources: [...sources], staleGraph };
}

export function usageForPacket(packet: ContextPacket): KnowledgeUsageSample {
  // The search in compile() is not a second lookup. Count only citations that fit in the final packet.
  return { ...usageForEvidence(packet.sections.flatMap((section) => section.items)), truncated: packet.truncated };
}

export function usageForCount(count: number, source: KnowledgeUsageSource): KnowledgeUsageSample {
  return count > 0 ? { outcome: 'hit', sources: [source] } : { outcome: 'empty' };
}
