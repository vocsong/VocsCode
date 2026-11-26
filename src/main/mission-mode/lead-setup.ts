/** Lead session adoption, forking, and worktree planning for Mission mode startup. */
import { promises as fs } from 'node:fs';
import { branchSlug } from '../../shared/branch-prefix';
import type { SessionConfig, SessionMeta, UserInput } from '../../shared/types';
import { createWorktree, gitRoot } from '../git';
import { titleFromPrompt } from '../session-title';
import { errorMessage } from '../util/async';
import { createMissionRecord, samePath, type LeadPlan } from './format';
import { cleanupWorktree, currentHead, ensureLeadWorktree, MISSION_BRANCH_PREFIX, statusPorcelain } from './git-ops';
import type { MissionRecord } from './record';

export interface LeadSetupSessionPort {
  moveTo(id: string, cwd: string): Promise<unknown>;
  adoptMissionSession(id: string, opts: { mission: NonNullable<SessionMeta['mission']>; permissionMode: 'plan' }): Promise<unknown>;
  createMissionSession(opts: {
    config: SessionConfig;
    title: string;
    cwd: string;
    worktreeBranch?: string;
    mission: NonNullable<SessionMeta['mission']>;
    forkContextFrom?: string;
  }): Promise<SessionMeta>;
  delete(id: string, removeWorktree?: boolean): Promise<unknown>;
}

