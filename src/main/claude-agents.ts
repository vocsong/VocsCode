/**
 * The project's Claude Code agent definitions: reading them, setting the one field this app owns, and
 * creating a new one.
 *
 * Claude Code reads `<projectRoot>/.claude/agents/*.md`, and a definition whose `name:` matches a
 * built-in (`Explore`, `Plan`) *replaces* that built-in — the built-in's own instructions are gone,
 * verified against the bundled CLI. So creating a definition is deliberate about which kind it is:
 * a name no built-in and no existing file claims *adds* a type, and a built-in name is written only
 * when the caller passes `override` — the panel's Models view asks for that from a built-in's row,
 * after saying out loud that the built-in's instructions are replaced. Editing stays narrow either
 * way — the app rewrites a definition's `model:` line and leaves every other byte of a hand-written
 * file exactly as its author left it.
 *
 * The `model:` line is also what the adapter reads back: a project that pins a model anywhere cannot
 * be overridden wholesale by `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (the CLI lets FORCE outrank a
 * definition), so the harness withholds FORCE for as long as a pin exists.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isValidAgentName } from '../shared/agent-files';
import { CLAUDE_BUILTIN_AGENT_TYPES, parseClaudeAgentFile, serializeClaudeAgentFile, withClaudeAgentModel, type ClaudeAgentDraft, type ClaudeAgentFileInfo } from '../shared/claude-agent-files';

export const CLAUDE_AGENT_DIR = path.join('.claude', 'agents');

export function claudeAgentDir(projectRoot: string): string {
  return path.join(projectRoot, CLAUDE_AGENT_DIR);
}

/** `<dir>/<name>.md`, or null when the name could escape the folder or is not a safe file name. */
function claudeAgentFile(projectRoot: string, name: string): string | null {
  if (!isValidAgentName(name)) return null;
  const dir = claudeAgentDir(projectRoot);
  const file = path.join(dir, `${name}.md`);
  // Defence in depth: the name is already a safe file name, and the path must stay inside the folder.
  return path.dirname(path.resolve(file)) === path.resolve(dir) ? file : null;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** One definition file resolved to what the panel and the adapter need from it. */
interface ResolvedAgentFile extends ClaudeAgentFileInfo {
  text: string;
}

async function readAgentFiles(projectRoot: string): Promise<ResolvedAgentFile[]> {
  const dir = claudeAgentDir(projectRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return []; // no directory is the ordinary case: the project defines nothing
  }
  const files: ResolvedAgentFile[] = [];
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    const file = path.join(dir, entry);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseClaudeAgentFile(text);
    // A file with no frontmatter is not a definition; the CLI ignores it too, so the panel does.
    if (!parsed) continue;
    files.push({ ...parsed.fields, path: file, text });
  }
  return files;
}

/** Every Claude agent definition the project has, for the panel's rows. */
export async function listClaudeAgents(projectRoot: string): Promise<ClaudeAgentFileInfo[]> {
  return (await readAgentFiles(projectRoot)).map(({ text: _text, ...info }) => info);
}

/**
 * Whether the project pins a model for any agent. A pin is a concrete model id — `inherit` restates
 * the default and asks for nothing, so it does not count.
 */
export async function hasClaudeAgentPins(projectRoot: string): Promise<boolean> {
  return (await readAgentFiles(projectRoot)).some((info) => isPinnedModel(info.model));
}

export function isPinnedModel(model: string | undefined): boolean {
  const value = model?.trim();
  return Boolean(value) && value !== 'inherit';
}

/**
 * Create a definition. Adding a type is safe; taking one away is not, so the two ways writing a file
 * would replace something are refused unless they are exactly what was asked for.
 *
 * `reserved` is what the live engine reports as its own types; `CLAUDE_BUILTIN_AGENT_TYPES` covers
 * the built-ins an idle session cannot list, so the rule holds whether or not one is running. A
 * built-in name is written only with `override` — the definition then *replaces* that built-in,
 * instructions and all, which only the user who asked for the override may do.
 */
export async function createClaudeAgent(
  projectRoot: string,
  draft: ClaudeAgentDraft,
  reserved: string[] = [],
  options: { override?: boolean } = {}
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const name = draft.name.trim();
  if (!isValidAgentName(name)) return { ok: false, error: 'A definition needs a name of letters, digits, dot, dash or underscore.' };
  if (!draft.description.trim()) return { ok: false, error: 'A description is required: Claude Code picks a subagent by it.' };
  const file = claudeAgentFile(projectRoot, name);
  if (!file) return { ok: false, error: 'Invalid definition name.' };
  // A file the exact name already holds is the author's, even when it does not parse as a definition.
  if (await exists(file)) return { ok: false, error: `${path.basename(file)} already exists; edit it in the list instead.` };
  // The panel keys a row by the name in the file, so a differently-named file claiming this name —
  // in any casing — counts as the project already defining it.
  const existing = (await readAgentFiles(projectRoot)).find((info) => info.name.toLowerCase() === name.toLowerCase());
  if (existing) return { ok: false, error: `This project already defines ${existing.name}; edit it in the list instead.` };
  const reservedNames = [...CLAUDE_BUILTIN_AGENT_TYPES, ...reserved];
  const builtin = reservedNames.find((candidate) => candidate.trim().toLowerCase() === name.toLowerCase());
  if (builtin && !options.override) {
    return { ok: false, error: `${builtin} is one of Claude Code's built-in agent types: a definition named after it replaces it. Pick another name, or override it from its row.` };
  }
  try {
    await fs.mkdir(claudeAgentDir(projectRoot), { recursive: true });
    const fields = { name, description: draft.description.trim(), ...(draft.model?.trim() ? { model: draft.model.trim() } : {}) };
    await fs.writeFile(file, serializeClaudeAgentFile(fields, draft.prompt), 'utf8');
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Set (or with `undefined`, clear) the model one definition pins. Only an existing file is touched:
 * creating one would silently replace a built-in and take its instructions with it.
 */
export async function setClaudeAgentModel(projectRoot: string, name: string, model: string | undefined): Promise<{ ok: boolean; error?: string }> {
  if (!isValidAgentName(name)) return { ok: false, error: 'Invalid agent type.' };
  const file = (await readAgentFiles(projectRoot)).find((info) => info.name === name);
  if (!file) return { ok: false, error: `This project has no ${name} definition to change.` };
  const next = withClaudeAgentModel(file.text, model?.trim() || undefined);
  if (next === null) return { ok: false, error: `${name} has no frontmatter to edit.` };
  if (next === file.text) return { ok: true };
  try {
    await fs.writeFile(file.path, next, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
