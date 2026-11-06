# Dots remote MCP control — implementation plan

Status: **first implementation slice under review; disabled and not shipped**. Revision 1.2, 2026-11-03.

This replaces the delivery order and first-release scope of the supplied **VocsCode CLI and MCP
implementation plan**, revision 1.0 (2026-10-17). The attachment remains historical input, not a
second specification to implement in parallel. This document records the review and subsequent
owner decisions; it does not authorize deployment, credentials handling, dependencies or paid tests.
The owner subsequently approved implementation and the pinned Cloudflare OAuth provider dependency.
That approval did not enable deployment or live/provider tests.

## Implementation checkpoint

The [first-slice guide](CONTROL-MCP.md) describes the code now present: typed desktop grants and
project identities, durable ordinary-session receipts and runtime barriers, a separate authenticated
relay MCP channel, and local enrollment/revocation UI. The coordinated `vocs.io` branch adds OAuth,
consent and ingress, followed by a disabled per-client OAuth lifecycle coordinator (see the guide).
Both cloud feature flags remain unset; authorization storage is not provisioned.

This is **not completion of every W0–W5 item** below. All questions are owner-only; creation uses
remembered defaults rather than arbitrary overrides; lifecycle events are a bounded local ring,
not a resumable public feed. Moved projects need explicit re-enrollment. Actual Dots identity,
interoperability, stable intent retries, distributed OAuth race qualification and two-computer live
validation remain gates before activation. No deployed `/mcp` availability is claimed.

## 1. Decisions and first user journey

The owner confirmed:

- Dots connects to a **remote HTTPS MCP endpoint**, not a local stdio process.
- Use **OAuth** for that connection.
- The gateway is our own deployment on our Cloudflare account, at the proposed
  `https://code.vocs.io/mcp` endpoint.
- The gateway may process readable prompts and results. Keep their content out of cloud logs and
  persistent storage by default. This is not blind-cloud, Dots-to-desktop end-to-end encryption.
- Support multiple computers, each running its own Vocs Code instance, and selected projects and
  sessions on each computer.

The first journey is: connect Dots once, choose an authorized computer and project, create or select
an ordinary session, send a development task, read its reply, and continue the conversation. The
existing desktop remains usable and authoritative. Source files and harness credentials stay on
the selected computer; only explicitly authorized request/result content travels through the gateway.

**Remote MCP is the first product, not a later extension of the CLI.** A local CLI, stdio MCP,
Missions and process administration are separate follow-ups, not prerequisites.

## 2. Existing foundation and baseline

Reviewed checkout: `6abe90ca24dfa41e0a2da312acd1357cfe3fb1f4` on `develop` (2026-11-02).
Revalidate against the implementation checkout and the deployed desktop/relay versions before work.
The code graph was stale in this review; the working tree supplied the implementation evidence.

| Existing boundary | Reuse / constraint |
| --- | --- |
| `src/main/remote/host.ts` | The desktop initiates an authenticated outbound connection to `/v1/ws/host`; it reconnects without exposing an inbound PC port. |
| `relay/src/worker.ts`, `hub.ts`, `routes.ts` | Account-isolated Hubs, registered computers, presence, targeted routing and revocation already exist. Account membership does not replace device authorization. |
| `docs/REMOTE-ACCESS.md`, `REMOTE-ACCESS-ROADMAP.md` | `code.vocs.io` is owned by the landing Worker in the separate `vocs.io` repository; it fronts `/app` and `/v1` through a service binding. Adding `/mcp` requires coordinated ingress/auth work there. |
| `src/shared/remote-channels.ts` | The browser channel allowlist is not an automation grant. Do not expose it wholesale or give the gateway a browser's approval/terminal authority. |
| `src/main/session-manager.ts`, `store.ts` | One session/runtime/transcript authority. Ordinary sends are not durably deduplicated just because the internal IPC accepts an `idempotencyKey`. |
| `src/main/handlers.ts` | Shared domain behavior, but invocation defaults to user origin. A controller must receive its own verified origin, never inherit that default. |
| `src/shared/session-defaults.ts` | Resolve remembered per-project choices, not only app-wide defaults. Existing project identity is path-based and needs an explicit stable-ID mapping. |
| `docs/MISSION-STATUS.md` | Missions remain experimental and are outside this first release. Ordinary session support does not certify Mission support. |

The reviewed relay has no MCP route. No live probe established that `/mcp` is deployed. The current
landing repository source, exact Dots client/version and its OAuth interoperability remain W0 checks.

