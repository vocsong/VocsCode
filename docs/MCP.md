# MCP support

Status: **P0 shipped.** Global MCP servers have a sidebar page ("MCP", beside Skills);
repo-level servers have a right-panel tab reading `<repo>/.mcp.json`. The effective set is
injected into Claude, both Codex adapters, ACP agents and pi (through the bundled
`vocs-code-mcp` extension); Cursor gets import/export. "Test connection" runs the app's own
MCP client. GitNexus ships as a built-in server, on by default in every repo and scoped
strictly to that repo's index, served by one shared process behind a per-session scope proxy
(§13). §10 lists what P1 and P2 still hold — the native loop's
client mode, live status, write-back to harness stores.

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
| Pi | `pi.ts` argv + bundled extensions | pi 0.85.1 has no MCP flag or config; the bundled `vocs-code-mcp` extension connects to each server and registers its tools with pi |
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
  /** Built-in server ids switched off for this repo. */
  disabledBuiltin?: string[];
  /** GitNexus only: share this repo's index with sessions in other repos (§13). */
  gitnexusGlobal?: boolean;
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
flattens it to `--config` flags; secrets therefore go through `env_vars` and
`env_http_headers`, never inline (§8). Verified live: Codex loads the servers, but this
adapter runs with `approvalPolicy: 'never'` (it has no interactive approvals) and Codex
answers every MCP tool call with "MCP tool call requires approval, but approval policy is
never". So the tools are visible and unusable here; the panel says so and points at the
app-server harness. Making them callable means auto-approving MCP tool calls in a
harness with no approval UI, which is a permission decision for the user, not a P0 default.

**ACP** — `newSession/resumeSession({ cwd, mcpServers: toAcp(effective) })`; env and
headers become `[{ name, value }]` arrays; http/sse entries are dropped unless
`initialize` reported `mcpCapabilities.http`/`.sse`. ACP wants an absolute stdio
`command` and the agent rejects the whole request otherwise, so the adapter resolves a
bare one through PATH and skips it with a warning when it cannot (§9). Claude-agent-acp,
codex-acp and gemini all honour `session/new.mcpServers`; verify `dsh` and pi-acp in the
smoke run.

**Native loop** (`client`) — **shipped.** The adapter is the MCP client: `src/main/harness/native/mcp-tools.ts` connects every resolved server at `start()` (in parallel, 15 s per server, a failure is reported in the transcript and skipped), maps each tool to `mcp__<server>__<tool>` with the server's `inputSchema` as its `parameters`, and closes the connections in `dispose()`. `executeTool` dispatches to the connection and the existing `gateAction` gate; the tool card reports `hint: 'mcp'`. Only the app's own memory server is trusted to declare a tool read-only (`annotations.readOnlyHint`) — a server the app does not own is never treated as safe, so such a tool asks below Full access even in Auto mode and is hidden in plan mode. Elicitation and sampling from servers are not routed to approvals yet (P2). The same client powers "Test connection" on both UI surfaces.

**Pi** (`inject`) — `resources/pi/vocs-code-mcp.ts`, a second bundled extension alongside the
approvals one. The adapter writes the session's resolved servers to `<sessionDir>/pi/mcp.json`,
points `VOCS_CODE_MCP_CONFIG` at it and loads the extension with `-e`. The extension speaks the
MCP protocol itself (stdio + streamable HTTP, no SDK import, so nothing has to resolve out of the
asar), lists each server's tools and calls `pi.registerTool()` for every one as
`mcp__<server>__<tool>`. Every registered tool carries a `promptSnippet` — pi leaves a custom tool
out of its "Available tools" list entirely without one, which is how an injected server stays
invisible to the model — and the built-in code graph also carries a `promptGuidelines` line so the
graph is reached for before grep. The approvals extension gates every `mcp__*` tool, since a server
tool's blast radius is unknown; only full-auto lets it through unprompted — with one exception: the
app's own memory server marks its read-only tools (`annotations.readOnlyHint`) and those run
unprompted and survive plan mode, in the parent and in every subagent child. Trust is by server
identity (`vocs_memory`), so a server the app does not own can never inherit it. The bridge is
process-wide, and a subagent child registers the same tools over the parent's connections instead of
spawning its own copy of every server.

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
access — keep that. The native loop does the same, with one exception: the app's own
memory server may mark its read-only tools (`readOnlyHint`), and only that server is
trusted to do so — a tool from a server the app does not own always asks below Full
access, even in Auto mode, and is hidden in plan mode. Codex runs MCP tool calls inside its own sandbox/approval model;
note in the UI that Vocs Code does not add a prompt there. Elicitation requests (Codex
app-server today, native client in P2) become `'elicitation'` approvals instead of
silent declines. `tests/review-fixes.test.ts` gets the new gate cases.

