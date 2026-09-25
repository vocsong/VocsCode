/** Bounded turn-local observations, not a retry engine. Only normalized host/runtime facts enter
 * here; assistant prose, result summaries and arbitrary log text never establish a cause. */
import { classifyExecution, deriveOutcome } from '../../shared/analytics/classify';
import { commandPreview, isContentLine } from '../../shared/analytics/text';
import type { MissionFailure, MissionRecord } from '../../shared/mission';
import type { ApprovalRequest, HarnessId, SessionEvent, TranscriptItem } from '../../shared/types';

type Turn = Extract<TranscriptItem, { kind: 'turn' }>;
type Tool = Extract<TranscriptItem, { kind: 'tool' }>;
type Source = NonNullable<MissionFailure['source']>;
export interface MissionTurnTrouble {
  failures: Map<string, MissionFailure>;
  approvals: Map<string, Pick<ApprovalRequest, 'kind' | 'options'>>;
}
const LIMIT = 32;
function remember<T>(map: Map<string, T>, id: string, value: T): void {
  map.delete(id); map.set(id, value);
  if (map.size > LIMIT) map.delete(map.keys().next().value!);
}

const RATE_LIMIT = /\brate[_ -]?limit(?:ed|_error)?\b|\btoo many requests\b|\b(?:http|status(?: code)?)\s*[:=]?\s*429\b|^429\b/i;
const CREDENTIALS = /\b401\b|unauthenticated|unauthorized|authentication (?:failed|required)|not authenticated|invalid api key|api key (?:is )?(?:missing|invalid|required)|no api key|not logged in|login required|credentials? (?:not found|missing|invalid|expired)|token (?:expired|invalid)|connection\/account is unavailable or revoked/i;
const PERMISSION = /permission denied|denied by (?:the )?user|not approved|\beacces\b|\beperm\b|access (?:is )?denied|operation not permitted|\b403\b|\bforbidden\b|outside .*grants|not permitted for this (?:project|Mission)|permission or data rules prohibit|preset has been disabled or removed/i;
const MISSING = /\benoent\b|command not found|not recognized as (?:an internal|the name of a cmdlet)|cannot find (?:module|package)|no module named|missing (?:binary|dependency)|(?:binary|runtime|executable|shell) (?:is )?(?:not found|unavailable)|required task tool is not available|not installed|no shell available|failed to start shell/i;
const INTEGRATION = /merge conflict|conflict \(content\)|automatic merge failed|unmerged (?:paths|files)|non-fast-forward|accepted (?:revision|content).*(?:changed|diverged)|workspace does not match its accepted input/i;
const PROVIDER = /\b(?:500|502|503|504)\b|service unavailable|bad gateway|gateway time-?out|overloaded|api[_ ]error|provider.*(?:failed|unavailable)|\beconn(?:refused|reset)\b|\benotfound\b|\betimedout\b|fetch failed|socket hang up|network (?:error|is unreachable)|connection (?:refused|timed out)/i;
const PROTOCOL = /invalid (?:tool )?arguments|invalid schema|control protocol|extension error|unsupported.*(?:control|protocol)|mission tools|transport closed|jsonrpc/i;
// These are actual adapter info-card formats (Pi auto_retry_start, Codex willRetry). Matching
// text is still heuristic: SessionEvent has no structured retry/backoff field or retry deadline.
const BACKOFF = /^Retrying \(\d+\/\d+\): | \(retrying\)$/i;

function failure(kind: MissionFailure['kind'], code: string, source: Source, detail: string, recovery: MissionFailure['recovery'] = 'lead_diagnosis', confidence: MissionFailure['confidence'] = 'heuristic', eventId?: string): MissionFailure {
  return { kind, code, source, confidence, recovery, ...(eventId ? { eventId } : {}),
    message: `${confidence === 'heuristic' ? 'Heuristic diagnosis, not a proven root cause. ' : confidence === 'unknown' ? 'Cause unclassified. ' : ''}${commandPreview(detail, 700)}` };
}

/** Codes/strings name suspected causes, never positive authority to change presets or grants. */
function fromText(text: string, source: Source, eventId?: string): MissionFailure {
  // This exact host preflight refusal prohibits new model input; it is not a denied tool.
  // The lead can select another approved preset explicitly, but cannot reinstate this one.
  if (source === 'dispatch' && text.trim() === 'The preset has been disabled or removed from the live library.') return failure('permission', 'preset_revoked', source, text, 'lead_diagnosis', 'heuristic', eventId);
  if (CREDENTIALS.test(text)) return failure('provider', 'credentials_unavailable', source, text, 'user_action', 'heuristic', eventId);
  if (PERMISSION.test(text)) return failure('permission', 'permission_denied', source, text, 'user_action', 'heuristic', eventId);
  if (RATE_LIMIT.test(text)) return failure('rate_limit', 'rate_limit', source, text, 'same_preset_after_backoff', 'heuristic', eventId);
  if (MISSING.test(text)) return failure('environment', 'missing_tool_or_runtime', source, text, 'lead_diagnosis', 'heuristic', eventId);
  if (INTEGRATION.test(text)) return failure('integration', 'integration_conflict', source, text, 'lead_diagnosis', 'heuristic', eventId);
  if (PROVIDER.test(text)) return failure('provider', 'provider_unavailable', source, text, 'same_preset_after_backoff', 'heuristic', eventId);
  if (PROTOCOL.test(text)) return failure('protocol', 'runtime_protocol', source, text, 'lead_diagnosis', 'heuristic', eventId);
  return failure('unknown', 'unclassified', source, text || 'No cause was reported by the runtime.', 'lead_diagnosis', 'unknown', eventId);
}

