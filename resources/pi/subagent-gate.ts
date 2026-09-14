/**
 * Shared permission gate for pi tool calls.
 *
 * Both the parent approvals extension (`vocs-code-approvals.ts`) and every subagent child session
 * (`vocs-code-subagents.ts`) decide through this module, so a rule can never be enforced on one
 * path and forgotten on the other. No pi SDK imports: the running Pi supplies all execution code
 * and this file stays loadable by jiti and testable in plain Node.
 *
 * Modes (VOCS_CODE_PERMISSION_MODE, re-read from VOCS_CODE_MODE_FILE before each call):
 *   ask          -> confirm bash/edit/write
 *   accept-edits -> confirm bash only (and edits outside the project)
 *   plan         -> block bash/edit/write
 *   auto         -> confirm only dangerous shell commands and edits outside the project
 *   full-auto    -> never ask
 *
 * A dangerous command always prompts below full access, even after "Allow for session".
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

export type Mode = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'full-auto';

export const MODES: Mode[] = ['ask', 'accept-edits', 'plan', 'auto', 'full-auto'];

/** The `select` title prefix the desktop app turns into an approval card. */
export const APPROVAL_MARKER = 'VCODE_APPROVAL::';
/** Structured RPC notification, never inferred from model-visible error prose. */
export const BLOCK_MARKER = 'VCODE_TOOL_BLOCKED::';
/** Shared event-bus channel: a user granted a tool for the session, apply it everywhere. */
export const GRANT_EVENT = 'vocs-code:approval-grant';
export const APPROVAL_OPTIONS = ['Allow once', 'Allow for session', 'Deny'] as const;
export type ApprovalChoice = (typeof APPROVAL_OPTIONS)[number];

export const MUTATING = new Set(['bash', 'powershell', 'edit', 'write']);
export const EDITS = new Set(['edit', 'write']);
/** Tools the MCP bridge extension registers. A server's tool can do anything, so it always asks
 * unless the mode is full-auto; unlike shell commands we have no way to classify it. */
export const MCP_PREFIX = 'mcp__';

