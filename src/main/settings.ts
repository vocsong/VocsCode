/** Persisted settings, with the built-in provider and ACP agent presets and their normalization. */
import path from 'node:path';
import type { AcpAgentPreset, AppSettings, FolderStyle, HarnessId, McpProjectState, McpServerDef, McpTransport, ModelRef, ProviderConfig } from '../shared/types';
import { isAutoCompactionThreshold } from '../shared/compaction';
import { HARNESSES } from '../shared/harness-meta';
import { pruneModelOverrides } from '../shared/model-overrides';
import { normalizeCustomShortcuts } from '../shared/shortcuts';
import { DEFAULT_TERMINAL_SETTINGS } from '../shared/terminal';
import { isThemeId } from '../shared/themes';
import { isValidServerId } from './mcp/file';
import { readJson, writeJson } from './util/fs';

export const BUILTIN_ACP_AGENTS: AcpAgentPreset[] = [
  {
    id: 'dsh',
    name: 'DeepSeek Harness (dsh)',
    description: 'DeepSeek\'s open-source harness in its ACP profile. Needs DEEPSEEK_API_KEY or dsh credentials.',
    command: 'dsh',
    args: ['--profile', 'acp'],
    builtin: true
  },
  {
    id: 'dsh-npx',
    name: 'DeepSeek Harness via npx',
    description: 'Runs @deepseek-ai/dsh through npx (slower start, no global install needed).',
    command: 'npx',
    args: ['-y', '@deepseek-ai/dsh', '--profile', 'acp'],
    builtin: true
  },
  {
    id: 'claude-agent-acp',
    name: 'Claude Agent (ACP)',
    description: 'Claude Agent SDK exposed over ACP (@agentclientprotocol/claude-agent-acp).',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    builtin: true
  },
  {
    id: 'codex-acp',
    name: 'Codex (ACP)',
    description: 'Codex exposed over ACP (@zed-industries/codex-acp).',
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp'],
    builtin: true
  },
  {
    id: 'pi-acp',
    name: 'Pi (ACP)',
    description: 'Pi coding agent exposed over ACP (pi-acp).',
    command: 'npx',
    args: ['-y', 'pi-acp'],
    builtin: true
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI in ACP mode (requires gemini on PATH).',
    command: 'gemini',
    args: ['--experimental-acp'],
    builtin: true
  }
];

export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: 'anthropic',
    kind: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    hasApiKey: false,
    envKey: 'ANTHROPIC_API_KEY',
    models: [],
    builtin: true,
    enabled: true
  },
  {
    id: 'openai',
    kind: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    hasApiKey: false,
    envKey: 'OPENAI_API_KEY',
    models: [],
    builtin: true,
    enabled: true
  },
  {
    id: 'cursor',
    kind: 'cursor',
    name: 'Cursor',
    hasApiKey: false,
    envKey: 'CURSOR_API_KEY',
    models: [],
    builtin: true,
    enabled: false
  },
  {
    id: 'deepseek',
    kind: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    hasApiKey: false,
    envKey: 'DEEPSEEK_API_KEY',
    models: [],
    builtin: true,
    enabled: true
  },
  {
    id: 'openrouter',
    kind: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    hasApiKey: false,
    envKey: 'OPENROUTER_API_KEY',
    models: [],
    builtin: true,
    enabled: true
  },
  {
    id: 'ollama',
    kind: 'ollama',
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    hasApiKey: false,
    models: [],
    builtin: true,
    enabled: true
  },
  {
    id: 'lmstudio',
    kind: 'lmstudio',
    name: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    hasApiKey: false,
    models: [],
    builtin: true,
    enabled: false
  },
  {
    id: 'groq',
    kind: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    hasApiKey: false,
    envKey: 'GROQ_API_KEY',
    models: [],
    builtin: true,
    enabled: false
  },
  {
    id: 'xai',
    kind: 'xai',
    name: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    hasApiKey: false,
    envKey: 'XAI_API_KEY',
    models: [],
    builtin: true,
    enabled: false
  },
  {
    id: 'mistral',
    kind: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    hasApiKey: false,
    envKey: 'MISTRAL_API_KEY',
    models: [],
    builtin: true,
    enabled: false
  },
  {
    id: 'gemini',
    kind: 'gemini-openai',
    name: 'Google Gemini (OpenAI-compatible)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    hasApiKey: false,
    envKey: 'GEMINI_API_KEY',
    models: [],
    builtin: true,
    enabled: false
  }
];

