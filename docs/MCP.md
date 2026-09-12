# MCP support

Status: **P0 shipped.** Global MCP servers have a sidebar page ("MCP", beside Skills);
repo-level servers have a right-panel tab reading `<repo>/.mcp.json`. The effective set is
injected into Claude, both Codex adapters and ACP agents; Cursor gets import/export; pi is
marked unsupported. "Test connection" runs the app's own MCP client. §10 lists what P1 and
P2 still hold — the native loop's client mode, live status, write-back to harness stores.

## 1. The idea

Let a user attach Model Context Protocol servers to their agents once, in Vocs Code, and
have every harness that can take them pick them up — instead of maintaining the same
server in `~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json` and whatever
each ACP agent wants. Two scopes, mirroring how the harnesses themselves think about it:

- **Global** — servers the user wants everywhere (a GitHub server, a docs search, a
  browser). Managed on a new sidebar page, "MCP", next to Skills.
- **Repo** — servers that belong to a project (its database, its issue tracker, a local
  dev server). Defined in a file in the repo so teammates get them, managed from a new
  tab on the right panel of any session in that repo.

The product promise is the same one Skills already makes: one place to see and edit what
each harness will load, plus the ability to move a definition between harnesses.

## 2. Two scopes — decision: sidebar page + right-panel tab

> **Decision (user, 2026-09-13):** global servers live on a bottom-left sidebar entry
> "MCP" beside Skills; repo-level servers live on a right-panel tab.

Both surfaces read and write the same data model (§4); they differ only in which store
they edit and which rows they show. Per session, the **effective set** is:

```
effective(session) = enabled(global servers, for this repo)
                   ∪ enabled(repo servers from <cwd>/.mcp.json, for this repo)
```

"for this repo" is per-user, per-project state kept in the app's own settings (§5), so a
teammate's `.mcp.json` never switches a server on for you until you say so (§8).

## 3. What the codebase already gives us

An inventory of the seams, so the plan can be sized honestly.

**Config and UI patterns to copy**

- `AcpAgentPreset` (`src/shared/types.ts:82`) and the `acpAgents` settings section
  (`SettingsView.tsx:592`) are already a user-editable list of spawnable stdio programs
  `{ id, name, command, args, env }` — the MCP server record is the same shape plus a
  transport and a URL.
- `settings.json` (`src/main/settings.ts`, `SettingsStore`) is the global store;
  `normalizeSettings()` (`settings.ts:245`) needs an explicit branch for any new
  array-of-records field, because it hard-resets `providers` and `acpAgents`.
- Per-project state already lives in global settings as maps keyed by the absolute
  project root: `folderStyles`, `folderOrder`, `collapsedFolders`
  (`types.ts:651-657`). There is no project entity and no per-repo settings file today;
  the only per-repo file the app reads is `.vocs-code/INSTRUCTIONS.md`
  (`harness/native/prompt.ts:33`).
- The Skills page (`SkillsView.tsx`) is the template for the MCP page: per-harness tab
  strip, list + preview panes, Refresh, "New", copy-to-harness. Skills is global-only and
  reads each harness's native folder (`src/main/skills.ts:33`); the MCP page does the
  same with each harness's native MCP store (§7.1).
- The right panel's tab list is data-driven (`RightPanel.tsx:16`, `PanelTab` in
  `store.ts:7`); every tab passes `session.id` over IPC and main resolves the cwd.
- Registering a new `View` touches `store.ts:8`, `App.tsx:146`, `Sidebar.tsx:365`,
  `CommandPalette.tsx:34`, `shortcuts.ts:76`, `src/shared/shortcuts.ts:28,61`, and
  `tests/sidebar-nav.test.tsx`.
- Secrets: `src/main/secrets.ts` (`safeStorage`, channels `secrets:set|clear|has`).
  Invariant: keys never land in settings, logs, transcripts or the repo.
- `@modelcontextprotocol/sdk` 1.30 is already a runtime dependency (`package.json:47`),
  pulled in as the Claude Agent SDK's peer; nothing in `src/` imports it yet. `zod` is
  present too. So a first-party MCP client needs **no new dependency**.

**Where MCP already shows up (display only — no configuration anywhere)**

- `ToolKindHint` has `'mcp'` (`types.ts:404`); Claude (`mcp__*`), Codex (`mcpToolCall` /
  `mcp_tool_call`) and Cursor tool names already map to it; the transcript renders it
  with the `bolt` icon.
