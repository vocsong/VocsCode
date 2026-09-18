# Testing & Verification Reference

Testing details moved out of the README and `AGENTS.md`. The working rules — verification bar,
regression coverage, E2E discipline — stay in [`AGENTS.md`](../AGENTS.md); this doc holds the
commands, the suite map and the mechanics behind them.

## Commands

```bash
npm run dev          # electron-vite dev server with HMR
npm run typecheck    # main + renderer + tests, all strict
npm test             # all offline suites (no network)
npm run build        # bundles to out/
npm run dist:win     # NSIS installer + dist/win-unpacked/
```

An unpackaged run (`npm run dev`, `npm run preview`) keeps its settings, sessions, logs and
keychain entries in a `Vocs Code (Dev)` userData directory, under a `dev.vocs.vocscode.dev`
AppUserModelID and `Vocs Code (Dev)` Start Menu shortcut, so it never shares the installed app's
single-instance lock, shortcut or profile — the two run side by side. The e2e suites go further and
isolate every launch with their own `VOCS_CODE_USER_DATA` temp directory.

`npm test` is the gate for every change. Add or extend a test when behavior changes;
permission-gating changes must keep `tests/review-fixes.test.ts` passing and extend execution-level
coverage. Screenshots land in `tests/artifacts/` (gitignored).

## Opt-in Electron suites (no provider key)

```bash
npm run build && npm run test:e2e:ci       # all twelve below; fails if any reports skipped
npm run build && VOCS_CODE_E2E_UI=1 npm run test:e2e:ui
npm run build && VOCS_CODE_E2E_UI=1 npm run test:e2e:themes
npm run build && VOCS_CODE_E2E_UI=1 npm run test:e2e:models
npm run build && VOCS_CODE_E2E_UI=1 npx vitest run tests/e2e.files.test.ts
npm run build && VOCS_CODE_E2E_UI=1 npx vitest run tests/e2e.pi-settings.test.ts
npm run build && VOCS_CODE_E2E_UI=1 npx vitest run tests/e2e.git.test.ts
npm run build && VOCS_CODE_E2E_UI=1 npx vitest run tests/e2e.knowledge.test.ts
npm run build && VOCS_CODE_E2E_UI=1 npx vitest run tests/e2e.remote.test.ts
npm run build && VOCS_CODE_E2E_UI=1 npx vitest run tests/e2e.usage.test.ts
npm run build && VOCS_CODE_E2E_UI=1 npx vitest run tests/e2e.goal.test.ts
npm run build && VOCS_CODE_E2E_UI=1 npx vitest run tests/e2e.context-menu.test.ts
npm run build && HARNESS_E2E=1 npm run test:e2e:terminal
# Vesta on the real pi runtime, offline scripted model (installed Pi 0.85.1; HARNESS_E2E_EXE for the packaged app).
npm run build && VOCS_CODE_E2E_UI=1 VOCS_CODE_PI_INTEGRATION=1 npx vitest run tests/e2e.vesta.test.ts
# In-app auto-update (issue #198) against a staged mock update feed (stages resources/app-update.yml in dist/win-unpacked).
# Other packaged e2e runs default VOCS_CODE_UPDATER_DISABLE=1 via isolatedEnv; pass '' to re-enable the updater.
npm run dist:dir && VOCS_CODE_E2E_UI=1 HARNESS_E2E_EXE="dist/win-unpacked/Vocs Code.exe" npx vitest run tests/e2e.update.test.ts
VOCS_CODE_E2E_UI=1 VOCS_CODE_PI_INTEGRATION=1 npx vitest run tests/pi-subagents.integration.test.ts tests/e2e.pi-tools.test.ts
VOCS_CODE_E2E_UI=1 npx vitest run tests/e2e.subagents.test.ts
```

`npm run test:e2e:ci` runs the twelve suites and fails if any of them reports *skipped*.

Any run with `VOCS_CODE_E2E_UI=1` or `HARNESS_E2E=1` parks its window outside every display and never
takes focus, so suites can run while you work. `VOCS_CODE_E2E_VISIBLE=1` brings the window back on
screen when you need to watch a run.

## Which suite a change must keep passing

Extend the matching suite in the same PR when the change touches what it drives (see **Keeping the
suites alive** below):

