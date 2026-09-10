# Vocs Code

One desktop app for every coding agent. Pick the **harness** per session and any **model** it can reach.

| Harness | Engine | Approvals | Models |
| --- | --- | --- | --- |
| **Claude Agent SDK** | `@anthropic-ai/claude-agent-sdk` (Claude Code loop, hooks, MCP, checkpoints) | interactive (`canUseTool`) | Anthropic catalog, plus Bedrock/Vertex/Foundry/gateway via env |
| **Codex (app-server)** | `codex app-server` JSON-RPC — the same engine as the Codex desktop app | interactive (command + file-change requests), steer, interrupt | `model/list` from Codex, any `model_providers` entry |
| **Codex (exec SDK)** | `@openai/codex-sdk` | none — sandbox mode is the boundary | Codex catalog |
| **Pi** | `pi --mode rpc` + bundled approvals extension | interactive | pi's registry: Anthropic, OpenAI, Codex OAuth, Google, DeepSeek, OpenRouter, Ollama, custom |
| **ACP agent** | Agent Client Protocol over stdio: **DeepSeek Harness** (`dsh --profile acp`), Claude Agent ACP, Codex ACP, Pi ACP, Gemini CLI, anything else | interactive (`session/request_permission`) | agent-advertised config options |
| **Native loop** | built-in loop with bash / read / write / edit / glob / grep | interactive | Anthropic API or any OpenAI-compatible endpoint (OpenAI, DeepSeek, OpenRouter, Ollama, LM Studio, Groq, xAI, Mistral, Gemini) |

## What it borrows, and what it adds

From the **Codex app**: threads grouped by project, isolated git worktrees per session, sandbox-graded permission modes, steer-vs-queue while a turn runs, diff review with per-file revert and commit, `/goal` with an iteration guard.

