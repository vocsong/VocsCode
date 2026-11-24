# Vocs Code assistant and control plane: implementation handoff

Version: 1.0 · 18 November 2026 · Status: proposed architecture and implementation backlog.

This document is a standalone handoff for implementation in Vocs Code. It does not claim that the proposed assistant, CLI, A2A endpoint, cloud orchestration or production integrations already work. The name **Vesta** is provisional. Implement a renameable assistant, not a product identity hard-coded through the system.

## 1. Outcome and product thesis

The user wants a conversational, personal-assistant experience for Vocs Code: one place to discuss work, remember decisions, delegate development, monitor sessions, answer questions and receive meaningful updates. It should feel like a continuing relationship and a responsible coordinator, not a command palette that happens to accept English.

Vocs Code remains the execution environment. Its CLI and MCP are programmable control surfaces. Vesta is the reasoning and coordination layer above those capabilities. Voxy is an external personal assistant that can either operate Vocs Code directly or delegate an outcome to Vesta. A2A is a later interoperability adapter, not the foundation of persistence or permission enforcement.

Success means: “Pick up the authentication work on my PC, let the Mac investigate the regression, keep me informed, and stop before deployment” becomes an observable, resumable task with explicit authority, correct computer selection, evidence and a clear final outcome.

### User direction captured

- Build CLI and MCP capabilities around Vocs Code; the user is already pursuing this work.
- Evolve the existing Vesta assistant toward conversational, proactive personal assistance.
- Orchestrate sessions and eventually multiple computers, rather than pretending one giant chat is the entire system.
- Reuse universal Vocs Login and the MCP Hub; keep identity separate from grants.
- Preserve a hybrid option: an always-available cloud coordinator and local execution on user computers.
- Let Voxy communicate with the assistant; evaluate both MCP and A2A without requiring both initially.
- Use a comprehensive plan for a different Vocs Code session to take over implementation.
- Make status explicit: what the assistant is doing, what the user must do, what needs approval, and what is merely suggested.

### Non-goals for the first release

No universal remote shell, unrestricted IPC proxy, arbitrary autonomous purchases, default deployment permission, multi-tenant agent marketplace, general mobile app, new coding harness, cross-agent credential sharing, or production A2A dependency. Do not rewrite working Mission or SessionManager functionality merely to give it a new name.

## 2. Evidence and existing boundaries

The following files were retrieved from the repository default branch, reported by GitHub as `develop`, on 18 November 2026. Search results identified snapshot `11f9cd31336e83b57826d334f2dbe632a10823da`; subsequent file reads were branch reads, not an assertion that the branch remained frozen. Revalidate these facts against the implementation checkout and production independently.

| Evidence | Verified source fact | Consequence |
| --- | --- | --- |
| [VESTA.md](VESTA.md), blob `49bd65ba6d4d81c4d6315c1d108b6a5bb3029e0a` | P0 assistant uses pi RPC with app capability bridge; transcript is in-memory; no built-in shell/filesystem/network tools; `agent:*` blocked on WebSocket | Evolve runtime and storage; do not claim a remote assistant endpoint exists |
| `src/shared/agent-manifest.ts`, blob `3486ee74dea1047e7e4ab2a04f77aa1173f82f77` | App capability allowlist defines schema, risk, request mapping and result projection | Reuse narrow capabilities; do not expose `registry.invoke` |
| [CONTROL-MCP.md](CONTROL-MCP.md), blob `4de4a41b8305708e236e2ea46a2eecdb5941f80f` | Typed remote tools and desktop grants exist in an implementation slice documented as disabled/unreleased | Source existence is not live availability; qualify actual clients and two computers |
| [CONTROL-MCP-PLAN.md](CONTROL-MCP-PLAN.md), blob `a86231073ab2f120fd35808b6b639f0442318bb8` | Remote HTTPS MCP is first; local CLI/stdio/Missions follow separately | This roadmap expands the destination; it does not silently enable unfinished work |
| `MISSION-STATUS.md` (since removed with the Mission feature), blob `28857ccc8da2724dc70bd3c24ee26b68d8bf3352` | Missions experimental, Windows/Pi and Claude test limitations; no passed live demonstration recorded; macOS/Linux Mission support absent | Ordinary-session multi-machine support must not imply cross-platform Mission support |
| [AGENTS.md](../AGENTS.md) | One normalized SessionEvent stream; development gates and high-risk coverage rules | Preserve harness abstraction and repository verification rules |

