# Subagents

Vocs Code ships its own subagent capability for **pi** sessions. It replaces the dependency on a
user-installed third-party pi extension (`@tintinweb/pi-subagents`) with a bundled extension the app
owns, so subagent runs are permission-gated like everything else, visible in the UI, and counted in
analytics with real numbers instead of reverse-engineered ones.

> **Status.** Shipped: the extension (`resources/pi/vocs-code-subagents.ts` and its modules), the
> harness wiring, the permission gate, run records, analytics, and the run panel — the right panel's
> vertical split with the MCP | Subagents strip, run list, run detail with the per-call table, the
> transcript card's link into it, and Stop/Steer. `tests/e2e.subagents.test.ts` covers the panel
> offline (seeded state) and end to end against the real pi runtime.

Design decisions below are settled; the items in [Open items](#open-items) are the ones still to
resolve during implementation.

## Why

Today subagents arrive from outside the app:

- `src/main/harness/pi.ts` hard-codes the third-party extension's contract — the `PiSubagentDetails`
  payload, the `Agent` / `get_subagent_result` tool names, the `subagent-notification` custom
  message, and its terminal status strings — then converts it into `SessionEvent` `{ type: 'subagent' }`
  and `SubagentCost` entries for `src/main/analytics.ts`.
- `src/main/pi-agents.ts` exists only to patch that package's pins: it installs a Vocs-managed
  `Explore.md` (dropping the pinned Haiku model so children inherit the session model) and merges
  `reportUsage: true` into `subagents.json`.
- **Nested runs are not permission-gated.** The third-party runner builds a child session from a
  fresh `DefaultResourceLoader`; Vocs Code's extensions are passed with `-e` on the parent CLI and
  are not in any discovery path the child loads. A child's `bash` / `edit` / `write` calls
  therefore never reach `resources/pi/vocs-code-approvals.ts`.
- Analytics for subagent work is lossy: child spend reaches the app only because pi folds it into
  the parent session totals and `analytics.ts` re-attributes it per model; internal tool calls
  collapse into one synthetic `subagent` counter; nothing per model call survives.

Owning the extension removes all four problems at once.

## Scope

**In scope**

- pi sessions only. Every other harness keeps its own subagent story (Claude has one, Codex reports
  `subAgentActivity`, native has none).
- Foreground and background runs, parallel fan-out, delivery of results, mid-run steering.
- Agent types from files (Claude Code parity: `general-purpose`, `Explore`, `Plan`).
- Vocs Code permission inheritance, approval cards, run panel, per-call analytics.

**Out of scope**

- Workflow-script orchestration (`SubagentWorkflow`-style `pipeline()` / `parallel()` scripting).
- Scheduling, cron, saved workflows, nested subagents (depth stays 1), worktree isolation of child
  runs, structured-output schemas.
- TUI widgets and "Claude Code look and feel" — `--mode rpc` has no TUI; the app renders its own UI.
- Exposing subagents to non-pi harnesses.

## Architecture

```
renderer                       main                                    pi process
─────────────────────────────  ─────────────────────────────────────  ──────────────────────────────
RightPanel bottom tab strip    pi.ts (PiAdapter)                       vocs-code-subagents.ts
 ├ MCP                          ├ spawn pi --mode rpc -e ...            ├ run manager (parent ctx)
 └ Subagents                    ├ maps events → SessionEvent            ├ child AgentSession via SDK
    ├ run list (live)           ├ emits { type:'subagent', … }          │   ├ inline gate extension
    └ run detail                └ writes <sessionDir>/subagents/*.jsonl  │   ├ agent tools (allowlist)
       ├ child transcript      analytics.ts                             │   └ usage + activity events
       ├ per-call table         └ subagent spend + per-call rows         └ custom messages → parent
       └ stop / steer          store.ts / IPC: subagents:list|get|stop
```

One `-e` entry point in `resources/pi/`, loaded next to the existing five extensions, with sibling
modules for agent files, the shared permission gate, and the run store. The app talks to it only
over the two contracts it already owns: custom messages out, `extension_ui_request` for approvals.

## Tool surface

Names deliberately avoid the third-party extension's (`Agent`, `SubagentWorkflow`,
`get_subagent_result`, `steer_subagent`), because the two coexist (see
[Coexistence](#coexistence-and-cleanup)).

| Tool | Purpose |
| --- | --- |
| `subagent` | Spawn a run. `{ description, prompt, type?, background?, model? }` |
| `subagent_result` | Fetch a finished (or running) run's output and stats by `runId` |
| `subagent_steer` | Send a mid-run instruction to a background run |

- **Foreground** (default) returns the run's final output plus a compact stat footer
  (`type`, model, turns, tool calls, duration, cost). The parent's turn waits for it.
- **Background** returns immediately with a `runId`.
- **Parallel fan-out** comes free: several `subagent` calls in one assistant message execute
  concurrently under pi's parallel tool execution.
- `promptSnippet` / `promptGuidelines` describe the tools and state plainly that `subagent` is the
  Vocs Code tool to prefer over any other delegation tool that may be present.

Concurrency: background pool default **4** (setting), a hard cap of **8 runs per session**, foreground
uncapped. Bounds live in the extension so a runaway loop cannot spawn dozens of agents.

## Agent types

The definitions are **the project's**, not the app's: Vocs Code ships templates, and a project's own
files are what the session actually uses. `resources/pi/agents/{general-purpose,Explore,Plan}.md` are
the shipped templates (read as data by both the runtime and, in time, the manager UI); the prompts
compiled into `subagent-agents.ts` are only a fallback for a stray copy of the extension, and a test
asserts the two stay identical.

Resolution order — first definition of a name wins, and a file replaces a template wholesale (no
field merging):

1. `<projectRoot>/.pi/agents/*.md` — **the managed, project-level set**. This is what a project's
   Subagents configuration edits, and it is read from `VOCS_CODE_PROJECT_ROOT`, not from the session
   cwd, so every session on the repo sees the same set whether or not it runs in a worktree.
2. `<cwd>/.pi/agents/*.md` — branch-only extras (a worktree that commits agents). These *add* types
   the project set does not define; they never override it, so editing a managed file always wins.
3. `<projectRoot>/.claude/agents/*.md` — Claude Code's project files.
4. `~/.pi/agent/agents/*.md` — your global set.
5. `~/.claude/agents/*.md` — your global Claude set.
6. The shipped templates.

For a **Claude** session only #3 and #5 are in play, and Claude Code resolves them itself. Of those,
the app reads back just #3 — the project's own definitions, in `src/main/claude-agents.ts` — to offer
the model rows above; it creates a new definition there for a name no built-in and no existing file
claims, and never touches the global set.

Frontmatter: `name`, `description`, `tools`, optional `model`, `prompt_mode` (`append` | `replace`),
`mcp: false`. **Model defaults to the session model**; a pinned model is respected, which is why the
shipped templates pin nothing — a committed pin would oblige every teammate to have that provider.

**Git practice.** Definitions are project knowledge but also personal workflow, so Vocs Code's rule
is: write them, ignore them, and let the owner decide. `.pi/agents/*` belongs in the repo's
`.gitignore` by default (per-file, so a single definition can be un-ignored), and the manager offers
"track this one" for anything the whole team should share. Committed agents arrive with the branch;
untracked ones live in the main checkout, which is exactly why the project root is authoritative.

**Managing them**: the Subagents tab's **Agents** view lists the project's definitions (with each
one's git state) and the shipped templates, creates a definition from a template or from scratch,
edits every frontmatter field, deletes one, and toggles **Track** per definition. Writes go to
`<projectRoot>/.pi/agents/<name>.md`; the first write adds `.pi/agents/*` to the repo's `.gitignore`,
and Track adds the matching `!.pi/agents/<name>.md` so exactly that one file can be committed. A
running session keeps the set it started with — a change applies to the next session (or a `/reload`).

edit, delete, and the track/ignore toggle) is the remaining piece; today the interface is the files
plus the tool description the model is given. Until then a project agent is created by writing
`<projectRoot>/.pi/agents/<name>.md`.

## Permissions

Child runs inherit the parent session's effective mode and are gated by the same rules. The mode is
re-read from `VOCS_CODE_MODE_FILE` before every child tool call, exactly like
`resources/pi/vocs-code-approvals.ts` does for the parent.

| Parent mode | Child behavior |
| --- | --- |
| `full-auto` | full access, no prompts |
| `auto` | prompts only for dangerous shell commands and writes outside the workspace |
| `accept-edits` | prompts for bash; edits outside the project prompt |
| `ask` | prompts for bash / edit / write |
| `plan` | bash / edit / write blocked outright |

Rules that hold regardless of mode:

- A dangerous command (`DANGEROUS_COMMAND_PATTERNS` — the list in `src/main/harness/types.ts`, kept
  verbatim in sync with the pi resource) always prompts below Full access, even after
  "Allow for session".
- Any write outside the workspace prompts below Full access.
- A denied request is **not executed**; the child sees a decline and the run continues or fails
  normally.
- "Allow for session" grants made by the user apply to the whole session, children included.

Prompt routing: the child gate calls back into the run manager, which asks through the **parent's**
`ctx.ui.select` with the existing `VCODE_APPROVAL::` payload (extended with `runId` and agent type),
so the app renders its normal approval card naming the requesting agent. Concurrent approval requests
are serialized through a queue — one card at a time — so four parallel children cannot flood the UI.

The gate logic is extracted into `resources/pi/subagent-gate.ts` and imported by
`vocs-code-approvals.ts`, so parent and child decisions cannot drift.

## Lifecycle

| Situation | Behavior |
| --- | --- |
| User stops / interrupts the parent turn | Every child of that turn aborts immediately (cascade). |
| Per-run **Stop** in the panel | Aborts that run; the parent receives a follow-up note naming it. |
| Parent steers a run (`subagent_steer`) | Delivered as a steer to that child's current turn. |
| Background run finishes, parent idle | Completion is delivered as a follow-up that triggers a turn, debounced (~2s window) so a burst of parallel finishers causes one parent turn, not five. |
| App quit / session restart | Children die with the pi process. On resume, any run that was not terminal is marked `interrupted` and keeps its transcript up to that point. |
| Session deleted | Run files are removed with the session directory. |

## Analytics

Per model call, recorded for every child session:

`index`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
`reasoningTokens`, `costUsd`, `durationMs`, `stopReason`, `toolsInvoked[]`.

Per run, rolled up: `agentType`, `model`, `status`, `turns`, `toolUses`, `tokens`, `costUsd`,
`durationMs`, plus the child's own tool-call breakdown (counted individually now, instead of
collapsed into the synthetic `subagent` counter).

- Subagent spend **is added to the session's overall totals** (today's behavior, kept).
- It is also recorded as its own dimension, so the dashboard can separate parent from subagent spend,
  show calls/cost/cache-hit rate/tokens-per-second by model, and stop guessing via
  `pendingSubagentCost` re-attribution.
