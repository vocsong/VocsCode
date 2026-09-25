/** Shared renderer actions for changing and archiving sessions. */
import type { AppSettings, EffortLevel, SessionMeta } from '../../shared/types';
import { withFolderSessionDefaults } from '../../shared/session-defaults';
import { invoke } from './api';
import { basename } from './format';
import { askConfirm } from './components/ui';
import { useStore } from './store';

type Toast = (text: string, kind?: 'info' | 'success' | 'error') => void;

let latestEffortSelection = 0;
let effortPreferenceQueue: Promise<void> = Promise.resolve();

/** Runs a settings write after every earlier one in the effort queue, so remembered choices land in order. */
function enqueue(write: () => Promise<void>): Promise<void> {
  const update = effortPreferenceQueue.then(write);
  effortPreferenceQueue = update.catch(() => undefined);
  return update;
}

function persistEffort(selection: number, effort: EffortLevel | undefined, patch: Partial<AppSettings> = {}): Promise<void> {
  return enqueue(async () => {
    if (selection !== latestEffortSelection) return;
    await invoke('settings:update', { ...patch, defaultEffort: effort });
  });
}

/** Remembers a new-session or Settings choice in the same order as live effort changes. */
export function rememberEffort(effort: EffortLevel | undefined, patch: Partial<AppSettings> = {}): Promise<void> {
  return persistEffort(++latestEffortSelection, effort, patch);
}

/** Remembers new-session choices for a model that takes no effort. There is no effort choice to
 *  record, so the remembered one stays for the next model that has effort, and a newer live
 *  switch still being saved is not superseded. */
export function rememberWithoutEffort(patch: Partial<AppSettings>): Promise<void> {
  return enqueue(async () => {
    await invoke('settings:update', patch);
  });
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
  // The app-wide effort preference is shared with the dialog, and the session's own project keeps
  // the choice too: otherwise the next dialog on that folder would offer the effort it was last
  // *created* with, and the switch just made would look forgotten.
  const root = useStore.getState().sessions.find((s) => s.id === id)?.config.projectRoot;
  const patch = root ? { folderSessionDefaults: withFolderSessionDefaults(useStore.getState().settings, root, { effort }) } : {};
  try {
    await persistEffort(selection, effort, patch);
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
    // The row stays visible with a blinking Archiving pill until the main process reports back.
    const setArchiving = (on: boolean) => useStore.getState().setArchiving(s.id, on);
    setArchiving(true);
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
    } finally {
      setArchiving(false);
    }
    return;
  }
  useStore.getState().setArchiving(s.id, true);
  void invoke('sessions:archive', { id: s.id, archived: true })
    .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'))
    .finally(() => useStore.getState().setArchiving(s.id, false));
}

/**
 * Takes a project folder out of the app after confirming what goes with it. Removal is about the
 * app's own record of the project — its sessions, their transcripts and the folder's sidebar
 * settings. The project directory itself is never deleted, and the confirmation says so, because
 * "remove folder" is exactly the phrase a user would fear meant otherwise.
 */
export async function removeFolder(root: string, sessions: SessionMeta[], toast: Toast): Promise<void> {
  const inFolder = sessions.filter((s) => s.config.projectRoot === root);
  const worktrees = inFolder.filter((s) => s.worktreeBranch).length;
  const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  const body = [
    inFolder.length === 1
      ? 'Its session and its transcript are removed from the app.'
      : inFolder.length
        ? `Its ${count(inFolder.length, 'session')} and their transcripts are removed from the app.`
        : 'It has no sessions left.',
    worktrees ? `The ${count(worktrees, 'worktree folder')} created for those sessions are deleted; their branches are kept.` : '',
    `The project itself is not deleted — ${root} stays on disk, and you can add it again at any time.`
  ]
    .filter(Boolean)
    .join(' ');
  const ok = await askConfirm({
    title: `Remove "${basename(root)}" from Vocs Code?`,
    body,
    confirmLabel: 'Remove folder',
    danger: true
  });
  if (!ok) return;
  try {
    const { removedSessions } = await invoke('folders:remove', { root });
    toast(
      removedSessions
        ? `Removed "${basename(root)}" and ${count(removedSessions, 'session')} from Vocs Code.`
        : `Removed "${basename(root)}" from Vocs Code.`,
      'success'
    );
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  }
}