- `codex-app-server.ts:391` hard-declines every `mcpServer/elicitation/request`.
- `acp.ts:151,158` pass a literal `mcpServers: []` to `session/new` and `session/resume`.
- `ApprovalKind` already includes `'elicitation'` (`types.ts:478`).

**Per-harness seams for injection** (verified against the installed SDK typings)

| Harness | Seam | What the SDK/protocol accepts |
| --- | --- | --- |
| Claude Agent SDK | `buildOptions()` in `claude.ts:121` → `options.mcpServers` | `Record<name, McpStdioServerConfig \| McpSSEServerConfig \| McpHttpServerConfig>`; also `strictMcpConfig`, `query.mcpServerStatus()`, `query.setMcpServers()` for live changes |
| Codex app-server | `common.config` in `codex-app-server.ts:161` (already used for `model_providers`) | Codex TOML overrides: `mcp_servers.<name>.command/args/env` (stdio) or `.url` (+ auth, §6) |
| Codex exec SDK | `new Codex({...})` in `codex-exec.ts:57` | `CodexOptions.config: CodexConfigObject` — flattened to `--config key=value`; `ThreadOptions` has no MCP field |
| ACP | the two `mcpServers: []` literals | `McpServerStdio { name, command, args, env: [{name,value}] }`, `McpServerHttp`/`McpServerSse` if `agentCapabilities.mcpCapabilities.http/sse` |
| Native loop | `NATIVE_TOOLS` at `native/index.ts:154,241` | a plain `NativeToolDef[]` whose `parameters` is JSON Schema — the same shape as an MCP tool's `inputSchema` |
| Pi | `pi.ts:96` argv | pi 0.85.1 has no MCP flag or config; extensions (`resources/pi/`) can register tools |
| Cursor | none | `@cursor/sdk` has no MCP option; the Cursor runtime reads `~/.cursor/mcp.json` and `<repo>/.cursor/mcp.json` itself |

## 4. Data model

One record type, shared by both scopes, in `src/shared/types.ts`:

```ts
export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerDef {
  /** Stable key; also the server name the harness sees (mcp__<id>__<tool>). */
  id: string;
  transport: McpTransport;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;        // values may use ${VAR} (§8)
  // http / sse
  url?: string;
  headers?: Record<string, string>;    // values may use ${VAR} (§8)
  /** Restrict to some harnesses; absent = every harness that can take it. */
  harnesses?: HarnessId[];
  /** Per-call timeout hint, passed through where the harness supports it. */
  timeoutMs?: number;
  description?: string;
}

/** Global list — lives in settings.json, like acpAgents. */
mcpServers: McpServerDef[];

/** Per-user, per-repo switches — keyed by projectRoot, like folderStyles. */
mcpProjectState?: Record<string, {
  /** Global server ids switched off for this repo. */
  disabledGlobal?: string[];
  /** Repo-file server ids the user has enabled here (off until enabled, §8). */
  enabledRepo?: string[];
}>;
```

Capability flag on `HarnessCapabilities` (`types.ts:557`) and all seven descriptors in
`src/shared/harness-meta.ts`:

```ts
/** none: no way in; inject: we pass the effective set; client: we run the MCP
 *  client ourselves; inherit: the harness reads its own store, we only import/export. */
mcp: 'none' | 'inject' | 'client' | 'inherit';
```

claude/codex/codex-exec/acp → `inject`, native → `client`, cursor → `inherit`,
pi → `none` (until §10 P2).

## 5. Where config lives

| Store | Path | Owner | Edited from |
| --- | --- | --- | --- |
| Global list | `userData/settings.json` → `mcpServers` | Vocs Code | MCP page |
| Per-repo switches + secrets refs | `settings.json` → `mcpProjectState[root]` | Vocs Code | right-panel tab |
| Repo servers | `<repo>/.mcp.json` → `{ "mcpServers": { "<id>": {...} } }` | the repo (committed) | right-panel tab |
| Secrets | OS keychain via `secrets.ts`, key `mcp:<VAR>` | Vocs Code | either surface |
| Harness-native stores | `~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`; `<repo>/.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json` | the harness | read + import/export |

> **Proposed:** the repo file is **`.mcp.json` at the repo root**, in the de-facto shape
> Claude Code, Cursor (`.cursor/mcp.json`), VS Code (`.vscode/mcp.json`) and Windsurf all
> use — `{ "mcpServers": { name: { command, args, env } | { type, url, headers } } }`.

