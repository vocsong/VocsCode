import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ControlError, controlErrorCode, controlIdSchema, controlParams, type ControlProject } from '../../shared/control';
import {
  LOCAL_CONTROL_METHODS, LOCAL_CONTROL_VERSION, encodeLocalControlTarget, localControlRequestSchema,
  type LocalControlOwnerState, type LocalControlReply, type LocalControlTarget,
} from '../../shared/local-control';
import type { SessionManager } from '../session-manager';
import { checkControlWorkspace, controlDirectoryIdentity, controlPathKey as key, controlSessionIdentity, freshControlSession, localWorkspaceIdentity, type ControlResourceGuard } from './workspace';

export interface LocalPipe {
  pid: number;
  started: string;
  close(): void;
}
export type OpenLocalPipe = (options: {
  name: string;
  signal: AbortSignal;
  dispatch(input: unknown): Promise<LocalControlReply>;
  closed(): void;
}) => Promise<LocalPipe>;
interface LocalProject extends ControlProject { identity: string }
interface Grant {
  target: LocalControlTarget;
  projects: LocalProject[];
  pipe: LocalPipe;
}

const selection = z.strictObject({ projectIds: z.array(controlIdSchema).min(1).max(100) });
const denied = { ok: false, error: 'denied' } as const;
const page = <T>(items: T[], offset: number, limit: number) => ({
  items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null,
});
// Drive-rooted Windows paths only: preview discovery does not follow UNC profiles or projects.
const localDirectory = (value: string): boolean => path.isAbsolute(value) && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(value));

/** One revocable in-memory grant per running desktop. The pipe authenticates the Windows user;
 * the desktop decides which ordinary metadata that user has allowed. No remote identity/journal. */
export class LocalControl {
  private readonly salt = randomUUID();
  private pending?: AbortController;
  private active?: Grant;
  private stopped = false;
  private roots: Set<string>;

  constructor(private readonly deps: {
    supported: boolean;
    userData: string;
    roots(): readonly string[];
    sessions: Pick<SessionManager, 'list' | 'get'>;
    guard: ControlResourceGuard;
    workspaceRevision(): number;
    open: OpenLocalPipe;
  }) { this.roots = new Set(this.deps.roots().filter(localDirectory).map((root) => path.resolve(root))); }

  private get supported(): boolean { return this.deps.supported && localDirectory(this.deps.userData); }

  private knows(project: LocalProject): boolean {
    return this.deps.roots().some((root) => path.resolve(root) === project.root);
  }

  private async identify(root: string): Promise<LocalProject> {
    const canonicalRoot = await fs.realpath(root);
    if (!localDirectory(canonicalRoot) || key(canonicalRoot) !== key(root)) throw new ControlError('denied');
    const identity = await controlDirectoryIdentity(canonicalRoot);
    await this.deps.guard({ projectRoot: canonicalRoot });
    if (await fs.realpath(root) !== canonicalRoot || await controlDirectoryIdentity(canonicalRoot) !== identity) throw new ControlError('denied');
    const id = `p_${createHash('sha256').update(JSON.stringify([this.salt, path.resolve(root), canonicalRoot, identity])).digest('hex')}`;
    return { id, root: path.resolve(root), canonicalRoot, identity, name: path.basename(canonicalRoot) || 'Drive root' };
  }

  private async inventory(): Promise<LocalProject[]> {
    if (!this.supported || this.stopped) return [];
    const results: LocalProject[] = [];
    const listed = new Set<string>();
    for (const root of [...new Set(this.deps.roots().filter(localDirectory).map((item) => path.resolve(item)))].slice(0, 1000)) {
      try {
        const project = await this.identify(root);
        if (!listed.has(project.canonicalRoot)) {
          listed.add(project.canonicalRoot);
          results.push(project);
        }
      } catch { /* Unavailable, redirected and managed folders cannot be granted. */ }
    }
    return results.filter((project) => this.knows(project));
  }

  private ownerStateFor(projects: LocalProject[]): LocalControlOwnerState {
    return {
      supported: this.supported,
      projects: projects.map(({ id, root, name }) => ({ id, root, name })),
      approvedProjectIds: this.active?.projects.map((project) => project.id) ?? [],
      target: this.active ? encodeLocalControlTarget(this.active.target) : null,
    };
  }

  async ownerState(): Promise<LocalControlOwnerState> { return this.ownerStateFor(await this.inventory()); }

