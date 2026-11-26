/** Git inspection, landing, PR publishing, and Builder worktree cleanup actions for MissionService. */
import { errorMessage } from '../util/async';
import type { MissionToolResult } from './contracts';
import { findBuilder, makeInboxEntry, ok, refuse, who, type DeliveryTarget } from './format';
import { builderDiff, builderLog, currentHead, editPrBody, landOnLead, mergeBase, openPr, pushBranch } from './git-ops';
import type { BuilderRecord, InboxEntry, MissionRecord } from './record';
import { renderReport, reportTitle, type FinalReport } from './report';
import { cleanBuilderWorktree } from './sweep';

const LAND_WAIT_MS = 20_000;

export interface MissionGitActionsDeps {
  getRecord: (missionId: string) => MissionRecord | undefined;
  mutate: <T>(missionId: string, fn: (draft: MissionRecord) => T) => Promise<T>;
  enqueue: (missionId: string, target: DeliveryTarget, entry: Omit<InboxEntry, 'id' | 'ts'>) => Promise<void>;
  scheduleDelivery: (missionId: string, target: DeliveryTarget) => void;
  refreshGitState: (sessionId: string) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  landWaitMs?: number;
}

export async function inspectBuilderGitView(
  record: MissionRecord,
  builderId: string,
  kind: 'diff' | 'log',
  stat?: boolean
): Promise<MissionToolResult> {
  const builder = findBuilder(record, builderId);
  if (!record.git) refuse("This mission's folder is not a git repository, so there is no diff or log; ask the Builder what it changed.");
  let cwd: string;
  let from: string;
  let to: string | undefined;
  if (builder.worktree) {
    if (builder.cleaned) refuse(`${who(builder)}'s worktree was removed after its work landed; its commits are on your branch.`);
    cwd = builder.worktree.path;
    const base = await mergeBase(cwd, record.leadBranch ?? 'HEAD', builder.worktree.branch);
    if (!base.ok) refuse(base.error);
    from = (base as Extract<typeof base, { ok: true }>).sha;
  } else {
    cwd = record.leadWorktree;
    if (!builder.startSha) refuse(`${who(builder)} has no recorded start commit.`);
    from = builder.startSha!;
  }
  if (kind === 'diff') {
    const r = await builderDiff(cwd, { from, ...(to ? { to } : {}), stat: stat === true });
    if (!r.ok) refuse(r.error);
    const v = r as Extract<typeof r, { ok: true }>;
    const scope = builder.worktree ? `${who(builder)}'s worktree ${builder.worktree.path}` : `your shared worktree (it may include other Builders' uncommitted changes)`;
    return ok(`Changes in ${scope} since ${from.slice(0, 9)}:\n\n${v.text}`);
  }
  const r = await builderLog(cwd, { from, to: builder.worktree?.branch ?? 'HEAD' });
  if (!r.ok) refuse(r.error);
  const v = r as Extract<typeof r, { ok: true }>;
  return ok(`${v.count} commit(s) on ${builder.worktree?.branch ?? record.leadBranch ?? 'the branch'} since ${from.slice(0, 9)}${builder.worktree ? '' : ' (shared worktree: every Builder’s commits)'}:\n${v.text}`);
}

/** The background half of finish_mission: one plain push, then the PR (or the local ending). */
export async function publishMission(deps: MissionGitActionsDeps, missionId: string, report: FinalReport): Promise<void> {
  const record = deps.getRecord(missionId);
  if (!record?.leadBranch) return;
  const head = record.leadBranch;
  const base = record.baseBranch;
  const tell = (text: string) => deps.enqueue(missionId, 'lead', { kind: 'note', text }).catch((e) => deps.log('warn', `mission ${missionId}: could not queue the finish result: ${errorMessage(e)}`));
  const local = async (reason: string) => {
    const body = renderReport(report, { kind: 'local', reason, branch: head });
    await deps.mutate(missionId, (d) => {
      d.state = 'done_local';
      d.report = body;
    });
    await tell(`No PR was opened: ${reason} The work is on the local branch ${head}. Tell the user, with the report, briefly.`);
  };
  try {
    if (!base) return await local('the project had no branch checked out when the mission started, so there is no base branch for a PR.');
    const tip = await currentHead(record.leadWorktree);
    const sha = tip.ok ? tip.sha : undefined;
    if (record.pr) {
      const pushed = await pushBranch(record.leadWorktree, head);
      if (!pushed.ok) {
        if ('unavailable' in pushed && pushed.unavailable) return await local(pushed.error);
        return await tell(`finish_mission could not push ${head}: ${pushed.error} Fix that (a Builder can), then call finish_mission again.`);
      }
      const body = renderReport(report, { kind: 'pr', head, base, url: record.pr.url });
      const edited = await editPrBody(record.leadWorktree, record.pr.url, body);
      await deps.mutate(missionId, (d) => {
        d.state = 'pr_open';
        d.report = body;
        if (d.pr && sha) d.pr.lastPushedSha = sha;
      });
      deps.refreshGitState(record.leadId);
      return await tell(`Pushed the new commits to ${record.pr.url}.${edited.ok ? ' The PR description now carries the new report.' : ` The PR description could not be updated: ${edited.error}`} Tell the user, briefly.`);
    }
    const body = renderReport(report, { kind: 'pr', head, base });
    const pr = await openPr(record.leadWorktree, { base, head, title: reportTitle(report), body });
    if (!pr.ok) {
      if ('unavailable' in pr && pr.unavailable) return await local(pr.error);
      return await tell(`finish_mission could not open the PR: ${pr.error} Fix that, then call finish_mission again.`);
    }
    const opened = pr as Extract<typeof pr, { ok: true }>;
    const url = opened.url ?? '';
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]) || undefined;
    await deps.mutate(missionId, (d) => {
      d.state = 'pr_open';
      d.report = body;
      if (url) d.pr = { url, ...(number ? { number } : {}), ...(sha ? { lastPushedSha: sha } : {}) };
    });
    deps.refreshGitState(record.leadId);
    await tell(`${opened.existing ? 'A PR for this branch was already open' : 'The PR is open'}: ${url || '(gh printed no link)'} (${head} into ${base}), for the user to review; it is never merged automatically. Tell the user, briefly.`);
  } catch (e) {
    deps.log('warn', `mission ${missionId}: finishing failed: ${errorMessage(e)}`);
    await tell(`finish_mission failed: ${errorMessage(e)}. Call it again once the problem is fixed.`);
  }
}