function toolFailure(item: Tool, harness: HarnessId): MissionFailure | undefined {
  if (item.status === 'running' || item.parentId) return undefined;
  const { facts, derived: outcome } = classifyExecution({ harness, platform: process.platform, tool: item.name, hint: item.hint,
    status: item.status, exitCode: item.exitCode, input: item.input, output: item.output });
  // In particular rg/grep exit 1 and git diff --exit-code are informational, not provider errors.
  if (outcome.outcome === 'success' || outcome.outcome === 'informational') return undefined;
  // Analytics treats documented diagnostic exits (e.g. pytest 1) as test results before reading
  // stderr. A Mission must still distinguish permission/dependency failures from bad code.
  // Refine just those diagnostics without the exit shortcut; never rewrite the retained facts.
  const derived = outcome.outcome === 'diagnostic' ? deriveOutcome({ ...facts, status: 'error', exitCode: undefined }) : outcome;
  const code = derived.category ?? 'unclassified';
  const detail = `${item.name}: ${code}${facts.excerpt ? `; ${facts.excerpt}` : ''}`;
  if (item.status === 'declined') return failure('permission', 'tool_declined', 'tool', detail, 'user_action', 'observed', item.id);
  // Analytics calls diagnostics neither provider nor tool failures. For Mission they can explain
  // failed implementation, but do not prove the worker introduced the defect or tests really ran.
  if (derived.outcome === 'diagnostic') return failure('implementation', code, 'tool', detail, 'lead_diagnosis', 'heuristic', item.id);
  if (derived.outcome === 'control') return undefined;
  let kind: MissionFailure['kind'] = 'unknown';
  let recovery: MissionFailure['recovery'] = 'lead_diagnosis';
  if (code === 'permission_denied' || code === 'declined') { kind = 'permission'; recovery = 'user_action'; }
  else if (code === 'missing_credentials') { kind = 'environment'; recovery = 'user_action'; }
  else if (['command_not_found', 'missing_dependency', 'tool_unavailable', 'tool_spawn_failure', 'resource_exhaustion', 'filesystem_failure', 'network_failure'].includes(code)) kind = 'environment';
  else if (code === 'vcs_state_conflict') kind = 'integration';
  else if (['invalid_tool_arguments', 'incorrect_tool_usage', 'edit_target_not_found', 'tool_transport_failure', 'malformed_patch', 'wrong_shell_syntax', 'malformed_syntax', 'invalid_argument', 'invalid_path'].includes(code)) kind = 'protocol';
  else if (code === 'program_error') kind = 'implementation';
  // An unavailable MCP tool may emit a more precise runtime signature than analytics recognizes.
  // Do not scan shell/test output for provider codes: e.g. an assertion printing 429 is not a 429 API failure.
  if (kind === 'unknown' && facts.physical === 'mcp') {
    const text = (facts.excerpt ?? '').split('\n').filter((line) => !isContentLine(line)).join('\n');
    if (MISSING.test(text)) kind = 'environment';
  }
  return failure(kind, code, 'tool', detail, recovery, kind === 'unknown' ? 'unknown' : 'heuristic', item.id);
}

/** Read-only: never interrupts backoff, answers approvals, or creates a new attempt. */
export function observeMissionTrouble(previous: MissionTurnTrouble | undefined, event: SessionEvent, harness: HarnessId): MissionTurnTrouble {
  const state = previous ?? { failures: new Map<string, MissionFailure>(), approvals: new Map() };
  const approval = (request: Pick<ApprovalRequest, 'id' | 'kind' | 'options'>, optionId?: string) => {
    if (request.kind === 'question' || request.kind === 'elicitation') return;
    if (!optionId) { remember(state.approvals, request.id, { kind: request.kind, options: structuredClone(request.options) }); return; }
    const decision = request.options.find((option) => option.id === optionId)?.kind;
    if (decision === 'deny' || decision === 'deny_always' || decision === 'cancel') {
      remember(state.failures, `approval:${request.id}`, failure('permission', 'approval_denied', 'approval', 'The human permission request was denied or canceled. A model cannot approve it.', 'user_action', 'observed', request.id));
    }
    state.approvals.delete(request.id);
  };
  if (event.type === 'approval.request') approval(event.request);
  else if (event.type === 'approval.resolved') {
    const request = state.approvals.get(event.requestId);
    if (request) approval({ ...request, id: event.requestId }, event.decision.optionId);
  } else if (event.type === 'error') remember(state.failures, 'error', fromText(event.message, 'error'));
  else if (event.type === 'status' && event.status === 'error' && event.detail) remember(state.failures, 'status', fromText(event.detail, 'status'));
  else if (event.type === 'item.upsert') {
    const item = event.item;
    if (item.kind === 'tool' && item.status !== 'running') {
      const diagnosis = toolFailure(item, harness);
      if (diagnosis) remember(state.failures, `tool:${item.id}`, diagnosis);
      else state.failures.delete(`tool:${item.id}`);
    } else if (item.kind === 'approval') approval(item.request, item.decision?.optionId);
    else if (item.kind === 'info' && item.level !== 'info' && BACKOFF.test(item.text)) remember(state.failures, 'backoff', fromText(item.text, 'backoff', item.id));
  }
  return state;
}

