import type { ModelInfo } from '../../../shared/types';

/** USD / million tokens. Explicit published Fast rates, never a guessed universal multiplier.
 * https://developers.openai.com/api/docs/pricing
 * https://platform.claude.com/docs/en/about-claude/pricing#fast-mode-pricing
 * Native Anthropic cache writes use the default five-minute TTL.
 */
export function fastModePricing(model: string, inputTokens: number): ModelInfo['pricing'] | undefined {
  const id = model.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
  if (id === 'claude-opus-5-5' || id === 'claude-opus-5.5') return { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 };
  if (id === 'claude-opus-5' || id === 'claude-opus-4-8') return { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
  const rates: Record<string, [number, number, number, number?]> = {
    'gpt-6-astra': [20, 2, 100, 25],
    'gpt-6.1-sol': [4, 0.2, 20, 5],
    'gpt-6-luna': [0.2, 0.02, 1, 0.25],
    'gpt-6-sol': [4, 0.4, 20, 5],
    'gpt-5.6-sol': [8, 0.8, 40, 10],
    'gpt-5.6-terra': [4, 0.4, 24, 5],
    'gpt-5.6-luna': [0.4, 0.04, 2.4, 0.5],
    'gpt-5.5': [12.5, 1.25, 75],
    'gpt-5.4': [5, 0.5, 30],
    'gpt-5.4-mini': [1.5, 0.15, 9],
    'gpt-5.3-codex': [3.5, 0.35, 28],
    'gpt-5.2': [3.5, 0.35, 28],
    'gpt-5.1': [2.5, 0.25, 20],
    'gpt-5': [2.5, 0.25, 20],
    'gpt-5-mini': [0.45, 0.045, 3.6]
  };
  const rate = rates[id];
  if (!rate) return undefined;
  const long = inputTokens > 272_000;
  // Only GPT-6 and GPT-5.6 publish long-context Fast rates in this table.
  if (long && !/^gpt-(?:6|5\.6)/.test(id)) return undefined;
  return { input: rate[0] * (long ? 2 : 1), cacheRead: rate[1] * (long ? 2 : 1), output: rate[2] * (long ? 1.5 : 1), ...(rate[3] !== undefined ? { cacheWrite: rate[3] * (long ? 2 : 1) } : {}) };
}