export async function landBuilderOnLead(deps: MissionGitActionsDeps, missionId: string, builderId: string): Promise<MissionToolResult> {
  const record = deps.getRecord(missionId)!;
  const builder = findBuilder(record, builderId);
  if (!record.git || !builder.worktree || !record.leadBranch) refuse("You work in the Lead's folder, so there is nothing to land: commit your work and call report_done.");
  const wt = builder.worktree!;
  const landing = landOnLead({ missionId, leadWorktree: record.leadWorktree, leadBranch: record.leadBranch!, builderWorktree: wt.path, builderBranch: wt.branch }).then(async (r) => {
    if (r.ok && !r.alreadyLanded) {
      await deps.mutate(missionId, (d) => {
        const b = findBuilder(d, builderId);
        b.landed = true;
        d.inbox.lead.push(makeInboxEntry('note', `${who(b)} landed ${r.commits} commit(s) on ${record.leadBranch}; it is now at ${r.sha.slice(0, 9)}.`, { builderId: b.id }));
      }).catch((e) => deps.log('warn', `mission ${missionId}: could not record ${builderId}'s land: ${errorMessage(e)}`));
      deps.scheduleDelivery(missionId, 'lead');
    } else if (r.ok) {
      await deps.mutate(missionId, (d) => { findBuilder(d, builderId).landed = true; }).catch(() => undefined);
    }
    return r;
  });
  const wait = deps.landWaitMs ?? LAND_WAIT_MS;
  let timer: NodeJS.Timeout | undefined;
  const late = Symbol('late');
  const first = await Promise.race([landing, new Promise<typeof late>((resolve) => { timer = setTimeout(() => resolve(late), wait); timer.unref?.(); })]);
  clearTimeout(timer);
  const answer = (r: Awaited<typeof landing>): string => (r.ok
    ? r.alreadyLanded ? `Your branch is already on ${record.leadBranch}. Call report_done.` : `Landed ${r.commits} commit(s) on ${record.leadBranch}. Call report_done now.`
    : r.error);
  if (first !== late) return first.ok ? ok(answer(first)) : { text: answer(first), isError: true };
  void landing.then((r) => deps.enqueue(missionId, builderId, { kind: 'note', text: `land_on_lead finished: ${answer(r)}` })).catch(() => undefined);
  return ok('Landing is taking a while; it carries on in the background. End your turn: the app messages you with the result.');
}

/** Removes the matching Builders' worktrees one at a time and records what was removed. */
export async function cleanMissionBuilders(
  deps: Pick<MissionGitActionsDeps, 'getRecord' | 'mutate' | 'log'>,
  missionId: string,
  which: (b: BuilderRecord) => boolean,
  notes: string[] = []
): Promise<string[]> {
  const record = deps.getRecord(missionId);
  if (!record) return notes;
  for (const b of record.builders.filter(which)) {
    const current = deps.getRecord(missionId);
    const builder = current?.builders.find((x) => x.id === b.id);
    if (!current || !builder || builder.cleaned) continue;
    const outcome = await cleanBuilderWorktree(current, builder).catch((e: unknown) => ({ removed: false, note: errorMessage(e) }));
    if (outcome.removed) await deps.mutate(missionId, (d) => { findBuilder(d, b.id).cleaned = true; }).catch(() => undefined);
    if (outcome.note) {
      notes.push(outcome.note);
      deps.log('info', `mission ${missionId}: ${outcome.note}`);
    }
  }
  return notes;
}
