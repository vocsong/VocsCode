import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CONTROL_REQUIRED_SCOPE, CONTROL_VERSION, ControlError, controlGrantInputSchema, controlParams,
  controlPrincipalSchema, controlRequestSchema,
  type ControlGrant, type ControlGrantInput, type ControlMethod, type ControlOperation,
  type ControlOwnerState, type ControlProject, type ControllerPrincipal,
} from '../../shared/control';
import { resolveNewSessionDefaults } from '../../shared/session-defaults';
import type { AppSettings, CreateSessionRequest, SessionMeta } from '../../shared/types';
import { confinedWorktreeRoot } from '../git';
import type { SessionManager } from '../session-manager';
import { ControlJournal, type ControlJournalState } from './journal';
import {
  checkControlWorkspace, controlPathKey as key, controlSessionIdentity as sessionIdentity,
  freshControlSession, insideControlWorkspace, localWorkspaceIdentity, type ControlResourceGuard,
} from './workspace';

type EnrolledProject = ControlJournalState['projects'][number];
type DiscoveryMethod = 'projects.list' | 'sessions.list' | 'sessions.get';

const terminal = new Set(['succeeded', 'failed', 'interrupted', 'unknown']);
const WINDOW_MS = 60 * 60 * 1000;
const MAX_GRANT_MS = 90 * 24 * 60 * 60 * 1000;
/** Per-controller shares of the journal's global bounds (1024 windows, 5000 receipts), so one
 * controller cannot exhaust admission for every other controller the owner has granted. Open
 * windows (still able to admit) are capped tightly; windows kept only as retry evidence count
 * toward a larger retained cap, since each holds at least one receipt and receipts are capped. */
export const CONTROL_OPEN_WINDOWS_PER_CONTROLLER = 32;
export const CONTROL_WINDOWS_PER_CONTROLLER = 128;
export const CONTROL_OPERATIONS_PER_CONTROLLER = 1000;

/** App-owned control domain. The authenticated transport supplies identity, not a tool argument. */
export class ControlService {
  private storageFault = false;
  private jobs = new Set<Promise<void>>();
  private discoveryDisableRevision = 0;
  constructor(private readonly deps: {
    journal: ControlJournal;
    sessions: SessionManager;
    settings: () => AppSettings;
    /** The desktop's session/workspace resource check, not an IPC invoke tunnel. */
    guard: ControlResourceGuard;
    now?: () => number;
  }) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private snapshot(): ControlJournalState {
    if (this.storageFault) throw new ControlError('storage_unavailable');
    return this.deps.journal.snapshot();
  }

  async ownerState(): Promise<ControlOwnerState> {
    const current = this.snapshot();
    const known = [...this.deps.settings().folders, ...this.deps.sessions.list().map((s) => s.config.projectRoot)];
    const projects = [...current.projects];
    for (const root of new Set(known)) {
      if (!path.isAbsolute(root) || projects.some((p) => key(p.root) === key(root))) continue;
      try {
        const canonicalRoot = await fs.realpath(root);
        if (projects.some((p) => key(p.canonicalRoot) === key(canonicalRoot))) continue;
        await this.deps.guard({ projectRoot: root });
        const stat = await fs.stat(canonicalRoot);
        if (!stat.isDirectory()) continue;
        projects.push({ id: `p_${randomUUID().replaceAll('-', '')}`, root, canonicalRoot, name: path.basename(root), identity: `${stat.dev}:${stat.ino}` });
      } catch { /* Never infer new access from a root that failed enrollment. */ }
    }
    if (projects.length !== current.projects.length) await this.deps.journal.transaction((s) => {
      for (const project of projects) if (!s.projects.some((p) => key(p.root) === key(project.root) || key(p.canonicalRoot) === key(project.canonicalRoot))) s.projects.push(project);
    });
    const state = this.snapshot();
    return { instanceId: state.instanceId, enabled: state.enabled, projects: state.projects, grants: state.grants };
  }

