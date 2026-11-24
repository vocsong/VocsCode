/**
 * Mission mode labels and lookups shared by the composer, the sidebar, the status strip and the
 * transcript cards. Everything here reads host-owned facts (`SessionMeta.mission`, `mission:get`).
 */
import { HARNESSES, PERMISSION_MODE_LABELS } from '../../shared/harness-meta';
import {
  DEFAULT_MISSION_DEFAULTS,
  missionSupport,
  type BuilderState,
  type MissionDefaults,
  type MissionMessageMeta,
  type MissionState,
  type MissionTool,
  type MissionView
} from '../../shared/mission-mode';
import type { AppSettings, SessionMeta } from '../../shared/types';

export const MISSION_STATE_LABELS: Record<MissionState, string> = {
  running: 'Running',
  waiting_user: 'Waiting on you',
  pr_open: 'PR open',
  done_local: 'Done · local branch',
  interrupted: 'Interrupted',
  stopped: 'Stopped',
  ended: 'Ended'
};

export const BUILDER_STATE_LABELS: Record<BuilderState, string> = {
  working: 'Working',
  waiting_lead: 'Waiting on the Lead',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped'
};

/** A mission that still has work in flight (or waiting to resume), so Stop applies. */
export function missionInFlight(state: MissionState | undefined): boolean {
  return state === 'running' || state === 'waiting_user' || state === 'interrupted';
}

/** Builders still on their task: working, or waiting for the Lead's answer. */
export function runningBuilders(view: MissionView | undefined): number {
  return view?.builders.filter((b) => b.state === 'working' || b.state === 'waiting_lead').length ?? 0;
}

export function missionDefaultsOf(settings: AppSettings | null | undefined): MissionDefaults {
  return settings?.missionDefaults ?? DEFAULT_MISSION_DEFAULTS;
}

/** The permission pill while Mission mode is on: the Lead always plans; Builders use the Settings tier. */
export function missionPermissionLabel(settings: AppSettings | null | undefined): string {
  const tier = missionDefaultsOf(settings).builder.permissionMode;
  return `Lead: Plan · Builders: ${PERMISSION_MODE_LABELS[tier]?.short ?? tier}`;
}

/** A Lead's branch is `mission/<slug>` (its Builders get `mission/<slug>-b<n>`). */
export const MISSION_BRANCH_PREFIX = 'mission';

/** Harnesses that can lead, by name, for the message a harness that cannot lead shows. */
export const LEAD_HARNESS_NAMES = HARNESSES.filter((h) => missionSupport(h.id).lead).map((h) => h.name);

/** Whether this session's next message may start a mission: an ordinary session on a Lead-capable harness. */
export function canStartMission(session: SessionMeta): boolean {
  return !session.mission && !session.archived && missionSupport(session.config.harness).lead;
}

/** The ended-mission notice; the Lead's composer shows it instead of accepting text. */
export const MISSION_ENDED_TEXT = 'This mission has ended — fork to continue';

export function missionEnded(session: SessionMeta): boolean {
  return session.mission?.role === 'lead' && session.mission.state === 'ended';
}

/** The heading of a host-written transcript row; any other Builder it names shows beside it. */
export function missionMessageLabel(meta: MissionMessageMeta | undefined, builderIndex?: number): string {
  switch (meta?.kind) {
    case 'kickoff': return 'Kickoff';
    case 'from_lead': return 'From the Lead';
    case 'from_builder': return builderIndex ? `From Builder ${builderIndex}` : 'From a Builder';
    case 'report': return 'Report';
    case 'question': return 'Question';
    case 'approval': return 'Approval';
    case 'failed': return 'Failed';
    case 'stopped': return 'Stopped';
    case 'resume': return 'Resumed';
    case 'note':
    default: return 'Note';
  }
}

/**
 * A Builder's number from whatever id a card carries: the mission's Builder id or the Builder's
 * session id. The Lead's last mission view answers first, the session list second.
 */
export function builderIndexOf(builderId: string | undefined, views: Record<string, MissionView>, sessions: SessionMeta[]): number | undefined {
  if (!builderId) return undefined;
  for (const view of Object.values(views)) {
    const hit = view.builders.find((b) => b.id === builderId || b.sessionId === builderId);
    if (hit) return hit.index;
  }
  return sessions.find((s) => s.id === builderId && s.mission?.role === 'builder')?.mission?.builderIndex;
}

