import type { EffortLevel, HarnessDescriptor, HarnessId, ModelInfo, PermissionMode } from './types';

export const HARNESSES: HarnessDescriptor[] = [
  {
    id: 'pi',
    name: 'Pi',
    tagline: 'Minimal, hackable, any provider',
    vendor: 'Mario Zechner / community',
    description:
      "Runs the pi coding agent in RPC mode. Model-agnostic through pi's provider registry (Anthropic, OpenAI, Codex OAuth, Google, DeepSeek, OpenRouter, Ollama, custom). Approvals are added by a bundled pi extension.",
    docsUrl: 'https://github.com/badlogic/pi-mono',
    capabilities: {
      streaming: true,
      approvals: true,
      steer: true,
      queue: true,
      interrupt: true,
      liveModelSwitch: true,
      effort: true,
      images: true,
      dropsUnsupportedImages: true,
      resume: true,
      fork: true,
      plan: true,
      costReporting: true,
      // `--append-system-prompt`, so the session's own prompt is never replaced.
      systemPrompt: true,
      // Injected through the bundled vocs-code-mcp extension, which registers each MCP tool with pi.
      mcp: 'inject',
      slashCommands: 'listed',
      permissionModes: ['ask', 'accept-edits', 'plan', 'auto', 'full-auto'],
      modelSource: 'harness'
    }
  },
  {
    id: 'claude',
    name: 'Claude Agent SDK',
    tagline: 'Claude Code harness, embedded',
    vendor: 'Anthropic',
    description:
      'Runs the Claude Code agent loop through @anthropic-ai/claude-agent-sdk with the full built-in tool set, hooks, MCP, and file checkpointing. Uses your Claude Code login (system CLI), an Anthropic API key, or the Anthropic-format catalog of a configured provider — OpenRouter and DeepSeek publish one, and any vendor can be added as an Anthropic-compatible provider.',
    docsUrl: 'https://code.claude.com/docs/en/agent-sdk/typescript',
    capabilities: {
      streaming: true,
      approvals: true,
      steer: true,
      queue: true,
      interrupt: true,
      liveModelSwitch: true,
      effort: true,
      // Claude Code's own scale: it has no `minimal`.
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      images: true,
      dropsUnsupportedImages: false,
      resume: true,
      fork: true,
      plan: true,
      costReporting: true,
      // The claude_code preset with `append`, so Claude Code's own prompt stays underneath.
      systemPrompt: true,
      mcp: 'inject',
      slashCommands: 'listed',
      permissionModes: ['ask', 'accept-edits', 'plan', 'auto', 'full-auto'],
      modelSource: 'harness'
    }
  },
  {
    id: 'codex',
    name: 'Codex (app-server)',
    tagline: 'Same engine as the Codex desktop app',
    vendor: 'OpenAI',
    description:
      'Drives the Codex CLI through its JSON-RPC app-server: interactive command and file-change approvals, steering, sandbox policies, reasoning effort, thread resume, and any OpenAI-compatible model provider configured for Codex.',
    docsUrl: 'https://developers.openai.com/codex',
    capabilities: {
      streaming: true,
      approvals: true,
      steer: true,
      queue: true,
      interrupt: true,
      liveModelSwitch: true,
      effort: true,
      images: true,
      dropsUnsupportedImages: false,
      resume: true,
      fork: true,
      plan: true,
      costReporting: false,
      // The app-server owns the thread's instructions; priming goes through the first message.
      systemPrompt: false,
      mcp: 'inject',
      // Codex's skills (`skills/list`); a picked `/name` goes out as `$name` (main/harness/codex-skills.ts).
      slashCommands: 'listed',
      permissionModes: ['ask', 'accept-edits', 'plan', 'auto', 'full-auto'],
      modelSource: 'harness'
    }
  },
  {
    id: 'codex-exec',
    name: 'Codex (exec SDK)',
    tagline: 'Non-interactive Codex runs',
    vendor: 'OpenAI',
    description:
      'Uses @openai/codex-sdk (codex exec). No interactive approvals: safety comes from the sandbox mode. Good for fire-and-forget tasks.',
    docsUrl: 'https://github.com/openai/codex/tree/main/sdk/typescript',
    capabilities: {
      streaming: true,
      approvals: false,
      steer: false,
      queue: true,
      interrupt: true,
      liveModelSwitch: false,
      effort: true,
      images: true,
      dropsUnsupportedImages: false,
      resume: true,
      fork: false,
      plan: false,
      costReporting: false,
      systemPrompt: false,
      mcp: 'inject',
      // Skills as for app-server, listed by a one-shot app-server and sent as `$name` text.
      slashCommands: 'listed',
      permissionModes: ['plan', 'auto', 'full-auto'],
      permissionModeNotes: { auto: 'Closest match: sandboxed by Codex. It cannot ask, so a dangerous command that stays inside the sandbox runs without asking.' },
      modelSource: 'harness'
    }
  },
  {
    id: 'cursor',
    name: 'Cursor',
    tagline: 'The Cursor agent, embedded',
    vendor: 'Cursor / Anysphere',
    description:
      "Runs the Cursor agent loop through @cursor/sdk on your Cursor plan. Codebase indexing, MCP, skills and rules all apply. No interactive approvals: safety comes from Cursor's sandbox and Plan mode (a read-only tool allowlist).",
    docsUrl: 'https://cursor.com/docs/api/sdk/typescript',
    capabilities: {
      streaming: true,
      approvals: false,
      steer: true,
      queue: true,
      interrupt: true,
      liveModelSwitch: true,
      effort: false,
      images: true,
      dropsUnsupportedImages: false,
      resume: true,
      fork: false,
      plan: true,
      costReporting: false,
      systemPrompt: false,
      mcp: 'inherit',
      // @cursor/sdk exposes no command or skill listing; the text is handed to Cursor unchanged.
      slashCommands: 'typed',
      permissionModes: ['plan', 'auto', 'full-auto'],
      permissionModeNotes: { auto: 'Closest match: sandboxed by Cursor. It cannot ask, so a dangerous command that stays inside the sandbox runs without asking.' },
      modelSource: 'harness'
    }
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    tagline: 'Gemini through your Google account',
    vendor: 'Google',
    description: 'Runs Google’s Antigravity CLI using its saved Google sign-in. Gemini models and reasoning options come from your account once the session starts.',
    docsUrl: 'https://antigravity.google/docs/cli/acp/',
    capabilities: {
      streaming: true,
      approvals: true,
      steer: false,
      queue: true,
      interrupt: true,
      liveModelSwitch: true,
      effort: true,
      images: true,
      dropsUnsupportedImages: false,
      resume: true,
      fork: false,
      plan: true,
      costReporting: false,
      systemPrompt: false,
      mcp: 'inject',
      slashCommands: 'listed',
      permissionModes: ['ask', 'accept-edits', 'plan', 'auto', 'full-auto'],
      modelSource: 'acp-config'
    }
  },
  {
    id: 'acp',
    name: 'ACP agent (DeepSeek Harness, ...)',
    tagline: 'Any Agent Client Protocol agent',
    vendor: 'DeepSeek / Zed ecosystem',
    description:
      "Speaks the Agent Client Protocol over stdio. Presets include DeepSeek Harness (dsh --profile acp), Claude Agent ACP, Codex ACP, Pi ACP, and Gemini CLI. Model and reasoning effort come from the agent's advertised config options.",
    docsUrl: 'https://agentclientprotocol.com',
    capabilities: {
      streaming: true,
      approvals: true,
      steer: false,
      queue: true,
      interrupt: true,
      liveModelSwitch: true,
      effort: true,
      images: true,
      dropsUnsupportedImages: false,
      resume: true,
      fork: false,
      plan: true,
      costReporting: false,
      systemPrompt: false,
      mcp: 'inject',
      slashCommands: 'listed',
      permissionModes: ['ask', 'accept-edits', 'plan', 'auto', 'full-auto'],
      permissionModeNotes: {
        ask: 'Closest match: Vocs Code only sees the tool calls the agent asks about.',
        'accept-edits': 'Closest match: Vocs Code only sees the tool calls the agent asks about.',
        auto: 'Closest match: Vocs Code only sees the tool calls the agent asks about.'
      },
      modelSource: 'acp-config'
    }
  },
  {
    id: 'native',
    name: 'Native loop',
    tagline: 'Built-in agent, bring any API key',
    vendor: 'Vocs Code',
    description:
      'A lightweight agent loop implemented in the app with bash, read, write, edit, glob and grep tools. Talks directly to Anthropic or any OpenAI-compatible endpoint (OpenAI, DeepSeek, OpenRouter, Ollama, LM Studio, Groq, xAI, Mistral, Gemini).',
    capabilities: {
      streaming: true,
      approvals: true,
      steer: true,
      queue: true,
      interrupt: true,
      liveModelSwitch: true,
      effort: true,
      images: true,
      dropsUnsupportedImages: false,
      resume: true,
      fork: true,
      plan: true,
      costReporting: true,
      // `buildSystemPrompt` takes an `append` string; the loop owns the prompt.
      systemPrompt: true,
      mcp: 'client',
      slashCommands: 'none',
      permissionModes: ['ask', 'accept-edits', 'plan', 'auto', 'full-auto'],
      modelSource: 'providers'
    }
  }
];

