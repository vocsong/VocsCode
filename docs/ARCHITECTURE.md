# Architecture & Harness Reference

Technical reference moved out of the README. For the friendly overview, read the [README](../README.md).

## Source layout

```
src/shared        types, IPC contract, harness metadata, diff parser, theme catalogue + terminal palette (no runtime deps)
src/main
  harness/        one adapter per harness → normalized SessionEvent stream
    claude.ts     Agent SDK query() with streaming input, canUseTool approvals, file-change hooks
    codex-app-server.ts + jsonrpc.ts   Codex app-server client (thread/turn/item notifications, approval requests)
    codex-exec.ts SDK fallback
    cursor.ts     @cursor/sdk, local runtime; sandbox + plan-mode allowlist instead of approvals
    pi.ts         pi RPC protocol; resources/pi/vocs-code-approvals.ts is the extension that adds approvals
    acp.ts        Agent Client Protocol client (DeepSeek Harness and friends)
    native/       provider-neutral agent loop, tools, Anthropic + OpenAI-compatible drivers
  models/         provider clients and model discovery, with offline catalogs and pricing
  util/           fs and async helpers shared by the adapters (no Electron imports)
  session-manager.ts  sessions, transcripts, approvals, goals, worktrees
  runtime.ts      binary discovery (PATH, app runtime dir, bundled), doctor, installer
  secrets.ts      API keys encrypted at rest via Electron safeStorage
  terminal.ts     PTY tabs (node-pty) mirrored by headless xterm for snapshots, flow control, restore
  handlers.ts     transport-agnostic IPC handler registry (Electron-free, unit-tested in Node)
  web-server.ts   localhost web client (VOCS_CODE_WEB=1): serves the built renderer, bridges the registry over WebSocket
  git.ts / settings.ts / store.ts / ipc.ts / index.ts   (ipc.ts binds handlers.ts to ipcMain)
src/preload       contextBridge (window.harness)
src/renderer      React 19 + zustand UI
  components/     sidebar, transcript, composer, diff view, terminal panel, settings, command palette
    analytics/    the usage dashboard: tabs, view model (model.ts) and the SVG chart primitives (charts.tsx)
  terminal/       xterm.js instances kept alive outside React (host.ts)
  theme.ts        injects the data-driven palettes and applies the active theme to <html>
  store.ts        session state; api.ts wraps the preload bridge
resources/pi      the approvals extension loaded into pi at spawn time
tests             unit + format + review-fixes run offline; smoke and e2e are opt-in
```

## Harness matrix

| Harness | Engine | Approvals | Models |
| --- | --- | --- | --- |
| **Claude Agent SDK** | `@anthropic-ai/claude-agent-sdk` (Claude Code loop, hooks, MCP, checkpoints) | interactive (`canUseTool`) | Anthropic catalog, plus Bedrock/Vertex/Foundry/gateway via env |
| **Codex (app-server)** | `codex app-server` JSON-RPC — the same engine as the Codex desktop app | interactive (command + file-change requests), steer, interrupt | `model/list` from Codex, any `model_providers` entry |
| **Codex (exec SDK)** | `@openai/codex-sdk` | none — sandbox mode is the boundary | Codex catalog |
| **Cursor** | `@cursor/sdk` (same agent loop as the Cursor app/CLI, local runtime) | none — Cursor's sandbox + Plan-mode read-only tool allowlist are the boundary | `Cursor.models.list()`, billed to the Cursor plan |
| **Pi** | `pi --mode rpc` + bundled approvals extension | interactive | pi's registry: Anthropic, OpenAI, Codex OAuth, Google, DeepSeek, OpenRouter, Ollama, custom |
| **ACP agent** | Agent Client Protocol over stdio: **DeepSeek Harness** (`dsh --profile acp`), Claude Agent ACP, Codex ACP, Pi ACP, Gemini CLI, anything else | interactive (`session/request_permission`) | agent-advertised config options |
| **Native loop** | built-in loop with bash / read / write / edit / glob / grep | interactive | Anthropic API or any OpenAI-compatible endpoint (OpenAI, DeepSeek, OpenRouter, Ollama, LM Studio, Groq, xAI, Mistral, Gemini) |

