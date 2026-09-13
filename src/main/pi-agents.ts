/**
 * Vocs Code overrides for pi-subagents' built-in agents. No Electron imports.
 *
 * pi-subagents pins its built-in `Explore` agent to `anthropic/claude-haiku-4-5`, which pi
 * resolves to whichever provider serves that model — often OpenRouter, billed to the user's
 * OpenRouter key even when the session runs a different model. A custom agent file fully
 * replaces the built-in (pi-subagents merges no fields), so this is a drop-in replacement that
 * keeps Explore's read-only tools and prompt but omits `model:`, letting the child inherit the
 * model selected in the session.
 *
 * Installed once in pi's global agent dir, which every project and worktree shares — and never
 * where a user's own file already exists. Earlier versions also wrote a project copy into
 * `<cwd>/.pi/agents`; because a worktree session's cwd is the worktree, that left an untracked
 * `.pi/` folder in every worktree for no benefit, so the project copy is gone. The exact copy
 * Vocs wrote before is removed on the next pi session; a project-authored file is left alone and
 * still outranks the global override through pi-subagents' own precedence.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PI_EXPLORE_AGENT_FILE = 'Explore.md';
/** Proves a file is Vocs-managed. A YAML comment, so pi's frontmatter parser ignores it. */
export const PI_MANAGED_MARKER = 'Managed by Vocs Code';

function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.USERPROFILE ?? env.HOME ?? os.homedir();
}

function expandTilde(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/** pi's global agent dir, honoring PI_CODING_AGENT_DIR the way pi itself does. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home = homeDir(env)): string {
  const envDir = env.PI_CODING_AGENT_DIR?.trim();
  return envDir ? expandTilde(envDir, home) : path.join(home, '.pi', 'agent');
}

/**
 * The Explore override. Reproduces pi-subagents' built-in agent minus the `model:` pin; omitting
 * a field means its default (`extensions`/`skills` inherit, `prompt_mode` replace), so only the
 * model differs from the built-in.
 */
export function exploreOverrideMarkdown(): string {
  return `---
# ${PI_MANAGED_MARKER} — subagents inherit the model selected in the session.
# Edit or delete this file to change the Explore agent's model for this project.
name: Explore
description: 'Fast read-only search agent for locating code. Use it to find files by pattern (eg. "src/components/**/*.tsx"), grep for symbols or keywords (eg. "API endpoints"), or answer "where is X defined / which files reference Y." Do NOT use it for code review, design-doc auditing, cross-file consistency checks, or open-ended analysis — it reads excerpts rather than whole files and will miss content past its read window. When calling, specify search breadth: "quick" for a single targeted lookup, "medium" for moderate exploration, or "very thorough" to search across multiple locations and naming conventions.'
tools: read, bash, grep, find, ls
prompt_mode: replace
---
# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
- Make independent tool calls in parallel for efficiency
- Adapt search approach based on thoroughness level specified

# Output
- Use absolute file paths in all references
- Report findings as regular messages
- Do not use emojis
- Be thorough and precise
`;
}

export interface AgentOverrideInstall {
  path: string;
  /** False when a file (of any origin) already existed and was left untouched. */
  written: boolean;
  skipped: 'exists' | null;
}

/** Write an agent file unless one already exists. Never overwrites a user's file. */export async function installAgentOverride(destDir: string, filename: string, content: string): Promise<AgentOverrideInstall> {
  const file = path.join(destDir, filename);
  try {
    await fs.access(file);
    return { path: file, written: false, skipped: 'exists' };
  } catch {
    /* absent — install */
  }
  await fs.mkdir(destDir, { recursive: true });
  await fs.writeFile(file, content, 'utf8');
  return { path: file, written: true, skipped: null };
}

export interface InstallOverridesOptions {
  /** Session cwd — only used to drop the project copy earlier versions installed here. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  log?: (level: 'info' | 'warn', message: string) => void;
}

/**
 * Removes the project-scoped Explore file Vocs installed before installs became global-only. Only
 * a byte-for-byte match to what we generate is deleted; an edited or project-authored file stays.
 * Empty `.pi/agents` and `.pi` directories are cleaned up, anything else in them is left intact.
 */
export async function removeInstalledProjectOverride(cwd: string): Promise<boolean> {
  const file = path.join(cwd, '.pi', 'agents', PI_EXPLORE_AGENT_FILE);
  let current: string;
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    return false;
  }
  const normalize = (s: string) => s.replace(/\r\n/g, '\n');
  if (normalize(current) !== normalize(exploreOverrideMarkdown())) return false;
  await fs.rm(file, { force: true });
  await fs.rmdir(path.dirname(file)).catch(() => undefined);
  await fs.rmdir(path.join(cwd, '.pi')).catch(() => undefined);
  return true;
}

/**
 * Merge `reportUsage: true` into pi-subagents' global settings so each run's spend is folded into
 * `getSessionStats()` instead of living only in its own session. An explicit boolean the user
 * already set is respected; a malformed file is left alone rather than clobbered. Returns true when
 * the file was written. The project `subagents.json` is deliberately not touched — it is often
 * tracked, and rewriting it would show up as a repo change.
 */
export async function installPiSubagentsReportUsage(agentDir: string): Promise<boolean> {
  const file = path.join(agentDir, 'subagents.json');
  let raw: string | null = null;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    raw = null;
  }
  let settings: Record<string, unknown> = {};
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false; // pi-subagents warns about this itself; do not destroy the content
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    settings = parsed as Record<string, unknown>;
    if (typeof settings.reportUsage === 'boolean') return false; // the user chose
  }
  settings.reportUsage = true;
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return true;
}

/**
 * Install the Explore override in pi's global agent dir. Failures are logged, never thrown: a
 * read-only or locked config dir must not stop the harness from starting. Returns the global
 * install, or null when it could not be written.
 */
export async function installPiAgentOverrides(opts: InstallOverridesOptions): Promise<AgentOverrideInstall | null> {
  const log = opts.log ?? (() => {});
  const env = opts.env ?? process.env;
  const agentDir = piAgentDir(env, opts.home);
  const agentsDir = path.join(agentDir, 'agents');
  let installed: AgentOverrideInstall | null = null;
  try {
    installed = await installAgentOverride(agentsDir, PI_EXPLORE_AGENT_FILE, exploreOverrideMarkdown());
    if (installed.written) log('info', `installed pi subagent override: ${installed.path}`);
  } catch (e) {
    log('warn', `could not install pi subagent override in ${agentsDir}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Only once the global override is confirmed on disk: dropping the project copy without it would
  // fall back to pi-subagents' pinned model, the exact regression this override exists to fix.
  if (installed) {
    try {
      if (await removeInstalledProjectOverride(opts.cwd)) log('info', `removed legacy project pi subagent override: ${path.join(opts.cwd, '.pi', 'agents', PI_EXPLORE_AGENT_FILE)}`);
    } catch (e) {
      log('warn', `could not remove legacy project pi subagent override: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    if (await installPiSubagentsReportUsage(agentDir)) log('info', 'enabled pi subagent usage reporting');
  } catch (e) {
    log('warn', `could not enable pi subagent usage reporting: ${e instanceof Error ? e.message : String(e)}`);
  }
  return installed;
}
