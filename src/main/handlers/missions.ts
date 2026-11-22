/**
 * Mission IPC handlers (`missions:*`).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MissionRecord, MissionUserControl } from '../../shared/mission';
import { MISSION_NOT_LINKED_MESSAGE, parseMissionCommand } from '../../shared/mission-command';
import { missionRevisionConflictMessage } from '../../shared/mission-errors';
import { gitRoot } from '../git';
import { missionPlanMarkdown } from '../mission/context';
import { missionCommandSchema, missionControlSchema, missionCreateSchema, missionIdSchema } from './mission-guard';
import type { HandlerContext } from './types';

export function registerMissionHandlers(ctx: HandlerContext): void {
  const { deps, handle, knownFolder, missionGuard } = ctx;
  const { missionService, sessionFor, missionFor, requireLead, realResource, assertOrdinaryWorkspace } = missionGuard;

  async function createMission(input: unknown): Promise<MissionRecord> {
    const request = missionCreateSchema.parse(input);
    if (!path.isAbsolute(request.projectRoot)) throw new Error('Choose an absolute project folder.');
    if (request.originSessionId) {
      const source = sessionFor(request.originSessionId);
      const mission = missionFor(source);
      if (mission) requireLead(source, mission);
      else await assertOrdinaryWorkspace(source.cwd);
      if (await realResource(request.projectRoot) !== await realResource(source.config.projectRoot)) throw new Error('Source session belongs to a different project.');
      // Never let renderer fields choose the source cwd or its model. The permission mode is the
      // caller's explicit choice: the launch dialog's "Mission permissions" (which must win, so a
      // narrower choice is never widened back to the source's), or for a typed /mission, which has
      // no dialog, the source's own mode as missions:command passes it.
      request.projectRoot = source.config.projectRoot;
    } else {
      if (!knownFolder(request.projectRoot)) throw new Error('Choose a known project folder or pick one in New Session.');
      await assertOrdinaryWorkspace(request.projectRoot);
    }
    const stat = await fs.stat(request.projectRoot).catch(() => null);
    if (!stat?.isDirectory()) throw new Error('Project folder does not exist.');
    if (!(await gitRoot(request.projectRoot))) throw new Error('Mission requires a Git project. Initialize the project explicitly before launching.');
    return missionService().create(request);
  }

  async function controlMission(input: unknown): Promise<MissionRecord> {
    const request = missionControlSchema.parse(input);
    const mission = missionService().get(request.missionId);
    if (!mission) throw new Error('Mission not found.');
    // The recognised pre-commit conflict, so the UI retires the stale request and binds the newer
    // record instead of replaying the same expectedRevision on every later click.
    if (request.expectedRevision !== mission.revision) throw new Error(missionRevisionConflictMessage(request.expectedRevision, mission.revision));
    if (request.control.action === 'execute') {
      const proposal = mission.pendingProposal;
      if (!proposal || proposal.id !== request.control.proposalId || proposal.specificationRevision !== request.control.specificationRevision ||
          proposal.specificationRevision !== mission.specificationRevision || proposal.planRevision !== mission.planRevision) throw new Error('No current ready plan proposal matches this approval. Refresh the Mission.');
    }
    return missionService().control(request);
  }

  handle('missions:list', (req) => {
    if (req != null) throw new Error('missions:list takes no arguments.');
    return deps.missions?.list() ?? [];
  });
  handle('missions:get', (req) => {
    const { missionId } = z.strictObject({ missionId: missionIdSchema }).parse(req);
    return deps.missions?.get(missionId) ?? null;
  });
  handle('missions:exportPlan', (req) => {
    const { missionId } = z.strictObject({ missionId: missionIdSchema }).parse(req);
    const record = missionService().get(missionId);
    if (!record) throw new Error('Mission not found.');
    return { markdown: missionPlanMarkdown(record), suggestedName: 'plan.md' };
  });
  handle('missions:create', createMission);
  handle('missions:control', controlMission);
  handle('missions:command', async (input) => {
    const req = missionCommandSchema.parse(input);
    const command = parseMissionCommand(req.text);
    if (!command) throw new Error('Use the exact /mission command. /missionary is not a Mission command.');
    if (command.kind === 'error') throw new Error(command.message);
    if ((req.images?.length || req.files?.length) && command.kind !== 'launch') throw new Error('Mission controls and the creation dialog cannot take attachments. Add an objective to /mission to send them as context, or remove them before using a control.');
    const source = sessionFor(req.sessionId);
    let mission = missionFor(source);
    if (mission) requireLead(source, mission);
    else await assertOrdinaryWorkspace(source.cwd);
    if (command.kind === 'show') return { kind: 'show', ...(mission ? { mission, sessionId: mission.leadSessionId } : {}) };
    if (command.kind === 'control' && command.action === 'status') {
      return mission ? { kind: 'status', mission, sessionId: mission.leadSessionId } : { kind: 'status', message: MISSION_NOT_LINKED_MESSAGE };
    }
    if (command.kind === 'launch' && (!mission || command.explicit)) {
      const created = await createMission({ idempotencyKey: req.idempotencyKey, projectRoot: source.config.projectRoot, originSessionId: source.id,
        objective: command.objective, mode: command.mode, permissionMode: mission?.requestedPermissionMode ?? source.config.permissionMode, submittedCommand: req.text, ...(req.images?.length ? { images: req.images } : {}), ...(req.files?.length ? { files: req.files } : {}) });
      return { kind: 'created', mission: created, sessionId: created.leadSessionId };
    }
    if (!mission) throw new Error('Open a Mission first, or use /mission <objective> to create one.');
    const apply = async (control: MissionUserControl, suffix = '') => {
      mission = await controlMission({ missionId: mission!.id, expectedRevision: mission!.revision, idempotencyKey: `${req.idempotencyKey}${suffix}`, control, submittedCommand: req.text });
    };
    if (command.kind === 'control') {
      if (command.action === 'execute') {
        if (!mission.pendingProposal) throw new Error('No ready plan proposal is awaiting execution approval.');
        await apply({ action: 'execute', proposalId: mission.pendingProposal.id, specificationRevision: mission.pendingProposal.specificationRevision });
      } else if (command.action !== 'status') await apply({ action: command.action });
    } else {
      if (['completed', 'stopped', 'failed'].includes(mission.status)) throw new Error('This Mission is terminal. Use /mission start -- <objective> for a linked follow-up.');
      if (command.mode === 'interactive_plan') {
        if (mission.phase !== 'planning' && mission.status !== 'paused') await apply({ action: 'pause' }, ':pause');
        await apply({ action: 'continue_planning' }, ':planning');
      }
      // Retain the actual command and attachments through the same host user-input path as
      // chat. It restores the original received revision on a lost-reply retry; rebinding a
      // control to today's revision would either duplicate the input or reject an exact retry.
      await missionService().sendUser(source.id, { text: req.text, ...(req.images?.length ? { images: req.images } : {}), ...(req.files?.length ? { files: req.files } : {}) }, `${req.idempotencyKey}:steer`);
      mission = missionService().get(mission.id);
      if (!mission) throw new Error('Mission state is unavailable after retaining the command. Retry the same input.');
    }
    return { kind: 'updated', mission, sessionId: mission!.leadSessionId };
  });
}