Current remote tool names include `computers_list`, `capabilities`, `projects_list`, `sessions_list`, `sessions_get`, `sessions_transcript`, `windows_create`, `sessions_create`, `sessions_send`, `operations_get`, and `operations_interrupt`. Existing grants bind account/controller, host instance, project, action, expiry, harness and permission mode. Current remote slice excludes Mission, raw filesystem, terminal, secrets, attachments and generic invoke. Questions and approvals are owner-only.

Current Vesta is an **MCP configurator/consumer-facing app assistant**, not the same thing as Vocs Code's **inbound control MCP server**. MCP Hub supplies external tools; it is not automatically a session orchestrator. Keep these directions distinct in names and documentation.

No production feature flags, deployment versions, provider credentials, Voxy native A2A support or live interoperability were verified for this document. Do not replace those unknowns with assumptions during rollout.

## 3. Architecture: one domain, several adapters

```text
User in Vocs Code                       User in Voxy
        |                                    |
Assistant conversation UI              MCP client / future A2A client
        |                                    |
        +---- Assistant Task Service --------+  delegation mode
        |       durable jobs, memory,
        |       plans, events, notifications
        |                    |
        |                Session/Mission orchestration
        |                    |
CLI ----+---- Typed Control Service <---------+  direct-control MCP mode
                     |
          policy + resource grants + approval gates
                     |
        existing domain handlers / SessionManager / Mission
                     |
              normalized harness adapters
                     |
              selected local computer

Cloud: identity, routing, presence, opt-in task coordination
Local: workspaces, credentials, actual runtime, final execution authority
```

### Responsibility map

| Component | Owns | Must not own |
| --- | --- | --- |
| Vocs Login | user/device/client identity, authentication lifecycle | blanket project or tool permission |
| MCP Hub | external connector catalog, per-user credentials and connector grants | local app session authority |
| Control Service | typed app operations, validation, policy context, receipts | model reasoning or arbitrary IPC forwarding |
| Assistant Task Service | conversation/task state, planning, coordination, reminders | a second copy of harness runtime ownership |
| SessionManager | sessions, harness lifecycle, transcripts and normalized events | global user memory or account authorization |
| Mission | explicitly supported lead/worker workflows and delivery lifecycle | every ordinary assistant chat |
| Cloud coordinator | presence, routing, task scheduling when enabled, status delivery | pretending offline local work has run |
| CLI/MCP/A2A | transport translation and presentation | independent permission rules or task databases |

Use direct typed calls internally. Vesta need not spawn the CLI to control its own application. CLI and MCP should exercise the same domain contract, not duplicate it. A separate process or remote host can use those adapters where an actual transport boundary is needed.

## 4. Two ways Voxy can help

### A. Direct operation

Voxy selects an authorized computer/project, creates or sends to an ordinary session, reads its output and reports back. Voxy owns planning and follow-up. This maps closest to the existing remote MCP slice. Vesta need not be running and there is no extra assistant reasoning loop.

### B. Delegation

Voxy asks Vesta to own an outcome: “Investigate the regression, prepare a fix for review, do not merge.” Vesta creates a durable task, coordinates sessions and returns updates/artifacts. Voxy remains the user's contact but does not micromanage every session. A delegated task must identify its owner, origin, scope and limits; another agent's text is not permission.

Expose these modes as separately named tools and grants. Never silently turn a read or direct command into a long-running autonomous task. Avoid two assistants repeatedly re-planning each other's work: one task owner, bounded delegation depth, correlation IDs, hop limit and explicit return-to-owner rules.

### MCP first, A2A later

MCP can expose asynchronous task submission, status, replies and cancellation; it is not restricted to immediate tiny operations. Build application-owned durable task semantics first. Later an A2A adapter can map agent discovery, task lifecycle, messages and artifacts onto those same semantics using the then-current specification. Do not assume every client supports the same task/streaming extensions or that Voxy currently has a usable A2A client. Demonstrate the actual client before promising connectivity.

## 5. Control service and CLI contract

