import type { HarnessDescriptor, HarnessId, PermissionMode } from './types';

export const HARNESSES: HarnessDescriptor[] = [
  {
    id: 'claude',
    name: 'Claude Agent SDK',
    tagline: 'Claude Code harness, embedded',
    vendor: 'Anthropic',
    description:
      'Runs the Claude Code agent loop through @anthropic-ai/claude-agent-sdk with the full built-in tool set, hooks, MCP, and file checkpointing. Uses your Claude Code login (system CLI) or an Anthropic API key.',
    docsUrl: 'https://code.claude.com/docs/en/agent-sdk/typescript',
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
      permissionModes: ['plan', 'auto', 'full-auto'],
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
      permissionModes: ['plan', 'auto', 'full-auto'],
      modelSource: 'harness'
    }
  },
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
      permissionModes: ['ask', 'accept-edits', 'plan', 'auto', 'full-auto'],
      modelSource: 'harness'
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
      permissionModes: ['ask', 'accept-edits', 'plan', 'auto', 'full-auto'],
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
    description: 'Approve commands and file changes before they run.'
  },
  'accept-edits': {
    label: 'Accept edits',
    short: 'Edits',
    description: 'File edits apply automatically; shell commands still ask.'
  },
  plan: {
    label: 'Plan mode',
    short: 'Plan',
    description: 'Read-only exploration and planning. No mutations.'
  },
  auto: {
    label: 'Auto',
    short: 'Auto',
    description: 'Run inside the harness sandbox; ask only on escalation or failure.'
  },
  'full-auto': {
    label: 'Full access',
    short: 'Full',
    description: 'No prompts, no sandbox. Use only in a disposable environment.'
  }
};

export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const SLASH_COMMANDS: { name: string; description: string; args?: string }[] = [
  { name: 'help', description: 'Show available commands and shortcuts' },
  { name: 'model', description: 'Switch model for this session', args: '<provider/model>' },
  { name: 'mode', description: 'Change permission mode', args: 'ask|accept-edits|plan|auto|full-auto' },
  { name: 'effort', description: 'Change reasoning effort', args: 'low|medium|high|xhigh|max' },
  {
    name: 'goal',
    description: 'Set, show, pause, resume, clear or complete the session goal',
    args: '[objective|status|pause|resume|clear|complete]'
  },
  { name: 'diff', description: 'Open the Changes panel' },
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
