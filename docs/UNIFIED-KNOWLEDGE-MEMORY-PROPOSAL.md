# Vocs Code — Unified Knowledge, Memory and Cross-Project Intelligence

- **Status:** Historical proposal — see [Local Knowledge and Memory](INTELLIGENCE.md) for the local implementation and its limits
- **Version:** 1.0
- **Date:** 22 November 2026
- **Target:** Vocs Code (develop branch)
- **Audience:** Vocs Code maintainers, coding-agent developers, architecture reviewers, security reviewers and future implementers

> **Document convention:** **Current** describes behavior verified in the Vocs Code repository at the time of writing. **Proposed** describes a target design, not an existing capability. **Decision pending** identifies an area that must be agreed before implementation. This proposal does not authorize cloud sync, broader memory sharing, external data transfer or changes to security-sensitive access rules.

## 1. Executive summary

Vocs Code already contains a substantial local-first engineering knowledge system. GitNexus supplies current code-structure intelligence; the project wiki holds architectural decisions and durable explanations; session transcripts and FTS5 search record past agent work. The separate OpenBrain project supplies an LLM-maintained knowledge/reflection scaffold. The missing capability is not merely another graph index: it is a consistent knowledge authority, memory lifecycle, retrieval policy and scope model that works across projects, agents, devices and eventually authorized cloud runtimes.

**Proposal:** Introduce a **Vocs Intelligence Core** owned by Vocs Code. Keep GitNexus as the structural-code specialist, integrate Graphify as an optional broader relationship and document-to-code graph provider, preserve the existing Markdown wiki as the canonical project-knowledge store, and evolve session history into typed episodic/semantic/procedural memory. Expose a single, scoped retrieval and memory interface to all supported harnesses. Add explicit **Project Collections** for cross-repository intelligence.

Graph indexes remain rebuildable evidence products; neither GitNexus nor Graphify becomes the sole authority for durable project memory. Every durable claim must retain provenance, validity, visibility and correction/revocation semantics. Project-wide, collection-wide and personal memory must never inherit access solely through similarity of topic.

### Outcomes

1. A coding agent can answer how code currently works, why it was designed that way and what previous attempts taught us, with distinct evidence sources.
2. Knowledge survives sessions and worktrees, without becoming coupled to a specific harness, LLM or graph engine.
3. Explicitly grouped projects can reuse reviewed architectural decisions and validated implementation patterns without leaking private repository data.
4. Memory captures outcomes instead of indiscriminately turning transcripts or model inferences into project truth.
5. Users can understand, inspect, correct, promote, expire, export and remove knowledge and memories.
6. Local-first behavior works without Graphify, without embeddings, without a cloud service and without a new model provider.

### Non-goals for the initial release

- Replacing GitNexus, Vocs Code's Markdown wiki or the existing transcript store.
- Building a second independent code-symbol/call-graph database.
- Automatically uploading code, transcripts, wiki pages or embeddings to a hosted service.
- Enabling Graphify Cloud memory as a second automatic knowledge writer.
- Silently sharing personal, repo-private or collection knowledge across accounts, projects or devices.
- Treating a graph relationship, LLM synthesis or repeated agent assertion as a verified fact.
- Deploying a new organization-wide service as a prerequisite for local usage.

## 2. Verified current-state inventory

The existing [project knowledge reference](MEMORY.md), [architecture reference](ARCHITECTURE.md), [MCP design](MCP.md) and [working agreements](../AGENTS.md) describe four layers:

| Existing layer | Question | Current owner | Actual state |
| --- | --- | --- | --- |
| L1 structural | What does the code currently do? | GitNexus built-in MCP | Implemented and repo-scoped via proxy |
| L2 project knowledge | What does this project mean, and why? | Vocs Wiki under .vocs-code/wiki | Implemented |
| L3 episodic | What occurred in previous work sessions? | Session transcripts, search.db and episode ledger | Search and git-boundary capture implemented; richer session-end capture not yet implemented |
| L4 organizational | What do related projects and the wider organization know? | Not built | Future scope |

### 2.1 Existing implementation to preserve

| Component / path | Current behavior |
| --- | --- |
| src/main/mcp/gitnexus.ts, src/main/mcp/shared-server.ts, resources/mcp/gitnexus-scope.mjs | One shared GitNexus service, with a per-session scope proxy and explicit shared-root settings |
| src/main/mcp/indexer.ts | Serialized, best-effort GitNexus refresh on supported lifecycle events |
| src/main/knowledge/store.ts | Markdown pages, branch overlays, source/claim evidence, rejection tombstones, atomic writes and write locking |
| src/main/knowledge/service.ts | Project-scoped knowledge facade, lexical and graph-aware search, digest, reviews, publishing and synthesis orchestration |
| src/main/knowledge/anchors.ts | Live resolution of wiki file/symbol anchors against GitNexus |
| src/main/knowledge/synth.ts and llm.ts | Documentation bootstrap, commit/merge distillation and PR reflection using the configured utility model |
| src/shared/knowledge.ts | Typed page contract, frontmatter serialization, authority mapping and derived wiki graph |
| resources/mcp/vocs-memory.mjs | Separate per-session stdio MCP with knowledge search/read/related/propose/status and session-history search |
| src/main/mcp/memory.ts | Per-session built-in memory MCP registration, conditional on an existing project wiki |
| src/main/search.ts | Rebuildable SQLite FTS5 index derived from session transcripts |
| src/renderer/src/components/KnowledgeTab.tsx | Knowledge browse/search/review/reject/publish panel |
| src/main/session-manager.ts | Session creation and bounded knowledge digest priming |

