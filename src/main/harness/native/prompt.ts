import { promises as fs } from 'node:fs';
import path from 'node:path';
import { detectShell } from './tools';

export async function buildSystemPrompt(cwd: string, opts: { planMode: boolean; append?: string; model: string }): Promise<string> {
  const shell = detectShell();
  const parts: string[] = [];
  parts.push(`You are an expert software engineering agent running inside Vocs-Desk, a desktop coding assistant. You work autonomously in the user's project by calling tools. Model: ${opts.model}.`);
  parts.push(`Working directory: ${cwd}\nOperating system: ${process.platform} (${process.arch})\nShell used by the bash tool: ${shell.name}\nDate: ${new Date().toISOString().slice(0, 10)}`);
  parts.push(
    [
      'Guidelines:',
      '- Investigate before changing: read relevant files and search the codebase; do not guess at APIs or file contents.',
      '- Make focused, minimal changes that solve the request; keep the existing style and conventions.',
      '- Prefer edit_file for small changes and write_file for new files. Never truncate files you rewrite.',
      '- Use bash for builds, tests, git and package managers. Check results and fix failures you introduced.',
      '- Paths are relative to the working directory unless absolute.',
      '- When the task is complete, summarize what changed and how you verified it. Mention anything left undone.',
      '- Ask a short clarifying question only when the request is genuinely ambiguous and a wrong guess would be costly.'
    ].join('\n')
  );
  if (opts.planMode) {
    parts.push('PLAN MODE is active: you must not modify files or run commands that change state. Explore with read-only tools and produce a concrete, numbered implementation plan for the user to approve.');
  }
  const context = await loadContextFiles(cwd);
  if (context) parts.push(context);
  if (opts.append) parts.push(opts.append);
  return parts.join('\n\n');
}

async function loadContextFiles(cwd: string): Promise<string> {
  const candidates = ['AGENTS.md', 'CLAUDE.md', '.vocs-desk/INSTRUCTIONS.md'];
  const out: string[] = [];
  for (const name of candidates) {
    try {
      const text = await fs.readFile(path.join(cwd, name), 'utf8');
      if (text.trim()) out.push(`# Project instructions from ${name}\n\n${text.slice(0, 16_000)}`);
    } catch {
      /* not present */
    }
  }
  return out.join('\n\n');
}
