# Vocs-Desk

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

From the **Claude Code desktop app**: multi-session sidebar with live status, permission modes (Ask / Accept edits / Plan / Auto / Full access), live model and effort switching, cost and context tracking, a side panel with Changes / Files / Terminal, slash commands and `@file` mentions, notifications when a turn needs you.

Added on top: every feature above works **across all harnesses** through one normalized event model, API keys live in the OS keychain (`safeStorage`), sessions resume after restart (Claude `resume`, Codex `thread/resume`, pi session files, ACP `session/resume`, native history), and a **Doctor** page shows which runtimes are installed and logged in.

## Requirements

- Windows 10+/macOS/Linux, Node 22+, npm.
- Harness runtimes are optional and detected at runtime:
  - Claude: bundled native runtime ships with the app (uses your `~/.claude` login or an Anthropic API key).
  - Codex: bundled binary ships with the app; a system `codex` install is preferred when present (`codex login`).
  - Pi: `npm i -g @earendil-works/pi-coding-agent` (or Settings → Harnesses → Install).
  - DeepSeek Harness: `npm i -g @deepseek-ai/dsh`, or let the app run it through `npx`.

## Develop

```bash
npm install
npm run dev          # electron-vite dev server with HMR
npm run typecheck    # main + renderer
npm test             # unit tests (vitest)
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
```

Screenshots from the e2e runs land in `tests/artifacts/`. `npm run dist:win` produces `dist/Vocs-Desk-<version>-win-x64.exe` (NSIS) plus `dist/win-unpacked/`.

Debug hooks for headless runs: `VOCS_DESK_USER_DATA` (isolate state), `VOCS_DESK_SCREENSHOT=path.png`, `VOCS_DESK_AUTOQUIT=ms`, `VOCS_DESK_DEBUG=1` (forward renderer console to stdout).

## Architecture

```
src/shared        types, IPC contract, harness metadata, diff parser (no runtime deps)
src/main
  harness/        one adapter per harness → normalized SessionEvent stream
    claude.ts     Agent SDK query() with streaming input, canUseTool approvals, file-change hooks
    codex-app-server.ts + jsonrpc.ts   Codex app-server client (thread/turn/item notifications, approval requests)
    codex-exec.ts SDK fallback
    pi.ts         pi RPC protocol; resources/pi/vocs-desk-approvals.ts is the extension that adds approvals
    acp.ts        Agent Client Protocol client (DeepSeek Harness and friends)
    native/       provider-neutral agent loop, tools, Anthropic + OpenAI-compatible drivers
  session-manager.ts  sessions, transcripts, approvals, goals, worktrees
  runtime.ts      binary discovery (PATH, app runtime dir, bundled), doctor, installer
  git.ts / shell.ts / secrets.ts / settings.ts / store.ts / ipc.ts / index.ts
src/preload       contextBridge (window.harness)
src/renderer      React 19 + zustand UI
```

Permission modes map per harness:

| Mode | Claude | Codex | Pi (extension) | ACP client policy | Native |
| --- | --- | --- | --- | --- | --- |
| Ask | `default` + prompt | `on-request`, workspace-write | confirm bash/edit/write | prompt | prompt |
| Accept edits | `acceptEdits` | auto-accept file changes | confirm bash only | allow edit kinds | allow edits |
| Plan | `plan` | read-only sandbox, decline writes | block mutations | reject mutations | read-only tools |
| Auto | `default` + auto-allow safe | workspace-write with network | confirm dangerous only | allow unless dangerous | allow unless dangerous |
| Full access | `bypassPermissions` | `never` + danger-full-access | never ask | allow always | allow |

## Security notes

- API keys are encrypted with Electron `safeStorage` and never leave the machine except to the provider you configured.
- The renderer runs sandboxed with context isolation; all privileged work happens in the main process behind a typed IPC contract.
- "Full access" disables every prompt and sandbox. Use it only in disposable environments.

## Known limitations

- Codex exec (SDK) cannot ask for approval; prefer the app-server harness for interactive work.
- Custom Codex model providers are passed as thread config overrides and were not verified against a live OpenAI-compatible endpoint.
- ACP agents expose models only after the session starts; pick the model from the header once the agent is up.
- The Terminal panel runs one-shot commands (no PTY).
