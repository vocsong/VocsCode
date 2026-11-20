import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ControlError } from '../../shared/control';
import type { SessionMeta } from '../../shared/types';

export type ControlResourceGuard = (resource: { sessionId?: string; projectRoot?: string }) => Promise<void>;

export const controlPathKey = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

export function insideControlWorkspace(root: string, target: string): boolean {
  const relative = path.relative(controlPathKey(root), controlPathKey(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Everything an ordinary-session workspace decision reads, including mutable session state. */
export const controlSessionIdentity = (session: SessionMeta): string => JSON.stringify([session.id, session.createdAt, session.cwd, session.config.projectRoot,
  session.config.permissionMode, session.config.harness, !!session.mission, !!session.archived]);

export function freshControlSession(get: (id: string) => SessionMeta | undefined, checked: { session: SessionMeta; identity: string }): SessionMeta {
  const current = get(checked.session.id);
  if (!current || controlSessionIdentity(current) !== checked.identity) throw new ControlError('denied');
  return current;
}

export async function controlDirectoryIdentity(directory: string): Promise<string> {
  const stat = await fs.stat(directory, { bigint: true });
  if (!stat.isDirectory() || !stat.ino) throw new ControlError('denied');
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

async function canonicalControlCwd(session: SessionMeta, canonicalRoot: string, exactCase: boolean): Promise<string> {
  if (session.mission || session.archived) throw new ControlError('denied');
  const project = await fs.realpath(session.config.projectRoot);
  const actual = await fs.realpath(session.cwd);
  if (controlPathKey(project) !== controlPathKey(canonicalRoot) || controlPathKey(actual) !== controlPathKey(session.cwd) ||
    !insideControlWorkspace(canonicalRoot, actual)) throw new ControlError('denied');
  // Local discovery also compares canonical spellings, for Windows case-sensitive directories.
  const prefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
  if (exactCase && (project !== canonicalRoot || actual !== canonicalRoot && !actual.startsWith(prefix))) throw new ControlError('denied');
  return actual;
}

export async function localWorkspaceIdentity(session: SessionMeta, canonicalRoot: string): Promise<string> {
  const cwd = await canonicalControlCwd(session, canonicalRoot, true);
  return JSON.stringify([cwd, await controlDirectoryIdentity(cwd)]);
}

/** Canonical cwd is authoritative, not just the remembered project. Callers recheck live grants
 * and `freshControlSession` after the last await. Local pages also re-sample the workspace. */
export async function checkControlWorkspace(session: SessionMeta, canonicalRoot: string, guard: ControlResourceGuard, exactCase = false): Promise<string | undefined> {
  try {
    let identity: string | undefined;
    if (exactCase) identity = await localWorkspaceIdentity(session, canonicalRoot);
    else await canonicalControlCwd(session, canonicalRoot, false);
    await guard({ sessionId: session.id });
    return identity;
  } catch {
    throw new ControlError('denied');
  }
}
