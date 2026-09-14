# Project knowledge — Layer 2 memory

Vocs Code carries four kinds of memory. This document defines the second one, what it may and may
not contain, and how the four stay out of each other's way.

| Layer | Question | Owner | Lifetime |
| --- | --- | --- | --- |
| **L1 structural** | What does the code currently do? | GitNexus (built-in MCP server) | Rebuilt by indexing |
| **L2 project knowledge** | What does this project mean, why is it designed this way, what must stay true? | **this feature** — `.vocs-code/wiki/*.md` | Curated, reviewed, versioned by hand |
| **L3 episodic** | What happened while agents worked here? | `userData/sessions/*` + the FTS index | Append-only, private, disposable |
| **L4 organisational** | What does the wider organisation know? | not built | future scope |

The one-line distinction: **GitNexus answers "what exists"; Layer 2 answers "what does it mean",
and never the other way around.** Anything GitNexus can regenerate by indexing is not L2 content.
Anything that only makes sense with "in session X we found…" is L3, not L2.

## What ships today

| Piece | Where |
| --- | --- |
| Markdown wiki store, proposals, evidence ledger, episodes, publish | `src/main/knowledge/store.ts` |
| Scored retrieval, digest, review, authority, jobs facade | `src/main/knowledge/service.ts` |
| Bootstrap + distillation prompts (utility model) | `src/main/knowledge/synth.ts`, `knowledge/llm.ts` |
| Shared schema, frontmatter codec, digest renderer | `src/shared/knowledge.ts` |
| `vocs-memory` stdio MCP server (5 tools) | `resources/mcp/vocs-memory.mjs` |
| Built-in server registration + per-repo switches | `src/main/mcp/memory.ts`, `src/main/mcp/index.ts` |
| Knowledge panel | `src/renderer/src/components/KnowledgeTab.tsx` |
| Session history recall (L3) | `session_history_search` in `resources/mcp/vocs-memory.mjs`, scoped to the project and redacted |
| Session priming | `SessionManager.create` → `appendSystemPrompt` |
| Git boundaries → episodes → distillation | `src/main/handlers.ts` (`git:commit`, `git:pr`, `git:merge`) |

## Architecture

```
                      ┌────────────────────────────────────────────────┐
                      │      KnowledgeService (src/main/knowledge)     │
                      │  view · search · digest · propose · review ·   │
                      │  publish · recordEpisode · generate            │
                      └──┬──────────────┬────────────────┬─────────────┘
    pull (MCP, all       │              │ app IPC        │ jobs (utility model)
    inject/client        │              │ (panel, Vesta) │
    harnesses)           │              │                │
┌────────────────────────▼───┐   ┌──────▼──────────┐  ┌──▼───────────────────┐
│ vocs-memory (stdio MCP)    │   │  Knowledge panel │  │ bootstrap: docs →    │
│ search · read · related ·  │   │  review queue    │  │ draft pages          │
│ propose · status           │   │  publish         │  │ distill: episodes →  │
└────────────────────────────┘   └─────────────────┘  │ proposals            │
                                                      └──┬───────────────────┘
┌──────────────────────┐   anchors (resolved live)        │ episodes
│ L1 GitNexus (as-is)  │◄─────────────────────────────────┤
│ symbols · flows      │                                  │
└──────────────────────┘                    ┌─────────────▼─────────────┐
                                            │ L3 transcripts + episodes │
                                            │ userData/sessions/*        │
                                            └────────────────────────────┘
```

Four seams:

1. **Pull.** `vocs-memory` is an app-shipped built-in MCP server, materialized per session exactly
   like the GitNexus scope proxy (`src/main/mcp/memory.ts`). It is injected into every harness whose
   MCP capability is `inject` or `client`; Cursor (inherit-only) and the native loop (client not yet
   implemented) do not get it yet. A project with no wiki gets no server at all.