  /** Cancel before-dispatch intent in the same commit that withdraws its authority. Re-enabling
   * or regranting must not resurrect it; already-dispatched work keeps its terminal evidence. */
  private failPending(state: ControlJournalState, controller?: Pick<ControlGrantInput, 'accountId' | 'controllerId'>): void {
    for (const operation of state.operations) {
      if (operation.state !== 'accepted' || (controller && (operation.accountId !== controller.accountId || operation.controllerId !== controller.controllerId))) continue;
      operation.state = 'failed';
      operation.updatedAt = this.now();
    }
  }

  async setEnabled(enabled: boolean): Promise<ControlOwnerState> {
    if (typeof enabled !== 'boolean') throw new ControlError('invalid_request');
    await this.deps.journal.transaction((s) => {
      s.enabled = enabled;
      if (!enabled) this.failPending(s);
    });
    // A committed disable retires in-flight reads even if the same grants are re-enabled.
    if (!enabled) this.discoveryDisableRevision++;
    return this.ownerState();
  }

  async grant(input: ControlGrantInput): Promise<ControlOwnerState> {
    const parsed = controlGrantInputSchema.parse(input);
    const now = this.now();
    if (parsed.expiresAt <= now || parsed.expiresAt > now + MAX_GRANT_MS) throw new ControlError('invalid_request');
    for (const projectId of parsed.projectIds) await this.project(projectId);
    await this.deps.journal.transaction((s) => {
      if (parsed.projectIds.some((id) => !s.projects.some((p) => p.id === id))) throw new ControlError('denied');
      // A replacement is an explicit owner action, never an automation-side scope expansion.
      for (const old of s.grants) if (old.accountId === parsed.accountId && old.controllerId === parsed.controllerId && !old.revokedAt) old.revokedAt = now;
      this.failPending(s, parsed);
      s.grants.push({ ...parsed, id: randomUUID() });
    });
    return this.ownerState();
  }

  async revoke(grantId: string): Promise<ControlOwnerState> {
    await this.deps.journal.transaction((s) => {
      const grant = s.grants.find((g) => g.id === grantId);
      if (!grant) throw new ControlError('denied');
      if (grant.revokedAt !== undefined) return;
      grant.revokedAt = this.now();
      this.failPending(s, grant);
    });
    // Already-dispatched work is not silently interrupted; the owner can still use Stop.
    return this.ownerState();
  }

  private authorize(principal: ControllerPrincipal, method: ControlMethod, projectId?: string, state = this.snapshot()): ControlGrant {
    if (!state.enabled || principal.validUntil <= this.now() || principal.validUntil > this.now() + 30_000) throw new ControlError('denied');
    const scope = CONTROL_REQUIRED_SCOPE[method];
    if (!principal.scopes.includes(scope)) throw new ControlError('denied');
    const grant = state.grants.find((g) => g.accountId === principal.accountId && g.controllerId === principal.controllerId &&
      !g.revokedAt && g.expiresAt > this.now() && g.scopes.includes(scope) && (!projectId || g.projectIds.includes(projectId)));
    if (!grant) throw new ControlError('denied');
    return grant;
  }

  private discoveryFence(principal: ControllerPrincipal, method: DiscoveryMethod, grant: ControlGrant, instanceId: string, projectId?: string) {
    const disabled = this.discoveryDisableRevision;
    // Recheck the same desktop grant synchronously with the final response projection.
    return () => {
      const state = this.snapshot();
      const current = this.authorize(principal, method, projectId, state);
      if (current.id !== grant.id || current.revokedAt !== undefined || state.instanceId !== instanceId ||
        disabled !== this.discoveryDisableRevision) throw new ControlError('denied');
      return { state, grant: current };
    };
  }

  private currentDiscoveryProject(project: EnrolledProject, state: ControlJournalState, grant: ControlGrant): EnrolledProject | undefined {
    const current = state.projects.find(({ id }) => id === project.id);
    if (current && grant.projectIds.includes(current.id) && current.root === project.root &&
      current.canonicalRoot === project.canonicalRoot && current.identity === project.identity) return current;
  }