## 3. Architecture

```text
Dots (OAuth MCP client)
          |
          | HTTPS /mcp — Streamable HTTP, version qualified with Dots
          v
code.vocs.io ingress + OAuth authorization / consent
          |
          v
MCP gateway — authenticated controller, bounded typed tools
          |
          v
account-isolated relay — explicit host/instance routing
          ^
          | outbound authenticated connection initiated by each computer
          v
Vocs Code desktop — local delegated grant + ControlService
          |
          v
existing SessionManager / SessionStore / harness adapters
```

The gateway is an API adapter, not another coding agent or scheduler. It never writes desktop
session files or maintains a second authoritative session database. The desktop owns admission,
execution receipts, transcripts and recovery. Cloud metadata may describe grants, hosts, request
correlation and content-free operation status; it must not become an offline copy of project data.

Use one public MCP URL for all computers. Every resource handle binds account, host/instance and
resource identity. Account/controller identity comes from authentication, never tool arguments.
Require explicit computer selection; there is no shared mutable "active computer" or "active
project" for all Dots. Replies identify their computer, project, session and operation.

A PC name is a display label, not an identifier. Reinstalled profiles and development/packaged
instances must not silently inherit another instance's grant. Same-named projects on two computers
are independent checkouts; this feature does not sync files or migrate running work between them.

An online desktop must advertise a compatible control capability and protocol version. An older
remote-enabled desktop is not automatically controllable. Missing, sleeping or disconnected hosts
return an explicit unavailable/unknown result. No fallback to another computer and no offline
mutation queue. Running the desktop on a headless server is a separate service-mode design.

## 4. OAuth and desktop authorization

OAuth authenticates and delegates access to the gateway; it does not itself authorize arbitrary
local execution. Implement and test both boundaries:

1. Dots discovers the authorization server for the MCP resource. The endpoint returns protocol
   authorization responses, not an HTML login redirect in place of an MCP response.
2. The owner signs in through the existing account identity and explicitly consents to the client,
   requested scopes and selected computers/projects. Reusing GitHub-backed sign-in does not mean
   accepting a GitHub token as an MCP access token.
3. Issue audience-bound access tokens with bounded expiry and reviewed refresh/revocation behavior.
   Bind client/redirect identity, use the selected OAuth flow's PKCE/state protections, and prevent
   consent or token reuse across accounts/resources. Do not put credentials in URLs or chat.
4. Each desktop separately enables external control and approves a named delegated grant. The cloud
   grant cannot exceed that local host/project/action grant. Existing browser pairing alone grants
   the automation client nothing.
5. The gateway sends only typed control requests with verifiable controller/grant provenance. The
   desktop validates scope, expiry, revocation and resource ownership again at admission and dispatch.
   A request with unavailable authorization freshness fails closed.

Keep controller, desktop-human, Mission participant and internal-agent origins distinct through
service/domain boundaries and audit. An arbitrary `dotId` label is not an authenticated principal.
If Dots shares one OAuth grant across several agents, they share that grant's authority unless Dots
provides a verifiable per-agent identity/delegation mechanism; do not claim per-Dot isolation otherwise.

Initial grants cover capability discovery, approved project/session metadata, separately authorized
transcript reads, session creation, sending and interruption of bound work. No secrets, raw terminal,
filesystem browsing API, generic IPC invoke, permission expansion or delegated security approvals.

The owner can revoke a controller locally and through the account UI. Revocation denies new
admission and prevents accepted-but-undispatched work from starting. Proposed v1 policy for work
already dispatched: let that admitted ordinary turn finish unless the owner separately requests
cancellation; report this plainly on consent/revocation screens. Disconnecting a client is not a
stop command. Revocation must not stop unrelated desktop work or claim to undo external effects.
This in-flight policy is a review decision before implementation, not an existing guarantee.

### Execution permissions are not a new sandbox

For v1, recommend ordinary sessions under explicitly approved existing permission modes. Enroll
only modes/harnesses the owner deliberately permits; reject later desktop mode expansion that
exceeds the grant on the next control admission. Do not silently change a session's mode.

Project grants restrict the **control API's resources**, not every file the harness can read.
For example, ACP permits absolute reads outside its workspace. A worktree is file separation, not
OS isolation. Disclose the selected harness's actual access at enrollment. The reviewed desktop does
not provide a universal `localEdits` / `localCommit` / no-push security ceiling. Those stronger
ceilings and runtime filesystem confidentiality remain unavailable until independently enforced and
certified through tools, shell, MCP and nested-agent paths. Never substitute prompt instructions for
enforcement. Confirm this ordinary-session scope before promising stronger isolation to users.

