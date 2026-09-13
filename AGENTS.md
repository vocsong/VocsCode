# AGENTS.md

Working agreements for agents in this repo: how to verify, what to touch, what to leave alone. Seven harness adapters (Claude Agent SDK, Codex app-server, Codex exec SDK, Cursor, Pi, ACP, native) all emit one normalized `SessionEvent` stream — keep it that way.

## Working style

- **Run to done.** Take a task from understanding through edit, verification (below), and a local commit on the current agent branch (see Git history). Report when finished; don't stop for approval mid-task unless there's a real fork in the road (ambiguous requirement, destructive action, new dependency).
- **One question at a time.** When the user asks you to ask them questions, ask a single question and wait for the answer before asking the next; never batch several into one prompt.
- **Verification bar.** Every change must pass `npm run typecheck`, `npm test`, and `npm run build` before the commit. Then run the narrowest relevant integration tier below. A skipped suite is not verification: confirm the requested tests actually executed, and report unavailable runtimes, credentials, or platforms rather than silently accepting skips. Never stub a live suite into passing.
- **Regression coverage.** Behavior changes need a test that fails before the fix and passes after it. Assert user-visible outcomes and production boundaries, not merely helper return values or implementation details; an assertion hidden in `.catch()` is invalid because unexpected success can pass. Prefer exact terminal states/counts where duplication, retries, or partial writes are risks.
- **High-risk paths.** Session lifecycle tests use a scripted/fake adapter with the real `SessionManager` and `SessionStore`, including streaming, stop/error, teardown, and restart. Permission changes are tested through dispatch to prove denied operations never execute, including dangerous commands, outside-workspace paths, and symlink/junction escapes. IPC changes exercise the registered handler with mocked privileged dependencies so invalid ids/paths cannot reach them. Persistence changes include failure injection and recovery after a failed write. Adapter changes cover normalized events, completion/error, cancellation, and resume or stale-session recovery.
- **E2E discipline.** UI/session changes run the relevant no-provider Electron suite after `npm run build` — `npm run test:e2e:ci` runs all four and fails if any of them reports *skipped*. **E2E upkeep ships with the change, never as a follow-up:** if the task adds, renames, moves or removes anything a suite drives — an entry point, a control, a panel, a whole flow — then the matching suite is added or updated *in the same PR*, and the PR is neither opened nor merged until it passes. A new user-visible flow that no suite covers needs a new one; "the existing suites still pass" is not enough when the feature they should cover is untested. Keep selectors aligned with the real UI: enter through roles, labels or `data-testid`, never layout-dependent CSS, and put shared steps in `tests/e2e-ui.ts` rather than duplicating them — duplicated entry steps are why one sidebar change once broke four suites at once. Restart claims require quitting and relaunching Electron with the same `VOCS_CODE_USER_DATA`, then checking exact transcript/configuration state. Renderer reload alone proves only renderer reattachment. Terminal continuity checks retained output/state and a successful post-reload command, not just tab count.
- **Stay in scope.** Surgical by default: change only what the task needs. Trivial adjacent problems are fair game to fix inline (a typo, an obvious bug, a missing type in a file you are already editing). Anything larger — a refactor, a rename, an unrelated fix — goes in the report as a note, not the diff.
- **Dependencies.** Never add a runtime dependency without asking first. Dev-only tooling and new source files are fine when the task needs them.
- **UI is open.** No mandated reuse rule: build new components and patterns when they are the better fit. The primitives in `components/ui.tsx` and the CSS variables in `styles.css` are available, not required. A UI library is still a runtime dependency — ask first (see Dependencies).
- **No AI attribution in commits.** Never append `Co-Authored-By` or "Generated with …" trailers; every commit is authored and committed as Vocs Ong only. `.claude/settings.json` pins Claude Code's `includeCoAuthoredBy: false`, and `CLAUDE.md` imports this file — keep both if the harness list changes.
- **Git history.** Work on your own agent branch (`<agent>/<slug>`, e.g. `pi/<slug>`). Rebase or force-push your own agent branch freely. Never rewrite `develop` or `master` history, and never force-push a branch you did not create (the permission gate still prompts for force-push below Full access).
- **PR titles feed releases.** PRs are squash-merged into `develop`, so the PR title becomes the commit that release-please parses on `master` to write the changelog and pick version bumps. Titles must follow Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `refactor:`, `test:`) with imperative sentence case after the prefix. The `develop` → `master` ship PR is the one exception — rebase-merge it so the individual conventional commits land on master's first-parent chain where the bot parses them (a merge commit hides them under its PR title). See [docs/RELEASING.md](docs/RELEASING.md).
- **Report tight.** The final write-up — and the PR description — is a short structured report, same shape every time, bullets only, no process narration:
  - **Task** — one-line recap of the original task as it was asked, so the report stands alone.
  - **Files** — files touched, grouped by what changed and why.
  - **Verification** — the exact commands run and their results (pass/fail); name anything that could not be run and why.
  - **PR** — merge status: merged into `develop` with the PR link, or left open for review with the reason it was not merged.
  - **Notes** — anything spotted but deliberately not fixed, out of scope, or left for follow-up. Omit if empty.
