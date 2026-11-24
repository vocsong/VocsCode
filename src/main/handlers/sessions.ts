/** Session lifecycle, chat import, mission mode, subagents/agents, housekeep, approvals, and Vesta handlers. */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { MAX_HOUSEKEEP_RECENT_DAYS } from '../../shared/housekeep';
import { PUSH_CHANNELS } from '../../shared/ipc';
import { transcriptPage } from '../../shared/transcript-page';
import { deleteProjectAgent, listProjectAgents, readProjectAgent, saveProjectAgent, setProjectAgentTracked } from '../agent-files';
import { Vesta } from '../agents';
import { discoverChatImports } from '../chat-import';
import { representsChatImport } from '../chat-import-identity';
import { createClaudeAgent, isPinnedModel, listClaudeAgents, setClaudeAgentModel } from '../claude-agents';
import { configuredHousekeepReviewer, HousekeepService } from '../housekeep';
import { scanHousekeepInventory } from '../housekeep-inventory';
import { providerSecrets } from '../secret-ids';
import { errorMessage } from '../util/async';
import {
  isMissionCreate,
  normalizeAgentImages,
  sessionIdSchema,
  SLOW_HANDLER_MS,
  type HandlerContext
} from './context';

/** The first message of a mission, as the composer sends it. */
const missionInputSchema = z.strictObject({
  text: z.string().max(200_000),
  images: z.array(z.unknown()).max(20).optional(),
  files: z.array(z.strictObject({ name: z.string().min(1).max(500), mimeType: z.string().max(200), data: z.string() })).max(20).optional(),
  mode: z.enum(['now', 'steer', 'queue']).optional()
});

