/** Reports the desktop's active session to main (docs/REMOTE-ACCESS.md §4), where it becomes
 *  `desktop:focus` and `push:desktopFocus` for paired browsers. Debounced so a fast session switch
 *  reports only where it settled. A browser never reports: it follows the desktop, and
 *  `desktop:setFocus` is not on the remote surface anyway. */
import { useEffect, useRef } from 'react';
import { invoke, isWeb } from './api';
import { useStore } from './store';

export function useReportDesktopFocus(): void {
  const activeId = useStore((s) => s.activeId);
  useEffect(() => {
    if (isWeb) return;
    const timer = setTimeout(() => {
      // Best-effort: a failed report must never surface as a toast in the middle of a switch.
      void invoke('desktop:setFocus', { sessionId: activeId }).catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [activeId]);
}

/** How long a session must stay on screen in the focused window before it counts as viewed. */
export const VIEW_DWELL_MS = 1500;

/**
 * Tells main which sessions are on screen, so a turn that ends while nobody is looking is marked
 * "done · not viewed", and clears that mark once a session has been on screen in the focused window
 * for VIEW_DWELL_MS — a glance while switching apps does not count. Window focus comes from main's
 * `push:desktopFocus`, the same source main judges a finished turn by.
 */
export function useSessionViewing(): void {
  const visible = useStore((s) => s.visibleSessionIds);
  const windowFocused = useStore((s) => s.desktopFocus?.windowFocused === true);
  const key = visible.join('\n');

  useEffect(() => {
    if (isWeb) return;
    const timer = setTimeout(() => {
      void invoke('desktop:setVisible', { sessionIds: key ? key.split('\n') : [] }).catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [key]);

  // One dwell per visible session, independent of the others: opening a pane beside it does not
  // restart it. A dwell is dropped the moment its session leaves the screen or the window loses
  // focus, and starts afresh when that is true again. A session counted once is not re-counted
  // until it leaves and comes back.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const counted = useRef(new Set<string>());
  useEffect(() => {
    const ids = isWeb || !windowFocused || !key ? [] : key.split('\n');
    for (const [id, timer] of timers.current) {
      if (ids.includes(id)) continue;
      clearTimeout(timer);
      timers.current.delete(id);
    }
    for (const id of [...counted.current]) if (!ids.includes(id)) counted.current.delete(id);
    for (const id of ids) {
      if (timers.current.has(id) || counted.current.has(id)) continue;
      timers.current.set(id, setTimeout(() => {
        timers.current.delete(id);
        counted.current.add(id);
        // Best-effort, like the focus report: a session deleted a moment ago is not worth a toast.
        void invoke('sessions:markViewed', { id }).catch(() => undefined);
      }, VIEW_DWELL_MS));
    }
  }, [key, windowFocused]);
  useEffect(() => () => {
    timers.current.forEach(clearTimeout);
    timers.current.clear();
  }, []);
}
