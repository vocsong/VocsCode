/**
 * Mission ownership boundary guards, Zod schemas, and scoped read/diff helpers
 * shared across IPC handler registrars. Electron-free.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { channelsWithMissionGuard } from '../../shared/ipc-policy';
import type { MissionCodeRevision, MissionRecord } from '../../shared/mission';
import type { SessionMeta } from '../../shared/types';
import { gitDiff, gitFolderBranch, gitRoot, gitWorktrees } from '../git';
import { isOutsideWorkspace } from '../harness/permissions';
import { missionDeliveryBranch } from '../mission/delivery';
import type { TargetObservation } from '../mission/workspaces';
import { runCapture, which } from '../runtime';
import type { HandlerDeps, MissionBoundaryGuard, MissionHandlerService, MissionReadScope } from './types';

export const missionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/, 'Invalid Mission/session identifier');
export const missionKeySchema = z.string().min(1).max(200);
export const missionTextSchema = z.string().min(1).max(100_000).refine((text) => !!text.trim(), 'Text must not be empty');
export const missionImageSchema = z.strictObject({ mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i), data: z.string().min(1).max(32_000_000), name: z.string().max(1000).optional() });
export const missionImagesSchema = z.array(missionImageSchema).max(100).optional();
export const missionFileSchema = z.strictObject({
  name: z.string().min(1).max(255), mimeType: z.string().min(1).max(200),
  data: z.string().min(1).max(Math.ceil(10 * 1024 * 1024 / 3) * 4 + 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'Invalid file encoding')
});
export const missionFilesSchema = z.array(missionFileSchema).max(10).refine(
  (files) => files.reduce((size, file) => size + Buffer.byteLength(file.data, 'base64'), 0) <= 30 * 1024 * 1024,
  'Attachments exceed 30 MiB per message'
).optional();
export const missionCreateSchema = z.strictObject({
  idempotencyKey: missionKeySchema, projectRoot: missionTextSchema, originSessionId: missionIdSchema.optional(),
  objective: missionTextSchema, mode: z.enum(['interactive_plan', 'autonomous']), leadPresetId: missionIdSchema.optional(),
  permissionMode: z.enum(['ask', 'accept-edits', 'plan', 'auto', 'full-auto']), submittedCommand: missionTextSchema.optional(), images: missionImagesSchema, files: missionFilesSchema
});
export const missionControlSchema = z.strictObject({
  missionId: missionIdSchema, idempotencyKey: missionKeySchema, expectedRevision: z.number().int().nonnegative(), submittedCommand: missionTextSchema.optional(),
  control: z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('execute'), proposalId: missionIdSchema, specificationRevision: z.number().int().positive() }),
    z.strictObject({ action: z.enum(['pause', 'resume', 'stop', 'continue_planning', 'cleanup', 'apply_configuration']) }),
    z.strictObject({ action: z.literal('steer'), text: missionTextSchema, images: missionImagesSchema, files: missionFilesSchema }),
    z.strictObject({ action: z.literal('replace_lead'), presetId: missionIdSchema }),
    z.strictObject({ action: z.literal('narrow_delivery'), endpoint: z.enum(['local_commit', 'open_pr']) })
  ])
});
export const missionCommandSchema = z.strictObject({ sessionId: missionIdSchema, text: missionTextSchema, idempotencyKey: missionKeySchema, images: missionImagesSchema, files: missionFilesSchema });
export const missionInputSchema = z.strictObject({ text: z.string().max(100_000), images: missionImagesSchema, files: missionFilesSchema, mode: z.enum(['now', 'steer', 'queue']).optional() });

/** All generic writer/lifecycle entry points must pass the same resource check, including
 * ordinary-session aliases. Derived from the exhaustive `IPC_CHANNEL_POLICY` table. */
const MISSION_SESSION_CONTROLS = channelsWithMissionGuard('session-control');
const MISSION_GIT_MUTATIONS = channelsWithMissionGuard('git-mutation', 'git-repo-mutation');
const MISSION_REPO_MUTATIONS = channelsWithMissionGuard('git-repo-mutation');
const MISSION_PROJECT_WRITES = channelsWithMissionGuard('project-write');
const MISSION_TERMINAL_CONTROLS = channelsWithMissionGuard('terminal-control');
/** Every keystroke and resize. Checked synchronously so input reaches the PTY in order and never
 * waits on, or fails with, a filesystem round-trip (terminal:ack/detach carry no authority). */