/**
 * The number of the Builder a `start_builder` call created: the Builder whose id the result names,
 * else the one with the requested title. Undefined until the Lead's mission view lists it.
 */
export function startedBuilderIndex(output: string | undefined, title: string | undefined, views: Record<string, MissionView>): number | undefined {
  const builders = Object.values(views).flatMap((v) => v.builders);
  const named = output ? builders.find((b) => output.includes(b.id) || output.includes(b.sessionId)) : undefined;
  return (named ?? (title ? builders.find((b) => b.title === title) : undefined))?.index;
}

/** The text a Mission tool call carries, shown beside its heading. */
export function missionToolSummary(tool: MissionTool, input: unknown): string | undefined {
  switch (tool) {
    case 'start_builder': return toolArg(input, 'task');
    case 'message_builder': return toolArg(input, 'text');
    case 'answer_request':
    case 'record_check': return toolArg(input, 'note');
    case 'ask_lead': return toolArg(input, 'question');
    case 'report_done': return toolArg(input, 'summary');
    case 'report_blocked': return toolArg(input, 'reason');
    case 'finish_mission': return toolArg(input, 'task');
    default: return undefined;
  }
}

/**
 * Coordination tools that hand work between the Lead and its Builders. Their cards stay on screen
 * between messages; the read-only checks (list, wait, diff, log) fold into the work like any step.
 */
const HANDOFF_TOOLS: ReadonlySet<MissionTool> = new Set<MissionTool>([
  'start_builder', 'message_builder', 'answer_request', 'record_check', 'accept_builder', 'stop_builder', 'finish_mission',
  'ask_lead', 'report_done', 'report_blocked', 'land_on_lead'
]);

export function isHandoffTool(tool: MissionTool | undefined): boolean {
  return !!tool && HANDOFF_TOOLS.has(tool);
}

/** Reads a string argument from a tool call's input without trusting its shape. */
export function toolArg(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** The one-line heading of a Mission tool card. `builder` is "Builder 2" when the card names one. */
export function missionToolLabel(tool: MissionTool, input: unknown, builder: string | undefined): string {
  const who = builder ?? 'a Builder';
  switch (tool) {
    case 'start_builder': {
      const title = toolArg(input, 'title');
      return `Started ${builder ?? 'a Builder'}${title ? `: ${title}` : ''}`;
    }
    case 'message_builder': return `Messaged ${who}`;
    case 'answer_request': {
      const decision = toolArg(input, 'decision');
      return decision === 'allow' ? 'Allowed a Builder request' : decision === 'deny' ? 'Denied a Builder request' : 'Answered a Builder request';
    }
    case 'list_builders': return 'Checked the Builders';
    case 'wait_for_builders': return 'Waiting for the Builders';
    case 'builder_diff': return `Viewed ${builder ? `${builder}'s` : 'a Builder’s'} changes`;
    case 'builder_log': return `Viewed ${builder ? `${builder}'s` : 'a Builder’s'} commits`;
    case 'record_check': {
      const passed = input && typeof input === 'object' ? (input as Record<string, unknown>).passed : undefined;
      return passed === true ? `Check passed for ${who}` : passed === false ? `Check failed for ${who}` : `Recorded a check for ${who}`;
    }
    case 'accept_builder': return `Accepted ${who}`;
    case 'stop_builder': return `Stopped ${who}`;
    case 'finish_mission': return 'Finished the mission';
    case 'ask_lead': return 'Asked the Lead';
    case 'report_done': return 'Reported done to the Lead';
    case 'report_blocked': return 'Reported blocked to the Lead';
    case 'land_on_lead': return 'Landed on the Lead branch';
  }
}

/** The `finish_mission` report as the PR body reads it: Task / Done / Decisions / Files / Verification / Notes. */
export function finishReportSections(input: unknown): { title: string; lines: string[] }[] {
  if (!input || typeof input !== 'object') return [];
  const raw = input as Record<string, unknown>;
  const list = (key: string) => (Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((v): v is string => typeof v === 'string' && !!v.trim()) : []);
  const sections = [
    { title: 'Task', lines: typeof raw.task === 'string' && raw.task.trim() ? [raw.task] : [] },
    { title: 'Done', lines: list('done') },
    { title: 'Decisions', lines: list('decisions') },
    { title: 'Files', lines: list('files') },
    { title: 'Verification', lines: list('verification') },
    { title: 'Notes', lines: list('notes') }
  ];
  return sections.filter((s) => s.lines.length > 0);
}
