/** Pi model catalog translation, effort mapping, command filtering, legacy subagent model resolution, and one-shot model discovery. */
import type { HarnessCommand } from '../../shared/harness-commands';
import { EFFORT_LEVELS } from '../../shared/harness-meta';
import { modelName } from '../../shared/model-names';
import type { EffortLevel, ModelInfo, ModelRef } from '../../shared/types';
import { LineSplitter, deferred, withTimeout } from '../util/async';
import { PROVIDER_ENV_KEYS } from './provider-env';
import { shutdownChild, spawnTool } from './spawn';

/** Env var names pi understands for each of our provider ids. */
export const PI_ENV_KEYS = PROVIDER_ENV_KEYS;

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  thinkingLevelMap?: Record<string, string | null>;
}

export function piModelToInfo(m: PiModel): ModelInfo {
  const efforts = piSupportedEfforts(m);
  return {
    id: m.id,
    provider: m.provider,
    displayName: m.name || m.id,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxTokens,
    supportsImages: (m.input ?? []).includes('image'),
    supportsReasoning: !!m.reasoning,
    supportedEfforts: efforts && efforts.length ? efforts : undefined,
    pricing: m.cost ? { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite } : undefined
  };
}

/**
 * Mirrors pi's own getSupportedThinkingLevels: a level is hidden only by an explicit `null`, a
 * missing standard level keeps the provider's default mapping, and the extended `xhigh`/`max`
 * levels need an explicit mapping. `off` is dropped — leaving effort unset already runs the model
 * default. Without a map we keep the full list; pi clamps anything the model cannot use.
 */
function piSupportedEfforts(m: PiModel): EffortLevel[] | undefined {
  const map = m.thinkingLevelMap;
  if (!m.reasoning || !map) return undefined;
  return EFFORT_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

export function piThinkingLevel(effort: EffortLevel | undefined): string | undefined {
  return effort;
}

/** Extension commands this app registers in Pi to drive it (fast mode, subagent control); never the user's to type. */
const PI_APP_COMMAND = /^vocs-(?:code|subagent)-/i;
const PI_COMMAND_KIND = { extension: 'extension', prompt: 'prompt', skill: 'skill' } as const;

/**
 * Pi's `get_commands` rows: extension commands, prompt templates and `skill:<name>` skills, each run
 * by sending `/name args` as a prompt. Pi's built-in TUI commands are not listed — in RPC mode they
 * are separate requests, which the app's own `/model`, `/compact`, `/rename` and `/export` drive.
 */
export function piHarnessCommands(raw: unknown): HarnessCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c): HarnessCommand[] => {
    if (!c || typeof c !== 'object') return [];
    const { name, description, source } = c as { name?: unknown; description?: unknown; source?: unknown };
    if (typeof name !== 'string' || PI_APP_COMMAND.test(name)) return [];
    const kind = typeof source === 'string' && source in PI_COMMAND_KIND ? PI_COMMAND_KIND[source as keyof typeof PI_COMMAND_KIND] : 'command';
    return [{ name, description: typeof description === 'string' ? description : undefined, kind }];
  });
}

/** Resolve a legacy name only when its best match identifies one provider/model, never by order. */
export function resolveSubagentModel(models: readonly ModelInfo[], name?: string): ModelRef | null {
  if (!name || !models.length) return null;
  const typed = name.trim();
  const unique = (matches: ModelInfo[]): ModelRef | null => {
    const refs = new Map(matches.map((m) => [modelName(m.provider, m.id), { provider: m.provider, model: m.id }]));
    return refs.size === 1 ? refs.values().next().value ?? null : null;
  };
  // Preserve explicit routes before normalization can merge distinct punctuation or providers.
  const qualified = models.filter((m) => modelName(m.provider, m.id) === typed);
  if (qualified.length) return unique(qualified);
  const norm = (s: string) => s.toLowerCase().replace(/^claude\s+/, '').replace(/[^a-z0-9]/g, '');
  const target = norm(typed);
  if (!target) return null;
  const exact = models.filter((m) => norm(m.displayName) === target || norm(m.id) === target || norm(modelName(m.provider, m.id)) === target);
  if (exact.length) return unique(exact);
  // An unresolved slashed route must not become a different provider through a fuzzy id match.
  if (typed.includes('/')) return null;
  return unique(models.filter((m) => {
    const display = norm(m.displayName);
    const id = norm(m.id);
    return (display && display.includes(target)) || (id && target.includes(id));
  }));
}

/** One-shot model listing: `pi --mode rpc --no-session` + get_available_models. */
export async function listPiModels(piPath: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<ModelInfo[]> {
  const child = spawnTool(piPath, ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills'], { env: { ...process.env, ...extraEnv } });
  const d = deferred<ModelInfo[]>();
  const splitter = new LineSplitter((line) => {
    try {
      const ev = JSON.parse(line) as { type: string; command?: string; success?: boolean; data?: { models: PiModel[] }; error?: string };
      if (ev.type === 'response' && ev.command === 'get_available_models') {
        if (ev.success && ev.data) d.resolve(ev.data.models.map(piModelToInfo));
        else d.reject(new Error(ev.error ?? 'get_available_models failed'));
      }
    } catch {
      /* ignore non-json */
    }
  });
  child.stdout?.on('data', (b: Buffer) => splitter.push(b));
  child.on('error', (e) => d.reject(e));
  // stdin is a separate EventEmitter; guard against EPIPE if pi exits before the write flushes.
  child.stdin?.on('error', (e) => d.reject(e));
  child.on('close', () => d.reject(new Error('pi exited before answering')));
  child.stdin?.write(JSON.stringify({ id: 'm1', type: 'get_available_models' }) + '\n');
  try {
    return await withTimeout(d.promise, 45_000, 'pi model list');
  } finally {
    await shutdownChild(child, 1000);
  }
}