  private async projectDirectory(project: EnrolledProject): Promise<string> {
    try {
      const real = await fs.realpath(project.root);
      const stat = await fs.stat(real);
      if (key(real) !== key(project.canonicalRoot) || !stat.isDirectory() || `${stat.dev}:${stat.ino}` !== project.identity) throw new Error('changed');
      return real;
    } catch { throw new ControlError('unavailable'); }
  }

  private async project(projectId: string): Promise<EnrolledProject> {
    const project = this.snapshot().projects.find((p) => p.id === projectId);
    if (!project) throw new ControlError('denied');
    const real = await this.projectDirectory(project);
    try { await this.deps.guard({ projectRoot: real }); }
    catch { throw new ControlError('unavailable'); }
    return project;
  }

  private async session(principal: ControllerPrincipal, method: ControlMethod, projectId: string, sessionId: string): Promise<{ session: SessionMeta; identity: string }> {
    this.authorize(principal, method, projectId);
    const project = await this.project(projectId);
    const session = this.deps.sessions.get(sessionId);
    if (!session || session.archived) throw new ControlError('denied');
    const checked = sessionIdentity(session);
    await checkControlWorkspace(session, project.canonicalRoot, this.deps.guard);
    // Synchronously after the last await: the workspace, mode and harness approved above are
    // still the session's. Callers publish through fresh(), which repeats this in their own
    // synchronous block, because resuming after this method returns is another turn of the loop.
    const current = this.fresh({ session, identity: checked });
    const grant = this.authorize(principal, method, projectId);
    if (!grant.permissionModes.includes(current.config.permissionMode) || !grant.harnesses.includes(current.config.harness)) throw new ControlError('denied');
    return { session: current, identity: checked };
  }

  /** The session exactly as it was authorized, or denied. Synchronous by design. */
  private fresh(checked: { session: SessionMeta; identity: string }): SessionMeta {
    return freshControlSession((id) => this.deps.sessions.get(id), checked);
  }

  private summary(session: SessionMeta): unknown {
    return { id: session.id, title: session.title, status: session.status, harness: session.config.harness,
      permissionMode: session.config.permissionMode, model: session.activeModel, ownerActionNeeded: session.status === 'awaiting' };
  }

