/**
 * Where a file named in a session is read from, and what happens to one outside it. Shared by the
 * store's `revealFile` (which selects the editor drawer, the Files tab or the system file manager)
 * and the drawer itself (which reads and shows the file).
 */
import { canInvoke, invoke, invokeErrorMessage, isMac, platform } from './api';

/** What `app:showInFolder` opens, named the way the platform names it. Read on use, not at import:
 *  the store imports this module, and many tests stub `api` without the platform fields. */
export function fileManagerName(): string {
  return isMac ? 'Finder' : platform === 'win32' ? 'File Explorer' : 'the file manager';
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
