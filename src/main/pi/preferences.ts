/** Curated Pi settings.json preference and subagents.json normalization and sanitization. */
import type { PiPreferences, PiSubagentsSettings } from '../../shared/types';

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const TRANSPORTS = new Set(['auto', 'sse', 'websocket', 'websocket-cached']);
const TRUST_LEVELS = new Set(['ask', 'always', 'never']);

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

export function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

export function object(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The curated subset of global settings, read defensively: a hand-edited value is ignored, not echoed. */
export function readPreferences(settings: Record<string, unknown>): PiPreferences {
  const compaction = object(settings.compaction);
  const retry = object(settings.retry);
  const level = str(settings.defaultThinkingLevel);
  const transport = str(settings.transport);
  const trust = str(settings.defaultProjectTrust);
  return {
    ...(level && THINKING_LEVELS.has(level) ? { defaultThinkingLevel: level } : {}),
    ...(transport && TRANSPORTS.has(transport) ? { transport } : {}),
    showCacheMissNotices: bool(settings.showCacheMissNotices),
    ...(trust && TRUST_LEVELS.has(trust) ? { defaultProjectTrust: trust } : {}),
    httpProxy: str(settings.httpProxy),
    enableSkillCommands: bool(settings.enableSkillCommands),
    compactionEnabled: bool(compaction.enabled),
    compactionReserveTokens: positiveInt(compaction.reserveTokens),
    compactionKeepRecentTokens: positiveInt(compaction.keepRecentTokens),
    retryEnabled: bool(retry.enabled),
    retryMaxRetries: retry.maxRetries === 0 ? 0 : positiveInt(retry.maxRetries),
    retryBaseDelayMs: positiveInt(retry.baseDelayMs)
  };
}

export type FlatKey = keyof PiPreferences;

/** Nested target for each flat preference; delete removes the key so pi's default returns. */
export const PREFERENCE_PATHS: Record<FlatKey, string[]> = {
  defaultThinkingLevel: ['defaultThinkingLevel'],
  transport: ['transport'],
  showCacheMissNotices: ['showCacheMissNotices'],
  defaultProjectTrust: ['defaultProjectTrust'],
  httpProxy: ['httpProxy'],
  enableSkillCommands: ['enableSkillCommands'],
  compactionEnabled: ['compaction', 'enabled'],
  compactionReserveTokens: ['compaction', 'reserveTokens'],
  compactionKeepRecentTokens: ['compaction', 'keepRecentTokens'],
  retryEnabled: ['retry', 'enabled'],
  retryMaxRetries: ['retry', 'maxRetries'],
  retryBaseDelayMs: ['retry', 'baseDelayMs']
};

/** Rejects a hand-edited or stale value at the boundary rather than writing something pi ignores. */
export function normalizePreference(key: FlatKey, value: unknown): string | number | boolean {
  const reject = (): never => {
    throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`);
  };
  switch (key) {
    case 'defaultThinkingLevel':
      return typeof value === 'string' && THINKING_LEVELS.has(value) ? value : reject();
    case 'transport':
      return typeof value === 'string' && TRANSPORTS.has(value) ? value : reject();
    case 'defaultProjectTrust':
      return typeof value === 'string' && TRUST_LEVELS.has(value) ? value : reject();
    case 'httpProxy': {
      if (typeof value !== 'string' || value.length > 500) return reject();
      return value.trim();
    }
    case 'showCacheMissNotices':
    case 'enableSkillCommands':
    case 'compactionEnabled':
    case 'retryEnabled':
      return typeof value === 'boolean' ? value : reject();
    case 'compactionReserveTokens':
    case 'compactionKeepRecentTokens':
      return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 1_000_000 ? value : reject();
    case 'retryMaxRetries':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10 ? value : reject();
    case 'retryBaseDelayMs':
      return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 60_000 ? value : reject();
  }
}

export function setNested(target: Record<string, unknown>, keys: string[], value: unknown): void {
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const child = node[key];
    const next: Record<string, unknown> = child && typeof child === 'object' && !Array.isArray(child) ? { ...(child as Record<string, unknown>) } : {};
    node[key] = next;
    node = next;
  }
  node[keys[keys.length - 1]] = value;
}

export function deleteNested(target: Record<string, unknown>, keys: string[]): void {
  const parents: Record<string, unknown>[] = [];
  let node: Record<string, unknown> | undefined = target;
  for (const key of keys.slice(0, -1)) {
    parents.push(node);
    node = object(node[key]);
  }
  if (!node) return;
  delete node[keys[keys.length - 1]];
  for (let i = parents.length - 1; i >= 0; i--) {
    const parent = parents[i];
    const key = keys[i];
    if (Object.keys(object(parent[key])).length === 0) delete parent[key];
  }
}

/** Bounds mirror pi-subagents' own sanitize() so a stale value cannot survive here either. */
const SUBAGENT_LIMITS: Partial<Record<keyof PiSubagentsSettings, [number, number]>> = {
  maxConcurrent: [1, 1024],
  maxConcurrentForeground: [0, 1024],
  defaultMaxTurns: [0, 10_000],
  maxSubagentDepth: [0, 16]
};
const SUBAGENT_BOOL_KEYS: (keyof PiSubagentsSettings)[] = ['reportUsage', 'showCost', 'showModel', 'backgroundByDefault', 'worktreeIsolation', 'rememberAgents', 'strictAgentFiles', 'disableDefaultAgents'];
export const SUBAGENT_KEYS = new Set<string>([...SUBAGENT_BOOL_KEYS, ...Object.keys(SUBAGENT_LIMITS), 'fallbackSubagent']);

/** Rejects a patch value pi-subagents would silently drop, rather than writing it. */
export function normalizeSubagentValue(key: string, value: unknown): boolean | number | string {
  if (SUBAGENT_BOOL_KEYS.includes(key as keyof PiSubagentsSettings)) {
    if (typeof value !== 'boolean') throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`);
    return value;
  }
  const limits = SUBAGENT_LIMITS[key as keyof PiSubagentsSettings];
  if (limits) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < limits[0] || value > limits[1]) throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`);
    return value;
  }
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`);
  return value.trim();
}

/** Keeps only well-formed curated keys, the way pi-subagents' own sanitize() does. */
export function sanitizeSubagents(raw: unknown): PiSubagentsSettings {
  const r = object(raw);
  const out: Record<string, unknown> = {};
  for (const key of SUBAGENT_BOOL_KEYS) if (typeof r[key] === 'boolean') out[key] = r[key];
  for (const [key, [min, max]] of Object.entries(SUBAGENT_LIMITS) as [string, [number, number]][]) {
    const v = r[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) out[key] = v;
  }
  const fallback = str(r.fallbackSubagent);
  if (fallback) out.fallbackSubagent = fallback;
  return out as PiSubagentsSettings;
}