Introduce or extract a versioned ControlService interface around existing narrow operations. Before extraction, inventory existing manifest, remote methods and handlers; choose one canonical schema source and preserve current risk behavior. A generated tool schema is not a permission grant.

Every invocation carries a server-derived execution context:

```ts
type InvocationContext = {
  accountId: string;
  actor: { type: 'owner-ui' | 'local-cli' | 'controller' | 'assistant'; id: string };
  hostId: string;
  instanceId: string;
  requestId: string;
  taskId?: string;
  delegatedGrantId?: string;
};
```

Never accept actor identity, `owner-ui`, approval state or a broader grant from untrusted tool arguments. Narrow operation parameters separately identify project/session and intended action. Validate canonical filesystem identity at use time and revalidate immediately before side effects.

CLI command names below are proposed, not existing commands:

```sh
vocs computers list --json
vocs projects list --host <id> --json
vocs sessions list --host <id> --project <id> --json
vocs sessions send --host <id> --session <id> --message-file task.txt --intent <key>
vocs assistant ask --conversation <id> --message-file task.txt
vocs tasks show <id> --json
vocs tasks cancel <id> --intent <key>
```

- Human output and stable `--json` schemas; versioned capabilities discovery.
- Separate connection profiles for local and remote. No automatic target substitution.
- Local transport must authenticate/authorize the OS user and use protected socket/pipe permissions. Do not open an unauthenticated localhost HTTP server.
- Follow existing Windows named-pipe and macOS/Linux platform constraints; prove behavior on real target platforms.
- Secrets through secure credential storage, not process arguments or printed environment dumps.
- Standard exit categories: success, invalid request, denied, needs owner action, offline, busy, incompatible version, unknown outcome.
- `--wait` may watch an operation; closing the terminal does not imply cancel. Explicit cancellation is a separate action.
- CLI must not fabricate approval flags such as `--yes` to bypass policy. An approved noninteractive grant can cover exact low-risk actions.

## 6. Persistent assistant runtime

Keep pi as the first assistant runtime adapter to minimize churn; do not require changing provider or adding a runtime dependency. Separate assistant identity/persona, runtime provider, conversation and execution tasks.

### Conversation lifecycle

Persist messages, task references, decision summaries and provenance. Restore history after restart without replaying old tool calls. Reconstruct context from bounded summaries plus relevant source messages; retain original messages for inspection. Context compression cannot change grants or mark work complete.

Provide: new conversation, continue, archive, export, clear history and explicit memory management. A new conversation does not implicitly terminate its tasks. Clearing history must explain whether active task records and audit receipts remain. Never silently delete active evidence.

### Task state machine

```text
accepted -> planning -> running -> verifying -> completed
                 |         |          |
                 +-> waiting_for_user / waiting_for_approval
                 +-> waiting_for_host / blocked / failed
running -> cancel_requested -> cancelled (only after runtime acknowledgment)
restart -> recovering -> running OR blocked/unknown_outcome
```

Distinguish `needs_input` from `needs_authorization`. An agent may answer a delegated ordinary clarification only if explicitly allowed; existing remote owner-only behavior remains the default until a separately reviewed extension. Remote agents can never approve their own proposed expansion of access.

Tasks record desired outcome and completion criteria before execution. For a simple action this can be one sentence. For multi-session work include dependencies, explicit host/project placement, budget, verification and delivery boundary. “Completed” requires an outcome and evidence, not merely an LLM final sentence or child-process exit.

### Personal-assistant behavior

- Answer ordinary questions without starting a coding session.
- Ask a concise question only when missing information changes a consequential choice.
- Acknowledge accepted tasks promptly; show live state and the next actor.
- Remember preferences and decisions with source/time, scope and user-edit controls.
- Suggest relevant next steps without silently executing them.
- Support opt-in triggers and reminders with explicit notification destination, stopping condition and budgets.
- Never say “I am working” when no durable active job exists.

## 7. Data model and storage ownership

Suggested logical entities (choose physical schema after inspecting existing stores):

