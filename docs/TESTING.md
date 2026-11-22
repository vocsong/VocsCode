# Testing & Verification Reference

Testing details moved out of the README and `AGENTS.md`. The working rules — verification bar,
regression coverage, E2E discipline — stay in [`AGENTS.md`](../AGENTS.md); this doc holds the
commands, the suite map and the mechanics behind them.

## Commands

```bash
npm run dev                    # electron-vite dev server with HMR
npm run typecheck              # desktop, web, relay, and tests, all strict
npm run test:changed           # broad affected-test run for shared or uncertain changes
npm run test:changed -- --list # see which test files would be selected, without running them
npm run test:pr                # reproduce the hosted develop test allowlist (not another local requirement)
npm test                       # full offline suite — release gate
npm run build                  # desktop out/ and web relay/public/app/
npm run dist:win               # NSIS installer + dist/win-unpacked/
```

An unpackaged run (`npm run dev`, `npm run preview`) keeps its settings, sessions, logs and
keychain entries in a `Vocs Code (Dev)` userData directory, under a `dev.vocs.vocscode.dev`
AppUserModelID and `Vocs Code (Dev)` Start Menu shortcut, so it never shares the installed app's
single-instance lock, shortcut or profile — the two run side by side. The e2e suites go further and
isolate every launch with their own `VOCS_CODE_USER_DATA` temp directory.

## Verification tiers

`develop` is the integration branch and is kept fast to iterate on; `master` is the release gate
and carries the full weight.

| Tier | When | Local, before the commit | CI |
| --- | --- | --- | --- |
| Develop | every PR into `develop` | affected regression tests; final typecheck and build for code/tooling; guarded E2E for changed flows | typecheck, `test:pr`, `test:relay-do`, build (Ubuntu) |
| Release | PRs into `master`, pushes to `master`, manual dispatch | nothing extra — CI runs it | full `npm test`, all no-provider E2E (`test:e2e:ci`), Windows ownership/recovery and packaged-app smoke |
| Live | by hand, as the sections below require | provider-credit and logged-in-runtime suites | never |

### Before opening a develop PR

