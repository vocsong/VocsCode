/** Pure Mission mode formatting, state predicates, record validation, and Builder config resolution. */
import path from 'node:path';
import { HARNESS_BY_ID, closestPermissionMode } from '../../shared/harness-meta';
import {
  DEFAULT_MISSION_DEFAULTS,
  missionSupport,
  type ApprovalMissionRoute,
  type BuilderState,
  type MissionMessageKind,
  type MissionMessageMeta,
  type MissionState,
  type MissionView
} from '../../shared/mission-mode';
import type {
  ApprovalRequest,
  AppSettings,
  EffortLevel,
  HarnessId,
  ModelRef,
  PermissionMode,
  SessionConfig,
  SessionMeta
} from '../../shared/types';
import { shortId } from '../util/async';
import type { MissionToolResult } from './contracts';
import { roleReminder } from './prompts';
import type { BuilderRecord, InboxEntry, MissionRecord } from './record';

export const RECORD_FILE = 'mission.json';

/** States in which host messages go out; the rest hold them (interrupted until Resume). */
export const DELIVERING: ReadonlySet<MissionState> = new Set<MissionState>(['running', 'waiting_user', 'pr_open', 'done_local']);
/** States in which the Lead may hand out or change work. */
export const DISPATCHING: ReadonlySet<MissionState> = new Set<MissionState>(['running', 'waiting_user', 'pr_open', 'done_local']);
export const OVER: ReadonlySet<MissionState> = new Set<MissionState>(['ended', 'stopped']);

export const STATE_WORDS: Record<BuilderState, string> = {
  working: 'working',
  waiting_lead: 'waiting for your answer',
  done: 'reported done',
  failed: 'failed or blocked',
  stopped: 'stopped'
};

export type DeliveryTarget = 'lead' | string;

export interface LeadPlan {
  cwd: string;
  branch?: string;
  baseBranch?: string;
  startSha?: string;
  uncommittedAtStart: boolean;
  owned: boolean;
  /** A worktree this call created, removed again when the start fails. */
  created?: { path: string; branch: string };
}

/** A refusal the model reads as the tool's error; never logged as a fault. */
export class Refusal extends Error {}
/** The record could not be written; the in-memory state was not changed. */
export class RecordWriteError extends Error {}

export const ok = (text: string): MissionToolResult => ({ text });
export const refuse = (text: string): never => {
  throw new Refusal(text);
};
export const who = (b: Pick<BuilderRecord, 'index' | 'id'>): string => `Builder ${b.index} (${b.id})`;
export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);
export const isActive = (b: BuilderRecord): boolean => !b.accepted && (b.state === 'working' || b.state === 'waiting_lead');

export const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
};

export function findBuilder(record: MissionRecord, builderId: string): BuilderRecord {
  const b = record.builders.find((x) => x.id === builderId || x.sessionId === builderId);
  if (!b) refuse(`There is no Builder ${builderId} in this mission. list_builders shows their ids.`);
  return b!;
}

export function inboxOf(record: MissionRecord, target: DeliveryTarget): InboxEntry[] {
  return target === 'lead' ? record.inbox.lead : record.inbox.builders[target] ?? [];
}

export function makeInboxEntry(kind: MissionMessageKind, text: string, extra: { builderId?: string; requestId?: string } = {}): InboxEntry {
  return { id: shortId('mi_'), kind, text, ...(extra.builderId ? { builderId: extra.builderId } : {}), ...(extra.requestId ? { requestId: extra.requestId } : {}), ts: Date.now() };
}

export function createMissionRecord(
  missionId: string,
  leadId: string,
  projectRoot: string,
  git: boolean,
  plan: LeadPlan,
  overrides: { uncommittedAtStart?: boolean; baseBranch?: string }
): MissionRecord {
  const now = Date.now();
  const baseBranch = overrides.baseBranch ?? plan.baseBranch;
  return {
    v: 1,
    id: missionId,
    leadId,
    createdAt: now,
    updatedAt: now,
    state: 'running',
    projectRoot,
    git,
    ...(baseBranch ? { baseBranch } : {}),
    ...(plan.branch ? { leadBranch: plan.branch } : {}),
    leadWorktree: plan.cwd,
    leadWorktreeOwned: git && plan.owned,
    ...(plan.startSha ? { startSha: plan.startSha } : {}),
    uncommittedAtStart: overrides.uncommittedAtStart ?? plan.uncommittedAtStart,
    builders: [],
    inbox: { lead: [], builders: {} }
  };
}