## 5. Cloud privacy and transport trust

The owner accepted that the deployed MCP gateway processes the tool requests and readable results.
Cloudflare is the infrastructure provider; Dots also receives the content returned to its MCP client.
Do not advertise the gateway as a blind encrypted relay. Preserve the existing browser-to-desktop
E2E path without giving the gateway browser identity keys, mirror keys or automatic transcript access.

Use a distinct authenticated controller channel over the existing host connectivity. Specify its
principal attestation, replay protection and grant binding before implementation; adding a new
message kind or a service binding is not authentication. Never forward arbitrary MCP arguments to
`HandlerRegistry.invoke` or accept client-supplied internal-routing headers.

Default cloud policy:

- No prompt, transcript, source-file, attachment, tool-output or raw request-body logging/persistence.
- Do not cache content responses or reuse the browser's offline transcript mirror for automation.
- Retain only bounded, allowlisted operational metadata needed for auth, routing and audit; define
  retention/cleanup explicitly. Redact errors and disable body capture in telemetry/tracing paths.
- No raw OAuth tokens, private keys or harness/provider credentials in audit or diagnostics.
- Bound frames, in-flight requests, response sizes, connection queues and per-controller rates.
  Slow clients must not stall the desktop; overflow requires explicit resynchronization.

Desktop transcripts and operation receipts remain local under normal retention. Temporary in-memory
processing in the gateway is not a claim that no data crosses the cloud. Any future durable cloud
content storage is a separate design/consent change, not an implementation optimization.

## 6. First-release contract and project defaults

Tool names below are proposed. Publish a small versioned allowlist, strict schemas, stable errors,
capabilities and bounded pagination; leave future tools absent rather than freezing the full original
catalog now. All mutation replies distinguish durable acceptance from completion.

| Tool family | First-release behavior |
| --- | --- |
| Capabilities / computers | List only authorized instances, online state and capability/version reasons. No registration or self-grant tool. |
| Projects | List/get approved projects on one explicit instance; no arbitrary host path registration. |
| Sessions | List/get/create ordinary sessions; select existing sessions only within an explicit grant. Reject Mission-managed sessions/workspaces. |
| Send | Submit text with a stable intent/idempotency key; return a durable operation receipt. Initially `rejectIfBusy` only. |
| Operations | Get status and bound output references for the caller's permitted work, including interrupted/failed/unknown outcomes. |
| Transcripts | Bounded pages authorized separately from session-list visibility, with input/turn/output correlation. |
| Interrupt | Target the exact active operation/runtime generation; refuse if ownership moved. Never a generic process kill. |
| Pending input | Show sanitized pending-task-input or owner-action-needed status. Only certified ordinary question sources may be answered externally. |

Project IDs must map to existing known folders and session project roots without duplicate
registration. Persist the mapping and reconcile moved/missing roots explicitly. Preserve the
canonical root/worktree relationship and reject symlink/junction substitution at filesystem effects.
A path supplied by a caller is not an authorization grant.

Resolve creation fields in a documented order: explicit permitted request, owner-approved controller
preset if selected, remembered project defaults, then existing app defaults. Reuse
`resolveNewSessionDefaults` semantics and report the resolved configuration. No silent model/harness
fallback. Default workspace behavior follows the project's remembered choice; an owner can configure
an isolated-worktree automation preset. Do not globally override existing worktree-off preferences.

## 7. Durable admission, completion and recovery

### One idempotency definition

The canonical receipt key is `(controllerId, admissionWindowId, method, idempotencyKey)` within one
host's durable journal. The immutable payload hash binds target instance/project/session and the
normalized request. Same key/same payload returns the same receipt; a changed payload conflicts.

Admission windows are server-issued, authenticated, controller-bound and expire at a fixed time.
Keep receipts/tombstones through the full window plus the documented retry grace period. Expired or
unknown windows never create new work, even after receipt garbage collection. A new window means a
new intentional submission; clients must not renew a window to retry an uncertain old request.
Qualify the Dots adapter's ability to preserve the complete intent key across request/reconnect
retries. Neither a transient MCP request ID nor a hash of prompt text is a durable user intent.