Why not `.vocs-code/mcp.json`: `git.ts:709` writes `.vocs-code/` into
`.git/info/exclude`, so anything there is local-only by construction (that's why the
worktrees live there). A committed, team-shared file needs a path git sees, and
`.mcp.json` is one Claude Code already loads natively (`settingSources` includes
`'project'` by default) and that every other tool's import dialog understands. The cost
is that it is nominally "Claude's file"; the alternative is to narrow the exclude to
`.vocs-code/worktrees/` and own `.vocs-code/mcp.json` (see §11).

Reads use `meta.cwd` (a worktree has its own checkout of `.mcp.json`); the per-repo state
key is `session.config.projectRoot`, so worktree sessions share switches with the main
checkout.

## 6. Per-harness injection

A single main-process module, `src/main/mcp/effective.ts`, computes `effective(session)`
(§2), resolves `${VAR}` (§8) and converts to each harness's dialect. Adapters stay
ignorant of the UI: they call `ctx.mcpServers()` — one new `HarnessContext` accessor
added in `session-manager.ts:421 buildContext()` — and get the list already filtered by
`def.harnesses` and by their own capability.

**Claude** — `options.mcpServers = toClaude(effective)`; stdio → `{ command, args, env }`,
http/sse → `{ type, url, headers }`; `timeoutMs` → `timeout`. Do **not** set
`strictMcpConfig` (it would drop the user's own `~/.claude.json` servers and plugin
servers). Overlap to resolve live in P0: with `'project'` in `settingSources` Claude also
reads `.mcp.json` itself, so a repo server would be declared twice under the same name —
verify whether the SDK entry wins or both run; fallback is to skip repo entries for
Claude when `'project'` is in `settingSources`. Also verify whether project-scope servers
load at all in SDK mode without `enableAllProjectMcpServers` (Claude Code's trust
prompt has no interactive path there) — if not, injection is the only reliable route and
the fallback above flips. After `start()`, `query.mcpServerStatus()` gives
connected / failed / needs-auth per server for the tab (§7.2); `setMcpServers()` makes
edits apply mid-session without a restart (P1).

**Codex app-server** — `common.config.mcp_servers = toCodex(effective)`; stdio →
`{ command, args, env }`, http → `{ url }` plus auth (Codex supports
`bearer_token_env_var` and `http_headers`; verify the exact keys against
`codex --help`/docs before P0 lands). Same object shape the adapter already builds for
`model_providers`. Replace the hard-decline at `:391` with a `requestApproval({ kind:
'elicitation', ... })` round-trip (P1). Check whether the app-server exposes a server
status request (`mcpServerStatus/list` or similar) to feed §7.2; if not, the tab shows
"configured" only.

**Codex exec** — `new Codex({ codexPathOverride, env, config: { mcp_servers } })`. The SDK
flattens it to `--config` flags; secrets must therefore go through `env` +
`bearer_token_env_var`, never inline (§8).

**ACP** — `newSession/resumeSession({ cwd, mcpServers: toAcp(effective) })`; env and
headers become `[{ name, value }]` arrays; http/sse entries are dropped unless
`initialize` reported `mcpCapabilities.http`/`.sse`. Claude-agent-acp, codex-acp and
gemini all honour `session/new.mcpServers`; verify `dsh` and pi-acp in the smoke run.

**Native loop** (`client`) — new `src/main/mcp/client.ts` wrapping the MCP SDK `Client`
with `StdioClientTransport` / `StreamableHTTPClientTransport` / `SSEClientTransport`.
On `start()` the adapter connects each server, lists tools, and builds a per-session
`tools: NativeToolDef[] = [...NATIVE_TOOLS, ...mcpTools]` where each MCP tool is
`{ name: 'mcp__<server>__<tool>', parameters: inputSchema, mutating: !annotations?.readOnlyHint,
isEdit: false, execute }`. `executeTool` dispatches by `def.execute` when present, goes
through the existing `gateAction` permission gate, and reports `hint: 'mcp'`. Elicitation
and sampling requests from servers route to `ctx.requestApproval`. The same client
powers "Test connection" on both UI surfaces, so it is worth building first (§10).

**Pi** (`none` → P2) — pi has no MCP support, but our approvals extension shows the
shape: a `resources/pi/vocs-code-mcp.ts` extension that reads a JSON file path from env,
connects with the MCP SDK client and registers each tool with pi. The catch is module
resolution — the extension must import the SDK from the app's (asar-unpacked)
`node_modules`, which the approvals extension does not need today. Until then the MCP
page marks pi "not supported" and the user's `pi.extraArgs` remains the escape hatch.