2. **Push.** When a wiki exists and `knowledge.prime` is on (default), a new session's
   `appendSystemPrompt` gains a bounded `<digest>` naming the most useful pages. It never contains
   page bodies, never outranks AGENTS.md, and reaches pi subagent children for free (they inherit
   the parent system prompt).
3. **App surface.** The Knowledge panel and Vesta read the same service, so the panel, the tools and
   the jobs can never disagree about what the wiki says.
4. **Jobs.** One background completion at a time per project, on the `utilityModel`. A job may write
   drafts or proposals; it can never mark a page current, publish, or delete.

## Storage

Local-first, under the project, git-excluded by the existing `.vocs-code/` convention:

```
<projectRoot>/.vocs-code/wiki/
  <kind>/<slug>.md            pages (path = id); repo scope, written by every session
  branches/<branch>/<kind>/…  branch-scope pages, overlaid for a session on that branch
  _proposals/*.md             candidates waiting for a human decision
  _observations/*.jsonl       commit / PR / merge outcomes waiting for distillation
  _evidence.json              claim key → distinct sessions that have seen it
  _rejected.json              claim tombstones, so agents stop refiling a rejection
docs/wiki/                    written only by the explicit Publish action (tracked, committed by the user)
```

Decisions behind this layout:

- **One wiki per project, always in the project root checkout.** Knowledge must never live in a
  session's worktree: a worktree is deleted with its session, and a page written there would be
  lost. Every session — worktree or not — reads and writes `<projectRoot>/.vocs-code/wiki`.
- **Repo scope is the default, branch scope is opt-in.** A discovery made on a feature branch is
  filed against the project (scope `repo`) so every session and every branch sees it; a proposal
  that explicitly says `scope: branch` lands under `branches/<branch>/` and only overlays for
  sessions working that branch. A migration under development can say so without rewriting the
  project's shared understanding — and without its knowledge dying with the worktree.
- **Nothing agent-derived lands in tracked files by default.** The repo's own `AGENTS.md` currently
  carries an *uncommitted* `<!-- gitnexus:start -->` block from `gitnexus analyze`; generated
  knowledge must not add more of that. `Publish` copies reviewed pages to `docs/wiki/`, and the
  commit stays a human act through the normal git flow.
- **Markdown is the only source of truth.** Retrieval is a scored scan over the loaded pages — a
  wiki is tens to low hundreds of files. `KnowledgeService.search()` is the seam where a
  rebuildable FTS index (the `search.db` pattern) or embeddings can go later, once a measured
  retrieval failure asks for them. No vector database until then.
- **No second copy of L1.** Pages may name a file and a symbol in `anchors:`; those are pointers.
  Nothing stores call graphs, symbol lists or line numbers, because the next `gitnexus analyze`
  makes them false.

## Page model

One file, path = id (`conventions/harness-lifecycle.md`), narrow frontmatter subset:

```yaml
---
id: conventions/harness-lifecycle
title: Harness lifecycle
kind: architecture | component | concept | decision | convention | flow | gotcha | testing | migration
status: draft | proposed | current | deprecated | superseded | uncertain
scope: repo | branch
branch: pi/pty-guard              # only when scope: branch
confidence: low | medium | high   # judgement, never a computed score
claim: One sentence that must stay true.       # what proposals are deduped on
keywords: [harness, lifecycle]                 # cheap query expansion instead of embeddings
sources:
  - type: file | doc | commit | transcript | session | url | human
    ref: src/main/session-manager.ts | 4b2020d | s_ab12#u_9
    note: where it was first seen
anchors:
  - file: src/main/session-manager.ts
    symbol: SessionManager.buildContext
related: [mcp/scoping]         # bidirectional at read time; wikilinks also count
supersedes: []
superseded_by: conventions/old
contradicts: []
review_state: reviewed         # unreviewed | reviewed | rejected
reviewed_by: human
updated_at: 2026-09-14T…
evidence_count: 3
---
```

Rules that keep it honest:

- Record only provenance you have; no placeholder fields. `reviewed_by`/`reviewed_at` exist only
  through the review action.
