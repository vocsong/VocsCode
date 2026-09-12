# Logs & Environment Variables Reference

Operational details moved out of the README.

## Logs

The main process writes every line it logs to `<userData>/logs/main.log` (2 MB, one rotated `main.log.1` behind it) as well as the console:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\Vocs Code\logs\main.log` |
| macOS | `~/Library/Application Support/Vocs Code/logs/main.log` |
| Linux | `~/.config/Vocs Code/logs/main.log` |

Warnings worth grepping for when the window stops responding:

- `main event loop stalled <n>ms` — the main process blocked, which is the same thing as a window that dispatches no clicks or keystrokes. The line before it usually names the cause.
- `renderer longtask|input-delay|loop-lag <n>ms` — the renderer blocked instead: one script task ran too long (typically an unbounded render), so input queued behind it.
- `slow ipc <channel>: <n>ms` — one IPC handler held the main process that long.

## Environment variables

None of these are required to run the app; they exist for headless runs and the test suites.

| Variable | Read by | Effect |
| --- | --- | --- |
| `VOCS_CODE_USER_DATA` | main process | Overrides Electron's userData directory, so a run gets isolated settings, sessions and keychain entries. |
| `VOCS_CODE_DEBUG` | main process | `1` forwards renderer console output to stdout and keeps debug-level logs in a packaged build. |
| `VOCS_CODE_WEB` | main process | `1` starts the localhost web client: serves the built renderer (`npm run build` first) at `http://localhost:5177/?token=…` and bridges the same handler registry to a browser tab. See docs/REMOTE-ACCESS.md. |
| `VOCS_CODE_WEB_PORT` | main process | Port for the web client. Defaults to `5177`. |
| `VOCS_CODE_SCREENSHOT` | main process | Writes a PNG of the window to this path once the UI has settled, then continues running. |
| `VOCS_CODE_SCREENSHOT_DELAY` | main process | Milliseconds to wait before that screenshot. Defaults to `2500`. |
| `VOCS_CODE_AUTOQUIT` | main process | Quits the app after this many milliseconds. Used to bound headless runs. |
| `VOCS_CODE_PERMISSION_MODE` | pi extension | Initial permission mode handed to `resources/pi/vocs-code-approvals.ts`. Set by the app when it spawns pi. |
| `VOCS_CODE_MODE_FILE` | pi extension | Path the extension re-reads before each approval, so mode changes mid-session take effect. Set by the app. |
| `VOCS_CODE` | child harnesses | Set to `1` so a spawned agent can tell it is running inside this app. |

### Test-only switches

| Variable | Effect |
| --- | --- |
| `HARNESS_SMOKE=1` | Opts into `tests/smoke.live.test.ts`, which drives real runtimes. Without it the suite skips. |
| `HARNESS_SMOKE_ONLY` | Comma-separated harness ids to exercise, for example `codex,pi,native`. |
| `HARNESS_SMOKE_ACP_AGENT` | ACP agent preset to test. Defaults to `dsh`. |
| `HARNESS_SMOKE_VERBOSE` | Prints every harness event during the smoke run. |
| `HARNESS_E2E=1` | Opts into the Playwright suites, which launch the built app from `out/`. |
| `HARNESS_E2E_HARNESS` | Which harness the e2e session uses, for example `native`. |
| `VOCS_CODE_E2E_UI=1` | Opts into `tests/e2e.vision.test.ts`. Runs with every provider key stripped from the environment, so it never reaches a provider. |
| `HARNESS_E2E_EXE` | Path to a packaged binary (`dist/win-unpacked/Vocs Code.exe`); the terminal e2e drives it instead of `out/`. |

The live suites need the corresponding runtime installed and logged in, and they spend real API credit.
