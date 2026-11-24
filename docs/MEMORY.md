# Project knowledge — Layer 2 memory

Vocs Code carries four kinds of memory. This document defines the second one, what it may and may
not contain, and how the four stay out of each other's way. For the desktop memory ledger,
scoped evidence, collections and the built-in Graphify index, see [Local Knowledge and Memory](INTELLIGENCE.md).

| Layer | Question | Owner | Lifetime |
| --- | --- | --- | --- |
| **L1 structural** | What does the code currently do? | GitNexus (built-in MCP server) | Rebuilt by indexing |
| **L2 project knowledge** | What does this project mean, why is it designed this way, what must stay true? | **this feature** — `.vocs-code/wiki/*.md` | Ingested automatically, corrected by hand, versioned in git |
| **L3 episodic** | What happened while agents worked here? | `userData/sessions/*` + the FTS index | Append-only, private, disposable |
| **L4 organisational** | What does the wider organisation know? | not built | future scope |

The one-line distinction: **GitNexus answers "what exists"; Layer 2 answers "what does it mean",
and never the other way around.** Anything GitNexus can regenerate by indexing is not L2 content.
Anything that only makes sense with "in session X we found…" is L3, not L2.

## What ships today

| Piece | Where |
| --- | --- |
| Markdown wiki store, tombstones, scan ledger, relation graph, evidence ledger, episodes, publish | `src/main/knowledge/store.ts` |
| Scored + graph-aware retrieval, digest, ingestion, authority, jobs facade | `src/main/knowledge/service.ts` |
| Bootstrap, distillation and PR-reflection prompts (utility model) | `src/main/knowledge/synth.ts`, `knowledge/llm.ts` |
| Shared schema, frontmatter codec, digest renderer | `src/shared/knowledge.ts` |
| `vocs-memory` stdio MCP client (six aliases plus scoped tools) | `resources/mcp/vocs-memory.mjs`, `src/main/intelligence/gateway.ts` |
| Built-in server registration + per-repo switches | `src/main/mcp/memory.ts`, `src/main/mcp/index.ts` |
| Knowledge panel (browse · search · reject/delete · publish) | `src/renderer/src/components/KnowledgeTab.tsx` |
| Live anchor resolution | `src/main/knowledge/anchors.ts` — each page anchor is checked against GitNexus when the detail view opens |
| Session history recall (L3) | `session_history_search` in `resources/mcp/vocs-memory.mjs`, scoped to the project and redacted |
| Session priming | `SessionManager.create` → `SessionMeta.knowledgeDigest` (system prompt, else first-turn preamble) |
| Git boundaries → episodes → distillation / reflection | `src/main/handlers.ts` (`git:commit`, `git:pr`, `git:merge`) |

## Architecture

```
                      ┌────────────────────────────────────────────────────┐
                      │        KnowledgeService (src/main/knowledge)       │
                      │  view · search · ingest · digest · reject ·        │
                      │  publish · recordEpisode · generate · reflect      │
                      └──┬──────────────┬────────────────┬─────────────────┘
    pull (MCP, all       │              │ app IPC        │ jobs (utility model)
    inject/client        │              │ (panel, Vesta) │
    harnesses)           │              │                │
┌────────────────────────▼───┐   ┌──────▼──────────┐  ┌──▼─────────────────────┐
│ vocs-memory (stdio MCP)    │   │  Knowledge panel │  │ bootstrap: repo docs → │
│ search · read · related ·  │   │  browse · search │  │ pages (scan ledger)    │
│ history · propose · status │   │  reject/delete · │  │ distill: episodes →    │
└────────────────────────────┘   │  publish         │  │ pages                  │
                                 └──────────────────┘  │ reflect: PR commits +  │
                                                       │ bounded diff → pages   │
                                                       └──┬───────────┬─────────┘
                                                          │ pages     │ episodes
                                       ┌──────────────────▼────────┐  │
                                       │ relation graph (derived)  │  │
                                       │ _graph.json · lexical →   │  │
                                       │ 1–2 hop → rank by         │  │
                                       │ relevance·centrality·     │  │
                                       │ authority·recency         │  │
                                       └───────────────────────────┘  │
┌──────────────────────┐   anchors (resolved live)                    │
│ L1 GitNexus (as-is)  │◄─────────────────────────────────────────────┤
│ symbols · flows      │                                             │
└──────────────────────┘                   ┌─────────────────────────▼───┐
                                           │ L3 transcripts + episodes   │
                                           │ userData/sessions/*         │
                                           └─────────────────────────────┘
```