export interface LeadSetupDeps {
  sessions: LeadSetupSessionPort;
  recordFile: (leadId: string) => string;
  writeRecord: (record: MissionRecord) => Promise<void>;
  registerAndStart: (record: MissionRecord, input: UserInput, logMessage: string) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export async function removeMissionWorktree(
  record: Pick<MissionRecord, 'projectRoot' | 'leadBranch' | 'baseBranch'>,
  wt: { path: string; branch: string },
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
): Promise<void> {
  const r = await cleanupWorktree({
    projectRoot: record.projectRoot,
    path: wt.path,
    branch: wt.branch,
    mergedInto: [record.leadBranch, record.baseBranch].filter((b): b is string => !!b && b !== wt.branch)
  }).catch((e: unknown) => ({ ok: false as const, error: errorMessage(e) }));
  if (!r.ok) log('warn', `mission: could not remove the worktree ${wt.path}: ${r.error}`);
}

/** A new `mission/<slug>` worktree at the source checkout's HEAD; its uncommitted changes stay behind. */
async function newLeadWorktree(projectRoot: string, sourceCwd: string, slug: string): Promise<Omit<LeadPlan, 'owned' | 'created'>> {
  const [here, project] = await Promise.all([gitRoot(sourceCwd), gitRoot(projectRoot)]);
  if (!project) throw new Error('This folder is not a git repository.');
  if (!here || samePath(here, project)) {
    const wt = await ensureLeadWorktree(projectRoot, slug);
    if (!wt.ok) throw new Error(wt.error);
    const w = wt as Extract<typeof wt, { ok: true }>;
    return { cwd: w.path, branch: w.branch, ...(w.baseBranch ? { baseBranch: w.baseBranch } : {}), startSha: w.startSha, uncommittedAtStart: w.uncommittedAtStart };
  }
  // The source runs in a worktree of its own: the mission starts from that checkout.
  const head = await currentHead(sourceCwd);
  if (!head.ok) throw new Error("The session's folder has no commit checked out.");
  const h = head as Extract<typeof head, { ok: true }>;
  const status = await statusPorcelain(sourceCwd);
  const made = await createWorktree(project, branchSlug(slug) || 'mission', { branchPrefix: MISSION_BRANCH_PREFIX, startPoint: h.sha });
  return { cwd: made.path, branch: made.branch, ...(h.branch ? { baseBranch: h.branch } : {}), startSha: h.sha, uncommittedAtStart: status.ok ? !status.clean : false };
}

/** The empty-session toggle: reuse the worktree the session runs in, or make a new one. */
async function planLeadWorktree(source: SessionMeta, projectRoot: string, slug: string): Promise<LeadPlan> {
  let reuse: { cwd: string; branch: string; owned: boolean } | undefined;
  if (source.worktreeBranch) reuse = { cwd: source.cwd, branch: source.worktreeBranch, owned: true };
  else {
    const [here, project] = await Promise.all([gitRoot(source.cwd), gitRoot(projectRoot)]);
    if (here && project && !samePath(here, project)) {
      const head = await currentHead(source.cwd);
      if (!head.ok || !head.branch) throw new Error("The session's worktree has no branch checked out; check one out, then start the mission.");
      reuse = { cwd: source.cwd, branch: head.branch, owned: false };
    }
  }
  if (reuse) {
    const wt = await ensureLeadWorktree(projectRoot, slug, { cwd: reuse.cwd, branch: reuse.branch });
    if (!wt.ok) throw new Error(wt.error);
    const w = wt as Extract<typeof wt, { ok: true }>;
    return { cwd: w.path, branch: w.branch, ...(w.baseBranch ? { baseBranch: w.baseBranch } : {}), startSha: w.startSha, uncommittedAtStart: w.uncommittedAtStart, owned: reuse.owned };
  }
  const wt = await newLeadWorktree(projectRoot, source.cwd, slug);
  return { ...wt, owned: true, created: { path: wt.cwd, branch: wt.branch! } };
}

export async function adoptLeadSession(
  deps: LeadSetupDeps,
  source: SessionMeta,
  p: { missionId: string; projectRoot: string; git: boolean; slug: string; input: UserInput; uncommittedAtStart?: boolean; baseBranch?: string }
): Promise<{ leadId: string }> {
  const { sessions } = deps;
  const originalCwd = source.cwd;
  let plan: LeadPlan = { cwd: source.cwd, uncommittedAtStart: false, owned: false };
  if (p.git) {
    plan = await planLeadWorktree(source, p.projectRoot, p.slug);
    // A mission session can no longer move, so it moves into its worktree first.
    if (plan.created) {
      try {
        await sessions.moveTo(source.id, plan.created.path);
      } catch (e) {
        await removeMissionWorktree({ projectRoot: p.projectRoot, leadBranch: plan.branch, baseBranch: plan.baseBranch }, plan.created, deps.log);
        throw e;
      }
    }
  }
  const record = createMissionRecord(p.missionId, source.id, p.projectRoot, p.git, plan, p);
  const rollback = async () => {
    if (!plan.created) return;
    await sessions.moveTo(source.id, originalCwd).catch(() => undefined);
    await removeMissionWorktree({ projectRoot: p.projectRoot, leadBranch: plan.branch, baseBranch: plan.baseBranch }, plan.created, deps.log);
  };
  try {
    await deps.writeRecord(record);
  } catch (e) {
    await rollback();
    throw new Error(`The mission record could not be saved: ${errorMessage(e)}`);
  }
  try {
    await sessions.adoptMissionSession(source.id, { mission: { missionId: p.missionId, role: 'lead', state: 'running' }, permissionMode: 'plan' });
  } catch (e) {
    await fs.rm(deps.recordFile(source.id), { force: true }).catch(() => undefined);
    await rollback();
    throw e;
  }
  deps.registerAndStart(record, p.input, `[${source.id}] mission ${record.id} started in this session${record.leadBranch ? ` on ${record.leadBranch}` : ''}`);
  return { leadId: source.id };
}

export async function forkLeadSession(
  deps: LeadSetupDeps,
  source: SessionMeta,
  p: { missionId: string; projectRoot: string; git: boolean; slug: string; input: UserInput }
): Promise<{ leadId: string }> {
  const { sessions } = deps;
  let plan: LeadPlan = { cwd: p.projectRoot, uncommittedAtStart: false, owned: false };
  if (p.git) {
    const wt = await newLeadWorktree(p.projectRoot, source.cwd, p.slug);
    plan = { ...wt, owned: true, created: { path: wt.cwd, branch: wt.branch! } };
  }
  const cfg = source.config;
  const model = source.activeModel ?? cfg.model;
  const config: SessionConfig = {
    harness: cfg.harness,
    projectRoot: p.projectRoot,
    ...(model ? { model } : {}),
    ...(cfg.effort !== undefined ? { effort: cfg.effort } : {}),
    permissionMode: 'plan',
    useWorktree: p.git,
    ...(p.git ? { branchPrefix: MISSION_BRANCH_PREFIX } : cfg.branchPrefix ? { branchPrefix: cfg.branchPrefix } : {}),
    ...(cfg.acpAgent ? { acpAgent: cfg.acpAgent } : {}),
    ...(cfg.appendSystemPrompt ? { appendSystemPrompt: cfg.appendSystemPrompt } : {}),
    ...(cfg.maxBudgetUsd !== undefined ? { maxBudgetUsd: cfg.maxBudgetUsd } : {}),
    ...(cfg.codexModelProvider ? { codexModelProvider: cfg.codexModelProvider } : {})
  };
  let lead: SessionMeta;
  try {
    lead = await sessions.createMissionSession({
      config,
      title: titleFromPrompt(p.input.text),
      cwd: plan.cwd,
      ...(plan.created ? { worktreeBranch: plan.created.branch } : {}),
      mission: { missionId: p.missionId, role: 'lead', state: 'running' },
      forkContextFrom: source.id
    });
  } catch (e) {
    if (plan.created) await removeMissionWorktree({ projectRoot: p.projectRoot, leadBranch: plan.branch, baseBranch: plan.baseBranch }, plan.created, deps.log);
    throw e;
  }
  const record = createMissionRecord(p.missionId, lead.id, p.projectRoot, p.git, plan, {});
  try {
    await deps.writeRecord(record);
  } catch (e) {
    await sessions.delete(lead.id).catch(() => undefined);
    if (plan.created) await removeMissionWorktree({ projectRoot: p.projectRoot, leadBranch: plan.branch, baseBranch: plan.baseBranch }, plan.created, deps.log);
    throw new Error(`The mission record could not be saved: ${errorMessage(e)}`);
  }
  deps.registerAndStart(record, p.input, `[${lead.id}] mission ${record.id} started from ${source.id}${record.leadBranch ? ` on ${record.leadBranch}` : ''}`);
  return { leadId: lead.id };
}
