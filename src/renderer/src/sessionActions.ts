/** Shared renderer actions for changing and archiving sessions. */
import type { AppSettings, EffortLevel, SessionMeta } from '../../shared/types';
import { invoke } from './api';
import { askConfirm } from './components/ui';

type Toast = (text: string, kind?: 'info' | 'success' | 'error') => void;

let latestEffortSelection = 0;
let effortPreferenceQueue: Promise<void> = Promise.resolve();

function persistEffort(selection: number, effort: EffortLevel | undefined, patch: Partial<AppSettings> = {}): Promise<void> {
  const update = effortPreferenceQueue.then(async () => {
    if (selection !== latestEffortSelection) return;
    await invoke('settings:update', { ...patch, defaultEffort: effort });
  });
  effortPreferenceQueue = update.catch(() => undefined);
  return update;
}

/** Remembers a new-session or Settings choice in the same order as live effort changes. */
export function rememberEffort(effort: EffortLevel | undefined, patch: Partial<AppSettings> = {}): Promise<void> {
  return persistEffort(++latestEffortSelection, effort, patch);
}

/** Applies an effort to a session, then remembers it unless the user made a newer choice. */
export async function setSessionEffort(id: string, effort: EffortLevel, toast: Toast): Promise<void> {
  const selection = ++latestEffortSelection;
  try {
    await invoke('sessions:setEffort', { id, effort });
  } catch (e) {
    toast(`Reasoning effort switch failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return;
  }
  try {
    await persistEffort(selection, effort);
  } catch (e) {
    toast(`Reasoning effort changed, but could not be remembered: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

/** Archive like the sidebar row does: a worktree is removed after confirmation; uncommitted changes block, then force. */
export async function archiveSession(s: SessionMeta, toast: Toast) {
  if (s.worktreeBranch) {
    const ok = await askConfirm({
      title: `Remove the worktree for "${s.title}"?`,
      body: `The folder is deleted; the branch ${s.worktreeBranch} is kept. Unarchiving recreates the worktree.`,
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