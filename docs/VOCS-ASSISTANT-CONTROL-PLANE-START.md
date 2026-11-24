# Vocs Code assistant and control plane: where to start

**Phase 0 assessment and initial architecture decision — no feature activation.** Keep the
[full proposal](VOCS-ASSISTANT-CONTROL-PLANE-PLAN.md) as the destination. The first deliverable is
an approved project's ordinary sessions visible from the Windows terminal and local stdio MCP,
using the already-running desktop. Do not wait for persistent Vesta or cloud rollout to build it.

[Windows local control preview](LOCAL-CONTROL.md) implements the read-only CLI and stdio path for
source checkouts. It does not change Vesta's tools or the remote MCP rollout. Windows account,
packaged CLI, and other-platform qualification remain separate.

## Revalidated baseline (at plan review)

- **Desktop `3977b2f`:** the five blobs cited in the proposal still match. [Vesta](VESTA.md) is
  an in-app pi conversation with an in-memory transcript, argument-sensitive proposals and an
  allowlisted capability bridge. It can create a session after approval, including an initial
  prompt; it has no general tool for sending to an existing session today. Do not treat a Vesta
  proposal or a model summary as a durable task or operation receipt.
- **Control:** the desktop already has strict v1 request schemas, grants, project identities,
  durable receipts and controlled turns. No packaged CLI or local endpoint existed at this baseline.
  The Electron single-instance lock is profile-specific; a second invocation focuses the app,
  not an authenticated request/reply channel. Dev, installed and test profiles stay separate.