Five seams:

1. **Pull.** `vocs-memory` is an app-shipped built-in MCP server, materialized per session exactly
   like the GitNexus scope proxy (`src/main/mcp/memory.ts`). It is injected into every harness whose
   MCP capability is `inject` or `client`. Cursor does not get it (inherit-only, file export); pi
   subagent children do, over the parent's connections, unless their agent definition sets
   `mcp: false` — which the shipped Explore and Plan templates do. The gateway can recall history
   without a wiki. Only explicit legacy mode requires a wiki.
2. **Push.** When a wiki exists and `knowledge.prime` is on (default), a new session gains a bounded
   `<digest>` naming the most useful pages. It never contains page bodies and never outranks
   AGENTS.md. A harness with a system prompt (pi, Claude, native) gets it through
   `appendSystemPrompt`; the four that have none (Codex app-server, Codex exec, Cursor, ACP) get it
   as a once-per-session preamble on the first turn instead — the same mechanism a cross-harness
   fork uses, so the transcript still records only what the user typed. pi subagent children get it
   for free, inheriting the parent system prompt.
3. **App surface.** The Knowledge panel and Vesta read the same service, so the panel, the tools and
   the jobs can never disagree about what the wiki says.
4. **Jobs.** One background completion at a time per project, on the `utilityModel`. A job ingests
   pages as `current`, distills an episode, or reflects a PR over the existing wiki. It never
   deletes, never publishes to `docs/wiki/`, and never refiles a tombstoned claim.
5. **Graph.** Every page write recompiles `_graph.json` from page frontmatter, anchors, labels and
   wikilinks; retrieval expands over it after the lexical match. The graph is derived, so it can be
   deleted and rebuilt without touching a page.

## Storage

Local-first, under the project, git-excluded by the existing `.vocs-code/` convention:

```
<projectRoot>/.vocs-code/wiki/
  <kind>/<slug>.md            pages (path = id); repo scope, written by every session
  branches/<branch>/<kind>/…  branch-scope pages, overlaid for a session on that branch
  _scan.json                  docs scan ledger: file → mtime + size at the last scan
  _graph.json                 derived relation graph (rebuildable, git-ignored)
  _proposals/…                Markdown drafts awaiting review, separate from current pages
  _observations/*.jsonl       commit / PR / merge outcomes waiting for distillation
  _evidence.json              claim key → distinct sessions that have seen it
  _rejected.json              claim tombstones, so a job stops refiling a rejection
  _write.lock/                app/MCP cross-process write mutex (normally absent)
docs/wiki/                    written only by the explicit Publish action (tracked, committed by the user)
```

Decisions behind this layout:

- **One wiki per project, always in the project root checkout.** Knowledge must never live in a
  session's worktree: a worktree is deleted with its session, and a page written there would be
  lost. Every session — worktree or not — reads and writes `<projectRoot>/.vocs-code/wiki`.
- **Repo scope is the default, branch scope is opt-in.** A discovery made on a feature branch is
  filed against the project (scope `repo`) so every session and every branch sees it; an ingested
  page that explicitly says `scope: branch` lands under `branches/<branch>/` and only overlays for
  sessions working that branch. A migration under development can say so without rewriting the
  project's shared understanding — and without its knowledge dying with the worktree.
- **Nothing agent-derived lands in tracked files by default.** The repo's own `AGENTS.md` currently
  carries an *uncommitted* `<!-- gitnexus:start -->` block from `gitnexus analyze`; generated
  knowledge must not add more of that. `Publish` copies pages to `docs/wiki/`, and the commit stays
  a human act through the normal git flow.
- **Markdown is the only source of truth; the graph is derived.** Retrieval is a scored scan over
  the loaded pages, expanded over a rebuildable `_graph.json` compiled from those same pages —
  deleting the graph costs one rebuild. A wiki is tens to low hundreds of files.
  `KnowledgeService.search()` is the seam where a rebuildable FTS index (the `search.db` pattern) or
  embeddings can go later, once a measured retrieval failure asks for them. No vector database until then.
- **No second copy of L1.** Pages may name a file and a symbol in `anchors:`; those are pointers.
  Nothing stores call graphs, symbol lists or line numbers, because the next `gitnexus analyze`
  makes them false.

### Concurrent writes and recovery

