/** Follow my computer: while it is on for a computer, the shell switches to the session the desktop
 *  moves to. The choice is per computer and remembered in localStorage; while it is off, a move
 *  shows a snackbar with a one-tap Follow instead of changing what the reader is looking at. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@renderer/store';
import type { DesktopFocus } from '@shared/types';

const keyFor = (hostDeviceId: string | null) => `vocs-follow-${hostDeviceId ?? 'none'}`;

export function followEnabled(hostDeviceId: string | null): boolean {
  try {
    return window.localStorage.getItem(keyFor(hostDeviceId)) === '1';
  } catch {
    return false;
  }
}

export function setFollow(hostDeviceId: string | null, on: boolean): void {
  try {
    window.localStorage.setItem(keyFor(hostDeviceId), on ? '1' : '0');
  } catch {
    // A browser refusing storage (private windows) simply forgets the choice.
  }
}

export interface FollowSnackbar {
  sessionId: string;
  title: string;
}

export function useFollow(hostDeviceId: string | null, focus: DesktopFocus | null, onFollow: (sessionId: string) => void) {
  const [following, setFollowing] = useState(() => followEnabled(hostDeviceId));
  const [snackbar, setSnackbar] = useState<FollowSnackbar | null>(null);
  const last = useRef<string | null>(null);
  const initialized = useRef(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setFollowing(followEnabled(hostDeviceId));
    initialized.current = false;
    last.current = null;
  }, [hostDeviceId]);

  useEffect(() => {
    const next = focus?.sessionId ?? null;
    if (!next) return;
    // The first focus of a connection is what the default route already opened: never a "move".
    if (!initialized.current) {
      initialized.current = true;
      last.current = next;
      return;
    }
    if (next === last.current) return;
    last.current = next;
    const store = useStore.getState();
    if (following) {
      // Never yank the view away from a half-typed message.
      const draft = store.activeId ? store.drafts[store.activeId] ?? '' : '';
      if (draft.trim()) return;
      if (store.activeId !== next) onFollow(next);
      return;
    }
    const title = store.sessions.find((s) => s.id === next)?.title ?? 'another session';
    setSnackbar({ sessionId: next, title });
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = setTimeout(() => setSnackbar(null), 8_000);
  }, [focus, following, onFollow]);

  useEffect(
    () => () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    },
    []
  );

  const toggle = useCallback(() => {
    setFollowing((on) => {
      setFollow(hostDeviceId, !on);
      if (on) setSnackbar(null);
      return !on;
    });
  }, [hostDeviceId]);

  const followNow = useCallback(() => {
    if (!snackbar) return;
    setFollow(hostDeviceId, true);
    setFollowing(true);
    onFollow(snackbar.sessionId);
    setSnackbar(null);
  }, [hostDeviceId, snackbar, onFollow]);

  return { following, toggle, snackbar, dismiss: () => setSnackbar(null), followNow };
}