Key invariants (enforced by convention and tsconfig project boundaries):

- Adapters implement `HarnessAdapter` (`src/main/harness/types.ts`) and receive a `HarnessContext`. Adapters must not import Electron.
- The terminal lives in the main process; the renderer re-attaches to snapshots and never owns PTY lifetime.
- API keys live only in the OS keychain via `src/main/secrets.ts` (`safeStorage`) — never in settings, logs, transcripts, or the repo.
- Sessions must resume after restart for every harness.

## Permission mode mapping

| Mode | Claude | Codex | Pi (extension) | ACP client policy | Native |
| --- | --- | --- | --- | --- | --- |
| Ask | `default` + prompt | `untrusted` (every non-read-only command asks), workspace-write | confirm bash/edit/write | prompt | prompt |
| Accept edits | `acceptEdits` | `untrusted`, auto-accept in-workspace file changes | confirm bash only | allow in-workspace edits | allow edits |
| Plan | `plan` | read-only sandbox, decline writes | block mutations | reject mutations | read-only tools |
| Auto | `default` + auto-allow safe | `on-request`, workspace-write with network | confirm dangerous only | allow unless dangerous | allow unless dangerous |
| Full access | `bypassPermissions` | `never` + danger-full-access | never ask | allow always | allow |

Across all harnesses a dangerous command (`rm -rf`, force-push, `sudo`, piping curl into a shell, …) and any write outside the project directory always prompt below Full access, even after "Allow for session". Logic lives in `src/main/harness/permissions.ts`.

## Security notes

- API keys are encrypted with Electron `safeStorage` and never leave the machine except to the provider you configured.
- The renderer runs sandboxed with context isolation; all privileged work happens in the main process behind a typed IPC contract.
- ACP read requests intentionally allow the agent's `readTextFile` callback to open absolute paths, matching the read policy of the other harnesses; approvals gate writes and commands, not reads. Use ACP with an agent you trust if the machine contains sensitive files outside the project.
- "Full access" disables every prompt and sandbox. Use it only in disposable environments.

## Usage analytics

`userData/analytics.json` feeds the Analytics view. The main-process `AnalyticsStore` (`src/main/analytics.ts`) turns every cumulative usage report into a delta against the session's last totals and adds it to a UTC day bucket, attributing it to the harness, model and project active at that moment (`UsageDay.by`, which also remembers the session ids, per-tool counts and per-file change counts of the day). Session snapshots and the all-time per-tool and per-file maps survive session deletion, so history never shrinks.

The dashboard (`src/renderer/src/components/analytics/`) asks for one range at a time and scopes every tab to it. All-time views come from the session records; bounded ranges (7, 30, 90 days) come from the day slices through the shared `src/shared/usage-rollup.ts`, and the summary also carries the preceding window so tiles can show period-over-period change. Days recorded before slices existed are reconstructed once on load from the sessions last active that day, in proportion to their lifetime usage (per-tool and per-file counts are shared out from the all-time maps by call volume); those days are flagged `estimated` and the dashboard says so. A legacy day with no matching session keeps its usage in the totals only and is labelled "unattributed" until it ages out of the bounded ranges. Series colours come from `CHART_SERIES` in `src/shared/themes.ts`, a categorical palette validated for colour-vision separation on every theme surface (the theme hues themselves are UI accents and fail those checks); single-series charts use the theme accent.

## Known limitations

- Codex exec (SDK) cannot ask for approval; prefer the app-server harness for interactive work.
- The Cursor harness cannot ask for approval either; safety comes from Cursor's sandbox (Auto) and Plan mode. A `.cursor/hooks.json` approval bridge is a possible follow-up.
- Cursor usage is billed to the user's Cursor plan, so the analytics show tokens but no dollar cost for that harness.
- Custom Codex model providers are passed as thread config overrides and were not verified against a live OpenAI-compatible endpoint.
- ACP agents expose models only after the session starts; pick the model from the header once the agent is up.
- The terminal tab's directory tracking relies on the shell announcing its cwd (OSC 7, or OSC 9;9 as Windows Terminal profiles do); shells without such a prompt hook show the directory they started in.
