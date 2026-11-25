/** Tool classification, formatting, diff previews, and AskUserQuestion card handling for Claude Code. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PermissionMode as SdkPermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { FileChange, PermissionMode, TranscriptItem } from '../../shared/types';
import { truncate } from '../util/async';
import { makeFileChange } from '../util/file-changes';
import { questionAnswerWithNote } from './question-answers';
import type { HarnessContext } from './types';

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'TodoRead',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'ToolSearch',
  'AskUserQuestion',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'Skill'
]);

/**
 * Tools that steer the Claude session itself (questions, subagents, plan mode, background-task
 * control) rather than the project, the shell or the network. The PreToolUse gate leaves them to
 * Claude Code's own pipeline, which reaches canUseTool when it would ask: AskUserQuestion needs
 * canUseTool to collect its answers, and what a subagent does is gated call by call in its own run.
 */
export const SESSION_CONTROL_TOOLS = new Set(['AskUserQuestion', 'Agent', 'Task', 'TaskOutput', 'TaskStop', 'KillShell', 'BashOutput', 'EnterPlanMode']);

/** Claude Code's own delegation tools. A mission session delegates through its Builders instead. */
export const DELEGATION_TOOLS = ['Agent', 'Task'];

export function toSdkMode(mode: PermissionMode): SdkPermissionMode {
  switch (mode) {
    case 'ask':
      return 'default';
    case 'accept-edits':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'auto':
    case 'full-auto':
      // The app gate decides every call (PreToolUse, then canUseTool), so the CLI stays in its
      // prompting mode and is never handed `bypassPermissions`: Full access is the gate allowing
      // everything, which applies live and needs no `allowDangerouslySkipPermissions`.
      return 'default';
  }
}

export function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  const i = input as Record<string, unknown>;
  if (typeof i.command === 'string') return i.command;
  if (typeof i.file_path === 'string') return i.file_path as string;
  if (typeof i.path === 'string') return i.path as string;
  if (typeof i.pattern === 'string') return `${i.pattern}${typeof i.path === 'string' ? ` in ${i.path}` : ''}`;
  if (typeof i.url === 'string') return i.url as string;
  if (typeof i.query === 'string') return i.query as string;
  if (typeof i.description === 'string') return i.description as string;
  if (typeof i.prompt === 'string') return truncate(i.prompt as string, 200, '…');
  const s = JSON.stringify(i);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

export function toolHint(toolName: string): TranscriptItem extends infer _ ? 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'mcp' | 'agent' | 'other' : never {
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'execute';
  if (EDIT_TOOLS.has(toolName)) return 'edit';
  if (toolName === 'Read') return 'read';
  if (toolName === 'Glob' || toolName === 'Grep' || toolName === 'LS') return 'search';
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'fetch';
  if (toolName === 'Agent' || toolName === 'Task') return 'agent';
  if (toolName.startsWith('mcp__')) return 'mcp';
  return 'other';
}

export async function askClaudeUserQuestion(ctx: HarnessContext, input: Record<string, unknown>): Promise<PermissionResult> {
  const qs = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
  const decision = await ctx.requestApproval({
    kind: 'question',
    title: 'Claude has a question',
    toolName: 'AskUserQuestion',
    input,
    options: [
      { id: 'allow', label: 'Answer', kind: 'allow' },
      { id: 'deny', label: 'Skip', kind: 'deny' }
    ],
    questions: qs.map((q, i) => ({
      id: String(i),
      header: typeof q.header === 'string' ? q.header : undefined,
      question: String(q.question ?? ''),
      options: Array.isArray(q.options)
        ? (q.options as Record<string, unknown>[]).map((o) => ({ label: String(o.label ?? ''), description: typeof o.description === 'string' ? o.description : undefined }))
        : undefined,
      allowOther: true
    }))
  });
  if (decision.optionId !== 'allow') return { behavior: 'deny', message: decision.note?.trim() || 'The user skipped the question.' };
  const answers: Record<string, string> = {};
  qs.forEach((q, i) => {
    const a = questionAnswerWithNote(decision.answers?.[String(i)], decision.note);
    if (a !== undefined) answers[String(q.question ?? '')] = a;
  });
  return { behavior: 'allow', updatedInput: { ...input, answers } };
}

export async function previewClaudeChange(cwd: string, toolName: string, input: Record<string, unknown>): Promise<FileChange[] | undefined> {
  try {
    const file = String(input.file_path ?? input.path ?? '');
    if (!file) return undefined;
    const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
    let before: string | null = null;
    try {
      before = await fs.readFile(abs, 'utf8');
    } catch {
      before = null;
    }
    let after = before ?? '';
    if (toolName === 'Write') after = String(input.content ?? '');
    else if (toolName === 'Edit') {
      const oldS = String(input.old_string ?? '');
      const newS = String(input.new_string ?? '');
      after = input.replace_all ? (before ?? '').split(oldS).join(newS) : (before ?? '').replace(oldS, newS);
    } else if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
      for (const e of input.edits as Record<string, unknown>[]) {
        const oldS = String(e.old_string ?? '');
        const newS = String(e.new_string ?? '');
        after = e.replace_all ? after.split(oldS).join(newS) : after.replace(oldS, newS);
      }
    } else return undefined;
    return [makeFileChange(cwd, file, before, after, { newFileHeader: '(new file)' })];
  } catch {
    return undefined;
  }
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          const o = c as { type?: string; text?: string };
          if (o.type === 'text' && o.text) return o.text;
          if (o.type === 'image') return '[image]';
        }
        return '';
      })
      .join('\n');
  }
  return '';
}