The app and standalone MCP processes share a project-wide filesystem mutex (`_write.lock/`,
acquired with atomic directory creation). Proposal identity checks, fresh metadata merges and page
replacement all happen while holding it. A call-start page snapshot, retrieval scan limit or cached
mtime is never an overwrite guard. Explicit-id updates participate in the same boundary. Pages use
unique sibling temp files plus rename, so a failed write or crashed writer cannot expose half a page.

Writers wait at most five seconds for a busy lock, then fail without taking it over. **Locks are never
automatically deleted for age or an apparently dead PID:** a paused writer must not resume into
another owner's critical section. After a crash, stop **all** app and MCP writers for that project,
inspect the wiki and remove only its abandoned `_write.lock/` directory before retrying. Leftover
`*.tmp` siblings are not pages and may also be removed while every writer is stopped. Do not remove
a lock while another session may still be writing. The lock coordinates Vocs writers, not arbitrary
external editors; stop them too before repairing damaged page files.

## Page model

One file, path = id (`conventions/harness-lifecycle.md`), narrow frontmatter subset:

```yaml
---
id: conventions/harness-lifecycle
title: Harness lifecycle
kind: architecture | component | concept | decision | convention | flow | gotcha | testing | migration
status: current | deprecated | superseded | uncertain | draft | proposed
scope: repo | branch
branch: pi/pty-guard              # only when scope: branch
confidence: low | medium | high   # judgement, never a computed score
claim: One sentence that must stay true.       # what ingestion dedupes on
keywords: [harness, lifecycle]                 # cheap query expansion instead of embeddings
labels: [harness, lifecycle]                   # normalized tags; matched directly and by graph edges
sources:
  - type: file | doc | commit | transcript | session | url | human
    ref: src/main/session-manager.ts | 4b2020d | s_ab12#u_9
    note: where it was first seen
anchors:
  - file: src/main/session-manager.ts
    symbol: SessionManager.buildContext
related: [mcp/scoping]         # authored edge; wikilinks also count
supersedes: []
superseded_by: conventions/old
contradicts: []
review_state: unreviewed        # unreviewed | reviewed | rejected
reviewed_by: human              # present only after a human reviews or edits the page
updated_by: agent:bootstrap     # human:<name> when a human wrote it; agent:<job> when ingested
updated_at: 2026-09-14T…
evidence_count: 3
---
```

Rules that keep it honest:

- Record only provenance you have; no placeholder fields. `reviewed_by`/`reviewed_at` exist only
  once a human reviews or edits a page; `updated_by` distinguishes a human write from an ingested one.
- `status` drives retrieval: `superseded` and `deprecated` pages are never served as current;
  `current` and `uncertain` are; review-only drafts live separately from the ordinary page view.
  `knowledge_search` returns the authority rung (`human-reviewed`, `auto-current`, `uncertain`, …)
  beside every result.
- **Authority ladder:** explicit project rules (AGENTS.md) > human-reviewed page > auto-current page
  > episodic observation (L3) > model inference. Layer 2 never silently overrides AGENTS.md; when
  the two disagree, the wiki carries a page that proposes an edit to the rules, and a human decides.
- **Staleness is cheap and visible.** A page whose `file` source changed after `updated_at`, or
  whose source or anchor file disappeared, is flagged in the panel. Supersession is an authored
  transition (`supersedes` on the newer page), not a heuristic.
- **Anchors are checked live, never stored.** The detail view asks GitNexus about every symbol the
  page names and shows `resolved` (with the current line range and a "Now in …" note when the symbol
  moved files), `unresolved`, or `not checked` when GitNexus is off or the repo is unindexed. A
  file-only anchor is answered from disk. Results are cached for five minutes; the page itself still
  holds nothing but the pointer. Agents resolve anchors the same way they resolve anything else — by
  calling GitNexus themselves.

## Labels and the relation graph

- **`labels` is normalized frontmatter.** A small tag vocabulary carried by every page, matched
  directly by retrieval and used to derive graph edges between pages that share a tag.
- **`_graph.json` is derived, never authored.** Each page write (and each explicit rebuild) compiles
  the wiki into nodes plus edges. The file is git-ignored and deleting it costs one rebuild:
  markdown stays the single source of truth, the graph is regenerated, never migrated.
- **Edge types.** Authored edges come from frontmatter: `related`, `supersedes`, `contradicts`.
  Derived edges come from shared GitNexus anchors, shared labels, and wikilinks in the body.
- **Graph-aware retrieval.** A query matches lexically first (title, labels, keywords, claim, body),
  then expands 1–2 hops over the graph, then ranks the candidates by relevance, centrality,
  authority and recency.