export function defaultSettings(): AppSettings {
  return {
    version: 1,
    theme: 'system',
    defaultHarness: 'claude',
    defaultPermissionMode: 'ask',
    defaultEffort: undefined,
    autoCompactionThreshold: undefined,
    defaultUseWorktree: false,
    defaultModelByHarness: {},
    favoriteModels: [],
    notifications: true,
    soundOnApproval: false,
    binaries: {},
    claude: { runtime: 'auto', useProviderKey: false, settingSources: ['user', 'project', 'local'] },
    codex: { runtime: 'auto' },
    pi: { extraArgs: [] },
    acpAgents: BUILTIN_ACP_AGENTS.map((a) => ({ ...a })),
    mcpServers: [],
    mcpProjectState: {},
    providers: BUILTIN_PROVIDERS.map((p) => ({ ...p, models: [] })),
    modelOverrides: {},
    sidebarWidth: 280,
    panelWidth: 420,
    recentProjects: [],
    folders: [],
    folderStyles: {},
    customLabels: [],
    folderOrder: [],
    collapsedFolders: [],
    customShortcuts: {},
    goalDefaults: { autoContinue: true, maxIterations: 25 },
    terminal: { ...DEFAULT_TERMINAL_SETTINGS, customShellArgs: [] }
  };
}

/** Keep only well-formed folder style entries (hex colors, sane icon names). */
function normalizeFolderStyles(stored: unknown): Record<string, FolderStyle> {
  if (!stored || typeof stored !== 'object') return {};
  const out: Record<string, FolderStyle> = {};
  for (const [root, raw] of Object.entries(stored as Record<string, unknown>)) {
    if (!root || !raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const color = typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : undefined;
    const icon = typeof s.icon === 'string' && /^[a-z][a-z-]{0,23}$/.test(s.icon) ? s.icon : undefined;
    if (color || icon) out[root] = { ...(color ? { color } : {}), ...(icon ? { icon } : {}) };
  }
  return out;
}

/** Keep only well-formed custom status labels (trimmed, non-empty, deduped, capped). */
function normalizeCustomLabels(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  const out: string[] = [];
  for (const raw of stored) {
    if (typeof raw !== 'string') continue;
    const label = raw.trim().slice(0, 24);
    if (label && !out.some((l) => l.toLowerCase() === label.toLowerCase())) out.push(label);
    if (out.length >= 30) break;
  }
  return out;
}

/** Keep only well-formed MCP server definitions; a malformed entry must not reach a harness. */
export function normalizeMcpServers(stored: unknown): McpServerDef[] {
  if (!Array.isArray(stored)) return [];
  const out: McpServerDef[] = [];
  for (const raw of stored) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    if (!isValidServerId(id) || out.some((x) => x.id === id)) continue;
    const transport: McpTransport = s.transport === 'http' || s.transport === 'sse' ? s.transport : 'stdio';
    const def: McpServerDef = { id, transport };
    if (transport === 'stdio') {
      if (typeof s.command !== 'string' || !s.command.trim()) continue;
      def.command = s.command;
      if (Array.isArray(s.args)) def.args = s.args.filter((a): a is string => typeof a === 'string');
      def.env = strMap(s.env);
    } else {
      if (typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url)) continue;
      def.url = s.url;
      def.headers = strMap(s.headers);
    }
    if (Array.isArray(s.harnesses)) {
      const ids = s.harnesses.filter((h): h is HarnessId => typeof h === 'string' && HARNESSES.some((d) => d.id === h));
      if (ids.length) def.harnesses = ids;
    }
    if (typeof s.timeoutMs === 'number' && s.timeoutMs > 0) def.timeoutMs = Math.round(s.timeoutMs);
    if (typeof s.description === 'string' && s.description.trim()) def.description = s.description.trim();
    if (s.disabled === true) def.disabled = true;
    out.push(def);
  }
  return out;
}

function strMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (k.trim() && typeof val === 'string') out[k] = val;
  return Object.keys(out).length ? out : undefined;
}

/** Per-repo MCP switches: string id lists, keyed by absolute project root. */
export function normalizeMcpProjectState(stored: unknown): Record<string, McpProjectState> {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x))] : []);
  const out: Record<string, McpProjectState> = {};
  for (const [root, raw] of Object.entries(stored as Record<string, unknown>)) {
    if (!root || !raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const disabledGlobal = ids(s.disabledGlobal);
    const enabledRepo = ids(s.enabledRepo);
    if (disabledGlobal.length || enabledRepo.length) {
      out[root] = { ...(disabledGlobal.length ? { disabledGlobal } : {}), ...(enabledRepo.length ? { enabledRepo } : {}) };
    }
  }
  return out;
}

