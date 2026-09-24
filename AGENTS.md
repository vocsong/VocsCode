# AGENTS.md

Working agreements for agents in this repo: how to work, what to verify, what to leave alone. Seven harness adapters (Claude Agent SDK, Codex app-server, Codex exec SDK, Cursor, Pi, ACP, native) all emit one normalized `SessionEvent` stream — keep it that way.

This file is loaded by pi and other agents at startup, so it stays short: behavioral rules and pointers only. The memory guide below is the deliberate exception — which layer owns a question decides the opening move of every task, so it earns the space the rest does not. Commands, suites, layout, invariants and conventions live in `docs/` (see [Reference docs](#reference-docs)) — update those docs when those things change.

## Working style

- **Run to done.** Take a task from understanding through edit, verification, and a local commit on the current agent branch. Report when finished; don't stop for approval mid-task unless there's a real fork in the road (ambiguous requirement, destructive action, new dependency).
- **One question at a time.** When the user asks you to ask them questions, ask a single question and wait for the answer before asking the next; never batch several into one prompt.
- **Verification bar.** Every change must pass `npm run typecheck`, `npm test`, and `npm run build` before the commit, then the narrowest relevant integration tier. A skipped suite is not verification: confirm the requested tests actually executed, and report unavailable runtimes, credentials, or platforms rather than silently accepting skips. Never stub a live suite into passing. Commands and the change → suite table: [docs/TESTING.md](docs/TESTING.md).
- **Regression coverage.** Behavior changes need a test that fails before the fix and passes after it. Assert user-visible outcomes and production boundaries, not merely helper return values or implementation details; an assertion hidden in `.catch()` is invalid because unexpected success can pass. Prefer exact terminal states/counts where duplication, retries, or partial writes are risks.
- **High-risk paths carry extra coverage.** Session lifecycle, permission gating, IPC handlers, persistence and adapter changes each have a required test shape — see [docs/TESTING.md](docs/TESTING.md#coverage-rules-for-high-risk-paths).
- **E2E discipline.** E2E upkeep ships with the change, never as a follow-up: if the task adds, renames, moves or removes anything a suite drives (an entry point, a control, a panel, a whole flow), update the matching suite in the same PR and do not open or merge the PR until it passes. A new user-visible flow that no suite covers needs a new one; "the existing suites still pass" is not enough when the feature they should cover is untested. Mechanics — suite list, selectors, shared steps, restart claims: [docs/TESTING.md](docs/TESTING.md#keeping-the-suites-alive).
- **Stay in scope.** Surgical by default: change only what the task needs. Trivial adjacent problems are fair game to fix inline (a typo, an obvious bug, a missing type in a file you are already editing). Anything larger — a refactor, a rename, an unrelated fix — goes in the report as a note, not the diff.
- **Dependencies.** Never add a runtime dependency without asking first. Dev-only tooling and new source files are fine when the task needs them.
- **UI is open.** No mandated reuse rule: build new components and patterns when they are the better fit. The primitives in `components/ui.tsx` and the CSS variables in `styles.css` are available, not required. A UI library is still a runtime dependency — ask first.
- **No AI attribution in commits.** Never append `Co-Authored-By` or "Generated with …" trailers. Every commit is authored and committed under the git identity of the person running the session, exactly as their `git config` resolves it; never substitute another name with `-c user.*`, `--author` or `GIT_AUTHOR_*`/`GIT_COMMITTER_*`. `.claude/settings.json` pins `includeCoAuthoredBy: false`, and `CLAUDE.md` imports this file — keep both if the harness list changes.
- **Git history.** Work on your own agent branch (`<agent>/<slug>`, e.g. `pi/<slug>`). Rebase or force-push your own agent branch freely. Never rewrite `develop` or `master` history, and never force-push a branch you did not create (the permission gate still prompts for force-push below Full access).
- **PR titles feed releases.** A one-commit PR must carry the Conventional Commits title on the commit itself, because the squash takes the commit subject; a multi-commit PR only needs it on the PR title. The `develop` → `master` ship PR is rebase-merged. Rules, prefix effects and why: [docs/RELEASING.md](docs/RELEASING.md#conventions-that-feed-the-bot).
- **Report tight.** The final write-up — and the PR description — is a short structured report, same shape every time, bullets only, no process narration:
  - **Task** — one-line recap of the original task as it was asked, so the report stands alone.
  - **Done** — what was delivered in outcome terms: decisions taken and why, anything done beyond the literal ask. Tight bullets; no process narration and no file-by-file recap (that is **Files**).
  - **Files** — files touched, grouped by what changed and why.
  - **Verification** — the exact commands run and their results (pass/fail); name anything that could not be run and why.
  - **PR** — merge status: merged into `develop` with the PR link, or left open for review with the reason it was not merged.
  - **Notes** — additional information for the reader to take note of: anything spotted but deliberately not fixed, out of scope, or left for follow-up. Not a recap of the work; omit if empty.
- **Deliver a PR — and merge it.** After the local commit, push the agent branch and open a PR into `develop`. By default, merge the PR yourself once verification passes (`develop` is the integration branch; releases ship from `develop` → `master`). Skip merging only when the user explicitly says to hold the PR for review, or when the change needs further consideration before it lands (touching permission gating or secrets handling, skipping a required verification run, an ambiguous requirement the user hasn't confirmed, or a destructive action). When you don't merge, say so in the report and why, and leave the PR open for review.

## Memory — you have three layers

Most questions here are already answered somewhere. Find the layer that owns the question
before you grep, read widely, or infer. Authority runs highest to lowest: **AGENTS.md →
reviewed wiki page → accepted → proposed → session history → your own inference.** Never
override a higher layer silently.

**L1 — the code graph.** What the code does right now: the repo indexed as symbols and the
relationships between them.
*When:* anything structural — where a symbol lives, what calls it, how a flow is wired end
to end, what a change or rename would break. Text search cannot answer those.
*How:* three steps, in order. `query` with the concept plus `task_context` to find the area.
`context` on one symbol — pass the `uid` from the query result, not the name, so a common
name cannot resolve to the wrong thing. `impact` with `direction: "upstream"` before you edit:
`d=1` will break, `d=2` probably. Pass `include_content: true` rather than re-reading the
file. Never pass `repo` — the repo is already scoped. The index is a snapshot; when it
disagrees with the working tree, trust the tree and say a re-index is due.
*Example — adding MFA to login:*
```
query({ query: "user login validation", task_context: "adding MFA" })
  → flow: handleLogin → validateUser → issueSession, with uids
context({ uid: "<validateUser uid from that result>" })
  → 9 callers, 2 of them in other modules
impact({ target: "validateUser", direction: "upstream" })
  → d=1: the 9 callers. Those are the edits; now write the code.
```

**L2 — the project wiki.** What the project means: intent, decisions and invariants — what
indexing can never regenerate.
*When:* before changing an invariant, an architecture decision or a convention, and whenever
*why is it like this* matters more than *what is it*.
*How:* `knowledge_search` with words that appear in the page (every term must match, so keep
it to two or three). Read the hit with `knowledge_read({ page })` — it carries the authority
rung and provenance, so you can see whether a human reviewed it. `knowledge_related` follows
the thread from a page or a file path. When you learn something durable — a decision, a
constraint, a gotcha that outlives this task — file it with `knowledge_propose` and cite the
evidence. That writes the page immediately — no draft, no queue, nothing waiting on a human:
it lands as `current` (rung `accepted`), ranked below any page a human reviewed or wrote.
*Example — about to add a cache in front of the session store:*
```
knowledge_search({ query: "session state store" })
  → "One store owns session state" · human-reviewed
knowledge_read({ page: "architecture/one-store-owns-session-state" })
  → a second cache was tried and rejected; it split ownership on restart.
Drop the cache, extend the store.
```

**L3 — session history.** What happened here before: the record of earlier sessions in this
project.
*When:* a bug, flake or dead end feels familiar, or before re-deriving something an earlier
session already settled.
*How:* `session_history_search` with distinctive words — an error string, a test name, a
symbol. Hits are past events, not project truth: confirm against the code before acting, and
never let them outrank L2 or AGENTS.md.
*Example — a test fails only on Windows:*
```
session_history_search({ query: "windows path separator test" })
  → a session last month traced it to a hardcoded "/" in the fixture.
Check that line first instead of re-bisecting.
```

Grep and reading files are the fallback, not the opening move: for files you already know,
for strings, comments, config and docs, and for anything newer than the index.

## Reference docs

| Doc | What's in it |
| --- | --- |
| [docs/TESTING.md](docs/TESTING.md) | Dev commands, offline/opt-in/live suites, the change → suite table, coverage rules, packaging gotchas |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Source layout, layering and invariants, harness matrix, adding a harness, permission mapping |
| [docs/MEMORY.md](docs/MEMORY.md) | Layer 2 memory: the project wiki, its provenance and review rules, the MCP tools, and the L1–L4 boundary |
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | Language and formatting, file layout, commit messages, what never gets committed |
| [docs/RELEASING.md](docs/RELEASING.md) | Branch model, PR titles and squash rules, release-please, CI build |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Logs and environment variables |
| [docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md), [docs/REMOTE-ACCESS-ROADMAP.md](docs/REMOTE-ACCESS-ROADMAP.md) | Remote-access design and decisions of record; the working backlog — what is live, what is not, what is next |