  async handle(identity: unknown, input: unknown): Promise<unknown> {
    const principal = controlPrincipalSchema.parse(identity);
    const request = controlRequestSchema.parse(input);
    const params = controlParams[request.method].parse(request.params) as Record<string, unknown>;
    const projectId = typeof params.projectId === 'string' ? params.projectId : undefined;
    const state = this.snapshot();
    const grant = this.authorize(principal, request.method, projectId, state);
    if (request.method !== 'capabilities' && params.instanceId !== state.instanceId) throw new ControlError('denied');
    const offset = Number(params.offset ?? 0), limit = Number(params.limit ?? 50);
    switch (request.method) {
      case 'capabilities':
        return { version: CONTROL_VERSION, instanceId: state.instanceId, logId: state.logId, epoch: this.deps.journal.epoch,
          methods: Object.keys(controlParams).filter((method) => {
            try { this.authorize(principal, method as ControlMethod); return true; } catch { return false; }
          }), questions: 'owner-only', busyPolicy: 'rejectIfBusy' };
      case 'projects.list': {
        const checkPublication = this.discoveryFence(principal, request.method, grant, state.instanceId);
        const checked: EnrolledProject[] = [];
        for (const project of state.projects) {
          if (!grant.projectIds.includes(project.id)) continue;
          try {
            await this.deps.guard({ projectRoot: await this.projectDirectory(project) });
            checked.push(project);
          } catch { /* No existence leak. */ }
        }
        const verified: EnrolledProject[] = [];
        for (const project of checked) {
          try { await this.projectDirectory(project); verified.push(project); } catch { /* Directory changed. */ }
        }
        const live = checkPublication();
        const visible = verified.flatMap((project) => {
          const current = this.currentDiscoveryProject(project, live.state, live.grant);
          return current ? [{ id: current.id, name: current.name }] : [];
        });
        return { items: visible.slice(offset, offset + limit), nextOffset: offset + limit < visible.length ? offset + limit : null };
      }
      case 'sessions.list':
      case 'sessions.get': {
        const checkPublication = this.discoveryFence(principal, request.method, grant, state.instanceId, projectId);
        const project = await this.project(projectId!);
        checkPublication();
        const single = request.method === 'sessions.get';
        const candidates = single ? [this.deps.sessions.get(String(params.sessionId))] : this.deps.sessions.list({ refreshGit: false }).slice();
        const checked: Array<{ session: SessionMeta; identity: string; workspace: string | undefined }> = [];
        for (const session of candidates) {
          try {
            if (!session || session.archived || !grant.permissionModes.includes(session.config.permissionMode) ||
              !grant.harnesses.includes(session.config.harness)) continue;
            const identity = sessionIdentity(session);
            const workspace = await checkControlWorkspace(session, project.canonicalRoot, this.deps.guard, true);
            checked.push({ session, identity, workspace });
          } catch { /* Not an ordinary session in the granted workspace. */ }
        }
        // Re-sample directories after all the resource guards, then check live session identities
        // and authority together. Keep offset/limit over the filtered rows, as before.
        const verified: typeof checked = [];
        for (const entry of checked) {
          try {
            if (await localWorkspaceIdentity(entry.session, project.canonicalRoot) === entry.workspace) verified.push(entry);
          } catch { /* Workspace changed or disappeared. */ }
        }
        await this.projectDirectory(project);
        const live = checkPublication();
        if (!this.currentDiscoveryProject(project, live.state, live.grant)) throw new ControlError('denied');
        const visible = verified.flatMap((entry) => {
          try {
            const current = this.fresh(entry);
            return live.grant.permissionModes.includes(current.config.permissionMode) && live.grant.harnesses.includes(current.config.harness)
              ? [this.summary(current)] : [];
          } catch { return []; }
        });
        if (single) {
          if (!visible.length) throw new ControlError('denied');
          return visible[0];
        }
        return { items: visible.slice(offset, offset + limit), nextOffset: offset + limit < visible.length ? offset + limit : null };
      }
      case 'sessions.transcript': {
        const checked = await this.session(principal, request.method, projectId!, String(params.sessionId));
        const transcript = await this.deps.sessions.transcript(checked.session.id);
        // Reads do not reserve the runtime: desktop moves/configuration edits can finish meanwhile.
        await this.session(principal, request.method, projectId!, checked.session.id);
        // Against the identity the read began with (a move away and back is not detected), in the same
        // synchronous block that builds the response. Revocation during the read also wins.
        this.fresh(checked);
        this.authorize(principal, request.method, projectId);
        // A question card and the tool call it belongs to are one group: the call's input and output
        // carry the question and the owner's answer, so both are withheld, whichever page they are on.
        const answered = new Set(transcript.flatMap((item) => item.kind === 'approval' && item.request.questions?.length && item.request.toolItemId ? [item.request.toolItemId] : []));
        const items: unknown[] = [];
        let bytes = 0;
        for (const item of transcript.slice(offset, offset + limit)) {
          let safe: unknown = item.kind === 'approval' ? { id: item.id, kind: 'info', ts: item.ts, level: 'info', text: 'Owner action required on this computer.' }
            : answered.has(item.id) ? { id: item.id, kind: 'info', ts: item.ts, level: 'info', text: 'Owner-only question; read it on this computer.' } : item;
          let size = Buffer.byteLength(JSON.stringify(safe));
          if (size > 180_000) { safe = { id: item.id, kind: 'info', ts: item.ts, level: 'info', text: 'Item exceeds remote size limit; read it locally.' }; size = 200; }
          if (bytes + size > 200_000) break;
          bytes += size;
          items.push(safe);
        }
        return { items, nextOffset: offset + items.length < transcript.length ? offset + items.length : null };
      }
      case 'windows.create': return this.deps.journal.transaction((s) => {
        const grant = this.authorize(principal, request.method, undefined, s);
        const own = s.windows.filter((w) => w.accountId === principal.accountId && w.controllerId === principal.controllerId);
        if (own.filter((w) => w.expiresAt > this.now()).length >= CONTROL_OPEN_WINDOWS_PER_CONTROLLER || own.length >= CONTROL_WINDOWS_PER_CONTROLLER || s.windows.length >= 1024) throw new ControlError('busy');
        const window = { id: randomUUID(), accountId: principal.accountId, controllerId: principal.controllerId, expiresAt: Math.min(this.now() + WINDOW_MS, grant.expiresAt) };
        s.windows.push(window);
        return { admissionWindowId: window.id, expiresAt: window.expiresAt, instanceId: s.instanceId };
      });
      case 'sessions.create':
      case 'sessions.send': return this.admit(principal, request.method, params);
      case 'operations.get':
      case 'operations.interrupt': {
        const operation = state.operations.find((op) => op.id === params.operationId && op.controllerId === principal.controllerId && op.accountId === principal.accountId);
        if (!operation) throw new ControlError('denied');
        this.authorize(principal, request.method, operation.projectId);
        if (request.method === 'operations.get') return operation;
        if (terminal.has(operation.state)) return { requested: false, state: operation.state };
        if (operation.method !== 'sessions.send' || !operation.sessionId) throw new ControlError('invalid_request');
        await this.session(principal, request.method, operation.projectId, operation.sessionId);
        this.authorize(principal, request.method, operation.projectId);
        await this.deps.sessions.interruptControlled(operation.sessionId, operation.id);
        return { requested: true, operationId: operation.id };
      }
    }
  }

