/** Managed Mission policy. This is a tool boundary and shell heuristic, NOT an OS sandbox.
 * Loaded explicitly with discovery disabled; no native delegation/goal extension is installed.
 * Keep dependencies standalone: the desktop also uses the pure policy below for Claude.
 */
import { BLOCK_MARKER, MCP_PREFIX, MUTATING, PLAN_REASON, readModeFile } from './subagent-gate';
import { loadMcpBridge } from './vocs-code-mcp';

export const MISSION_SERVER_ID = 'vocs-mission';
/** Exact broker operations, not a permissive mission_* wildcard. User-only controls are absent. */
export const MISSION_COORDINATION_TOOLS = [
  'mission_read', 'mission_plan_update', 'mission_question_ask', 'mission_execution_propose',
  'mission_profile_upsert', 'mission_phase_set', 'mission_task_claim', 'mission_task_delegate', 'mission_report',
  'mission_decision_request', 'mission_decision_resolve', 'mission_context_read',
  'mission_verification_request', 'mission_review_submit', 'mission_integration_request',
  'mission_task_accept', 'mission_task_diagnose', 'mission_task_cancel', 'mission_finding_resolve', 'mission_yield', 'mission_finish_request',
] as const;
const COORDINATION = new Set<string>(MISSION_COORDINATION_TOOLS);
export const MISSION_PI_CORE_TOOLS = ['read', 'write', 'edit', 'bash', 'powershell', 'rg', 'glob', 'ls'];

export interface MissionPolicy {
  role: 'lead' | 'worker';
  sourceAccess: 'read_only' | 'assigned_workspace';
  requestedTools: string[];
  /** Completed-conversation scope: only the two retained-data getters, not planning tools. */
  questionId?: string;
}

/** Authentication/role checks still belong to the broker, not this name classifier. */
export function isMissionCoordinationTool(serverId: string, tool: string): boolean {
  return serverId === MISSION_SERVER_ID && COORDINATION.has(tool);
}

export function missionToolDenial(name: string): string | undefined {
  const normalized = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  if (/(?:^|__|_)(?:agent|agents|subagent|subagents|delegate|delegation|spawn|goal|goals|ask_user_question|ask_question|questionnaire|enter_plan_mode|exit_plan_mode|task|task_output|task_stop|team_create|team_delete|send_message)(?:_|$)/.test(normalized)) {
    return 'Mission owns delegation, continuation and user questions. Use the scoped mission coordination tools.';
  }
  if (/(?:^|__|_)(?:set_model|switch_model|cycle_model|set_effort|set_thinking_level|cycle_thinking_level)(?:_|$)/.test(normalized)) {
    return 'Mission presets are fixed for the attempt; model and reasoning changes require a new approved assignment.';
  }
  if (/(?:push_files|git_push|create_pull_request|merge_pull_request|publish|deploy|release_create)/.test(normalized)) {
    return 'Independent remote delivery is disabled. Return a candidate to the Mission delivery owner.';
  }
  return undefined;
}