1. **Contained change:** Run the new/edited offline tests and the named tests for the affected area
   together (`npx vitest run tests/<file>.test.ts [other exact files]`). Don't run the import graph
   or repeat the CI allowlist for the same coverage. Keep the [high-risk test shapes](#coverage-rules-for-high-risk-paths).
   For prose-only edits, review the diff and run any tests that read those docs instead of rebuilding.
   Markdown shipped as an app resource or used as a fixture isn't prose-only.
2. **Shared contract, uncertain scope, or toolchain change:** Run `npm run test:changed`. Use
   `npm run test:changed -- --list` to see the selection before committing to a long run. Still run
   required tests not in the list: Vitest's import graph can't see every subprocess input, disk
   fixture, or opt-in suite. Appending test filenames to `test:changed` *filters* its selection; it
   doesn't add extra files. An empty selection or a skipped test is not verification of a change.
3. **Final code/tooling diff:** Run `npm run typecheck` and `npm run build` once. Reuse that build
   and pass just the new/edited no-provider E2E files to `node scripts/e2e-guard.mjs`. Run manual/opt-in
   checks when the coverage map calls for them. Don't run the full release tier for a routine PR.

`test:changed` compares your branch to its merge base with `origin/develop`, plus staged, unstaged
and untracked edits. Fetch to refresh the base; set `VOCS_CODE_TEST_BASE` to use another ref. A
`package.json`, lockfile, `tsconfig*.json`, or Vite/Vitest/Electron-Vite config change **on your
branch or worktree** falls back to the full offline suite: it can affect tests that don't import it.
An upstream-only edit no longer triggers that fallback.

`tests/workspace-files.test.ts` exercises real directory junctions on Windows and directory
symlinks on POSIX for exact resolution, escapes, fallback non-traversal and dangling links. POSIX
also exercises native file symlinks; the Windows junction checks do not claim file-symlink UX
coverage or require file-symlink privileges. Non-ENOENT propagation injects `lstat` errors because
a blocked descendant can report ENOENT on Windows rather than ENOTDIR.

Failures the release gate finds are fixed on `develop` with a normal PR before the ship PR merges.
Add or extend a test when behavior changes; permission-gating changes must keep
`tests/review-fixes.test.ts` passing and extend execution-level coverage. Screenshots land in
`tests/artifacts/` (gitignored).

The relay is covered at four depths. `tests/fake-relay.ts` serves the relay's **real** route table
and frame router (`relay/src/routes.ts`, `relay/src/hub.ts`) over `ws` sockets that throw on send
after close like a Durable Object's, so the remote suites exercise production rules, not a
re-implementation. `npm run test:relay-do` runs the Hub in workerd (tags, hibernation, queues,
edge rate-limit bindings). `tests/remote-workerd.test.ts` — part of `npm test`, about four
seconds — starts the whole relay Worker locally in workerd (`tests/support/local-relay.ts`, wrangler's
programmatic dev server with a throwaway secret) and runs the full smoke flow against it over real
sockets: pairing, the sealed credential, proof-of-possession tokens, handshake, invoke, mirror key,
revocation. It is what found a refused request's unread body ending a `wrangler dev` session and a
revocation answering 500, which no fake could. `e2e.remote-web` (in `test:e2e:ci`) loads the web
app in Electron's Chromium from that local relay: the native WebSocket, IndexedDB keys across a
reload, the static CSP, the pairing link, the computer switcher, a streamed terminal typed into and
unpair;
and, through `tests/support/test-landing.ts` (a stand-in for the landing that signs per-account
assertions, gates owner routes and isolates accounts), Connect with Vocs, account switching and
pairing from the signed-in computer list. `e2e.remote` drives the desktop side of the same flow in
the real app. The opt-in **deployed** smoke runs the flow against the incumbent production account;
it needs the enrollment secret and a signed-in session cookie kept outside the repo:

```bash
REMOTE_LIVE=1 REMOTE_LIVE_ORIGIN=https://code.vocs.io \
  REMOTE_LIVE_TOKEN_FILE=/absolute/path/to/relay-enroll-token.txt \
  REMOTE_LIVE_SESSION_COOKIE_FILE=/absolute/path/to/incumbent-session-cookie.txt npm run test:remote-live
```

It attempts to revoke temporary devices and clear its mirror, including recovery through the
claimant-only poll capability if the approved browser response is lost. A failed run can still
leave devices when neither side receives credentials; inspect/revoke them through an existing
authenticated desktop before rerunning. Never run it against a shared account without
authorization. The session-cookie preflight verifies it belongs to `vocs-v1` before any mutation;
keep that HttpOnly credential private. With `REMOTE_LIVE=1`, missing origin, token file or session
cookie fails loudly before network access. `npm test` excludes it, so a green offline run is not live
verification. Run it
after any production relay/landing deploy and after pairing, socket or mirror changes; if no
credentials or deployment are available, report the live tier as unverified.

## Opt-in Electron suites (no provider key)

Use the matching `tests/e2e.<name>.test.ts` files from the coverage map. Build once for the same
checkout and pass all changed no-provider suites in one guarded invocation. For example:

```bash
npm run build && node scripts/e2e-guard.mjs tests/e2e.themes.test.ts tests/e2e.ui-modes.test.ts
# Standalone web-only check builds its own web output (no desktop bundle needed):
node scripts/e2e-guard.mjs tests/e2e.remote-web.test.ts
# If npm run build just passed in the same checkout and sources haven't changed, reuse its web output:
VOCS_CODE_E2E_WEB_PREBUILT=1 node scripts/e2e-guard.mjs tests/e2e.remote-web.test.ts
# Reproduce the full release E2E job when diagnosing release CI:
npm run build && VOCS_CODE_E2E_WEB_PREBUILT=1 npm run test:e2e:ci
```

The guard sets the UI and terminal gates and rejects skipped or uncollected tests. Run the
remaining opt-in suites only when required:

```bash
# Vesta uses a real installed Pi runtime and an offline scripted model. Reuse the desktop build.
VOCS_CODE_PI_INTEGRATION=1 node scripts/e2e-guard.mjs tests/e2e.vesta.test.ts
VOCS_CODE_E2E_UI=1 VOCS_CODE_PI_INTEGRATION=1 npx vitest run tests/pi-subagents.integration.test.ts tests/e2e.pi-tools.test.ts
# Windows auto-update: disposable unpacked app and a loopback feed (startup, manual check, handoff on quit).
npm run dist:dir -- --publish never && HARNESS_E2E_EXE="dist/win-unpacked/Vocs Code.exe" node scripts/e2e-guard.mjs tests/e2e.update.test.ts
```

`npm run test:e2e:ci` runs twenty-seven no-provider suites (including `e2e.layout`, `e2e.split`, `e2e.processes`, `e2e.dictation`, `e2e.ui-modes` and the
seeded `e2e.subagents` panel tier) and fails if any of them reports *skipped*. The real-Pi test inside
`e2e.subagents` is registered only with `VOCS_CODE_PI_INTEGRATION=1` and remains opt-in. The
`tests/test-inventory.test.ts` gate requires every `e2e.*.test.ts` file to be in that CI list or
explicitly classified as requiring a provider, installed Pi, or packaged app.

Any run with `VOCS_CODE_E2E_UI=1` or `HARNESS_E2E=1` parks its window outside every display and never
takes focus, so suites can run while you work. `VOCS_CODE_E2E_VISIBLE=1` brings the window back on
screen when you need to watch a run.

## Which suite a change must keep passing

Run the named offline tests for the area you changed. The E2E entries tell you which suite to
extend when the change affects a flow it drives; run the files you edited or added before merging.
The full no-provider inventory runs at release. Live and other opt-in checks still apply where
called out (see [Keeping the suites alive](#keeping-the-suites-alive)).

| You changed | Offline checks, E2E to maintain, and applicable opt-ins |
| --- | --- |
| Transcript link destinations and file mentions, the source editor drawer (`FilePreviewPane.tsx`, `FileSourceEditor.tsx`), Files tab, workspace file resolution and saves | `tests/transcript-link-kinds.test.tsx`, `tests/file-refs.test.ts`, `tests/file-links.test.tsx`, `tests/file-editor-language.test.ts`, `tests/markdown-cache.test.ts`, `tests/workspace-files.test.ts`, `tests/handler-registry.test.ts`, `tests/harness-setup-ipc.test.ts` + `e2e.files` (computed link and syntax colors, line jumps, real saves); Mission-scoped file access also needs `tests/mission-handlers.test.ts`, `tests/mission-ui.test.tsx` + `e2e.mission` |
| Sidebar, New Session dialog, session lifecycle | `e2e.terminal` (no key) + `e2e.electron` (live) |
| `/housekeep` review, recent-session protection and checked worktree removal | `tests/housekeep*.test.ts(x)`, `tests/handler-registry.test.ts`, `tests/harness-setup-ipc.test.ts` + `e2e.session-view` (real temporary Git worktrees and saved settings, no provider) |
| Automatic session titles (`session-title.ts`, `SessionManager.scheduleLlmTitle`) | `tests/session-title-rename.test.ts` + `e2e.session-view` (loopback utility model, turn completion and sidebar/header updates) |
| Activity tray and "done · not viewed" — the header trigger, `ActivityTray.tsx`, `activity.ts`, the viewing dwell (`useSessionViewing`), `DesktopFocusTracker`'s visible set, `SessionManager.markViewed` / turn-end marking | `tests/activity-tray.test.tsx`, `tests/session-viewing.test.tsx`, `tests/session-unseen.test.ts`, `tests/desktop-focus.test.ts` + `e2e.session-view` (review screenshot `tests/artifacts/session-view-06-activity-tray.png`) |
| Git tab (Branches, Worktrees, PRs and Issues), including `git-panel-cache.ts` | `tests/git-panel-refresh.test.tsx`, `tests/git-panel-pr-dialog.test.tsx`, `tests/git-error-banner.test.tsx`, `tests/git-setup-ui.test.tsx` + `e2e.git` (session switching in Standard and Zen, refresh and GitHub previews) |
| GitHub PR links in transcripts (`Transcript.tsx`, `git:pullRequest`) | `tests/pr.test.ts`, `tests/git-panel-pr-dialog.test.tsx`, `tests/handler-registry.test.ts` + `e2e.git` (opening the linked PR in Standard and Zen) |
| Right-click menus (`components/ContextMenu.tsx`), folder removal | `tests/context-menus.test.tsx`, `tests/folder-remove.test.ts` + `e2e.context-menu` |
| Composer, attachments, model/capability UI | `e2e.vision`, `e2e.models` |
| Composer slash commands answered in the transcript (`/doctor`) | `tests/composer-doctor.test.tsx` + `e2e.doctor` |
| Usage panel, `src/renderer/src/session-usage.ts` | `tests/session-usage.test.ts`, `tests/usage-panel.test.tsx` + `e2e.usage` |
| Analytics dashboard, `src/main/analytics*.ts`, `src/shared/analytics/**` | `tests/analytics*.test.ts(x)` + `e2e.vision` |
| Settings navigation/search, `settings-catalog.ts`, `SettingsPrimitives.tsx`, `components/settings.css` | `tests/settings-navigation.test.tsx`, `tests/branch-prefix-settings-ui.test.tsx`, `tests/context-ui.test.tsx` + `e2e.layout`; update and run the affected section’s E2E below. The layout suite captures isolated light/dark review screenshots in `tests/artifacts/settings-redesign-*.png`; see [Settings UX](SETTINGS.md). |
| Themes, `styles.css`, terminal colours | `e2e.themes`, `e2e.ui-modes` (Zen restyles the standard tree, so a `styles.css` change can move it) |
| Interface modes — `shared/ui-modes.ts`, `ui-zen.css`, `ui-mode.ts`, `applyUiMode` (`theme.ts`), Appearance → Interface, Zen's one-button title-bar menu, the CSS hooks on session rows and work chips (`data-status`, `data-tone`, `data-pinned`, `data-short`) | `tests/ui-modes.test.tsx`, `tests/ui-modes-settings.test.ts`, `tests/zen-panel-rail.test.tsx` (Zen's side-panel rail, peek and pins) + `e2e.ui-modes` (review screenshots `tests/artifacts/ui-modes-*.png`). A change to a component either mode restyles (sidebar, header, transcript, composer, side panel, settings) needs a look in Zen too |
| Terminal panel, PTY, `terminal/host.ts` | `e2e.terminal` |
| Which permission tiers a harness may run (`closestPermissionMode`, create/switch/fork/remote create) | `tests/permission-tiers.test.ts`, `tests/control-service.test.ts`, `tests/cursor-harness.test.ts` |
| Approval cards and structured questions, `harness/permissions.ts` | `tests/approval-card.test.tsx`, `tests/pi-questions.test.ts`, `tests/claude-questions.test.ts`, `tests/codex-approvals.test.ts` + `e2e.transcript` (seeded question layout/state only), `e2e.pi-tools` (real question answer/context → Pi, Skip, and restart), `e2e.approval` (live). Pi question transport also requires `VOCS_CODE_PI_INTEGRATION=1 vitest run tests/pi-questions.integration.test.ts` (scripted provider, cancellation/stale reply recovery). |
| Mission configuration, orchestration, controls or managed workspaces | `tests/mission-*.test.ts` + `e2e.mission-settings`, `e2e.mission`; managed or ordinary Pi process ownership also needs `VOCS_CODE_PI_INTEGRATION=1 vitest run tests/mission-pi.integration.test.ts tests/mission-ordinary-pi.integration.test.ts`. Suites that need Windows Job Objects (`mission-check-job`, `mission-terminal-windows`, `mission-receipt-recovery`, `mission-ordinary-pi`, the app-death part of `mission-restart-recovery`) skip on macOS/Linux, so the ubuntu CI gate does not cover them. Live demonstrations: see below and `docs/MISSION-STATUS.md`. |
| First-time onboarding and setup recovery (`harness-setup.ts`, `OnboardingWizard`, `HarnessSetup`, `OnboardingProvider`, Home/Settings/New Session entry points) | `tests/harness-readiness.test.ts`, `tests/runtime.test.ts`, `tests/harness-setup.test.ts`, `tests/harness-setup-ipc.test.ts`, `tests/onboarding-ui.test.tsx`, `tests/handler-registry.test.ts`, `tests/review-fixes.test.ts` + `e2e.models`, `e2e.vision`, `e2e.instructions`, `e2e.session-view`. Retain draft/save failure recovery, unknown sign-in, catalog fallback, stale-response, owner-main-frame dispatch and restart coverage. Use isolated, existing vendor homes and APPDATA directories; no live OAuth or paid prompts in these suites. See [Onboarding](ONBOARDING.md). |
| Google Antigravity CLI, account quota and ACP session dispatch | `tests/acp-turn-state.test.ts`, `tests/session-resume.test.ts`, `tests/harness-readiness.test.ts`, `tests/harness-setup-ipc.test.ts` + `e2e.models`, `e2e.antigravity-turn` + live `HARNESS_SMOKE_ONLY=antigravity HARNESS_SMOKE_RESUME=1`. Verify every permission mode at dispatch (Plan denials, one-time grants only), stalled-prompt recovery, and a resumed signed-in Gemini session. |
| Harness CLI update check (`runtime.ts` `checkUpdates`, Harness logins card) | `tests/harness-updates.test.ts`, `tests/harness-update-ui.test.tsx` + `e2e.vision` |
| Vesta panel, `agents/` pi bridge, `resources/pi/vocs-code-vesta.ts` | `tests/vesta.test.ts` + `e2e.vesta` (opt-in, real pi) |
| Updater, `main/updater*.ts`, sidebar update button, About updates panel | `tests/updater.test.ts`, `tests/update-ui.test.tsx` + `e2e.update` (opt-in, packaged + mock feed) |
| pi harness (`harness/pi.ts`), `resources/pi/**` | `tests/pi-steering.test.ts`, `tests/pi-steering-session.test.ts`, `tests/pi-mcp-cancellation.test.ts` + `VOCS_CODE_PI_INTEGRATION=1 vitest run tests/pi-steering.integration.test.ts tests/pi-tool-compatibility.integration.test.ts tests/pi-subagents.integration.test.ts tests/pi-questions.integration.test.ts tests/e2e.pi-tools.test.ts` + live `HARNESS_SMOKE_ONLY=pi`. Steering coverage retains shell/foreground-child cancellation with no late write, successful exactly-once redirection, queued images/FIFO order, rapid steers, natural completion, late dialogs, disposal, and delayed stats. |
| Pi global settings (`main/pi-config.ts`, Settings → Pi) | `tests/pi-config.test.ts`, `tests/pi-settings.test.tsx`, `tests/handler-registry.test.ts` + `e2e.pi-settings`; retain concurrent-write/reload, write-failure recovery, prompt-byte-budget, pending-draft and stale-response regressions. |
| Subagents panel, right-panel split | `e2e.subagents`, `e2e.layout`, `e2e.files` |
| Project knowledge and intelligence (`src/main/knowledge/**`, `src/main/intelligence/**`, `resources/mcp/vocs-memory.mjs`, Knowledge panel) | `tests/knowledge*.test.ts`, `tests/search.test.ts`, `tests/intelligence-*.test.ts`, `tests/intelligence-ui.test.tsx`, `tests/mcp-memory.test.ts`, `tests/handler-registry.test.ts` + `e2e.knowledge`; keep the real stdio-to-loopback boundary, collection isolation, revoked/forgotten records and the quit/relaunch test. |
| The app's instruction layer (`src/main/app-instructions.ts`, Settings → Instructions, `harness/system-prompt.ts`, `session-manager.ts` first-message priming) | `tests/app-instructions.test.ts`, `tests/instructions-ui.test.tsx`, `tests/claude-project-instructions.test.ts`, `tests/pi-startup-compatibility.test.ts`, `tests/fork-context.test.ts`, `tests/handler-registry.test.ts` + `e2e.instructions` |
| Chat history import (`main/chat-import.ts`, `SessionStore.importSession`, `SessionManager.importChats`, Settings/onboarding → Import chats) | `tests/chat-import*.test.ts(x)`, `tests/handler-registry.test.ts` + `e2e.instructions` (isolated Claude/Codex fixtures, accepted parent chains, unsupported lineage refusal, import/remove races, registration failure → reopen/rescan → explicit repair → restart, stale-repair refusal and native-session deduplication, skip-reason breakdown/reset, source preservation, live folder retention and restart deduplication) |
| Vocs account broker/settings and kept sign-in (`main/vocs-account.ts`, `shared/vocs-account.ts`, `VocsAccountSettings.tsx`, the `vocs-account:*` ids in `main/secrets.ts`) | `tests/vocs-account.test.ts`, `tests/vocs-account-persistent.test.ts`, `tests/vocs-account-settings.test.tsx`, `tests/handler-registry.test.ts`, the MCP OAuth suites, the `SecretStore` block of `tests/unit.test.ts` + `e2e.vocs-account`, `e2e.layout`; preserve owner-frame IPC, no-secret state, cancellation/retry/expiry/account-switch, vault-before-use rotation, offline-versus-ended refresh outcomes and no automatic tool authorization. The fake issuer in `vocs-account-persistent` follows the identity-service contract; no suite contacts a real issuer. Real PC steps: [ACCOUNT-STAGING-TEST.md](ACCOUNT-STAGING-TEST.md). |
| MCP layer (`src/main/mcp/**`), built-in servers, computer use (`mcp/cua.ts`, `cua-preview.ts`, `CuaCard.tsx`, `DesktopTab.tsx`) | `tests/mcp.test.ts`, `tests/mcp-gitnexus.test.ts`, `tests/mcp-client.test.ts`, `tests/mcp-client-http.test.ts`, `tests/mcp-oauth.test.ts`, `tests/mcp-oauth-transport-race.test.ts`, `tests/cua.test.ts`, `tests/cua-preview.test.ts`, `tests/cua-card.test.tsx`, `tests/desktop-tab.test.tsx`, `tests/right-panel-bottom.test.tsx` |
| Remote access panel, `src/main/remote/**`, relay `/devices`, audit and view-only policy, the pairing QR (`shared/qr.ts`, `PairingQr.tsx`) | `e2e.remote` + `tests/remote-audit.test.ts`, `tests/remote-host-lifecycle.test.ts`, `tests/remote-e2e.test.ts`, `tests/web-client.test.ts`, `tests/remote-ui.test.tsx`, `tests/qr.test.ts` |
| Remote controller MCP (`shared/control.ts`, `main/control/**`, controlled SessionManager turns, `relay/src/control-*.ts`, `ControlSettings.tsx`) | `tests/control-service.test.ts`, `tests/control-turns.test.ts`, `tests/control-relay.test.ts`, `tests/control-relay-workerd.test.ts`, `tests/handler-registry.test.ts`, `tests/remote-ui.test.tsx` + `e2e.remote`; retain the affected lifecycle and relay rows below. The separate landing repository owns its OAuth/consent tests; actual Dots and two-host qualification are a rollout gate, not implied by offline success. |
| Remote terminal (P3.5): `src/main/remote/terminal-streams.ts`, `TerminalManager.watch/snapshot`, `shared/remote-terminal.ts`, `src/web/terminal/**`, `src/web/sheets/TerminalSheet.tsx` | `tests/remote-terminal-streams.test.ts`, `tests/remote-e2e.test.ts`, `tests/web-terminal.test.ts`, `tests/web-terminal-sheet.test.tsx`, `tests/terminal.test.ts` + `e2e.remote-web` |
| Relay routing, accounts, auth, tokens or rate limiting (`relay/src/{account,core,routes,edge,rate}.ts`) | `tests/relay-account.test.ts`, `tests/relay-core.test.ts`, `tests/relay-routes.test.ts`, `tests/relay-edge.test.ts` + `tests/remote-e2e.test.ts`, `tests/remote-workerd.test.ts`, `test:relay-do`, `e2e.remote` |
| Web shell, relay web client and the account-partitioned browser vault (`src/web/**`, `vite.config.web.ts`, `relay/src/web-client.ts`, `relay/public/_headers`) | `tests/web-transport.test.ts`, `tests/web-router.test.ts`, `tests/web-shell.test.tsx`, `tests/web-bundle.test.ts`, `tests/web-client.test.ts`, `tests/browser-socket.test.ts`, `tests/relay-page-layout.test.ts` (reads `_headers`) + `e2e.remote-web` (real browser, CSP and account switching). Also cover desktop flows that use the changed renderer core. |
| Relay Durable Object and frame routing (`relay/src/{worker,hub}.ts`, socket lifecycle/tags/queues) | `test:relay-do`, `tests/remote-workerd.test.ts` + `test:remote-live` against the deployed origin after deploy |
| CI workflows and test runners (`.github/workflows/`, `scripts/test-*.mjs`, `scripts/e2e-guard*.mjs`, `scripts/pr-test-files.json`) | `tests/ci-workflow.test.ts` and the affected runner tests: `tests/test-changed.test.ts`, `tests/e2e-guard.test.ts`, `tests/test-metrics.test.ts`, `tests/test-inventory.test.ts`. `vitest.relay.config.ts` or relay test config changes also need `npm run test:relay-do`. |
| Split view — panes, the active pane, the divider, drag-to-split, layout restore (`panes.ts`, `components/SessionPanes.tsx`, the `layout`/`activeId` pair in `store.ts`) | `tests/session-panes.test.ts`, `tests/split-view.test.tsx` + `e2e.split`; `e2e.files` checks the editor drawer does not resize the split |
| Transcript rendering — message rows, work/command collapse groups, tool cards, shell panels (`components/Transcript.tsx`, `transcript-window.ts`) | `tests/tool-group.test.tsx`, `tests/transcript-window.test.ts`, `tests/transcript-virtual.test.tsx` + `e2e.transcript` |
| Session view chrome — the one-row header and its changes chip, the run controls under the composer (`SessionControls.tsx`), the title bar's search and Vesta launcher, the sidebar's views, the sidebar's top row (Projects / Recent switch, Archived filter, New session icon) and the list it shapes (`settings.sidebarView`), the welcome screen (`Header.tsx`, `Composer.tsx`, `TitleBar.tsx`, `Sidebar.tsx`, `Welcome.tsx`) | `tests/header-actions.test.tsx`, `tests/fast-mode-ui.test.tsx`, `tests/session-view-chrome.test.tsx`, `tests/sidebar-recent-view.test.tsx`, `tests/sidebar-nav.test.tsx`, `tests/sidebar-view-settings.test.ts` + `e2e.session-view` (review screenshots in `tests/artifacts/session-view-*.png`), `e2e.models` |
| Processes panel — process tracking, attribution and ending (`process-tracker.ts`, `process-snapshot.ts`, `process-context.ts`, `resources/processes/**`, `shared/processes.ts`, `ProcessesTab.tsx`) | `tests/process-tracker.test.ts`, `tests/process-snapshot.test.ts` (its real-reader case runs on the platform it belongs to, so ubuntu CI never runs the Windows one), `tests/process-context.test.ts`, `tests/session-process-owner.test.ts`, `tests/processes-shared.test.ts`, `tests/processes-tab.test.tsx` + `e2e.processes` |
| Composer dictation and Settings → Voice (`src/main/dictation/**`, `src/shared/dictation.ts`, `renderer/src/dictation.ts`, `DictationControl.tsx`, `VoiceSettings.tsx`) | `tests/dictation-cloud.test.ts`, `tests/dictation-local.test.ts`, `tests/dictation-service.test.ts`, `tests/composer-dictation.test.tsx` + `e2e.dictation`; a change to downloads, the pinned whisper.cpp release or the server launch also runs `VOCS_CODE_WHISPER_INTEGRATION=1 npx vitest run tests/dictation-whisper.integration.test.ts` (real download and transcription; add `VOCS_CODE_WHISPER_COMPUTE=gpu` on a Windows NVIDIA machine for the CUDA build) |
| Other `src/renderer/**` changes | The regression test and the suite(s) driving the affected flow. Add a suite for a new user-visible flow with no coverage; don't run the full E2E inventory by default. |

`.github/workflows/ci.yml` keeps develop PRs to typecheck, a reviewed fast Vitest allowlist
(`npm run test:pr`), the relay Durable Object suite, and a production build. The allowlist is recorded
in `scripts/pr-test-files.json` and runs with two isolated Vitest workers. Missing, uncollected, or
skipped tests still fail the check. This worker override does not apply to the full offline or
Electron runs. Full offline Vitest, no-provider Electron E2E, Windows ownership/recovery and
packaged-app smoke run on pull requests to `master`, pushes to `master`, and manual runs. The
Windows job preflights ConPTY ownership before the long real-Git suite; the preflight does not replace
the full no-skip run. This release gate preserves broad coverage while keeping routine develop PRs
shorter. CI prints slow files/cases and uploads sanitized timing reports; raw Vitest JSON stays in
runner temp because failure messages could contain sensitive data. The Windows E2E job sets
`VOCS_CODE_E2E_WEB_PREBUILT=1` only after `npm run build`, so `e2e.remote-web` consumes the
validated prebuilt web bundle instead of building it again. Standalone runs still build it.
Paid/live tiers remain manual.

## Optional Graphify pilot

Run the provider fixture corpus offline as normal. For CLI/artifact upgrades, install the pinned
`graphifyy==0.9.115` in a disposable environment and run:

```bash
VOCS_CODE_GRAPHIFY_TEST_EXE="/absolute/path/to/graphify" npx vitest run tests/intelligence-graphify.test.ts
```

The extra test indexes a throwaway Git repo, queries the result, commits a new revision and checks
that the original index is stale. No provider keys and no production repositories are needed.

## Coverage rules for high-risk paths

Beyond the ordinary regression test, these areas carry a required test shape:

- **Session lifecycle** — a scripted/fake adapter with the real `SessionManager` and `SessionStore`,
  including streaming, stop/error, teardown, and restart.
- **Permission changes** — tested through dispatch to prove denied operations never execute,
  including dangerous commands, outside-workspace paths, and symlink/junction escapes.
- **IPC changes** — exercise the registered handler with mocked privileged dependencies so invalid
  ids/paths cannot reach them.
- **Persistence changes** — include failure injection and recovery after a failed write.
- **Adapter changes** — cover normalized events, completion/error, cancellation, and resume or
  stale-session recovery.

## Live suites (provider credit or a logged-in runtime)

```bash
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=codex,codex-exec,cursor,pi,claude,acp,antigravity,native,native-tools npx vitest run tests/smoke.live.test.ts
# Fast opt-in, on a model this account's runtime actually advertises (premium usage).
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=codex,codex-exec,pi HARNESS_SMOKE_MODEL=gpt-6-astra HARNESS_SMOKE_FAST_MODE=1 npx vitest run tests/smoke.live.test.ts
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=claude HARNESS_SMOKE_MODEL=claude-opus-5 HARNESS_SMOKE_FAST_MODE=1 npx vitest run tests/smoke.live.test.ts
# ACP against a different agent preset (dsh is the default)
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=acp HARNESS_SMOKE_ACP_AGENT=claude-agent-acp npx vitest run tests/smoke.live.test.ts
HARNESS_SMOKE=1 HARNESS_SMOKE_RESUME=1 HARNESS_SMOKE_ONLY=codex,pi npx vitest run tests/smoke.live.test.ts  # resume round-trips (two turns per harness)
# A real model chooses Pi's structured question tool and receives an exact choice plus context.
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=pi HARNESS_SMOKE_QUESTIONS=1 npx vitest run tests/smoke.live.test.ts -t 'pi asks a structured question'
HARNESS_E2E=1 HARNESS_E2E_HARNESS=native npx vitest run tests/e2e.electron.test.ts
HARNESS_E2E=1 npx vitest run tests/e2e.approval.test.ts
```

Run the matching live smoke or e2e whenever `src/main/harness/**` changes. Live smoke assertions must
require an exact successful response, one completed turn, a final idle status, and no error/stopped
outcome; requested but unavailable harnesses fail loudly instead of reporting a green skipped run.
The live suites need the corresponding runtime installed and logged in, and they spend real API
credit. If the runtime is unavailable, leave the PR open and explain why verification is incomplete.

`HARNESS_SMOKE_MODEL` overrides the model without editing the user's CLI configuration; use an
account-advertised id. `HARNESS_SMOKE_FAST_MODE=1` explicitly requests premium speed and refuses
an observed standard fallback or unavailable state. `requested` is accepted only where the runtime
cannot report the actual served tier, not treated as proof of activation. Provider/account failures
stay failures, including Claude organizations without Fast permission. Offline Fast coverage lives
in `session-fast-mode`, `fast-mode-adapters`, `pi-fast-mode`, `fast-mode-ui` and the registered
handler tests; `e2e.models` drives both user controls and persistence without spending credit.

The Mission demonstrations (spec §22.5) have their own live driver. It runs a real Pi runtime with
no mocks, retains its artifacts outside the checkout, and never retries automatically:

```bash
# Metadata only: lists the real Pi models, sends no prompt.
VOCS_CODE_MISSION_METADATA=1 npx vitest run tests/mission-live.integration.test.ts -t metadata
# One paid demonstration at a time (A, B or C); bounds are optional overrides.
VOCS_CODE_MISSION_LIVE=1 VOCS_CODE_MISSION_LIVE_PROVIDER=<provider> VOCS_CODE_MISSION_LIVE_MODEL=<model> \
  VOCS_CODE_MISSION_LIVE_ONLY=A VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD=20 npx vitest run tests/mission-live.integration.test.ts
```

Paid runs need the user's explicit go-ahead each time. Record every outcome, including failures, in
`docs/MISSION-STATUS.md`.

## Packaged-app checks

Run `npm run dist:dir` plus the relevant suite against `HARNESS_E2E_EXE` for changes to packaging,
native modules, bundled runtime resources, or production startup:

```bash
# The same flow against the packaged app, which proves node-pty loads from the unpacked asar
npm run dist:dir && HARNESS_E2E=1 HARNESS_E2E_EXE="$PWD/dist/win-unpacked/Vocs Code.exe" npx vitest run tests/e2e.terminal.test.ts
```

The Windows `packaged-smoke` CI job runs after the full offline and no-provider E2E gates on PRs
to `master`, pushes to `master`, and manual CI dispatches — not routine develop PRs. It builds an
unpublished unpacked app and runs `e2e.packaged` through the no-skip guard. The suite uses a fresh
user-data directory, disables the live updater, and checks the packaged identity, renderer paint,
preload/core IPC (`app:info`, `sessions:list`), and a clean process exit, with bounded timeouts.
Failure screenshots and main/renderer logs are uploaded as `packaged-smoke-failure`.

```bash
npm run dist:dir -- --publish never
HARNESS_E2E_EXE="$PWD/dist/win-unpacked/Vocs Code.exe" node scripts/e2e-guard.mjs tests/e2e.packaged.test.ts
```

This checks startup under the packaged layout, not installer UX, code signing or notarization,
every bundled SDK/resource, or an actual updater install. Tag-triggered `release.yml` publication
is a separate workflow, but its `verify-tag` job refuses to build unless this CI run passed on the
tagged master commit (see [RELEASING.md](RELEASING.md#release-tag-gate)).
At minimum, also verify the affected feature; terminal-only coverage does not prove every unpacked
SDK or copied resource loads.

## Keeping the suites alive

E2E upkeep is part of the change that would break it, not a follow-up — see **E2E discipline** in
`AGENTS.md` for the rule and the change → suite table. In short:

- If your change touches something a suite drives, update that suite in the same PR, run that suite
  file, and do not merge the PR until it passes. If the change adds a user-visible flow no suite
  covers, add one. The other suites run in the release gate.
- Every suite self-skips unless its env gate is set, so `npm test` alone reports them all skipped and
  proves nothing. `scripts/e2e-guard.mjs` (behind `test:e2e:ci`) sets the gates and then fails the
  run if a named suite was skipped or collected no tests.
- Shared launch/seed/dialog steps live in `tests/e2e-ui.ts`. Reach for them instead of copying the
  dance into a new suite — duplication is what let one sidebar change break four suites at once.
- Enter the UI through roles, labels or `data-testid`. The sidebar's own "new folder" button opens a
  **native** directory chooser Playwright cannot drive, so `seedSettings()` puts the project into
  `settings.folders` and the suites click that folder's own new-session button instead.
- Screenshot checks compare decoded pixels with a tolerance (`pixelDelta`), never a file hash:
  antialiasing drifts by ±1 between paints, and a hash turns that into a phantom failure.
- Restart claims require quitting and relaunching Electron with the same `VOCS_CODE_USER_DATA`, then
  checking exact transcript/configuration state. A renderer reload alone proves only renderer
  reattachment.
- Terminal continuity checks retained output/state and a successful post-reload command, not just tab
  count.

## Packaging gotchas

- `@lydell/node-pty` and its N-API/ConPTY binaries must stay unpacked from the asar (`electron-builder.yml`); never bundle them.
- `npm run dist:dir` + `HARNESS_E2E_EXE="dist/win-unpacked/Vocs Code.exe"` is how packaged-app regressions (asar, native modules) are caught.
- `NODE_ENV=production` may be set in some environments, so a plain `npm install` omits every devDependency. If `typecheck`/`test`/`build` report missing modules, run `npm install --include=dev`.