  private async admit(principal: ControllerPrincipal, method: 'sessions.send' | 'sessions.create', params: Record<string, unknown>): Promise<ControlOperation> {
    const projectId = String(params.projectId);
    const project = await this.project(projectId);
    if (method === 'sessions.send') await this.session(principal, method, projectId, String(params.sessionId));
    const payloadHash = createHash('sha256').update(JSON.stringify({ method, params })).digest('hex');
    const admitted = await this.deps.journal.transaction((state) => {
      this.authorize(principal, method, projectId, state);
      const window = state.windows.find((w) => w.id === params.admissionWindowId && w.accountId === principal.accountId && w.controllerId === principal.controllerId);
      if (!window) throw new ControlError('expired');
      const existing = state.operations.find((op) => op.controllerId === principal.controllerId && op.accountId === principal.accountId && op.admissionWindowId === window.id && op.method === method && op.idempotencyKey === params.idempotencyKey);
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new ControlError('conflict');
        return { operation: existing, fresh: false };
      }
      if (window.expiresAt <= this.now()) throw new ControlError('expired');
      const own = state.operations.filter((op) => op.accountId === principal.accountId && op.controllerId === principal.controllerId).length;
      if (own >= CONTROL_OPERATIONS_PER_CONTROLLER || state.operations.length >= 5000) throw new ControlError('busy');
      const id = randomUUID();
      const operation: ControlOperation = { id, accountId: principal.accountId, controllerId: principal.controllerId, instanceId: state.instanceId, projectId,
        sessionId: method === 'sessions.send' ? String(params.sessionId) : undefined, inputId: method === 'sessions.send' ? `u_${id.replaceAll('-', '')}` : undefined,
        method, admissionWindowId: window.id, idempotencyKey: String(params.idempotencyKey), payloadHash, state: 'accepted', createdAt: this.now(), updatedAt: this.now() };
      state.operations.push(operation);
      return { operation, fresh: true };
    });
    if (admitted.fresh) {
      const job = this.execute(principal, admitted.operation, params, project).catch(() => { this.storageFault = true; });
      this.jobs.add(job);
      void job.finally(() => this.jobs.delete(job));
    }
    return admitted.operation;
  }

  private async update(id: string, patch: Partial<ControlOperation>): Promise<void> {
    await this.deps.journal.transaction((state) => {
      const operation = state.operations.find((op) => op.id === id);
      if (!operation || terminal.has(operation.state)) throw new ControlError('conflict');
      Object.assign(operation, patch, { updatedAt: this.now() });
    });
  }

  private async execute(principal: ControllerPrincipal, operation: ControlOperation, params: Record<string, unknown>, project: ControlProject): Promise<void> {
    try {
      const beforeDispatch = async (): Promise<void> => {
        await this.project(project.id);
        if (operation.sessionId) await this.session(principal, operation.method, project.id, operation.sessionId);
        else await this.deps.guard({ projectRoot: project.canonicalRoot });
        // Authorization and dispatch intent commit atomically. No OAuth/browser identity elevation.
        await this.deps.journal.transaction((state) => {
          this.authorize(principal, operation.method, project.id, state);
          const receipt = state.operations.find((op) => op.id === operation.id);
          if (!receipt || receipt.state !== 'accepted') throw new ControlError('conflict');
          receipt.state = 'dispatched'; receipt.updatedAt = this.now();
        });
        this.authorize(principal, operation.method, project.id);
      };
      if (operation.method === 'sessions.send') {
        // The manager has reserved the session (configuration edits are refused) when it calls this,
        // and calls it before constructing or starting a runtime: starting one can spawn CLI and MCP
        // processes, so a configuration the grant excludes must not get that far.
        let checked: { session: SessionMeta; identity: string } | undefined;
        const beforeStart = async (): Promise<void> => {
          await this.project(project.id);
          checked = await this.session(principal, operation.method, project.id, operation.sessionId!);
          startAllowed();
        };
        // Synchronous, so the manager can run it immediately before the adapter starts: a grant
        // revoked or narrowed while the runtime was prepared stops it there.
        const startAllowed = (): void => {
          try {
            const state = this.snapshot();
            const grant = this.authorize(principal, operation.method, project.id, state);
            if (state.operations.find((op) => op.id === operation.id)?.state !== 'accepted' || !checked) throw new ControlError('conflict');
            const session = this.fresh(checked);
            if (!grant.permissionModes.includes(session.config.permissionMode) || !grant.harnesses.includes(session.config.harness)) throw new ControlError('denied');
          } catch { throw new Error('Remote control permission for this request was withdrawn before the session started.'); }
        };
        const result = await this.deps.sessions.runControlled(operation.sessionId!, { text: String(params.text) }, { operationId: operation.id, inputId: operation.inputId!, beforeStart, startAllowed, beforeDispatch });
        await this.update(operation.id, { state: result.outcome, runtimeId: result.runtimeId, turnId: result.turnId, outputIds: result.outputIds });
      } else {
        const defaults = resolveNewSessionDefaults(this.deps.settings(), project.root);
        const grant = this.authorize(principal, operation.method, project.id);
        if (!grant.permissionModes.includes(defaults.permissionMode) || !grant.harnesses.includes(defaults.harness)) throw new ControlError('denied');
        const config: CreateSessionRequest['config'] = { ...defaults, effort: defaults.effort || undefined, projectRoot: project.root };
        if (config.useWorktree) {
          // Decided once, before any effect: no repository means no worktree, even if a later Git
          // call would find one. Creation repeats the confinement at the point it writes.
          const root = await confinedWorktreeRoot(project.root, project.canonicalRoot).catch(() => { throw new ControlError('denied'); });
          if (!root) config.useWorktree = false;
        }
        await beforeDispatch();
        const session = await this.deps.sessions.createControlled({ config, title: params.title as string | undefined }, operation.id, project.canonicalRoot);
        // Defense in depth only; the destination was authorized before any effect above.
        if (!insideControlWorkspace(project.canonicalRoot, await fs.realpath(session.cwd))) throw new ControlError('denied');
        await this.update(operation.id, { state: 'succeeded', sessionId: session.id });
      }
    } catch {
      // Serialize with owner cancellation: a stale snapshot plus update would turn a harmless
      // terminal conflict into a service-wide storage fault. Pruned canceled receipts are no-ops.
      await this.deps.journal.transaction((state) => {
        const current = state.operations.find((op) => op.id === operation.id);
        if (!current || terminal.has(current.state)) return;
        current.state = current.state === 'accepted' ? 'failed' : 'unknown';
        current.updatedAt = this.now();
      });
    }
  }

  /** Test/shutdown barrier; never used as evidence that an operation succeeded. */
  async settle(): Promise<void> { await Promise.all([...this.jobs]); }
}