| Entity | Essential fields |
| --- | --- |
| AssistantProfile | id, owner, displayName, personaVersion, runtimeProfileRef |
| Conversation | id, owner, assistantId, title, storageLocation, timestamps, archiveState |
| Message | id, conversationId, role/origin, contentRef, timestamp, taskRefs, provenance |
| Task | id, owner, originActor, conversationId, objective, criteria, status, version, budget, deadline, policySnapshotRef |
| TaskStep | id, taskId, dependencyIds, host/project/session refs, operationId, state, resultRef |
| TaskEvent | taskId, monotonic sequence, eventId, type, time, payloadRef, actor |
| Artifact | id, taskId, type, producer, host/repository/commit provenance, access scope, checksum |
| ApprovalRequest | id, taskId, canonical action digest, target, expiry, status, owner decision ref |
| DelegationGrant | id, issuer, audience, subject, resource/actions, expiry, parentGrantRef, revocation version |
| NotificationDelivery | taskId, eventId, destinationRef, dedupe key, attempt, delivery state |
| MemoryFact | owner, scope, text, sourceMessageIds, confidence, timestamp, supersededBy |

Store IDs and references rather than duplicating session transcripts into another authoritative store. Existing SessionManager remains authoritative for runtime state; assistant task state records what it requested and observed. Use transactions/version checks for state changes and an outbox for durable event publication. Schema migrations need backup/recovery and forward-compatibility handling.

Default first release: local task/conversation storage, cloud routing metadata only. Opt-in cloud coordinator requires a separate disclosure and retention setting because durable prompts/results are a material change from the existing no-cloud-content-storage controller design. Keep cloud metadata minimal, but acknowledge that titles and summaries may themselves be sensitive. Redact logs and provide retention/deletion semantics for backups too.

## 8. Proposed assistant API

All names below are proposed. Keep existing remote tools backward compatible and namespace new assistant functions clearly.

| Operation | Inputs | Output / rule |
| --- | --- | --- |
| `assistant_conversations_create` | assistantId, optional title, intent key | conversationId; authenticated owner |
| `assistant_tasks_submit` | conversationId, objective, allowed resources/actions, completion criteria, budget, intent key | taskId + accepted receipt; no inferred broader authority |
| `assistant_tasks_get` | taskId | status, next actor, bounded progress, result/artifact refs |
| `assistant_tasks_events` | taskId, cursor, limit | sequenced events + next cursor; access rechecked |
| `assistant_tasks_reply` | taskId, questionId, message, intent key | reply receipt; questions and approvals distinct |
| `assistant_tasks_cancel` | taskId, intent key | cancel_requested receipt, not premature cancelled |
| `assistant_tasks_resume` | taskId, expectedVersion, intent key | revalidated scope and recovery result |
| `assistant_artifacts_get` | artifactId, bounded range | authorized output; no arbitrary path reads |

Example conceptual submission, not a current wire schema:

```json
{
  "conversationId": "conversation-123",
  "objective": "Investigate the login regression and prepare a fix for review",
  "targets": [{"hostId": "pc-1", "projectId": "vocs-code"}],
  "limits": {"merge": false, "deploy": false, "maxConcurrentSessions": 2},
  "completionCriteria": ["Reproduction documented", "Regression test passes", "Diff available"],
  "idempotencyKey": "stable-intent-123"
}
```

The authenticated grant still determines permission; submitted limits may only narrow it. Reject unknown fields instead of ignoring dangerous misunderstandings. Replies include a stable task/operation ID, state, next actor, error code and retry guidance. Pagination limits and content-size ceilings apply everywhere.

## 9. Hybrid cloud and multiple computers

Stage local-first, then cloud-assisted routing, then opt-in cloud reasoning. Do not make a cloud reasoning service prerequisite for desktop usefulness.

Each host advertises authenticated instance identity, protocol version, harness capabilities and approved project handles. Presence is advisory; acceptance requires the chosen host's current connection and grant. Show offline versus incompatible versus unauthorized accurately without leaking another account's inventory.

For each task, pin execution steps to a host and project. Never send a failed PC task to the Mac without an approved placement policy. Workspaces on different computers are not interchangeable just because their folder names match. Cross-host work uses repository commits/branches or explicitly transferred artifacts with checksums. Do not synchronize uncommitted work implicitly.