// Best-effort detection of obviously destructive shell commands; not exhaustive.
// Verbatim copy of DANGEROUS_COMMAND_PATTERNS in src/main/harness/types.ts — keep the two in sync.
export const DANGEROUS: RegExp[] = [
  // rm: recursive + force flags in any arrangement, including shell-quoted flags
  /\brm\s+(?=(?:(?:"[^"]*"|'[^']*'|-\S+)\s+)*(?:"-[a-z]*r[a-z]*"|'-[a-z]*r[a-z]*'|"--recursive"|'--recursive'|-[a-z]*r[a-z]*\b|--recursive\b))(?=(?:(?:"[^"]*"|'[^']*'|-\S+)\s+)*(?:"-[a-z]*f[a-z]*"|'-[a-z]*f[a-z]*'|"--force"|'--force'|-[a-z]*f[a-z]*\b|--force\b))/i,
  /\brm\s+(?:(?:-\S+|"-{1,2}[a-zA-Z-]+"|'-{1,2}[a-zA-Z-]+')\s+)*(?:"-[a-z]*r[a-z]*"|'-[a-z]*r[a-z]*'|"--recursive"|'--recursive'|-[a-z]*r[a-z]*\b)(?:\s+-\S+|\s+"-{1,2}[a-zA-Z-]+"|\s+'-{1,2}[a-zA-Z-]+')*\s+["']?[\/~]/i,
  // dd reading from or writing to a device node
  /\bmkfs\b|\bdd\s+(?:\S+\s+)*(?:if|of)=\/dev\//i,
  // chmod 777 with a recursive flag, in any order
  /\bchmod\s+(?=(?:\S+\s+)*(?:-[a-z]*r[a-z]*\b|--recursive\b))(?=(?:\S+\s+)*777)/i,
  // git force-push: --force, --force-with-lease, -f or a +-prefixed refspec, allowing global git options before push
  /\bgit(?:\s+-{1,2}\S+(?:\s+"[^"]*"|\s+\S+)?)*\s+push\b(?=\s)[^|;&]*?(?:--force(?:-with-lease)?\b|\s-f\b|\s\+\S)/i,
  /\bgit\s+reset\s+--hard\b/i,
  // any -f-containing flag cluster in any position
  /\bgit\s+clean\s+(?:-\S+\s+)*-[a-z]*f/i,
  /\bgit\s+checkout\s+--\s+\./i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bformat(?:\.com)?\s+[a-z]:/i,
  // Windows del/rd/rmdir with recursive-quiet flags in any order
  /\bdel\s+(?:\/[a-z]+\s+)*\/[sq]/i,
  /\b(?:rd|rmdir)\s+(?:\/[a-z]+\s+)*\/s/i,
  // Remove-Item and its aliases with a recurse flag
  /\b(?:remove-item|ri)\s+(?:\S+\s+)*(?:-recurse\b|-[a-z]*r\b)/i,
  /\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b/i,
  // Downloaded or decoded payloads piped directly into a shell
  /\b(?:curl|wget|base64)\b[^|;&\r\n]*\|\s*(?:ba)?sh\b/i,
  // PowerShell's download-and-evaluate aliases, including its pipeline form
  /\b(?:iex|invoke-expression)\s*(?:\(\s*)?(?:iwr|invoke-webrequest|irm|invoke-restmethod)\b/i,
  /\b(?:iwr|invoke-webrequest|irm|invoke-restmethod|curl|wget)\b[^|;&\r\n]*\|\s*(?:iex|invoke-expression)\b/i,
  /\b(?:sudo|doas|pkexec)\b/i,
  /(?:^|[|;&]\s*)\bsu(?:\s+(?!--?(?:help|version|h)\b)\S+|\s*$)/i,
  // arbitrary encoded payloads
  /\b(?:powershell|pwsh)(?:\.exe)?\s+(?:\S+\s+)*(?:-encodedcommand\b|-enc\b|-e\b)/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/
];

export const PLAN_REASON = 'Plan mode is active in Vocs Code: no file edits or shell commands. Describe the plan instead.';
export const DECLINED_REASON = 'The user declined this action in Vocs Code.';

export function isDangerous(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}

export function parseMode(text: string | undefined): Mode {
  const m = (text ?? '').trim() as Mode;
  return MODES.includes(m) ? m : 'ask';
}

export function readModeFromEnv(env: NodeJS.ProcessEnv = process.env): Mode {
  return parseMode(env.VOCS_CODE_PERMISSION_MODE);
}

/**
 * Re-read the live mode from the host's mode file. Any read failure means `ask`: the safe default
 * is the strictest interactive mode, never a silently permissive one.
 */
export async function readModeFile(file: string | undefined): Promise<Mode> {
  if (!file) return readModeFromEnv();
  try {
    return parseMode(await fs.readFile(file, 'utf8'));
  } catch {
    return 'ask';
  }
}

export async function isOutsideCwd(cwd: string | undefined, target: unknown): Promise<boolean> {
  if (!cwd || typeof target !== 'string' || !target) return true;
  // Pi expands these spellings itself. Require approval rather than checking a
  // different, unexpanded Node path (including drive paths emitted by Git Bash).
  if (/^(?:@|~|file:\/\/)/.test(target) || /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(target) ||
      (process.platform === 'win32' && /^\/(?:mnt\/|cygdrive\/)?[a-z](?:\/|$)/i.test(target))) return true;
  const inside = (root: string, file: string) => {
    const rel = path.relative(root, file);
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };
  const absolute = path.resolve(cwd, target);
  if (!inside(path.resolve(cwd), absolute)) return true;
  try {
    const root = await fs.realpath(cwd);
    // New files inherit the nearest existing parent's real location. A junction
    // inside the workspace may point outside it, even when the suffix is new.
    let parent = absolute;
    while (true) {
      try {
        return !inside(root, await fs.realpath(parent));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
        // A dangling link is not a nonexistent, safe child directory.
        const entry = await fs.lstat(parent).catch(() => undefined);
        if (entry) return true;
        const next = path.dirname(parent);
        if (next === parent) return true;
        parent = next;
      }
    }
  } catch {
    return true;
  }
}

export interface GateInput {
  tool: string;
  input: Record<string, unknown>;
  cwd: string | undefined;
  mode: Mode;
  /** Tools the user already granted for this session ("Allow for session"). */
  sessionAllowed: ReadonlySet<string>;
  /**
   * MCP tools the app itself marked read-only (its memory server). A server the app does not own
   * can never appear here, so a third-party tool still asks below full access.
   */
  readOnlyMcp?: ReadonlySet<string>;
}

export type GateDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'ask'; summary: string; outside: boolean; dangerous: boolean };

/**
 * The single decision function. `ask` means the caller must obtain explicit approval and may only
 * execute on `Allow once` / `Allow for session`; it must never be treated as a default allow.
 */
export async function decideToolCall({ tool, input, cwd, mode, sessionAllowed, readOnlyMcp }: GateInput): Promise<GateDecision> {
  const isMcp = tool.startsWith(MCP_PREFIX);
  if (!MUTATING.has(tool) && !isMcp) return { action: 'allow' };
  // The app's own read-only memory tools are reads: they run unprompted and survive plan mode.
  if (isMcp && readOnlyMcp?.has(tool)) return { action: 'allow' };
  if (mode === 'full-auto') return { action: 'allow' };
  if (mode === 'plan') return { action: 'block', reason: PLAN_REASON };
  const command = typeof input?.command === 'string' ? (input.command as string) : undefined;
  const dangerous = !!command && isDangerous(command);
  const outside = EDITS.has(tool) && (await isOutsideCwd(cwd, input?.path));
  if (!dangerous && !outside) {
    // auto never classifies an MCP tool as safe; it always asks below full access.
    if (mode === 'auto' && !isMcp) return { action: 'allow' };
    if (mode === 'accept-edits' && EDITS.has(tool)) return { action: 'allow' };
    if (sessionAllowed.has(tool)) return { action: 'allow' };
  }
  const target = command ?? (typeof input?.path === 'string' ? (input.path as string) : '');
  return { action: 'ask', summary: outside ? `${target} (outside the project directory)` : target, outside, dangerous };
}

/** Input echoed into the approval card; large strings are clipped so a payload stays renderable. */
export function trimInput(input: Record<string, unknown>, limit = 4000): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v === 'string' && v.length > limit) out[k] = v.slice(0, limit) + '…';
    else out[k] = v;
  }
  return out;
}
