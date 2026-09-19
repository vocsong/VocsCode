# Computer use with Cua

Status: **Phase 1 core + Desktop preview shipped** (`src/main/mcp/cua.ts`, `cua-preview.ts`, `CuaCard.tsx`, `DesktopTab.tsx`, docs/MCP.md §14); in-transcript screenshots, the guidance skill and a shared app-owned runtime are still to come. This document decides whether Vocs Code should
use [trycua/cua](https://github.com/trycua/cua) for computer use, and how.

## 1. What Cua actually is

Cua is four separable products, and only two are relevant to Vocs Code:

| Product | What it is | Relevant? |
| --- | --- | --- |
| **Cua Driver** | A background computer-use driver: a Rust binary (`cua-driver`) that inspects and operates native desktop apps and browsers on macOS, Windows and Linux. Speaks **MCP over stdio** (`cua-driver mcp`), a CLI (`cua-driver <tool> '<json>'`), and typed SDKs. Exposes ~56 tools (`list_apps`, `list_windows`, `get_window_state`, `click`, `type_text`, `press_key`, `hotkey`, `scroll`, `drag`, `get_desktop_state`, `browser_*`, `start_session`/`end_session`, …). | **Yes — this is the integration.** |
| **Cua Driver agent skill** | A bundled instruction pack (eight files) shipped inside the driver and installable into agent skill directories (`cua-driver skills install`, or read over MCP as `skill://cua-driver/…`). Teaches the agent how to choose tools, address windows and verify actions. | **Yes — supporting.** |
| **Cua Fleets** | Isolated cloud Linux desktops claimed from a pool, driven through the Sandbox SDK. Needs credentials, network and paid capacity. | Optional, later (remote/isolated desktops). |
| **Cua Bench / Lume** | Task benchmarks and local macOS/Linux VMs on Apple Silicon. | Not a runtime; possible CI evaluation and a sandboxed-desktop option. |

**The headline answer: it is an MCP server, plus a skill. It is not a harness adapter and not a
new native tool.**

- Not a harness: a harness adapter runs an agent loop. Cua Driver has no model and no loop — it is
  a tool backend, exactly the shape Vocs Code's MCP layer already transports.
- Not a native tool: Vocs Code's native loop already runs a first-party MCP client
  (`src/main/harness/native/mcp-tools.ts`), so a cua MCP server reaches the native loop for free.
- The skill is real but secondary: it is agent guidance, and Vocs Code's Skills page already
  manages the three skill roots.

Everything below follows from that.

## 2. Why this fits Vocs Code with almost no new machinery

Vocs Code's MCP layer (docs/MCP.md) already does the hard parts:

- A built-in server concept (`MCP_BUILTIN_IDS`, `src/main/mcp/index.ts`) with a shared,
  app-owned process, per-repo switches, global switches and harness capability filtering — the
  exact shape a desktop-owning runtime needs.
- Injection into claude, codex (app-server and exec), ACP and pi (via the bundled bridge);
  a first-party client for the native loop; import/export for Cursor (which reads its own
  `mcp.json`).
- `${VAR}` resolution against the encrypted secret store, `normalizeStdio` Windows shim handling,
  a "Test connection" prober (`src/main/mcp/client.ts`), and a `.mcp.json`/native-store reader.
- A memory of how to own a long-lived process: `src/main/mcp/shared-server.ts` (one
  `gitnexus serve` for the whole app, sessions reach it through a scope proxy).

So the work is not "build computer use". It is: **detect the binary, own one runtime, inject the
server, gate it properly, and render what comes back.**

## 3. Runtime topology (the one real design decision)

Cua Driver's authorization **mode is fixed when the process that owns the runtime starts** and
cannot be changed by a tool call. On Windows and Linux bare `cua-driver mcp` owns its own runtime
and shuts it down on stdin EOF; on macOS it proxies to `CuaDriver.app` so Accessibility and Screen
Recording grants keep the app-bundle identity. `--socket` selects an explicit daemon endpoint,
`cua-driver serve` starts one, and `cua-driver autostart` registers a platform-native daemon
(Windows registers a `cua-driver-serve` task during install).

Two options:

**A. Per-session runtime** — inject `cua-driver mcp` with `env` carrying
`CUA_DRIVER_PERMISSION_MODE`. Each harness session gets its own runtime.
- Pro: mode per session; simple stdio health; matches how built-ins are injected today.
- Con: several runtimes fight over one physical desktop. Two sessions driving the same pointer and
  keyboard is not a capability difference, it is corruption. No shared "who holds the desktop".

**B. One app-owned runtime (recommended)** — Vocs Code attaches sessions to a single runtime:
- Where the host already runs the `CuaDriver.app` / `cua-driver-serve` daemon, attach with
  `cua-driver mcp --socket <endpoint>`.
- Otherwise start one `cua-driver serve --permission-mode <mode> --socket <app-owned path>` and
  point every session at it, mirroring `shared-server.ts`.

Each session then passes its Vocs Code session id as the tool `session` label (the tools accept
one), so audit trails correlate across concurrent sessions, and the app can serialize or refuse
concurrent GUI work rather than let two agents interleave input.

Recommended mode ownership: **do not fight the host.** Read the effective mode with `get_config`
and report it honestly in the UI. Offer to *own* the runtime only where the platform supports it
and only with the user's explicit acknowledgement. On macOS the honest UI is "granted by
CuaDriver.app — change it there", because a Vocs-Code-launched `--direct` runtime would lose the
existing TCC grants.

Layer the app-owned runtime over `shared-server.ts`'s pattern (lazy start, free port or named
pipe, `waitForMcp` readiness probe, `killTree` on quit); it is the same problem already solved
once.