- The panel's run detail shows the per-call table; the dashboard carries the aggregate.
- `UsageTotals` on the parent turn keeps including the child spend that arrived during that turn.

## UI

The right panel is a vertical split:

- **Top** — the workspace tabs: Changes, Files, Git, Goal, Usage, Terminal.
- **Bottom** — a second tab strip with **MCP** and **Subagents**, mounted lazily: a half's tab loads
  the first time it is opened (MCP probes servers; Subagents lists run files), and a transcript card
  link mounts the Subagents tab without a click.
- A vertical `Resizer` (`SplitResizer`) with a persisted `panelSplit` fraction (AppSettings, default
  0.62). `Ctrl+J` still toggles the whole panel.

**Subagents tab**

- Run list for the active session: status, agent type, one-line description, model, turns, tool
  calls, cost. Live while running, refreshed from the `subagent.run` session events.
- Run detail: child transcript (text, thinking, tool calls, outputs), the per-call analytics table,
  and **Stop** / **Steer** for a running run (`/vocs-subagent-stop` and `/vocs-subagent-steer`).
- A harness with no runs at all explains that rather than showing an empty pane.
- The run list is one of up to three views, and the strip appears only for harnesses with something
  in it: **Runs** always, **Agents** for pi (the `.pi/agents` manager), **Models** for Claude.