/** Builders run on Settings → Sessions → Mission mode; "Same as Lead" copies the Lead's harness, model and effort. */
export function resolveBuilderSpec(lead: SessionMeta, settings: AppSettings): { config: SessionConfig } {
  const d = (settings.missionDefaults ?? DEFAULT_MISSION_DEFAULTS).builder;
  let harness: HarnessId;
  let model: ModelRef | undefined;
  let effort: EffortLevel | null | undefined;
  let extra: Partial<SessionConfig> = {};
  if (d.harness === 'same') {
    harness = lead.config.harness;
    model = lead.activeModel ?? lead.config.model;
    effort = lead.activeEffort ?? lead.config.effort;
    if (lead.config.codexModelProvider) extra = { codexModelProvider: lead.config.codexModelProvider };
  } else {
    harness = d.harness;
    model = d.model;
    effort = d.effort;
  }
  const descriptor = HARNESS_BY_ID[harness];
  if (!descriptor || !missionSupport(harness).builder) refuse(`${descriptor?.name ?? harness} cannot run Builders. Choose another Builder harness in Settings → Sessions → Mission mode.`);
  const permissionMode: PermissionMode = closestPermissionMode(harness, d.permissionMode);
  return { config: { harness, projectRoot: '', ...(model ? { model } : {}), ...(effort !== undefined ? { effort } : {}), permissionMode, ...extra } };
}

export function missionView(record: MissionRecord): MissionView {
  return {
    id: record.id,
    leadId: record.leadId,
    state: record.state,
    git: record.git,
    ...(record.baseBranch ? { baseBranch: record.baseBranch } : {}),
    ...(record.leadBranch ? { leadBranch: record.leadBranch } : {}),
    ...(record.pr?.url ? { prUrl: record.pr.url } : {}),
    builders: record.builders.map((b) => ({ id: b.id, sessionId: b.sessionId, index: b.index, title: b.title, state: b.state, ownWorktree: !!b.worktree, failedChecks: b.failedChecks })),
    blockedOnUser: [...(record.checksBlockedUntilUser ?? [])]
  };
}

export function missionRoster(record: MissionRecord, waiting: boolean): string {
  const lines = record.builders.length
    ? record.builders.map((b) => {
        const where = b.worktree ? `own worktree on ${b.worktree.branch}${b.landed ? ', landed' : ''}` : 'shares your worktree';
        const blocked = record.checksBlockedUntilUser?.includes(b.id) ? '; blocked until the user replies' : '';
        const asked = b.pendingQuestion ? `; asked: "${clip(b.pendingQuestion, 200)}"` : '';
        return `- ${who(b)} "${b.title}" (session ${b.sessionId}): ${b.accepted ? 'accepted' : STATE_WORDS[b.state]}; ${where}${b.failedChecks ? `; ${b.failedChecks} failed check(s)` : ''}${blocked}${asked}`;
      })
    : ['- No Builders yet. Start one with start_builder.'];
  const active = record.builders.filter(isActive).length;
  const tail = waiting
    ? active ? `\n\n${active} Builder(s) still on their tasks. End your turn now: the app messages you when one reports, asks or fails. Do not poll.` : '\n\nNo Builder is working; there is nothing to wait for.'
    : '';
  return `Mission ${record.id} (${record.state}):\n${lines.join('\n')}${tail}`;
}

/** What the role prompt adds about this mission right now (Lead): where it started, who works. */
export function leadMissionContext(record: MissionRecord): string {
  const lines: string[] = [];
  if (record.git && record.uncommittedAtStart) lines.push(record.leadWorktreeOwned ? '- The project checkout had uncommitted changes when the mission started; they are not in your worktree. Tell the user, and ask if the task depends on them.' : '- Your worktree already had uncommitted changes when the mission started; make sure the Builders know what is whose.');
  if (record.builders.length) {
    lines.push('- Builders so far:');
    for (const b of record.builders) lines.push(`  - ${who(b)} "${b.title}": ${b.accepted ? 'accepted' : STATE_WORDS[b.state]}${b.worktree ? `, own worktree on ${b.worktree.branch}` : ', shares your worktree'}`);
  }
  if (record.pr?.url) lines.push(`- The PR is open: ${record.pr.url}`);
  return lines.length ? `## This mission so far\n${lines.join('\n')}` : '';
}

