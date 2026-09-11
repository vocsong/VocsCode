# Testing & Verification Reference

Testing details moved out of the README.

## Commands

```bash
npm run dev          # electron-vite dev server with HMR
npm run typecheck    # main + renderer, both strict
npm test             # offline suites: unit, format, review-fixes, terminal (no network)
npm run build        # bundles to out/
npm run dist:win     # NSIS installer + dist/win-unpacked/
```

## Verification suites

```bash
# Drive each adapter against the real runtime installed on this machine
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=codex,codex-exec,pi,claude,native,native-tools,acp npx vitest run tests/smoke.live.test.ts
# ACP against a different agent preset (dsh is the default)
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=acp HARNESS_SMOKE_ACP_AGENT=claude-agent-acp npx vitest run tests/smoke.live.test.ts

# Launch the built app with Playwright, create a session through the UI, get a reply
npm run build && HARNESS_E2E=1 HARNESS_E2E_HARNESS=native npx vitest run tests/e2e.electron.test.ts
# Approval flow through the UI (Ask mode → approval card → Allow once → file written)
HARNESS_E2E=1 npx vitest run tests/e2e.approval.test.ts
# Text-only-model warning and the capability override. Needs no API key and makes no network call.
npm run build && VOCS_CODE_E2E_UI=1 npm run test:e2e:ui
# Every theme through the picker in the real app: distinct palettes, a recolored terminal, Nebula animating
npm run build && VOCS_CODE_E2E_UI=1 npm run test:e2e:themes
# Terminal through the UI: type into a real PTY, reload the renderer, close and exit tabs (no API key needed)
HARNESS_E2E=1 npx vitest run tests/e2e.terminal.test.ts
# The same flow against the packaged app, which proves node-pty loads from the unpacked asar
npm run dist:dir && HARNESS_E2E=1 HARNESS_E2E_EXE="$PWD/dist/win-unpacked/Vocs Code.exe" npx vitest run tests/e2e.terminal.test.ts
```

Screenshots from the e2e runs land in `tests/artifacts/` (gitignored). `npm run dist:win` produces `dist/Vocs-Code-<version>-win-x64.exe` (NSIS) plus `dist/win-unpacked/`.

The live suites need the corresponding runtime installed and logged in, and they spend real API credit.

## Packaging gotchas

- `@lydell/node-pty` and its N-API/ConPTY binaries must stay unpacked from the asar (`electron-builder.yml`); never bundle them.
- `npm run dist:dir` + `HARNESS_E2E_EXE="dist/win-unpacked/Vocs Code.exe"` is how packaged-app regressions (asar, native modules) are caught.
- `NODE_ENV=production` may be set in some environments, so a plain `npm install` omits every devDependency. If `typecheck`/`test`/`build` report missing modules, run `npm install --include=dev`.
