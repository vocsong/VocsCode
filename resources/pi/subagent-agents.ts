/**
 * Subagent type definitions for Vocs Code.
 *
 * Built-ins match Claude Code's three agents (`general-purpose`, `Explore`, `Plan`) so existing
 * `.claude/agents` and `.pi/agents` files keep working. Files override built-ins by name, in the
 * order: project `.pi/agents` → project `.claude/agents` → global `~/.pi/agent/agents` →
 * global `~/.claude/agents`. No pi SDK imports: this module is pure and unit-testable.
 */

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

export interface AgentModelRef {
  provider: string;
  model: string;
}

export type PromptMode = 'append' | 'replace';

/** Where a definition came from, so the UI can say who owns it. */
export type AgentOrigin = 'project' | 'branch' | 'claude' | 'global' | 'template';

export interface AgentType {
  name: string;
  description: string;
  /** Built-in tool names the child may use. `bash` is still permission-gated at run time. */
  tools: string[];
  prompt: string;
  promptMode: PromptMode;
  /** Pinned model. Absent means the child inherits the session model. */
  model?: AgentModelRef;
  /** Whether the child inherits the session's MCP servers. */
  mcp: boolean;
  /** Where it came from: a file path, or `template` for the shipped definitions. */
  source: string;
  origin: AgentOrigin;
}

/** Every built-in tool pi can hand a child session; `powershell` only exists on Windows. */
export const BUILTIN_TOOL_NAMES = ['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls'] as const;

const ALL_TOOLS = BUILTIN_TOOL_NAMES.filter((name) => name !== 'powershell' || process.platform === 'win32');
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls', 'bash'];

const GENERAL_PURPOSE_PROMPT = [
  'You are a general-purpose agent working on a delegated part of a larger task.',
  'Complete the task end to end, then report back.',
  '',
  '- Read the relevant code before changing anything; never guess at APIs or file contents.',
  '- Match the conventions of the surrounding code exactly (formatting, naming, error handling).',
  '- Keep the change as small as the task allows. Do not refactor adjacent code.',
  '- Verify your work with the narrowest relevant command and include the exact command and its result in your report.',
  '- Your final message is the return value handed back to the agent that delegated this task. Report outcomes, not process: what changed, what you verified, and anything you could not do.',
].join('\n');

const EXPLORE_PROMPT = [
  '# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS',
  'You are a file search specialist. You excel at thoroughly navigating and exploring codebases.',
  'Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.',
  '',
  'You are STRICTLY PROHIBITED from:',
  '- Creating new files',
  '- Modifying existing files',
  '- Deleting files',
  '- Moving or copying files',
  '- Creating temporary files anywhere, including /tmp',
  '- Using redirect operators (>, >>, |) or heredocs to write to files',
  '- Running ANY commands that change system state',
  '',
  'Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.',
  '',
  '# Tool Usage',
  '- Use the find tool for file pattern matching (NOT the bash find command)',
  '- Use the grep tool for content search (NOT bash grep/rg command)',
  '- Use the read tool for reading files (NOT bash cat/head/tail)',
  '- Use Bash ONLY for read-only operations',
  '- Make independent tool calls in parallel for efficiency',
  '- Adapt search approach based on thoroughness level specified',
  '',
  '# Output',
  '- Use absolute file paths in all references',
  '- Report findings as regular messages',
  '- Do not use emojis',
  '- Be thorough and precise',
].join('\n');

const PLAN_PROMPT = [
  'You are a software architect reviewing a problem and returning an implementation plan.',
  'You never modify the workspace: you read code and produce a plan.',
  '',
  '- Ground every step in code you actually read; cite file paths and what is there today.',
  '- Surface the real forks in the road (data model, interfaces, migration order) and recommend one option with reasons.',
  '- Include verification for each step: the exact command that proves it worked.',
  '- Call out what you could not determine and what would resolve it.',
  '',
  'Your final message IS the plan, returned to the agent that delegated this task. Be concrete and complete; do not pad it.',
].join('\n');

