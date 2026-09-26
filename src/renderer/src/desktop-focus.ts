/** Reports the desktop's active session to main (docs/REMOTE-ACCESS.md §4), where it becomes
 *  `desktop:focus` and `push:desktopFocus` for paired browsers. Debounced so a fast session switch
 *  reports only where it settled. A browser never reports: it follows the desktop, and
 *  `desktop:setFocus` is not on the remote surface anyway. */
import { useEffect } from 'react';
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