  async enable(input: unknown): Promise<LocalControlOwnerState> {
    const { projectIds } = selection.parse(input);
    if (!this.supported || this.stopped) throw new ControlError('unavailable');
    if (new Set(projectIds).size !== projectIds.length) throw new ControlError('invalid_request');
    this.revoke();
    const pending = new AbortController();
    this.pending = pending;
    const revision = this.deps.workspaceRevision();
    let pipe: LocalPipe | undefined;
    let opened: Grant | undefined;
    let closed = false;
    try {
      const projects = await this.inventory();
      const selected = projects.filter(({ id }) => projectIds.includes(id));
      if (selected.length !== projectIds.length) throw new ControlError('denied');
      const canonicalProfile = await fs.realpath(this.deps.userData);
      if (!localDirectory(canonicalProfile) || key(canonicalProfile) !== key(this.deps.userData)) throw new ControlError('denied');
      const profileId = createHash('sha256').update(canonicalProfile).digest('hex');
      const instanceId = randomUUID();
      const name = `vocs-code-local-${randomUUID().replaceAll('-', '')}`;
      if (pending.signal.aborted) throw new ControlError('denied');
      pipe = await this.deps.open({
        name, signal: pending.signal,
        dispatch: (request) => this.dispatch(opened, request),
        closed: () => { closed = true; if (opened && this.active === opened) this.active = undefined; },
      });
      if (closed || pending.signal.aborted || revision !== this.deps.workspaceRevision() || !selected.every((project) => this.knows(project))) throw new ControlError('unavailable');
      opened = { projects: selected, pipe, target: { v: LOCAL_CONTROL_VERSION, profileId, instanceId, pipeName: name, pid: pipe.pid, started: pipe.started } };
      this.active = opened;
      return this.ownerStateFor(projects);
    } catch (error) {
      if (opened && this.active === opened) this.active = undefined;
      pipe?.close();
      throw error;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  cancelPendingEnable(): void {
    this.pending?.abort();
    this.pending = undefined;
  }

  /** Called on committed folder changes. Re-adding a folder cannot revive an old descriptor. */
  projectsChanged(): void {
    const current = new Set(this.deps.roots().filter(localDirectory).map((root) => path.resolve(root)));
    if ([...this.roots].some((root) => !current.has(root))) this.cancelPendingEnable();
    this.roots = current;
    if (this.active?.projects.some((project) => !current.has(project.root))) this.revoke();
  }

  private revoke(): void {
    const prior = this.active;
    this.active = undefined;
    this.cancelPendingEnable();
    prior?.pipe.close();
  }

  async disable(): Promise<LocalControlOwnerState> {
    this.revoke();
    return this.ownerState();
  }

  shutdown(): void { this.stopped = true; this.revoke(); }

  private async liveProject(project: LocalProject): Promise<boolean> {
    if (!this.knows(project)) return false;
    try {
      return (await this.identify(project.root)).id === project.id && this.knows(project);
    } catch { return false; }
  }

  private async dispatch(grant: Grant | undefined, input: unknown): Promise<LocalControlReply> {
    if (!grant || grant !== this.active) return denied;
    try {
      if (typeof input === 'object' && input !== null && 'v' in input && typeof input.v === 'number' && input.v !== LOCAL_CONTROL_VERSION) {
        return { ok: false, error: 'incompatible' };
      }
      const { profileId, instanceId, request } = localControlRequestSchema.parse(input);
      if (profileId !== grant.target.profileId || instanceId !== grant.target.instanceId) return denied;
      const revision = this.deps.workspaceRevision();
      let result: Record<string, unknown>;
      switch (request.method) {
        case 'capabilities':
          controlParams.capabilities.parse(request.params);
          result = { version: LOCAL_CONTROL_VERSION, instanceId, methods: LOCAL_CONTROL_METHODS };
          break;
        case 'projects.list': {
          const params = controlParams[request.method].parse(request.params);
          if (params.instanceId !== instanceId) return denied;
          const visible: LocalProject[] = [];
          for (const project of grant.projects) {
            if (this.active !== grant) return denied;
            if (await this.liveProject(project)) visible.push(project);
          }
          result = page(visible.filter((project) => this.knows(project)).map(({ id, name }) => ({ id, name })), params.offset, params.limit);
          break;
        }
        case 'sessions.list': {
          const params = controlParams[request.method].parse(request.params);
          const project = grant.projects.find(({ id }) => id === params.projectId);
          if (params.instanceId !== instanceId || !project || !await this.liveProject(project)) return denied;
          // Limit filesystem work to the requested page of candidates. A page may omit stale or
          // unavailable rows; its next offset refers to the scan, not the number of rows returned.
          const candidatePage = page(this.deps.sessions.list({ refreshGit: false }).filter((session) => !session.mission && !session.archived &&
            key(session.config.projectRoot) === key(project.root) && controlIdSchema.safeParse(session.id).success), params.offset, params.limit);
          const checked = [];
          for (const session of candidatePage.items) {
            if (this.active !== grant) return denied;
            const identity = controlSessionIdentity(session);
            try {
              const workspace = await checkControlWorkspace(session, project.canonicalRoot, this.deps.guard, true);
              checked.push({ session, identity, workspace });
            } catch { /* Not an ordinary session in the selected workspace. */ }
          }
          if (!await this.liveProject(project) || this.active !== grant) return denied;
          // Re-sample the approved cwd identities after the asynchronous Mission/resource guard.
          // The final in-process revisions below reject changes during this filesystem scan.
          const verified = await Promise.all(checked.map(async (entry) => {
            try { return await localWorkspaceIdentity(entry.session, project.canonicalRoot) === entry.workspace ? entry : null; }
            catch { return null; }
          }));
          if (!this.knows(project)) return denied;
          result = {
            items: verified.flatMap((entry) => {
              if (!entry) return [];
              try {
                const { id, title, status, config } = freshControlSession((id) => this.deps.sessions.get(id), entry);
                return [{ id, title: title.slice(0, 160), status, harness: config.harness }];
              } catch { return []; }
            }),
            nextOffset: candidatePage.nextOffset,
          };
          break;
        }
      }
      return grant === this.active && revision === this.deps.workspaceRevision() ? { ok: true, result } : denied;
    } catch (error) { return { ok: false, error: controlErrorCode(error) }; }
  }
}