export const BUILTIN_AGENTS: AgentType[] = [
  {
    name: 'general-purpose',
    description:
      'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Use it when a task needs several rounds of tool use and the result matters more than the search trail.',
    tools: [...ALL_TOOLS],
    prompt: GENERAL_PURPOSE_PROMPT,
    promptMode: 'append',
    mcp: true,
    source: 'template',
    origin: 'template',
  },
  {
    name: 'Explore',
    description:
      'Fast read-only search agent for locating code. Use it to find files by pattern, grep for symbols or keywords, or answer "where is X defined / which files reference Y". Do NOT use it for code review, design-doc auditing, or open-ended analysis: it reads excerpts. Say whether you want a quick lookup, medium exploration, or a very thorough search.',
    tools: READ_ONLY_TOOLS,
    prompt: EXPLORE_PROMPT,
    promptMode: 'replace',
    mcp: false,
    source: 'template',
    origin: 'template',
  },
  {
    name: 'Plan',
    description:
      'Software architect agent for designing implementation plans. Use it when you need a step-by-step plan grounded in the real code before committing to an approach. It returns the plan; it does not write code.',
    tools: READ_ONLY_TOOLS,
    prompt: PLAN_PROMPT,
    promptMode: 'replace',
    mcp: false,
    source: 'template',
    origin: 'template',
  },
];

export function findAgent(agents: readonly AgentType[], name: string | undefined): AgentType | undefined {
  if (!name) return undefined;
  const wanted = name.trim().toLowerCase();
  return agents.find((agent) => agent.name.toLowerCase() === wanted);
}

/** The child system prompt: a replace-mode agent owns it, an append-mode agent extends the parent's. */
export function buildSystemPrompt(agent: AgentType, parentSystemPrompt: string): string {
  if (agent.promptMode === 'append' && parentSystemPrompt.trim()) {
    return `${parentSystemPrompt.trim()}\n\n# Your role\n${agent.prompt}`;
  }
  return agent.prompt;
}

/** Tool names an agent may use, filtered to what pi actually has on this platform. */
export function toolNamesFor(agent: AgentType): string[] {
  const known = new Set<string>(ALL_TOOLS);
  const names = agent.tools.filter((name) => known.has(name));
  return names.length ? names : ['read', 'grep', 'find', 'ls'];
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"');
  return v;
}

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * Minimal frontmatter reader for agent files: `key: value` lines between `---` markers, with `>`
 * and `|` block scalars and single/double quoted values. pi's own parser is richer; this reads
 * everything the documented agent-file fields use and ignores the rest rather than failing.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const fields: Record<string, string> = {};
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const firstLineEnd = normalized.indexOf('\n');
  if (firstLineEnd === -1 || normalized.slice(0, firstLineEnd).trim() !== '---') return { fields, body: normalized.trim() };
  const lines = normalized.split('\n');
  let index = 1;
  for (; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line.trim() === '---') break;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    const raw = line.slice(colon + 1).trim();
    if (raw === '>' || raw === '>-' || raw === '|' || raw === '|-') {
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] as string;
        if (next.trim() !== '' && !/^\s/.test(next)) break;
        block.push(next.replace(/^\s{1,}/, ''));
        index++;
      }
      fields[key] = (raw.startsWith('|') ? block.join('\n') : block.join(' ')).trim();
      continue;
    }
    fields[key] = unquote(raw);
  }
  const body = lines.slice(index + 1).join('\n').trim();
  return { fields, body };
}

function parseModel(value: string | undefined): AgentModelRef | undefined {
  if (!value) return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** Parse one agent file. Returns null when it has no usable name. */
export function parseAgentFile(text: string, file = '', origin: AgentOrigin = 'project'): AgentType | null {
  const { fields, body } = parseFrontmatter(text);
  const name = (fields.name ?? '').trim();
  if (!name) return null;
  const declared = (fields.tools ?? '').trim();
  const tools = !declared || declared === '*'
    ? [...ALL_TOOLS]
    : declared.split(',').map((t) => t.trim()).filter(Boolean);
  return {
    name,
    description: (fields.description ?? '').trim() || `${name} subagent`,
    tools,
    prompt: body || `You are the ${name} subagent.`,
    promptMode: fields.prompt_mode?.trim().toLowerCase() === 'replace' ? 'replace' : 'append',
    model: parseModel(fields.model?.trim()),
    mcp: fields.mcp?.trim().toLowerCase() !== 'false',
    source: file || 'file',
    origin,
  };
}

export interface DiscoverOptions {
  cwd: string;
  agentDir: string;
  /** The repo's main checkout. Its `.pi/agents` is the managed, project-level set. */
  projectRoot?: string;
  /** Folder holding the shipped templates (`<resources>/pi/agents`). */
  templateDir?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Project config directory name; pi rebrands use a different one. */
  configDirName?: string;
}

function expandTilde(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/** pi's global agent directory, honoring PI_CODING_AGENT_DIR the way pi itself does. */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env, home = env.USERPROFILE ?? env.HOME ?? os.homedir()): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  return fromEnv ? expandTilde(fromEnv, home) : path.join(home, '.pi', 'agent');
}