/** Merge stored settings over defaults, keeping builtin providers/agents present. */
export function normalizeSettings(stored: Partial<AppSettings> | undefined): AppSettings {
  const d = defaultSettings();
  if (!stored) return d;
  const merged: AppSettings = {
    ...d,
    ...stored,
    // A theme removed from the catalogue (or hand-edited into settings.json) falls back to 'system'.
    theme: isThemeId(stored.theme) ? stored.theme : d.theme,
    autoCompactionThreshold: isAutoCompactionThreshold(stored.autoCompactionThreshold) ? stored.autoCompactionThreshold : undefined,
    binaries: { ...d.binaries, ...(stored.binaries ?? {}) },
    claude: { ...d.claude, ...(stored.claude ?? {}) },
    codex: { ...d.codex, ...(stored.codex ?? {}) },
    pi: { ...d.pi, ...(stored.pi ?? {}) },
    goalDefaults: { ...d.goalDefaults, ...(stored.goalDefaults ?? {}) },
    terminal: { ...d.terminal, ...(stored.terminal ?? {}), customShellArgs: Array.isArray(stored.terminal?.customShellArgs) ? stored.terminal.customShellArgs.filter((a) => typeof a === 'string') : [] },
    defaultModelByHarness: { ...(stored.defaultModelByHarness ?? {}) },
    folders: Array.isArray(stored.folders) ? stored.folders.filter((p): p is string => typeof p === 'string' && p.length > 0) : [],
    folderOrder: Array.isArray(stored.folderOrder) ? stored.folderOrder.filter((p): p is string => typeof p === 'string' && p.length > 0) : [],
    collapsedFolders: Array.isArray(stored.collapsedFolders) ? stored.collapsedFolders.filter((p): p is string => typeof p === 'string' && p.length > 0) : [],
    folderStyles: normalizeFolderStyles(stored.folderStyles),
    customLabels: normalizeCustomLabels(stored.customLabels),
    customShortcuts: normalizeCustomShortcuts(stored.customShortcuts),
    favoriteModels: Array.isArray(stored.favoriteModels)
      ? stored.favoriteModels.filter((m): m is ModelRef => !!m && typeof m.provider === 'string' && typeof m.model === 'string')
      : [],
    utilityModel:
      stored.utilityModel && typeof stored.utilityModel.provider === 'string' && typeof stored.utilityModel.model === 'string'
        ? { provider: stored.utilityModel.provider, model: stored.utilityModel.model }
        : undefined,
    modelOverrides: pruneModelOverrides(stored.modelOverrides),
    mcpServers: normalizeMcpServers(stored.mcpServers),
    mcpProjectState: normalizeMcpProjectState(stored.mcpProjectState),
    providers: [],
    acpAgents: []
  };
  // Wrong-shaped arrays in settings.json must not break boot: coerce to arrays before use.
  const storedProviders = Array.isArray(stored.providers) ? stored.providers : [];
  for (const bp of BUILTIN_PROVIDERS) {
    const s = storedProviders.find((p) => p.id === bp.id);
    merged.providers.push(s ? { ...bp, ...s, builtin: true } : { ...bp, models: [] });
  }
  for (const s of storedProviders) if (!BUILTIN_PROVIDERS.some((bp) => bp.id === s.id)) merged.providers.push({ ...s, builtin: false });
  const storedAgents = Array.isArray(stored.acpAgents) ? stored.acpAgents : [];
  for (const ba of BUILTIN_ACP_AGENTS) {
    const s = storedAgents.find((a) => a.id === ba.id);
    merged.acpAgents.push(s ? { ...ba, ...s, builtin: true } : { ...ba });
  }
  for (const s of storedAgents) if (!BUILTIN_ACP_AGENTS.some((ba) => ba.id === s.id)) merged.acpAgents.push({ ...s, builtin: false });
  return merged;
}

export class SettingsStore {
  private settings: AppSettings = defaultSettings();
  private readonly file: string;
  private listeners = new Set<(s: AppSettings) => void>();

  constructor(userData: string) {
    this.file = path.join(userData, 'settings.json');
  }

  async load(): Promise<AppSettings> {
    const stored = await readJson<Partial<AppSettings> | undefined>(this.file, undefined);
    this.settings = normalizeSettings(stored);
    return this.settings;
  }

  get(): AppSettings {
    return this.settings;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    await writeJson(this.file, this.settings);
    for (const l of this.listeners) l(this.settings);
    return this.settings;
  }

  onChange(l: (s: AppSettings) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