**Cursor** (`inherit`) — nothing is injected. The tab shows what Cursor will read
(`.cursor/mcp.json`) and offers "Export repo servers to .cursor/mcp.json"; the MCP page
shows `~/.cursor/mcp.json` read-only with "Import".

**Windows shims.** MCP stdio servers are overwhelmingly `npx ...`; on Windows `npx` is a
`.cmd` shim that `child_process.spawn` cannot exec directly (the Codex SDK EINVAL we
already hit, and the reason the user's own `~/.codex/config.toml` spells servers as
`command = "cmd", args = ["/c", "npx", ...]`). `effective.ts` normalises stdio commands
with the same resolution `spawnTool` (`harness/spawn.ts`) uses before handing them to any
harness, so a definition typed as `npx -y foo` works everywhere. Verify per harness in
P0 — Claude Code may already do this itself, Codex demonstrably does not.

## 7. UI

### 7.1 MCP page (sidebar, global)

`View = 'mcp'`, sidebar button after Skills with the `server` icon (the transcript's
`bolt` stays for tool-call rows). Layout follows `SkillsView.tsx`:

- **Header** — back, "MCP servers · N", filter, Refresh, primary "Add server".
- **Tab strip** — one tab per store, like Skills' per-harness tabs: **Vocs Code**
  (the injected global list), **Claude** (`~/.claude.json` → `mcpServers`), **Codex**
  (`~/.codex/config.toml` → `[mcp_servers.*]`), **Cursor** (`~/.cursor/mcp.json`). The
  harness tabs are read-only in P0 with a per-row "Copy to Vocs Code"; writing back to a
  harness store ("Copy to Codex") is P1 and follows Skills' `skills:copy`.
- **List pane** — rows with name, transport badge, `command args` / URL, harness chips
  (from `def.harnesses`), and an enabled switch (global on/off — distinct from the
  per-repo switches in §7.2).
- **Detail pane** — the edit form (id, transport, command + args, env, url + headers,
  harness restriction, timeout, description). Secret-marked env/header values are
  masked and stored in the keychain (§8). Below the form: **Test connection** — spawns the
  server through `src/main/mcp/client.ts`, runs `initialize` + `tools/list`, shows the
  tool names and descriptions (or the error), then disconnects. Harness-independent, so
  it also validates a server that only Codex will run.

### 7.2 Right-panel tab (repo)

`PanelTab = 'mcp'`, label "MCP", icon `server`, after Goal. Rendered only for sessions,
so it always has a cwd and a harness. Sections top to bottom:

1. **Trust banner** (only when `.mcp.json` declares servers not yet enabled here):
   "This repo defines 3 MCP servers. Review and enable the ones you trust." with the list
   and per-row Enable. (§8)
2. **This repo** — rows from `<cwd>/.mcp.json` with per-repo switch, edit, delete, and
   "Add server" (same form as §7.1, saving to the file). Empty state offers "Create
   .mcp.json" and "Import from .cursor/mcp.json" when one exists.
3. **Global** — the enabled global list with per-repo switches (writes
   `mcpProjectState[root].disabledGlobal`); a link "Manage global servers" jumps to §7.1.