/** Concurrency caps for a session, derived from pi-subagents' global `subagents.json`. */
export interface SubagentLimits {
  /** Concurrent background runs allowed (pi-subagents' `maxConcurrent`). */
  background: number;
  /** Concurrent runs allowed in total — the same number the user configured. */
  session: number;
  /** Concurrent foreground runs allowed; `0` means no separate cap. */
  foreground: number;
}

/** Matches the shipped extension's long-standing caps when nothing is configured. */
export const DEFAULT_BACKGROUND_LIMIT = 4;
export const DEFAULT_SESSION_LIMIT = 8;
/** Mirror pi-subagents' own sanitize() bound so a stale value cannot survive here either. */
const MAX_LIMIT = 1024;

/**
 * The user's concurrency settings, read from `<agentDir>/subagents.json` on every spawn so a change
 * made in Settings takes effect without restarting the session. A missing, malformed or
 * out-of-range value falls back to the shipped defaults; the extension must never fail to spawn a
 * run because a settings file is unreadable.
 */
export async function readSubagentLimits(agentDir: string): Promise<SubagentLimits> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path.join(agentDir, 'subagents.json'), 'utf8'));
  } catch {
    raw = undefined;
  }
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : undefined;
  const maxConcurrent = count(settings.maxConcurrent);
  return {
    background: maxConcurrent ?? DEFAULT_BACKGROUND_LIMIT,
    session: maxConcurrent ?? DEFAULT_SESSION_LIMIT,
    foreground: count(settings.maxConcurrentForeground) ?? 0,
  };
}

async function readAgentDir(dir: string, origin: AgentOrigin): Promise<AgentType[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const agents: AgentType[] = [];
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    const file = path.join(dir, entry);
    try {
      const parsed = parseAgentFile(await fs.readFile(file, 'utf8'), file, origin);
      if (parsed) agents.push(parsed);
    } catch {
      /* unreadable file: skip it rather than failing the whole discovery */
    }
  }
  return agents;
}

/**
 * The definitions Vocs Code ships, read from `<resources>/pi/agents`. They are files so the app's
 * agent manager and the pi runtime cannot disagree about a template; if the folder is missing
 * (a stray copy of the extension) the prompts compiled into this module stand in for them.
 */
export async function loadTemplates(templateDir: string | undefined): Promise<AgentType[]> {
  if (!templateDir) return BUILTIN_AGENTS;
  const templates = await readAgentDir(templateDir, 'template');
  return templates.length ? templates : BUILTIN_AGENTS;
}

/**
 * Agent types available in a workspace. The project's managed set wins, then anything the branch
 * adds, then Claude Code's project files, then the user's global files, then the shipped templates.
 * The first definition of a name wins; a file replaces a template wholesale (no field merging).
 */
export async function discoverAgents(opts: DiscoverOptions): Promise<AgentType[]> {
  const home = opts.home ?? opts.env?.USERPROFILE ?? opts.env?.HOME ?? os.homedir();
  const configDirName = opts.configDirName ?? '.pi';
  const projectRoot = opts.projectRoot ?? opts.cwd;
  const dirs: { dir: string; origin: AgentOrigin }[] = [
    { dir: path.join(projectRoot, configDirName, 'agents'), origin: 'project' },
    { dir: path.join(projectRoot, '.claude', 'agents'), origin: 'claude' },
    { dir: path.join(opts.agentDir, 'agents'), origin: 'global' },
    { dir: path.join(home, '.claude', 'agents'), origin: 'global' },
  ];
  // A worktree session's own .pi/agents can add types the project set does not define (a branch that
  // commits agents), but it never overrides the managed set — that is what the manager edits.
  if (path.resolve(opts.cwd) !== path.resolve(projectRoot)) dirs.splice(1, 0, { dir: path.join(opts.cwd, configDirName, 'agents'), origin: 'branch' });
  const found = new Map<string, AgentType>();
  for (const { dir, origin } of dirs) {
    for (const agent of await readAgentDir(dir, origin)) {
      const key = agent.name.toLowerCase();
      if (!found.has(key)) found.set(key, agent); // first directory wins
    }
  }
  for (const agent of await loadTemplates(opts.templateDir)) {
    const key = agent.name.toLowerCase();
    if (!found.has(key)) found.set(key, agent);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
