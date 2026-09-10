# AGENTS.md

Working agreements for agents in this repo: how to verify, what to touch, what to leave alone. Six harness adapters (Claude Agent SDK, Codex app-server, Codex exec SDK, Pi, ACP, native) all emit one normalized `SessionEvent` stream — keep it that way.

## Working style

- **Run to done.** Take a task from understanding through edit, verification (below), and a local commit on the current `claude/<slug>` branch. Report when finished; don't stop for approval mid-task unless there's a real fork in the road (ambiguous requirement, destructive action, new dependency).
- **Verification bar.** Every change must pass `npm run typecheck`, `npm test`, and `npm run build` before the commit. A change that touches a harness adapter (`src/main/harness/**`) additionally runs that harness's opt-in suite — `tests/smoke.live.test.ts` (via `HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=<id>`) or the matching e2e. These need the runtime installed and logged in and spend real credit. If the runtime is unavailable, say so in the report rather than skipping silently; never stub a live suite into passing.
- **Stay in scope.** Surgical by default: change only what the task needs. Trivial adjacent problems are fair game to fix inline (a typo, an obvious bug, a missing type in a file you are already editing). Anything larger — a refactor, a rename, an unrelated fix — goes in the report as a note, not the diff.
- **Dependencies.** Never add a runtime dependency without asking first. Dev-only tooling and new source files are fine when the task needs them.
- **UI is open.** No mandated reuse rule: build new components and patterns when they are the better fit. The primitives in `components/ui.tsx` and the CSS variables in `styles.css` are available, not required. A UI library is still a runtime dependency — ask first (see Dependencies).
- **Git history.** Rebase or force-push your own `claude/<slug>` branch freely. Never rewrite `develop` or `master` history, and never force-push a branch you did not create (the permission gate still prompts for force-push below Full access).
- **Report tight.** The final write-up — and the PR description — is bullets: files touched, what changed and why, the exact verification run, and anything noted but not fixed. No process narration.
- **Deliver a PR.** After the local commit, push the `claude/<slug>` branch and open a PR into `develop`. Never merge it yourself unless the user explicitly instructs it; `develop` is the integration branch and you review.

## Commands

```bash
npm run dev          # electron-vite dev server with HMR
npm run typecheck    # main + renderer, both strict; run before calling work done
npm test             # offline suites only (unit, format, review-fixes, terminal); no network
npm run build        # bundles to out/
npm run dist:win     # NSIS installer + dist/win-unpacked/
```

Opt-in suites that spend real credit or need a logged-in runtime (`tests/`):

```bash
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=codex,pi,native npx vitest run tests/smoke.live.test.ts
HARNESS_E2E=1 HARNESS_E2E_HARNESS=native npx vitest run tests/e2e.electron.test.ts
HARNESS_E2E=1 npx vitest run tests/e2e.approval.test.ts
HARNESS_E2E=1 npx vitest run tests/e2e.terminal.test.ts
VOCS_CODE_E2E_UI=1 npm run test:e2e:ui
```

`npm test` is the gate for every change. Add or extend a test when behavior changes; permission-gating changes must keep `tests/review-fixes.test.ts` passing and should extend it. Screenshots land in `tests/artifacts/` (gitignored).

## Architecture rules

Layering is enforced by convention and by `tsconfig` project boundaries:

- `src/shared` — types, IPC contract, harness metadata, diff parser. **No runtime deps, no Electron imports**; importable from every process.
- `src/main` — all privileged work. `harness/` holds one adapter per harness; `models/` provider clients; `util/` has no Electron imports so adapters stay unit-testable in Node.
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
- Commit messages are imperative sentence case with no prefix (`Show the shell's directory in the terminal strip`).
- Keep platform-specific behavior tested on Windows and POSIX paths; the test suites branch on `process.platform` deliberately.

## Gotchas

- `@lydell/node-pty` and its N-API/ConPTY binaries must stay unpacked from the asar (`electron-builder.yml`); never bundle them.
- `npm run dist:dir` + `HARNESS_E2E_EXE="dist/win-unpacked/Vocs Code.exe"` is how packaged-app regressions (asar, native modules) are caught.
- Never commit build output (`out/`, `dist/`), `node_modules/`, or `tests/artifacts/`.
- `NODE_ENV=production` is set in this environment, so a plain `npm install` omits every devDependency. If `typecheck`/`test`/`build` report missing modules (`typescript`, `vitest`, `@types/node`, `electron-vite`), run `npm install --include=dev`.
- This file is loaded by pi and other agents at startup; keep it accurate when commands, layout, or invariants change.