export const HARNESS_BY_ID: Record<HarnessId, HarnessDescriptor> = Object.fromEntries(
  HARNESSES.map((h) => [h.id, h])
) as Record<HarnessId, HarnessDescriptor>;

export const PERMISSION_MODE_LABELS: Record<PermissionMode, { label: string; short: string; description: string }> = {
  ask: {
    label: 'Ask before acting',
    short: 'Ask',
    description: 'Approve file changes, commands and MCP tools before they run.'
  },
  'accept-edits': {
    label: 'Accept edits',
    short: 'Edits',
    description: 'File edits in the project apply automatically; commands and MCP tools still ask.'
  },
  plan: {
    label: 'Plan mode',
    short: 'Plan',
    description: 'Read-only exploration and planning. Nothing is changed.'
  },
  auto: {
    label: 'Auto',
    short: 'Auto',
    description: 'Edits, commands and MCP tools run; dangerous commands and anything outside the project ask.'
  },
  'full-auto': {
    label: 'Full access',
    short: 'Full',
    description: 'Nothing asks. Use only in a disposable environment.'
  }
};

/** What a tier means on this harness: the tier's description, or the harness's note where it can only approximate it. */
export function permissionModeHint(harness: HarnessId, mode: PermissionMode): string {
  return HARNESS_BY_ID[harness].capabilities.permissionModeNotes?.[mode] ?? PERMISSION_MODE_LABELS[mode].description;
}