Authorize/validate, then persist the receipt plus dispatch intent before acknowledging acceptance.
Use one atomic write or a transactional outbox for each operation-state/event transition. Where
session creation/transcript persistence spans stores, use stable domain correlation and recovery;
never pretend unrelated files participate in one transaction. Storage failure must reach the caller.

### Bind inputs to turns and outputs

Introduce a stable app-level input identity and an explicit operation-to-turn association, runtime
generation and output/child references. Preserve the normalized `SessionEvent` stream across all
adapters; extend it compatibly rather than introducing a second uncorrelated event stream.

The first release rejects a busy session instead of silently steering or queuing. Serialize admission
at the shared session/domain boundary so concurrent desktop and controller sends cannot both win.
Once a controlled turn is admitted, a second send must not become an untracked contribution to that
turn. Surface busy status to both clients; keep an explicit human interrupt available. Do not infer
completion from `send()` resolving, an idle parent or the next unrelated terminal event.

Require a failure-propagating persistence barrier for the terminal turn and its output references
before committing durable success. Current live events can publish before transcript appends finish,
and append failures are logged rather than propagated; observing them alone is not this barrier.
Test the gap between observing a terminal event and persisting the final answer, not only the gap
between operation-state persistence and publishing an event.

Advertise operation completion only for qualified adapter behavior, including its tracked child work;
unknown child disposition is not proof of success. Return recorded execution evidence and the
assistant's answer distinctly. Do not certify that tests/builds passed merely from assistant prose.

Control lifecycle events are durable and replayable with log generation, instance epoch, stable
event ID and bounded cursor. State/event writes are atomic or use an outbox drained on recovery.
Polling remains sufficient even if Dots does not support notifications or MCP task extensions.

On connection loss, admitted work may continue locally. Return uncertainty, reconnect to the same
instance and query the same receipt; never reroute/replay on another computer. On application restart,
reconcile against domain receipts and actual runtime state. Unknown side effects remain unknown;
no automatic replay of an irreversible action. Terminal history is immutable; later reconciliation
or resumption gets a linked record/new operation. A client timeout is not cancellation.

## 8. Questions and approvals

Existing `ApprovalRequest.questions` can contain a batch, and existing question classification can
originate from arbitrary extension UI methods. Some questions are secret-bearing. Do not treat
`kind: 'question'` alone as proof that a response is safe to delegate.

Qualify sources/adapters and preserve sensitivity metadata. Secret inputs, unknown-origin requests,
security approvals and requests that would authorize plan/delivery/grant changes remain owner-only.
Never classify them by searching their prompt for sensitive words. A typed question response cannot
submit an arbitrary `ApprovalDecision` or edited tool input.

Represent the underlying question group and answer it atomically, or durably aggregate child answers
before resolving the group. Use exact session/group/question IDs, revision and one-winner CAS against
concurrent desktop/controller answers; validate allowed choices, required answers, cancellation and
free text. Preserve actor provenance. Do not resume the harness after only one answer from a required
batch or advertise multiplicity the adapter cannot represent.

If a source cannot satisfy that contract, advertise observation/owner-action-needed only. Ordinary
chat replies still use `send` once the session is ready; they never resolve an unrelated pending gate.

## 9. Delivery packages

| Package | Deliverable and gate |
| --- | --- |
| W0 — interoperability and security decisions | Inspect the current landing repo and deployed version boundaries. Identify the exact Dots client, supported MCP/OAuth discovery and client-registration flow, refresh/revocation, intent-key behavior and shared/per-Dot identity. Select compatible SDKs/storage/attestation, review in-flight revocation policy and ordinary-session permission scope. Obtain approval before any new runtime dependency. |
| W1 — typed service and project identities | Small catalog, schemas, grant/resource checks, instance/project ID mapping and compatible defaults. Test denied requests through real dispatch; preserve desktop-human/agent/controller provenance. No public listener enabled. |
| W2 — durable session boundary | Receipt journal, outbox/replay, input-turn-output binding and terminal persistence barrier, exact interruption and restart reconciliation. Real SessionManager/SessionStore with scripted adapters and failure injection. No generic IPC tunnel. |
| W3 — authenticated vertical slice | Local desktop enablement/revocation UI, OAuth consent/token validation, explicit controller channel over existing relay, `/mcp` ingress and capability-filtered tools. Read-only end-to-end first, then W2-backed ordinary session control. No production enablement without review. |
| W4 — actual Dots qualification | Connect the real Dots client, select between two authorized running desktop instances, use new/existing sessions and follow-up chat, observe results and prove wrong-host/project/approval requests are denied. Qualify packaged Windows first; other platforms need their own evidence. |
| W5 — release and operations | Coordinated desktop/relay/landing versions, migration/rollback, grant revocation, redacted diagnostics, retention defaults, compatibility matrix and deployment review. Existing browser remote access must remain intact. |