const MISSION_TERMINAL_IO = channelsWithMissionGuard('terminal-io');

/** Every delivery branch execution can use for this Mission, named by missionDeliveryBranch
 * itself: the plain branch and, after an approved-target integration, one per retained target
 * observation for the current accepted revision and for each recorded delivery request's. */
function missionDeliveryBranches(mission: MissionRecord): string[] {
  const observations = mission.operations.flatMap((op) => {
    const observed = op.kind === 'integrate' && op.payload.target === 'approved' ? op.payload.targetObservation as TargetObservation | undefined : undefined;
    return observed && typeof observed.id === 'string' ? [observed] : [];
  });
  const revisions = [mission.acceptedRevision, ...mission.operations.flatMap((op) => op.kind === 'deliver' && op.payload.expectedAccepted ? [op.payload.expectedAccepted as MissionCodeRevision] : [])];
  const branches = new Set([missionDeliveryBranch(mission)]);
  for (const acceptedRevision of revisions) for (const observed of observations) branches.add(missionDeliveryBranch({ ...mission, acceptedRevision }, observed));
  return [...branches];
}

export function createMissionBoundaryGuard(deps: HandlerDeps): MissionBoundaryGuard {
  const { sessions, terminals } = deps;

  const missionService = (): MissionHandlerService => {
    if (!deps.missions) throw new Error('Mission service is unavailable in this run.');
    return deps.missions;
  };
  const sessionFor = (id: unknown): SessionMeta => {
    const session = sessions.get(missionIdSchema.parse(id));
    if (!session) throw new Error('Session not found');
    return session;
  };
  const missionFor = (session: SessionMeta): MissionRecord | undefined => {
    const record = session.mission ? deps.missions?.get(session.mission.missionId) : deps.missions?.list().find((m) =>
      m.leadSessionId === session.id || m.attempts.some((a) => a.sessionId === session.id) || m.workspaces.some((w) => w.ownerSessionId === session.id));
    if (session.mission && !record) throw new Error('Mission ownership cannot be resolved. Resume/reconcile the Mission before changing this session.');
    return record;
  };
  const denyMissionControl = (): never => { throw new Error('Mission owns this session/workspace. Use the principal engineer and Mission controls; generic changes cannot reconcile owned work.'); };
  const isLead = (session: SessionMeta, mission: MissionRecord): boolean => mission.leadSessionId === session.id && session.mission?.role !== 'worker';
  const requireLead = (session: SessionMeta, mission: MissionRecord): void => {
    if (!isLead(session, mission)) throw new Error('Mission workers are read-only. Send instructions to the principal engineer instead.');
  };
  const pathKey = (p: string): string => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  const containsPath = (root: string, target: string): boolean => !isOutsideWorkspace(root, target, path);
  // Resolve existing ancestors too: a missing leaf below a junction must not escape ownership.
  const realResource = async (p: string): Promise<string> => {
    const absolute = path.resolve(missionTextSchema.parse(p));
    try { return pathKey(await fs.realpath(absolute)); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!['ENOENT', 'ENOTDIR'].includes(code)) {
        // EPERM/EACCES/EBUSY and friends (network shares, locked or odd paths) must not fail an
        // ordinary request. Compare the lexical path: Mission roots are recorded canonical, so a
        // path inside one still matches; only a link the host cannot resolve right now escapes.
        deps.log('debug', `mission guard: realpath failed (${code || 'unknown'}); comparing the lexical path`);
        return pathKey(absolute);
      }
      const parent = path.dirname(absolute);
      if (parent === absolute) return pathKey(absolute);
      return pathKey(path.join(await realResource(parent), path.basename(absolute)));
    }
  };
  async function workspaceOwners(target: string, includeDescendants = false) {
    const real = await realResource(target);
    const owners: Array<{ mission: MissionRecord; workspace: MissionRecord['workspaces'][number] }> = [];
    for (const mission of deps.missions?.list() ?? []) for (const workspace of mission.workspaces) {
      if (workspace.cleanedAt !== undefined) continue;
      const root = await realResource(workspace.path);
      if (containsPath(root, real) || includeDescendants && containsPath(real, root)) owners.push({ mission, workspace });
    }
    return owners;
  }
  async function assertOrdinaryWorkspace(target: string, includeDescendants = false): Promise<void> {
    if (deps.missions && (await workspaceOwners(target, includeDescendants)).length) denyMissionControl();
    // A corrupt Mission journal must not turn retained managed sessions into ordinary writable
    // aliases. Session ownership is a second, independent fence; planning's original source is
    // not a managed worktree and deliberately has no worktreeBranch marker.
    const real = await realResource(target);
    for (const session of sessions.list().filter((s) => s.mission && s.worktreeBranch)) {
      const root = await realResource(session.cwd);
      if (containsPath(root, real) || includeDescendants && containsPath(real, root)) denyMissionControl();
    }
  }
  async function assertOrdinarySession(id: unknown): Promise<SessionMeta> {
    const session = sessionFor(id);
    if (missionFor(session)) denyMissionControl();
    await assertOrdinaryWorkspace(session.cwd);
    return session;
  }
  const assertLeadShell = (session: SessionMeta, mission: MissionRecord): void => {
    requireLead(session, mission);
    if (!mission.executionAuthorization || session.mission?.sourceAccess === 'read_only' || mission.status !== 'running' || mission.phase !== 'executing') throw new Error('Mission planning, paused and non-executing workspaces do not allow interactive shells.');
  };
  async function assertInteractiveWorkspace(session: SessionMeta | undefined, cwd: string): Promise<void> {
    const mission = session && missionFor(session);
    if (mission) assertLeadShell(session!, mission);
    else await assertOrdinaryWorkspace(cwd);
    const owners = await workspaceOwners(cwd);
    if (mission && !owners.length) denyMissionControl();
    for (const owner of owners) {
      if (!session || !isLead(session, owner.mission) || owner.workspace.role !== 'lead' || owner.workspace.ownerSessionId !== session.id) denyMissionControl();
    }
  }
  async function assertOrdinaryBranch(session: SessionMeta, branches: unknown[], repositoryWide = false): Promise<Set<string>> {
    const protectedBranches = new Set<string>();
    const candidates = (deps.missions?.list() ?? []).filter((m) => m.workspaces.some((w) => w.cleanedAt === undefined));
    if (!candidates.length) return protectedBranches;
    const root = await realResource(session.config.projectRoot);
    let registered: Awaited<ReturnType<typeof gitWorktrees>> | undefined;
    for (const mission of candidates) {
      let sameRepo = root === await realResource(mission.projectRoot);
      if (!sameRepo) {
        // A session can have been opened in another worktree with a different projectRoot label.
        registered ??= await gitWorktrees(session.cwd);
        for (const workspace of mission.workspaces.filter((w) => w.cleanedAt === undefined)) {
          const actual = await realResource(workspace.path);
          if ((await Promise.all(registered.worktrees.map((w) => realResource(w.path)))).includes(actual)) { sameRepo = true; break; }
        }
      }
      if (!sameRepo) continue;
      if (repositoryWide) denyMissionControl();
      const ownedBranches = new Set([...mission.workspaces.filter((w) => w.cleanedAt === undefined).map((w) => w.branch), ...missionDeliveryBranches(mission)]);
      for (const branch of ownedBranches) protectedBranches.add(branch);
      for (const branch of branches) {
        if (typeof branch === 'string' && ownedBranches.has(branch.trim().replace(/^refs\/heads\//, '').split(':').at(-1)!)) denyMissionControl();
      }
    }
    return protectedBranches;
  }
  /** Nothing is Mission-owned until a Mission record or a host-created owned session exists: a
   * user who never starts a Mission pays for no resource check (no realpath, no Git probe). */
  const missionOwnershipPossible = (): boolean => sessions.list().some((s) => !!s.mission) || !!deps.missions?.list().length;
  /** Terminal id → verdict of its last full resource check (create, attach and restart establish
   * one; any refused terminal control revokes it), bound to the cwd it covered. Keystrokes and
   * resizes reuse it instead of resolving paths per PTY event. */
  const terminalVerdicts = new Map<string, { cwd: string; allowed: boolean }>();
  const recordTerminalVerdict = (terminal: { id: string; cwd: string }, allowed: boolean): void => {
    const live = new Set(terminals.list().map((t) => t.id));
    for (const id of terminalVerdicts.keys()) if (!live.has(id)) terminalVerdicts.delete(id);
    terminalVerdicts.set(terminal.id, { cwd: pathKey(terminal.cwd), allowed });
  };
  /** Synchronous, lexical-only ownership: Mission roots are recorded canonical. */
  const lexicallyMissionOwned = (target: string): boolean => {
    const key = pathKey(target);
    const roots = [...(deps.missions?.list() ?? []).flatMap((m) => m.workspaces.filter((w) => w.cleanedAt === undefined).map((w) => w.path)),
      ...sessions.list().filter((s) => s.mission && s.worktreeBranch).map((s) => s.cwd)];
    return roots.some((root) => containsPath(pathKey(root), key));
  };
  /** Synchronous by design (MISSION_TERMINAL_IO): the owning session's metadata plus the verdict of
   * this terminal's last full check. An owned session's shell still needs its live executing lead. */
  function guardTerminalIo(req: Record<string, unknown>): void {
    const terminal = terminals.list().find((t) => t.id === req.terminalId);
    if (!terminal) return; // the handler reports an unknown terminal itself
    const session = sessions.get(terminal.sessionId);
    if (session?.mission) {
      const mission = deps.missions?.get(session.mission.missionId);
      if (!mission) throw new Error('Mission ownership cannot be resolved. Resume/reconcile the Mission before changing this session.');
      assertLeadShell(session, mission);
    }
    const verdict = terminalVerdicts.get(terminal.id);
    if (verdict?.cwd === pathKey(terminal.cwd)) {
      if (!verdict.allowed) denyMissionControl();
      return;
    }
    // Not fully checked yet: a restored tab only buffers input until its first attach, which runs
    // the full check before any shell starts. Refuse anything lexically inside a Mission root.
    if (lexicallyMissionOwned(terminal.cwd)) denyMissionControl();
  }
  /** The resource check a generic writer/lifecycle channel needs, or undefined when it needs none. */
  function missionResourceCheck(channel: string, req: Record<string, unknown>, actor: 'user' | 'agent'): (() => Promise<void>) | undefined {
    if (MISSION_SESSION_CONTROLS.has(channel)) return async () => {
      const session = await assertOrdinarySession(req.id);
      if (channel === 'sessions:moveTo') await assertOrdinaryWorkspace(missionTextSchema.parse(req.cwd));
      if (channel.startsWith('agents:') || channel.startsWith('claude-agents:')) await assertOrdinaryWorkspace(session.config.projectRoot);
    };
    if (channel === 'sessions:send' || channel === 'sessions:archive') return async () => {
      const session = sessionFor(req.id);
      const mission = missionFor(session);
      if (mission) {
        requireLead(session, mission);
        if (actor !== 'user') throw new Error('Mission user actions cannot originate from an agent tool.');
      } else await assertOrdinaryWorkspace(session.cwd);
    };
    if (channel === 'sessions:create') {
      const config = req.config && typeof req.config === 'object' ? req.config as Record<string, unknown> : {};
      const projectRoot = config.projectRoot;
      if (typeof projectRoot !== 'string') return undefined;
      return async () => {
        await assertOrdinaryWorkspace(projectRoot);
        // Starting a new worktree branch from a Mission branch is held to the same boundary as checking it out.
        if (req.checkoutBranch || req.worktreeBase) await assertOrdinaryBranch({ cwd: projectRoot, config } as unknown as SessionMeta, [req.checkoutBranch, req.worktreeBase]);
      };
    }
    if (channel === 'folders:remove') {
      const missions = deps.missions;
      if (!missions) return undefined;
      return async () => {
        const root = await realResource(missionTextSchema.parse(req.root));
        for (const mission of missions.list()) if (await realResource(mission.projectRoot) === root) denyMissionControl();
        for (const session of sessions.list().filter((s) => pathKey(s.config.projectRoot) === pathKey(String(req.root)))) await assertOrdinarySession(session.id);
        await assertOrdinaryWorkspace(String(req.root), true);
      };
    }
    if (MISSION_GIT_MUTATIONS.has(channel)) return async () => {
      const session = await assertOrdinarySession(req.sessionId);
      if (typeof req.path === 'string') await assertOrdinaryWorkspace(path.resolve(session.cwd, req.path), channel === 'git:removeWorktree');
      const currentBranch = deps.missions?.list().some((m) => m.workspaces.some((w) => w.cleanedAt === undefined)) ? (await gitFolderBranch(session.cwd)).branch : undefined;
      await assertOrdinaryBranch(session, [req.branch, req.head, req.base, session.worktreeBranch, currentBranch], MISSION_REPO_MUTATIONS.has(channel));
    };
    if (MISSION_PROJECT_WRITES.has(channel) || channel === 'mcp:import' && req.to === 'repo') return async () => {
      const session = await assertOrdinarySession(req.sessionId);
      await assertOrdinaryWorkspace(session.config.projectRoot);
    };
    if (channel === 'terminal:create') return async () => {
      const session = sessionFor(req.sessionId);
      await assertInteractiveWorkspace(session, session.cwd);
    };
    if (MISSION_TERMINAL_CONTROLS.has(channel)) return async () => {
      const terminal = terminals.list().find((t) => t.id === req.terminalId);
      if (!terminal) throw new Error('Terminal not found');
      try { await assertInteractiveWorkspace(sessionFor(terminal.sessionId), terminal.cwd); }
      catch (e) { recordTerminalVerdict(terminal, false); throw e; }
      if (channel === 'terminal:attach' || channel === 'terminal:restart') recordTerminalVerdict(terminal, true);
    };
    if (channel === 'app:openTerminal') return async () => { await assertInteractiveWorkspace(undefined, missionTextSchema.parse(req.cwd)); };
    if (channel === 'app:openInEditor' && deps.missions) return async () => {
      const session = sessionFor(req.sessionId);
      await assertOrdinaryWorkspace(path.resolve(session.cwd, missionTextSchema.parse(req.path)));
    };
    return undefined;
  }
  /** Mission ownership at generic channels (V23/V24). Returns a promise only when a filesystem/Git
   * check must finish first; unguarded channels, keystrokes and any request made while nothing can
   * be Mission-owned are decided synchronously. */
  function guardMissionBoundary(channel: string, input: unknown, actor: 'user' | 'agent'): Promise<void> | undefined {
    if (actor === 'agent' && (channel.startsWith('missions:') || channel === 'app:fileSaveAs')) throw new Error('User export and Mission actions cannot originate from an agent tool.');
    const req = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    if (actor === 'agent' && channel === 'sessions:send' && typeof req.id === 'string' && sessions.get(req.id)?.config.harness === 'antigravity') {
      throw new Error('Antigravity sessions are driven by direct user prompts.');
    }
    if (channel === 'sessions:create') {
      const config = req.config && typeof req.config === 'object' ? req.config as Record<string, unknown> : {};
      if (actor === 'agent' && config.harness === 'antigravity') throw new Error('Antigravity sessions are driven by direct user prompts.');
      if (['mission', 'missionId', 'missionRole', 'ownership', 'activeAttemptId'].some((key) => key in req || key in config)) throw new Error('Mission ownership is host-only; use missions:create.');
    }
    if (MISSION_TERMINAL_IO.has(channel)) {
      guardTerminalIo(req);
      return undefined;
    }
    const check = missionResourceCheck(channel, req, actor);
    if (!check) return undefined;
    if (!missionOwnershipPossible()) {
      // Nothing can own this terminal's cwd yet, and a later Mission only provisions fresh roots.
      if (channel === 'terminal:attach' || channel === 'terminal:restart') {
        const terminal = terminals.list().find((t) => t.id === req.terminalId);
        if (terminal) recordTerminalVerdict(terminal, true);
      }
      return undefined;
    }
    return check();
  }
  async function missionReadScope(sessionId: string, workspaceId?: string): Promise<MissionReadScope> {
    const session = sessionFor(sessionId);
    const mission = missionFor(session);
    if (workspaceId !== undefined) {
      missionIdSchema.parse(workspaceId);
      if (!mission || !isLead(session, mission)) throw new Error('Only the owning Mission lead can select a Mission workspace.');
    }
    if (!mission || !isLead(session, mission)) return { cwd: session.cwd, session };
    const workspace = workspaceId === undefined ? mission.workspaces.find((w) => w.role === 'integration' && w.cleanedAt === undefined) : mission.workspaces.find((w) => w.id === workspaceId && w.cleanedAt === undefined);
    if (!workspace) throw new Error('Mission workspace is unavailable or cleaned. No integration result is ready yet.');
    const cwd = await fs.realpath(workspace.path);
    // Provisioning records canonical roots. A replaced root/junction cannot redirect inspection.
    if (pathKey(cwd) !== pathKey(workspace.path) || !(await fs.stat(cwd)).isDirectory()) throw new Error('Mission workspace path changed; reconcile before inspecting it.');
    return { cwd, mission, workspace, session };
  }
  function assertPreviewWriteScope(scope: MissionReadScope): void {
    const mission = scope.mission ?? missionFor(scope.session);
    if (!mission) return;
    requireLead(scope.session, mission);
    if (scope.workspace?.role !== 'lead' || scope.workspace.ownerSessionId !== scope.session.id ||
        !mission.executionAuthorization || scope.session.mission?.sourceAccess === 'read_only' ||
        scope.session.archived || mission.archived || mission.status !== 'running' || mission.phase !== 'executing') {
      throw new Error('Only the active Mission lead’s own executing workspace is editable.');
    }
  }
  async function assertPreviewWriteTarget(scope: MissionReadScope, target: string): Promise<void> {
    if (!scope.workspace || !scope.mission) {
      // An ordinary session can overlap a managed worktree; containing a path is not enough.
      if (missionOwnershipPossible()) await assertOrdinaryWorkspace(target);
      return;
    }
    const owners = await workspaceOwners(target);
    if (!owners.length || owners.some(owner => owner.mission.id !== scope.mission!.id || owner.workspace.id !== scope.workspace!.id)) denyMissionControl();
  }
  async function missionDiff(sessionId: string, workspaceId?: string, file?: string, staged?: boolean): Promise<{ diff: string; error?: string }> {
    const scope = await missionReadScope(sessionId, workspaceId);
    if (!scope.mission || !scope.workspace) return gitDiff(scope.cwd, file, staged);
    let relative: string | undefined;
    if (file !== undefined) {
      missionTextSchema.parse(file);
      const target = path.resolve(scope.cwd, file);
      if (!containsPath(scope.cwd, target) || !containsPath(pathKey(scope.cwd), await realResource(target))) throw new Error('Path outside Mission workspace.');
      relative = path.relative(scope.cwd, target).split(path.sep).join('/');
    }
    if (scope.workspace.role !== 'integration') return gitDiff(scope.cwd, relative, staged);
    const baseline = scope.mission.baseline?.contentHash;
    const accepted = scope.mission.acceptedRevision?.contentHash;
    if (!baseline || !accepted) return { diff: '', error: 'No accepted Mission result is available yet.' };
    if (![baseline, accepted].every((sha) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))) throw new Error('Invalid Mission Git object identity.');
    if (pathKey(await gitRoot(scope.cwd) ?? '') !== pathKey(scope.cwd)) throw new Error('Mission integration workspace is not a valid Git root.');
    // Literal pathspecs plus an argv separator prevent flags/pathspec magic. Disable external
    // diff/textconv hooks and inherited Git routing so a read cannot execute project programs.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    const result = await runCapture(which('git') ?? 'git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', baseline, accepted, '--', ...(relative ? [relative] : [])], {
      cwd: scope.cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }, timeoutMs: 60_000
    });
    if (result.timedOut || result.truncated || result.code !== 0) return { diff: '', error: result.timedOut ? 'Mission diff timed out.' : result.truncated ? 'Mission diff was truncated; select a smaller file.' : `Mission diff failed: ${result.stderr.trim()}` };
    return { diff: result.stdout };
  }

  return {
    missionService,
    sessionFor,
    missionFor,
    requireLead,
    pathKey,
    realResource,
    assertOrdinaryWorkspace,
    assertOrdinarySession,
    assertOrdinaryBranch,
    missionOwnershipPossible,
    recordTerminalVerdict,
    guardMissionBoundary,
    missionReadScope,
    assertPreviewWriteScope,
    assertPreviewWriteTarget,
    missionDiff
  };
}