/** The Vocs Code permission tiers from most to least restrictive. */
export const PERMISSION_TIER_ORDER: readonly PermissionMode[] = ['plan', 'ask', 'accept-edits', 'auto', 'full-auto'];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_TIER_ORDER as readonly string[]).includes(value);
}

/**
 * The tier a harness actually runs for a requested one: the request itself when the harness offers
 * it, otherwise the closest offered tier that is stricter — never a looser one. Cursor and Codex
 * exec cannot ask, so Ask and Accept edits become Plan there rather than running unprompted.
 */
export function closestPermissionMode(harness: HarnessId, mode: PermissionMode): PermissionMode {
  const offered = HARNESS_BY_ID[harness].capabilities.permissionModes;
  if (offered.includes(mode)) return mode;
  for (let i = PERMISSION_TIER_ORDER.indexOf(mode) - 1; i >= 0; i--) {
    if (offered.includes(PERMISSION_TIER_ORDER[i])) return PERMISSION_TIER_ORDER[i];
  }
  return 'plan';
}

/** Throws unless the harness offers the tier; for explicit user or controller choices. */
export function assertPermissionModeOffered(harness: HarnessId, mode: unknown): asserts mode is PermissionMode {
  const descriptor = HARNESS_BY_ID[harness];
  if (!isPermissionMode(mode) || !descriptor.capabilities.permissionModes.includes(mode)) {
    const offered = descriptor.capabilities.permissionModes.map((m) => PERMISSION_MODE_LABELS[m].label).join(', ');
    throw new Error(`${descriptor.name} does not offer that permission mode. Choose one of: ${offered}.`);
  }
}

export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Harnesses advertise levels beyond ours (Codex has `ultra`/`persistent`); only known levels may enter the app's effort state. */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * The reasoning efforts to offer for a model: the levels it lists, none when it lists none (`[]`:
 * the model takes no effort, so the controls are disabled), and, while its support is unknown,
 * every level its harness takes.
 */
export function effortOptionsFor(harness: HarnessDescriptor, model: Pick<ModelInfo, 'supportedEfforts'> | undefined): readonly EffortLevel[] {
  return model?.supportedEfforts ?? harness.capabilities.effortLevels ?? EFFORT_LEVELS;
}

/**
 * Autocomplete keeps array order and Tab takes the first prefix match, so a new command goes after
 * every existing command it shares a prefix with: `/m` + Tab must stay `/model`.
 */
export const SLASH_COMMANDS: { name: string; description: string; args?: string }[] = [
  { name: 'help', description: 'Show available commands and shortcuts' },
  { name: 'housekeep', description: 'Review old sessions for safe batch archiving', args: '[days|sessions|settings]' },
  { name: 'doctor', description: 'Check harness runtimes, sign-in state and provider keys' },
  { name: 'model', description: 'Switch model for this session', args: '<provider/model>' },
  { name: 'mode', description: 'Change permission mode', args: 'ask|accept-edits|plan|auto|full-auto' },
  { name: 'effort', description: 'Change reasoning effort', args: 'low|medium|high|xhigh|max' },
  {
    name: 'goal',
    description: 'Set, show, pause, resume, clear or complete the session goal',
    args: '[objective|status|pause|resume|clear|complete]'
  },
  { name: 'diff', description: 'Open the Changes panel' },
  { name: 'mcp', description: 'Open the MCP panel for this repo' },
  { name: 'cost', description: 'Show token usage and cost for this session' },
  { name: 'compact', description: 'Ask the harness to compact its context (where supported)' },
  { name: 'clear', description: 'Clear the visible transcript (keeps harness state)' },
  { name: 'rename', description: 'Rename this session', args: '<title>' },
  { name: 'export', description: 'Export transcript as Markdown' },
  { name: 'open', description: 'Open the project in your editor or file manager', args: 'editor|folder|terminal' },
  { name: 'worktree', description: 'Show worktree information for this session' },
  { name: 'pr', description: 'Push this branch and open a GitHub PR into a base branch (needs gh)', args: '<branch>' },
  { name: 'merge', description: 'Merge the open PR for this branch (needs gh)', args: '<branch>' },
  { name: 'stop', description: 'Interrupt the current turn' }
];