W1/W2 can proceed without adding CLI packaging or Mission readiness work. A local test client is
useful but not a requirement to ship a complete CLI. W3's mutation path depends on W2's tests, not
merely a working HTTP handler. W4 includes a real client, not only MCP Inspector/scripted tests.

Follow-ups, ranked after first-release qualification:

1. Local CLI/stdio adapter and richer session controls (queue/steer, attachments, exports), reusing
   the same contracts. Queue/steer require delivered-vs-queued acknowledgments, per-input correlation
   and cancellation semantics for shared turns before exposure.
2. Missions, enforceable delivery ceilings, process administration and any offline cloud content
   mirror: separately designed/certified capabilities with independent grants and tests.

## 10. Verification and rollout

Required behavior tests include:

- OAuth resource/audience, redirect/client binding, consent forgery/replay, expired/revoked grants,
  refresh failures and two-account isolation. Caller-supplied account/Dot/internal-header fields
  cannot upgrade identity. Browser cookies do not become automation credentials.
- Two computers, duplicate display/project names and instance replacement; wrong host/session/project
  handles never dispatch. An offline or old host cannot execute via another instance or later queue.
- Real handler/service denial tests; invalid inputs never reach privileged dependencies. Existing
  Mission ownership protections remain enforced through the new ordinary-session entry points.
- Same-key concurrent sends, lost acknowledgments, expired windows after receipt cleanup, changed
  payload conflicts, desktop/controller send races, stable turn/output binding and cancellation races.
- Crashes/full disk/failed writes at receipt, dispatch, terminal-output persistence and event/outbox
  boundaries; exact session/turn counts after restart and honest unknown outcomes.
- Question groups, secret/unknown-source exclusion, stale answers, concurrent human/controller answers
  and proof that question tools cannot resolve security approvals.
- No cloud content/token logging or persistence in errors, telemetry, retries, queues and diagnostics;
  bounded payloads, slow readers, reconnection and no global mutable computer selection.
- Existing browser enrollment, E2E routing, view-only controls, pairing/revocation and web UX regressions.

Each implementation PR follows [AGENTS.md](../AGENTS.md) and the current change-to-suite table in
[TESTING.md](TESTING.md): develop typecheck, changed tests plus named area suites, build and edited/new
E2E flows; release/master runs the full offline/no-provider/Windows recovery gates. Harness changes
also require the documented live/manual tiers. Missing client/platform/provider access is unverified,
not passed. Paid tests and live production mutations require explicit authorization.

Roll out disabled by default. No deployed gateway may infer authority from a desktop's older browser
remote capability. Grant and control protocol versions must be negotiated. Rollback disables new
admission/listeners, preserves local receipts/transcripts/worktrees and does not kill unrelated work.
Coordinate both repositories and the protected release-tag relay deployment; a merged document or
`develop` PR is not production deployment approval.

### First demonstration / definition of done

On two disposable fixture projects across two running instances: enroll the permitted controller,
connect Dots through OAuth, select a host/project, create a session, submit a small change, read its
recorded result and continue chatting. Exercise an explicitly granted existing session as well.
Drop the connection after admission, reconnect and recover the same operation without another turn.
Reject wrong-host/project access, security self-approval, revoked/expired requests, a duplicate with
changed payload and an offline target. Prove the terminal answer survives a restart and persistence
failures do not report successful output. Finish with targeted interruption and unaffected unrelated
desktop work. Use a scripted adapter first; a live harness demonstration requires separate approval.

No implementation, deployment or client-compatibility result is claimed by this plan.

## References

- [Remote design and trust model](REMOTE-ACCESS.md), [remote roadmap](REMOTE-ACCESS-ROADMAP.md)
- [Architecture / harness permission matrix](ARCHITECTURE.md), [Mission limits](MISSION-STATUS.md)
- [Cloudflare MCP transport](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/)
- [Cloudflare MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)
- [Cloudflare MCP security](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/)

Cloudflare documentation was retrieved during this review, but library APIs and Dots compatibility
must be pinned and tested during W0. Do not silently upgrade the application's existing MCP SDK or
add an orchestration framework merely because a current tutorial uses one.