- `status` drives retrieval: `superseded` and `deprecated` pages are never served as current;
  `current` and `uncertain` are; `draft`/`proposed` wait. `knowledge_search` returns the authority
  rung (`human-reviewed`, `accepted`, `proposed`, …) beside every result.
- **Authority ladder:** explicit project rules (AGENTS.md) > human-reviewed page > accepted page >
  proposed page > episodic observation (L3) > model inference. Layer 2 never silently overrides
  AGENTS.md; when the two disagree, the wiki proposes an edit to the rules, and a human decides.
- **Staleness is cheap and visible.** A page whose `file` source changed after `updated_at`, or
  whose source or anchor file disappeared, is flagged in the panel and in `knowledge_status`.
  Supersession is a reviewed transition (`supersedes` on the new proposal), not a heuristic.

## Promotion policy (recorded)

The wiki is easy to generate; keeping it true is the product. The rules:

- **Agents propose, humans decide.** Every harness gets `knowledge_propose`; it writes a file under
  `_proposals/` and nothing else. The panel's Accept/Reject is the only path to `current`.
- **Repeated evidence promotes.** A claim independently seen in ≥ 2 sessions becomes a *proposed
  page* (still not current, still never published). One session's finding waits in the queue.
- **Rejections are remembered.** A rejected claim is tombstoned; the same claim is refused on sight,
  so agents cannot refile it every session.
- **Bootstrap drafts for review.** `Generate from docs` reads README, `docs/*.md`, AGENTS.md and the
  top-level layout, and asks the utility model for at most 12 `status: draft` pages grounded in
  those files. Nothing in the draft state is ever served to an agent: every row carries an
  **Accept** button, opening one offers **Accept as current** / **Discard**, and **Accept all**
  beside Publish takes every pending draft and proposal in one action (deprecated and superseded
  pages are left alone — accepting everything must not resurrect history). Discarding deletes the
  file and tombstones the claim, so the same draft is not regenerated every run.
- **Distillation runs at git boundaries.** Commits, PR opens and merges append an episode; with
  `autoDistill` on (default) the newest episode plus its transcript slice is distilled into up to
  three proposals, which go through the same rules above.
- **Failures are visible, never silent.** Every job records its outcome on the project's status
  (`KnowledgeJobState`): the panel shows running / done / failed with the model name and the error
  instead of a toast that fades. A model that returns no text — a thinking mode that spends the
  whole budget before writing anything — is retried once with double the budget and an explicit
  "JSON only" instruction, and the complete entries of a truncated reply are salvaged rather than
  discarded. Generation needs a configured utility model; the panel says so and disables the
  buttons when there is none.

### "Every PR" in a local app

Vocs Code is a desktop app with no server, so there is no GitHub webhook to hook. The triggers are
the git operations the app already performs and owns:

| Trigger | Hook | Evidence distilled |
| --- | --- | --- |
| `git:commit` | `handlers.ts` after a successful commit | commit subject + output tail |
| `git:pr` (create) | after the PR is opened | base/head + PR URL |
| `git:merge` | after the merge succeeds | merged branch/PR |
| PR detected from another tool | existing `pr`/`merged` status polling | no episode today; the merge hook covers app-driven merges |

Distillation draws on the episode list plus the most recent episode's transcript lines (bounded to
6 000 characters). This is deliberately a trigger on *durable outcomes*, not on every tool call: a
wiki that rewrites itself after every edit turns into noise nobody reviews.

## Retrieval

Five tools, all pull-based and cheap enough to call without thinking:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `knowledge_search` | `query`, `limit?`, `include_historical?` | ranked page summaries: id, title, kind, status, authority, claim, keywords, snippet |
| `knowledge_read` | `page` | full markdown + provenance (sources, anchors, status, authority, evidence) |
| `knowledge_related` | `page` or `path` | related pages by link or shared anchor |
| `knowledge_propose` | `title`, `claim`, `body`, `kind?`, `page_id?`, `keywords?`, `sources?`, `anchors?` | writes a proposal; explains that a human reviews it |
| `knowledge_status` | — | page/servable/proposal counts and the wiki path |
| `session_history_search` | `query`, `limit?`, `include_archived?` | **L3 recall**: earlier attempts, failures and outcomes from this project's past sessions, with redacted snippets. Read-only over the app's `search.db`; degrades to an explanation when the index is absent. |