4. **Detected** — other harness-native project files found in the repo
   (`.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `.codex/config.toml`)
   with an Import action per server; for Cursor sessions an Export action the other way.
5. **In this session** — what the running harness actually has: Claude via
   `mcpServerStatus()` (connected / failed / needs-auth, tool count), native via our own
   client, others "configured — status not reported by <harness>". For harnesses that
   can't hot-reload, a footer notes that changes apply when the next session starts.

### 7.3 Other touchpoints

- `SLASH_COMMANDS` (`harness-meta.ts:221`) gains `/mcp` → opens the tab.
- `app.mcp` shortcut command + command-palette entry "Open MCP servers", like `app.skills`.
- New-session dialog: nothing in P0. A "servers active: N" hint on the session Header is
  a P1 nicety once status exists.
- Analytics already attributes tool calls per tool name; `mcp__server__tool` rows will
  show up in the per-tool view for free.

## 8. Trust, secrets, approvals

**Repo servers are inert until enabled.** A cloned repo's `.mcp.json` is arbitrary code
that would run at session start. Claude Code answers this with a first-use trust prompt;
we answer it with the per-repo `enabledRepo` list (§4) and the banner in §7.2. Global
servers are on everywhere by default because the user typed them in; they can still be
switched off per repo.

**No secrets in `.mcp.json`, settings, or argv.** Values in `env` and `headers` may use
`${VAR}`. Resolution order at injection time: the process environment, then the keychain
under `mcp:<VAR>` (set from either surface's secret field via `secrets:set`). The repo
file carries only the reference, so it is safe to commit; the resolved value goes to the
harness in the way that keeps it out of command lines — `env` for stdio, `env` +
`bearer_token_env_var` for Codex HTTP (Codex flattens `config` into `--config` argv,
which is visible in the process list), `headers` inside the JSON-RPC payload for Claude
and ACP. Log lines redact resolved values.

**Tool calls stay behind the existing gates.** Claude's `canUseTool` already treats
`mcp__*` as mutating (it is not in `READ_ONLY_TOOLS`), so MCP tools prompt below Full
access — keep that. The native loop gates MCP tools as mutating unless the server marks
the tool `readOnlyHint`. Codex runs MCP tool calls inside its own sandbox/approval model;
note in the UI that Vocs Code does not add a prompt there. Elicitation requests (Codex
app-server today, native client in P1) become `'elicitation'` approvals instead of
silent declines. `tests/review-fixes.test.ts` gets the new gate cases.

**Remote servers with OAuth** (Sentry, Linear, GitHub's hosted MCP) are handled by the
harness where it owns the connection — Claude reports `needs-auth` and the user finishes
the flow in the CLI; Codex has `codex mcp login`. For the native client this needs the
MCP SDK's OAuth provider and a loopback redirect; deferred to P2 (§10).

## 9. Windows notes

- Shim resolution (§6) is the one thing that will bite every user on this machine; test
  `npx -y @modelcontextprotocol/server-filesystem` end to end per harness.
- ConPTY is irrelevant here (MCP stdio is plain pipes), but `killTree()` from
  `harness/spawn.ts` is needed when a session ends so orphaned `node.exe` servers don't
  accumulate — the native client must own the lifetime of what it spawns.
- Paths in `.mcp.json` written by the app use forward slashes; Codex TOML wants escaped
  backslashes or forward slashes in `--config` values — the converter handles it.

## 10. Phasing and sizing

| Phase | Scope | Size |
| --- | --- | --- |
| **P0** | types + settings + `normalizeSettings`; `.mcp.json` read/write; `effective.ts` with `${VAR}` + shim normalisation; `mcp:*` IPC; injection for Claude, Codex app-server, Codex exec, ACP; MCP page (Vocs Code tab + read-only Claude/Codex/Cursor tabs); right-panel tab (banner, repo, global, detected-read-only); `Test connection` via `src/main/mcp/client.ts`; unit tests | 2 PRs: main + shared + tests, then renderer |
| **P1** | native loop `client` mode (tools merged, gate, hint, killTree); Claude live status + `setMcpServers` hot-apply; Codex elicitation → approval; import/export to harness-native files (write side); `/mcp`, shortcut, palette; smoke coverage per harness | 2–3 PRs |
| **P2** | pi extension bridge; OAuth for the native client; per-server tool allow/deny (Claude `tools` policy, Codex `enabled_tools`); Codex status if the app-server exposes it | opportunistic |

P0 deliberately ships the MCP client for "Test connection" only. It is the same code the
native loop needs, so P1's native work is mostly the tool-list merge and the gate.

## 11. Decisions and open questions

**Locked**

- Global servers: sidebar page "MCP" beside Skills (user, 2026-09-13).
- Repo servers: right-panel tab (user, 2026-09-13).
- No new runtime dependency: `@modelcontextprotocol/sdk` is already present.

**Proposed here, shipped as specified in P0**

- Repo file is `<repo>/.mcp.json` in the Claude/Cursor shape (§5), not `.vocs-code/mcp.json`:
  it is shareable with plain Claude Code users and importable everywhere.
- Repo servers stay off until enabled per repo (§8).
- Harness-native stores are read-only tabs on the MCP page in P0; write-back is P1.
- The native loop's MCP client is P1. P0 ships the client for "Test connection" only.
- Pi: extension bridge deferred to P2, `pi.extraArgs` remains the escape hatch.
- Cursor: inherit-only with import/export, no injection (the SDK has no seam).

**Settled while building P0**

- Codex's TOML MCP keys are `command` / `args` / `env` / `env_vars` for stdio and
  `url` / `http_headers` / `env_http_headers` / `bearer_token_env_var` for HTTP, plus
  `startup_timeout_sec` / `tool_timeout_sec` / `enabled_tools` / `disabled_tools`
  (read off the shipped `codex` binary). `env_http_headers` and `env_vars` are the
  indirections the exec SDK path uses so no secret lands in `--config` argv.
- The MCP SDK's own stdio transport goes through `cross-spawn`, so the app's client
  survives a `.cmd` shim untouched. The harnesses do not, so `normalizeStdio` still
  rewrites to `cmd /c <shim>`; `tests/mcp-client.test.ts` runs a real `.cmd` server to
  prove that form works.

**Still to verify live** (they shape the Claude path, not the design)

- Whether an SDK `mcpServers` entry and a `.mcp.json` entry with the same name dedupe.
- Whether `.mcp.json` servers load at all in SDK mode without `enableAllProjectMcpServers`.
- Which ACP agents accept `session/new.mcpServers` (dsh, pi-acp).
- Whether Claude Code resolves `npx` shims itself on Windows.

## 12. What P0 shipped

Shipped exactly as sketched, file for file.

- `src/shared/types.ts` — `McpTransport`, `McpServerDef`, `AppSettings.mcpServers`,
  `AppSettings.mcpProjectState`, `HarnessCapabilities.mcp`.
- `src/shared/harness-meta.ts` — `mcp` on all seven descriptors.
- `src/shared/ipc.ts` — `mcp:stores` → the harness-native global stores;
  `mcp:project { sessionId }` → the repo file, the global list, the per-repo switches, the
  detected project stores and the effective set with a reason per skipped row;
  `mcp:project:save { sessionId, servers }`; `mcp:project:state { sessionId, patch }`;
  `mcp:inspect { def, sessionId? }` → `{ ok, serverInfo?, tools[], error?, durationMs }`;
  `mcp:import { servers, to, sessionId? }`; `mcp:export { sessionId, to: 'cursor' }`.
  The global list is edited through the existing `settings:update`, so no channel of its
  own. Every definition the renderer sends back goes through `normalizeMcpServers` before
  it can reach a file or a harness.
- `src/main/mcp/` — `file.ts` (`.mcp.json` + harness-native readers: JSON for Claude /
  Cursor / VS Code / Gemini, a minimal TOML `[mcp_servers.*]` reader for Codex),
  `effective.ts` (merge, `${VAR}`, shim normalisation, `toClaude/toCodex/toAcp`),
  `client.ts` (MCP SDK wrapper for inspect; reused by native in P1), `index.ts` (the one
  place that sees settings, the repo file and the secret store together). No Electron
  imports; the MCP SDK is imported lazily so nothing loads until a server is probed.
- `src/main/settings.ts` — defaults + explicit normalisation of the two new fields.
- `src/main/session-manager.ts` — `ctx.mcpServers()` in `buildContext()`.
- `src/main/harness/{claude,codex-app-server,codex-exec,acp}.ts` — the four injections.
- `src/main/ipc.ts` — handlers. The state patch goes through `settings.update`, so the
  existing `settingsChanged` push refreshes both surfaces.
- `src/renderer/src/components/McpView.tsx` (page), `McpTab.tsx` (panel), shared
  `McpServerForm.tsx`; registrations in `store.ts`, `App.tsx`, `Sidebar.tsx`,
  `RightPanel.tsx`, `CommandPalette.tsx`, `shortcuts.ts`, `src/shared/shortcuts.ts`.
- Tests — `tests/mcp.test.ts` (store readers and the `.mcp.json` round trip, the Codex TOML
  reader, the off-until-enabled merge, `${VAR}` resolution and its keychain fallback, the
  Windows shim rewrite, all four dialects, settings normalisation);
  `tests/mcp-client.test.ts` (the client against a real stdio server from
  `tests/fixtures/`, including a `.cmd` shim on Windows); `tests/mcp-tab.test.tsx` (the
  trust gate and the per-repo switches).
- Docs — this file's status line, README docs table, `docs/ARCHITECTURE.md` harness
  matrix gains an MCP column.

Not in P0, by design: the native loop still runs without MCP tools (its capability says
`client`, and `resolveForSession` returns the list, but the tool merge is P1); Claude's
`mcpServerStatus()` is not read yet, so the panel's "In this session" section says
"configured, not probed"; the Codex app-server still hard-declines elicitation requests.
