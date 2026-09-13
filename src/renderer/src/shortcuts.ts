/** Executes custom shortcut commands (Settings → Shortcuts) against the app store. */
import { accelFromEvent, type ShortcutCommand } from '../../shared/shortcuts';
import { invoke } from './api';
import { useStore } from './store';
import { createTerminal } from './terminal/host';
import { archiveSession } from './sessionActions';

/** Runs one bound command; session commands are a no-op when no session is active. */
export function runShortcutCommand(cmd: ShortcutCommand): void {
  const st = useStore.getState();
  const s = st.sessions.find((x) => x.id === st.activeId);
  if (cmd.startsWith('session.') && !s) return;
  switch (cmd) {
    case 'session.archive':
      void archiveSession(s!, st.toast);
      break;
    case 'session.fork':
      void invoke('sessions:fork', { id: s!.id })
        .then((f) => {
          if (f) {
            st.toast(`Forked "${f.title}"`, 'success');
            void st.setActive(f.id);
          }
        })
        .catch((e) => st.toast(e instanceof Error ? e.message : String(e), 'error'));
      break;
    case 'session.interrupt':
      void invoke('sessions:interrupt', { id: s!.id });
      break;
    case 'session.pin':
      void invoke('sessions:pin', { id: s!.id, pinned: !s!.pinned });
      break;
    case 'session.newTerminal':
      void createTerminal(s!.id);
      break;
    case 'session.export':
      void invoke('sessions:export', { id: s!.id });
      break;
    case 'session.compact':
      void invoke('sessions:compact', { id: s!.id });
      break;
    case 'app.newSession':
      void st.startNewSession();
      break;
    case 'app.newSessionQuick':
      st.openQuickSession(true);
      break;
    case 'app.palette':
      st.openPalette(!st.paletteOpen);
      break;
    case 'app.toggleSidebar':
      st.toggleSidebar();
      break;
    case 'app.togglePanel':
      st.togglePanel();
      break;
    case 'app.toggleThinking':
      st.toggleThinking();
      break;
    case 'app.focusTerminal':
      st.setPanelTab('terminal');
      st.focusTerminal();
      break;
    case 'app.showChanges':
      st.setPanelTab('changes');
      break;
    case 'app.showGoal':
      st.setPanelTab('goal');
      break;
    case 'app.settings':
      st.setView('settings');
      break;
    case 'app.analytics':
      st.setView('analytics');
      break;
    case 'app.skills':
      st.setView('skills');
      break;
    case 'app.mcp':
      st.setView('mcp');
      break;
    case 'app.back':
      void st.navBack();
      break;
    case 'app.forward':
      void st.navForward();
      break;
  }
}

/**
 * Consumes a keyboard event for a custom shortcut, if one is bound. Called from the global
 * keydown handler after the fixed shortcuts, which keep priority.
 */
export function handleCustomShortcut(e: KeyboardEvent): boolean {
  const accel = accelFromEvent(e);
  if (!accel) return false;
  const cmd = useStore.getState().settings?.customShortcuts?.[accel];
  if (!cmd) return false;
  e.preventDefault();
  runShortcutCommand(cmd);
  return true;
}