- **Landing `257c5d9`:** the [gateway](https://github.com/vocsong/vocs.io/blob/257c5d9/code/worker/MCP.md)
  and relay code are merged, not an activated or qualified MCP service. `MCP_ENABLED` and relay
  `CONTROL_MCP_ENABLED` are unset in the checked-in configs; `MCP_AUTHORIZATION` is unbound and
  has no production migration in the checked-in config. The landing now checks **Vocs Login**
  for consent and maps its subject to the existing relay account ID. Older GitHub-gate setup
  text in the gateway runbook is stale. Browser sign-out and controller revocation are separate.
- **Not verified:** live flags/bindings, live OAuth/provider behavior, the exact Voxy or Dots
  client/build and its supported transport/retry behavior, or a two-computer run. MCP Hub is a
  connector catalog/credential boundary, not the inbound control service. Do not infer that an
  outbound MCP client or issuer change proves an inbound controller route.

## Capability matrix

This is an inventory of existing boundaries, not a new grant list. External operation names
below use the domain method; the relay converts dots to underscores and adds `hostId`.

| Operation | Current schema / caller / transport | Risk and authority to preserve | Verification baseline / first new check |
| --- | --- | --- | --- |
| Host, capabilities and project discovery | `computers_list` is HTTPS relay-only; `capabilities`, `projects.list` in [`controlParams`](../src/shared/control.ts); Vesta sees known folders in app context/`get_app_settings` | External discovery requires a matching live desktop grant; expose handles, not settings or paths | `control-relay.test.ts`, `control-relay-workerd.test.ts`; add local profile/grant and post-await withdrawal checks |
| Ordinary session metadata | Vesta `list_sessions` via [`AGENT_CAPABILITIES`](../src/shared/agent-manifest.ts); automation `sessions.list/get` via [`ControlService`](../src/main/control/service.ts) | Shared first read: `sessions.list` for an explicit project. Keep Vesta's existing UI-scoped behavior separate from the narrower caller grant and projection. Exclude archived/managed or out-of-project sessions from delegated results | `vesta.test.ts`, `control-service.test.ts`; compare project-scoped outcomes across adapters; no leaked paths, unapproved rows or unauthorized fallback |
| Create / send | Desktop session handlers; Vesta `create_session` is a write proposal; HTTPS `sessions.create/send` with a bound admission window and intent key | Existing Vesta approval stays. External write needs its own grant and pre-effect checks. Bound one turn to the selected instance, canonical workspace and runtime; no mode escalation, raw path or harness override | `vesta.test.ts`, `handler-registry.test.ts`, `control-service.test.ts`, `control-turns.test.ts`; add one approved existing-session send, denied dispatch has zero effects, lost ACK has one send |
| Transcript, receipt, interrupt | Desktop transcript and Stop; HTTPS `sessions.transcript`, `operations.get/interrupt` | Transcript is separately granted and projected; do not disclose owner-only answers. Get/interrupt only the caller's exact operation; Ctrl+C or client disconnect stops waiting, not the turn | `control-service.test.ts`, `control-turns.test.ts`; later transcript/operation tests, not part of the read-only slice |
| Manage authority and approvals | Remote grant management is desktop-main-frame-only in [`ipc.ts`](../src/main/ipc.ts); Vesta resolve/confirm is an existing UI path | No grant management, owner approval, generic `invoke`, settings, secret, shell or terminal tool on new adapters. Same OS user and Vocs Login are not blanket owner authority | `handler-registry.test.ts`, `harness-setup-ipc.test.ts`, `vesta.test.ts`, `e2e.remote.test.ts`; test origin refusal at the new boundary, not only in a parser |
| MCP connector setup and probing | Vesta `mcp:*` allowlist, argument-sensitive tier; MCP Hub is a separate outbound concern | A stdio probe launches a process and still needs a proposal; destructive actions retain confirmation. No reuse of connector credentials or probes in the controller API | `vesta.test.ts`; retain the existing proposal/decline behavior and payload projections |
| Assistant tasks / Mission | No durable Vesta task API. The former Mission feature (since removed) owns its managed workspaces, execution and delivery | A task refers to a session/operation or explicitly supported Mission; it is not a scheduler with broader authority. No Mission scope in ordinary-session v1 | Mission scripted/Windows verification is not a live demonstration or macOS/Linux support; add task recovery separately |

## ADR: one session authority, narrow adapters

- Use `src/shared/control.ts` as the request/method schema source for **new shared automation
  operations**. Preserve v1 HTTPS names, fields, scopes, and `control.json` compatibility. Prove
  one read before extracting more. Keep existing Vesta tool-facing schemas, argument-dependent
  risk, result projections and proposal behavior; reuse typed domain operations behind its
  bridge where semantics match. Parity means the same resource and permission checks where
  applicable, not identical access or payloads for the owner, assistant and external clients.
- The running app is the sole session/runtime/transcript owner. CLI and local stdio are clients
  of one app-owned, opt-in IPC endpoint. Vesta uses in-process typed calls, not a subprocess of
  the CLI. Do not reuse the browser bridge, raw renderer IPC, or open a localhost HTTP port.
- Authenticate the local peer **and** intended profile/endpoint before reading a grant. Prove a
  local-only Windows named pipe with explicit user access controls and protected discovery; a
  name, a claimed SID, same-user status or a record on disk alone does not make it the app or
  the owner. The desktop authorizes a revocable local grant under a distinct local principal;
  do not spoof a relay account or pass a caller-supplied actor. Keep the local grant namespace
  separate from remote v1. State clearly what the chosen boundary can isolate among programs
  running as the same user. No new dependency before approval if the platform spike needs one.
- Reuse the desktop's canonical-workspace and execution checks at use time, and recheck a read's
  scope before publishing after asynchronous work. Stable target and operation IDs belong to
  the app. Durable admission, dispatch and completion remain separate; no success from timeout,
  idle, a plain LLM message or a missing receipt. A project grant is not a runtime sandbox:
  do not promise “no merge/deploy” as a universal ceiling without actual effect-level controls.

## Implementation order and stop conditions

1. **Phase 1a: one read-only vertical slice.** Use a disposable Windows profile with one approved
   and one unapproved project. Prove the transport first; add CLI `status`, `projects list` and
   project-bound `sessions list --json`, and the equivalent local SDK stdio tools. Use the same
   typed `sessions.list` path for a project-scoped Vesta view without replacing its existing
   global tool. Verify disabled, wrong user/profile, app closed/restarted, incompatible version,
   revoked grant, malformed input and out-of-project results on real Windows. Keep stdout
   machine-only in JSON/stdio modes. No read of transcripts, writes, installer/PATH, auto-launch
   or headless support in this slice. Qualify macOS/Unix sockets separately before claiming
   platform parity. If the Windows endpoint identity/access checks cannot be proven, stop before
   exposing real project data.
2. **Phase 1b: one gated send to an existing idle ordinary session.** Reuse the existing manager,
   journal and admission/dispatch checks. Prove Vesta still requires an owner proposal; a
   local controller requires an explicit action grant. Use a scripted adapter with the real
   manager/store: a duplicate intent dispatches once, revoke before dispatch prevents it,
   a busy human turn is not joined, restart without evidence remains unknown, and success has
   durable correlated output. Then add creation, scoped transcript and interrupt incrementally;
   package only after a fresh installed Windows profile and real stdio client pass without
   a checkout. The local control path needs no cloud sign-in; individual harnesses may need one.
3. **Phase 2: persist conversations, then one task for one ordinary session.** Local history
   can start independently of the CLI. Persist a versioned, owner-scoped text projection, not
   raw `AgentState` with images and proposal arguments. Keep pi's `--no-session` boundary; supply
   bounded history as context for the next turn, never replay tool calls. Prove a follow-up after
   restart remembers a fact with zero replayed calls. Invalidate pending approvals on restart;
   fence late callbacks after clear and document retention, export and deletion. Then link a
   task to a controlled operation. Commit intent/target before submitting; reconcile an observed
   receipt on restart. If association or completion cannot be proven, report unknown, not a
   fresh send. Show input, approval, offline and evidence states separately. An interrupt request
   or ACK does not prove cancellation without correlated terminal evidence and quiescence.
4. **Phase 3: direct HTTPS MCP can qualify in parallel with local work.** First join the actual
   gateway and relay workerd fixtures offline, using synthetic Vocs Login and a disposable
   desktop/host grant. Check disabled/unbound behavior, mapped consent and that revocation blocks
   new calls. Run an independent authorization review and verify public OAuth edge budgets; relay
   limits are not registration/token limits. Then, with separate rollout authorization, verify
   the real Voxy/Dots client (current server is stateless Streamable HTTP), retry/refresh behavior,
   one-computer pilot and two computers. Keep remote disabled until the gate is met.
5. **Phases 4–5: delegated tasks, then multiple sessions.** Require Phase 2 recovery and Phase 3
   caller qualification before accepting external tasks. Separate tools/grants from direct control;
   key on one task owner and one intent, recheck scope, bound recursion, and expose explicit
   reply/status/cancel. Persist authorized task events with task state, not in the bounded
   controller diagnostics ring. Once a one-session task is reliable, add dependency scheduling
   and outcome verification for ordinary sessions. Use Mission only for supported combinations;
   Windows test support does not certify it on other platforms or against live providers.
6. **Phases 6–7: explicit opt-in choices, not foundations.** Cloud continuity needs a content and
   retention decision (including titles, summaries, logs and backups), cost/budget policy, and
   a durable coordinator generation enforced at the host before side effects. No silent host
   substitution or offline execution queue. Evaluate A2A only with a named client/version and
   approved dependencies; a task submitted once via MCP should have the same ID and grants when
   observed via A2A. Neither blocks the CLI or MCP.

Follow [TESTING.md](TESTING.md) for local/CI gates and update the matching Windows Electron E2E
with the first user-visible command path. No new runtime, provider spend, secrets, cloud storage,
provisioning or deployment is authorized by this document. If the CLI must work when the desktop
is closed, that is a separate host-lifecycle, credential and approval design, not a fallback to
start another writer against the same profile.
