# Remote controller MCP — first implementation slice

**Implemented for review; disabled and unreleased.** This is not evidence that Dots can connect to
production. The exact Dots client/version, its retry behavior, and a two-computer live qualification
remain outstanding. The broader [plan](CONTROL-MCP-PLAN.md) is not all implemented.

## Boundaries

- The separate `vocs.io` landing Worker owns OAuth and `/mcp`. Its `MCP_ENABLED` flag is unset and
  `OAUTH_KV` is deliberately unbound. The relay's `CONTROL_MCP_ENABLED` flag is also unset.
  Nothing in this change provisions credentials, enables these flags, or deploys either Worker.
- Browser sign-in authorizes consent, not MCP calls. Resource-bound OAuth bearers identify an
  account and controller. Refresh retains that controller; another consent creates another one.
  Dots sharing a grant share its authority; a supplied Dot name cannot split or expand it.
- The landing sends a 30-second, exact-body-bound HMAC assertion through its relay service binding.
  The account Hub verifies it again and durably consumes a single-use nonce. A request names its
  host explicitly; the reply must come from that host's current authenticated socket.
- Controller traffic is a separate typed channel, never browser IPC. The desktop independently
  checks account/controller, instance, project, action, expiry, harness and permission mode.
- Gateway and relay see readable content. MCP bodies/results are not logged, cached or queued in
  cloud storage. OAuth KV contains authorization data, not conversations; relay storage contains
  bounded nonce metadata. Existing encrypted browser access and its optional mirror remain separate.

## Owner setup (after a separately approved rollout)

1. Enroll/connect each computer through the existing Remote access panel. Keep its project folders
   in Vocs Code. Source checkouts and harness credentials stay on that computer.
2. Start OAuth from the controller client. On the consent page, copy both **Account ID** and
   **Controller ID** before completing consent.
3. On each native desktop, open **Settings → Remote access → External MCP control**. Enable
   external control, enter those IDs, and select projects, actions, a harness and a permission mode.
   Confirm the disclosure and save the grant. The UI grants **all ordinary sessions** in the
   selected projects, not one individually chosen session, for 30 days.
4. Discovery now returns only online, compatible computers with a matching local grant. A missing,
   offline, unapproved or older computer is not silently replaced by another target.

Only the actual desktop main frame can invoke the grant-management IPC channels. A paired browser,
internal agent, Mission, or controller cannot enable control or change its grants.

Project enrollment binds a stable ID to a canonical root and filesystem identity. A missing,
replaced or redirected root is refused. A moved root needs explicit owner re-enrollment; automatic
move reconciliation is not implemented. A project grant is an API-resource boundary, **not an OS
sandbox**. The selected harness retains the permissions/access of its existing mode.

## Tool flow

All tools except `computers_list` require `hostId`. `capabilities` returns the desktop `instanceId`;
all subsequent desktop calls require it. Request objects reject extra fields.

| Tool | Purpose / extra identifiers |
| --- | --- |
| `computers_list`, `capabilities` | Authorized online hosts and compatible API version |
| `projects_list` | Approved project IDs; no arbitrary path input |
| `sessions_list`, `sessions_get` | Ordinary session discovery/status within a `projectId` |
| `sessions_transcript` | Separately authorized, bounded `offset`/`limit` reads |
| `windows_create` | Server-issued, controller-bound admission window |
| `sessions_create` | Create with `projectId`, admission window, stable `idempotencyKey`, optional title |
| `sessions_send` | Send text to an existing `sessionId` with the same intent fields |
| `operations_get` | Read a receipt by `operationId` |
| `operations_interrupt` | Interrupt only that controller's exact active operation/runtime |

Creation uses remembered project/app defaults and refuses unapproved harness/mode choices. There
are no caller-controlled configuration overrides or silent model/harness fallback. Follow-up chat
uses another `sessions_send` on the same session, with a **new intent key**. A retry of that same
send must retain its original key, admission window, target and text. Never manufacture a new key
merely because an acknowledgment was lost.

Transcript access is independent from send permission. Approval/question cards are replaced with
owner-action notices. **All questions and security approvals remain owner-only**, including ordinary
questions in this first slice. There are no generic invoke, filesystem, terminal, secret, Mission,
queue, steer, attachment or slash-command tools.

## Receipts, recovery and revocation

- Admission and lifecycle metadata commit to the desktop's atomic `control.json` before acceptance.
  It contains grants, project identities, hashes and correlation IDs, not prompt text. The tuple is
  `(account/controller, admission window, method, idempotency key)` within one desktop journal.
- Same key/payload returns the same receipt; a different payload conflicts. Windows admit new work
  for at most one hour. Expired windows can return existing receipts through a 24-hour retry grace,
  but cannot admit new work. Terminal receipts may be pruned after that grace. Unknown window IDs
  always fail closed. Limits are 1,024 retained windows and 5,000 receipts; new admission returns
  `busy` at capacity. Local lifecycle diagnostics retain the latest 10,000 entries and are not a
  resumable public event stream.
- A controlled send reserves the shared session boundary synchronously and uses a fresh runtime
  generation to fence late events. Desktop sends/configuration changes cannot join it. Busy,
  managed, active-goal, queued or unproven work is refused. Human Stop/Interrupt remains available.
- `succeeded` requires a correlated terminal event, proven quiescence, and a failure-propagating
  atomic/fsynced transcript and metadata barrier. It does not mean assertions in assistant prose
  or tests mentioned there were independently verified. Unsupported child/writer evidence produces
  `unknown`; this is not blanket live-harness certification.
- Creation derives its session ID from the operation UUID. Restart marks unfinished receipts
  `unknown`, never automatically replays prompts, creates worktrees again or declares success from
  a live event alone. Session storage and the journal are separate stores; ambiguous crash windows
  remain explicitly unknown. Do not delete the journal to recover a lost acknowledgment.
- Local revoke/disable prevents new dispatch. Already-dispatched turns are not automatically stopped;
  use the ordinary desktop Stop or an authorized exact-operation interrupt. OAuth/KV revocation is
  eventually consistent, and an already-issued assertion can remain valid for up to 30 seconds.
  This is not an instantaneous global cancellation guarantee.

## Verification and remaining rollout gates

Offline coverage: `tests/control-service.test.ts`, `tests/control-turns.test.ts`,
`tests/control-relay.test.ts`, `tests/control-relay-workerd.test.ts`, and the owner-origin cases in
`tests/handler-registry.test.ts`. `tests/e2e.remote.test.ts` drives actual renderer → IPC → journal
grant creation/revocation. Real local workerd exercises the SDK, host sockets and replay rejection
across restart. The landing repository owns OAuth/consent and browser tests under `code/worker/`.

Before activation: independent authorization review; distributed OAuth code/refresh/revocation
race qualification and edge abuse controls; actual Dots OAuth/transport/stable-key qualification;
two real computers/projects including existing-session follow-ups, disconnect/restart, revocation,
wrong-resource denial and unaffected desktop work. Live GitHub/provider tests, provisioning and
production deployment require separate authorization. See [TESTING.md](TESTING.md) for the develop
gate and [the roadmap](REMOTE-ACCESS-ROADMAP.md#28-dots-remote-mcp-control-implemented-first-slice-disabled) for status.
