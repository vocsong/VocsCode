/** Persisted settings, with the built-in provider and ACP agent presets and their normalization. */
import path from 'node:path';
import type { AcpAgentPreset, AppSettings, ProviderConfig } from '../shared/types';
import { pruneModelOverrides } from '../shared/model-overrides';
import { DEFAULT_TERMINAL_SETTINGS } from '../shared/terminal';
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
    defaultModelByHarness: {},
    notifications: true,
    soundOnApproval: false,
    binaries: {},
    claude: { runtime: 'auto', useProviderKey: false, settingSources: ['user', 'project', 'local'] },
    codex: { runtime: 'auto' },
    pi: { extraArgs: [] },
    acpAgents: BUILTIN_ACP_AGENTS.map((a) => ({ ...a })),
    providers: BUILTIN_PROVIDERS.map((p) => ({ ...p, models: [] })),
    modelOverrides: {},
    sidebarWidth: 280,
    panelWidth: 420,
    recentProjects: [],
    goalDefaults: { autoContinue: true, maxIterations: 25 },
    terminal: { ...DEFAULT_TERMINAL_SETTINGS, customShellArgs: [] }
  };
}

/** Merge stored settings over defaults, keeping builtin providers/agents present. */
export function normalizeSettings(stored: Partial<AppSettings> | undefined): AppSettings {
  const d = defaultSettings();
  if (!stored) return d;
  const merged: AppSettings = {
    ...d,
    ...stored,
    binaries: { ...d.binaries, ...(stored.binaries ?? {}) },
    claude: { ...d.claude, ...(stored.claude ?? {}) },
    codex: { ...d.codex, ...(stored.codex ?? {}) },
    pi: { ...d.pi, ...(stored.pi ?? {}) },
    goalDefaults: { ...d.goalDefaults, ...(stored.goalDefaults ?? {}) },
    terminal: { ...d.terminal, ...(stored.terminal ?? {}), customShellArgs: Array.isArray(stored.terminal?.customShellArgs) ? stored.terminal.customShellArgs.filter((a) => typeof a === 'string') : [] },
    defaultModelByHarness: { ...(stored.defaultModelByHarness ?? {}) },
    modelOverrides: pruneModelOverrides(stored.modelOverrides),
    providers: [],
    acpAgents: []
  };
  const storedProviders = stored.providers ?? [];
  for (const bp of BUILTIN_PROVIDERS) {
    const s = storedProviders.find((p) => p.id === bp.id);
    merged.providers.push(s ? { ...bp, ...s, builtin: true } : { ...bp, models: [] });
  }
  for (const s of storedProviders) if (!BUILTIN_PROVIDERS.some((bp) => bp.id === s.id)) merged.providers.push({ ...s, builtin: false });
  const storedAgents = stored.acpAgents ?? [];
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