Only one coordinator holds a task lease at a time. Use fencing generations so an old coordinator cannot resume side effects after failover. Each host independently enforces receipts and scope. An accepted remote operation with a lost acknowledgment is reconciled by ID, not resent with a fresh intent key. If outcome cannot be proven, surface `unknown_outcome` and require investigation.

Offline work defaults to waiting with expiry, not unbounded queued execution. Any future durable queue must be opt-in and recheck grant, workspace identity, budget and task freshness before execution. A cloud scheduler cannot finish local tests while the computer sleeps.

## 10. Authentication, authorization and safety

Use universal Vocs Login for the same user identity. A signed-in app does not inherit all MCP Hub connectors, desktop projects or agent powers. OAuth audiences and scopes must be distinct for Hub consumption, Vocs Code control and assistant delegation.

Use the existing issuer/device-client approach after its actual staging/production qualification. Do not pass browser cookies to desktop agents or copy provider keys into agent prompts. Browser authentication, device authorization and execution grants are three separate layers.

Rules:

1. Effective authority is the intersection of owner grants, caller grants, delegated grants, task limits, current resource state and operation policy.
2. Delegation only narrows authority. Parent/child revocation and expiry must be enforced server-side at use time.
3. Owner-only grant creation and approval controls remain protected from browser IPC, assistants and external controllers as documented today.
4. A capability's risk tier depends on arguments. A stdio MCP probe launches a program and must not be treated as a harmless read.
5. Approval binds exact action, target, material arguments, version and expiry. Changed action needs fresh approval; a cached “yes” is not universal authority.
6. Source code, tool output, external agent messages and retrieved memory are data, not authorization. Preserve origin and defend against prompt injection.
7. Readable transcripts need their own grants. A caller allowed to send a task may not automatically read all history or secrets.
8. Apply resource and rate limits: token/cost budgets where measurable, maximum sessions, wall time, retries and delegation depth. Unknown cost must be reported, not represented as zero.
9. Stop/revoke must prevent new actions promptly and interrupt only the authorized operation. Do not claim already-committed external effects can be undone.
10. Maintain an audit trail of actor, grant, action digest, target, result and approval decision without logging raw credentials or unrestricted message bodies.

Public agent discovery exposes minimal capability metadata only. Authenticate private inventories and artifact reads. Signed or authenticated callback deliveries require replay protection, bounded retry and destination allowlists to prevent SSRF. Protocol support is never a security boundary by itself.

## 11. UX and notifications

Assistant entry point becomes a durable conversation surface, with compact task cards and an optional activity panel. Avoid forcing a full new screen for simple chat. Keep title/name configurable; retain accessible keyboard navigation and reduced-motion support.

Every active card displays: objective, current state, selected computer/project, what finished, what remains, next actor, budget when known and last confirmed update time. Provide inspect session, view evidence, reply, approve (owner only), pause/cancel and retry/recover where valid.

Use four unambiguous message types:

- **Working:** “I’m checking the login regression on Vocs-PC.”
- **Your action needed:** “Open the provider sign-in page on Vocs-PC.”
- **Approval needed:** “Approve pushing this branch to this repository.”
- **Suggestion:** “A useful next step would be a second-device login test. I have not started it.”

Send updates for acceptance, material blockers, owner questions, meaningful milestones and terminal outcomes. Coalesce noisy session events. Durable delivery deduplication must prevent reconnect storms; do not equate notification delivery with the user reading it. Store destination permissions and respect quiet hours, except explicitly agreed urgent conditions. A return artifact is not automatically public or shareable.

## 12. Failure and recovery requirements

| Failure | Required behavior |
| --- | --- |
| App restarts after tool dispatch | Recover receipt; never replay blindly |
| Cloud loses acknowledgment | Query same operation/task ID; stable retry key |
| Host offline or changed instance | Wait/block with accurate state; no silent reassignment |
| Project moved, symlink changed, workspace replaced | Refuse until owner re-enrolls resource |
| Grant expires/revoked mid-task | Stop new work; cancel safe pending work; report partial effects |
| Session busy with user input | Respect existing ownership barrier; do not splice turns |
| Provider/model unavailable | Report blocked; no silent paid-provider fallback |
| Model says complete without tests | Mark awaiting verification or failed criteria |
| User cancels during delivery | Record committed effects and verified stop; no false rollback |
| Event cursor too old | Return explicit resync snapshot and new cursor |
| Artifact deleted or host unreachable | Unavailable with provenance; do not fabricate content |
| Approval expires or task changes | Invalidate stale approval; explain exact changed action |
| Two coordinators recover | Lease/fencing prevents dual side effects |
| Agent-to-agent loop | Hop/budget limits stop recursion and report cause |

