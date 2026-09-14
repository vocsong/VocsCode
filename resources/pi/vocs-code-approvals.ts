/**
 * Vocs Code approvals extension for pi (loaded with `pi -e <this file>`).
 *
 * pi has no built-in permission prompts, so this extension gates mutating tools
 * (bash, edit, write) and every MCP tool the vocs-code-mcp bridge registers
 * (`mcp__*`) according to the Vocs Code permission mode and asks the host through
 * the RPC extension-UI channel. The `select` title carries a JSON payload prefixed
 * with VCODE_APPROVAL:: which the desktop app renders as an approval card.
 *
 * The decision itself lives in `subagent-gate.ts` so subagent child sessions enforce exactly the
 * same rules; this file only owns the parent's prompting and its session-scoped grants.
 *
 * A dangerous command always prompts below full access, even after "Allow for session".
 */

import {
  APPROVAL_MARKER,
  APPROVAL_OPTIONS,
  BLOCK_MARKER,
  DECLINED_REASON,
  DANGEROUS,
  GRANT_EVENT,
  type Mode,
  decideToolCall,
  readModeFile,
  readModeFromEnv,
  trimInput,
  type ApprovalChoice
} from './subagent-gate';
import { mcpReadOnlyToolNames } from './vocs-code-mcp';

// The dangerous-command list is shared with the child gate; re-exported because the offline test
// asserts it stays verbatim-identical to src/main/harness/types.ts.
export { DANGEROUS };

type ToolCallEventLike = {
  type: 'tool_call';
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
};

interface UiLike {
  select(title: string, options: readonly string[], opts?: Record<string, unknown>): Promise<string | undefined>;
  notify(message: string, type?: string): void;
}

interface CtxLike {
  ui?: UiLike;
  hasUI?: boolean;
  cwd?: string;
}

interface EventsLike {
  on(channel: string, handler: (payload: unknown) => void): void;
  emit(channel: string, payload: unknown): void;
}

interface PiLike {
  on(event: string, handler: (event: ToolCallEventLike, ctx: CtxLike) => Promise<unknown> | unknown): void;
  events?: EventsLike;
}

interface ProviderRequestEventLike {
  payload?: { reasoning?: { effort?: string } } & Record<string, unknown>;
}

interface EffortCtxLike {
  model?: { provider?: string; id?: string };
}

interface EffortChoice {
  provider?: string;
  model?: string;
  effort?: string;
}

export default function vocsCodeApprovals(pi: PiLike): void {
  installEffortOverride(pi);
  let mode: Mode = readModeFromEnv();
  const sessionAllowed = new Set<string>();
  const modeFile = process.env.VOCS_CODE_MODE_FILE;

  // "Allow for session" is one decision, so parent and child gates share it over the extension
  // event bus. Purely capability-passing: a grant is only ever added, never assumed.
  pi.events?.on(GRANT_EVENT, (payload) => {
    const tool = (payload as { tool?: unknown } | null)?.tool;
    if (typeof tool === 'string' && tool) sessionAllowed.add(tool);
  });

  const readiness = (ctx: CtxLike, ready: boolean) => {
    ctx.ui?.notify('VCODE_PI_READY::' + JSON.stringify({
      version: 1, nonce: process.env.VOCS_CODE_PI_NONCE, capability: 'approvals', ready,
    }), 'info');
  };
  pi.on('session_start', (_event, ctx) => readiness(ctx, true));
  pi.on('session_shutdown', (_event, ctx) => readiness(ctx, false));

  const refreshMode = async () => {
    const next = await readModeFile(modeFile);
    if (modeFile && next === mode) return;
    if (next !== mode) sessionAllowed.clear(); // grants do not survive a mode change
    mode = next;
  };

  pi.on('tool_call', async (event, ctx) => {
    await refreshMode();
    const tool = event.toolName;
    const decline = (reason: string) => {
      if (event.toolCallId && ctx.ui?.notify) {
        ctx.ui.notify(BLOCK_MARKER + JSON.stringify({ toolCallId: event.toolCallId, toolName: tool }), 'info');
      }
      return { block: true, reason };
    };
    const decision = await decideToolCall({ tool, input: event.input, cwd: ctx.cwd, mode, sessionAllowed, readOnlyMcp: await mcpReadOnlyToolNames() });
    if (decision.action === 'allow') return undefined;
    if (decision.action === 'block') return decline(decision.reason);
    // No approval UI means we cannot ask: fail closed instead of letting a gated action run.
    if (!ctx.ui || typeof ctx.ui.select !== 'function') {
      return { block: true, reason: 'Vocs Code approval UI is unavailable; refusing to run this action.' };
    }
    const payload = JSON.stringify({ tool, toolCallId: event.toolCallId, input: trimInput(event.input), summary: decision.summary });
    const choice = (await ctx.ui.select(APPROVAL_MARKER + payload, APPROVAL_OPTIONS)) as ApprovalChoice | undefined;
    if (choice === 'Allow once') return undefined;
    if (choice === 'Allow for session') {
      sessionAllowed.add(tool);
      pi.events?.emit(GRANT_EVENT, { tool });
      return undefined;
    }
    return decline(DECLINED_REASON);
  });
}

/**
 * Forward the host's reasoning effort to OpenRouter. pi clamps a level against the model's bundled
 * thinking map first, and that map can lag OpenRouter's live catalog, so the host writes the level
 * it wants here and this rewrites the provider payload for the matching model.
 */
function installEffortOverride(pi: PiLike): void {
  const file = process.env.VOCS_CODE_EFFORT_FILE;
  if (!file) return;
  // `before_provider_request` is newer than the tool_call event typed above; pi accepts any event name.
  const on = pi.on as unknown as (event: string, handler: (event: ProviderRequestEventLike, ctx: EffortCtxLike) => unknown) => void;
  on('before_provider_request', async (event, ctx) => {
    const reasoning = event.payload?.reasoning;
    const model = ctx.model;
    if (!reasoning || !model?.provider || !model.id) return undefined;
    let choice: EffortChoice | null = null;
    try {
      const fs = await import('node:fs/promises');
      choice = JSON.parse(await fs.readFile(file, 'utf8')) as EffortChoice | null;
    } catch {
      return undefined;
    }
    if (!choice?.effort || choice.provider !== model.provider || choice.model !== model.id) return undefined;
    return { ...event.payload, reasoning: { ...reasoning, effort: choice.effort } };
  });
}
