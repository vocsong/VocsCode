/**
 * The project instruction files the app treats as canonical, and the one place that reads them.
 *
 * `AGENTS.md` is the cross-harness convention: pi, Codex, and the native loop all read it, and the
 * app asks users to keep their rules there. `CLAUDE.md` is Claude Code's own name for the same idea
 * (a repo that wants both often makes it `@AGENTS.md`), and `.vocs-code/INSTRUCTIONS.md` is the
 * app-scoped override. An engine that reads one of these itself must not be handed it a second time;
 * `claude.ts` decides which names it may add.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** In precedence order. */
export const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.vocs-code/INSTRUCTIONS.md'] as const;

/** Each file is capped so a huge instruction tree cannot crowd out the rest of a system prompt. */
export const PROJECT_INSTRUCTION_MAX_CHARS = 16_000;

/** The trimmed, capped body of one instruction file, or null when it is missing or blank. */
export async function readProjectInstruction(cwd: string, name: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(path.join(cwd, name), 'utf8')).trim();
    return text ? text.slice(0, PROJECT_INSTRUCTION_MAX_CHARS) : null;
  } catch {
    return null;
  }
}

/** Every named file that exists, as one labelled block; empty string when none do. */
export async function projectInstructionBlock(cwd: string, names: readonly string[] = PROJECT_INSTRUCTION_FILES): Promise<string> {
  const parts: string[] = [];
  for (const name of names) {
    const text = await readProjectInstruction(cwd, name);
    if (text) parts.push(`# Project instructions from ${name}\n\n${text}`);
  }
  return parts.join('\n\n');
}
