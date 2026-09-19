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
  knowledge/      Layer 2 project knowledge: markdown wiki store, scored retrieval, synthesis and
                  distillation jobs, publish (docs/MEMORY.md); resources/mcp/vocs-memory.mjs is
                  the stdio MCP server every harness reaches it through
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

| Harness | Engine | Approvals | Models | MCP |
| --- | --- | --- | --- | --- |
| **Claude Agent SDK** | `@anthropic-ai/claude-agent-sdk` (Claude Code loop, hooks, MCP, checkpoints) | interactive (`canUseTool`) | Claude's catalog plus every provider with an Anthropic-format endpoint (OpenRouter, DeepSeek, OpenCode Go, or an anthropic-kind gateway); the endpoint follows the selected model's provider, with Bedrock/Vertex/Foundry via env | injected (`options.mcpServers`) |
| **Codex (app-server)** | `codex app-server` JSON-RPC — the same engine as the Codex desktop app | interactive (command + file-change requests), steer, interrupt | Codex's `model/list` plus every enabled OpenAI-wire provider (OpenRouter, DeepSeek, OpenCode Go, Groq, …), registered per session as a `model_providers` entry using the Responses API | injected (`config.mcp_servers`) |
| **Codex (exec SDK)** | `@openai/codex-sdk` | none — sandbox mode is the boundary | Codex catalog | injected (`config.mcp_servers`; secrets via the environment) — Codex declines MCP tool calls under this adapter's `approvalPolicy: never` |
| **Cursor** | `@cursor/sdk` (same agent loop as the Cursor app/CLI, local runtime) | none — Cursor's sandbox + Plan-mode read-only tool allowlist are the boundary | `Cursor.models.list()`, billed to the Cursor plan | inherited — Cursor reads its own `mcp.json`; import/export only |
| **Pi** | `pi --mode rpc` + bundled approvals and MCP-bridge extensions | interactive | pi's registry plus the app's bundled catalogs for every provider pi already lists (Anthropic, OpenAI, Codex OAuth, Google, DeepSeek, OpenRouter, OpenCode Go, Ollama, custom) | injected — the bridge extension registers each MCP tool with pi |
| **ACP agent** | Agent Client Protocol over stdio: **DeepSeek Harness** (`dsh --profile acp`), Claude Agent ACP, Codex ACP, Pi ACP, Gemini CLI, anything else | interactive (`session/request_permission`) | agent-advertised config options | injected (`session/new.mcpServers`) |
| **Native loop** | built-in loop with bash / read / write / edit / glob / grep | interactive | Anthropic API or any OpenAI-compatible endpoint (OpenAI, DeepSeek, OpenRouter, OpenCode Go, Ollama, LM Studio, Groq, xAI, Mistral, Gemini) | client — the app runs the MCP client itself |

**Pi's tool set is Vocs Code's, on Pi's implementations.** `resources/pi/vocs-code-tools.ts`
registers Pi's own `grep`, `find` and `ls` definitions under the names `rg`, `glob` and `ls`, so a Pi
session starts with `read, bash, edit, write, rg, glob, ls` active and never needs a shell to search
or list. They are extension tools, which is what makes them active by default while still honouring
`--tools`, `--exclude-tools` and `--no-tools`; a `--tools` allowlist could not express that default
because it also filters MCP and subagent tools. Pi's built-in `grep`/`find` stay inactive, and
delegated Pi subagents — separate in-process sessions with per-agent tool lists — keep them.