The wiki is intentionally local and git-excluded at **projectRoot/.vocs-code/wiki/**. An explicit Publish action writes selected pages to **docs/wiki/**. Branch pages are overlaid from **branches/{branch}/...** inside the main project's wiki, not stored in disposable worktrees. The derived **_graph.json** can be regenerated from Markdown. Existing claims have source lists, anchors, confidence, statuses, evidence counts and rejection tombstones.

The current retrieval method uses lexical matches where every query term must appear, then expands over one to two graph hops. This design is effective for a curated project wiki but does not yet form a scalable federated retrieval layer. Session recall already uses FTS5, yet the knowledge MCP implements some parsing and ranking separately from the main process.

### 2.2 OpenBrain's relationship to Vocs Code

The separate [OpenBrain repository](https://github.com/vocsong/openbrain) is a reusable repository-local scaffold inspired by the LLM wiki concept. Its **raw/** area stores evidence; **knowledge/** holds maintained source, entity, concept, synthesis and query pages; its reflect workflow preserves useful sessions. It is not currently a unified Vocs Code runtime dependency.

**Proposed direction:** Import OpenBrain content as sources and compiled knowledge, and preserve its reflection semantics as a Vocs Code workflow. Do not create a second independently authoritative wiki or competing automatic writer inside each project.

### 2.3 The actual gaps

- Project identity and knowledge scope are keyed primarily by local filesystem root, which is not a durable identity across PCs, clones and cloud machines.
- No native collection of authorized projects exists; existing GitNexus shared roots are not a general knowledge-federation model.
- Wiki, L3 search and Graphify would otherwise expose separate tools, competing rankings and inconsistent promotion semantics.
- The main knowledge service and stand-alone MCP duplicate some parsing, searching and write logic.
- The existing automatic ingestion path can mark agent-generated claims current immediately; distinct session sightings are not inherently independent evidence.
- Freshness checks rely partly on file modification time and anchors; portable Git revision and graph snapshot identity are needed.
- L3 does not yet perform a structured, opt-in session-end lesson capture.
- There is no generalized cross-project authorization, conflict handling, memory expiry or cross-device synchronization contract.
- Graphify would duplicate portions of the current derived wiki graph unless its role is explicitly bounded.

**Important:** None of these gaps justifies discarding the mature safeguards already present in the repository.

## 3. Architectural principles

1. **One authority per fact type.** Source code governs current implementation, reviewed decisions govern intended design, transcript evidence governs what was attempted, and explicit project instructions remain the highest behavioral authority.
2. **Graph is derived, never unquestionable truth.** Graphify/GitNexus results are evidence tied to a source revision, parser version and indexing status.
3. **Knowledge and scope are orthogonal.** A decision can be project-local, collection-shared or personal; it remains a decision in every scope.
4. **Local-first, offline-capable and portable.** Basic knowledge, memory and retrieval must work without a hosted service.
5. **Harness-neutral.** Claude, Codex, Pi, native and future agents receive the same access policies through a common interface.
6. **Least privilege before search.** Resolve authorized scope before retrieving candidates or traversing graph edges. Never fetch a forbidden result merely to filter it at presentation time.
7. **Source-backed and temporal.** Preserve exact provenance, verification outcomes, supersession, timestamps and revision context.
8. **Explicit promotion and deletion.** A repo-local lesson does not automatically become a collection-wide rule. Revocations and forget operations are first-class.
9. **Bounded context.** Keep short session orientation; fetch detailed evidence on demand.
10. **Incremental migration.** Existing data remains readable, and no new engine is mandatory on day one.

## 4. Proposed logical architecture

~~~mermaid
flowchart TD
    H["Vocs Code harnesses: Claude / Codex / Pi / ACP / native"] --> G["Vocs Intelligence Gateway (MCP + internal API)"]
    G --> C["Vocs Intelligence Core"]
    C --> Q["Scoped query planner / evidence resolver / context compiler"]
    C --> L["Knowledge lifecycle / memory policy / provenance"]
    Q --> GN["GitNexus adapter: structural code intelligence"]
    Q --> GF["Graphify adapter: document + concept relationships"]
    Q --> WK["Vocs Wiki adapter: decisions and project facts"]
    Q --> EM["Memory adapter: episodes, preferences, lessons"]
    L --> WK
    L --> EM
    GN --> SRC["Sources: code, docs, commits, PRs, sessions"]
    GF --> SRC
    WK --> SRC
    EM --> SRC
    C --> AUTH["Project registry / collections / permissions / audit"]
~~~

The gateway is a Vocs-owned interface, not necessarily a separate network service. For the first local release it can be a main-process service reached through a narrow authenticated IPC boundary. Existing direct GitNexus engineering tools remain usable for specialized questions; the gateway owns multi-source retrieval and all durable knowledge writes.

### Responsibility matrix

| Subsystem | Authoritative responsibility | Explicit exclusion |
| --- | --- | --- |
| GitNexus | Current symbols, call chains, flows, impact, refactoring and relevant API/code contracts | Final authority for project intent, agent preferences or historical rationale |
| Graphify | Queryable relationships across docs, concepts, code and supported cross-repository references | Canonical durable memory or automatic project rules |
| Vocs Wiki | Durable architecture, decisions, conventions, constraints, patterns, gotchas and lessons | Current line numbers, entire symbol inventories and re-created dependency graphs |
| Vocs Memory | Task episodes, retained experiences, validated personal preferences and procedures | Unverified assertions about current implementation |
| Intelligence Core | Stable identities, scoped retrieval, policy, provenance, memory lifecycle, conflict analysis and context packets | Language parsing and implementation of individual graph algorithms |
| Evidence sources | Git trees, documents, PRs, tests, tool results and original sessions | Automatically granted authority beyond their source and revision |

## 5. Redesigning memory: type, scope and lifecycle

### 5.1 Memory type is not scope

The existing L1-L4 terminology mixes kinds of information with where information is visible. Keep the terms as legacy compatibility labels, but internally model **type** and **scope** separately.

| Type | What it retains | Typical lifetime | Example |
| --- | --- | --- | --- |
| Working | Active task state, unresolved assumptions, temporary evidence | Session/turn, with resumable checkpoints | Files currently being investigated |
| Episodic | Attempts, errors, fixes, outcomes and source links | Long-lived, reviewable/expirable | The previous Windows recovery failure and the fix |
| Semantic | Durable facts, design decisions, constraints and rationale | Until corrected or superseded | Why a single session store owns restart recovery |
| Procedural | Verified reusable practices, coding conventions and workflows | Until changed | Steps to validate an MCP server |
| Preference | User or agent preferences, with consent and scope | Until changed or forgotten | Prefer a particular development workflow |

**Do not infer global user preferences from one coding session.** Preserve declared preferences separately from heuristic observations.

### 5.2 Scope hierarchy

| Scope | Meaning | Default access |
| --- | --- | --- |
| Session | One run of one agent, including child-agent permissions | Only that session's grant |
| Branch | Provisional work against a branch/commit | Authorized sessions on that branch |
| Project | One canonical repository identity and its approved local checkouts | Sessions authorized for that project |
| Collection | Explicitly grouped projects (e.g. Vocs Platform) | Only sessions with a matching collection grant |
| Personal / account | Explicitly authorized profile-wide preferences and memory | Owner and permitted agents; never automatically shared |
| Organizational (future) | Governed group-wide knowledge | Explicit identity, policy and review integration |

The hierarchy describes possible visibility, **not automatic inheritance**. A record tagged collection-wide must have permission to be published there; private source evidence stays private if the broader collection does not grant access.

### 5.3 State and authority

Suggested memory states: **captured → candidate → verified → active → superseded / expired / revoked**, with **uncertain** and **rejected** as explicit side states. Captured raw evidence and an accepted durable claim are different things.

- **Captured:** A bounded episode or source event has been recorded; no factual promotion.
- **Candidate:** An extracted claim with provenance, confidence and intended scope is awaiting a validation policy.
- **Verified:** Evidence was checked against a source, test, Git revision or explicit human review.
- **Active:** Eligible for retrieval at its authority level and authorized scope.
- **Superseded/expired:** Retained for history but not presented as current guidance.
- **Revoked/rejected:** No longer served; the existing tombstone mechanism prevents accidental re-ingestion.

An agent may still write low-authority project-local observations automatically, as today. **Automatic promotion to high-authority or broader-scope guidance is disallowed** until the applicable verification/review policy passes. Existing user-reviewed pages retain their authority; migration must not reclassify them as unverified.

### 5.4 Provenance and independent evidence

A distinct session ID must not be treated as an independent source if several sessions repeat the same unsupported claim. Evidence should retain source identity (commit, file revision, human review, test run, PR, session, URL) and a verification method.

Recommended authority ordering for actionable context:

1. Explicit project/user policy and session permissions (including AGENTS.md).
2. Current source code or verified tool result **for implementation-state questions**.
3. Human-reviewed or otherwise verified knowledge appropriate to the question.
4. Agent-ingested project knowledge with direct citations and fresh verification.
5. Historical observations, session recollections and unverified hypotheses.
6. Model inference without source evidence.

This is **intent-aware**, not one universally numeric ranking. A current code call graph is stronger for “what currently calls this function”; a reviewed design record is stronger for “why did we choose this design.” Conflicts should be shown, not silently suppressed.

### 5.5 Example durable record contract (illustrative)

~~~yaml
id: kn_immutable_identity
project_id: github:repository-id
collection_ids: []
type: semantic
kind: decision
scope: project
status: active
title: One store owns session state
claim: Session restart state has one authoritative owner.
confidence: high
authority: human-reviewed
sources:
  - type: commit
    repository_id: github:repository-id
    revision: full-commit-sha
    ref: src/main/session-manager.ts
  - type: doc
    repository_id: github:repository-id
    revision: full-commit-sha
    ref: docs/ARCHITECTURE.md
anchors:
  - repository_id: github:repository-id
    file: src/main/session-manager.ts
    symbol: SessionManager
related: []
supersedes: []
valid_from: 2026-11-22T00:00:00Z
last_verified_at: 2026-11-22T00:00:00Z
updated_by: human
~~~

This is a **target conceptual schema**, not a replacement format that current frontmatter parsers can read. Schema/version migration and unknown-field preservation are required before adoption. Structured identifiers and timestamps are examples, never synthetic citations.

## 6. Stable project identity and Project Collections

### 6.1 Identity

Today the wiki and MCP scope are largely keyed by the local **projectRoot** path. Introduce a stable **projectId** in an app-owned registry:

- Hosted repositories: use immutable provider repository identity where available; retain owner/name as display metadata, not primary identity.
- Local-only projects: generate a random stable identifier, retained in an app-owned registry and optionally in an explicit portable export.
- Checkouts/worktrees: map local canonical path and Git common directory to projectId, plus branch and commit.
- Renames, moved folders and re-clones must preserve identity through explicit verification rather than name similarity.
- Forks and copies default to distinct project identities unless the user explicitly links them.

Repository history for Vocs Code, a user's other PC and a cloud worktree should resolve to the same project only after authorized identity mapping.

### 6.2 Project Collections

A **Project Collection** is an explicit group of projects used for federated search and optional promoted knowledge. For example:

~~~text
Vocs Platform (collection)
  Vocs Code       -> local project wiki + GitNexus + Graphify
  Vocs Login      -> local project wiki + available graph indexes
  MCP Hub         -> local project wiki + available graph indexes
  Shared Patterns -> reviewed collection-scoped decisions only
~~~

Collection membership is not proof that every fact may be shared. A collection query fans out only to projects authorized for the current user, agent and task.

### 6.3 Cross-project edge types

| Edge type | Example | Validation |
| --- | --- | --- |
| Code contract | Service A calls an endpoint in service B | Resolved endpoint/contract plus source revisions |
| Document-to-code | Authentication ADR describes one implementation | Document anchor plus indexed implementation |
| Semantic similarity | Two services apply similar auth patterns | Candidate relationship, never automatic policy |
| Reuses pattern | Project B deliberately adopted Project A's convention | Explicit decision, reviewed evidence |
| Depends on service | MCP Hub depends on Vocs Login | Source/config/contract verification |
| Supersedes / contradicts | A new policy replaces an old one | Reviewed transition with audit |
| Learned from | A fix in one repo informs another | Promoted lesson with its original provenance |

Graphify's graph merge capability is useful as a **derived federated view**. Do not assume every imported call can be resolved automatically. Preserve repository-qualified IDs and the identity/revision of each graph snapshot. GitNexus's existing repo groups and API contract support may serve complementary, code-specific cases.

## 7. Graphify integration strategy

### 7.1 Choose “graph provider”, not “new memory authority”

Integrate the local open-source Graphify engine first. Keep code parsing local. Graphify documentation and media enrichment may involve a chosen LLM backend and is not automatically local; model provider, outbound request and content scope must therefore be explicit.

Graphify can add:

- Document, schema, configuration and concept relationships not covered by a code-focused index.
- Traversals between architectural explanations and code entities.
- Candidate cross-repository relationships and project-level concept communities.
- Source-linked graph exploration and diagrams.
- Optional PR collision intelligence if its results are proven useful.

Do not initially synchronize durable memory by enabling Graphify Cloud's independent Wiki/Memory writers. Cloud features and licensing are a **separate later decision**.

### 7.2 Adapter boundary

Suggested provider contract:

~~~ts
interface IntelligenceGraphProvider {
  id: string;
  capabilities(): Promise<GraphCapabilities>;
  index(project: ProjectContext, reason: IndexReason): Promise<IndexStatus>;
  query(request: ScopedGraphQuery): Promise<GraphEvidence[]>;
  neighbors(request: ScopedNodeQuery): Promise<GraphEvidence[]>;
  trace(request: ScopedPathQuery): Promise<GraphEvidence[]>;
  health(projectId: string): Promise<IndexStatus>;
}
~~~

This is a logical TypeScript sketch only; actual types should extend Vocs Code's existing shared contracts. Include a provider-origin field, parser/index version, projectId, commit/branch snapshot, source pointers, confidence and evidence classification in every result.

### 7.3 Operational rules

1. Graphify is opt-in per project, with an app-level default disabled until the integration is validated.
2. Prefer a pinned installed version; avoid unreviewed auto-upgrades and “latest” for persistent background indexers.
3. Reuse the lifecycle pattern of **src/main/mcp/indexer.ts**: bounded jobs, coalescing, explicit manual initial index and passive incremental refresh afterward.
4. Store generated Graphify artifacts in a git-ignored per-project cache. Do not write agent instruction files automatically.
5. Indexing must not block opening sessions; query-time freshness is surfaced to the caller.
6. Add a scope proxy or invoke the graph adapter through Vocs-owned authorization. Do not expose a shared Graphify service containing all projects directly to arbitrary harness sessions.
7. Treat semantic edges labelled inferred or ambiguous as lower-confidence candidates.
8. A missing Graphify index degrades to Wiki + GitNexus + session history without breaking the session.
9. Use stable source IDs to connect Graphify graph nodes to existing wiki page anchors; do not duplicate current symbol tables in Markdown.

### 7.4 Key constraint: licence and privacy

Graphify's public engine is documented under Apache 2.0. GitNexus publicly advertises PolyForm Noncommercial licensing for its public distribution. Review permitted use, distribution and any commercial agreements before expanding GitNexus deployment. These licence observations are not legal advice. Running Graphify locally is not equivalent to authorizing a hosted/cloud Graphify connection.

## 8. Unified retrieval and context compilation

### 8.1 Query pipeline

~~~mermaid
flowchart TD
    USER["User / agent question"] --> SCOPE["Resolve project, collection, user and tool grants"]
    SCOPE --> INTENT["Identify intent and required freshness"]
    INTENT --> GN["GitNexus structural retrieval"]
    INTENT --> GF["Graphify relation retrieval"]
    INTENT --> WK["Vocs Wiki knowledge retrieval"]
    INTENT --> EP["Session / episodic memory search"]
    GN --> MERGE["Merge candidates, dedupe and verify provenance"]
    GF --> MERGE
    WK --> MERGE
    EP --> MERGE
    MERGE --> CHECK["Check authority, source revisions, contradictions and ACLs"]
    CHECK --> PACKET["Compile token-budgeted, cited context packet"]
    PACKET --> AGENT["Authorized harness / user"]
~~~

The planner may fan out to multiple sources when warranted; ordinary symbol lookup should not pay for full multi-source retrieval.

### 8.2 Intent routing

| Query | Primary provider | Supporting provider |
| --- | --- | --- |
| Where is a function used? | GitNexus | Current source file verification |
| What breaks if I edit this API? | GitNexus impact | Graphify cross-repo relationships; reviewed constraints |
| Why does this module use this architecture? | Vocs Wiki | Graphify document/code anchors |
| Did we try this before? | Episodic memory | Referenced PRs, commits, source verification |
| Which other projects follow this pattern? | Project Collection federation | Graphify, reviewed project wiki claims, code contracts |
| Which approach should a new service reuse? | Reviewed knowledge + constraints | Current GitNexus implementation, Graphify, past failures |

### 8.3 Retrieval scoring

Extend the current all-terms lexical scan at **KnowledgeService.search()** without changing its public return shape abruptly.

Proposed staged retrieval:

1. Exact title/claim/ID and symbol/source matches.
2. SQLite FTS5/BM25 retrieval (rebuildable, with provenance and scope filters).
3. Graphify/wiki-graph neighborhood expansion within authorized project boundaries.
4. Optional embeddings for fuzzy prose recall **only after measured retrieval failures**.
5. Evidence-aware reranking by intent, source quality, freshness, specificity and authority.
6. Deduplication, contradiction detection and final answer packaging.

Avoid global semantic search over private data before authorization. Any embedding backend must be provider-configurable, offline-capable when required and deletable by source identity.

### 8.4 Context packet

The existing bounded knowledge digest is a strong foundation. Retain short session priming; use retrieval for details rather than injecting the entire wiki.

A context packet should include:

- Scope and query interpretation.
- Relevant instructions/invariants, with authority.
- A small set of current wiki claims with source references.
- Relevant historical lessons labelled as history, not present fact.
- Graph/code references including revision and freshness.
- Conflicts, uncertainty and missing evidence.
- A token budget and truncation policy.

For example, a question about authorization across Vocs Code and MCP Hub should produce a cited comparison of prior decisions and current implementations, not thousands of graph edges or complete transcripts.

### 8.5 Failure and stale-result handling

- If GitNexus is stale: do not claim its impact result matches the working tree; re-index or validate against current files.
- If Graphify is missing: continue with available sources.
- If wiki claims conflict with current code: identify the difference between documented intent and current implementation.
- If a branch overlay differs from the project base: label the branch explicitly.
- If a source has been deleted or access revoked: suppress or downgrade derived records and queue revalidation.
- If a source cannot be cited: call the result an inference rather than manufacturing provenance.

## 9. One Vocs-owned Intelligence MCP

Keep direct GitNexus graph tools available for specialist code engineering, but consolidate general knowledge and memory retrieval behind a Vocs-owned gateway. Retain the existing six **vocs-memory** tool names as compatibility aliases until each harness is migrated.

| Proposed MCP tool | Purpose | Write privilege |
| --- | --- | --- |
| intelligence_search | Federated, permission-scoped evidence search | None |
| intelligence_trace | Relationship/path explanation with source evidence | None |
| knowledge_read | Read one approved knowledge record and provenance | None |
| knowledge_record | Capture a sourced project knowledge candidate | Candidate write |
| knowledge_promote | Move verified knowledge to a broader scope | Explicit authorization/review |
| memory_recall | Retrieve episodes, preferences and lessons | None |
| memory_forget | Revoke/delete eligible memory and derived references | Explicit authorized mutation |
| context_compile | Produce task-specific, bounded context | None |

Existing aliases remain: **knowledge_search, knowledge_read, knowledge_related, knowledge_propose, knowledge_status, session_history_search**.

### Gateway architecture and enforcement

The existing standalone **resources/mcp/vocs-memory.mjs** duplicates portions of the page parser and scorer. The target is a thin per-session gateway client calling the central app-owned Knowledge Core through authenticated local IPC. Only the core performs durable writes, policy checks and evidence merging.

The gateway must accept a signed or unforgeable per-session capability binding:

- User and agent identity, projectId, authorized collections.
- Branch/worktree identity and required source revision.
- Allowed tools and read/write/promote/delete actions.
- Session expiry, revocation and cancellation.
- Appropriate restrictions for child agents and Mission-managed runs.

Do not grant a Graphify or GitNexus shared-process endpoint global data privileges merely because the client calls itself an MCP server. All provider calls should be mediated by scoped adapters or proxies.

## 10. Storage ownership and portability

| Record or artifact | Canonical source of truth | Derived/cached copy |
| --- | --- | --- |
| Code, source docs and commits | Git and source files | GitNexus + Graphify indexes |
| Current project wiki | .vocs-code/wiki Markdown | Search index and wiki relation graph |
| Human-published project pages | docs/wiki in Git | Indexed documents |
| Session transcript | Existing userData/sessions files | Existing session search.db |
| Structured episode/claim metadata | Vocs-owned app store / durable event record | Query/search indexes |
| Collection membership and project identity | Vocs registry with explicit authorized mappings | Session-scoped lookup cache |
| Personal/collection memory | Vocs-owned durable records with export/delete policy | Scoped search and graph indexes |
| Cross-project graph | Verified source-backed edges and indexed projects | Rebuildable federated graph cache |

**Storage principle:** Keep Markdown as the project wiki source of truth. SQLite is appropriate for an app-wide metadata/episode ledger and rebuildable FTS5 indexes, but should not create a second editable version of the same Markdown page.

### Portability and optional sync

The first release supports multiple local projects on a single machine. Optional future sync should:

- Use stable project and record IDs, not absolute filesystem paths.
- Distinguish source-of-truth records from rebuildable graph/embedding caches.
- Encrypt data before synchronization and use explicit project/account authorization.
- Handle revisions, conflicts, tombstones and deletion propagation.
- Keep the current Cloudflare relay's remote-session transport independent from this knowledge service.
- Never assume that access to a device or cloud agent implies access to every indexed repository.

No existing relay or account service should silently become the general-purpose knowledge database.

## 11. Ingestion, consolidation and memory quality

### 11.1 Preserve existing sources and triggers

Current supported observations include app-driven commits, PR creation, merges and incremental documentation scans. Add a **session-end reflection** option and an ingestion adapter for OpenBrain raw/reflection records. Consider external GitHub PR detection later, but do not imply that it is already implemented.

### 11.2 Proposed pipeline

~~~text
Source event / OpenBrain import / conversation reflection / user entry
  -> raw evidence capture (bounded, sourced, with allowed scope)
  -> candidate extraction (configured utility model, if needed)
  -> schema / secret / identity / provenance validation
  -> exact-claim and semantic duplicate detection
  -> contradiction / supersession / freshness checks
  -> project-local candidate or verified record
  -> optional review + explicit promotion to collection/personal scope
  -> rebuild derived text/graph indexes and notify affected sessions
~~~

A conversation-driven memory capture should follow user preferences and consent controls. Never convert a speculative brainstorm into permanent personal memory just because a model found it noteworthy.

### 11.3 Guardrails

- Preserve existing exact-claim collision safety, rejection tombstones, atomic file writes and lock semantics.
- Maintain audit records of authority changes and memory promotion.
- Treat graph centrality as a relevance signal, never as evidence of truth.
- Never overwrite human-reviewed knowledge with a lower-authority model synthesis.
- Provide revalidation instead of an automatic rewrite when sources change.
- Support explicit deprecation, supersession, rejection and deletion.
- A collection-level lesson must cite the contributing project's original source; authorization to see the lesson does not grant access to its private underlying evidence.
- Ensure prompt injection inside imported docs, transcripts or tool output cannot change policy or bypass tool permissions.

## 12. Product and UX proposal

Upgrade the Knowledge tab into an **Intelligence** workspace while preserving familiar per-project knowledge controls.

### Proposed views

1. **Overview:** Knowledge and graph coverage, freshness, indexing health, pending candidates, recent verified changes.
2. **Knowledge:** Browse decisions, architecture, conventions, constraints and source-backed syntheses; edit/review/reject/publish.
3. **Memory:** Timeline of episodic lessons and explicit preferences; inspect origin, validate, expire, revoke, forget.
4. **Graph:** Switch or overlay GitNexus structural relationships, Graphify conceptual/document links and wiki relations, clearly labelling provenance.
5. **Projects & Collections:** Explicit collection membership, cross-project search scope, permissions and promotion history.
6. **Evidence & conflicts:** Show competing claims, stale anchors, outdated source revisions and review actions.

For any answer or record, show **why it was retrieved**, **how authoritative it is**, **what project/branch/revision it belongs to** and **when it was last verified**. Do not display “verified” for an LLM-generated unconfirmed claim.

### User controls

- Enable/disable Graphify independently of GitNexus.
- Configure allowed indexable folders and LLM enrichment provider.
- Choose memory capture (off / manual / bounded automatic) and scope defaults.
- Review project-to-collection promotions, source visibility and deletion.
- Export/import project knowledge and app-owned memory without requiring Graphify.
- Clear graph/search caches independently from authoritative records.

## 13. Security, governance and operations

### 13.1 Trust boundaries

- Source documents, generated graphs and session histories are **untrusted data**, not instructions.
- Permission gating applies before retrieval, graph traversal, indexing and sharing.
- A personal or collection scope must be explicitly granted; GitNexus global-root preference is not sufficient authorization for wiki/memory federation.
- Agent subprocesses, subagents, Mission sessions and remote clients must receive revocable least-privilege capabilities.
- Sensitive data redaction should happen before any model-enrichment stage; a keyword-based redactor alone is not a complete data-loss-prevention control.
- Provider API requests, model embeddings, hosted Graphify use and telemetry require explicit configuration.
- Denied retrieval and promotion actions should be auditable without logging secret content.

### 13.2 Local-first and cloud separation

Local source code and project knowledge should remain on the owning machine by default. A future shared knowledge backend requires a distinct design review covering encryption, tenancy, identity, residency, retention, sync conflicts, data deletion and authorization. It should not bypass existing Vocs account or remote execution boundaries.

### 13.3 Operational signals

Expose index age, latest successful revision, number of indexed projects, provider availability, failed ingestion jobs, stale claims, denied cross-scope queries, storage growth, cache rebuild time and query latency. Errors should degrade explicitly and appear in the existing job/status UI rather than silently disappearing.

## 14. Migration and delivery plan

**Implement in phases.** Each phase needs a feature flag, independent acceptance tests and a rollback path; preserve old schemas and reads until data migration is proved reversible.

| Phase | Scope | Main touchpoints | Exit criteria |
| --- | --- | --- | --- |
| 0 — Baseline | Fixture corpus, integration inventory, compatibility contracts, current retrieval benchmarks | docs/MEMORY.md, tests/knowledge*.test.ts | Baseline recall/precision, latency and index freshness recorded |
| 1 — Identity and schema | Stable project IDs, repository registry, record metadata and scope model; keep legacy path mapping | src/shared/knowledge.ts, src/main/knowledge/store.ts | Existing wiki pages and sessions read unchanged; clone/worktree identity tests |
| 2 — Consolidate knowledge core | Single authoritative parser/writer/policy path; thin memory MCP gateway; compatibility aliases | service.ts, resources/mcp/vocs-memory.mjs, src/main/mcp/ | Identical old-tool behavior; no bypass of source scope or write permissions |
| 3 — Memory lifecycle | Typed episodes, opt-in session reflection, candidate/verified states, provenance and forget/expiry | knowledge/synth.ts, session-manager.ts, search.ts | Verifiable captures; no repeated unsupported promotion; deletion/tombstone tests |
| 4 — Graphify provider | Optional local indexer, query adapter, graph freshness and fallback | new intelligence/providers/graphify.ts and index scheduler | Offline and provider-disabled behavior unchanged; source/revision-specified results |
| 5 — Project Collections | Explicit membership, authorized federation, cross-project evidence edges and promotion | new project registry, scope resolver, federated planner | Cross-project isolation/redaction and revocation tests pass |
| 6 — Product surfaces | Graph, memory timeline, project collections, conflict and evidence UI | KnowledgeTab.tsx, shared types/IPC, renderer | E2E for browse, promote, reject, revoke, disabled-provider and stale-source states |
| 7 — Optional synchronization | Encrypted cross-device portability and account-bound policy, separately approved | new sync service and export/import adapters | Dedicated privacy/security review, conflict/deletion tests and rollback |

### Recommended initial milestone

**Do not start by replacing the wiki with Graphify.** The first engineering milestone is a unified knowledge contract with stable project identities, source-qualified evidence and a single memory write/authority path. Next, add an opt-in Graphify adapter. Project Collections can then use consistent policy rather than bridging unrelated databases after the fact.

### Migration strategy

1. Introduce additive schema fields and version detection; do not mutate current Markdown on read.
2. Backfill stable project IDs by explicit verified local repository mappings.
3. Build derived SQLite FTS5 indexes without changing Markdown page ownership.
4. Move standalone MCP write/read policy behind the Knowledge Core with compatibility shims.
5. Add new memory types and provenance to new records first; migrate older records conservatively.
6. Enable Graphify for one designated test project; measure benefit before expansion.
7. Enable collection federation behind permission controls and tests.
8. Retire aliases and duplicate implementations only after usage telemetry and regression coverage show safe migration.

### Testing and acceptance

Include security and functional tests for:

- Existing knowledge frontmatter roundtrip, unknown fields, exact claim collision and concurrent app/MCP writers.
- Human-reviewed page authority, branch overlays, stale anchors, rejected/tombstoned claims and publication behavior.
- Project ID consistency across clones/worktrees and fork separation.
- Scope filtering before search/traversal; denial of unauthorized cross-project edges and records.
- No automatic collection promotion, no preference inference without consent.
- Source-revision changes, stale graph detection, Graphify downtime and cold-start fallback.
- Capture/forget/revoke semantics across all derived indexes and caches.
- Token-budgeted context compilation, source citations and contradictions.
- Windows/macOS/Linux path handling, restart recovery and bounded subprocess cleanup.
- Existing harness MCP injections, including explicit child-agent permission restrictions.

Follow the repository's testing requirements in [AGENTS.md](../AGENTS.md) and [TESTING.md](TESTING.md). At minimum, new behavioral changes should have focused unit/integration coverage and the appropriate E2E changes in the same PR. No tests or product functionality are added by **this proposal document**.

## 15. Evaluation: prove it is better

Before adding an embedding store or cloud graph service, run the same questions through current Vocs Code and the proposed stack using pinned source commits and consistent LLM/harness settings.

| Dimension | Metric | Why |
| --- | --- | --- |
| Correctness | Grounded answer and independent source verification | Prevents plausible but wrong knowledge |
| Retrieval quality | Precision@K / recall@K for known sources | Quantifies Graphify/FTS improvement |
| Cross-project value | Validated relationships and missed/false links | Detects overly broad federation |
| Freshness | Time from merge/source change to correct answer | Avoids stale guidance |
| Context efficiency | Context tokens consumed per correct task | Avoids broad wiki/transcript dumps |
| Runtime | Cold/warm query latency, index time and storage | Protects local desktop UX |
| Safety | Unauthorized retrievals blocked and verified forget behavior | Enforces boundaries |
| Memory usefulness | Repeated-debugging reduction and verified lesson reuse | Measures actual long-term benefit |

Sample evaluation prompts:

1. “Where is the authorization middleware called, and what will break if it changes?”
2. “Why did we choose this authentication architecture?”
3. “What previous attempt to fix this Windows reconnect issue failed?”
4. “Which projects use this authorization pattern, and which decisions were deliberately shared?”
5. “What changed between the documented intent and the current implementation?”
6. “Can the agent retrieve evidence from an unapproved private project?” — expected **no**.
7. “After deleting a memory, can the old content still surface through a derived index?” — expected **no**.

Benchmark standalone GitNexus, current Wiki + session recall, Graphify alone where comparable, and the unified system. Do not treat a vendor's benchmark or graph completeness as conclusive proof of agent task quality.

## 16. Key architectural decisions proposed

| Topic | Proposed decision | Status |
| --- | --- | --- |
| Primary code intelligence | Retain GitNexus | Proposed; preserve existing implementation |
| Concept/document relationships | Integrate local Graphify as optional derived provider | Proposed |
| Project knowledge source of truth | Retain Markdown wiki, with explicit published Git export | Proposed |
| Session and experience memory | Evolve existing transcripts + structured episodes | Proposed |
| Reusable OpenBrain scaffold | Import its evidence/compiled pages and adopt reflection workflow; no competing authoritative store | Proposed |
| Cross-project model | Explicit Project Collections with separate ACLs | Proposed |
| Agent-facing interface | Vocs-owned gateway with backward-compatible MCP aliases | Proposed |
| Search | Incremental FTS5 + graph expansion; embeddings only after measured need | Proposed |
| Cloud | No default external synchronization or hosted Graphify | Proposed |
| Memory promotion | Evidence-based state transitions and explicit broader-scope review | Proposed |
| Current L1-L4 terminology | Retain in existing docs until replacement is implemented; avoid retroactive reinterpretation | Proposed |

## 17. Open questions for architecture review

1. Is personal/account-scoped memory wanted in the first release or only project/collection memory?
2. Should all repos receive session recall even when no project wiki exists? Today the built-in memory MCP is conditional on wiki presence.
3. What minimum evidence qualifies an agent-generated claim as verified? Should tests/commits qualify automatically, while design intent remains human-reviewed?
4. Should a session-end reflection be opt-in per project or a global default with a per-session skip?
5. What user experience should govern promotion from repo to collection, and can promotions be revoked centrally?
6. Which Graphify capabilities should be enabled initially: local AST/document graph only, or semantic model labeling as an explicit optional add-on?
7. Should an app-wide SQLite store own collection/personal records while project wiki stays Markdown, or should there be an additional portable Markdown bundle for those scopes?
8. How should branches and multiple active working trees report conflicting code facts?
9. Which remote execution/knowledge-sync threat model and data residency requirements would apply if this later reaches code.vocs.io or mcp.vocs.io?
10. Which measured benchmark threshold would justify embeddings or an always-on central graph process?

## 18. Recommended next implementation session

1. Read this proposal together with [MEMORY.md](MEMORY.md), [ARCHITECTURE.md](ARCHITECTURE.md), [MCP.md](MCP.md), [AGENTS.md](../AGENTS.md) and the existing knowledge tests.
2. Establish an initial compatibility and benchmark fixture from the present wiki + session search.
3. Draft stable project IDs and the typed knowledge/memory/scope contract; explicitly map all existing fields.
4. Define the Gateway authorization and provenance contract before connecting Graphify.
5. Produce a focused Phase 1 PR with tests; keep user-visible behavior unchanged.
6. Decide the first Graphify pilot project and evaluation queries only after that foundation is accepted.

**Acceptance for this document:** It accurately separates verified current behavior from future proposals, preserves Vocs Code's existing authority and storage boundaries, includes a staged integration plan, and does not imply that Graphify, federation or new memory behavior has already shipped.

## 19. References

### Vocs Code source of truth

- [Project knowledge and current L1-L4 architecture](MEMORY.md)
- [Architecture and harness integration](ARCHITECTURE.md)
- [MCP support and built-in GitNexus](MCP.md)
- [Project working agreements and verification gates](../AGENTS.md)
- [Test requirements](TESTING.md)
- [Existing project wiki implementation](../src/main/knowledge/)
- [Existing memory MCP server](../resources/mcp/vocs-memory.mjs)
- [Existing session search](../src/main/search.ts)
- [Existing GitNexus integration](../src/main/mcp/gitnexus.ts)
- [OpenBrain repository and reflection scaffold](https://github.com/vocsong/openbrain)

### External project references, checked 22 November 2026

- [Graphify source repository and CLI capabilities](https://github.com/Graphify-Labs/graphify)
- [Graphify MCP tools](https://graphiffy.com/docs/mcp-tools)
- [GitNexus source repository](https://github.com/abhigyanpatwari/GitNexus)
- [GitNexus architecture](https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md)

Vendor feature sets, installation commands, licence terms and hosted offerings may change. Reverify those details before choosing versions, deployment or paid services.