## Automated ingestion

The wiki is easy to generate; keeping it true is the product. The rules:

- **Use drafts for passive learning.** During an ordinary task, an agent can check a durable lesson
  against current code, docs or tests and file `knowledge_record` with `draft: true`. It creates a
  separate Markdown draft for desktop review, not guidance. Drafts cite files or commits, never a
  transcript. Legacy `knowledge_propose` and generated pages still use current-page ingestion and
  rank below human-reviewed pages.
- **Tombstones and collision-safe identity.** A rejected claim is recorded in `_rejected.json`;
  the same claim is refused on sight, so a job cannot refile it every scan. Rejection retains its
  conservative case/punctuation-insensitive match, checked against the full stored claim rather
  than only its lookup hash; that broader refusal never grants permission to overwrite. Without an explicit
  `pageId` (app) / `page_id` (MCP), an existing generated id may only be updated for the same full
  claim with whitespace folded. Case, punctuation and Unicode remain meaningful (`C++` is not
  `C#`, and an identifier's case can change its meaning); a hash, substring or truncated prefix
  is not proof. Unrelated claims with the same title, normalized slug or truncated slug fail with
  a clear error and leave pages, evidence and supersession untouched. Choose a different title for
  a new page, or pass the existing id explicitly for an intentional claim change. Same-claim repeats
  keep one page and merge evidence; explicit updates preserve creation time and merge provenance.
- **Review changes authority, not recall.** The panel can mark a draft reviewed to make it current,
  or reject it to tombstone the claim. Existing pages can be corrected, rejected, deleted or explicitly
  published to `docs/wiki/`. Neither recall nor draft creation publishes anything.
- **Bootstrap is recursive and incremental.** With an explicitly selected, usable utility model, priming an empty wiki can schedule a seed without waiting for the model. Deliberate `Generate from docs` walks *every* markdown
  file in the repository — skipping `node_modules/`, `.git/`, `dist/`, `build/`, `vendor/`,
  `.vocs-code/`, `.gitnexus/`, `CHANGELOG` and `LICENSE` — maps each batch through the utility model,
  then synthesises the batches into pages. It is incremental: `_scan.json` keeps each file's mtime
  and size, and only files that changed since the last scan are re-read.
- **Distillation runs at git boundaries.** Commits, PR opens and merges append an episode; with
  `autoDistill` on (default) and an explicitly selected, usable utility model, the newest episode plus
  its transcript slice is distilled into pages, which are ingested by the same automatic path.
- **PR reflection uses the same automatic model requirement.** A PR's commits and a bounded diff are read against
  the pages that already exist; the job updates the pages the diff touches and adds the ones it is
  missing, then ingests them. Reflection is what keeps the wiki current with code the recursive docs
  scan never saw.
- **Failures are visible, never silent.** Every job records its outcome on the project's status
  (`KnowledgeJobState`): the panel shows running / done / failed with the model name and the error
  instead of a toast that fades. A model that returns no text — a thinking mode that spends the
  whole budget before writing anything — is retried once with double the budget and an explicit
  "JSON only" instruction, and the complete entries of a truncated reply are salvaged rather than
  discarded. Generation needs a configured utility model; the panel says so and disables the
  buttons when there is none.

### Ingest triggers in a local app

Vocs Code is a desktop app with no server, so there is no GitHub webhook to hook. The triggers are
the git operations the app already performs and owns:

| Trigger | Hook | Evidence ingested |
| --- | --- | --- |
| `git:commit` | `handlers.ts` after a successful commit | commit subject + output tail |
| `git:pr` (create) | after the PR is opened | base/head + PR URL; the PR's commits and a bounded diff are reflected over the existing wiki |
| `git:merge` | after the merge succeeds | merged branch/PR |
| PR detected from another tool | existing `pr`/`merged` status polling | no episode today; the merge hook covers app-driven merges |

Distillation draws on the episode list plus the most recent episode's transcript lines (bounded to
6 000 characters); reflection draws on the PR's commits and a bounded diff. This is deliberately a
trigger on *durable outcomes*, not on every tool call: a wiki that rewrites itself after every edit
turns into noise.

## Retrieval

Six compatibility tools. The new scoped tools are described in [Local Knowledge and Memory](INTELLIGENCE.md):