## 13. Delivery phases and acceptance gates

### Phase 0: inventory and freeze contracts

- Inspect latest branch, existing pending work and relevant wiki/graph tools before edits. Preserve Vocs-PC work.
- Map Vesta capabilities, remote control methods, Mission operations, session ownership and auth deployment matrix.
- Record actual production versus source state; keep disabled flags disabled.
- Decide canonical schemas and record an ADR for shared ControlService.
- Acceptance: a checked-in capability matrix shows operation, caller, schema, risk, grant, transport and tests; no undocumented raw IPC exposure.

### Phase 1: shared typed service and local CLI

- Extract narrow service boundaries without widening existing gates.
- Add local authenticated CLI transport and discovery/read commands first, then explicitly approved session actions.
- Ensure UI, existing Vesta tools, CLI and remote MCP reach equivalent validation.
- Acceptance: parity tests prove same denial/approval results across adapters; Windows and macOS local connection/authentication tests; no arbitrary channel or path injection; versioned JSON output.

### Phase 2: persistent Vesta and honest status

- Durable conversations, task state, event journal, result links and owner-action cards.
- Start with one ordinary session per task. Restore after restart without automatic side-effect replay.
- Preserve existing pi runtime behavior; no runtime dependency change without repository-required approval.
- Acceptance: create task, close/reopen app, recover history and correct operation state; cancellation waits for acknowledgment; no duplicate sends; completed tasks include evidence.

### Phase 3: direct remote MCP qualification

- Reconcile existing CONTROL-MCP plan with actual implementation instead of rebuilding it.
- Qualify OAuth, consent, grants, retries, revocation and two real computers in staging using an actual supported client.
- Verify Voxy's available connector path; do not assume native A2A or dynamic tool installation.
- Acceptance: Voxy or identified test client can discover only granted resources, send once despite retries, read authorized bounded output, and receive a truthful offline/denied result. Production rollout remains a separate authorized decision.

### Phase 4: delegated assistant tasks over MCP

- Add task submission/status/reply/cancel APIs and durable event delivery.
- Voxy can delegate a bounded outcome to Vesta and obtain result artifacts.
- Acceptance: one external task survives disconnect, asks owner for approval without bypass, and returns the same task on a duplicate submission. Cross-user reads and grant escalation fail.

### Phase 5: multi-session orchestration and Mission adapter

- Add task DAG, budgets, dependency scheduling and independent verification.
- Use ordinary sessions for supported baseline; integrate Mission only for its explicitly supported combinations.
- Acceptance: parallel read-only investigation plus bounded implementation joins into one reviewed outcome; user interaction and cancellation remain responsive; unsupported OS/harness combinations are clearly rejected.

### Phase 6: opt-in cloud continuity and multi-host coordination

- Obtain content-storage/privacy decision before cloud conversation retention.
- Add coordinator leases, durable outbox, host scheduling and artifact transfer policy.
- Acceptance: PC offline/Mac online does not silently move work; planned explicit multi-host task uses both with isolated workspaces; coordinator restart produces no duplicate external side effects.

### Phase 7: A2A adapter

- Pin then-current A2A specification and SDK only after dependency approval; map existing task service rather than create another state machine.
- Add minimal agent discovery, task lifecycle, artifacts, cancellation and authenticated notifications as supported by the chosen client.
- Acceptance: the same task submitted through MCP and observed through A2A has one identity and consistent state; authorization and tenant isolation match; interoperability demonstrated with a named real client/version.

## 14. Test plan and definition of done

Tests should assert user-visible outcomes and security boundaries, not mocked success flags. Follow current [TESTING.md](TESTING.md) and AGENTS.md; current develop guidance calls for typecheck, changed tests and build, with affected E2E and high-risk coverage. Release gates are separate; no claim of live provider validation from scripted tests.

Required suites:

