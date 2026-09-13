# Logs & Environment Variables Reference

Operational details moved out of the README.

## Logs

The main process writes every line it logs to `<userData>/logs/main.log` (2 MB, one rotated `main.log.1` behind it) as well as the console:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\Vocs Code\logs\main.log` |
| macOS | `~/Library/Application Support/Vocs Code/logs/main.log` |
| Linux | `~/.config/Vocs Code/logs/main.log` |

The first lines of every run name the version, the user-data directory and the log file path itself, so a bug report can quote them.

### What gets logged

Levels: `ERROR` is something that broke a feature or the app (a harness that failed to start, a renderer crash, a fatal harness error). `WARN` is a recoverable failure or a suspicious state (a corrupt store quarantined, a failed IPC call, a timed-out `git`, a key that could not be decrypted). `INFO` is the timeline of what happened (sessions created and deleted, harnesses started and stopped, turns, approvals, terminals). `DEBUG` is only kept in development or with `VOCS_CODE_DEBUG=1` (harness stderr, resolved MCP servers, non-zero `git` probes, settings keys).

Session lines are prefixed `[<sessionId>]`, so `grep s_abc123 main.log` is one session's history: `starting <harness>`, `<harness> started in <n>ms`, `turn completed in <s>s (<in> in / <out> out) $<cost>`, `approval <id> requested … → allow|deny`, `harness stopped`, `<harness> fatal error`, `permission mode ask → full-auto`, `session deleted`.

Renderer failures reach the same file: uncaught exceptions and unhandled rejections arrive as `[renderer] uncaught exception: …` (structured, via `app:log`, capped at 20 per minute), and the renderer's own `console.error`/`console.warn` output as `[renderer console] …` — in every build, not just development. Chromium helper processes dying (`renderer process gone`, `GPU process gone`), an unresponsive window, a failed page load and a broken preload script are logged too.

Store corruption is never silent: a `settings.json`, `sessions.json`, `secrets.json`, `analytics.json` or terminal snapshot that is not valid JSON is copied to `<file>.corrupt-<timestamp>` and a `WARN` names both paths; a transcript with unparsable lines reports how many were skipped.

Secrets never appear. Log lines name provider ids, never keys, and every line passes through a redaction filter before it is written (`sk-…`, `gsk_…`, `xai-…`, `AIza…`, GitHub tokens, `Bearer …` headers and any `api_key=…`/`"apiKey": "…"`/`token: …` assignment become `[redacted]`). The filter is a safety net for harness stderr and error messages that echo a request, not a licence to log keys.

Warnings worth grepping for when the window stops responding:

- `main event loop stalled <n>ms` — the main process blocked, which is the same thing as a window that dispatches no clicks or keystrokes. The line before it usually names the cause.
- `renderer longtask|input-delay|loop-lag <n>ms` — the renderer blocked instead: one script task ran too long (typically an unbounded render), so input queued behind it.
- `slow ipc <channel>: <n>ms` — one IPC handler held the main process that long.
- `the window became unresponsive` / `renderer process gone` — Chromium's own verdict on the renderer; the lines before it say what it was doing.

Worth grepping for when a feature misbehaves:

- `ipc <channel> failed: <error>` — the main-process side of every error toast the renderer shows.
- `<harness> failed to start after <n>ms` and the `spawning <harness>: <path> (<source> runtime)` line above it — which binary was used and why it did not come up.
- `is not valid JSON` / `skipped <n> unparsable line(s)` — a store or transcript was damaged and quarantined.
- `could not decrypt the stored API key for <provider>` — the OS keychain no longer opens the stored key; re-enter it.
- `git … timed out` / `gh … timed out` — why the Changes or Branches panel is missing data.
- `log file … is not writable` (console only) — the log itself could not be opened; this run is console-only.

## Environment variables

None of these are required to run the app; they exist for headless runs and the test suites.

| Variable | Read by | Effect |
| --- | --- | --- |
| `VOCS_CODE_USER_DATA` | main process | Overrides Electron's userData directory, so a run gets isolated settings, sessions and keychain entries. |
| `VOCS_CODE_DEBUG` | main process | `1` keeps debug-level lines (harness stderr, MCP resolution, git probes, renderer `console.log`) in a packaged build. Renderer warnings and errors are logged regardless. |
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