Delegated agents differ too. A Claude session's subagents run on the **session's own model**: the
adapter sets `CLAUDE_CODE_SUBAGENT_MODEL` to it and, while the project pins no model of its own,
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` alongside it. The pair is required — Claude Code's built-ins
declare `model: inherit`, which on an endpoint that is not Anthropic resolves to an Anthropic id and
is refused with a `401 ... model sent to the API`. A project definition in `.claude/agents` that
names a model wins instead, which is why `_FORCE` is withheld the moment one does; the Subagents
tab's **Models** view lists every type with the model it will run on, edits that one field, and
writes the definition that overrides a built-in the user chooses to replace.

Context reduction differs the same way. Most engines take an app-requested `compact()` at an idle
boundary between turns. Claude's CLI instead reduces context from inside the turn that needs it, so
its adapter exposes `setAutoCompactionWindow(tokens)`: the app hands over the token window that the
auto-compaction setting resolves to and the engine decides when to use it. An adapter that offers
that method is never sent compaction requests, and `undefined` restores the engine's own default.

`/goal` has a per-session driver (`src/shared/goal-driver.ts`): the Claude adapter reports the slash
commands its CLI accepts (`supportedCommands()` on init, refreshed on `commands_changed`), and when
that list — or, before the harness has started, a `goal` skill on disk — names `goal`, the composer
forwards `/goal …` to the harness and the app sets no goal of its own. Every other session keeps the
app's goal engine. Settings → Goal defaults (`preferHarness`) forces the app driver everywhere.

## Layering rules

Layering is enforced by convention and by `tsconfig` project boundaries:

- `src/shared` — types, IPC contract, harness metadata, diff parser. **No runtime deps, no Electron imports**; importable from every process.
- `src/main` — all privileged work. `harness/` holds one adapter per harness; `models/` provider clients; `util/` has no Electron imports so adapters stay unit-testable in Node. `handlers.ts` is the Electron-free IPC handler registry and `ipc.ts` binds it to Electron.
- `src/preload` — the only bridge. Renderer calls go through `window.harness`; channels and payloads are defined once in `src/shared/ipc.ts`.
- `src/renderer` — React 19 + zustand. **Never touches Node or Electron directly.** `terminal/host.ts` keeps xterm.js instances alive outside React.

## Key invariants

- Adapters implement `HarnessAdapter` (`src/main/harness/types.ts`) and receive a `HarnessContext`. Adapters must not import Electron.
- Project instructions are read once per harness. `AGENTS.md`, `CLAUDE.md` and `.vocs-code/INSTRUCTIONS.md` are the app's instruction files (`src/main/harness/project-instructions.ts`); an engine that discovers one itself keeps it, and the adapter adds only what that engine does not read. The Claude adapter, whose CLI reads `CLAUDE.md` alone, appends `AGENTS.md` (only where the directory has no Claude document) and `.vocs-code/INSTRUCTIONS.md` to its system prompt, so no file is ever handed over twice.
- The terminal lives in the main process; the renderer re-attaches to snapshots and never owns PTY lifetime.
- API keys live only in the OS keychain via `src/main/secrets.ts` (`safeStorage`) — never in settings, logs, transcripts, or the repo.
- Dangerous commands (`rm -rf`, force-push, `sudo`, pipe-to-shell, …) and any write outside the workspace always prompt below Full access, even after "Allow for session". Logic lives in `src/main/harness/permissions.ts`; the pi side of the same rules lives in `resources/pi/subagent-gate.ts`, which both the parent approvals extension and every subagent child decide through.
- Sessions must resume after restart for every harness; keep that path working when touching persistence.
- A session's usage counts only the money it spent itself. Turn rows are the itemized ledger and `SessionMeta.usage` is the counter over it; a fork carries the conversation, never the ledger.

## Adding a harness

Touch all of these: add an adapter in `src/main/harness/<id>.ts`, register the case in
`src/main/harness/registry.ts`, add the id to `HarnessId` in `src/shared/types.ts`, add its
descriptor/capabilities in `src/shared/harness-meta.ts`, and wire detection/install/doctor in
`src/main/runtime.ts`. Permission modes must map through the shared model (see the table below).

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

`userData/analytics.json` feeds the Analytics view. The main-process `AnalyticsStore` (`src/main/analytics.ts`) turns every cumulative usage report into a delta against the session's last totals and adds it to a UTC day bucket, attributing it to the harness, model and project active at that moment (`UsageDay.by`, which also remembers the session ids, per-tool counts and per-file change counts of the day). Session snapshots and the all-time per-tool and per-file maps survive session deletion, so history never shrinks. Model slices are keyed `provider/model` and named from that key wherever they are read, so a slice recorded under an older bare label — or with no provider at all, which keys it `/model` — reads the same as everything else and no stored label can drift from the key beside it.

A session counts only what it spent itself, and the transcript is the ledger it is checked against. `fork()` copies its source's turn rows for context but rewrites them as `{ costUsd: 0, carried: true }` and starts the new session at `emptyUsage()`, so one session's dollars are never on two sessions and summed twice by the dashboard. History written before that rule is corrected once on boot: `reconcileForkInheritance` (`src/main/index.ts`) reads each transcript, splits the recorded totals against the rows at or after `createdAt` — the cut is safe because `fork()` is the only path that writes another session's rows and it stamps a fresh `createdAt` — zeroes the carried rows and takes the inherited part back off `meta.usage`, the session snapshot, `recorded[id]` and the day slices that carried it. It **lowers only**: a total that trails its own rows (a provider counter reset) is left alone rather than raised. The sweep is gated by `AnalyticsFile.version` 2 → 3, and the version is written only when the whole pass succeeds, so an interrupted run retries next boot.

The dashboard (`src/renderer/src/components/analytics/`) asks for one range at a time and scopes every tab to it. All-time views come from the session records; bounded ranges (7, 30, 90 days) come from the day slices through the shared `src/shared/usage-rollup.ts`, and the summary also carries the preceding window so tiles can show period-over-period change. Days recorded before slices existed are reconstructed once on load from the sessions last active that day, in proportion to their lifetime usage (per-tool and per-file counts are shared out from the all-time maps by call volume); those days are flagged `estimated` and the dashboard says so. A legacy day with no matching session keeps its usage in the totals only and is labelled "unattributed" until it ages out of the bounded ranges. Series colours come from `CHART_SERIES` in `src/shared/themes.ts`, a categorical palette validated for colour-vision separation on every theme surface (the theme hues themselves are UI accents and fail those checks); single-series charts use the theme accent.

## Known limitations

- Computer use ships as a built-in MCP server (Cua Driver), on by default once the driver binary is found. Phase 1 core plus a read-only Desktop preview tab are live (`src/main/mcp/cua.ts`, `cua-preview.ts`, `renderer/.../CuaCard.tsx`, `DesktopTab.tsx`); in-transcript screenshots of driver actions, a guidance skill, a preview window picker, and one shared app-owned runtime are not yet shipped (docs/CUA-COMPUTER-USE.md).
- Codex exec (SDK) cannot ask for approval; prefer the app-server harness for interactive work.
- The Cursor harness cannot ask for approval either; safety comes from Cursor's sandbox (Auto) and Plan mode. A `.cursor/hooks.json` approval bridge is a possible follow-up.
- Cursor usage is billed to the user's Cursor plan, so the analytics show tokens but no dollar cost for that harness.
- Custom Codex model providers are passed as thread config overrides and were not verified against a live OpenAI-compatible endpoint.
- ACP agents expose models only after the session starts; pick the model from the header once the agent is up.
- The terminal tab's directory tracking relies on the shell announcing its cwd (OSC 7, or OSC 9;9 as Windows Terminal profiles do); shells without such a prompt hook show the directory they started in.
- The Subagents panel covers pi and Claude runs; `subagentSupport` in `src/shared/subagents.ts` is the one answer for what each harness offers. Claude's per-call dollars are estimated from the shared pricing table (its SDK reports tokens, not cost), and its SDK can interrupt a turn but not one child, so the panel offers it no per-run stop/steer and no Agents view — that view edits `.pi/agents`, which a Claude session does not run with. Its **Models** view instead lists the agent types with the model each will run on, and edits the model of a definition the project already has; it never writes one, because a definition named after a built-in replaces that built-in rather than adjusting it.
