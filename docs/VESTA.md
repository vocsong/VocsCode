# Vesta

Status: **P0 shipped.** A floating in-app assistant that drives Vocs Code itself — setting up MCP servers, starting sessions, tidying branches — through a fixed allowlist of app capabilities.

The name is from Vesta, the Roman goddess of the hearth and home — the Roman counterpart of the *agathos daimon*, the benevolent household spirit: something that lives with you and does small useful things.

## Why it exists

Configuring an MCP server by hand means knowing the transport, the command line or endpoint, and which environment variable holds the token. That is a lot of ceremony for "set up this server". Vesta turns it into a sentence — and the same machinery generalises, because everything the user can do in this app is already an IPC channel.

## Shape

```
src/shared/agent.ts            transcript, proposal and state types
src/shared/agent-manifest.ts   THE ALLOWLIST — one entry per capability
src/main/agents/pi-runtime.ts  the pi process: spawn, RPC events, the capability bridge
src/main/agents/context.ts     system prompt + per-turn app context
src/main/agents/tools.ts       manifest -> tool defs; runs one capability
src/main/agents/index.ts       the gate: batch, approve, apply, confirm
resources/pi/vocs-code-vesta.ts  registers the allowlist tools with pi
src/renderer/src/components/Vesta.tsx   the floating panel
```

Vesta runs on **pi**, the same coding agent the Pi harness uses, started once per conversation in
RPC mode. It is a hermetic run: no session file, no built-in tools, and no user extensions, skills,
prompt templates or context files — only the capability bridge. The bridge extension registers one
pi tool per allowlist entry and forwards every call back to the app over pi's extension-UI channel,
where this code decides, gates and performs it. Neither the tool list nor any capability logic
lives in the extension; both come from the app at spawn time. A turn's system prompt is rewritten
before every message, so the app-context block stays fresh without restarting pi.

Vesta has no shell, no filesystem and no network of its own: if a job needs any of those, it says
so. `unavailable` is set when pi is not installed, and the panel shows where to install it.

## The allowlist is the security boundary

`handlers.ts` is a transport-agnostic registry serving 100+ channels — including `secrets:set` and `terminal:input`, which is raw keystrokes into a live PTY. Handing a model `registry.invoke` would be handing it a remote shell. So the default is closed:

- A capability exists in `AGENT_CAPABILITIES` or it does not exist. An unknown tool name is refused before dispatch and logged.
- Each entry carries its own JSON Schema, a **risk tier**, a one-line human summary and an optional projection that trims the channel's reply.
- Tiers: `read` runs immediately; `write` and `destructive` become a **proposal** the user approves. Destructive proposals additionally route through the confirm dialog, listing every target by name.
- The tier is a function of the request, not just the channel. An `http` MCP probe is a network read; a **stdio** probe runs a command line the model chose, so it is gated.
- Projections keep payloads out of the prompt as well as the context: `get_app_settings` deliberately drops the provider table.
- Secrets never reach the model. Vesta learns only that `${GITHUB_TOKEN}` is *required*; the value goes from the renderer to the OS keychain and never enters the transcript, the history or a provider request.
- Pasted images are not capabilities: they go straight to the model through pi's prompt, so they add nothing to the allowlist and never reach a handler themselves.
- `agent:*` is blocked on the WebSocket transport (`isRemoteBlocked` in `web-server.ts`), which otherwise forwards every channel.

## Adding a capability

Append an entry to `AGENT_CAPABILITIES`:

```ts
{
  name: 'rename_session',
  channel: 'sessions:rename',
  description: "Change a session's title.",
  parameters: { type: 'object', properties: { … }, required: […], additionalProperties: false },
  tier: () => 'write',
  summarize: (a) => `Rename a session to "${a.title}"`,
  request: (a) => ({ id: a.session_id, title: a.title }),
  project: () => ({ ok: true })
}
```

Rules of thumb:

- Prefer a channel that already narrows the blast radius over a general one. Global MCP servers go through `mcp:import` (merge by id) rather than `settings:update`, which would expose all of settings.
- `description` is the model's only documentation. Say what the tool is for and what to read first.
- `request` may be async and may consult the `CapabilityContext` — settings, plus a per-harness model
  catalog (`ctx.models`, the same `harness:models` reply the New Session dialog gets). Throw to refuse:
  the model sees the message as invalid arguments and the channel is never invoked. `create_session`
  uses this to resolve its optional `model` (`provider/model`, the app's canonical model name) against
  the chosen harness's catalog, so an unknown id, an id another harness offers, or a harness that
  cannot list its models all fail before a session exists; omitting `model` keeps the harness's
  configured default. A channel the context reaches on a capability's behalf is listed in
  `CONTEXT_CHANNELS`, so `agentChannels()` still names the whole surface.
- Give bulky replies a `project`, or the model's context fills with session metadata.
- Anything that deletes, pushes, merges or spends money is `destructive`.

`tests/vesta.test.ts` asserts the boundary: no forbidden channel is reachable, nothing gated runs unapproved, and `tests/handler-registry.test.ts` proves every allowlisted channel actually exists.
`tests/vesta-pi.integration.test.ts` (opt-in, `VOCS_CODE_PI_INTEGRATION=1`) runs the real installed
pi with a scripted provider and proves the bridge itself: the extension registers the allowlist,
pi dispatches the calls, and the gate answers them.

## Model

Vesta uses pi's own providers and models. `settings.agentModel` pins one from pi's catalog (the
Settings → General picker lists them); unset means pi's default model, which is also what a pi
session would use. The panel shows the model pi reports for the run, so a weak pick is diagnosable
rather than mysterious. If the pinned model no longer resolves, pi reports the error in the
conversation and the user picks another one.

## Not yet

- Repo-scoped chat on the right-panel MCP tab (the component takes a scope prop cleanly).
- Conversation persistence across restarts; today the transcript is in-memory and clearing it
  restarts the pi process.
- A second persona. The runtime is general, but one assistant that can do more beats several that
  each do less.
