import type { AutoCompactionThreshold, UsageTotals } from './types';

export const AUTO_COMPACTION_PRESETS: readonly { value: AutoCompactionThreshold; label: string }[] = [
  { value: '50%', label: '50% of context window' },
  { value: '75%', label: '75% of context window' },
  { value: '90%', label: '90% of context window' },
  { value: '100k', label: '100k tokens' },
  { value: '250k', label: '250k tokens' },
  { value: '500k', label: '500k tokens' },
  { value: '750k', label: '750k tokens' },
  { value: '1m', label: '1M tokens' }
];

const AUTO_COMPACTION_VALUES = new Set<string>(AUTO_COMPACTION_PRESETS.map((p) => p.value));
const ABSOLUTE_THRESHOLDS: Partial<Record<AutoCompactionThreshold, number>> = {
  '100k': 100_000,
  '250k': 250_000,
  '500k': 500_000,
  '750k': 750_000,
  '1m': 1_000_000
};

export function isAutoCompactionThreshold(value: unknown): value is AutoCompactionThreshold {
  return typeof value === 'string' && AUTO_COMPACTION_VALUES.has(value);
}

/** Token count represented by a preset, or undefined when percentage metadata is unavailable. */
export function autoCompactionTokenThreshold(
  threshold: AutoCompactionThreshold,
  usage: Pick<UsageTotals, 'contextWindow'>
): number | undefined {
  const absolute = ABSOLUTE_THRESHOLDS[threshold];
  if (absolute) return absolute;
  const contextWindow = usage.contextWindow;
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  return contextWindow * (Number.parseInt(threshold, 10) / 100);
}

/** True at the first reported safe boundary on or above the selected context threshold. */
export function hasReachedAutoCompactionThreshold(
  threshold: AutoCompactionThreshold,
  usage: Pick<UsageTotals, 'contextTokens' | 'contextWindow'>
): boolean {
  const used = usage.contextTokens;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return false;
  const limit = autoCompactionTokenThreshold(threshold, usage);
  return limit !== undefined && used >= limit;
}

export function autoCompactionThresholdLabel(threshold: AutoCompactionThreshold): string {
  return AUTO_COMPACTION_PRESETS.find((p) => p.value === threshold)?.label ?? threshold;
}
