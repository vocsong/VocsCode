/** Which session the desktop window is on (docs/REMOTE-ACCESS.md §4). The renderer reports its
 *  active session here, the window's own focus/blur updates the presence half, and paired browsers
 *  receive `push:desktopFocus` whenever either changes — so a phone can open the session the
 *  computer is showing instead of guessing. Main owns this because a browser can never be asked
 *  what the desktop is doing; `desktop:setFocus` stays local-only.
 *
 *  It also keeps which sessions are on screen — every visible pane, not just the active one — so
 *  main can tell, when a turn ends, whether anyone saw it finish. That set is local bookkeeping:
 *  it is never part of the `DesktopFocus` paired browsers receive. */
import type { DesktopFocus } from '../shared/types';

export interface DesktopFocusTrackerDeps {
  /** Whether a session id still exists; a deleted or archived session is not a focus target. */
  hasSession: (id: string) => boolean;
  push: (focus: DesktopFocus) => void;
}

export class DesktopFocusTracker {
  private focus: DesktopFocus = { sessionId: null, at: 0, windowFocused: false };
  private visible = new Set<string>();

  constructor(private readonly deps: DesktopFocusTrackerDeps) {}

  /** A copy, so a caller cannot mutate the tracker's state through the reference. */
  state(): DesktopFocus {
    return { ...this.focus };
  }

  /** The renderer's active session (null on Home). Unknown ids become null instead of erroring:
   *  the renderer can legitimately report a session deleted a moment earlier. */
  setSession(sessionId: string | null): void {
    const next = sessionId && this.deps.hasSession(sessionId) ? sessionId : null;
    if (next === this.focus.sessionId) return;
    this.focus = { ...this.focus, sessionId: next, at: Date.now() };
    this.push();
  }

  /** The desktop window came to the front or went behind something. */
  setWindowFocused(windowFocused: boolean): void {
    if (windowFocused === this.focus.windowFocused) return;
    this.focus = { ...this.focus, windowFocused, at: Date.now() };
    this.push();
  }

  /** The sessions in the panes on screen; empty while Settings, Analytics or another view hides them. */
  setVisible(sessionIds: string[]): void {
    this.visible = new Set(sessionIds);
  }

  /** Someone is looking at this session: it is on screen and the window is in front. */
  isViewing(sessionId: string): boolean {
    return this.focus.windowFocused && this.visible.has(sessionId);
  }

  /** After the session list changes: forget a focus target that no longer exists. */
  reconcile(): void {
    if (this.focus.sessionId && !this.deps.hasSession(this.focus.sessionId)) this.setSession(null);
  }

  private push(): void {
    this.deps.push(this.state());
  }
}

/** A reloading or crashed renderer shows nothing until it reports its panes again: without this, a
 *  turn ending in the last-reported sessions while the window stays focused would count as seen. */
export function forgetVisibleOnRendererReset(contents: NodeJS.EventEmitter, tracker: Pick<DesktopFocusTracker, 'setVisible'>): void {
  contents.on('did-start-loading', () => tracker.setVisible([]));
  contents.on('render-process-gone', () => tracker.setVisible([]));
}