export function registerSessionHandlers(ctx: HandlerContext): void {
  const { deps, handle, invokeChannel, sessionFor, scheduleGitnexus, isHousekeepWriting, onShutdown } = ctx;
  const { settings, secrets, sessions, terminals, runtime } = deps;

  const housekeep = new HousekeepService({
    sessions,
    settings: () => settings.get(),
    savingRecentDays: () => isHousekeepWriting(),
    // Partial registry hosts may not have a desktop bridge; without Trash, removal fails closed.
    trashDirectory: deps.desktop?.trashItem?.bind(deps.desktop),
    hasTerminalOrView: (id) =>
      deps.desktopFocus?.state().sessionId === id ||
      !!deps.desktopFocus?.isViewing(id) ||
      terminals.list().some((terminal) => terminal.sessionId === id),
    runningOwners:
      deps.processes &&
      (async () => {
        try {
          const snapshot = await deps.processes!.list();
          return snapshot.error ? null : new Set(snapshot.processes.flatMap((process) => (process.owner.sessionId ? [process.owner.sessionId] : [])));
        } catch {
          return null;
        }
      }),
    reviewer: () => configuredHousekeepReviewer(settings.get(), { getSecret: providerSecrets((id) => secrets.get(id)), log: deps.log })
  });

  handle('sessions:list', () => sessions.list());

  const importSourceSchema = z.strictObject({ source: z.enum(['claude', 'codex']) });
  handle('sessions:importList', async (req) => {
    const { source } = importSourceSchema.parse(req);
    const scan = await discoverChatImports(source);
    const existingSessions = sessions.list();
    const folders = deps.settings.get().folders;
    return {
      candidates: scan.sessions.map(({ candidate }) => {
        const existing = existingSessions.find((session) => representsChatImport(session, candidate));
        const root = existing?.config?.projectRoot;
        return {
          ...candidate,
          imported: !!existing,
          // A saved chat is not proof that the separate settings write completed.
          // Use its stored root: an external history may since have moved projects.
          ...(root && !folders.includes(root) ? { registrationPending: true, projectRoot: root } : {})
        };
      }),
      skipped: scan.skippedFiles,
      skippedReasons: scan.skippedReasons,
      scanErrors: scan.scanErrors,
      malformedLines: scan.malformedLines,
      truncated: scan.truncated
    };
  });
  handle('sessions:import', async (req) => {
    const { source, ids, repairOnly } = importSourceSchema
      .extend({ ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).min(1).max(200), repairOnly: z.boolean().optional() })
      .parse(req);
    const scan = await discoverChatImports(source);
    const wanted = new Set(ids);
    const selected = scan.sessions.filter(({ candidate }) => wanted.has(candidate.id));
    if (selected.length !== wanted.size) throw new Error('Some conversations are no longer available. Scan again before importing.');
    try {
      return await (repairOnly ? sessions.importChats(selected, { repairOnly: true }) : sessions.importChats(selected));
    } finally {
      // Committed imports (including a partial batch) register projects outside settings:update.
      deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
    }
  });

  const mission = () => {
    if (!deps.mission) throw new Error('Mission mode is not available here.');
    return deps.mission;
  };
  handle('sessions:create', async (req) => {
    if (isMissionCreate('sessions:create', req) && req.mission !== true) throw new Error('Invalid mission flag.');
    // A Lead is created without its prompt and adopted before its first runtime starts.
    const session = req.mission === true ? await mission().createLead(req) : await sessions.create(req);
    scheduleGitnexus(session, 'session-start');
    return session;
  });
  handle('mission:start', (input) => {
    const { sessionId, input: message } = z.strictObject({ sessionId: sessionIdSchema, input: missionInputSchema }).parse(input);
    const images = normalizeAgentImages(message.images);
    return mission().start({
      sessionId,
      input: { text: message.text, ...(images ? { images } : {}), ...(message.files?.length ? { files: message.files } : {}) }
    });
  });
  handle('mission:get', (input) => {
    const { sessionId } = z.strictObject({ sessionId: sessionIdSchema }).parse(input);
    return deps.mission?.get(sessionId) ?? null;
  });
  handle('mission:stop', (input) => mission().stop(z.strictObject({ leadId: sessionIdSchema }).parse(input).leadId));
  handle('mission:resume', (input) => mission().resume(z.strictObject({ leadId: sessionIdSchema }).parse(input).leadId));

  handle('sessions:get', ({ id }) => sessions.get(id) ?? null);
  handle('sessions:transcript', ({ id }) => sessions.transcript(id));
  handle('sessions:transcriptPage', async (req) => {
    const { items, seq } = await sessions.transcriptSnapshot(req.id);
    return { ...transcriptPage(items, req), seq };
  });

  handle('subagents:list', ({ id }) => sessions.subagentRuns(id));
  handle('subagents:get', ({ id, runId }) => sessions.subagentRun(id, runId));
  handle('subagents:stop', ({ id, runId }) => sessions.subagentCommand(id, runId, 'stop'));
  handle('subagents:steer', ({ id, runId, message }) => sessions.subagentCommand(id, runId, 'steer', message));

  // Project subagent definitions. The project root is the session's (its main checkout), and the
  // templates come from the bundled pi resources, so both live with everything else pi loads.
  const projectRootOf = (id: string): string | null => sessions.get(id)?.config.projectRoot ?? null;
  const templateDir = (): string | undefined => {
    try {
      return path.join(runtime.resource('pi', 'agents'));
    } catch {
      return undefined;
    }
  };
  handle('agents:list', async ({ id }) => {
    const root = projectRootOf(id);
    if (!root) return { agents: [], templates: [], git: false, ignored: false };
    return listProjectAgents(root, templateDir());
  });
  handle('agents:get', async ({ id, name }) => {
    const root = projectRootOf(id);
    return root ? readProjectAgent(root, name) : null;
  });
  handle('agents:save', async ({ id, fields, prompt }) => {
    const root = projectRootOf(id);
    if (!root) return { ok: false, error: 'Session not found' };
    return saveProjectAgent(root, fields, prompt);
  });
  handle('agents:delete', async ({ id, name }) => {
    const root = projectRootOf(id);
    if (!root) return { ok: false, error: 'Session not found' };
    return deleteProjectAgent(root, name);
  });
  handle('agents:track', async ({ id, name, tracked }) => {
    const root = projectRootOf(id);
    if (!root) return { ok: false, error: 'Session not found' };
    return setProjectAgentTracked(root, name, tracked);
  });

  // Claude Code's own agent definitions. Same project root, different format and different rules:
  // a definition replaces the built-in it is named after, so the app only ever edits an existing one.
  const claudeSessionModel = (id: string): string | null => {
    const meta = sessions.get(id);
    return meta?.config.model?.model ?? meta?.activeModel?.model ?? null;
  };
  handle('claude-agents:list', async ({ id }) => {
    const root = projectRootOf(id);
    const files = root ? await listClaudeAgents(root) : [];
    return {
      types: await sessions.subagentTypes(id),
      files,
      sessionModel: claudeSessionModel(id),
      forced: !files.some((file) => isPinnedModel(file.model))
    };
  });
  handle('claude-agents:setModel', async ({ id, name, model }) => {
    const root = projectRootOf(id);
    if (!root) return { ok: false, error: 'Session not found' };
    return setClaudeAgentModel(root, name, model ?? undefined);
  });
  handle('claude-agents:create', async ({ id, name, description, prompt, model, override }) => {
    const root = projectRootOf(id);
    if (!root) return { ok: false, error: 'Session not found' };
    // The engine names its own types while it is live; the module covers the built-ins it cannot.
    return createClaudeAgent(root, { name, description, prompt, model: model ?? undefined }, (await sessions.subagentTypes(id)).map((type) => type.name), { override });
  });

  handle('sessions:search', (req) => deps.search.search(req));
  handle('sessions:delete', async ({ id, removeWorktree }) => {
    // Shells hold their cwd open; take them down before the worktree is removed.
    const t0 = Date.now();
    await terminals.closeForSession(id);
    const t1 = Date.now();
    await sessions.delete(id, removeWorktree);
    if (Date.now() - t0 >= SLOW_HANDLER_MS) deps.log('warn', `slow delete ${id}: terminals ${t1 - t0}ms, session ${Date.now() - t1}ms`);
  });
  handle('sessions:rename', ({ id, title }) => sessions.patch(id, { title }));
  handle('sessions:label', ({ id, label }) => sessions.patch(id, { statusLabel: label?.trim() || undefined }));
  handle('sessions:archive', async ({ id, archived, removeWorktree, forceWorktree }) => {
    z.boolean().parse(archived);
    sessionFor(id);
    // Archiving parks the session, so its shells go with it — and a shell holding the worktree's
    // directory open (Windows) must be gone before the worktree is removed.
    if (archived) await terminals.closeForSession(id);
    return sessions.setArchived(id, archived, removeWorktree, forceWorktree);
  });

  const housekeepIds = z.array(sessionIdSchema).max(4096);
  const housekeepPreviewId = z.string().uuid();
  let scanningHousekeepInventory: ReturnType<typeof scanHousekeepInventory> | undefined;
  handle('housekeep:inventory', (input) => {
    z.undefined().parse(input); // Only the current profile supplies the scope, never the renderer.
    return (scanningHousekeepInventory ??= scanHousekeepInventory(settings.get().folders, sessions.list({ refreshGit: false })).finally(() => {
      scanningHousekeepInventory = undefined;
    }));
  });
  handle('housekeep:preview', (input) => {
    const { protectedIds, recentDaysOverride } = z
      .strictObject({
        protectedIds: housekeepIds,
        recentDaysOverride: z.number().int().min(0).max(MAX_HOUSEKEEP_RECENT_DAYS).optional()
      })
      .parse(input);
    return housekeep.preview(protectedIds, recentDaysOverride);
  });
  handle('housekeep:assess', (input) => {
    const { previewId } = z.strictObject({ previewId: housekeepPreviewId }).parse(input);
    return housekeep.assess(previewId);
  });
  handle('housekeep:apply', (input) => {
    const { previewId, ids, protectedIds } = z.strictObject({ previewId: housekeepPreviewId, ids: housekeepIds.min(1), protectedIds: housekeepIds }).parse(input);
    return housekeep.apply(previewId, ids, protectedIds);
  });

  handle('sessions:pin', ({ id, pinned }) => sessions.setPinned(id, pinned));
  handle('sessions:pinOrder', ({ ids }) => sessions.setPinOrder(ids));
  handle('sessions:markViewed', (input) => sessions.markViewed(sessionIdSchema.parse(z.strictObject({ id: z.string() }).parse(input).id)));
  handle('sessions:send', async ({ id, input }) => {
    sessionFor(id);
    await sessions.send(id, input);
  });
  handle('sessions:editAndResend', ({ id, userItemId, input }) => sessions.editAndResend(id, userItemId, input));
  handle('sessions:interrupt', ({ id }) => sessions.interrupt(id));
  handle('sessions:stop', ({ id }) => sessions.stop(id));
  handle('sessions:setModel', ({ id, model }) => sessions.setModel(id, model));
  handle('sessions:setEffort', ({ id, effort }) => sessions.setEffort(id, effort));
  handle('sessions:setFastMode', (input) => {
    const { id, enabled } = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]+$/), enabled: z.boolean() }).parse(input);
    sessionFor(id);
    return sessions.setFastMode(id, enabled);
  });
  handle('sessions:setPermissionMode', ({ id, mode }) => sessions.setPermissionMode(id, mode));
  handle('sessions:compact', ({ id }) => sessions.compact(id));
  handle('sessions:clearTranscript', ({ id }) => sessions.clearTranscript(id));
  handle('sessions:export', async ({ id }) => {
    const md = await sessions.exportMarkdown(id);
    const meta = sessions.get(id);
    const res = await deps.desktop.showSaveDialog({
      defaultPath: path.join(deps.desktop.documentsPath(), `${(meta?.title ?? 'session').replace(/[^\w.-]+/g, '_')}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (res.canceled || !res.filePath) return { path: null };
    await fs.writeFile(res.filePath, md, 'utf8');
    deps.log('info', `[${id}] transcript exported to ${res.filePath}`);
    return { path: res.filePath };
  });
  handle('sessions:fork', async ({ id, harness }) => {
    const session = await sessions.fork(id, harness);
    if (session) scheduleGitnexus(session, 'session-start');
    return session;
  });
  handle('sessions:moveTo', ({ id, cwd }) => sessions.moveTo(id, cwd));
  handle('sessions:goal', ({ id, action, objective, autoContinue, maxIterations }) => sessions.goal(id, action, { objective, autoContinue, maxIterations }));
  handle('approvals:respond', ({ sessionId, requestId, decision }) => sessions.respondApproval(sessionId, requestId, decision));

  // Vesta reaches the app through this same registry, but only via the capability allowlist in
  // shared/agent-manifest.ts — the registry itself serves keychain writes and raw PTY input.
  const vesta = new Vesta({
    getSettings: () => settings.get(),
    listSessions: () => sessions.list(),
    getSession: (id) => sessions.get(id),
    getSecret: providerSecrets((providerId) => secrets.get(providerId)),
    invoke: (channel, req) => invokeChannel(channel, req, 'agent'),
    push: (state) => deps.push(PUSH_CHANNELS.agentState, state),
    log: deps.log,
    // Vesta runs on pi (docs/VESTA.md); it is absent until pi is installed, which the panel says.
    piBinary: () => runtime.resolve('pi')?.path ?? null,
    piExtension: () => runtime.resource('pi', 'vocs-code-vesta.ts'),
    piCwd: () => homedir()
  });
  onShutdown(() => vesta.dispose());

  handle('agent:state', () => vesta.state());
  // A turn streams over push:agentState, so the invoke returns as soon as it is accepted.
  handle('agent:send', ({ text, context, images }) => {
    void vesta.send(String(text ?? ''), context, normalizeAgentImages(images)).catch((e: unknown) => deps.log('warn', `vesta send failed: ${errorMessage(e)}`));
  });
  handle('agent:cancel', () => vesta.cancel());
  handle('agent:resolve', ({ proposalId, approve }) => vesta.resolveProposal(String(proposalId ?? ''), approve === true));
  handle('agent:reset', () => vesta.reset());
}