| Tool | Arguments | Returns |
| --- | --- | --- |
| `knowledge_search` | `query`, `limit?`, `include_historical?` | ranked page summaries: id, title, kind, status, authority, claim, keywords, labels, snippet |
| `knowledge_read` | `page` | full markdown + provenance (sources, anchors, status, authority, evidence) |
| `knowledge_related` | `page` or `path` | related pages by link, shared anchor, shared label or graph edge |
| `knowledge_propose` | `title`, `claim`, `body`, `kind?`, `page_id?`, `keywords?`, `sources?`, `anchors?` | saves the claim straight into the wiki as a `current` page (`updated_by: agent:*`); a rejection is remembered, not reviewed |
| `knowledge_status` | — | page/servable/rejected counts and the wiki path |
| `session_history_search` | `query`, `limit?`, `include_archived?` | **L3 recall**: earlier attempts, failures and outcomes from this project's past sessions, with redacted snippets. Read-only over the app's `search.db`; degrades to an explanation when the index is absent. |

Every query term must match somewhere (title, labels, keywords, claim, body) — the right default for
a curated corpus, where a page matching half the words is not evidence. Retrieval is lexical match →
1–2 hop graph expansion → rank by relevance + centrality + authority + recency; non-servable pages
drop out unless `include_historical` is set.

Token discipline: the digest is the only always-on surface and is capped at ~2.4 KB of titles and
paths. The wiki itself costs nothing until an agent asks a question.

## What L2 must not become

- **Not another code index.** No symbols, call graphs, line numbers, file inventories, "current
  API" tables. If `gitnexus analyze` can regenerate it, it does not belong here.
- **Not a transcript dump.** A page must stand alone; a session reference is evidence, not content.
- **Not an unbounded rewriter.** Ingestion writes and updates pages automatically, but it never
  deletes, never edits AGENTS.md, never refiles a tombstoned claim, and never touches `docs/wiki/` —
  Publish is an explicit act. Cross-project retrieval belongs to a separate collection grant,
  not to the wiki store or ingestion jobs.
- **Not a replacement for AGENTS.md.** Explicit rules are the top rung of the ladder.

## Build vs integrate

- **Microsoft LLM Wiki:** no public Microsoft project by that name exists (checked GitHub); the
  "LLM Wiki" pattern is Karpathy's gist, implemented by community projects.
- **`atomicstrata/llm-wiki-compiler`** (MIT, TypeScript, MCP + SDK + CLI + citations + lint/freshness
  + hybrid retrieval) is the most serious candidate. It was not adopted: it owns `.llmwiki/` +
  `sources/` + `wiki/` inside the user's repo, needs Node ≥ 24 and its own provider configuration
  (duplicating the app's provider store and keys), and knows nothing about harnesses, worktrees or
  GitNexus scope. Its *semantics* (typed pages, citation ranges, freshness lint) are what this
  design copies. `KnowledgeService.search()` and the ingestion write path are the seam where an
  external compiler could be plugged in later, rather than inside the retrieval call.
- **GitNexus is PolyForm Noncommercial 1.0.0.** It stays a separate process over the user's own
  install; Layer 2 deliberately does not build on its generated wiki (`gitnexus wiki` writes HTML
  into `.gitnexus/wiki/`) or bundle its code.

## Evolution

- **L3 recall and capture.** `session_history_search` reads the app's existing transcript index
  (`search.db`, project-scoped, redacted). Local learning observes newly completed ordinary turns and
  keeps short cited work outcomes and lesson candidates in the separate project memory ledger, never
  in the wiki or digest. The scoped agent tools can retrieve a few relevant ones as unverified
  history; they don't enumerate them without a query. Model-assisted session reflection remains separate. See [Local Knowledge
  and Memory](INTELLIGENCE.md#what-works-in-the-background) for defaults and controls.
- **Consolidation.** Repetition detection is in (`_evidence.json`); the next steps are a periodic
  lint (unresolved anchors, changed sources, contradictions) and a merge flow that folds a duplicate
  auto-ingested page into an existing one instead of keeping a near-duplicate.
- **Branch overlay.** Branch-scope pages are stored, retrieved and overlaid; the remaining work is a
  UI affordance for promoting a branch page into repo scope.
- **L4.** Explicit local collections can share selected project knowledge. Organizational and
  account-bound memory remain unimplemented; collection membership does not imply either.



## Open questions

- Should the digest prime every new session by default even on a project with a large wiki (cost of
  ~500 tokens/turn), or only when the wiki is small?
- Should distillation run on session end and archive, or only on git outcomes?
- When a `file` source changes, should the page auto-demote to `uncertain`, or only be flagged?
- Should `_graph.json` rebuild on every page write, or lazily on the first query that needs it?