- Schema/contract: unknown methods/fields, invalid targets, version negotiation, bounded pagination.
- Policy: actor spoofing, grant narrowing, stale approval, transcript separation, revocation races, malicious tool output and secret redaction.
- Persistence: crash before/after intent commit, before/after dispatch, before/after receipt, migration failure and replay.
- Concurrency: double-click, duplicate MCP request, reconnect, two coordinators, user versus assistant session ownership.
- UX/E2E: restart, offline, Back/Cancel, repeated submission, waiting-for-user versus approval, accessible task cards and terminal status.
- Multi-host: exact targeting, account isolation, changed instance, moved project and no fallback.
- Runtime: pi real bridge qualification; other harness/Mission support only when independently tested.
- Delivery: notification dedupe, stale cursor resync, artifact permission checks and cleanup.
- Live staging: actual OAuth client, two computers, interrupted network, consent revocation and truthful outcome reconciliation. Paid tests require explicit authorization.

A phase is done only when code, migration, documentation, relevant tests and operational rollback are present; the exact tested commit and client/platform versions are recorded; skipped or unavailable tests are disclosed; and the user can tell what is working versus experimental. Roll back adapters/features behind independent flags; do not downgrade a database without a tested path.

## 15. Work packages and likely code locations

Paths are starting points, not instructions to bypass the repository code graph or create duplicate abstractions.

| Package | Starting locations | Deliverable |
| --- | --- | --- |
| Contract/policy extraction | `src/shared/agent-manifest.ts`, `src/main/agents/tools.ts`, `src/main/handlers.ts`, remote control schemas | canonical typed operations + parity tests |
| Assistant persistence | `src/main/agents/index.ts`, `pi-runtime.ts`, `context.ts`, `src/shared/agent.ts` | task/conversation service and migrations |
| Assistant UI | `src/renderer/src/components/Vesta.tsx` | durable chat, task cards, owner action/status UX |
| CLI | inspect existing command entry points first | protected local transport and versioned commands |
| Remote adapter | `relay/src/control-mcp.ts`, desktop remote control implementation | explicitly scoped assistant task API |
| Cloud ingress/auth | separate `vocs.io` repository and current issuer | reviewed OAuth audience/scopes, staged deployment |
| Hub consumption | separate `mcp-hub` repository | connector grants and per-user credential boundaries |
| Mission integration | `src/main/mission`, mission shared types | supported-platform adapter, not new scheduler ownership |

Each implementation PR should remain independently reviewable. Do not combine service extraction, permission expansion, production deployment and A2A dependency introduction in one PR. Keep protocol adapters thin enough to disable independently.

## 16. Defaults, decisions and takeover checklist

Proceed with these defaults unless implementation evidence contradicts them: name remains configurable Vesta; pi first; local-first persistence; MCP before A2A; one task owner; explicit host selection; no automatic provider fallback; no default cloud transcript storage; no autonomous grant changes; deployment/merge separate from code execution.

Critical decisions to obtain only when their phase is reached:

1. Cloud conversation/content retention and region/retention requirements.
2. Whether Vesta should be a Vocs-Code-focused assistant or also manage general-life connectors. First release stays focused on Vocs Code.
3. Which risky actions may have standing approval, for exactly which projects and destinations.
4. Budget ceilings and whether cloud reasoning uses user-owned provider keys or another explicitly chosen billing model.
5. Which actual external A2A client justifies implementation; branding is not a blocker.

### First implementation session

1. Read AGENTS.md, TESTING.md, VESTA.md, CONTROL-MCP.md, CONTROL-MCP-PLAN.md and current architecture/wiki decisions.
2. Inspect current develop and active work before starting; preserve unrelated uncommitted changes.
3. Mark this document's source facts current/stale; inspect real feature flags only through authorized read paths.
4. Produce Phase 0 capability matrix and ADR, with concrete regression tests for existing approval behavior.
5. Implement the smallest Phase 1 vertical slice: one read operation across existing Vesta and a protected CLI adapter, then one gated write with equivalent denial behavior.
6. Run the repository-required verification and report exact results. Do not activate cloud control, access credentials, spend provider credit or deploy based solely on this plan.

The intended destination is a continuing assistant with dependable execution beneath it. The protocols make it reachable; durable state, scoped authority, honest status and verified outcomes make it useful.
