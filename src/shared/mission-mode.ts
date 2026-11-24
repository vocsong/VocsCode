/**
 * Mission mode: one Lead session plans and coordinates, Builder sessions implement. Shared by main,
 * renderer and the harness adapters. Keep this file free of Node/Electron/DOM imports.
 *
 * The Lead runs in Plan and never edits; it reaches Builders only through the app's Mission tools
 * (the reserved built-in MCP server `vocs-mission`). A Builder's permission requests go to the Lead
 * first; the always-user classes (outside the mission's folders, publish, elevation, piped downloads)
 * still reach the user, with the Lead's recommendation attached.
 */
import type { EffortLevel, HarnessId, ModelRef, PermissionMode } from './harness-types';

export type MissionRole = 'lead' | 'builder';

/** The mission as a whole, as the Lead's status strip shows it. */
export type MissionState =
  | 'running'
  /** The Lead is waiting on the user: a question, an always-user approval or a failed-check limit. */
  | 'waiting_user'
  /** The PR is open; follow-up messages resume work on the same branch. */
  | 'pr_open'
  /** Finished on a local branch (no remote, no `gh`, or a folder without git). */
  | 'done_local'
  /** The app stopped while the mission was running; nothing resumes until the user clicks Resume. */
  | 'interrupted'
  | 'stopped'
  /** The PR was merged or closed; the mission's worktrees are cleaned up. */
  | 'ended';

export type BuilderState = 'working' | 'waiting_lead' | 'done' | 'failed' | 'stopped';

/** Host-owned identity on `SessionMeta.mission`; never accepted from a renderer patch. */
export interface SessionMission {
  missionId: string;
  role: MissionRole;
  /** A Builder's Lead session. */
  leadId?: string;
  /** 1-based Builder number, as in its branch `mission/<slug>-b<n>`. */
  builderIndex?: number;
  /** Lead: the mission's state. */
  state?: MissionState;
  /** Builder: its own state. */
  builderState?: BuilderState;
  /** Lead: the open PR. */
  prUrl?: string;
}

/** The reserved built-in MCP server that carries the Mission tools to every supported harness. */
export const MISSION_SERVER_ID = 'vocs-mission';

/** Tools a Lead token lists and may call. */
export const LEAD_TOOLS = [
  'start_builder', 'message_builder', 'answer_request', 'list_builders', 'wait_for_builders',
  'builder_diff', 'builder_log', 'record_check', 'accept_builder', 'stop_builder', 'finish_mission'
] as const;

/** Tools a Builder token lists and may call. */
export const BUILDER_TOOLS = ['ask_lead', 'report_done', 'report_blocked', 'land_on_lead'] as const;

export type LeadTool = (typeof LEAD_TOOLS)[number];
export type BuilderTool = (typeof BUILDER_TOOLS)[number];
export type MissionTool = LeadTool | BuilderTool;

export const MISSION_LIMITS = {
  /** Builders running at once. */
  builders: 3,
  /** Failed Lead checks on one Builder's task before the Lead must ask the user. */
  failedChecks: 3
} as const;

/** Which roles a harness can take. Codex exec declines MCP calls; Cursor takes no injected MCP and
 * raises no approvals; ACP permission requests do not name the tool, so Plan cannot recognise the
 * Mission tools there. Antigravity is driven by direct user prompts only. */
export function missionSupport(harness: HarnessId): { lead: boolean; builder: boolean } {
  switch (harness) {
    case 'claude':
    case 'codex':
    case 'pi':
    case 'native':
      return { lead: true, builder: true };
    case 'acp':
      return { lead: false, builder: true };
    default:
      return { lead: false, builder: false };
  }
}

const MISSION_TOOL_SET: ReadonlySet<string> = new Set<string>([...LEAD_TOOLS, ...BUILDER_TOOLS]);

/**
 * The Mission tool a harness-level tool name refers to, or undefined. Harnesses spell MCP tools
 * differently: `mcp__vocs-mission__x` (Claude), `mcp__vocs_mission__x` (sanitized by Pi/native) and
 * `vocs-mission.x` (Codex).
 */
export function missionToolOf(name: string | undefined): MissionTool | undefined {
  if (!name) return undefined;
  for (const prefix of ['mcp__vocs-mission__', 'mcp__vocs_mission__', 'vocs-mission.', 'vocs-mission__', 'vocs_mission__']) {
    if (name.startsWith(prefix)) {
      const tool = name.slice(prefix.length);
      return MISSION_TOOL_SET.has(tool) ? (tool as MissionTool) : undefined;
    }
  }
  return undefined;
}

/** Settings → Sessions → Mission mode: what every Builder runs on. */
export interface MissionDefaults {
  builder: {
    /** `same` runs Builders on the Lead's harness, model and effort. */
    harness: HarnessId | 'same';
    model?: ModelRef;
    /** null omits effort; undefined inherits the app preference. */
    effort?: EffortLevel | null;
    permissionMode: PermissionMode;
  };
}

export const DEFAULT_MISSION_DEFAULTS: MissionDefaults = { builder: { harness: 'same', permissionMode: 'auto' } };

/** One Builder as the Lead's strip and cards show it. */
export interface MissionBuilderView {
  id: string;
  sessionId: string;
  index: number;
  title: string;
  state: BuilderState;
  ownWorktree: boolean;
  failedChecks: number;
}

/** The mission record's public summary (`mission:get`). */
export interface MissionView {
  id: string;
  leadId: string;
  state: MissionState;
  git: boolean;
  baseBranch?: string;
  leadBranch?: string;
  prUrl?: string;
  builders: MissionBuilderView[];
  /** Builders at the failed-check limit, waiting for the user. */
  blockedOnUser: string[];
}

/** Where a Builder's permission request goes, recorded on its approval card. */
export interface ApprovalMissionRoute {
  route: 'lead' | 'user';
  /** Why it must reach the user (publish, elevation, outside the mission's folders, ...). */
  reason?: string;
  status: 'with_lead' | 'with_user';
  /** The Lead's advice on a request only the user may answer. */
  recommendation?: { verdict: 'allow' | 'deny'; note?: string };
}

/** Host-authored transcript rows of a mission (kickoff, Lead↔Builder messages, reports). */
export type MissionMessageKind = 'kickoff' | 'from_lead' | 'from_builder' | 'report' | 'question' | 'approval' | 'failed' | 'stopped' | 'resume' | 'note';

export interface MissionMessageMeta {
  kind: MissionMessageKind;
  builderId?: string;
  requestId?: string;
}

/** Arguments of each Mission tool, as the gateway validates them before the service sees them. */
export interface MissionToolArgs {
  start_builder: { title: string; task: string; own_worktree?: boolean };
  message_builder: { builderId: string; text: string };
  answer_request: { requestId: string; decision: 'allow' | 'deny'; note?: string };
  list_builders: Record<string, never>;
  wait_for_builders: Record<string, never>;
  builder_diff: { builderId: string; stat?: boolean };
  builder_log: { builderId: string };
  record_check: { builderId: string; passed: boolean; note?: string };
  accept_builder: { builderId: string };
  stop_builder: { builderId: string };
  finish_mission: { task: string; done: string[]; decisions: string[]; files: string[]; verification: string[]; notes?: string[] };
  ask_lead: { question: string };
  report_done: { summary: string; verification: string[]; files?: string[] };
  report_blocked: { reason: string };
  land_on_lead: Record<string, never>;
}