**Claude: the Models view**

Delegated Claude agents run on the **session's own model**, which the adapter applies for the whole
session (`CLAUDE_CODE_SUBAGENT_MODEL`, plus `_FORCE` while the project pins nothing — see
[ARCHITECTURE](ARCHITECTURE.md#harness-matrix)). So the view is mostly an account of what already
happens: every type the engine reports is listed with the model it will run on.

What it can change is a definition the project already supplies at
`<projectRoot>/.claude/agents/<Name>.md`. Those rows carry a **model** select — *Same as session*
clears the pin — and saving rewrites that one frontmatter line, leaving the rest of the file
byte-identical.

A **built-in** row (one with no project file) writes one instead. Clicking it opens the editor with
the name fixed to the built-in's and the engine's own description filled in, and it says plainly that
the file replaces the built-in's instructions, which the app cannot read back. Saving sends
`claude-agents:create` with `override: true` and writes `<Name>.md`, with a `model:` line when one
was chosen, so the override pins the model in the same step.

The view's **New** button writes a genuinely new type: a name, a description, the instructions and
an optional model. A name a built-in or an existing definition already has is refused, in the form
and over IPC — a definition does not *adjust* a built-in, it **replaces** it, instructions and all
(verified against the bundled CLI: a frontmatter-only `Explore.md` left the agent describing itself
as a general-purpose agent). The override path is the single exception, and the only thing that may
write a built-in's name. The refusal covers the built-ins even when the session is idle and cannot
list them (`Explore`, `Plan`, `general-purpose` in `src/shared/claude-agent-files.ts`).

The one thing to know about a pin: while any definition pins a model, the adapter stops forcing the
session model, so the built-ins without a definition go back to Claude Code's own default — an
Anthropic id that a third-party endpoint refuses. The view says so, and clearing the pin restores
the forcing.

**Transcript**

- The `subagent` tool call renders as a tool card with `hint: 'agent'`, the description as its
  summary, live status, and — once the run id is known — an `open run` chip that opens the panel on
  that run.

**IPC**: `subagents:list`, `subagents:get`, `subagents:stop`, `subagents:steer`,
`claude-agents:list`, `claude-agents:setModel`, `claude-agents:create`.

## Storage and wire contract

**Run files** — `<sessionDir>/subagents/<runId>.jsonl`, appended by the extension, read by the main
process. One JSON record per line:

```json
{"t":"run","runId":"…","agent":"Explore","description":"…","mode":"foreground","model":{"provider":"…","model":"…"},"cwd":"…","startedAt":0}
{"t":"item","item":{"id":"…","kind":"tool","name":"grep","summary":"…","status":"done"}}
{"t":"call","index":0,"model":{"provider":"…","model":"…"},"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"costUsd":0,"durationMs":0,"stopReason":"toolUse","toolsInvoked":["grep"]}
{"t":"end","status":"completed","totals":{"turns":0,"toolUses":0,"costUsd":0,"durationMs":0},"endedAt":0}
```

(`provider`/`model` are top-level strings on the `run` record in the shipped writer; the writer in
`resources/pi/subagent-runs.ts` is the authority, and `src/shared/subagents.ts` parses it.)
Items are append-only upserts: the last record for an id wins, which is how a running tool card and
its result become one item.

Sessions keep their existing `sessions/<id>/transcript.jsonl` untouched — subagent detail never
pollutes the parent transcript, its search index, or its analytics scan.

**Notifications** (extension → app, parent session) carry the same facts live, as
`VCODE_SUBAGENT::` notify payloads with `kind` of `start` | `item` | `call` | `end`. `pi.ts`
translates them into `SessionEvent { type: 'subagent.run', run }` for the UI and, on the terminal
record, `SessionEvent { type: 'subagent', completion }` for analytics.

**Session totals.** A foreground run's usage rides back on the tool result, so pi folds it into the
session totals and analytics sees it as an ordinary usage delta. A background run's tool result is
long gone before it finishes, so its spend is reported in `completion.usage` and added to the day's
counters and to the model slice of the model that ran it. The session snapshot keeps the
harness-reported totals; the subagent split lives in the analytics slices.

## Shipped behaviour worth knowing

- The three tools are `subagent`, `subagent_result`, `subagent_steer`; the third-party extension's
  `Agent` / `get_subagent_result` / `steer_subagent` keep working alongside them.
- Readiness is a new `subagents` capability in the `VCODE_PI_READY::` handshake, emitted
  **synchronously** on `session_start` (the host checks capabilities right after `get_state`).
- Children are built with `noExtensions: true` plus an inline gate extension, so nothing discovered
  on disk — including the third-party subagent extension — leaks into a child.
- Providers registered in-process (a proxy, a test fixture) are copied onto the child's runtime,
  because they exist nowhere on disk.
- `VOCS_CODE_SUBAGENT_COMPLETION_MS` overrides the 2s background-completion debounce (tests use it).

## Extension host contract

New files under `resources/pi/`, copied by the existing `resources/pi → pi` entry in
`electron-builder.yml`:

| File | Role |
| --- | --- |
| `vocs-code-subagents.ts` | Entry: tool registration, run manager, child session construction, event emission |
| `subagent-agents.ts` | Agent file discovery/parsing, templates, tool allowlists |
| `subagent-gate.ts` | Shared permission decision + approval payload (also used by `vocs-code-approvals.ts`) |
| `subagent-runs.ts` | Run records, run-file append, stats roll-up |
| `agents/*.md` | The shipped templates, the project set's starting point |

- Loaded with a new `-e` argument in `src/main/harness/pi.ts`, alongside the current five.
- A new capability in the `VCODE_PI_READY::` handshake (`subagents`), so a broken extension fails
  loudly through the existing "Incompatible Pi runtime" path instead of silently degrading.
- Reads the existing env contract — `VOCS_CODE_PERMISSION_MODE`, `VOCS_CODE_MODE_FILE`,
  `VOCS_CODE_PI_NONCE`, `VOCS_CODE_EFFORT_FILE` — plus `VOCS_CODE_SUBAGENT_DIR` (where run files go)
  and `VOCS_CODE_PROJECT_ROOT` (whose `.pi/agents` is the project's managed set).
- Child sessions are built with the SDK: `createAgentSession()` + `SessionManager` + a
  `DefaultResourceLoader` using `noExtensions: true` and explicit extension paths only, so third-party
  discovery never leaks into children. The permission gate is an inline extension factory
  (`extensionFactories: [...]`) held in the same process, which is what lets a child ask through the
  parent's UI.
- Children inherit the session model, the cwd, and (by default) the session's MCP tools. The MCP
  bridge is process-wide: a child registers the same tools over the parent's existing connections
  rather than spawning its own copy of every server, and an agent that sets `mcp: false` in its
  definition gets none (the shipped Explore and Plan templates do). The app's own read-only memory
  tools skip the approval prompt in children and in the parent alike; any other `mcp__*` tool still
  asks below full access. Nested subagents stay at depth 1: our own tool names are excluded from
  child tool sets.

## Coexistence and cleanup

The two extensions coexist under different tool names; nothing is force-disabled (`--exclude-tools`
is not used, discovery is untouched, and the user's other global extensions keep working).
`promptGuidelines` state that `subagent` is the tool to prefer.

Retired once this lands:

- `src/main/pi-agents.ts` and `tests/pi-agents.test.ts` (the override installer).
- The Vocs-managed `Explore.md` files already written to `~/.pi/agent/agents/` and project
  `.pi/agents/` — left in place (they are valid agent files and harmless), but no longer installed.
  Existing files still win over built-ins, which is correct.
- The `PiSubagentDetails` contract in `pi.ts` and the `pendingSubagentCost` re-attribution path in
  `analytics.ts`.

The `subagent-notification` handler stays for one release so users who still have the third-party
extension keep getting correct numbers, then it is deleted.

## Verification

Per `AGENTS.md`, everything below must actually execute — no silent skips.

| Layer | Coverage |
| --- | --- |
| Unit | Agent-file discovery and precedence, frontmatter parsing, tool allowlists; gate decision table across all five modes, dangerous commands, outside-workspace paths, symlink/junction escapes; run-file append/read and the reader's traversal rejections; per-call stats roll-up; the extension driven by a scripted child session (caps, gating, lifecycle, live events); the harness bridge (`pi.ts` subagent notifications → events); analytics attribution of background spend; the Subagents tab over a stubbed bridge. For the Claude side: the model pair the adapter sets (and withholds), the Claude definition format and its one-field edit, and the Models view over a stubbed bridge. |
| Integration (real pi CLI, offline scripted provider) | `tests/pi-subagents.integration.test.ts`: tools registered alongside the third-party ones, a foreground child runs and its run file parses, an unknown type is rejected, and a child command is **approved once and denied once — the denied one never runs**. |
| Electron E2E (offline) | `tests/e2e.subagents.test.ts`: seeded transcript + run file drive the split, the strip, the run list, the detail with its per-call table and the card's `open run` link (plus a reload); a Claude session's Models view, which refuses to write a definition for a built-in and rewrites only the `model:` line of one the project already has; and — under `VOCS_CODE_PI_INTEGRATION=1` — a real pi session whose recorded run reaches the panel. `tests/e2e.pi-tools.test.ts` asserts each bundled pi resource is copied byte-for-byte. |
| Packaged | `npm run dist:dir` + the subagent and pi suites against `HARNESS_E2E_EXE`, because the extension is a bundled resource. |
| Live (manual) | `HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=pi` and the packaged Electron run. |

Gate for every change: `npm run typecheck && npm test && npm run build`, then the tier above.

Test-fixture work: `tests/fixtures/pi-scripted-provider.mjs` must learn to script **child** turns
(the child runs in the same pi process and inherits the registered provider). Deterministic by
design — the scripted provider answers from a queue or from a marker in the child's prompt.

## Risks

- **Two delegation tools in the prompt** while a third-party extension is installed: extra tokens and
  possible model confusion. Mitigated by name and explicit guidance, not by disabling anything.
- **Double counting** while both extensions are active: our runs and theirs both report. Keys are
  distinct (our `runId` vs their `agentId`), and the existing dedupe (`recordedSubagents`) stays.
- **Approval flooding** with parallel children: serialized through the queue described above.
- **Run-file growth**: per-run files with capped transcript items and a retention policy for old runs.
- **Cost surprises**: children bill their own model calls; per-call rows and a per-run cost in the
  card and panel make spend visible at the moment it happens.

## Open items

- **Always-on vs setting.** Shipped always-on for pi sessions (matching today's behavior for users
  who already have a subagent extension). A setting remains cheap to add.
- Whether background runs' approvals should be allowed to appear while the parent is mid-turn
  (current answer: queued, one card at a time).
- Retention numbers for run files: they grow with the session and nothing prunes them yet.
- The Subagents tab lists the active session only; the dashboard carries the aggregate view.
- `src/main/pi-agents.ts` still installs the third-party Explore override and `reportUsage`; it is
  harmless for our runs and only serves users who keep the third-party extension. Retire it when
  that compatibility path is dropped.