| You changed | Required suite(s) |
| --- | --- |
| Transcript file mentions, Files panel | `e2e.files` |
| Sidebar, New Session dialog, session lifecycle | `e2e.terminal` (no key) + `e2e.electron` (live) |
| Right-click menus (`components/ContextMenu.tsx`), folder removal | `tests/context-menus.test.tsx`, `tests/folder-remove.test.ts` + `e2e.context-menu` |
| Composer, attachments, model/capability UI | `e2e.vision`, `e2e.models` |
| Usage panel, `src/renderer/src/session-usage.ts` | `tests/session-usage.test.ts`, `tests/usage-panel.test.tsx` + `e2e.usage` |
| Analytics dashboard, `src/main/analytics*.ts`, `src/shared/analytics/**` | `tests/analytics*.test.ts(x)` + `e2e.vision` |
| Themes, `styles.css`, terminal colours | `e2e.themes` |
| Terminal panel, PTY, `terminal/host.ts` | `e2e.terminal` |
| Approval cards, `harness/permissions.ts` | `e2e.approval` (live) |
| Vesta panel, `agents/` pi bridge, `resources/pi/vocs-code-vesta.ts` | `tests/vesta.test.ts` + `e2e.vesta` (opt-in, real pi) |
| Updater, `main/updater*.ts`, update pill, About updates panel | `tests/updater.test.ts`, `tests/update-ui.test.tsx` + `e2e.update` (opt-in, packaged + mock feed) |
| pi harness (`harness/pi.ts`), `resources/pi/**` | `VOCS_CODE_PI_INTEGRATION=1 vitest run tests/pi-tool-compatibility.integration.test.ts tests/pi-subagents.integration.test.ts tests/e2e.pi-tools.test.ts` + live `HARNESS_SMOKE_ONLY=pi` |
| Subagents panel, right-panel split | `VOCS_CODE_E2E_UI=1 vitest run tests/e2e.subagents.test.ts` + `e2e.layout`, `e2e.files` |
| Project knowledge (wiki store, docs scan, distillation, PR reflection, relation graph), `src/main/knowledge/**`, `resources/mcp/vocs-memory.mjs` | `e2e.knowledge` |
| Remote access panel, `src/main/remote/**`, relay `/devices`, audit and view-only policy | `e2e.remote` + `tests/remote-audit.test.ts`, `tests/web-client.test.ts` |
| Relay routing, auth or rate limiting (`relay/src/routes.ts`, `relay/src/rate.ts`) | `tests/relay-routes.test.ts` + `tests/remote-e2e.test.ts`, `e2e.remote` |
| Relay web app layout (`relay/public/app/**`, `relay/src/page.ts`) | `tests/relay-page-layout.test.ts` + `tests/web-client.test.ts` |
| Anything else under `src/renderer/**` | `npm run test:e2e:ci` |

`.github/workflows/ci.yml` runs `npm run typecheck && npm test && npm run build` plus `test:e2e:ci`
on every PR into `develop`. The live tiers stay manual.

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
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=codex,codex-exec,cursor,pi,claude,acp,native,native-tools npx vitest run tests/smoke.live.test.ts
# ACP against a different agent preset (dsh is the default)
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=acp HARNESS_SMOKE_ACP_AGENT=claude-agent-acp npx vitest run tests/smoke.live.test.ts
HARNESS_SMOKE=1 HARNESS_SMOKE_RESUME=1 HARNESS_SMOKE_ONLY=codex,pi npx vitest run tests/smoke.live.test.ts  # resume round-trips (two turns per harness)
HARNESS_E2E=1 HARNESS_E2E_HARNESS=native npx vitest run tests/e2e.electron.test.ts
HARNESS_E2E=1 npx vitest run tests/e2e.approval.test.ts
```

Run the matching live smoke or e2e whenever `src/main/harness/**` changes. Live smoke assertions must
require an exact successful response, one completed turn, a final idle status, and no error/stopped
outcome; requested but unavailable harnesses fail loudly instead of reporting a green skipped run.
The live suites need the corresponding runtime installed and logged in, and they spend real API
credit. If the runtime is unavailable, leave the PR open and explain why verification is incomplete.

## Packaged-app checks

Run `npm run dist:dir` plus the relevant suite against `HARNESS_E2E_EXE` for changes to packaging,
native modules, bundled runtime resources, or production startup:

```bash
# The same flow against the packaged app, which proves node-pty loads from the unpacked asar
npm run dist:dir && HARNESS_E2E=1 HARNESS_E2E_EXE="$PWD/dist/win-unpacked/Vocs Code.exe" npx vitest run tests/e2e.terminal.test.ts
```

At minimum, verify packaged startup and the affected feature; terminal-only coverage does not prove
every unpacked SDK or copied resource loads.

## Keeping the suites alive

E2E upkeep is part of the change that would break it, not a follow-up — see **E2E discipline** in
`AGENTS.md` for the rule and the change → suite table. In short:

- If your change touches something a suite drives, update that suite in the same PR, and do not open
  or merge the PR until it passes. If the change adds a user-visible flow no suite covers, add one.
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
