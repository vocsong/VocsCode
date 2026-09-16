/**
 * The on-disk format of a Claude Code subagent definition — `<projectRoot>/.claude/agents/<Name>.md`.
 *
 * Claude Code's frontmatter is not pi's: it names its own tools (`Bash, Read`) and knows nothing of
 * pi's `prompt_mode` / `mcp` keys, so `src/shared/agent-files.ts` can neither read nor write it and
 * the two formats must not be run through the same serializer.
 *
 * A definition with the same name as a built-in (`Explore`, `Plan`) replaces that built-in, which is
 * the only way to pin the model one of them runs on: the built-ins declare `model: inherit`, and
 * `CLAUDE_CODE_SUBAGENT_MODEL` is read *after* frontmatter, so the environment variable cannot move
 * them. Editing stays narrow — the app sets a definition's `model` and leaves every other byte of a
 * hand-written file exactly as its author left it. It creates a definition for a name no existing
 * file claims, and it creates one for a built-in name only when the caller explicitly overrides it,
 * because that file takes the built-in's instructions with it.
 */

/**
 * Claude Code's own delegation targets. A project definition with one of these names does not extend
 * the built-in, it *replaces* it — instructions and all. The engine only lists its built-ins while a
 * session is live, so the create path needs the names here to refuse one either way.
 */
export const CLAUDE_BUILTIN_AGENT_TYPES = ['Explore', 'Plan', 'general-purpose'] as const;

/** Whether a name is a built-in type, and so must be authored by hand rather than by the app. */
export function isClaudeBuiltinAgentType(name: string): boolean {
  const wanted = name.trim().toLowerCase();
  return CLAUDE_BUILTIN_AGENT_TYPES.some((type) => type.toLowerCase() === wanted);
}

/** The fields the app writes for a definition it creates. */
export interface ClaudeAgentDraft {
  name: string;
  description: string;
  prompt: string;
  /** A model to pin; absent writes no `model:` line, so the definition inherits the session model. */
  model?: string;
}

/** The frontmatter keys this app reads. Anything else in the file is preserved verbatim on write. */
export interface ClaudeAgentFields {
  name: string;
  description: string;
  /** An alias (`sonnet`), a full model id, or `inherit`. Absent means the definition pins nothing. */
  model?: string;
}

export interface ParsedClaudeAgentFile {
  fields: ClaudeAgentFields;
  /** Everything after the closing `---`, with surrounding blank lines trimmed. */
  prompt: string;
}

/** One definition found in a project, as the Subagents panel lists it. */
export interface ClaudeAgentFileInfo {
  name: string;
  description: string;
  /** The model the definition pins; absent means it inherits, as `inherit` also does. */
  model?: string;
  path: string;
}

/** `---` … `---` opening the file, capturing the body and the newline style actually in use. */
const FRONTMATTER = /^(﻿?)---(\r?\n)([\s\S]*?)(\r?\n)---/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"');
  return v;
}

/** Quote a value only when the agent-file style requires it, so a written file reads like a hand one. */
function quote(value: string): string {
  if (!/[#:'"{}[\],&*?|<>=!%@`]/.test(value) && value.trim() === value && value !== '') return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Parse a definition. Tolerant by design, like the pi parser: unknown keys are ignored and a file
 * with no frontmatter is not a definition at all, so a hand-edited file still opens.
 */
export function parseClaudeAgentFile(text: string): ParsedClaudeAgentFile | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of (match[3] as string).split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key) fields[key] = unquote(line.slice(colon + 1));
  }
  const name = (fields.name ?? '').trim();
  if (!name) return null;
  return {
    fields: {
      name,
      description: (fields.description ?? '').trim(),
      ...(fields.model?.trim() ? { model: fields.model.trim() } : {})
    },
    prompt: text.slice(match.index + match[0].length).replace(/^[\r\n]+/, '').trim()
  };
}

/**
 * Render a new definition: the two frontmatter fields the app owns, then the body that is the
 * agent's system prompt. No `model:` line, so it inherits the session model until the panel pins one.
 */
export function serializeClaudeAgentFile(fields: ClaudeAgentFields, prompt: string): string {
  const lines = ['---', `name: ${quote(fields.name)}`, `description: ${quote(fields.description)}`];
  if (fields.model?.trim()) lines.push(`model: ${quote(fields.model.trim())}`);
  lines.push('---', '');
  const body = prompt.trim();
  return `${lines.join('\n')}${body ? `\n${body}\n` : '\n'}`;
}

/**
 * Set (or with `undefined`, remove) a definition's `model` and return the file unchanged otherwise.
 *
 * Line-surgical on purpose: a definition is the user's file, carrying comments, key order and a
 * prompt this app has no business rewriting. Returns null when the file has no frontmatter to edit.
 */
export function withClaudeAgentModel(text: string, model: string | undefined): string | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  const [opening, newline, body] = [match[1] as string, match[2] as string, match[3] as string];
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((line) => /^\s*model\s*:/.test(line));
  const replacement = model ? `model: ${quote(model)}` : undefined;

  if (replacement === undefined) {
    if (at === -1) return text;
    lines.splice(at, 1);
  } else if (at === -1) {
    lines.push(replacement);
  } else {
    lines[at] = replacement;
  }

  const rest = text.slice(match.index + match[0].length);
  return `${opening}---${newline}${lines.join(newline)}${newline}---${rest}`;
}
