# Session activity tray — design

## Problem

With several project folders, the sidebar's `N running` / `N awaiting` badges say *how many*
sessions are busy but not *which* or *where*. Worse, a session whose turn finished while you were
elsewhere goes back to `idle` and looks exactly like one you read an hour ago, so finished work is
forgotten.

## Outcome

1. The app remembers, per session, that a turn finished while you were not looking at it
   ("done · not viewed"), until you actually view that session. It survives a restart.
2. The sidebar header opens an **activity tray** — on hover or click — listing what needs you,
   what is running, what finished unviewed and what you recently viewed, across every folder; a
   click jumps to the session.
3. Unviewed sessions are visible in the list itself: a dot on the row, a count on a collapsed
   folder's header.

## Decisions (agreed in brainstorming)

- **Persistence:** "done · not viewed" lasts until you view the session (unread-email model).
- **Viewed** means: the session is in a visible pane **and** the desktop window is focused,
  continuously for **1.5 s**. A turn that ends while that is already true is never marked.
- **Recent** = the last 5 sessions you viewed, excluding the active session and any session already
  listed in another tray section.
- **Who decides:** main, at turn end — a renderer that is reloading or closed still gets the mark.

## Data

Two optional `SessionMeta` fields, persisted with the session:

- `unseenAt?: number` — epoch ms of the unviewed turn end. Present ⇒ "done · not viewed".
- `lastViewedAt?: number` — epoch ms the session last counted as viewed. Feeds Recent.

Neither write bumps `updatedAt` from the viewing side (`markViewed`), for the same reason pinning
does not: the sidebar's ordering falls back to `updatedAt` and viewing must not reshuffle it.

## Main process

- `DesktopFocusTracker` (`src/main/desktop-focus.ts`) already owns window focus (from the window's
  focus/blur) and the active session. It gains a private **visible set**: `setVisible(ids)` and
  `isViewing(id) = windowFocused && visible.has(id)`. The visible set is not added to the
  `DesktopFocus` payload pushed to paired browsers. The window's `closed` event reports unfocused.
- New local-only IPC `desktop:setVisible { sessionIds: string[] }` (zod-validated; not on the
  remote surface).
- `SessionManager` gets an optional dep `isViewing(id)`. In `onTurnFinished`: for a `completed` or
  `failed` turn of a non-archived session that is not a Mission worker, if `!isViewing(id)`, set
  `unseenAt = turn.ts` and persist + push. `interrupted` turns are never marked.
- New `SessionManager.markViewed(id)`: deletes `unseenAt`, sets `lastViewedAt = now`, upserts and
  pushes without touching `updatedAt`. Exposed as local-only IPC `sessions:markViewed { id }`.
- A user-sent message clears `unseenAt` (you are evidently there).

## Renderer

- **Visible set:** `SessionPanes` publishes the ids of the panes actually on screen (all panes, or
  only the active one when the split is too narrow) to `store.visibleSessionIds`, and `[]` on
  unmount (Settings, Analytics, Skills, MCP views hide the panes).
- **`useSessionViewing()`** (replaces/extends `useReportDesktopFocus`, mounted in `App`):
  reports the visible set to `desktop:setVisible` (debounced 250 ms, desktop only), and for each
  visible session, while `store.desktopFocus.windowFocused` is true, arms a 1.5 s timer; when it
  fires it calls `sessions:markViewed`. Leaving the visible set or losing focus cancels the timer.
  Window focus comes from main's `push:desktopFocus`, so main and renderer agree on one source.
- **Header trigger** (`Sidebar.tsx`): the status cluster gains a green `N done` count and becomes a
  button that opens the tray; with no counts a clock icon button ("Recent sessions") sits in the
  header actions instead, so the tray is always reachable. Hover opens after 250 ms; click toggles
  and pins; Escape, outside click, or 300 ms after the pointer leaves both trigger and tray closes.
- **`ActivityTray.tsx`** (new): popover under the header, ~320 px. Sections, in order, empty ones
  hidden:
  1. **Needs you** — `awaiting`.
  2. **Running** — `running` / `starting`.
  3. **Done · not viewed** — `unseenAt` set and not in 1–2, newest first; a failed turn shows its
     error status dot here (so a stale error never sits in Needs you forever).
  4. **Recent** — top 5 by `lastViewedAt`, excluding the active session and sessions above.
  Rows show status dot, title, `folder · harness`, and elapsed (running) or relative time. Only
  top-level, non-archived sessions. Click (or Enter) → expand the folder if collapsed, open the
  session in the active pane, close the tray. Up/Down move between rows.
- **List markers:** a row with `unseenAt` gets an accent dot before the title and a bold title;
  a collapsed folder header shows `●N` of its unviewed sessions next to its count.

## Out of scope

- A paired phone/browser viewing a session does not clear the mark (no `markViewed` on the remote
  surface yet).
- A keyboard shortcut for "next session needing me".
- "Mark all as seen".

## Testing

- `tests/session-unseen.test.ts` (main): completed/failed off-screen → marked; viewed and focused →
  not marked; visible but unfocused → marked; interrupted → not; Mission worker → not; archived →
  not; `markViewed` clears, stamps `lastViewedAt`, does not bump `updatedAt`, pushes; a user send
  clears; IPC `sessions:markViewed` / `desktop:setVisible` reject malformed payloads and are not on
  the remote surface.
- `tests/desktop-focus.test.ts` (extend): `isViewing` needs both focus and visibility; the pushed
  payload stays unchanged.
- `tests/session-viewing.test.tsx` (renderer): the 1.5 s dwell marks only when visible and focused
  throughout; blur or leaving cancels; the visible set is reported.
- `tests/activity-tray.test.tsx` (renderer): sections and ordering, Recent de-duplication and cap,
  `done` badge count, hover/click open and close, row click expands the collapsed folder and opens
  the session, row dot and folder `●N`.
- `tests/sidebar-status-badges.test.tsx` updated for the new trigger.
- `tests/e2e.session-view.test.ts` (no-provider): seed sessions in two folders, one carrying
  `unseenAt` in a collapsed folder; the header shows `1 done`; hovering opens the tray; clicking the
  row opens the session and expands its folder; with the window reported focused, the dot and count
  clear after 1.5 s and `unseenAt` is gone from the session file on disk. Screenshot of the tray in
  `tests/artifacts/`.