**Remote servers with OAuth** (Sentry, Linear, GitHub's hosted MCP) are handled by the
harness where it owns the connection — Claude reports `needs-auth` and the user finishes
the flow in the CLI; Codex has `codex mcp login`. For the native client this needs the
MCP SDK's OAuth provider and a loopback redirect; deferred to P2 (§10).

## 9. Windows notes

- Shim resolution (§6) is the one thing that will bite every user on this machine; test
  `npx -y @modelcontextprotocol/server-filesystem` end to end per harness. The app's own
  subprocesses need the same treatment: `which('gitnexus')` resolves to the npm `.cmd`, and a
  bare `spawn` of one throws EINVAL, so the shared server (§13) goes through `spawnTool` and
  `killTree` from `harness/spawn.ts` like everything else.
- ACP takes an absolute stdio `command`; dsh fails `session/new` with "mcpServers[0].command
  must be an absolute path" for anything else. The shim wrapper `normalizeStdio` produces is
  a bare `cmd`, so the ACP adapter resolves it through PATH and drops a server it cannot
  resolve rather than losing the session.
- ConPTY is irrelevant here (MCP stdio is plain pipes), but `killTree()` from
  `harness/spawn.ts` is needed when a session ends so orphaned `node.exe` servers don't
  accumulate — the native client must own the lifetime of what it spawns.
- Paths in `.mcp.json` written by the app use forward slashes; Codex TOML wants escaped
  backslashes or forward slashes in `--config` values — the converter handles it.

## 10. Phasing and sizing

| Phase | Scope | Size |
| --- | --- | --- |
| **P0** | types + settings + `normalizeSettings`; `.mcp.json` read/write; `effective.ts` with `${VAR}` + shim normalisation; `mcp:*` IPC; injection for Claude, Codex app-server, Codex exec, ACP; MCP page (Vocs Code tab + read-only Claude/Codex/Cursor tabs); right-panel tab (banner, repo, global, detected-read-only); `Test connection` via `src/main/mcp/client.ts`; unit tests | 2 PRs: main + shared + tests, then renderer |
| **P1** | Claude live status + `setMcpServers` hot-apply; Codex elicitation → approval; import/export to harness-native files (write side); `/mcp`, shortcut, palette; smoke coverage per harness — native loop `client` mode is shipped (`src/main/harness/native/mcp-tools.ts`) | 2–3 PRs |
| **P2** | OAuth for the native client; elicitation/sampling from MCP servers into approvals; per-server tool allow/deny (Claude `tools` policy, Codex `enabled_tools`); Codex status if the app-server exposes it | opportunistic |

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
- The native loop's MCP client is shipped (`src/main/harness/native/mcp-tools.ts`); servers it
  spawns are killed by the SDK's transport on close, but a server that spawns its own grandchildren
  is not tree-killed yet (P2).
- Pi: extension bridge deferred to P2, `pi.extraArgs` remains the escape hatch.
- Cursor: inherit-only with import/export, no injection (the SDK has no seam).

**Settled while building P0**

- Injection is verified live end to end for **claude**, **codex** (app-server) and **acp**
  (dsh): each connects to a server this app handed it and calls one of its tools. The
  fixture stamps its output with a token that never appears in the prompt, so a model
  cannot fake the round trip (`HARNESS_SMOKE_ONLY=mcp`, §10).
- **codex-exec** loads the servers but cannot call them; see §6.
- The ACP adapter reports an MCP tool call with the transcript name `other` rather than the
  server-qualified name. Cosmetic, pre-existing in the ACP tool mapping, noted for P1.

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

## 13. Built-in GitNexus, one shared server

**Status: shipped.** GitNexus is an app-shipped server, so every repo has it without anyone
adding it, and each session is confined to its own repo's index. There is one topology: a single
`gitnexus serve` process for the whole app, which every session reaches through a per-session
**scope proxy**.

GitNexus keeps all indexes in one global registry (`~/.gitnexus/registry.json`) and its `mcp`
command serves every entry, with no scoping flag. Isolation is therefore the app's job.

**The server.** `src/main/mcp/shared-server.ts` starts one `gitnexus serve` process for the app
(MCP over Streamable HTTP at `POST /api/mcp`, from the global registry), lazily on the first
session that needs it and stopped on quit. It prefers the installed `gitnexus` binary (resolved
with `which`) over `npx -y gitnexus@latest`; when it will not start, sessions get no GitNexus
server at all rather than a broken one.

**The scope proxy.** Sessions never talk to the server directly: the app injects a stdio proxy
(`resources/mcp/gitnexus-scope.mjs`) carrying the shared endpoint (`VOCS_GITNEXUS_URL`) and the
session's allow-list (`VOCS_GITNEXUS_ALLOW`) — the session repo, matched against `projectRoot`
and `cwd`, plus any repo the user promoted. The proxy forwards to the shared server while
enforcing that list: it pins the `repo` argument to the session repo, rejects calls that name a
repo outside the allow-list, hides the cross-repo `group_*` tools, filters `list_repos`, and
filters resources. Isolation is policy rather than construction, so the proxy is the security
boundary and must cover every cross-repo surface GitNexus exposes.

**Global scope** is a per-repo switch, not a move to the global list:
`mcpProjectState[root].gitnexusGlobal` adds repo X's registry entry to every other repo's
allow-list. It is the one place a repo's index leaves its own boundary, and the toggle sits next
to the built-in row on the repo's MCP tab.

Rules:

- The built-in always wins over a same-id global or `.mcp.json` entry (the user's old manual
  `gitnexus` server is shadowed, not injected twice). Such an entry is dropped from the settings
  store on load, and the MCP page neither lists it nor offers a same-id id to the add form.
- It injects into every harness whose `mcp` support is `inject` or `client`, on by default. The
  MCP page's built-in row switches it off everywhere (`mcpDisabledBuiltins`); a repo keeps itself
  out of the shared server with `disabledBuiltin` — the switch above the share toggle on the
  repo's MCP tab. Either switch alone is enough to keep a session from receiving it, and the
  repo tab marks a built-in stuck off by the page switch with `off everywhere`.
- Index freshness is passive: creating or forking a session, committing from the Changes panel,
  opening a PR, and merging a PR enqueue `gitnexus analyze --skip-agents-md` for that session's
  checkout. The queue is best-effort, serialized across repos, and coalesces duplicate hooks; it
  never blocks the session/commit/PR action and never edits project instruction files. Failures go
  to the app log and the existing Re-index button remains the explicit retry. Automatic runs respect
  both the app-wide and per-repo GitNexus switches and refresh existing indexes only. The first index
  remains an explicit action in the MCP tab, so merely starting a session never creates files in an
  unindexed project.
- Codex loads its own `~/.codex/config.toml` underneath whatever a session is handed, so a
  `[mcp_servers.gitnexus]` left there would start a second, unscoped copy beside the shared one.
  Both Codex adapters pass `ownedMcpIds()` to `toCodex`, which writes
  `mcp_servers.gitnexus = { enabled: false }` for any owned name the session is not receiving:
  the name is switched off, and a real entry of the same name is never replaced. Both Codex
  harnesses belong to the set whose config the app writes, so the built-in row on the MCP tab
  says this (`claimed`); a harness whose config the app does not write is injected and left alone.
- A worktree session shares the main checkout's switches (`projectRoot`), but its `cwd` also
  matches an index built in the worktree.

The earlier per-repo mode (a private `GITNEXUS_HOME` per project holding a one-entry registry,
and a `gitnexus mcp` process per session) is gone: `src/main/mcp/gitnexus.ts` now only reads the
global registry and computes each session's allow-list. `AppSettings.gitnexus.mode` no longer
exists, and a value left on disk by an older build is dropped when settings are normalized.

## 14. Built-in Cua Driver — computer use

**Status: shipped (Phase 1 core + Desktop preview).** [Cua Driver](https://github.com/trycua/cua) is the third
app-shipped server: a native computer-use driver that inspects and operates desktop apps and
browsers on macOS, Windows and Linux, speaking MCP over stdio as `cua-driver mcp`. Vocs Code does
not ship the binary and never installs it silently; it discovers one the user installed
(`~/.local/bin`, `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin`, or the `binaries.cua` override),
asks for an authorization profile, and injects the server through the normal resolver, so every
harness with `inject`/`client` support gets its tools with no adapter code. Cursor stays
inherit-only. The design and the phase plan live in `docs/CUA-COMPUTER-USE.md`.

Rules:

- **Built in like GitNexus: on once a binary is found.** Installing Cua Driver is already the user's
explicit act, so the built-in switches itself on when one is discovered — the same shape as
GitNexus being on once a repo is indexed. `settings.cua.enabled` is true by default; only an
explicit `false` keeps it off. The def is still `disabled` (never injected) when no binary is
present or a `bounded` mode has no manifest, and `builtinEntries` honors that. The MCP page can
switch it off everywhere (`mcpDisabledBuiltins`) and a repo keeps itself out with
`disabledBuiltin`. The `CuaCard` is the one place the mode is chosen; the repo tab shows it in
compact form.
- **Managed, with a real health check.** The card reports the installed binary's version and its
resolution path, and its **Test connection** runs the app's own MCP client against
`cua-driver mcp` (the same probe user-defined servers get), so an install that cannot serve its
tools is visible before a session depends on it.
- **Two gates.** Vocs Code's per-call approval (permission mode, below Full access) is separate
  from Cua's per-action authorization inside its runtime. `standard` is promptless internally;
  `bounded` requires a capability manifest and denies undeclared scope; `unrestricted` needs the
  dangerous acknowledgement. The mode maps to the launch environment in `cuaEnv`
  (`CUA_DRIVER_PERMISSION_MODE`, plus the manifest pair or the bypass flag) because the runtime
  reads it once and no tool call can widen it.
- **The mode is fixed at launch, and on macOS the host owns it.** `cua-driver mcp` proxies to
  `CuaDriver.app` on macOS so the bundle keeps the Accessibility and Screen Recording grants, which
  means that daemon's launch flags — not this app's environment — fix the mode; the card says so
  (`CuaStatus.modeSource === 'host'`). On Windows and Linux the environment variables decide. This
  is why a shared, app-owned runtime is the remaining structural difference from GitNexus.
- **Fail closed.** Missing binary, no manifest in `bounded`, or an explicit off all leave the
  built-in disabled rather than injected broken. Settings normalization drops an unknown mode back
  to `standard` and an empty manifest path.
- It is claimed like the other built-ins: `builtinServerIds()` includes `cua-driver`, so both
  Codex adapters write `mcp_servers.cua-driver = { enabled: false }` for a session that is not
  receiving it.
- **Desktop preview.** The panel's lower half has a Desktop tab (`DesktopTab.tsx`) that polls
  `cua:preview` every 2s and shows the returned screenshot. The main-process `CuaPreviewSession`
  keeps one MCP connection to `cua-driver mcp` between polls (closed after 30s idle) and calls
  `get_desktop_state`, which never moves the pointer or takes focus. The tab's Stop button is the
  session interrupt; when the driver is not ready it falls back to the compact Cua card.

Not yet shipped (see the design doc): one app-owned runtime shared by concurrent sessions,
in-transcript screenshots of driver actions on tool cards, a window picker in the preview, the
guidance skill, and the Computer History audit view.