/** Best-effort detection only. Arbitrary shell programs can evade these patterns. */
export function missionCommandDenial(command: string): string | undefined {
  const text = command.replace(/["']/g, '');
  if (/\bgit(?:\.exe)?\b[^\r\n|;&]*\bpush\b|\bgh(?:\.exe)?\b[^\r\n|;&]*\b(?:pr\s+(?:create|merge)|release\s+create)\b|\b(?:npm|pnpm|yarn|bun)\b[^\r\n|;&]*\bpublish\b|\b(?:wrangler|vercel|netlify|firebase|flyctl)\b[^\r\n|;&]*\bdeploy\b|\b(?:docker|podman)\s+push\b/i.test(text)) {
    return 'Independent push/PR/merge/publish/deploy is disabled. Use the Mission delivery owner.';
  }
  if (/\b(?:npm|pnpm|yarn|bun)\b[^\r\n|;&]*\b(?:test(?::[\w:-]+)?|build(?::[\w:-]+)?|typecheck(?::[\w:-]+)?|dist(?::[\w:-]+)?)\b|\b(?:vitest|jest|pytest|playwright|tsc)\b|\b(?:cargo|go|dotnet)\s+(?:test|build)\b|\b(?:make|cmake|gradle|mvn)\b/i.test(text)) {
    return 'Request this check through mission_verification_request so the host admits heavy verification and captures evidence.';
  }
  return undefined;
}

/** No globs or silently ignored tool requests. Empty means the managed default surface. */
export function missionToolSubset(requested: readonly string[], exposed: readonly string[], coordination: readonly string[]): string[] {
  const known = new Set(exposed);
  for (const name of requested) {
    if (!known.has(name)) throw new Error(`Mission requested tool is unavailable or prohibited: ${name}`);
  }
  return [...new Set([...(requested.length ? requested : exposed), ...coordination])];
}

interface Pi {
  on(event: string, handler: (event: Record<string, any>, ctx: Context) => unknown): void;
  getAllTools(): { name: string }[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}
interface Context { ui: { notify(message: string, type?: string): void }; }

export default function vocsCodeMission(pi: Pi): void {
  const raw = process.env.VOCS_CODE_MISSION_POLICY;
  if (!raw) throw new Error('Managed Mission policy is missing.');
  let policy: MissionPolicy;
  try {
    policy = JSON.parse(raw);
    if (!['lead', 'worker'].includes(policy.role) || !['read_only', 'assigned_workspace'].includes(policy.sourceAccess) ||
      !Array.isArray(policy.requestedTools) || policy.requestedTools.some((name) => typeof name !== 'string') ||
      policy.questionId !== undefined && (typeof policy.questionId !== 'string' || !policy.questionId || policy.role !== 'lead' || policy.sourceAccess !== 'read_only')) throw new Error();
  } catch { throw new Error('Invalid managed Mission policy.'); }
  const modeFile = process.env.VOCS_CODE_MODE_FILE;
  let allowed = new Set<string>();
  let coordination = new Set<string>();
  let ready = false;
  const notify = (ctx: Context, marker: string, extra: Record<string, unknown>) => ctx.ui.notify(marker + JSON.stringify({ version: 1, nonce: process.env.VOCS_CODE_PI_NONCE, capability: 'mission', ...extra }), 'info');
  pi.on('session_start', async (_event, ctx) => {
    ready = false;
    try {
      const bridge = await loadMcpBridge();
      coordination = new Set(bridge.filter((tool) => tool.missionCoordination).map((tool) => tool.name));
      if (!coordination.has('mission_read') || !coordination.has(policy.questionId ? 'mission_context_read' : 'mission_report')
        || policy.questionId && [...coordination].some((name) => name !== 'mission_read' && name !== 'mission_context_read')) throw new Error('Required Mission MCP handshake/tools are missing.');
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      // Only shipped core tools and this process's connected MCP tools; a new extension tool is
      // not implicitly approved, even if another extension activates it later.
      const plan = policy.sourceAccess === 'read_only' || await readModeFile(modeFile) === 'plan';
      const exposed = [...MISSION_PI_CORE_TOOLS, ...bridge.map((tool) => tool.name)]
        .filter((name) => available.has(name) && (coordination.has(name) || (!missionToolDenial(name) &&
          (!plan || (!MUTATING.has(name) && !name.startsWith(MCP_PREFIX))))));
      allowed = new Set(policy.questionId ? [...coordination] : missionToolSubset(policy.requestedTools, exposed, [...coordination]));
      pi.setActiveTools([...allowed]);
      const active = pi.getActiveTools();
      if (active.length !== allowed.size || active.some((name) => !allowed.has(name))) throw new Error('Mission tool allowlist was not applied.');
      ready = true;
      notify(ctx, 'VCODE_PI_READY::', { ready: true, tools: active });
    } catch (error) {
      allowed.clear();
      pi.setActiveTools([]);
      notify(ctx, 'VCODE_PI_ERROR::', { message: error instanceof Error ? error.message : 'Mission gate failed.' });
      throw error;
    }
  });
  pi.on('tool_call', async (event, ctx) => {
    const name = String(event.toolName);
    let reason: string | undefined;
    if (!ready || !allowed.has(name)) reason = 'Tool is outside the managed Mission allowlist; no native delegation or unknown tools may execute.';
    else if (!coordination.has(name)) {
      reason = missionToolDenial(name);
      if (!reason && (name === 'bash' || name === 'powershell')) reason = missionCommandDenial(String(event.input?.command ?? ''));
      const plan = policy.sourceAccess === 'read_only' || await readModeFile(modeFile) === 'plan';
      // A server's model-facing annotations (or a trusted-looking name) are not source access
      // authority. Only the scoped broker can coordinate under the immutable read-only ceiling.
      if (!reason && plan && (MUTATING.has(name) || name.startsWith(MCP_PREFIX))) reason = PLAN_REASON;
    }
    if (!reason) return undefined; // Normal file/shell/MCP approvals still run after this gate.
    ctx.ui.notify(BLOCK_MARKER + JSON.stringify({ toolCallId: event.toolCallId, toolName: name }), 'info');
    return { block: true, reason };
  });
  pi.on('session_shutdown', (_event, ctx) => {
    ready = false;
    allowed.clear();
    notify(ctx, 'VCODE_PI_READY::', { ready: false });
  });
}
