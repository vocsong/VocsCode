/**
 * Where a file named in a session is read from, and what happens to one outside it. Shared by the
 * store's `revealFile` (which decides between the file pane, the Files tab and the system file
 * manager) and the file pane itself (which reads and shows the file).
 */
import type { MissionRecord } from '../../shared/mission';
import type { SessionMeta } from '../../shared/types';
import { canInvoke, invoke, invokeErrorMessage, isMac, platform } from './api';

/** What `app:showInFolder` opens, named the way the platform names it. Read on use, not at import:
 *  the store imports this module, and many tests stub `api` without the platform fields. */
export function fileManagerName(): string {
  return isMac ? 'Finder' : platform === 'win32' ? 'File Explorer' : 'the file manager';
}

export interface FileScope {
  /** The folder workspace-relative paths resolve against. */
  root: string;
  /** Mission sessions: the workspace the `fs:*` reads are scoped to; undefined is the integration result. */
  missionWorkspaceId?: string;
}

/**
 * The folder a session's files live in. An ordinary session reads its own cwd. A Mission lead reads
 * a Mission workspace: `workspace` names one ('' is the integration result), and without it a file
 * the transcript mentions resolves in the lead's own workspace, where the lead actually works.
 */
export function fileScope(session: SessionMeta, mission: MissionRecord | undefined, workspace?: string): FileScope {
  if (!session.mission || !mission) return { root: session.cwd };
  const lead = mission.workspaces.find((w) => w.role === 'lead' && w.ownerSessionId === session.id) ?? mission.workspaces.find((w) => w.role === 'lead');
  const id = workspace === undefined ? lead?.id : workspace || undefined;
  const chosen = (id ? mission.workspaces.find((w) => w.id === id) : undefined) ?? mission.workspaces.find((w) => w.role === 'integration');
  return { root: chosen?.path ?? session.cwd, missionWorkspaceId: id };
}

/**
 * A file outside the session folder is never read. On the desktop an absolute path is shown in the
 * system file manager instead (nothing is read or launched); anywhere else it is refused.
 */
export async function showOutsideFile(sessionId: string, root: string, target: string, toast: (text: string, kind: 'info' | 'error') => void): Promise<void> {
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(target) || !canInvoke('app:showInFolder')) {
    toast(`Cannot open files outside ${root}`, 'error');
    return;
  }
  try {
    const r = await invoke('app:showInFolder', { sessionId, path: target });
    if (!r.ok) toast(r.error ?? `Could not show ${target}`, 'error');
    else toast(`Showing ${target.split(/[\\/]/).pop()} in ${fileManagerName()}: files outside this session cannot be previewed here`, 'info');
  } catch (err) {
    toast(invokeErrorMessage(err), 'error');
  }
}
