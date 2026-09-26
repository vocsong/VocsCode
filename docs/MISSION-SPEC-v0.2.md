# /mission - MVP Implementation Specification

**Product:** Vocs Code  
**Version:** 0.2 - implementation baseline for the first testable MVP  
**Date:** 25 September 2026  
**Supersedes:** `VGOAL-SPEC-v0.1.md` and the subsequently superseded proposals in the design conversation  
**Canonical command:** `/mission`  
**Status:** Specification, not an implementation or test report. No application code was changed in preparing this document.

> A Mission is a session in which one T5 principal engineer takes responsibility for an objective, works directly on difficult engineering, dynamically creates specialists, selects their execution presets from five user-configured model tiers, and delivers a verified result under the project's delivery policy.

This document consolidates the user's decisions and supplies the remaining MVP defaults. Implement the defaults without reopening ordinary design questions; revise them after testing. Requirements about authorization, data preservation, truthful verification, and single ownership are not optional performance shortcuts.

## Contents

1. [Decision record and MVP assumptions](#1-decision-record-and-mvp-assumptions)
2. [Product boundaries and terminology](#2-product-boundaries-and-terminology)
3. [Mission entry points and interaction](#3-mission-entry-points-and-interaction)
4. [Session-based user experience](#4-session-based-user-experience)
5. [Presets, five tiers, and the principal engineer](#5-presets-five-tiers-and-the-principal-engineer)
6. [Dynamic agent profiles and routing](#6-dynamic-agent-profiles-and-routing)
7. [Architecture and existing-code integration](#7-architecture-and-existing-code-integration)
8. [Lifecycle, authorization, and state transitions](#8-lifecycle-authorization-and-state-transitions)
9. [Tasks, contracts, and dynamic replanning](#9-tasks-contracts-and-dynamic-replanning)
10. [Agent tools and communication protocol](#10-agent-tools-and-communication-protocol)
11. [Context, memory, and planning artifacts](#11-context-memory-and-planning-artifacts)
12. [Execution drivers and underlying goal loops](#12-execution-drivers-and-underlying-goal-loops)
13. [Scheduling, concurrency, and progress](#13-scheduling-concurrency-and-progress)
14. [Worktrees, candidates, and integration](#14-worktrees-candidates-and-integration)
15. [Verification, review, and completion](#15-verification-review-and-completion)
16. [Project-configured delivery](#16-project-configured-delivery)
17. [Permissions and trust boundaries](#17-permissions-and-trust-boundaries)
18. [Pause, stop, recovery, and retention](#18-pause-stop-recovery-and-retention)
19. [Persistence and reference data contracts](#19-persistence-and-reference-data-contracts)
20. [Analytics and diagnostics](#20-analytics-and-diagnostics)
21. [MVP implementation sequence](#21-mvp-implementation-sequence)
22. [Acceptance tests and release criteria](#22-acceptance-tests-and-release-criteria)
23. [MVP evaluation and later extensions](#23-mvp-evaluation-and-later-extensions)
24. [Implementation-agent handoff](#24-implementation-agent-handoff)
25. [Source review and provenance](#25-source-review-and-provenance)

## 1. Decision record and MVP assumptions

### 1.1 Confirmed product decisions

| ID | Decision |
| --- | --- |
| D01 | The feature is named **Mission**, entered through `/mission`, replacing the earlier `/vgoal` name. |
| D02 | It is a **kind of session in the existing Vocs Code interface**, not a separate application or mandatory dashboard workflow. |
| D03 | There is **exactly one principal engineer per Mission**. It plans, makes decisions, writes difficult code itself, delegates, resolves integration issues, and owns the outcome. It is not merely a dispatcher. |
| D04 | The principal engineer always uses a **T5 / Frontier preset**. One T5 preset is marked as the default principal engineer, with an optional T5-only override at launch. |
| D05 | Users configure **five model tiers, T1 through T5**. Each tier can contain several user-approved presets. |
| D06 | A reusable **preset is harness + model + reasoning effort**. The model references an existing provider/account configuration; credentials are not embedded in the preset. |
| D07 | Agent profiles are **created dynamically by the principal engineer**. Users are not required to preconfigure named roles or map permanent departments to models. |
| D08 | For each generated specialist, the principal engineer selects the appropriate tier and a whole approved preset from that tier. |
| D09 | Users instruct **only the principal engineer**. Worker activity is inspectable, but workers are not directly messageable by the user. |
| D10 | `/mission plan <message>` starts **interactive planning**: investigate, ask questions, clarify details, consolidate the plan, then explicitly ask whether to execute. |
| D11 | `/mission <message>` starts **autonomous execution**: investigate, make reasonable assumptions, plan, implement, verify, and continue until the objective is achieved or a genuine blocker prevents progress. It does not require routine plan approval. |
| D12 | Completion follows the **project-configured delivery policy**, including its verification requirements, target, conditions, and exceptions. |
| D13 | Missions use **automatically managed isolated worktrees**, including isolation for the principal engineer when it writes code and a controlled integration workspace. |
| D14 | Optimize for **quality and time to verified delivery**, not token savings. Use appropriate tiers rather than deliberately underpowered agents or indiscriminate T5 usage. |
| D15 | An underlying `/goal` may be orchestrated where suitable, but Mission behavior must **not depend on native `/goal` existing**. |

### 1.2 Adopted MVP assumptions

These are implementable defaults selected to complete the design. They are not presented as prior user-confirmed choices or benchmark-derived optima.

| ID | Assumption / default | Rationale |
| --- | --- | --- |
| A01 | `/mission` from an ordinary session creates a **new linked Mission session** and opens it. The original remains unchanged. | Clear lifetime and T5 lead configuration without replacing the discussion agent. |
| A02 | **Four concurrent workers per Mission**, excluding its one lead. | A useful initial ceiling, not a target number of agents. |
| A03 | **Ten concurrent agent-turn slots app-wide, including in-flight tools**, including leads; **one heavy verification job app-wide**. | Keeps multiple Missions bounded and local test jobs from fighting each other. Both limits are configurable. |
| A04 | The first release uses **Vocs-managed sessions** for the lead and workers. Native goal/subagent execution drivers are later optimizations. | Delivers arbitrary approved presets without depending on inconsistent native child controls. |
| A05 | Delegation depth is **one**: lead at depth 0, workers at depth 1. Workers cannot spawn further agents. | One accountable team and a comprehensible process tree. |
| A06 | Tier labels start as T1 Routine, T2 Focused, T3 Standard, T4 Advanced, T5 Frontier. IDs/order are fixed; labels/guidance may be edited. | Stable schema without making the illustrative labels a rigid taxonomy. |
| A07 | T1-T4 may be empty. A valid T5 default lead is required. | Useful with a small roster; no setup requirement to subscribe to five model classes. |
| A08 | Global preset/tier configuration is the baseline; projects may override tier membership and the default lead using the same preset library. Missions pin a configuration snapshot. | Reuse without making current behavior change invisibly during execution. |
| A09 | Execution requires a **clean Git baseline** for the MVP. Read-only planning may inspect a dirty checkout, clearly marked as such. | Avoids silently omitting, stashing, committing, or publishing user changes. Dirty-input snapshot automation is deferred. |
| A10 | A crashed/interrupted Mission recovers its records and presents **Resume**; it does not automatically restart mutations when the desktop app opens. | Predictable MVP recovery. Browser/UI reconnection alone does not pause desktop execution. |
| A11 | The lead preset remains fixed for the Mission. Explicit user-selected replacement must remain T5 and is a recorded handover after the old lead is quiescent. No automatic leader downgrade or rotation. | Exactly one accountable principal engineer. |
| A12 | No default cash or token cap. Optional user limits exist; progress and concurrency guards remain mandatory. | Matches the performance-first objective without allowing runaway execution. |
| A13 | When no project delivery endpoint can be resolved, use **verified local commit**, record the fallback, and do not infer publishing or deployment authority. | Safe autonomous default, not a substitute for an existing project policy. |
| A14 | All substantive code receives an independent review before final delivery; reviews may cover coherent batches instead of every tiny edit. | A meaningful quality gate without review bureaucracy. |
| A15 | No automatic worktree deletion in the MVP. Archive and explicit managed cleanup preserve unresolved work. | Simpler recovery and no accidental data loss. |

### 1.3 Superseded proposals

Do not implement these earlier ideas: a permanent role-to-model catalogue; workers with direct user chat; a lead inheriting an arbitrary lower-tier discussion model; planning that only emits a one-shot document; compulsory use of native `/goal`; eight agents as a utilization target; or a separate Mission application area.

`/vgoal` is not a required alias in this MVP. If it has already shipped in the implementation checkout, retain a documented compatibility alias rather than breaking users. No speculative migration is needed when it never existed.

## 2. Product boundaries and terminology

### 2.1 Objective

Deliver the user's actual objective with evidence and the configured delivery action. Do not optimize for agent count, maximum delegation, token consumption, superficial task completion percentages, or endless polishing.

Small Missions can be completed largely by the lead. Complex Missions can use several specialists and parallel work. A difficult specialist can use T5; that does not create a second principal engineer.

### 2.2 Terms

| Term | Meaning |
| --- | --- |
| Mission | One objective, one principal engineer, one coordination record, presented as one session. |
| Lead session | The actual harness session used by the principal engineer. |
| Preset | User-defined harness/model/reasoning execution choice, with a stable ID and revision. |
| Tier | User-configured pool of presets at T1-T5. It is neither a provider effort value nor an agent role. |
| Agent profile | Mission-local specialist definition generated by the lead: purpose, instructions, context needs, permitted tool requests, and selected tier. |
| Worker session | A managed harness session executing an assignment with one selected preset. |
| Task | Versioned outcome, scope, dependencies, and acceptance criteria. |
| Attempt | One execution of a task against identified inputs. A retry has a new attempt ID. |
| Candidate | An immutable submitted code or non-code artifact. It is not automatically accepted. |
| Accepted revision | The exact combined source content currently accepted by the Mission. It may be an immutable tree/snapshot before a policy-compliant commit. |
| Verification evidence | Runtime-captured results bound to a source revision, criterion, command/flow, and environment. |
| Delivery | The project-configured final action after verification, such as local commit, PR, or merge. |

### 2.3 MVP scope

Include both interactive planning and autonomous execution, T5 lead selection, five configurable preset pools, dynamically generated profiles, read-only worker inspection, managed parallel workers, isolated worktrees, structured coordination, integrated verification, project-policy delivery, persistence, pause/stop/resume, and auditable usage.

Exclude unrestricted agent recursion, automatic cross-repository transactions, auto-discovery of the world's best models, statistically learned tier assignment, native-worker control parity across every harness, cloud execution services, mandatory graph visualization, direct worker chat, and deployment orchestration as a generic first-release subsystem.

Do not add a second provider loop or replace the existing coding harnesses. Build an orchestration layer above existing sessions.

## 3. Mission entry points and interaction

### 3.1 Launch from an ordinary session

`/mission <objective>` creates a linked Mission-type session using the configured T5 lead and opens it immediately. Record the source session and transcript cutoff. Preserve the source's messages, provider session, drafts, permission settings, usage ledger, and working directory.

Capture the actual submitted command as user input. The source gets a small link to the created Mission. The Mission gets a source-discussion link and a kickoff brief with retrievable source evidence. The launch is idempotent: a duplicate IPC request or retry must not create another Mission.

A source session with a running turn is not interrupted merely to launch another session. For execution, wait until its relevant workspace is quiescent and the baseline can be established. Starting from a read-only source conversation need not wait for an unrelated read-only task. Never assume a live working tree is a stable snapshot.

Also add **New Session -> Mission** with Autonomous / Plan together choices. Default lead and project settings avoid a compulsory setup wizard after initial configuration.

### 3.2 Autonomous mode

`/mission <objective>` authorizes investigation, planning, and implementation within the objective and existing permissions. The lead:

1. Establishes the objective, available evidence, constraints, baseline, and delivery policy.
2. Makes reasonable scope-bounded assumptions for unspecified choices and records consequential assumptions.
3. Determines which decisions and shared contracts must precede implementation.
4. Works directly or delegates to generated specialists as useful.
5. Replans when discoveries require it, integrates, reviews, verifies, and delivers.

Do not ask routine questions about architecture, model selection, task scheduling, local style, or whether to continue. Prefer existing project conventions and reversible choices. Assumptions are about unspecified choices, not facts that can be inspected, and must not contradict explicit requirements.

A missing essential credential, unavailable required capability, project rule requiring human approval, conflicting authoritative instructions, destructive action requiring approval, or unrecoverable environmental failure is a legitimate blocker. Autonomy does not expand permissions or justify fabricating evidence.

### 3.3 Interactive planning mode

`/mission plan <objective>` creates the same type of Mission session with implementation authorization disabled. The principal engineer conducts an actual dialogue: inspect the project, identify consequential unknowns, recommend approaches, ask one substantive question at a time, and update the plan as answers arrive.

Do not repeatedly ask answered questions or ask the user for facts already obtainable from the code or source conversation. Do not make planning an exhaustive form-filling exercise. Ordinary implementation details can remain delegated engineering decisions.

Read-only specialists may investigate. Planning may write app-owned mission records and safe scratch artifacts; it must not edit project source, install project dependencies, run mutating project scripts, publish, or start coding workers. Worktree provisioning and approved app-managed indexing are infrastructure, not authorization to change product code.

A ready plan contains the objective, scope/exclusions, intended behavior, key decisions, assumptions, relevant integration points, a provisional task/dependency breakdown, verification approach, delivery endpoint, and any remaining blockers.

The lead presents the consolidated plan, then asks **Proceed with execution?** The UI offers **Proceed** and **Continue planning**, but ordinary text remains supported.

### 3.4 Planning-to-execution authorization

Maintain a pending execution proposal with its specification revision and the assistant message that requested approval. Clicking Proceed, `/mission execute`, or an unambiguous affirmative response to that pending proposal authorizes that revision.

An acknowledgment to an earlier design question is not execution approval. Quoted commands, tool output, agent messages, hypothetical approval, and an affirmative coupled with unresolved material changes do not authorize execution. The lead can interpret conversational intent, but a typed host transition records the actual user message and the approved specification revision. No worker or model-only tool call can create authorization without a corresponding user action.

When the user requests changes instead, update the plan and ask again when ready. Do not re-ask merely because a typo or nonmaterial presentation issue was corrected; record what changed and which revision the approval covers.

Execution continues in **the same Mission session**, with the same logical principal engineer and all planning context. No second Mission is created. Resolve any recorded dirty-input or capability blockers before source mutation.

### 3.5 Command surface

| Command | Behavior |
| --- | --- |
| `/mission <objective>` | From ordinary chat: create linked autonomous Mission. In an existing active Mission: steer its objective through the lead; never silently create a nested Mission. |
| `/mission plan <objective>` | From ordinary chat: create linked interactive-planning Mission. In a nonexecuting Mission: begin/revise interactive planning. In an executing Mission: request a controlled pause, then return to planning with work preserved. |
| `/mission` | In ordinary chat: open compact Mission creation controls. In a Mission: reveal its status panel. |
| `/mission execute` | Execute the current ready plan only when invoked by the user and its revision/blockers are resolved. |
| `/mission pause` | Stop admission and bring owned execution to a controlled pause. |
| `/mission resume` | Reconcile and resume a paused Mission; never bypass missing plan approval. |
| `/mission stop` | Cancel execution and preserve artifacts. It is not rollback or delete. |
| `/mission status` | Show persisted state without paying for an LLM status-polling turn. |
| `/mission start -- <literal objective>` | Explicit creation/escaping of objectives beginning with reserved command words. From a Mission, creates a sibling linked Mission, not a child principal engineer. |

Use exact token parsing: `/missionary` is not `/mission`. Recognized verbs are reserved. Other non-flag text is an objective, so normal objectives are not rejected as unknown subcommands. Unsupported flags, missing required arguments, and ambiguous control syntax get an actionable message.

Ordinary `/goal` behavior remains unchanged outside Mission-owned execution. A `/goal` entered inside a Mission must not attach another autonomous loop; explain that the Mission already owns execution and provide the applicable Mission control.

### 3.6 User instruction channel

Only the principal engineer receives user instructions. Worker views have no user-facing composer, steer action, retry-as-user action, or independent publish controls. Route any worker-view **Ask lead about this** action into the Mission composer with the relevant task reference.

Worker decisions and blockers are sent to the lead. Human permission cards may identify the originating worker but are presented in the Mission interface through the existing approval mechanism. Answering a permission card is not a second conversational instruction channel.

The lead sees user corrections promptly at a safe boundary. Material changes create a new specification revision, invalidate affected task inputs, and trigger replanning. No already-running shell operation can be retroactively undone by a message.

## 4. Session-based user experience

### 4.1 Reuse the existing shell

Mission appears alongside normal sessions under the existing project group, with a Mission badge/icon. The main pane remains the conversation with the lead. Keep the current composer, attachments, search, navigation, transcript conventions, and workspace panels where possible. [R8, R9]

Do not introduce a separate top-level application area or require a full-screen graph to use the feature. UI state displays coordination state; it never owns execution or scheduling.

### 4.2 Minimal surfaces

| Surface | Required MVP behavior |
| --- | --- |
| New Session / launch | Choose normal session or Mission; Mission mode; T5-only lead override; concise project defaults. |
| Session header | Mission name, lifecycle state, selected lead preset, Plan together / Autonomous origin, pause/resume/stop. |
| Main conversation | User-to-lead discussion, questions, assumptions, important decisions, compact task events, final report. |
| Mission side panel | Objective, plan, tasks, blockers, delivery target, verification summary. A list/dependency view is sufficient. |
| Agents view | Generated specialists, tier and selected preset, status, assigned task, read-only transcript/results and local diff. |
| Changes/Files | Mission integration result by default, with explicit read-only inspection of an agent workspace. |
| Settings | Preset library, five tier pools, default T5 lead, project overrides, concurrency. |

The existing Goal panel may be replaced contextually by Mission while a Mission session is active. Native subagent controls in ordinary sessions are not globally removed; they must not leak into managed Mission-worker views.

### 4.3 Workspace clarity

The Mission's default Changes panel compares the accepted integration result with its source baseline. Label it **Mission result**. Worker changes are labeled by task/agent and may be incomplete or unaccepted.

The lead's coding tools run in its own worktree, not the integration view's worktree. Make this visible in the Files/Terminal workspace selector. Revealing a path from a lead tool result uses that lead workspace. A terminal must show its actual cwd; default an interactive lead terminal to the lead workspace, not a writable integration target.

Existing Revert/Commit controls must respect Mission ownership. Do not let a UI control reset files beneath a live worker or mutate the accepted integration revision outside the integration service. Require pause/reconciliation or a lead-mediated change; enforce this in main-process handlers, not only by hiding buttons.

### 4.4 Session compatibility and lifecycle

Mission search includes lead conversation and references to task artifacts; worker transcripts remain searchable without appearing as unrelated top-level sessions. Existing sidebar keyboard navigation and archive behavior must remain correct.

One Mission entry owns its children for archive/delete/stop semantics. Do not allow generic child deletion to leave an untracked running process. Forking a Mission must create a new discussion/Mission input record, not duplicate live attempts or pending operations. MVP may disable generic fork/rewind on active Missions with a clear reason. It must not present ordinary transcript rewind as rollback of worker effects.

### 4.5 Notifications and status

Aggregate routine worker completion notifications. Surface an actionable human approval, interactive planning question, actual blocker, or final delivery result. Prefer milestones and accepted/evidence-backed counts; do not claim that 8 of 10 tasks means 80% complete.

Read-only remote viewers may inspect only what existing policy permits. New Mission mutating handlers must inherit the current authorization checks; exposing a new IPC handler must not accidentally grant write access to a view-only client.

## 5. Presets, five tiers, and the principal engineer

### 5.1 Preset definition

A preset contains a stable ID, revision, display name, harness reference, model reference, reasoning selection, enabled flag, and optional selection guidance. The model reference includes the existing provider/connection identity so two endpoints exposing the same model are not conflated.

Reasoning selection is either **provider/runtime default** or an **explicit supported effort value**. Default does not mean disabled reasoning. A model/harness that does not expose a selectable effort may use only Default. Never synthesize provider-specific values by translating T5 into `max` or T1 into `low`.

A preset does not contain task prompts, owned files, permanent role instructions, or elevated permissions. Existing account/secret and harness-runtime configuration remain the authoritative stores. A preset references them, rather than copying keys or modifying global settings.

A selected preset is atomic: the lead cannot choose it and silently replace its harness, model, effort, provider connection, or billing path.

### 5.2 Fixed tiers

| ID | Initial label | Routing guidance, not hard-coded role membership |
| --- | --- | --- |
| T5 | Frontier | Hardest uncertainty, principal engineering, complex architecture, critical failure diagnosis, adversarial review. |
| T4 | Advanced | Complex cross-module implementation, substantial debugging, performance work, nuanced review. |
| T3 | Standard | Normal autonomous feature implementation against a reasonably clear contract. |
| T2 | Focused | Bounded low-ambiguity implementation, explicit test cases, established UI patterns. |
| T1 | Routine | Mechanical edits, prescribed evidence collection, formatting, repetitive fixtures. |

All five slots exist. T1-T4 can be empty and must be shown as unavailable pools, not silently filled. A user can assign the same model to different tiers through different effort presets. A preset may be referenced by more than one tier, but the UI should flag that overlapping membership does not create a capability difference.

No automated benchmarking or model ranking is required. The labels reflect user-configured availability, not a guarantee of measured superiority across providers. The lead receives optional user guidance and current eligibility information.

### 5.3 Default principal engineer

Keep one authoritative `defaultLeadPresetId` in the resolved configuration. Render **Default principal engineer** as a flag on that preset in T5; do not persist several independent booleans that can disagree.

The default must reference an enabled, T5-member, lead-capable preset. Removing it from T5 or deleting it requires selecting another default or leaves Mission launch explicitly unconfigured. Do not silently choose the alphabetically first T5 entry.

A launch override may reference only another eligible T5 preset. A lower-tier source discussion never determines the lead. T5 specialists are permitted but have no lead authority.

### 5.4 Configuration layers and edits

Resolution order for ordinary defaults is global configuration -> project overrides -> explicit Mission launch selection. Project provider/permission restrictions are constraints, not overrides a launch can widen.

Persist the resolved tier memberships, preset revisions, selected lead, limits, and relevant policies as a Mission configuration snapshot. New settings normally affect new Missions. An explicit **Apply updated configuration** action for an existing Mission changes future dispatch after validation and records a new snapshot; it does not mutate active requests.

Security revocation, disabled credentials, unavailable accounts, and removal of a provider from the project's permitted set are checked live. A historical snapshot cannot authorize new work after revocation. Active calls are interrupted where supported; do not promise remote data already sent can be recalled.

### 5.5 Capability validation

Validate preset structure when saving, probe available runtime/model capabilities when possible, and revalidate the actual combination before dispatch. Distinguish Configured, Available, Unverified, Unsupported, and Unavailable. An offline catalog entry alone is not proof that a live runtime accepts the combination.

Required validation includes runtime presence, model/provider availability, supported reasoning selection, project permission/data rules, required tools, control protocol, worktree cwd support, and usable completion/cancellation observation. A lead additionally requires the Mission tool surface and verified suppression/ownership of competing delegation loops.

Record requested and effective model/effort when reported. A mismatch produces visible diagnostic state and cannot silently count as preset adherence. Unknown effective values remain unknown. A known incompatible substitution blocks that attempt or requires a new approved choice.

No automatic switch from subscription credentials to separately billed API access. Account routing is part of the existing configured connection and must remain visible where determinable.

## 6. Dynamic agent profiles and routing

### 6.1 The lead invents the specialists

A generated profile describes a mission-local responsibility, not a permanent department. Examples include cancellation-race investigator, spreadsheet-export implementer, accessibility challenger, or migration documentation editor. These names are examples only; no enumerated catalogue should limit them.

Minimum profile content: ID/revision, name, purpose, operating instructions, selected tier, relevant context references, requested tool subset, source-mutation class, and result expectations. Permission ceilings are derived separately by the runtime.

Profiles live in the Mission record. Do not write them automatically into global harness agent directories or tracked repository configuration. Optional export/reuse after the MVP is not needed for execution.

### 6.2 Profile versus task versus attempt

A profile describes how a specialist should approach a class of work. A task identifies a particular required outcome. An attempt binds the task and profile revisions to one selected preset, actual inputs, session, and workspace.

A profile may be reused for successive tasks, but each task must retain its own attempt and evidence. A role name never permanently determines a tier. Revising a profile's tier or instructions creates a new revision; existing attempts preserve their original revision.

Prefer fresh sessions for unrelated tasks and independent reviews. Reuse a worker context only when it remains relevant and its contract/workspace are reconciled. Never rely on profile identity alone to claim review independence.

### 6.3 Selection algorithm

The principal engineer determines the task's semantic difficulty, uncertainty, coupling, risk, modalities, relevant tools, and context needs. It selects a tier, then an eligible preset from that tier, with a short reason.

The runtime validates membership and capability, not semantic architecture. A scheduler does not silently choose another tier because a slot is free. Selection guidance and user preferences influence the lead; cost is not the default ranking objective.

An empty/unavailable tier is visible to the lead. It may explicitly select a different adequate configured tier and record the reason, but cannot invent presets. Lower-tier selection must not silently bypass a user-specified minimum. The lead itself never drops below T5.

### 6.4 Reassignment and consultation

When a worker is stuck, the lead can clarify the contract, consult another specialist, take over directly, alter the approach, or make a recorded new assignment. Different failure classes need different responses; a missing binary is not evidence that a larger model is needed.

A worker may request a specialist consultation, but only the lead creates/dispatches it. The original worker cannot create grandchildren through a native subagent escape hatch.

A difficult review can use another T5 preset for a different perspective. Agreement is not proof and disagreement is not resolved by voting. Require concrete evidence and an accountable lead decision.

### 6.5 Lead direct implementation

The principal engineer can claim a task and code in its own worktree using its fixed T5 preset. This is genuine lead implementation, not mandatory delegation to another instance of itself. Apply the same artifact and verification requirements to lead-authored work.

When worker messages arrive while the lead is coding, queue them in a prioritized mailbox. Do not run a second lead concurrently. Urgent decisions can trigger a supported safe interruption/yield; otherwise deliver at the next suitable turn boundary.

## 7. Architecture and existing-code integration

### 7.1 Ownership split

| Owner | Responsibility |
| --- | --- |
| Principal engineer | Requirements interpretation, assumptions, architecture, task decomposition, generated profiles, tier/preset choices, direct coding, decisions, and acceptance judgment. |
| Mission service | Durable coordination state, command handling, identity/authorization, dependencies, scheduling, messaging, revision checks, completion prerequisites, and recovery. |
| Existing SessionManager | Individual session creation, harness lifecycle, transcripts, normal approvals, event normalization, and persisted session identity. |
| Execution drivers | Start/continue/control one task execution using an existing session/harness; translate actual runtime signals without inventing capabilities. |
| Workspace/integration service | Provision managed worktrees, capture candidates, serialize accepted-revision promotion, preserve source state, and coordinate delivery changes. |
| Verification service | Run authorized checks, capture actual outputs and environment/revision identity, and expose evidence. |
| Renderer | Display state and send user commands through the existing typed transport. No autonomous scheduling or privileged filesystem operations. |

Do not duplicate SessionManager's ownership or put the entire new system inside that class. Add focused subscription and ownership hooks. Mission state references session IDs; it does not independently pretend to know whether a harness is busy.

The reviewed adapter contract says that `send()` resolves when input is accepted, **not** when a turn finishes. Build completion around normalized terminal events and immutable results, not an awaited send promise. [R3]

### 7.2 Suggested module placement

These are proposed locations, not claims that new files already exist. Adapt names to the checkout while preserving the responsibilities.

```text
src/shared/mission.ts                    public types and state/event contracts
src/shared/mission-config.ts             presets, tiers, default resolution, validation
src/main/mission/
  service.ts                            command orchestration and ownership
  state.ts                              pure reducer and state invariants
  store.ts                              mission persistence and journal
  scheduler.ts                          dependency/resource admission
  tools.ts                              scoped model-facing operations
  execution.ts                          managed-session driver
  profiles.ts                           generated profiles and preset resolution
  context.ts                            kickoff packages and source retrieval
  workspaces.ts                         worktree/candidate ownership
  verification.ts                       checks and evidence
  integration.ts                        accepted-revision transitions
  delivery.ts                           resolved project delivery policy
  recovery.ts                           restart reconciliation
src/renderer/src/components/mission/    session-integrated panels and cards
```

Use existing `src/shared/ipc.ts`, `src/main/handlers.ts`, adapter metadata, model catalogs, settings stores, secrets, git utilities, knowledge/history tools, and renderer state instead of inventing parallel registries. Split modules only as implementation complexity warrants.

### 7.3 Session identity versus display identity

Extend session metadata with optional ownership fields such as `missionId`, `missionRole: lead | worker`, and `activeAttemptId`, using a backward-compatible shape. Missing fields mean ordinary sessions.

A Mission session's display row resolves to its lead conversation, but its default Mission-result panels may resolve to the integration workspace. Do not overload a single `cwd` field to claim both workspaces are the lead's actual tool cwd. Use explicit workspace selectors/read models.

Workers remain ordinary managed execution sessions under the hood. Their appearance, controls, and mutating API access are constrained by Mission ownership.

### 7.4 Model-facing tool transport

Expose scoped orchestration operations through the existing tool infrastructure. A built-in, locally scoped MCP bridge is appropriate for compatible harnesses; a direct registered-tool bridge can serve the native loop. Both must call the same application operations and authorization checks.

A lead-capable preset must pass an actual handshake/integration test for these tools. Worker execution support does not imply lead-tool support. The current project documents different MCP and approval capabilities across adapters. [R2]

Do not require another third-party agent framework or database for the MVP. Any new runtime dependency remains subject to the project's dependency policy.

## 8. Lifecycle, authorization, and state transitions

### 8.1 Separate phase, status, and authorization

Persist three distinct concepts:

- **Entry mode:** `interactive_plan` or `autonomous`; records how the Mission began.
- **Phase:** `planning`, `executing`, `verifying`, `delivering`, or `done`.
- **Status:** `created`, `running`, `waiting_for_user`, `awaiting_execution_approval`, `pausing`, `paused`, `recovering`, `blocked`, `stopping`, `stopped`, `completed`, or `failed`.

Execution authorization is a separate record. Autonomous launch supplies authorization within the submitted objective and policy. Interactive launch supplies no implementation authorization until the user's approval is recorded.

Status and phase combinations are validated by the reducer. A blocked worker need not block the entire Mission if useful independent work remains. Keep task blockers separate from overall Mission status.

### 8.2 Interactive flow

```text
created
  -> planning / running
  -> planning / waiting_for_user           (one consequential question)
  -> planning / running                    (answer + investigation)
  -> planning / awaiting_execution_approval
  -> executing / running                   (explicit user approval only)
  -> verifying / running
  -> delivering / running
  -> done / completed
```

The inquiry cycle may repeat. Read-only agents can run during planning. The lead must not create implementation side effects while waiting for approval.

### 8.3 Autonomous flow

```text
created
  -> planning / running                    (investigate + record assumptions)
  -> executing / running                   (no routine approval gate)
  -> verifying / running
  -> executing / running                   (repair when evidence shows a gap)
  -> delivering / running
  -> done / completed
```

The lead can revisit architecture or split tasks without returning to an interactive product questionnaire. Requirements stay bounded by the user's objective and project rules.

### 8.4 Transition constraints

A Mission is not complete because its lead stopped speaking, a task list is checked, or a native goal emitted a success token. `completed` requires the completion predicate in section 15 and actual delivery outcome in section 16.

`resume` reactivates a previously authorized execution after reconciliation. It never converts an unapproved interactive plan into implementation. `stop` is terminal for that run; **Continue as new Mission** can explicitly reuse retained inputs later. `pause` is resumable.

After completion, ordinary questions can be answered without reactivating workers. A new implementation request starts a linked follow-up Mission so the completed evidence and delivery record remain immutable.

### 8.5 Lead loss and handover

If the principal engineer's runtime fails, workers may finish their already-authorized bounded operations, but the runtime must not dispatch new work, accept architectural changes, or deliver without the lead. Persist results and show the Mission's recovery state.

Resume the same configured T5 lead when possible. An explicit user-selected replacement uses another eligible T5 preset and receives the mission ledger, accepted decisions, task state, source links, and unresolved mailbox. The old lead must be quiescent and its control generation revoked before a new one can act. There is never more than one active principal engineer.

## 9. Tasks, contracts, and dynamic replanning

### 9.1 Task contract

Each task has stable identity, contract revision, objective, owned scope, exclusions, dependencies, accepted decisions/shared contracts, base revision, required tools/capabilities, acceptance criteria, verification requirements, and expected result artifacts.

It may be assigned to the lead or to a generated profile. A task and a profile are not interchangeable; identical specialist instructions may be used for different outcomes.

Use scope boundaries that reflect engineering responsibility. File allowlists are useful hints/checks but not a substitute for semantic ownership. Adding a necessary test inside a module normally stays within scope; changing a shared schema, introducing a prohibited dependency, or expanding the feature requires a lead decision.

### 9.2 Dependency graph

Persist tasks and dependency edges in app-owned state. Each edge specifies whether it requires an accepted decision artifact or integrated code. A stopped worker does not satisfy either condition.

A task that consumes code starts from a revision containing the prerequisite's accepted implementation. Once a shared interface/behavior contract is agreed, backend and UI tasks may proceed concurrently against it. Development mocks must be explicit; final verification exercises real integrated behavior.

Reject cycles, missing task references, conflicting revision assumptions, and impossible admission conditions. Prefer coherent feature slices when they reduce handoffs; do not automatically split every task into research/backend/UI/tests/docs departments.

### 9.3 Task and attempt progression

```text
Task:
planned -> ready -> running -> candidate_ready -> accepted -> integrated
                    |                |
                    +-> blocked      +-> changes_requested -> ready

Additional task outcomes: failed, canceled, superseded.
Non-code tasks can satisfy dependencies at accepted without code integration.

Attempt:
created -> starting -> running -> settling -> terminal
Terminal outcome: submitted, partial, failed, interrupted, canceled.
```

The current attempt can submit a result but cannot accept itself. Keep historical attempts for diagnosis. One current active attempt per task in the MVP; speculative competing implementations are deferred.

### 9.4 Dynamic replanning

Plan updates carry the expected plan revision. A relevant shared-decision change identifies affected tasks and marks their inputs stale. Do not rewrite a running task's contract in place.

The lead may allow the worker to stop at a safe boundary, preserve a partial artifact, supersede the attempt, and issue a new task revision. Useful unaffected tasks continue. Old results remain inspectable but cannot automatically satisfy new requirements.

A minor local design choice may be recorded as a decision without changing the mission specification. Material product scope/acceptance changes require a new specification revision with their source: a user instruction or a permitted assumption within the existing objective. The lead may not redefine away an explicit requirement to make completion easier.

## 10. Agent tools and communication protocol

### 10.1 Typed operations

The names below are logical API names. Map them to the existing tool/MCP/IPC naming conventions. All operations return validated structured results and actionable errors.

| Operation | Caller | Effect |
| --- | --- | --- |
| `mission.read` | Lead; scoped worker read | State, applicable objective/decisions, and revisions. Workers receive only relevant state. |
| `mission.plan.update` | Lead | Update versioned plan/tasks and validate dependencies. |
| `mission.question.ask` | Lead in interactive planning | Record one pending question and expose it in the main conversation. |
| `mission.execution.propose` | Lead | Publish a ready plan for user authorization; does not grant authorization. |
| `mission.profile.create/update` | Lead | Create/revise mission-local profile, tier, and requested tool subset. |
| `mission.task.claim` | Lead | Claim direct implementation with an identified attempt. |
| `mission.task.delegate` | Lead | Request an attempt using a generated profile and one eligible preset. |
| `mission.report` | Assigned worker or lead | Submit progress, findings, partial results, blockers, or immutable candidate references. |
| `mission.decision.request` | Worker or lead | Raise a question with evidence and proposed resolution. |
| `mission.decision.resolve` | Lead | Record a decision and identify affected contracts. |
| `mission.context.read` | Mission participant | Retrieve authorized source context or immutable artifacts by reference. |
| `mission.verification.request` | Lead; scoped verifier | Run approved checks and retain actual evidence. |
| `mission.review.submit` | Assigned reviewer | Findings bound to exact candidate and criterion identities. |
| `mission.integration.request` | Lead | Queue integration against an expected accepted revision. |
| `mission.yield` | Lead/worker | End the active turn and wait for named events without polling. |
| `mission.finish.request` | Lead | Ask host to evaluate completion prerequisites and final delivery state. |

User-only operations include create, authorize execution, steer, pause, resume, stop, change applicable configuration, approve a tool action, and explicitly replace the T5 lead. A worker cannot invoke them by supplying a user-like message.

### 10.2 Authentication and revisions

Bind actor, mission, task, attempt, and allowed operations from the session's authenticated local tool connection. A model-supplied `missionId`, filesystem path, or claimed sender is not authorization.

Mutating calls carry an idempotency key and expected revision where relevant. Reject stale generations, task/profile mismatches, duplicate conflicting submissions, and accesses outside the assigned scope. A repeated identical request returns the prior result rather than starting another side effect.

Artifacts are opaque host-generated IDs, not arbitrary paths chosen by the model. Validate real paths, symlinks/junctions, and worktree ownership when resolving filesystem artifacts. Normalize paths through existing platform-safe utilities.

### 10.3 Result protocol

A result has status `candidate`, `blocked`, `partial`, or `failed`, plus task/attempt/contract references, summary, decision refs, artifact refs, evidence refs, and unresolved issues. The host resolves actual changed files, content hashes, base revision, and executed check results.

Treat a natural-language completion as a prompt to request a proper result, not success. Allow one bounded result-format repair turn before returning a protocol failure to the lead. Preserve raw messages for diagnosis.

### 10.4 Mailbox and event handling

All worker communications go through the Mission mailbox to the lead; no direct worker-to-user channel and no uncontrolled worker-to-worker side chat. The lead can relay relevant accepted findings to siblings.

Prioritize user instructions, permission/security blockers, critical-path decision requests, failing integrated verification, and candidate acceptance decisions. Batch routine progress to avoid interrupting every tool call or generating expensive status polls.

The host must track active model turn, pending goal continuation, yielding/waiting state, tool completion, and compaction correctly. A worker waiting for a lead decision is not a failed task; a lead waiting for workers is not idle completion.

### 10.5 Prompt contracts

The lead's mission policy should establish: one accountable principal engineer, T5 preset fixed for itself, dynamic specialists selected from approved tiers, direct coding allowed, explicit assumptions, use of typed tools, source/revision awareness, project delivery policy, no hidden worker chat, and no fabricated completion.

The worker's scoped policy should establish: the assigned profile/task/preset, relevant project rules, owned workspace, no spawning other agents, no independent publishing/merging/deployment, decision escalation to the lead, immutable result/evidence submission, and no user questions.

Append/inject these policies through supported session-scoped mechanisms while preserving existing project instructions. Do not replace useful harness behavior wholesale or modify global harness files to implement temporary assignments.

## 11. Context, memory, and planning artifacts

### 11.1 Mission launch package

The lead receives the original objective, explicit source user instructions, project rules, existing accepted decisions, relevant discussion summary, source message IDs/cutoff, attachment references, repository/base identity, resolved delivery policy, permitted tier/preset roster, and capabilities/limits.

Preserve important requirements and source evidence verbatim where needed; do not rely solely on a lossy summary. Full source conversation and relevant attachments remain retrievable under existing access/data policies. Keep a bounded local source snapshot or durable references that remain usable if the original discussion is archived; do not destroy Mission context when the source UI entry is removed.

A native fork may help only when the actual harness supports it and execution cwd/context are correct. For cross-harness launch, use a deliberate brief plus retrieval. The reviewed fork-context code caps individual items at 1,500 characters and targets 24,000 characters overall; reusing that truncation policy alone would not meet Mission source preservation requirements. [R10]

### 11.2 Worker context

Supply the relevant mission objective, task contract, accepted decisions/interfaces, baseline/code references, profile instructions, exact selected preset, expected evidence, and scope limitations. The worker can request more context rather than being trapped in a short summary.

Do not copy the entire planning conversation into every worker by default. Prioritize source truth and retrieval, not excessive compression or indiscriminate duplication.

### 11.3 Project knowledge

Reuse the project's existing code graph, knowledge wiki, and session-history access. In Vocs Code's reviewed instructions these sources have different authority and freshness, with project rules taking precedence over unsupported inferences. [R1]

A shared index might represent the main branch rather than a worker's current tree. Carry revision/scope information when available and confirm task-critical facts against actual source. Do not claim an impact query includes a worker's uncommitted changes unless it does.

Persist accepted architectural decisions and durable findings through the existing knowledge mechanism where appropriate. Mission scratch status must not pollute the permanent wiki with every temporary thought.

### 11.4 Plan artifacts

Keep the current objective/specification, open questions, answers, assumptions, decisions, acceptance criteria, provisional task graph, and delivery policy in structured state. Produce a readable `plan.md` export from that state on demand; the Markdown file is not the authoritative mutation API.

Track assumptions with ID, rationale, source/context, affected criteria/tasks, and status: assumed, confirmed, superseded, or rejected. Autonomous execution records them without approval friction. User corrections invalidate the corresponding downstream assumptions.

### 11.5 Independent review context

Give reviewers the original criteria, exact code candidate, accepted decisions, and raw evidence. Do not make the implementer's persuasive transcript the only source. The reviewer can inspect it later for explanation.

Fresh context or a different model is not a guarantee of independent errors. Reviews must identify concrete evidence, severity, affected criteria, and a suggested reproduction or check.

## 12. Execution drivers and underlying goal loops

### 12.1 MVP managed execution

The Mission driver creates ordinary harness sessions through SessionManager with mission-scoped metadata, selected preset, workspace, tools, permission ceiling, and context. The harness retains its own model/tool loop.

An ordinary harness turn may already contain many model calls and tool steps. After a normalized completed turn, the Mission driver decides whether a structured result was submitted, a decision is pending, more scoped work is required, or the attempt must fail/stop. It continues with a targeted next instruction only when appropriate.

Do not infer completion from `busy === false` alone, process exit alone, a status of idle, or a successful `send()`. A turn may fail, be interrupted, await approval, compact context, or stop without a valid artifact. [R3-R5]

### 12.2 One continuation owner

Each attempt records `continuationOwner`: `mission`, `app_goal`, `native_goal`, or `native_subagent`. The MVP uses `mission`.

A Mission-owned lead/worker must not simultaneously have independent app-goal timers or native-goal continuation. Reuse tested goal utilities if useful, but centralize ownership. Compaction is also accounted for before dispatching a new continuation.

The current app goal loop recognizes `GOAL_COMPLETE` in assistant text; that existing behavior must not become the Mission acceptance protocol. Preserve ordinary `/goal` compatibility outside managed ownership. [R4, R5]

### 12.3 Optional future drivers

A native `/goal` driver is eligible only when start, outcome/blocker observation, interruption, quiescence, profile application, and recovery behavior are established. Command advertisement alone is insufficient. Do not invent `/goal pause` or `/goal status` syntax across harnesses.

Native subagents may be optimized later when they support the required profile, cwd/isolation, permissions, tools, reporting, cancellation, and usage accounting. The existing Pi subagent documentation explicitly treats worktree isolation and workflow orchestration as separate from its shipped native subagent mechanism. Do not assume those mechanisms already satisfy Mission requirements. [R11]

External SDK documentation demonstrates programmatic subagent definitions, but that does not provide cross-harness control automatically. Integrate only the capability actually supported and tested by the adapter/runtime in use. [E2]

### 12.4 No hidden nested fan-out

Known native delegation tools/extensions must be disabled or routed through Mission-managed admission in scoped sessions. Workers have no permission to create further agents; all specialists are generated and dispatched by the principal engineer.

Do not present prompt instructions as OS enforcement. An arbitrary trusted shell can launch other programs unless the actual sandbox prevents it. The MVP must test suppression of registered native delegation, count owned processes, and disclose its sandbox boundary; it does not claim to contain malicious code under Full access.

### 12.5 Harness support target

Prioritize managed-session integration for **Pi, Claude Agent SDK, and Codex app-server**, using the current adapters. These are implementation targets, not a claim of already verified Mission support.

Deliver the first vertical slice on one supported harness; before calling the product MVP cross-harness, demonstrate a Mission with a T5 lead on one harness and a worker preset on another. Other adapters may be worker-capable, lead-capable, experimental, or unavailable according to actual tests. Configuration presence alone must not advertise support.

## 13. Scheduling, concurrency, and progress

### 13.1 Initial limits

| Setting | Default | Meaning |
| --- | --- | --- |
| `maxConcurrentWorkersPerMission` | 4 | Non-quiescent worker attempts, including their in-flight model/tool work, excluding the lead. Read-only scouts/reviewers count too. |
| `maxConcurrentAgentTurnsGlobal` | 10 | Active harness turns, including in-flight tools, for leads and workers across all Missions. |
| `maxConcurrentHeavyChecksGlobal` | 1 | Heavy builds/test/application jobs admitted through verification. |
| `maxDelegationDepth` | 1 | Lead plus workers; no grandchildren. |
| `maxTaskAttemptsBeforeLeadDiagnosis` | 3 | Full failed attempts before an explicit diagnosis/replan, not edit/test cycles. |
| `progressCheckpointEveryTurns` | 20 | Review progress after this many autonomous completed turns; not an automatic stop when real progress exists. |
| `maxNoProgressCheckpoints` | 3 | Escalate and stop blind continuation when repeated checks show no useful progress. |
| Default financial/time budget | None | User may set a budget; no hidden cost-minimizing routing objective. |

These are tunable assumptions. The runtime enforces app-wide and provider/account limits as well as per-Mission limits. A configured capacity is a ceiling, not a target utilization rate.

### 13.2 Admission

Before an attempt starts, validate dependencies and their revisions, current authorization, profile/preset eligibility, resource capacity, workspace baseline, permission ceiling, and absence of another active attempt owner.

Prioritize critical-path tasks and unblocking decisions. Preserve a lead scheduling opportunity for each admitted Mission; workers must not occupy all capacity indefinitely while waiting for that lead. A new Mission may queue until lead capacity exists rather than oversubscribing.

An agent that yields or waits for a decision can release active capacity only after its current turn and tools have settled, while retaining workspace ownership. A process running a tool, waiting for permission, or otherwise capable of mutation is not quiescent merely because it is not consuming model tokens. Track these states separately.

### 13.3 Verification resource coordination

Workers can run targeted checks within their sandbox and record evidence, but heavy full-suite jobs should use the verification service for admission and capture. Classify project build/test commands and require heavy jobs to use this path; avoid four simultaneous complete Electron builds on the same machine by accident.

Tool hooks can enforce known heavy-command routing where supported. Do not claim complete shell-resource enforcement from a prompt alone. Record limitations and avoid sharing writable build directories or user profiles across verification jobs.

### 13.4 Progress, retries, and availability

Useful progress includes a new verified finding, a resolved decision, a relevant candidate, tests that expose/fix the actual issue, or advancement of a required outcome. Mere text generation or touching a file is not evidence of progress.

Progress detection is evidence-based but not a proof of productivity. The host can identify repeated failures and no artifact/state movement; the lead diagnoses semantic progress at checkpoints. Never restart a failed attempt infinitely by renewing its own budget without a new recorded approach.

After three failed attempts, require lead diagnosis. It may authorize another bounded attempt with a concrete change, take over, or mark a blocker. Repeated no-progress in the lead itself pauses automation with retained evidence rather than spawning another principal engineer.

Honor provider backoff/availability signals. A worker may be explicitly reassigned to another suitable approved preset after the old attempt is reconciled. Do not silently change accounts, billing paths, or model tier. A blocked T5 lead waits or requires explicit T5 handover.

Long reasoning, compaction, long builds, approval waits, and dead processes are different conditions. Do not kill a healthy long operation solely because it has not emitted chat text recently. Show last-known activity and driver-specific uncertainty.

## 14. Worktrees, candidates, and integration

### 14.1 Topology

```text
Original user checkout                      preserved, not a worker workspace
  |
  +-- Mission integration workspace          accepted combined result; serialized mutation
  +-- Principal engineer worktree            direct lead implementation
  +-- Worker attempt worktree A              isolated assigned edits
  +-- Worker attempt worktree B              isolated assigned edits
  +-- Verification scratch/worktree          candidate under test, when needed
```

Provision worktrees and session cwd automatically through existing git/session utilities. Read-only investigations may inspect a fixed snapshot without receiving a writable implementation worktree. For a stable lead session, provision its worktree once and refresh it only at safe boundaries with local work accounted for.

Git worktrees separate working trees while sharing repository administration; they are not security sandboxes. Use Git's worktree operations and path queries rather than assuming every worktree has a `.git` directory. [E1]

Use project-compatible unique branch names, for example `mission/m01-integration`, `mission/m01-lead`, and `mission/m01-t03-a01`. Never create a branch whose name conflicts with another branch's directory prefix. Do not rewrite project integration/release branches.

### 14.2 Source baseline and dirty inputs

For MVP execution, select a clean, existing commit from the source session's actual workspace or an explicit user-selected base. Detect nonignored tracked/untracked changes and ongoing writes before dispatch.

When the source is dirty, do not auto-stash, commit, discard, copy only part of it, or silently use HEAD. Record an actionable baseline blocker. The user can clean/commit the source outside the Mission, explicitly select a clean base, or knowingly choose HEAD with omitted changes clearly listed. This is an input-preservation boundary, not a request to approve ordinary engineering decisions.

Interactive planning can inspect dirty source read-only, but records that its observations may not match the eventual execution base. After a baseline change, revalidate relevant planning assumptions before execution. A non-Git/unborn repository uses the existing initialization flow or remains blocked; no hidden initialization or initial commit.

Automated dirty-overlay capture is a later feature. This restriction must be stated in the UI and release notes, not discovered through lost changes.

### 14.3 Candidate capture

The host captures an immutable patch/tree artifact with base identity, exact changed paths, file modes, content hashes, binary/added/deleted files, and producing attempt. Do not trust a worker-provided `changedPaths` list or claimed Git SHA without checking it.

No code acceptance from a still-mutating directory reference. Capture a stable snapshot or wait for the attempt to settle. If the worker changes content later, it produces another candidate. Preserve failed/partial candidates for diagnosis.

Intermediate accepted content may be represented by a base commit plus an immutable overlay/artifact. This avoids requiring unverified checkpoint commits when the project mandates checks before commits. Child tasks can materialize that recorded accepted content in their own workspace. Commit only when the project's required pre-commit checks have passed.

### 14.4 Integration algorithm

Only the integration service advances the accepted revision:

1. Validate task/profile/attempt/spec revisions and the immutable candidate against its contract.
2. Require targeted verification and required review of the candidate or its assigned batch.
3. Prepare an integration attempt against the expected current accepted revision.
4. Inspect scope and shared-contract conflicts, apply the candidate, and identify actual resulting content.
5. Run required integrated checks. A clean textual merge is not sufficient.
6. On conflict/failure, retain the attempt and send a scoped repair/decision to the lead. Do not indiscriminately choose one side.
7. Promote the resulting immutable revision only if the expected previous accepted revision still matches.
8. Invalidate affected evidence and refresh dependent inputs as needed.

Prepare candidate work in parallel but serialize promotion. Multiple Missions targeting the same repository branch must also serialize/reconcile delivery transitions. A changed target head requires refreshed integration and verification, not a force push.

### 14.5 Lead and worker workspace changes

The lead submits direct coding through the same candidate path. It may resolve integration conflicts by claiming a repair task, but must not edit the integration workspace behind the service's ownership.

Never rebase/reset/update an agent workspace during an active tool call. Capture its local work, stop/yield the owner, and reconcile before refreshing. Out-of-band human edits are detected by fingerprint/working-tree checks; stop conflicting mutation and surface them to the lead, never overwrite them.

### 14.6 Dependencies, builds, and local applications

Use per-workspace writable build output and isolated test state. Shared download caches are acceptable; shared mutable `node_modules`, native build outputs, test databases, Electron userData, or development server ports are not assumed safe.

Reuse existing project bootstrap commands where authorized. Do not copy production credentials into worker trees or let test applications connect to real user data by default. Allocate unique ports, temporary directories, and test profiles. Report missing runtime/platform requirements explicitly.

## 15. Verification, review, and completion

### 15.1 Distinct gates

| Gate | Meaning |
| --- | --- |
| Execution ended | A harness turn/process ended; no quality claim. |
| Candidate submitted | Immutable result and identified evidence are available. |
| Task accepted | Required outcome, checks, and review policy are satisfied. |
| Integrated | Candidate incorporated into the accepted Mission revision. |
| Implementation verified | Mission criteria are satisfied against the final integrated content. |
| Delivered | Configured final action and conditions are actually satisfied. |
| Mission completed | Implementation verified and the resolved delivery policy satisfied, with retained evidence. |

### 15.2 Evidence requirements

Every check record identifies criterion(s), specification/task revision, exact code content identity, actual command or tested user flow, cwd, environment/runtime identity, start/end timestamps, result, exit status, expected/observed tests where applicable, skip counts, logs, and artifact references.

Use `not_run`, `passed`, `failed`, `skipped`, `blocked`, `not_applicable`, and `waived` as distinct outcomes. A requested test suite exiting zero while all relevant tests are skipped or none execute is not verified. A compiler/build check with no test-count concept can legitimately pass; do not apply a blanket nonzero-test rule to every command.

Worker-reported evidence is a pointer or claim until the host captures/verifies the actual result. Screenshots can support behavioral evidence but are not a substitute for an executable correctness test where one is required. Preserve required platform checks that could not run as blocked/unverified, not green.

Bind evidence to content rather than only branch names. Relevant changes to code, requirements, test configuration, dependencies, or environment invalidate prior checks. An identical tree committed under a new SHA can retain content-bound evidence when the policy permits and the environment has not changed.

### 15.3 Review policy

All substantive code receives independent review before final delivery, including lead-authored code. Review a coherent batch or whole candidate when that is more efficient than a reviewer for each trivial edit. A reviewer must not have authored the candidate it is independently evaluating.

Increase depth for permissions, secrets, persistence, cancellation, concurrency, migrations, and lifecycle paths. An independent architecture challenge is optional for a concrete uncertainty, not a ritual required for every Mission.

Findings contain evidence, severity, affected criteria, and reproduction/check guidance. The lead resolves by fixing or rejecting with a documented reason supported by evidence. Required checks/explicit user requirements cannot be removed simply to dismiss a finding.

If the only configured suitable preset is the lead's model, a fresh specialist session can still provide a separate review context. Do not equate model diversity with guaranteed independence, and do not require another provider subscription.

### 15.4 Final verification

Run required project gates on the final integrated revision, plus behavior-specific acceptance checks. Worker tests and candidate reviews do not alone prove the final combined application works. Use real integrations where the requirement calls for them; do not substitute a mock and label it live verification.

In the reviewed Vocs Code project, base gates are `npm run typecheck`, `npm test`, and `npm run build`, with additional affected E2E/live tiers. Reconcile current `AGENTS.md` and `docs/TESTING.md` before implementation. [R1, R7]

Regression work should show the relevant failing behavior before the fix and passing behavior after it when feasible; retain baseline failures distinctly. Do not widen scope to unrelated cleanup merely to make an existing unrelated failure disappear. Diagnose and report it according to project policy.

### 15.5 Completion predicate

`mission.finish.request` may succeed only when:

- Every required outcome maps to valid final evidence or an explicit authorized exception allowed by policy.
- All required tasks are satisfied; canceled/superseded tasks have a recorded reason and are not silently counted as success.
- Mandatory findings and decisions are resolved; no stale result or obsolete contract is accepted.
- No owned writer, queued mutation, hidden continuation, or integration transition can change the delivered result afterward.
- The actual final content matches the verified content, and the resolved delivery action is satisfied.
- The final report distinguishes verified results, authorized exceptions, limitations, and external delivery identifiers.

A policy-mandated review hold can be a satisfied delivery endpoint if the policy explicitly defines it. A failed merge or missing mandatory check is otherwise `delivery blocked` or `verification blocked`, not generic success.

## 16. Project-configured delivery

### 16.1 Resolution

Resolve the project's current delivery rules at Mission start from existing structured project settings when available and repository instructions such as `AGENTS.md` and referenced release/testing documentation. Do not build a conflicting second policy editor if one already exists.

Record the effective endpoint, target repository/branch, required checks, approval/hold conditions, permitted remote actions, source/provenance, and fallback behavior. Explicit user instructions for this Mission can narrow/change its endpoint within authorization. Runtime permissions and provider/repository protections always constrain execution.

If structured settings and authoritative repository instructions materially conflict, record the conflict rather than silently choosing the less restrictive rule. Autonomous mode does not permit inventing authority. If no policy exists, use the documented local-commit fallback in A13 and state it as an assumption.

### 16.2 Endpoints

| Resolved endpoint | Completion condition |
| --- | --- |
| Local commit | Required checks passed; authorized commit exists locally with correct identity and content. |
| Open PR | Required checks passed; intended branch pushed and correct PR exists, ready for the project's review process. |
| Merge PR | Required checks/approvals satisfied; correct PR is merged into the configured target, or an explicit policy-defined hold endpoint applies. |
| Custom authorized workflow | Use an existing project mechanism with explicit scope and evidence; unsupported actions remain an identified blocker, not an invented generic deploy system. |

The current Vocs Code instructions normally require a PR into `develop` and merge after verification, with specified exceptions. Treat those as project rules, not universal behavior hard-coded for every repository. [R1]

### 16.3 One delivery owner

Workers return candidates and evidence. They do not open independent PRs, merge into project targets, release packages, or deploy their pieces merely because the repository's general agent instructions normally say to deliver.

Provide a visible, scoped delegation policy: the principal engineer holds the Mission's delivery responsibility; internal worker completion is not project delivery. This is a division of work, not permission to disregard repository quality or Git identity rules.

Where supported, disable remote-delivery tools for worker sessions. Shell-based restrictions are only as strong as the execution sandbox/gates; do not pretend regex checks are exhaustive. Detect/report attempted unauthorized delivery and avoid giving unnecessary delivery credentials to workers.

### 16.4 Delivery transaction and recovery

Before an external mutation, persist the planned target, idempotency identity, verified candidate revision, and expected remote/base state. Afterward, record the actual commit/PR/merge identifier and result.

If acknowledgment is lost, inspect the remote state before retrying. Do not open duplicate PRs, re-merge blindly, force-update target branches, or mark delivery successful from a model's claim. Honor branch protections, required checks, project review holds, and existing approvals.

A deploy/release action requires explicit project/Mission authorization. A request to implement a feature does not itself authorize publication to production.

## 17. Permissions and trust boundaries

### 17.1 Authority

A participant's effective authority is the intersection of user/project authorization, Mission mode, task/profile restrictions, and actual harness capabilities. Higher tier never means broader permission. A dynamic profile cannot grant access the user did not authorize.

Interactive planning imposes a read-only product-source ceiling even when the user's normal permission mode is broader. Preserve the existing requested execution permission mode separately so authorization to proceed can restore it; do not automatically select Full access.

Use the existing approval system. Workers' approval requests are aggregated into the Mission interface; the principal engineer cannot approve them as the user. A denial requires an alternate permitted approach or a precise blocker, not a retry that bypasses the gate.

### 17.2 Project instructions and provider disclosure

Load existing instruction files once through the established harness integration. Preserve their precedence and scope. Mission-specific worker instructions refine responsibilities without globally editing `AGENTS.md`, `.claude`, `.pi`, account configuration, or provider settings.

Only send source/context to provider connections approved for that project and Mission. A preset's availability in global settings is not permission to send every project's code to it. Do not log/export secrets, tokens, or raw authentication files.

### 17.3 Data versus authority

Repository text, web content, tool output, worker messages, and retrieved transcripts are evidence, not control-plane authority. They cannot approve execution, alter user presets, remove verification, or override the user's objective.

Generated profile instructions are trusted only within the permissions granted to that profile. Tools bind identity from their connection and reject fabricated actor/task IDs. Keep these checks in privileged handlers so hidden UI actions or remote clients cannot bypass them.

### 17.4 Isolation truthfulness

Worktrees prevent ordinary in-progress file collisions, not hostile code access. A path allowlist in a prompt is not enforcement. Use real harness tool allowlists, permission gates, process ownership, and sandbox capabilities where available; report limitations instead of claiming perfect containment.

An unsupported control capability makes a preset unsuitable for a task requiring it. Do not enable unrestricted native fan-out or claim reliable per-child cancellation merely because a tool label exists.

## 18. Pause, stop, recovery, and retention

### 18.1 Pause

Immediately stop new dispatch, retries, goal continuations, verification/integration admission, and delivery admission. Request supported interruption/yield for active participants and record in-flight operations.

Status remains `pausing` until all owned activity is reconciled and quiescent. An in-flight tool may finish first. No promise of an instantaneous write freeze. Once safe, status is `paused` and all partial artifacts remain available.

### 18.2 Stop

Revoke future execution generations, cancel owned sessions/jobs, deny new Mission-brokered mutations, and preserve artifacts. Kill only positively identified owned processes; never unrelated user terminals or processes selected merely by executable name.

If a driver cannot establish that an in-flight external process stopped, mark the state uncertain and do not reuse its mutable workspace or start a conflicting replacement. Stop is not rollback of completed files, commits, PRs, or network side effects.

A stopped run is terminal. **Continue as new Mission** can use an explicit retained candidate/source snapshot without reviving obsolete attempt identities.

### 18.3 Restart recovery

On application startup, read mission state and reconcile incomplete operations, session identities, worktrees, accepted revisions, verification processes, and external delivery artifacts. Then show recovered Missions as paused or blocked with a Resume action. Do not automatically resume mutation in the MVP.

A renderer refresh, remote-browser reconnect, or navigation away from the session does not stop a healthy desktop-owned Mission. Application process exit/sleep handling must not misreport ongoing work as completed; use existing runtime lifecycle signals.

Recovery cases include dispatch intent persisted but spawn acknowledgment missing, result captured but not indexed, integration applied but promotion not recorded, approval pending during crash, provider turn interrupted, and PR created but acknowledgment lost.

Persist intent before an external side effect. Reconcile actual state before retrying. Do not claim exactly-once arbitrary shell/API execution; provide deduplicated app transitions and explicit handling of uncertainty.

### 18.4 Explicit handover and settings changes

Only the user can authorize a new principal-engineer preset. Stop/reconcile the old lead, retain its state, record the new T5 selection, and increment the lead control generation. Old messages cannot mutate the new run.

Worker preset changes occur as new attempts or supported safe reassignment after recording the old outcome. No silent mid-call harness/model changes or retroactive usage attribution.

### 18.5 Retention and cleanup

Keep mission records, plans, selected preset snapshots, evidence, results, and links after completion/stop. Archive does not delete worktrees or child evidence.

Provide explicit **Clean up managed workspaces** after owned activity is quiescent. Verify all needed artifacts are captured, detect dirty/untracked changes, use proper Git worktree removal, and never delete the original checkout. Do not use blanket forced removal to solve a failed cleanup. No automatic cleanup timer in the MVP.

## 19. Persistence and reference data contracts

### 19.1 Storage model

Use a versioned mission journal with serialized writes and periodic atomic snapshots, following the repository's existing persistence conventions. No new database is required. The journal is the committed coordination history; snapshots contain a last-applied sequence and are replayable caches of that history.

A possible layout is:

```text
<userData>/missions/<missionId>/
  snapshot.json
  journal.jsonl
  source/                 kickoff/source references or retained authorized snapshots
  artifacts/              immutable candidates, plans, review outputs
  evidence/               check logs and supporting artifacts
```

Existing session directories own their transcripts, credentials references, and harness resume state. Mission records link to them; they do not duplicate token ledgers or create an independent secret store. Worktrees are stored through the app's existing workspace placement policy, outside the original checkout where appropriate.

Every committed event has schema version, unique ID, sequence, actor, timestamp, expected/current revisions, and relevant payload. Write and flush a dispatch/delivery/integration intent before the corresponding external side effect. A pending operation remains reconcilable even if the acknowledgment was never recorded.

Use one serialized mutation queue per Mission plus appropriate repository/global resource locks. A durable-state write failure stops new mutation admission. Snapshot replacement must be atomic; recovery replays committed events after its sequence. An incomplete final journal line can be reported and recovered safely; ambiguous internal corruption blocks mutation rather than silently skipping ownership-changing events.

### 19.2 Reference contracts

The following TypeScript is a transport-neutral design reference, not a claim about current exported types. Reuse existing `HarnessId`, `ModelRef`, effort types, and runtime validation helpers instead of introducing competing provider registries. Validate incoming data at runtime, not only with TypeScript.

```ts
export type TierId = 1 | 2 | 3 | 4 | 5;
export type Revision = number;

export type ReasoningSelection =
  | { kind: 'default' }
  | { kind: 'explicit'; value: string };

export interface ExecutionPreset {
  id: string;
  revision: Revision;
  name: string;
  harnessId: string;
  runtimeVariantId?: string;
  model: {
    providerId: string;
    modelId: string;
    connectionId?: string;
  };
  reasoning: ReasoningSelection;
  enabled: boolean;
  guidance?: string;
}

export interface ModelTier {
  id: TierId;
  label: string;
  guidance?: string;
  presetIds: string[];
}

export interface ResolvedRoster {
  revision: Revision;
  presets: ExecutionPreset[];
  tiers: ModelTier[]; // Validate exactly one each of 1, 2, 3, 4, 5.
  defaultLeadPresetId: string; // Must be enabled, lead-capable, and in T5.
}

export interface GeneratedAgentProfile {
  id: string;
  revision: Revision;
  missionId: string;
  name: string;
  purpose: string;
  instructions: string;
  tierId: TierId;
  requestedTools: string[];
  sourceAccess: 'read_only' | 'assigned_workspace';
  contextRefs: string[];
  resultExpectations: string;
}

export interface CodeRevisionRef {
  baseCommitSha: string;
  overlayArtifactId?: string;
  contentHash: string; // Host-computed identity of effective source content.
}

export interface ExecutionAuthorization {
  kind: 'autonomous_launch' | 'approved_plan';
  sourceUserActionId: string; // Host-bound message/click/command, never model-invented.
  specificationRevision: Revision;
  recordedAt: string;
}

export type MissionPhase =
  | 'planning' | 'executing' | 'verifying' | 'delivering' | 'done';

export type MissionStatus =
  | 'created' | 'running' | 'waiting_for_user'
  | 'awaiting_execution_approval' | 'pausing' | 'paused'
  | 'recovering' | 'blocked' | 'stopping' | 'stopped'
  | 'completed' | 'failed';

export interface MissionRecord {
  schemaVersion: number;
  id: string;
  revision: Revision;
  projectRoot: string;
  title: string;
  objective: string;
  originSessionId?: string;
  sourceSnapshotId?: string;
  leadSessionId: string;
  leadGeneration: number;
  leadPresetSnapshot: ExecutionPreset;
  configSnapshotId: string;
  entryMode: 'interactive_plan' | 'autonomous';
  phase: MissionPhase;
  status: MissionStatus;
  specificationRevision: Revision;
  planRevision: Revision;
  executionAuthorization?: ExecutionAuthorization;
  baseline?: CodeRevisionRef;
  acceptedRevision?: CodeRevisionRef;
  deliveryPolicySnapshotId: string;
  lastEventSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  required: boolean;
  evidenceKinds: Array<'test' | 'build' | 'review' | 'behavior' | 'delivery'>;
}

export interface MissionTask {
  id: string;
  missionId: string;
  revision: Revision;
  specificationRevision: Revision;
  objective: string;
  scope: string;
  exclusions: string[];
  dependsOn: Array<{
    taskId: string;
    condition: 'accepted_artifact' | 'integrated_code';
  }>;
  decisionRefs: string[];
  sharedContracts: string[];
  criteria: AcceptanceCriterion[];
  verificationPlanRefs: string[];
  assignment:
    | { kind: 'lead' }
    | { kind: 'worker'; profileId: string; profileRevision: Revision };
  status:
    | 'planned' | 'ready' | 'running' | 'candidate_ready'
    | 'changes_requested' | 'accepted' | 'integrated'
    | 'blocked' | 'failed' | 'canceled' | 'superseded';
  currentAttemptId?: string;
}

export interface TaskAttempt {
  id: string;
  missionId: string;
  taskId: string;
  taskRevision: Revision;
  generation: number;
  sessionId: string;
  profileRef?: { id: string; revision: Revision }; // Absent for lead-owned tasks.
  tierId: TierId;
  presetSnapshot: ExecutionPreset;
  sourceRevision: CodeRevisionRef;
  workspaceId: string;
  continuationOwner: 'mission' | 'app_goal' | 'native_goal' | 'native_subagent';
  status: 'created' | 'starting' | 'running' | 'settling' | 'terminal';
  outcome?: 'submitted' | 'partial' | 'failed' | 'interrupted' | 'canceled';
  requestedAt: string;
  endedAt?: string;
}

export interface TaskResult {
  schemaVersion: number;
  taskId: string;
  taskRevision: Revision;
  attemptId: string;
  specificationRevision: Revision;
  status: 'candidate' | 'blocked' | 'partial' | 'failed';
  summary: string;
  artifactIds: string[];
  evidenceIds: string[];
  decisionIds: string[];
  unresolved: Array<{ description: string; blocking: boolean }>;
}

export interface VerificationEvidence {
  id: string;
  missionId: string;
  criterionIds: string[];
  specificationRevision: Revision;
  attemptId?: string;
  sourceRevision: CodeRevisionRef;
  checkKind: 'test' | 'build' | 'review' | 'behavior' | 'delivery';
  commandOrFlow: string;
  environmentRef: string;
  provenance: 'host_executed' | 'verified_runtime' | 'agent_claim';
  result:
    | 'not_run' | 'passed' | 'failed' | 'skipped'
    | 'blocked' | 'not_applicable' | 'waived';
  exitCode?: number;
  executedTests?: number;
  skippedTests?: number;
  artifactIds: string[];
  startedAt?: string;
  endedAt?: string;
  invalidatedBy?: string;
}

export interface PendingOperation {
  id: string;
  idempotencyKey: string;
  missionId: string;
  expectedRevision: Revision;
  kind: 'dispatch' | 'interrupt' | 'capture' | 'verify' | 'integrate' | 'deliver';
  actorRef: string;
  payloadRef: string;
  state: 'intent_recorded' | 'in_flight' | 'reconciling' | 'succeeded' | 'failed';
  resultRef?: string;
}
```

### 19.3 Example configuration fixture

This is a schema illustration with fake models, not a ready-to-run recommendation. The empty tiers demonstrate that users do not need five populated pools. The `codex` harness ID denotes the app-server adapter in the reviewed project; reconcile actual IDs with the implementation checkout. Production serialization should use the existing provider/harness identity types.

```json
{
  "schemaVersion": 1,
  "presets": [
    {
      "id": "frontier-codex",
      "revision": 1,
      "name": "Principal engineer",
      "harnessId": "codex",
      "model": { "providerId": "configured-provider-a", "modelId": "configured-model-a" },
      "reasoning": { "kind": "explicit", "value": "high" },
      "enabled": true
    },
    {
      "id": "frontier-pi",
      "revision": 1,
      "name": "Frontier alternative",
      "harnessId": "pi",
      "model": { "providerId": "configured-provider-b", "modelId": "configured-model-b" },
      "reasoning": { "kind": "explicit", "value": "high" },
      "enabled": true
    },
    {
      "id": "standard-pi",
      "revision": 1,
      "name": "General implementation",
      "harnessId": "pi",
      "model": { "providerId": "configured-provider-c", "modelId": "configured-model-c" },
      "reasoning": { "kind": "default" },
      "enabled": true
    }
  ],
  "tiers": [
    { "id": 1, "label": "Routine", "presetIds": [] },
    { "id": 2, "label": "Focused", "presetIds": [] },
    { "id": 3, "label": "Standard", "presetIds": ["standard-pi"] },
    { "id": 4, "label": "Advanced", "presetIds": [] },
    { "id": 5, "label": "Frontier", "presetIds": ["frontier-codex", "frontier-pi"] }
  ],
  "defaultLeadPresetId": "frontier-codex",
  "limits": {
    "maxConcurrentWorkersPerMission": 4,
    "maxConcurrentAgentTurnsGlobal": 10,
    "maxConcurrentHeavyChecksGlobal": 1,
    "maxDelegationDepth": 1,
    "maxTaskAttemptsBeforeLeadDiagnosis": 3,
    "progressCheckpointEveryTurns": 20,
    "maxNoProgressCheckpoints": 3
  }
}
```

### 19.4 Validation invariants

Enforce exactly five unique tier IDs; valid preset references; one eligible T5 default; valid configured harness/model/effort; positive bounded concurrency settings; worker tier membership at dispatch; immutable attempt snapshots; task/actor ownership; one active lead generation; one active attempt per task; acyclic dependencies; valid state combinations; user-backed implementation authorization; and content-bound evidence before completion.

Historical records must remain readable after a preset is renamed, disabled, or removed from future configuration. Archive snapshot values rather than resolving history against today's mutable settings. Unknown future schema versions must not be executed as if fully understood.

## 20. Analytics and diagnostics

### 20.1 Usage ownership

Retain individual session ledgers as the source for their own spending. Mission usage is a rollup of attributed execution, not an extra charge copied into the lead. Inherited source discussion/history is context, not newly incurred historical usage. The reviewed project already has explicit rules against double-counting fork inheritance. [R2]

Native child usage may already be included in parent totals. Record inclusion/coverage provenance before summing. Deduplicate by execution/call identity where available. Do not add parent-inclusive totals and child totals together.

Distinguish reported monetary cost, estimated API-equivalent cost, included subscription activity, unknown billing, and cached-token usage. Missing dollar telemetry is not zero cost or unlimited quota.

### 20.2 Useful dimensions

Track Mission/task/attempt, generated profile revision, tier, preset revision, harness/runtime, requested/effective model and effort, prompt/tool token usage, model/tool/queue time, retries, provider waits, verification/integration time, accepted findings, user interventions, and delivery status.

Do not log hidden reasoning merely to justify routing. A short observable selection rationale and actual execution metadata are sufficient. Follow existing transcript/privacy settings.

### 20.3 Failure taxonomy

At minimum classify requirement ambiguity, architecture/implementation failure, tool invocation/protocol failure, shell/environment failure, provider/network/rate-limit failure, permission denial, stale state, merge/integration conflict, invalid verification, and persistence/recovery failure.

This taxonomy should guide diagnosis and evaluation; do not count every missing executable as a weak coding-model result.

### 20.4 User-facing summary

Show the objective, actual delivery result, verification summary, significant assumptions/decisions, unresolved limitations, source/delivery links, and optional usage/timing breakdown. Do not produce a transcript-length narrative or declare success solely from the lead's confidence.

## 21. MVP implementation sequence

Build vertical slices; do not require a large orchestration framework before one Mission can complete. All phases preserve ordinary sessions and current `/goal` behavior. Numeric defaults and UI wording may change after testing, but the confirmed product decisions in section 1 remain the baseline.

### Phase 1 - Configuration and session identity

Implement reusable presets, five tier pools, project resolution, T5 default lead selection, compatibility validation, immutable snapshots, Mission ownership metadata, and the New Session / `/mission` launch path.

Use the existing model catalog, settings, provider secrets, and sidebar. Test missing T5, invalid effort, unavailable harness, duplicate creation requests, ordinary-session compatibility, and source-context links.

**Exit:** A Mission opens as a session with the chosen T5 lead and resolved configuration, without changing the source discussion.

### Phase 2 - Principal engineer and interactive planning

Implement the scoped lead tools, mission record/reducer, source context access, planning artifacts, one-question interaction, pending execution proposal, and user-backed authorization transition. Add autonomous mode with recorded assumptions and no routine plan gate.

Persist before model-driven transitions can dispatch source mutations. Enforce planning read-only behavior and prevent another ordinary goal loop from attaching to the lead.

**Exit:** `/mission plan` collaborates and waits for explicit execution authorization; `/mission` progresses through internal planning without that wait. Both survive application restart as recoverable sessions.

### Phase 3 - One generated worker and direct lead coding

Add dynamic profile generation, tier/preset choice, one managed worker driver, typed results/decisions, task contracts, lead-owned implementation tasks, separate writer worktrees, candidate capture, and targeted verification.

No fixed role catalogue, no native worker fan-out, and no worker composer. Use scripted/fake adapters with the real service/session store for deterministic tests, then a real supported harness for the first live flow.

**Exit:** The lead can implement one task directly and delegate another to a generated specialist with an exact user-approved preset.

### Phase 4 - Controlled parallelism and integration

Add dependency/resource admission, the four-worker default, global limits, prioritized lead mailbox, versioned replanning, integration attempts, expected-head checks, and final combined verification. Make candidate/workspace state visible in the existing panels.

**Exit:** At least two independent workers genuinely overlap in a test Mission, their results integrate safely, and shared-contract conflicts are handled through the lead. Demonstrate a worker using a different supported harness from the lead before claiming cross-harness Mission support.

### Phase 5 - Review, delivery, and failure recovery

Add independent review, final evidence mapping, project delivery policy resolution, local/PR/merge endpoints where authorized, pause/stop semantics, process/worktree reconciliation, and recovery of uncertain dispatch/integration/delivery operations.

Record exact external identifiers. Support explicit retention/cleanup without deleting original user work. Add the minimum diagnostics and usage rollup needed to inspect a real run.

**Exit:** A realistic Mission reaches its configured verified delivery endpoint; injected crashes do not cause duplicate workers, repeated patches, or duplicate PR creation.

### Phase 6 - MVP usability and capability certification

Complete UI/E2E coverage, keyboard/sidebar integration, read-only remote policy where applicable, current documentation, and real harness smoke tests for advertised combinations. Label unsupported/unverified combinations clearly.

**Exit:** The release criteria in section 22 pass for the advertised support set. A first usable MVP does not wait for native `/goal` or native subagent optimizations.

## 22. Acceptance tests and release criteria

### 22.1 Base test strategy

Use the real Mission reducer/service/store and SessionManager with scripted/fake adapters for deterministic lifecycle tests. Use real temporary Git repositories and worktrees for source/integration behavior. Exercise actual registered handlers to test authorization, not only helper functions. Use isolated Electron/browser data for UI/E2E.

Run current project base gates and all affected required suites. Add live smoke for each advertised lead/worker driver configuration. Missing credentials, platforms, or runtimes are reported as unverified; do not stub a requested live suite into passing. Current repository guidance explicitly distinguishes these tiers. [R7]

### 22.2 Product acceptance matrix

| Test ID | Scenario | Required result |
| --- | --- | --- |
| P01 | Launch `/mission` from a lower-tier normal session. | New linked Mission opens with configured T5 lead; original session and ledger unchanged. |
| P02 | Create directly through New Session. | Same Mission type, modes, defaults, and validation as command launch. |
| P03 | `/missionary`, reserved words, literal escape, invalid flags. | Exact routing; no accidental Mission or native command forwarding. |
| P04 | Launch with no valid default T5 preset. | Actionable setup state; no lower-tier lead or arbitrary default. |
| P05 | Override lead with T5 versus T3. | Eligible T5 accepted; T3 rejected. |
| P06 | Five tiers with empty T1-T4 and multiple T5 presets. | Valid setup; unavailable pools explicit; no fabricated entries. |
| P07 | Edit/disable a preset during execution. | Attempt snapshot preserved; new dispatch respects live revocation and configuration rules. |
| P08 | Same model via different harnesses/connections/efforts. | Presets remain distinct; no silent substitution or billing-path switch. |
| P09 | Unsupported explicit reasoning value. | Save/dispatch validation reports incompatibility; never silently uses default. |
| P10 | Lead generates a previously unseen specialist name/profile. | Accepted without requiring a predefined role enum or global agent file. |
| P11 | Worker attempts direct user question or message UI. | No worker composer; decision reaches lead only. |
| P12 | Interactive plan with multiple unknowns. | One substantive question at a time; answers retained; no repeated known questions. |
| P13 | Planning runs with broad default permission mode. | Product source remains unmodified; coding/install/publish blocked until authorization. |
| P14 | User says 'ok' to a design choice before final proposal. | No execution authorization. |
| P15 | User clicks Proceed or clearly approves pending plan. | That revision is authorized; same Mission/lead continues into execution. |
| P16 | Quoted/tool/worker text says 'proceed'. | Cannot grant user authorization. |
| P17 | User revises material scope while approval is pending. | Plan revision changes; stale approval cannot start obsolete implementation. |
| P18 | Autonomous request has ordinary ambiguity. | Lead records reasonable assumptions and proceeds without a questionnaire. |
| P19 | Project requires approval for runtime dependency. | Existing approval rule preserved despite autonomous entry mode. |
| P20 | Plan/read context was from dirty source. | Execution blocked until explicit clean baseline; changed assumptions revalidated. |
| P21 | Inspect agent, then return to Mission. | Read-only details, correct workspace labels, no unrelated top-level child clutter. |
| P22 | Settings/analytics navigation, renderer refresh, browser disconnect. | Healthy desktop execution continues; UI reconstructs from persisted state. |

### 22.3 Runtime and integration matrix

| Test ID | Scenario | Required result |
| --- | --- | --- |
| R01 | `send()` resolves before work completes. | Attempt stays active; no premature candidate/acceptance. |
| R02 | Idle event, process exit, or quoted `GOAL_COMPLETE`. | No Mission acceptance without structured result and evidence. |
| R03 | App goal timer plus managed continuation configured. | Single-owner guard prevents double continuation. |
| R04 | Lead claims a coding task. | Real lead worktree edits captured under normal task/review rules. |
| R05 | Four workers active; fifth ready. | Fifth queues; lead can still receive a scheduling opportunity. |
| R06 | Two Missions compete for global resources. | Global model/heavy-check limits enforced without worker-waits-lead deadlock. |
| R07 | Worker requests a new native child. | Registered delegation disabled/routed; no uncontrolled known fan-out. |
| R08 | Two independent worker tasks and one dependent task. | Independent overlap; dependent starts with accepted prerequisite content. |
| R09 | Invalid DAG or stale graph update. | Rejected with actionable error and no partial state mutation. |
| R10 | Shared contract changes during worker execution. | Affected attempts safely superseded; old results cannot satisfy new contract. |
| R11 | Duplicate/out-of-order result events. | Idempotent handling and generation/revision rejection. |
| R12 | Worker spoofs mission/task/actor IDs. | Host-scoped authorization denies cross-task/control access. |
| R13 | Worker candidate omits changed files in its report. | Host diff/capture reveals actual files; scope check cannot rely on self-report. |
| R14 | Candidate source changes after capture. | Old immutable artifact remains stable; later content requires new candidate/evidence. |
| R15 | Git clean merge introduces behavioral incompatibility. | Integrated verification/review can reject it. |
| R16 | Accepted revision changes during candidate promotion. | Expected-head guard prevents stale promotion and forces revalidation. |
| R17 | Lead/worker active while workspace refresh requested. | No rebase/reset under active tool; safe ownership boundary enforced. |
| R18 | User edits managed source externally. | Detect drift, preserve changes, pause conflicting mutation, notify lead. |
| R19 | Non-Git, unborn, or dirty source. | No silent initialization/stash/reset/HEAD omission; actionable baseline state. |
| R20 | Build/test workers need ports and app data. | Isolated state and explicit resource allocation; no live-user profile collision. |
| R21 | Heavy checks requested by several workers. | Known heavy jobs queue through verification; observed limits accurately reported. |
| R22 | Native `/goal` advertised without reliable control. | Managed fallback or unsupported status; no invented native command semantics. |
| R23 | Requested preset differs from effective runtime config. | Visible mismatch/eligibility handling; no false claim that configured preset ran. |
| R24 | Provider limit versus missing binary versus logic failure. | Different classifications and appropriate recovery; no blind model upgrade. |

### 22.4 Verification, delivery, and recovery matrix

| Test ID | Scenario | Required result |
| --- | --- | --- |
| V01 | Worker claims tests passed with no real evidence. | Claim not treated as verified execution. |
| V02 | Requested suite exits zero with all tests skipped. | Required criterion remains unverified. |
| V03 | Build succeeds and has no test count. | Valid build evidence; not incorrectly failed for zero tests. |
| V04 | Final content changes after successful checks. | Relevant evidence invalidated and rerun before delivery. |
| V05 | Lead authors substantive code. | Independent reviewer required before final delivery. |
| V06 | Reviewer findings conflict. | Lead resolves against evidence, not model vote count. |
| V07 | Required live/platform check unavailable. | Explicit verification blocker/authorized exception, never fabricated pass. |
| V08 | Worker follows repository instruction to open/merge PR. | Scoped responsibility prevents independent delivery; attempt reported if violated. |
| V09 | Local, PR, and merge delivery policies. | Correct endpoint and evidence for each; no hard-coded `develop` for all projects. |
| V10 | Project-defined sensitive-change review hold. | PR left open with explicit policy outcome; not falsely labeled merged. |
| V11 | No delivery policy resolved. | Recorded local-commit assumption; no automatic publish/deploy. |
| V12 | Remote target advances before delivery. | Refresh/integrate/reverify; no forced rewrite. |
| V13 | Pause during compaction, tool call, or queued continuation. | New admission stops; pausing until reconciled; no later stray continuation. |
| V14 | Stop while an owned process remains uncertain. | Uncertainty retained; no replacement writer reuses its mutable state. |
| V15 | Stop with unrelated user terminal running. | Only positively owned processes affected. |
| V16 | Crash after dispatch intent, before/after acknowledgment. | Reconcile session/process identity; no duplicate active attempt. |
| V17 | Crash during candidate capture or integration. | Partial operation recovered without double-apply or accepted-state drift. |
| V18 | Crash after PR creation/merge, before recording result. | Inspect existing remote artifact before retry; no duplicate PR or false merge. |
| V19 | App restart with active/pending Mission. | Records restored; execution paused until Resume; unapproved plan stays unapproved. |
| V20 | Journal/snapshot write failure or corrupt tail. | Safe recovery or explicit mutation block, never silent state loss. |
| V21 | Native child usage already included in parent. | No parent/child double-counting; unknown billing remains unknown. |
| V22 | Source discussion archived/deleted from sidebar. | Mission's authorized source snapshot/references remain sufficient. |
| V23 | Active Mission generic rewind/fork/revert/delete controls. | No false rollback, cloned live operations, or orphan processes. |
| V24 | View-only remote client invokes new mutating Mission handler. | Authorization denies the operation in the host. |
| V25 | Completion requested while worker/continuation can still write. | Completion refused until owned mutation is quiescent. |
| V26 | Worktree cleanup with dirty/untracked uncaptured files. | Preserve state; no force-delete or original-checkout removal. |

### 22.5 End-to-end demonstration Missions

Use disposable repositories and approved live provider access for these demonstrations:

**Demo A - plan together:** Start from a normal session; launch an interactive Mission; ask/answer two material questions; use a read-only scout; present the plan; approve it; implement; independently review; verify; finish at a local commit. Prove there were no project-source writes before authorization.

**Demo B - autonomous parallel feature:** Start a self-contained multi-part feature. The principal engineer records assumptions, claims a difficult core task, dynamically creates two specialists using eligible presets, runs independent workers in separate worktrees, integrates, verifies the real combined behavior, and follows project delivery policy. At least one worker uses a different supported harness from the lead for the cross-harness claim.

**Demo C - failure and recovery:** Interrupt a worker, inject an integration conflict, and restart the app during a recorded pending operation. Inspect retained state, Resume explicitly, reconcile without duplicate execution, resolve through the lead, and deliver or report the actual blocker.

### 22.6 MVP release definition

The MVP is ready for user testing when these demonstrations and the applicable deterministic/UI tests pass on the advertised support set, ordinary session behavior remains intact, and limitations are visible. It does not require all seven harnesses, automatic tier benchmarking, nested teams, or native-goal optimization.

A release report names the tested harness/runtime/platform combinations and any skipped/unavailable required tiers. Do not imply production-grade cross-platform coverage from a single local run.

## 23. MVP evaluation and later extensions

### 23.1 Measure outcomes, not activity

Run representative tasks from reproducible baselines: a small fix, scoped feature, UI behavior, cross-module change, persistence/cancellation bug, and a task with independent implementation scopes. Compare a strong solo baseline with the same Mission system at one worker and then the default parallel configuration.

Measure objective satisfaction, defects discovered after acceptance, time to verified delivery, human corrections, review findings, retry/rework rates, integration failures, lost-context questions, effective preset adherence, peak concurrency, and resource/usage totals. Report uncertainty and run-to-run variation.

Do not claim that five tiers or four workers are optimal without evidence. Do not demote a preset globally based on one failed environment command. User preferences and approved availability remain authoritative while data informs suggested configuration changes.

### 23.2 First tuning candidates

Tune worker concurrency and heavy-job admission, task size, lead interruption/yield behavior, when to review batches, escalation thresholds, context package size, and the practical separation between adjacent tiers. These can change without changing the core product model.

Observe whether T2/T3 or T4/T5 pools are meaningfully different for a user's roster. Keeping five configuration slots does not require manufacturing differences where their presets are identical.

### 23.3 Deferred extensions

Native `/goal` and subagent drivers; explicit bounded nested teams; safe automated dirty-source snapshots; auto-resume policy after proven recovery; optional worktree retention timers; reusable/exported agent templates; richer graph UI; multi-repository Missions; learned routing suggestions; performance-aware provider selection; richer project deployment workflows; speculative parallel alternatives with a single selected result.

None is required before the first MVP can complete useful Missions. They must not undermine single-lead accountability, approved preset selection, explicit user authorization, or evidence-bound delivery.

## 24. Implementation-agent handoff

### 24.1 Working instruction

Implement this specification in the current Vocs Code checkout, reconciling the named integration points with actual source and current `AGENTS.md`/testing rules. Treat confirmed decisions in section 1.1 as product requirements and section 1.2 as the selected MVP defaults. Do not turn those defaults into another planning questionnaire; record necessary deviations and their evidence.

Start with a live vertical slice using the existing session/harness architecture. Preserve normal sessions and `/goal`. Do not replace the app's provider layer, permission system, model registry, Git utilities, or transcript ledger. Use existing code graph and project knowledge where available before structural changes.

Build a working single-lead system with dynamic profiles and approved preset pools, then add controlled parallelism and delivery recovery. Prioritize state ownership, source preservation, and testable boundaries over a large UI or generic framework.

Stop only for genuine authorization, data-loss, unavailable required capability, or irreconcilable project-policy blockers. Ordinary implementation choices are delegated to the implementer. Never call a requested live test verified if it did not run.

### 24.2 Required implementation deliverables

| Deliverable | Expected content |
| --- | --- |
| Application behavior | Both Mission modes, T5 lead, tier/preset settings, dynamic workers, isolated worktrees, evidence-bound integration/delivery. |
| Existing-UI integration | Mission session launch and header, plan/task/agent inspection, lead-only user instructions, relevant control safeguards. |
| State and recovery | Validated transitions, durable attempts/operations, pause/stop/resume, no duplicated delivery after restart. |
| Tests | Applicable matrices and demonstrations, regression coverage for existing session/goal behavior, honest live support report. |
| Documentation | Feature guide, settings definitions, baseline/permission limitations, architecture/testing updates, known support matrix. |
| Final handoff | Actual changes, tests executed with results, deviations from defaults, remaining limitations, delivery artifact under project policy. |

This file is the specification handoff. Generating it did not authorize a repository mutation, create a PR, run a live Mission, or demonstrate performance gains.

## 25. Source review and provenance

### 25.1 Review boundaries

The initial source review in this conversation used repository snapshot `9c086b04ef61eefca2719a1489d474d5e49a3934`. Later UI/context reads and the targeted subagent documentation check used snapshot `a3d52c39893d9f3e088ca0cd0cdb76f43eed9664`. These are inspected snapshots, not a claim that the implementation checkout is still at either revision.

The prior 727-line specification was read while consolidating this revision. Existing source observations below are limited to the retrieved files/sections. The desktop application, repository tests, and live agent harnesses were not executed in preparing this file. Current source wins over stale architectural prose; code and an actual test determine whether a capability works.

### 25.2 Repository sources

References support current-foundation observations, not the new requirements proposed by this specification.

| Ref | Inspected source | Relevance |
| --- | --- | --- |
| R1 | [AGENTS.md](https://github.com/vocsong/VocsCode/blob/a3d52c39893d9f3e088ca0cd0cdb76f43eed9664/AGENTS.md) | Verification, instruction/memory authority, dependency approval, Git identity, project delivery policy. |
| R2 | [docs/ARCHITECTURE.md](https://github.com/vocsong/VocsCode/blob/9c086b04ef61eefca2719a1489d474d5e49a3934/docs/ARCHITECTURE.md) | Layer ownership, adapter/MCP/permission differences, sessions, context and usage rules. |
| R3 | [src/main/harness/types.ts](https://github.com/vocsong/VocsCode/blob/9c086b04ef61eefca2719a1489d474d5e49a3934/src/main/harness/types.ts) | Shared adapter contract and accepted-versus-completed send semantics. |
| R4 | [src/shared/goal-driver.ts](https://github.com/vocsong/VocsCode/blob/9c086b04ef61eefca2719a1489d474d5e49a3934/src/shared/goal-driver.ts) | Native goal routing and visibility limits. |
| R5 | [src/main/session-manager.ts](https://github.com/vocsong/VocsCode/blob/9c086b04ef61eefca2719a1489d474d5e49a3934/src/main/session-manager.ts), inspected ranges 1-210 and 1230-1655 | Goal/event ownership, completion marker, continuation scheduling, approvals, and session lifecycle. |
| R6 | [src/shared/subagents.ts](https://github.com/vocsong/VocsCode/blob/9c086b04ef61eefca2719a1489d474d5e49a3934/src/shared/subagents.ts) | Native subagent capability and usage/run representations. |
| R7 | [docs/TESTING.md](https://github.com/vocsong/VocsCode/blob/9c086b04ef61eefca2719a1489d474d5e49a3934/docs/TESTING.md), inspected initial 150 lines | Base, high-risk, E2E, and live verification requirements. |
| R8 | [src/renderer/src/components/Sidebar.tsx](https://github.com/vocsong/VocsCode/blob/a3d52c39893d9f3e088ca0cd0cdb76f43eed9664/src/renderer/src/components/Sidebar.tsx), inspected initial portion | Project-grouped sessions and navigation model. |
| R9 | [src/renderer/src/store.ts](https://github.com/vocsong/VocsCode/blob/a3d52c39893d9f3e088ca0cd0cdb76f43eed9664/src/renderer/src/store.ts), inspected initial portion | Existing chat, panel, session, terminal, and navigation state. |
| R10 | [src/main/fork-context.ts](https://github.com/vocsong/VocsCode/blob/a3d52c39893d9f3e088ca0cd0cdb76f43eed9664/src/main/fork-context.ts) | Cross-harness text handoff and its current truncation limits. |
| R11 | [docs/SUBAGENTS.md](https://github.com/vocsong/VocsCode/blob/a3d52c39893d9f3e088ca0cd0cdb76f43eed9664/docs/SUBAGENTS.md), inspected initial 160 lines | Existing Pi-native subagent scope and distinction from worktree-isolated orchestration. |

Some repository documents contain historical design prose alongside shipped-status notes. Do not copy old default counts or assume all planned capabilities exist without checking the live code.

### 25.3 External primary sources checked for this revision

- **E1:** [Git - git-worktree manual](https://git-scm.com/docs/git-worktree.html). Supports linked working-tree behavior and shared repository administration. It does not provide an agent sandbox or orchestration service.
- **E2:** [Claude Code - Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents). Demonstrates programmatic agent definitions and model/tool configuration within that SDK. It does not establish parity with every Vocs Code adapter.

These sources were checked on 25 September 2026. API/runtime behavior is version-sensitive. All Mission commands, new module names, data structures, limits, and MVP policies above are specification requirements or explicit design assumptions, not claims that the cited products already implement them.

---

**End of MVP implementation specification.** The remaining design choices have defaults; validate them by building and testing the MVP rather than delaying implementation for a larger preset catalogue, more agent roles, or a separate orchestration UI.