From the **Claude Code desktop app**: multi-session sidebar with live status, permission modes (Ask / Accept edits / Plan / Auto / Full access), live model and effort switching, cost and context tracking, a side panel with Changes / Files and a real [terminal](#terminal), slash commands and `@file` mentions, notifications when a turn needs you.

Added on top: every feature above works **across all harnesses** through one normalized event model, API keys live in the OS keychain (`safeStorage`), sessions resume after restart (Claude `resume`, Codex `thread/resume`, pi session files, ACP `session/resume`, native history), and a **Doctor** page shows which runtimes are installed and logged in.

## Requirements

- Windows 10+/macOS/Linux, Node 22+, npm.
- Harness runtimes are optional and detected at runtime:
  - Claude: bundled native runtime ships with the app (uses your `~/.claude` login or an Anthropic API key).
  - Codex: bundled binary ships with the app; a system `codex` install is preferred when present (`codex login`).
  - Pi: `npm i -g @earendil-works/pi-coding-agent` (or Settings → Harnesses → Install).
  - DeepSeek Harness: `npm i -g @deepseek-ai/dsh`, or let the app run it through `npx`.

## Getting started

```bash
git clone https://github.com/vocsong/Vocs-Code.git
cd Vocs-Code
npm install
npm run dev
```

The app starts with no harness configured. Open **Settings -> Harnesses** to see which runtimes were detected, install the missing ones, and add an API key for any provider you want to reach directly. Keys are stored per provider in the OS keychain, never in this repository.

## Develop

```bash
npm install
npm run dev          # electron-vite dev server with HMR
npm run typecheck    # main + renderer
npm test             # offline suites: unit + format + review-fixes + terminal (37 tests, no network)
npm run build        # bundles to out/
npm run dist:win     # NSIS installer in dist/
```

### Verification suites

```bash
# Drive each adapter against the real runtime installed on this machine
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=codex,codex-exec,pi,claude,native,native-tools,acp npx vitest run tests/smoke.live.test.ts
# ACP against a different agent preset (dsh is the default)
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=acp HARNESS_SMOKE_ACP_AGENT=claude-agent-acp npx vitest run tests/smoke.live.test.ts

# Launch the built app with Playwright, create a session through the UI, get a reply
npm run build && HARNESS_E2E=1 HARNESS_E2E_HARNESS=native npx vitest run tests/e2e.electron.test.ts
# Approval flow through the UI (Ask mode → approval card → Allow once → file written)
HARNESS_E2E=1 npx vitest run tests/e2e.approval.test.ts
# Terminal through the UI: type into a real PTY, reload the renderer, close and exit tabs (no API key needed)
HARNESS_E2E=1 npx vitest run tests/e2e.terminal.test.ts
# The same flow against the packaged app, which proves node-pty loads from the unpacked asar
npm run dist:dir && HARNESS_E2E=1 HARNESS_E2E_EXE="$PWD/dist/win-unpacked/Vocs Code.exe" npx vitest run tests/e2e.terminal.test.ts
```

Screenshots from the e2e runs land in `tests/artifacts/`. `npm run dist:win` produces `dist/Vocs-Code-<version>-win-x64.exe` (NSIS) plus `dist/win-unpacked/`.

## Environment variables

None of these are required to run the app; they exist for headless runs and the test suites.

| Variable | Read by | Effect |
| --- | --- | --- |
| `VOCS_CODE_USER_DATA` | main process | Overrides Electron's userData directory, so a run gets isolated settings, sessions and keychain entries. |
| `VOCS_CODE_DEBUG` | main process | `1` forwards renderer console output to stdout and keeps debug-level logs in a packaged build. |
| `VOCS_CODE_SCREENSHOT` | main process | Writes a PNG of the window to this path once the UI has settled, then continues running. |
| `VOCS_CODE_SCREENSHOT_DELAY` | main process | Milliseconds to wait before that screenshot. Defaults to `2500`. |
| `VOCS_CODE_AUTOQUIT` | main process | Quits the app after this many milliseconds. Used to bound headless runs. |
| `VOCS_CODE_PERMISSION_MODE` | pi extension | Initial permission mode handed to `resources/pi/vocs-code-approvals.ts`. Set by the app when it spawns pi. |
| `VOCS_CODE_MODE_FILE` | pi extension | Path the extension re-reads before each approval, so mode changes mid-session take effect. Set by the app. |
| `VOCS_CODE` | child harnesses | Set to `1` so a spawned agent can tell it is running inside this app. |

Test-only switches:

| Variable | Effect |
| --- | --- |
| `HARNESS_SMOKE=1` | Opts into `tests/smoke.live.test.ts`, which drives real runtimes. Without it the suite skips. |
| `HARNESS_SMOKE_ONLY` | Comma-separated harness ids to exercise, for example `codex,pi,native`. |
| `HARNESS_SMOKE_ACP_AGENT` | ACP agent preset to test. Defaults to `dsh`. |
| `HARNESS_SMOKE_VERBOSE` | Prints every harness event during the smoke run. |
| `HARNESS_E2E=1` | Opts into the Playwright suites, which launch the built app from `out/`. |
| `HARNESS_E2E_HARNESS` | Which harness the e2e session uses, for example `native`. |
| `HARNESS_E2E_EXE` | Path to a packaged binary (`dist/win-unpacked/Vocs Code.exe`); the terminal e2e drives it instead of `out/`. |

The live suites need the corresponding runtime installed and logged in, and they spend real API credit.

## Terminal

The Terminal tab in the side panel is a full terminal, not a command runner. Each tab is a pseudo-terminal (ConPTY on Windows, `forkpty` elsewhere, via a prebuilt `node-pty`) rendered by xterm.js, so interactive programs, prompts, colors, progress bars, `vim`/`less`/REPLs, Ctrl+C and your shell profile all behave as they would in Windows Terminal or iTerm.

- **Shells.** New tabs start the session's working directory in the shell from *Settings → Terminal*: Auto (PowerShell on Windows, `$SHELL` elsewhere), or any detected shell — PowerShell 7, Windows PowerShell, cmd, Git Bash, WSL, zsh, bash, fish — or a custom executable. The `+` button's menu opens a one-off tab in another shell.
- **Tabs.** Several per session; titles follow the shell's own title (the running command in cmd/PowerShell), or double-click to rename. Middle-click or `×` closes; a clean `exit` closes the tab, a failed shell stays readable with a **Restart** bar.
- **Lives in the main process.** Shells keep running while you switch panel tabs, sessions, or reload the renderer; the panel re-attaches to an exact snapshot of the screen. On quit every screen is saved and the tabs come back on the next launch with their scrollback (the shell starts again when you open one) — toggle under *Settings → Terminal*.
- **Find** (`Ctrl+F`, case / regex options), **Select all**, **Clear**, **Kill process** for a hung command, clickable URLs, 10 000 lines of scrollback by default.
- **Send to agent.** The sparkle button puts the selection — or the last screenful of output — into the composer as a fenced block, so a failing build lands in the chat with one click. Output going idle also refreshes the Changes tab.
- **Shortcuts.** `Ctrl+`` focuses the terminal (again: back to the composer), `Ctrl+Shift+`` opens a new one, `Ctrl+Shift+C` / `Ctrl+Shift+V` copy and paste everywhere; on Windows/Linux `Ctrl+C` copies while text is selected (otherwise it interrupts) and `Ctrl+V` pastes. Right-click copies the selection or pastes. App chords (`Ctrl+N/K/B/J/,` and `Ctrl+1…9`) win over the shell.

Packaging: `@lydell/node-pty` ships N-API prebuilds per platform as optional dependencies, so no compiler or `electron-rebuild` step is needed; `electron-builder.yml` unpacks it from the asar because the `.node` binaries and ConPTY DLLs must be real files.

## Architecture

```
src/shared        types, IPC contract, harness metadata, diff parser (no runtime deps)
src/main
  harness/        one adapter per harness → normalized SessionEvent stream
    claude.ts     Agent SDK query() with streaming input, canUseTool approvals, file-change hooks
    codex-app-server.ts + jsonrpc.ts   Codex app-server client (thread/turn/item notifications, approval requests)
    codex-exec.ts SDK fallback
    pi.ts         pi RPC protocol; resources/pi/vocs-code-approvals.ts is the extension that adds approvals
    acp.ts        Agent Client Protocol client (DeepSeek Harness and friends)
    native/       provider-neutral agent loop, tools, Anthropic + OpenAI-compatible drivers
  models/         provider clients and model discovery, with offline catalogs and pricing
  util/           fs and async helpers shared by the adapters (no Electron imports)
  session-manager.ts  sessions, transcripts, approvals, goals, worktrees
  runtime.ts      binary discovery (PATH, app runtime dir, bundled), doctor, installer
  secrets.ts      API keys encrypted at rest via Electron safeStorage
  terminal.ts     PTY tabs (node-pty) mirrored by headless xterm for snapshots, flow control, restore
  git.ts / settings.ts / store.ts / ipc.ts / index.ts
src/preload       contextBridge (window.harness)
src/renderer      React 19 + zustand UI
  components/     sidebar, transcript, composer, diff view, terminal panel, settings, command palette
  terminal/       xterm.js instances kept alive outside React (host.ts)
  store.ts        session state; api.ts wraps the preload bridge
resources/pi      the approvals extension loaded into pi at spawn time
tests             unit + format + review-fixes run offline; smoke and e2e are opt-in
```

Permission modes map per harness:

| Mode | Claude | Codex | Pi (extension) | ACP client policy | Native |
| --- | --- | --- | --- | --- | --- |
| Ask | `default` + prompt | `untrusted` (every non-read-only command asks), workspace-write | confirm bash/edit/write | prompt | prompt |
| Accept edits | `acceptEdits` | `untrusted`, auto-accept in-workspace file changes | confirm bash only | allow in-workspace edits | allow edits |
| Plan | `plan` | read-only sandbox, decline writes | block mutations | reject mutations | read-only tools |
| Auto | `default` + auto-allow safe | `on-request`, workspace-write with network | confirm dangerous only | allow unless dangerous | allow unless dangerous |
| Full access | `bypassPermissions` | `never` + danger-full-access | never ask | allow always | allow |

Across all harnesses a dangerous command (`rm -rf`, force-push, `sudo`, piping curl into a shell, …) and any write outside the project directory always prompt below Full access, even after "Allow for session".

## Security notes

- API keys are encrypted with Electron `safeStorage` and never leave the machine except to the provider you configured.
- The renderer runs sandboxed with context isolation; all privileged work happens in the main process behind a typed IPC contract.
- "Full access" disables every prompt and sandbox. Use it only in disposable environments.

## Known limitations

- Codex exec (SDK) cannot ask for approval; prefer the app-server harness for interactive work.
- Custom Codex model providers are passed as thread config overrides and were not verified against a live OpenAI-compatible endpoint.
- ACP agents expose models only after the session starts; pick the model from the header once the agent is up.
- The terminal tab's directory tracking relies on the shell announcing its cwd (OSC 7, or OSC 9;9 as Windows Terminal profiles do); shells without such a prompt hook show the directory they started in.

## License

MIT. See [LICENSE](LICENSE).