- **Deliver a PR — and merge it.** After the local commit, push the agent branch and open a PR into `develop`. By default, merge the PR yourself once verification passes (`develop` is the integration branch; releases ship from `develop` → `master`, see [docs/RELEASING.md](docs/RELEASING.md)). Skip merging only when the user explicitly says to hold the PR for review, or when the change needs further consideration before it lands (touching permission gating or secrets handling, skipping a required verification run, an ambiguous requirement the user hasn't confirmed, or a destructive action). When you don't merge, say so in the report and why, and leave the PR open for review.

## Commands

```bash
npm run dev          # electron-vite dev server with HMR
npm run typecheck    # main + renderer + tests, all strict; run before calling work done
npm test             # all offline suites; no network
npm run build        # bundles to out/
npm run dist:win     # NSIS installer + dist/win-unpacked/
```

Opt-in Electron suites that do not need provider credit:

```bash
npm run build && npm run test:e2e:ci       # all four below; fails if any reports skipped
npm run build && VOCS_CODE_E2E_UI=1 npm run test:e2e:ui
npm run build && VOCS_CODE_E2E_UI=1 npm run test:e2e:themes
npm run build && VOCS_CODE_E2E_UI=1 npm run test:e2e:models
npm run build && HARNESS_E2E=1 npm run test:e2e:terminal
```

Which suite a change must keep passing — and extend, per **E2E discipline**:

| You changed | Required suite(s) |
| --- | --- |
| Sidebar, New Session dialog, session lifecycle | `e2e.terminal` (no key) + `e2e.electron` (live) |
| Composer, attachments, model/capability UI | `e2e.vision`, `e2e.models` |
| Themes, `styles.css`, terminal colours | `e2e.themes` |
| Terminal panel, PTY, `terminal/host.ts` | `e2e.terminal` |
| Approval cards, `harness/permissions.ts` | `e2e.approval` (live) |
| Anything else under `src/renderer/**` | `npm run test:e2e:ci` |

`.github/workflows/ci.yml` runs the gate plus `test:e2e:ci` on every PR into `develop`. The live tiers below stay manual.

Live suites that spend provider credit or need a logged-in runtime:

```bash
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=codex,codex-exec,cursor,pi,claude,acp,native,native-tools npx vitest run tests/smoke.live.test.ts
HARNESS_SMOKE=1 HARNESS_SMOKE_RESUME=1 HARNESS_SMOKE_ONLY=codex,pi npx vitest run tests/smoke.live.test.ts  # resume round-trips (two turns per harness)
HARNESS_E2E=1 HARNESS_E2E_HARNESS=native npx vitest run tests/e2e.electron.test.ts
HARNESS_E2E=1 npx vitest run tests/e2e.approval.test.ts
```

Run the matching live smoke or e2e whenever `src/main/harness/**` changes. Live smoke assertions must require an exact successful response, one completed turn, a final idle status, and no error/stopped outcome; requested but unavailable harnesses fail loudly instead of reporting a green skipped run. If the runtime is unavailable, leave the PR open and explain why verification is incomplete.

Run `npm run dist:dir` plus the relevant suite against `HARNESS_E2E_EXE` for changes to packaging, native modules, bundled runtime resources, or production startup. At minimum, verify packaged startup and the affected feature; terminal-only coverage does not prove every unpacked SDK or copied resource loads.

`npm test` is the gate for every change. Add or extend a test when behavior changes; permission-gating changes must keep `tests/review-fixes.test.ts` passing and extend execution-level coverage. Screenshots land in `tests/artifacts/` (gitignored).

## Architecture rules

Layering is enforced by convention and by `tsconfig` project boundaries:

- `src/shared` — types, IPC contract, harness metadata, diff parser. **No runtime deps, no Electron imports**; importable from every process.
- `src/main` — all privileged work. `harness/` holds one adapter per harness; `models/` provider clients; `util/` has no Electron imports so adapters stay unit-testable in Node. `handlers.ts` is the Electron-free IPC handler registry and `ipc.ts` binds it to Electron.
- `src/preload` — the only bridge. Renderer calls go through `window.harness`; channels and payloads are defined once in `src/shared/ipc.ts`.
- `src/renderer` — React 19 + zustand. **Never touches Node or Electron directly.** `terminal/host.ts` keeps xterm.js instances alive outside React.

Key invariants:

- Adapters implement `HarnessAdapter` (`src/main/harness/types.ts`) and receive a `HarnessContext`. Adapters must not import Electron.
- The terminal lives in the main process; the renderer re-attaches to snapshots and must never own PTY lifetime.
- API keys live only in the OS keychain via `src/main/secrets.ts` (`safeStorage`). Never write keys to settings, logs, transcripts, or the repo.
- Dangerous commands (`rm -rf`, force-push, `sudo`, pipe-to-shell, …) and any write outside the workspace always prompt below Full access, even after "Allow for session". Logic lives in `src/main/harness/permissions.ts`.
- Sessions must resume after restart for every harness; keep that path working when touching persistence.

## Adding a harness

Touch all of these: add an adapter in `src/main/harness/<id>.ts`, register the case in `src/main/harness/registry.ts`, add the id to `HarnessId` in `src/shared/types.ts`, add its descriptor/capabilities in `src/shared/harness-meta.ts`, and wire detection/install/doctor in `src/main/runtime.ts`. Permission modes must map through the shared model (see README table).

## Conventions

- TypeScript strict, ESM, 2-space indent, single quotes, semicolons, trailing commas. `@shared/*` (main) and `@renderer/*` (renderer) aliases are configured in `electron.vite.config.ts` and the tsconfigs.
- Comments and file headers are short and explanatory; match the existing terse style rather than narrating every line.
- Commit messages inside a PR are imperative sentence case with no prefix (`Show the shell's directory in the terminal strip`); the PR title — which becomes the squash-merge commit — is Conventional Commits (`feat: Show the shell's directory in the terminal strip`).
- Keep platform-specific behavior tested on Windows and POSIX paths; the test suites branch on `process.platform` deliberately.

## Gotchas

- `@lydell/node-pty` and its N-API/ConPTY binaries must stay unpacked from the asar (`electron-builder.yml`); never bundle them.
- `npm run dist:dir` + `HARNESS_E2E_EXE="dist/win-unpacked/Vocs Code.exe"` is how packaged-app regressions (asar, native modules) are caught.
- Never commit build output (`out/`, `dist/`), `node_modules/`, or `tests/artifacts/`.
- `NODE_ENV=production` is set in this environment, so a plain `npm install` omits every devDependency. If `typecheck`/`test`/`build` report missing modules (`typescript`, `vitest`, `@types/node`, `electron-vite`), run `npm install --include=dev`.
- This file is loaded by pi and other agents at startup; keep it accurate when commands, layout, or invariants change.