## 4. Two independent gates, and how they map

This is the part that must not be flattened.

- **Vocs Code's gate** is per tool call, at the harness approval boundary. In Ask/Accept-edits it
  prompts for `mcp__cua-driver__*`; in Auto/Full it does not; in Plan the harness's read-only mode
  is the boundary. This gate is coarse (one prompt per call) but it is the one the user already
  sees and trusts.
- **Cua Driver's gate** is per action, inside the native runtime, after transport arguments are
  sanitized. `standard` is **promptless** for routine operations — it does not render a
  confirmation card — so it is not a substitute for the Vocs Code gate. `bounded` requires a
  reviewed capability manifest and denies undeclared scope; `unrestricted` requires
  `--dangerously-bypass-approvals`.

Mapping proposal:

| Vocs Code access | Cua Driver mode | Vocs Code prompt |
| --- | --- | --- |
| Plan | runtime must be observation-only, or cua tools are simply not injected | — |
| Ask / Accept edits | `standard` | yes, per cua tool call |
| Auto | `bounded` + reviewed manifest | no (bounded is the boundary) |
| Full access | `bounded`, or `unrestricted` only with a separate explicit dangerous acknowledgement | no |

Two hard rules:

- **Full access must not silently become `unrestricted`.** `unrestricted` needs a distinct,
  explicit acknowledgement, because it is a materially different promise ("the agent may do
  anything to your desktop") than "don't prompt me".
- **Plan mode must not be able to drive the desktop.** The cleanest implementation is to filter
  cua out of the effective set when the session's access is read-only, rather than rely on the
  harness refusing each call.

Cua's capability manifest is the right primitive for the Auto case — a manifest scoped to named
apps (by `bundle_id` on macOS, absolute executable path on Windows/Linux) and, for browser work,
named origins. Note Cua's own rule: an origin-scoped browser manifest **cannot** also allow
generic input tools (`click`, `type_text`, `get_window_state`, …), so a browser task and a generic
desktop task are two manifests / two runtimes. The UI must not pretend otherwise.

## 5. Integration surface: built-in, not a manual entry

Cua Driver should be an **opt-in built-in server**, `MCP_BUILTIN_IDS = ['gitnexus',
'vocs-memory', 'cua-driver']`, off by default, because a manual global entry would give up every
thing the built-in path already provides:

- Binary discovery (`which('cua-driver')` + the Windows
  `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin` and macOS/Linux `~/.local/bin` locations), a
  `cua-driver --version` / `cua-driver doctor` probe in `runtime.ts`, and a clear "not installed —
  here is the exact installer command" state instead of a broken server.
- An install action that is **never silent**: show the one-line installer
  (`install.sh` / `install.ps1`), run it only on explicit click, and never bundle or auto-update
  the binary.
- The mode/manifest settings, the kill switch and the per-session label live in one place.
- Harness filtering comes for free: inject into claude/codex/codex-exec/acp, client for native,
  bridge for pi, and **Cursor is inherit-only** — offer the same import/export the MCP page
  already has (`cua-driver mcp-config --client cursor` prints the entry).
- Codex loads its own `~/.codex/config.toml` underneath the session's config, so the built-in path
  must write `mcp_servers.cua-driver = { enabled = false }` for sessions that are not receiving it,
  exactly as `ownedMcpIds()`/`toCodex` already do for GitNexus.

## 6. What has to change to render computer use

Cua tools return an MCP `CallTool.Result` with a `✅` text summary **plus image content blocks**
(screenshots). Vocs Code's transcript today has no channel for that: `TranscriptItem`'s `tool`
variant carries `output?: string`, and images exist only on `user` items with an
`ImageAttachment[]`. Options:

1. **Add images to tool cards** (recommended): extend the `tool` transcript variant with an
   optional `images?: ImageAttachment[]`, thread it through the adapters' tool-result mapping and
   the native MCP tool bridge, and render it with the existing `imageSrc`/`ImageLightbox`. This is
   the honest representation and it is reusable for any MCP server that returns images.
2. **Screenshot to a file and reference it** via Cua's `screenshot_out_file` parameter, rendering
   a path or a small preview. Cheaper on tokens and on the transcript, but loses the inline
   evidence.

Recommendation: option 1 for the snapshot the agent acts on, and use `screenshot_out_file` /
`include_accessibility_tree:false` for the live preview panel (below), where the image is
continuous and must not enter the transcript at all.

Also needed:

- A `ToolKindHint` for computer use (e.g. `'computer'`) alongside `'mcp'`, so cua call cards get a
  distinct icon and grouping instead of the generic bolt. `toolKind()` maps names per harness.
- **A kill switch.** A visible "Stop desktop control" that calls `end_session`, terminates the
  app-owned runtime and drops cua from the effective set for the session. Computer use is the one
  integration where the user must be able to stop it without finding the right tool call.
- **A Desktop panel tab** (optional, Phase 2): the right panel already has a data-driven tab list.
  A tab that polls `get_window_state` with `include_accessibility_tree:false` and a capped
  `max_dimension` gives a live picture-in-picture of what the agent is doing, with the kill switch
  beside it.
- **Analytics**: cua tool calls become per-tool counts in the existing analytics store; do not add
  screenshots to analytics.

## 7. The skill

Two layers, and the first matters more:

- **Cua's own skill** teaches the agent to snapshot before acting, address elements by
  `element_index` rather than pixels, verify each action, and preserve focus. Install it with
  `cua-driver skills install` (it auto-links Claude Code, Codex, Prime Agent, OpenClaw, and others)
  or by copying the embedded `skill://cua-driver/` pack into Vocs Code's three skill roots
  (`src/main/skills.ts`) using the app's writer, so the Skills page can show and remove it. A
  button on the cua row is enough; do not auto-install.
- **A small Vocs-Code-authored skill** for conventions Cua cannot know: pass the Vocs Code session
  id as the `session` label, prefer the driver-owned isolated browser profile over the user's
  logged-in profile unless the user asked otherwise, and report a screenshot into the answer.

The embedded resource path only helps clients that activate remote skills from MCP resources;
Claude Code 2.1.268 does **not** add a remote skill to its startup catalog, which is exactly why
the filesystem install remains the native path. Vocs Code already owns those directories.

## 8. Phases

**Phase 0 — spike (no product code).** Register `cua-driver mcp` as a manual global MCP server in
Vocs Code. From a Claude and a Codex session: call `get_screen_size`, `list_apps`, and one action
in a disposable app (Calculator). Confirm the image blocks actually arrive at the transcript layer
and decide option 1 vs 2 in §6. Confirm what `get_config` reports for mode on each platform.

**Phase 1 — MVP.**
- `src/main/mcp/cua.ts` — binary discovery, base `McpServerDef`, mode→env/argv, per-session label,
  manifest path resolution, `get_config` read.
- `src/main/runtime.ts` — a `cua-driver` tool entry: version/doctor probe, install hint.
- `src/main/mcp/index.ts` — cua in `builtinDefs()`; opt-in default; socket attachment; Codex
  name-claiming.
- `src/shared/types.ts` — `'cua-driver'` in `MCP_BUILTIN_IDS`; settings for mode, manifest path,
  binary override, and the app-owned-runtime flag; `ToolKindHint` `'computer'`; images on the tool
  transcript item.
- Adapters + native MCP bridge — carry tool-result images into the transcript item.
- Renderer — cua row on the MCP page with mode select, manifest path, doctor state and install
  button; image rendering on tool cards; the kill switch.
- Tests — see §9.

**Phase 2.** Bounded-manifest editor with the browser-origin constraint surfaced, skill-install
button, Cua Computer History as an opt-in session audit view, subagent policy (default: subagents
may not use cua tools), analytics category, a window picker in the preview, and one app-owned
runtime shared by concurrent sessions.

**Phase 3 (optional).** Cua Fleets as a second provider for remote isolated desktops; Lume VMs as a
sandboxed desktop for Full-access computer use; a Cua Bench task in the opt-in live suite.

## 9. Testing

Per docs/TESTING.md, plus the standing rule that a behavior change needs a test that fails before
and passes after.

- **Unit**: `cua.ts` (discovery order, def shape, mode→env/argv mapping, label, manifest
  resolution, refusal to enable when the binary is absent); effective-set behavior (off by default,
  shadowing a same-id user entry, per-repo enable, harness filtering, Plan-mode removal); settings
  normalization.
- **MCP client / transcript**: a fixture stdio server that returns a text block plus an image block,
  proving the image reaches the `tool` transcript item and survives persistence — this is the
  regression test for §6.
- **Opt-in live suite** (`HARNESS_SMOKE_ONLY=cua`, skipped with a named reason when the binary or
  the display is absent): start the runtime, assert `tools/list` contains the expected names, call
  `get_screen_size`, and perform one action in a disposable app. Never stub it into passing.
- **E2E**: the MCP page shows the cua row and its states (not installed / installed / mode),
  toggle on and off, and the kill switch is reachable during a session. Update
  `tests/sidebar-nav.test.tsx` and the MCP suites if any of the surfaces it drives move.

## 10. Risks and non-goals

Risks that shape the design:

- **It drives the user's real machine**, including logged-in browser profiles and any app on the
  desktop. Prompt injection through a page the agent reads is a direct path to unintended action.
  This is why the default is opt-in and `bounded`, why `unrestricted` needs its own
  acknowledgement, and why a kill switch is required rather than nice.
- **Two shared resources, not isolatable.** One pointer, one keyboard. Concurrent sessions must be
  serialized or refused, not permitted to interleave.
- **Platform honesty.** Windows is Supported with elevated-integrity refusals; macOS needs
  Accessibility + Screen Recording and keeps the mode on the app bundle; Linux is per window
  system (`X11` supported, Wayland compositor-specific, Hyprland experimental). The UI should
  surface the host's real state, not a green check.
- **A moving target.** Cua Driver shipped MCP `2026-07-28` in 0.28.0 and the tool surface is large
  and versioned. Pin a minimum supported version, read tools dynamically, and never hardcode a tool
  list into the product logic.

Non-goals:

- Do not build a Cua harness adapter.
- Do not reimplement Cua's tools natively.
- Do not bundle the binary or its updater; installation is user-initiated and visible.
- Do not let Cua's own mode substitute for Vocs Code's approval gate.
- Do not adopt Cua Fleets in Phase 1 (credentials, cost, network).

## 11. Open questions for the user

1. **Runtime ownership**: attach to the host's existing Cua Driver daemon (honest, no mode control)
   or let Vocs Code own a runtime where the platform allows (mode control, more moving parts)?
2. **Default mode**: ship `standard` (works, promptless internally, Vocs Code prompts per call) or
   ship `bounded`-with-a-manifest (safer, but the user must build a manifest before it works)?
3. **Cursor**: accept inherit-only with import/export, or treat Cursor sessions as out of scope for
   computer use until its SDK grows an MCP seam?
4. **Subagents**: deny cua tools to all subagents by default, or inherit the parent session's
   access?
5. **Scope now**: Phase 1 only, or Phase 1 + the Desktop preview tab as the thing that makes the
   feature legible?