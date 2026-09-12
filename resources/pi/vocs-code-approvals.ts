/**
 * Vocs Code approvals extension for pi (loaded with `pi -e <this file>`).
 *
 * pi has no built-in permission prompts, so this extension gates mutating tools
 * (bash, edit, write) according to the Vocs Code permission mode and asks the
 * host through the RPC extension-UI channel. The `select` title carries a JSON
 * payload prefixed with VCODE_APPROVAL:: which the desktop app renders as an
 * approval card.
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

type Mode = 'ask' | 'accept-edits' | 'plan' | 'auto' | 'full-auto';

interface ToolCallEventLike {
  type: 'tool_call';
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
}

interface UiLike {
  select(title: string, options: string[], opts?: Record<string, unknown>): Promise<string | undefined>;
  notify(message: string, type?: string): void;
}

interface CtxLike {
  ui?: UiLike;
  hasUI?: boolean;
  cwd?: string;
}

interface PiLike {
  on(event: string, handler: (event: ToolCallEventLike, ctx: CtxLike) => Promise<unknown> | unknown): void;
}

const MARKER = 'VCODE_APPROVAL::';
const MUTATING = new Set(['bash', 'edit', 'write']);
const EDITS = new Set(['edit', 'write']);
const MODES: Mode[] = ['ask', 'accept-edits', 'plan', 'auto', 'full-auto'];

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

function isDangerous(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}

function readModeFromEnv(): Mode {
  const m = (process.env.VOCS_CODE_PERMISSION_MODE ?? 'ask') as Mode;
  return MODES.includes(m) ? m : 'ask';
}

function isOutsideCwd(cwd: string | undefined, target: unknown): boolean {
  if (!cwd || typeof target !== 'string' || !target) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const isAbs = /^([a-z]:)?\//i.test(target.replace(/\\/g, '/'));
  if (!isAbs) return target.replace(/\\/g, '/').split('/').includes('..');
  const t = norm(target);
  const c = norm(cwd);
  return !(t === c || t.startsWith(c + '/'));
}

export default function vocsCodeApprovals(pi: PiLike): void {
  let mode: Mode = readModeFromEnv();
  const sessionAllowed = new Set<string>();
  const modeFile = process.env.VOCS_CODE_MODE_FILE;

  const refreshMode = async () => {
    if (!modeFile) return;
    try {
      const fs = await import('node:fs/promises');
      const txt = (await fs.readFile(modeFile, 'utf8')).trim() as Mode;
      if (MODES.includes(txt)) {
        if (txt !== mode) sessionAllowed.clear(); // grants do not survive a mode change
        mode = txt;
      }
    } catch {
      /* ignore */
    }
  };

  pi.on('tool_call', async (event, ctx) => {
    await refreshMode();
    const tool = event.toolName;
    if (!MUTATING.has(tool)) return undefined;
    if (mode === 'full-auto') return undefined;
    if (mode === 'plan') {
      return { block: true, reason: 'Plan mode is active in Vocs Code: no file edits or shell commands. Describe the plan instead.' };
    }
    const command = typeof event.input?.command === 'string' ? (event.input.command as string) : undefined;
    const dangerous = !!command && isDangerous(command);
    const outside = EDITS.has(tool) && isOutsideCwd(ctx.cwd ?? process.cwd(), event.input?.path);
    if (!dangerous && !outside) {
      if (mode === 'auto') return undefined;
      if (mode === 'accept-edits' && EDITS.has(tool)) return undefined;
      if (sessionAllowed.has(tool)) return undefined;
    }
    // No approval UI means we cannot ask: fail closed instead of letting a gated action run.
    if (!ctx.ui || typeof ctx.ui.select !== 'function') {
      return { block: true, reason: 'Vocs Code approval UI is unavailable; refusing to run this action.' };
    }

    const summary = command ?? (typeof event.input?.path === 'string' ? (event.input.path as string) : '');
    const payload = JSON.stringify({ tool, input: trimInput(event.input), summary: outside ? `${summary} (outside the project directory)` : summary });
    const choice = await ctx.ui.select(MARKER + payload, ['Allow once', 'Allow for session', 'Deny']);
    if (choice === 'Allow once') return undefined;
    if (choice === 'Allow for session') {
      sessionAllowed.add(tool);
      return undefined;
    }
    return { block: true, reason: 'The user declined this action in Vocs Code.' };
  });
}

function trimInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v === 'string' && v.length > 4000) out[k] = v.slice(0, 4000) + '…';
    else out[k] = v;
  }
  return out;
}