/** A Builder whose harness took its role prompt only with its first message (ACP) is re-anchored on each one. */
export function needsRoleReminder(harness: HarnessId): boolean {
  const d = HARNESS_BY_ID[harness];
  return !!d && !d.capabilities.systemPrompt && harness !== 'codex';
}

/** One host message from several inbox entries; its card kind is theirs when they agree. */
export function combineInboxEntries(entries: InboxEntry[], reminder: boolean): { text: string; meta: MissionMessageMeta } {
  const kinds = new Set(entries.map((e) => e.kind));
  const builders = new Set(entries.map((e) => e.builderId));
  const kind: MissionMessageKind = kinds.size === 1 ? entries[0].kind : 'note';
  const builderId = builders.size === 1 ? entries[0].builderId : undefined;
  const requestId = entries.length === 1 ? entries[0].requestId : undefined;
  const body = entries.map((e) => e.text).join('\n\n---\n\n');
  return {
    text: reminder ? `${roleReminder('builder')}\n\n${body}` : body,
    meta: { kind, ...(builderId ? { builderId } : {}), ...(requestId ? { requestId } : {}) }
  };
}

export function approvalPromptText(builder: BuilderRecord, request: ApprovalRequest, route: ApprovalMissionRoute): string {
  const lines = [`${who(builder)} "${builder.title}" asks for permission: ${request.title}`];
  if (request.command) lines.push(`Command: ${clip(request.command, 2_000)}`);
  if (request.cwd) lines.push(`Folder: ${request.cwd}`);
  if (request.changes?.length) lines.push(`Files: ${request.changes.slice(0, 20).map((c) => c.path).join(', ')}`);
  if (request.toolName && !request.command) lines.push(`Tool: ${request.toolName}`);
  lines.push(`Request id: ${request.id}`, '');
  lines.push(route.route === 'lead'
    ? `The Builder waits for you. Answer with answer_request({ requestId: "${request.id}", decision: "allow" | "deny", note }).`
    : `Only the user can approve this: it ${route.reason ?? 'needs the user'}, and the user has been asked. Answer allow with answer_request to recommend it to the user, or deny it; you cannot approve it yourself.`);
  return lines.join('\n');
}

/** Puts a block before the Mission rules recap, which must stay last. */
export function beforeRecap(text: string, extra: string): string {
  const at = text.lastIndexOf('\n\n## Mission rules');
  return at >= 0 ? `${text.slice(0, at)}\n\n${extra}${text.slice(at)}` : `${extra}\n\n${text}`;
}

export function parseMissionRecord(raw: unknown, meta: SessionMeta): MissionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<MissionRecord>;
  if (r.v !== 1 || typeof r.id !== 'string' || r.id !== meta.mission?.missionId || r.leadId !== meta.id) return null;
  if (typeof r.projectRoot !== 'string' || typeof r.leadWorktree !== 'string' || typeof r.state !== 'string') return null;
  const builders = Array.isArray(r.builders) ? r.builders.filter((b): b is BuilderRecord => !!b && typeof b === 'object' && typeof b.id === 'string' && typeof b.sessionId === 'string') : [];
  const inbox = r.inbox && typeof r.inbox === 'object' ? r.inbox : { lead: [], builders: {} };
  return {
    ...(r as MissionRecord),
    git: r.git === true,
    leadWorktreeOwned: r.leadWorktreeOwned === true,
    builders: builders.map((b) => ({ ...b, failedChecks: typeof b.failedChecks === 'number' ? b.failedChecks : 0 })),
    inbox: { lead: Array.isArray(inbox.lead) ? inbox.lead : [], builders: inbox.builders && typeof inbox.builders === 'object' ? inbox.builders : {} }
  };
}