/** Runtime/control failures outrank secondary tool diagnostics; denied access is never repaired
 * by an unrelated later test result. Ordering within each source class remains latest-first. */
function observedFailure(trouble?: MissionTurnTrouble): MissionFailure | undefined {
  const observed = [...trouble?.failures.values() ?? []].reverse();
  const known = observed.filter((entry) => entry.kind !== 'unknown');
  return known.find((entry) => entry.recovery === 'user_action')
    ?? known.find((entry) => entry.source !== 'tool') ?? known[0] ?? observed[0];
}

/** A successful settled turn supersedes transient trouble. Model result failure may request
 * diagnosis but its summary is not evidence of a provider, environment or implementation cause. */
export function classifyMissionTurn(end: Turn, trouble?: MissionTurnTrouble, resultFailed = false, mismatches: string[] = []): MissionFailure | undefined {
  if (mismatches.length) return failure('provider', 'preset_mismatch', 'preset', `Effective preset mismatch: ${mismatches.join(', ')}`, 'user_action', 'observed', end.id);
  if (end.status === 'completed' && !resultFailed) return undefined;
  const terminal = end.error ? fromText(end.error, 'turn', end.id) : undefined;
  const observed = observedFailure(trouble);
  if (observed?.recovery === 'user_action' && terminal?.recovery !== 'user_action') return observed;
  if (terminal && terminal.kind !== 'unknown') return terminal;
  return (observed?.kind !== 'unknown' ? observed : undefined) ?? terminal ?? observed
    ?? failure('unknown', end.status === 'completed' ? 'reported_failure_unverified' : `turn_${end.status}`, 'turn',
      end.status === 'completed' ? 'The worker reported failure without a runtime cause; its prose does not establish attribution.' : `Turn ${end.status} without an observed cause.`, 'lead_diagnosis', 'unknown', end.id);
}

export function classifyMissionDispatch(reason: string, trouble?: MissionTurnTrouble): MissionFailure {
  const direct = fromText(reason, 'dispatch'), observed = observedFailure(trouble);
  if (observed?.recovery === 'user_action' && direct.recovery !== 'user_action') return observed;
  return direct.kind !== 'unknown' ? direct : observed && observed.kind !== 'unknown' ? observed : direct;
}

/** Guards delayed settlement/dispatch callbacks as well as event observation. An old operation
 * never takes ownership of the newest attempt just because it reused the same session ID. */
export function currentMissionFailureOwner(record: MissionRecord, operationId: string, sessionId: string, generation: number): boolean {
  const operation = record.operations.find((op) => op.id === operationId && op.kind === 'dispatch' && !['succeeded', 'failed'].includes(op.state));
  if (!operation || operation.payload.sessionId !== sessionId) return false;
  if (sessionId === record.leadSessionId && generation !== record.leadGeneration) return false;
  if (operation.payload.generation !== undefined && operation.payload.generation !== generation) return false;
  if (operation.payload.attemptId) return record.attempts.some((attempt) => attempt.id === operation.payload.attemptId && attempt.sessionId === sessionId && attempt.generation === generation && attempt.status !== 'terminal');
  return sessionId === record.leadSessionId && generation === record.leadGeneration;
}

export function missionFailureNotice(value: MissionFailure): string {
  const action = value.recovery === 'user_action' ? 'Automation pauses for human credentials/permission or preset reconciliation. Resume explicitly after resolution; the lead cannot grant access.'
    : value.code === 'preset_revoked' ? 'This preset remains revoked. The lead may explicitly choose another already-approved suitable preset, or ask the user about a required blocker; it cannot reinstate access or silently substitute a preset.'
      : value.recovery === 'same_preset_after_backoff' ? 'The harness owns provider retry/backoff; Mission adds no timer or automatic retry. After it settles, the lead may diagnose and request one bounded same-preset attempt, inspecting retained effects first.'
        : value.kind === 'environment' ? 'Diagnose the missing tool/runtime or environment on this same preset. Do not upgrade the model or switch accounts to repair an environment failure.'
          : value.kind === 'integration' ? 'Inspect the retained conflict and accepted revision before a scoped repair; do not blindly reapply or choose one side.'
            : 'The lead must diagnose retained facts and choose a concrete bounded approach before requesting another attempt; unknown attribution is not a reason to upgrade.';
  return `Failure classification: ${JSON.stringify(value)}\n${action} No preset, account, permission or retry policy was changed.`;
}
