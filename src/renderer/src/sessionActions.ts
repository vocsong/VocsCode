/** Session actions shared by the sidebar rows and the header so both behave identically. */
import type { SessionMeta } from '../../shared/types';
import { invoke } from './api';
import { askConfirm } from './components/ui';

type Toast = (text: string, kind?: 'info' | 'success' | 'error') => void;

/** Archive like the sidebar row does: a worktree is removed after confirmation; uncommitted changes block, then force. */
export async function archiveSession(s: SessionMeta, toast: Toast) {
  if (s.worktreeBranch) {
    const ok = await askConfirm({
      title: `Remove the worktree for "${s.title}"?`,
      body: `The worktree folder is deleted; uncommitted changes block this. The branch ${s.worktreeBranch} is kept — unarchiving recreates the worktree.`,
      confirmLabel: 'Archive & remove',
      danger: true
    });
    if (!ok) return;
    try {
      await invoke('sessions:archive', { id: s.id, archived: true, removeWorktree: true });
      toast('Worktree removed; the branch is kept', 'success');
    } catch (e) {
      // A dirty worktree refuses removal; offer to discard the changes and retry with force.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('modified or untracked files')) {
        toast(msg, 'error');
        return;
      }
      const force = await askConfirm({
        title: 'Discard uncommitted changes?',
        body: `The worktree has modified or untracked files. Removing it discards them; the branch ${s.worktreeBranch} is kept.`,
        confirmLabel: 'Discard & remove',
        danger: true
      });
      if (!force) return;
      try {
        await invoke('sessions:archive', { id: s.id, archived: true, removeWorktree: true, forceWorktree: true });
        toast('Worktree removed with its changes; the branch is kept', 'success');
      } catch (e2) {
        toast(e2 instanceof Error ? e2.message : String(e2), 'error');
      }
    }
    return;
  }
  void invoke('sessions:archive', { id: s.id, archived: true });
}