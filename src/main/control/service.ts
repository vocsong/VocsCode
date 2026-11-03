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
import type { SessionManager } from '../session-manager';
import { ControlJournal, type ControlJournalState } from './journal';

const key = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const terminal = new Set(['succeeded', 'failed', 'interrupted', 'unknown']);
const WINDOW_MS = 60 * 60 * 1000;
const MAX_GRANT_MS = 90 * 24 * 60 * 60 * 1000;

/** App-owned control domain. The authenticated transport supplies identity, not a tool argument. */
export class ControlService {
  private storageFault = false;
  private jobs = new Set<Promise<void>>();
  constructor(private readonly deps: {
    journal: ControlJournal;
    sessions: SessionManager;
    settings: () => AppSettings;
    /** Same Mission session/workspace guards as the desktop, not an IPC invoke tunnel. */
    guard: (resource: { sessionId?: string; projectRoot?: string }) => Promise<void>;
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
      } catch { /* Missing or managed roots are not enrollable. Never infer new access from them. */ }
    }
    if (projects.length !== current.projects.length) await this.deps.journal.transaction((s) => {
      for (const project of projects) if (!s.projects.some((p) => key(p.root) === key(project.root) || key(p.canonicalRoot) === key(project.canonicalRoot))) s.projects.push(project);
    });
    const state = this.snapshot();
    return { instanceId: state.instanceId, enabled: state.enabled, projects: state.projects, grants: state.grants };
  }

  async setEnabled(enabled: boolean): Promise<ControlOwnerState> {
    if (typeof enabled !== 'boolean') throw new ControlError('invalid_request');
    await this.deps.journal.transaction((s) => { s.enabled = enabled; });
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
      s.grants.push({ ...parsed, id: randomUUID() });
    });
    return this.ownerState();
  }

  async revoke(grantId: string): Promise<ControlOwnerState> {
    await this.deps.journal.transaction((s) => {
      const grant = s.grants.find((g) => g.id === grantId);
      if (!grant) throw new ControlError('denied');
      grant.revokedAt ??= this.now();
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

  private async project(projectId: string): Promise<ControlProject> {
    const project = this.snapshot().projects.find((p) => p.id === projectId);
    if (!project) throw new ControlError('denied');
    try {
      const real = await fs.realpath(project.root);
      const stat = await fs.stat(real);
      if (key(real) !== key(project.canonicalRoot) || !stat.isDirectory() || `${stat.dev}:${stat.ino}` !== project.identity) throw new Error('changed');
      await this.deps.guard({ projectRoot: real });
    } catch { throw new ControlError('unavailable'); }
    return project;
  }

  private async session(principal: ControllerPrincipal, method: ControlMethod, projectId: string, sessionId: string): Promise<SessionMeta> {
    this.authorize(principal, method, projectId);
    const project = await this.project(projectId);
    const session = this.deps.sessions.get(sessionId);
    if (!session || session.mission || session.archived) throw new ControlError('denied');
    try {
      if (key(await fs.realpath(session.config.projectRoot)) !== key(project.canonicalRoot)) throw new Error('wrong project');
      // A substituted worktree symlink must not make an existing session point elsewhere.
      if (key(await fs.realpath(session.cwd)) !== key(session.cwd)) throw new Error('changed workspace');
      await this.deps.guard({ sessionId });
    } catch { throw new ControlError('denied'); }
    const grant = this.authorize(principal, method, projectId);
    if (!grant.permissionModes.includes(session.config.permissionMode) || !grant.harnesses.includes(session.config.harness)) throw new ControlError('denied');
    return session;
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
    this.authorize(principal, request.method, projectId);
    const state = this.snapshot();
    if (request.method !== 'capabilities' && params.instanceId !== state.instanceId) throw new ControlError('denied');
    const offset = Number(params.offset ?? 0), limit = Number(params.limit ?? 50);
    switch (request.method) {
      case 'capabilities':
        return { version: CONTROL_VERSION, instanceId: state.instanceId, logId: state.logId, epoch: this.deps.journal.epoch,
          methods: Object.keys(controlParams).filter((method) => {
            try { this.authorize(principal, method as ControlMethod); return true; } catch { return false; }
          }), questions: 'owner-only', busyPolicy: 'rejectIfBusy' };
      case 'projects.list': {
        const visible: unknown[] = [];
        for (const project of state.projects) {
          try { this.authorize(principal, 'projects.list', project.id); await this.project(project.id); visible.push({ id: project.id, name: project.name }); } catch { /* No existence leak. */ }
        }
        return { items: visible.slice(offset, offset + limit), nextOffset: offset + limit < visible.length ? offset + limit : null };
      }
      case 'sessions.list': {
        await this.project(projectId!);
        const visible: unknown[] = [];
        for (const session of this.deps.sessions.list()) {
          try { visible.push(this.summary(await this.session(principal, 'sessions.list', projectId!, session.id))); } catch { /* Filter unapproved sessions. */ }
        }
        return { items: visible.slice(offset, offset + limit), nextOffset: offset + limit < visible.length ? offset + limit : null };
      }
      case 'sessions.get': return this.summary(await this.session(principal, request.method, projectId!, String(params.sessionId)));
      case 'sessions.transcript': {
        const session = await this.session(principal, request.method, projectId!, String(params.sessionId));
        const transcript = await this.deps.sessions.transcript(session.id);
        this.authorize(principal, request.method, projectId); // Revocation during the read also wins.
        const items: unknown[] = [];
        let bytes = 0;
        for (const item of transcript.slice(offset, offset + limit)) {
          let safe: unknown = item.kind === 'approval' ? { id: item.id, kind: 'info', ts: item.ts, level: 'info', text: 'Owner action required on this computer.' } : item;
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
        if (s.windows.length >= 1024) throw new ControlError('busy');
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
      if (state.operations.length >= 5000) throw new ControlError('busy');
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
          const receipt = state.operations.find((op) => op.id === operation.id)!;
          if (receipt.state !== 'accepted') throw new ControlError('conflict');
          receipt.state = 'dispatched'; receipt.updatedAt = this.now();
        });
        this.authorize(principal, operation.method, project.id);
      };
      if (operation.method === 'sessions.send') {
        const result = await this.deps.sessions.runControlled(operation.sessionId!, { text: String(params.text) }, { operationId: operation.id, inputId: operation.inputId!, beforeDispatch });
        await this.update(operation.id, { state: result.outcome, runtimeId: result.runtimeId, turnId: result.turnId, outputIds: result.outputIds });
      } else {
        const defaults = resolveNewSessionDefaults(this.deps.settings(), project.root);
        const grant = this.authorize(principal, operation.method, project.id);
        if (!grant.permissionModes.includes(defaults.permissionMode) || !grant.harnesses.includes(defaults.harness)) throw new ControlError('denied');
        const config: CreateSessionRequest['config'] = { ...defaults, effort: defaults.effort || undefined, projectRoot: project.root };
        await beforeDispatch();
        const session = await this.deps.sessions.createControlled({ config, title: params.title as string | undefined }, operation.id);
        await this.update(operation.id, { state: 'succeeded', sessionId: session.id });
      }
    } catch {
      const current = this.snapshot().operations.find((op) => op.id === operation.id)!;
      if (!terminal.has(current.state)) await this.update(operation.id, { state: current.state === 'accepted' ? 'failed' : 'unknown' });
    }
  }

  /** Test/shutdown barrier; never used as evidence that an operation succeeded. */
  async settle(): Promise<void> { await Promise.all([...this.jobs]); }
}