Every query term must match somewhere (title, keywords, claim, body) — the right default for a
curated corpus, where a page matching half the words is not evidence. Results are ranked by field
weight plus authority; non-servable pages drop out unless `include_historical` is set.

Token discipline: the digest is the only always-on surface and is capped at ~2.4 KB of titles and
paths. The wiki itself costs nothing until an agent asks a question.

## What L2 must not become

- **Not another code index.** No symbols, call graphs, line numbers, file inventories, "current
  API" tables. If `gitnexus analyze` can regenerate it, it does not belong here.
- **Not a transcript dump.** A page must stand alone; a session reference is evidence, not content.
- **Not an auto-rewriter.** No hook edits an accepted page. No scoring engine, no org ontology, no
  cross-project memory in this version.
- **Not a replacement for AGENTS.md.** Explicit rules are the top rung of the ladder.

## Build vs integrate

- **Microsoft LLM Wiki:** no public Microsoft project by that name exists (checked GitHub); the
  "LLM Wiki" pattern is Karpathy's gist, implemented by community projects.
- **`atomicstrata/llm-wiki-compiler`** (MIT, TypeScript, MCP + SDK + CLI + review queues +
  citations + lint/freshness + hybrid retrieval) is the most serious candidate. It was not adopted:
  it owns `.llmwiki/` + `sources/` + `wiki/` inside the user's repo, needs Node ≥ 24 and its own
  provider configuration (duplicating the app's provider store and keys), and knows nothing about
  harnesses, worktrees or GitNexus scope. Its *semantics* (typed pages, review-held candidates,
  citation ranges, freshness lint) are what this design copies. `KnowledgeService.search()` and the
  proposal store are the seam where an external compiler could be plugged in later, through the
  review queue, rather than inside the write path.
- **GitNexus is PolyForm Noncommercial 1.0.0.** It stays a separate process over the user's own
  install; Layer 2 deliberately does not build on its generated wiki (`gitnexus wiki` writes HTML
  into `.gitnexus/wiki/`) or bundle its code.

## Evolution

- **L3 recall is live; L3 capture is next.** `session_history_search` reads the app's existing
  transcript index (`search.db`, read-only, project-scoped, redacted) so any harness can recall "we
  tried this and it failed". What is still missing is *structured* episodes from session end: the
  distillation trigger covers commits, PRs and merges, and a session-end pass (opt-in, same
  guardrails) would widen the evidence without widening the write path.
- **Consolidation.** Repetition detection is in (`_evidence.json`); the next steps are a periodic
  lint (unresolved anchors, changed sources, contradictions) and a merge flow that folds a
  confirmed proposal into an existing page instead of creating a near-duplicate.
- **Branch overlay.** Branch-scope pages are stored, retrieved and overlaid; the remaining work is a
  UI affordance for promoting a branch page into repo scope (and the review step for it).
- **L4.** Scope is already `projectRoot`-keyed and GitNexus has repo groups (currently hidden by
  the scope proxy), so organisational knowledge is another scope with a higher authority rung, not
  a rewrite. Portable export/import (e.g. OKF bundles) is the interop story.

## Open questions

- Should `vocs-memory` be injected even in projects with no wiki, so `session_history_search` (L3)
  works everywhere rather than only where a wiki exists?
- Should the digest prime every new session by default even on a project with a large wiki (cost of
  ~500 tokens/turn), or only when the wiki is small?
- Should distillation run on session end and archive, or only on git outcomes?
- When a `file` source changes, should the page auto-demote to `uncertain`, or only be flagged?
- Should `Publish` open a review diff for `docs/wiki/` instead of copying directly?
