# Session Activity Tray Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remember unviewed finished turns per session and surface them, plus running/awaiting/recent sessions, in a hover/click tray under the sidebar header.

**Architecture:** Main decides the mark at turn end using `DesktopFocusTracker` (window focus + a new visible-pane set reported by the renderer). The renderer clears it through `sessions:markViewed` after a 1.5 s focused dwell. A new `ActivityTray` component renders from `store.sessions`.

**Tech Stack:** Electron main (TypeScript), React + zustand renderer, zod IPC validation, Vitest + Testing Library, Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-11-09-session-activity-tray-design.md`

## Global Constraints

- No new runtime dependencies.
- Dwell before a session counts as viewed: **1500 ms**. Visible-set report debounce: **250 ms**. Tray hover-open delay: **250 ms**; hover-leave close delay: **300 ms**. Recent cap: **5**.
- New IPC channels are local-only: never added to `src/shared/remote-channels.ts`.
- `markViewed` must not change `updatedAt`.
- Only top-level (`mission?.role !== 'worker'`), non-archived sessions are marked or listed.
- Every new test must fail before its code exists.

## Review Focus

- A turn ends in the session you are looking at, with the window focused → no dot ever appears (Task 2: "viewed and focused → not marked").
- The window loses focus mid-dwell → the mark stays (Task 3: "blur cancels the dwell").
- A split is too narrow, so only the active pane shows → the hidden pane's session is not "visible" (Task 3: `visiblePaneSessions` narrow case).
- A failed turn → appears under Done with an error dot, not stuck under Needs you (Task 4: section test with a `status: 'error'` + `unseenAt` session).
- The session you're on never appears in Recent (Task 4: Recent excludes `activeId`).

---

### Task 1: Visible set on `DesktopFocusTracker` + `desktop:setVisible`

**Files:**
- Modify: `src/main/desktop-focus.ts`, `src/shared/ipc.ts:141`, `src/main/handlers.ts:761`, `src/main/index.ts` (window `closed` → `onWindowFocus(false)`)
- Test: `tests/desktop-focus.test.ts`

**Interfaces:**
- Produces: `DesktopFocusTracker.setVisible(ids: string[]): void`, `DesktopFocusTracker.isViewing(id: string): boolean`; IPC `'desktop:setVisible': [{ sessionIds: string[] }, void]`.

- [ ] Write failing tests: `isViewing` is false until both `setWindowFocused(true)` and `setVisible(['s1'])`; false for an id not in the set; `setVisible` does not call `push`; `state()` has no visible field; registry `desktop:setVisible` with `{ sessionIds: 's1' }` rejects; `'desktop:setVisible'` is not in the remote channel list.
- [ ] Run `npx vitest run tests/desktop-focus.test.ts` → FAIL.
- [ ] Implement (handler parses with `z.strictObject({ sessionIds: z.array(z.string()).max(32) })`).
- [ ] Run → PASS. Commit `feat: track which sessions the desktop shows`.

### Task 2: Mark unviewed turn ends; `markViewed`; send clears

**Files:**
- Modify: `src/shared/types.ts` (SessionMeta: `unseenAt?: number`, `lastViewedAt?: number` with doc comments), `src/main/session-manager.ts` (deps `isViewing?: (id: string) => boolean`; `onTurnFinished`; new `markViewed`; user send at `:1582` deletes `unseenAt`), `src/shared/ipc.ts`, `src/main/handlers.ts`, `src/main/index.ts` (wire `isViewing: (id) => desktopFocus.isViewing(id)` — `desktopFocus` is created after `sessions`, so pass a closure)
- Test: `tests/session-unseen.test.ts` (fixture modelled on `goalFixture` in `tests/goal-continuation.test.ts`)

**Interfaces:**
- Produces: `SessionManager.markViewed(id: string): Promise<SessionMeta>`; IPC `'sessions:markViewed': [{ id: string }, SessionMeta]`.

- [ ] Write failing tests:
  - completed turn, `isViewing → false` → `session.unseenAt === turn.ts`, `pushSessions` called.
  - failed turn → marked. interrupted → `unseenAt` undefined.
  - `isViewing → true` → not marked.
  - Mission worker (`mission: { role: 'worker', … }`) → not marked; archived → not marked.
  - `markViewed` → `unseenAt` undefined, `lastViewedAt` ≈ now, `updatedAt` unchanged, `store.upsert` called once.
  - `markViewed('nope')` rejects `Session not found`.
- [ ] Run `npx vitest run tests/session-unseen.test.ts` → FAIL.
- [ ] Implement. In `onTurnFinished`, set the mark and `schedulePersist(meta)` + `pushSessions()`. Handler: `sessions.markViewed(missionIdSchema.parse(id))`-style id validation (reuse the existing id schema).
- [ ] Run → PASS; also `npx vitest run tests/goal-continuation.test.ts`. Commit `feat: remember turns that finished unviewed`.

### Task 3: Renderer — publish visible set, dwell, mark viewed

**Files:**
- Modify: `src/renderer/src/store.ts` (`visibleSessionIds: string[]`, default `[]`, setter `setVisibleSessions(ids)`), `src/renderer/src/components/SessionPanes.tsx` (effect publishes `narrow ? [active pane session] : all pane session ids`, `[]` on unmount), `src/renderer/src/desktop-focus.ts` (new `useSessionViewing()`; keep `useReportDesktopFocus`), `src/renderer/src/App.tsx` (mount it)
- Test: `tests/session-viewing.test.tsx`

**Interfaces:**
- Consumes: IPC from Tasks 1–2; `store.desktopFocus.windowFocused`.
- Produces: `useSessionViewing(): void`; `export const VIEW_DWELL_MS = 1500`; `visiblePaneSessions(layout: PaneLayout, narrow: boolean): string[]` in `src/renderer/src/panes.ts` (used by `SessionPanes`).

- [ ] Write failing tests (fake timers, `renderHook`): visible `['s1']` + focused → after 1499 ms no `sessions:markViewed`, at 1500 ms called once with `{ id: 's1' }`; blur at 1000 ms → never called; s1 leaves the set at 1000 ms → never called; `desktop:setVisible` invoked with `{ sessionIds: ['s1'] }` after 250 ms; `isWeb` → nothing invoked; `visiblePaneSessions` returns every pane session id (empty panes skipped) and only the active pane's when `narrow`.
- [ ] Run → FAIL. Implement (one timer per id, keyed map; re-arm only when an id re-enters or focus returns). Run → PASS.
- [ ] Commit `feat: count a session as viewed after a focused dwell`.

### Task 4: Activity tray + header trigger + list markers

**Files:**
- Create: `src/renderer/src/activity.ts` (pure `activitySections(sessions, activeId): { needs, running, done, recent }`), `src/renderer/src/components/ActivityTray.tsx`
- Modify: `src/renderer/src/components/Sidebar.tsx` (trigger, `done` count, row dot, folder `●N`), `src/renderer/src/styles.css`
- Test: `tests/activity-tray.test.tsx`, update `tests/sidebar-status-badges.test.tsx`

**Interfaces:**
- Produces: `activitySections(sessions: SessionMeta[], activeId: string | null): ActivitySections` with each section `SessionMeta[]`; `<ActivityTray onClose={() => void} />`; test ids `activity-trigger`, `activity-tray`, `activity-row`, `session-unseen-dot`, `project-unseen`.

- [ ] Write failing tests:
  - `activitySections`: awaiting → needs; running/starting → running; `unseenAt` + idle or error → done, newest `unseenAt` first; recent = by `lastViewedAt` desc, cap 5, excludes `activeId` and any session in another section; archived and workers excluded everywhere.
  - Sidebar: badges `['2 running', '1 awaiting', '1 done']`; no counts → `.sidebar-status` absent and `activity-trigger` is the clock button; hover trigger → tray after 250 ms; click row in a collapsed folder → `settings:update` called with that folder removed from `collapsedFolders` and `activeId` becomes the row's id, tray closes; Escape closes; row with `unseenAt` has `session-unseen-dot`; collapsed folder with 2 unseen shows `project-unseen` text `●2`.
- [ ] Run → FAIL. Implement. Rows: `StatusDot`, title, `basename(projectRoot) · harnessShort(harness)`, time (`relTime`). Up/Down move focus among `activity-row` buttons.
- [ ] Run `npx vitest run tests/activity-tray.test.tsx tests/sidebar-status-badges.test.tsx tests/sidebar-*.test.tsx` → PASS. Commit `feat: activity tray for running, unviewed and recent sessions`.

### Task 5: E2E + docs

**Files:**
- Modify: `tests/e2e.session-view.test.ts` (new `it`), `docs/TESTING.md` (Session view chrome row: add `tests/activity-tray.test.tsx`, `tests/session-viewing.test.tsx`; session lifecycle: `tests/session-unseen.test.ts`)

- [ ] Add a test: seed two folders; folder B collapsed (`collapsedFolders`), holding a session with `unseenAt`; launch; `activity-trigger` text contains `1 done`; hover → `activity-tray` visible; screenshot `tests/artifacts/session-view-activity-tray.png`; click the row → folder B expanded, session open; emit window `focus` from main (`app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'))`); within 5 s the dot and `done` count are gone and the session's entry in the sessions index on disk has no `unseenAt`.
- [ ] `npm run build && VOCS_CODE_E2E_UI=1 npx vitest run tests/e2e.session-view.test.ts` → PASS. Commit `test: cover the activity tray end to end`.

### Task 6: Gate

- [ ] `npm run typecheck`, `npm run test:changed`, `npm run build` → all pass. Push, open PR into `develop`, merge when green.
