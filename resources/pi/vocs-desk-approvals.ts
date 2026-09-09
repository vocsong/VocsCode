/**
 * Vocs-Desk approvals extension for pi (loaded with `pi -e <this file>`).
 *
 * pi has no built-in permission prompts, so this extension gates mutating tools
 * (bash, edit, write) according to the Vocs-Desk permission mode and asks the
 * host through the RPC extension-UI channel. The `select` title carries a JSON
 * payload prefixed with VDESK_APPROVAL:: which the desktop app renders as an
 * approval card.
 *
 * Modes (VOCS_DESK_PERMISSION_MODE):
 *   ask          -> confirm bash/edit/write
 *   accept-edits -> confirm bash only
 *   plan         -> block bash/edit/write
 *   auto         -> confirm only dangerous shell commands
 *   full-auto    -> never ask
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
  ui: UiLike;
  hasUI?: boolean;
}

interface PiLike {
  on(event: string, handler: (event: ToolCallEventLike, ctx: CtxLike) => Promise<unknown> | unknown): void;
}

const MARKER = 'VDESK_APPROVAL::';
const MUTATING = new Set(['bash', 'edit', 'write']);
const EDITS = new Set(['edit', 'write']);

const DANGEROUS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\bgit\s+push\b.*(--force|-f)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bmkfs\b|\bdd\s+if=/i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bformat\s+[a-z]:/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\bnpm\s+publish\b|\bpnpm\s+publish\b/i,
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
  /\b(sudo|doas)\b/i
];

function readMode(): Mode {
  const m = (process.env.VOCS_DESK_PERMISSION_MODE ?? 'ask') as Mode;
  return ['ask', 'accept-edits', 'plan', 'auto', 'full-auto'].includes(m) ? m : 'ask';
}

export default function vocsDeskApprovals(pi: PiLike): void {
  let mode: Mode = readMode();
  const sessionAllowed = new Set<string>();

  // The host may push a mode change as a raw stdin line; pi reports unknown commands as
  // parse errors, so we also poll the environment file the host writes (best effort).
  const modeFile = process.env.VOCS_DESK_MODE_FILE;
  const refreshMode = async () => {
    if (!modeFile) return;
    try {
      const fs = await import('node:fs/promises');
      const txt = (await fs.readFile(modeFile, 'utf8')).trim() as Mode;
      if (['ask', 'accept-edits', 'plan', 'auto', 'full-auto'].includes(txt)) mode = txt;
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
      return { block: true, reason: 'Plan mode is active in Vocs-Desk: no file edits or shell commands. Describe the plan instead.' };
    }
    const command = typeof event.input?.command === 'string' ? (event.input.command as string) : undefined;
    if (mode === 'auto') {
      if (!(command && DANGEROUS.some((re) => re.test(command)))) return undefined;
    }
    if (mode === 'accept-edits' && EDITS.has(tool)) return undefined;
    if (sessionAllowed.has(tool)) return undefined;
    if (!ctx.ui || typeof ctx.ui.select !== 'function') return undefined;

    const summary = command ?? (typeof event.input?.path === 'string' ? (event.input.path as string) : '');
    const payload = JSON.stringify({ tool, input: trimInput(event.input), summary });
    const choice = await ctx.ui.select(MARKER + payload, ['Allow once', 'Allow for session', 'Deny']);
    if (choice === 'Allow once') return undefined;
    if (choice === 'Allow for session') {
      sessionAllowed.add(tool);
      return undefined;
    }
    return { block: true, reason: 'The user declined this action in Vocs-Desk.' };
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
