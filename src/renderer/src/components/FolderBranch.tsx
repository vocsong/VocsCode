import { useEffect, useState } from 'react';
import type { IpcResponse } from '../../../shared/ipc';
import { invoke } from '../api';
import { Icon } from './ui';

/** The folder's checkout, independent of any session's isolated worktree. */
export function FolderBranch({ root, expanded = true }: { root: string; expanded?: boolean }) {
  const [head, setHead] = useState<IpcResponse<'git:folderBranch'>>({});

  useEffect(() => {
    if (!expanded) return;
    let disposed = false;
    let pending = false;
    setHead({});
    const refresh = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const next = await invoke('git:folderBranch', { projectRoot: root });
        if (!disposed) setHead(next);
      } catch {
        if (!disposed) setHead({});
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [root, expanded]);

  if (!expanded || !head.branch) return null;
  const label = head.detached ? `Detached HEAD (${head.branch})` : head.branch;
  return (
    <span className="project-branch" title={`Current checkout in ${root}: ${label}`}>
      <Icon name="branch" size={11} />
      <span>{label}</span>
    </span>
  );
}
