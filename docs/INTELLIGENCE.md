# Local Knowledge and Memory

Open a session, then **Knowledge** in the right panel (Standard or Zen). The **Knowledge** view still browses, reviews, rejects and publishes the project wiki. The other views are local desktop controls:

| View | What you can do |
| --- | --- |
| **Memory** | Record a lesson, procedure or declared preference; review candidates; reflect on a session; promote, revoke or forget a record; export and import project memory. |
| **Collections** | See the current project identity and choose which known local projects may share knowledge. Membership starts with promoted records only. Enabling wiki sharing exposes current project wiki claims, not branch pages, source bodies or other sessions' transcripts. |
| **Evidence** | Search this project, or explicitly look across its collections. Compile a bounded packet with citations, history, missing providers, stale evidence and known conflicts. |
| **Sources** | Manage the tool gateway, collection search, personal recall, reflection and the built-in Graphify index. |

## What to trust

- **AGENTS.md and explicit user rules come first.** Use GitNexus and the working tree for current code structure. Neither Graphify nor memory replaces source verification.
- **Markdown is still the project wiki.** Existing pages, branch overlays, and rejection tombstones stay under `<project>/.vocs-code/wiki`. Publishing to `docs/wiki/` remains explicit. Upgraded pages can carry source/verification metadata; old pages still load without being rewritten on read.
- **A record of what happened is not a current fact.** Captured episodes and agent-derived candidates remain historical. A resolving commit is a citation, not proof of the claim. Agents may record local observations; they cannot replace the text or claim of a human-reviewed page. A differing proposal is filed for review instead.
- **Verify before sharing.** Agents can request promotion, but the desktop owner reviews the snapshot before it is shared. Collection recipients see the promoted text and source attribution, not private attachments or transcripts. Revocation removes that guidance from retrieval; Forget also deletes the memory record and its index entry and blocks automatic re-capture. The original transcript or a separately published wiki page is a different source and is not deleted by Forget.

## Privacy and storage

Project IDs, collection memberships and pending promotions live in the desktop profile (`userData/intelligence`), alongside the SQLite memory ledger and its derived search index. Project identity is local and stable across a repository's linked worktrees. It is not an account identity; matching a repository name is not permission to share. Project-only retrieval does not fan out. Personal recall is off by default; preferences are declared by the user, never inferred during reflection. The project export is a local JSON file and excludes personal and collection records, the transcript index and graph caches. An import does not carry the authority of the exporting user.

## What works in the background

- **Start with wiki context.** A new session gets a bounded project wiki digest when wiki priming is enabled. Memory and history are retrieved when the agent calls the scoped tools or you search **Evidence**; the app does not inject past conversations into every turn.
- **Learn locally.** **Sources → Session reflection** defaults to **Local learning** when no mode was saved. A completed ordinary user turn can leave a short lesson or work outcome, cited to its reply, in **Memory**. The app observes new saved turns; it does not scan or backfill old sessions. It takes at most 12 observations per session and does not copy prompts, tool output or thinking. It skips plans, managed and controller-created sessions, and ambiguous or unfinished turns. Secret-pattern filtering is best-effort, not a guarantee.
- **Keep observations separate from guidance.** Passive notes appear in desktop **Memory** and **Evidence**. They are withheld from agent memory tools until the owner verifies them, and are never added to the wiki digest or shared automatically. **Forget** blocks recapture from the same turn without deleting the transcript. Clearing, rewriting, or deleting the source transcript removes unreviewed passive notes whose cited replies are gone.

Saved modes are respected. **Off** stops new capture and reflection without deleting existing records. **Only when asked** uses the **Reflect** button. **Model-assisted on archive or merge** preserves the opt-in session-end behavior. Both model-assisted paths can send a bounded, redacted transcript excerpt only to the explicitly selected, usable utility model. The wiki's documentation and git-boundary jobs have separate settings; they also require an explicitly selected utility model to run automatically.

## Tools and rollback

Supported harnesses get the `vocs-memory` built-in. With the gateway enabled, the stdio process forwards calls to the desktop through a short-lived loopback capability bound to its session and checkout. It can recall project history even before a wiki exists. The six original tools remain available, along with `intelligence_search`, `intelligence_trace`, `knowledge_record`, `knowledge_promote`, `memory_recall` and `context_compile`. Plan-mode sessions can read but not record or request promotion. The native desktop owns durable forget, approval, membership and configuration actions. Managed Mission workers are not given a memory gateway; paired web clients have no intelligence-management channels.

Stopping a runtime revokes its capability; expiry requires a fresh runtime. A refused or unavailable gateway never downgrades a live client to a disk reader. Explicitly disable the gateway in **Sources**, then restart the session, to use the standalone six-tool implementation for a project that has a wiki. This rollback does not remove or modify the new ledger. Built-in switches in the MCP panel still control injection.

## Built-in Graphify

Desktop installers include a private, pinned Graphify (`graphifyy==0.9.115`) and Python runtime. Users do not install Python, install a separate MCP server, or download the worker at first use. Vocs Code uses only local AST extraction. Both **Evidence** and the built-in `vocs-memory` tools (`intelligence_search`, `intelligence_trace`, `context_compile`) read the same app-owned cache; neither launches Python on a query.

Graphify defaults on. Opening a supported local Git checkout in an ordinary desktop session queues a background index. Switching sessions in the same checkout reuses the queued or running job. Vocs Code checks that open checkout for new commits; it does not crawl all registered projects. The input is bounded, committed source code, not untracked files, unsaved edits, transcripts, `.vocs-code`, submodules or linked files. No provider keys, model calls, Git hooks or repository writes are needed. Graph citations refer to the indexed commit, not to dirty changes on disk, and remain derived evidence, not reviewed guidance.

Under **Sources**, disable Graphify globally or for one project; existing saved global off choices remain off. Disabling it stops automatic indexing and graph retrieval. **Refresh index** retries a build, and **Clear cache** only removes the derived cache (a later refresh can rebuild it). A missing worker or stale revision is visible without disabling Wiki, Memory or History.

Built-in indexing does not enable semantic/cloud enrichment, OpenBrain import, embeddings or cross-device/organization sharing. GitNexus remains a separate specialist tool; the Evidence view does not run GitNexus impact or call-graph queries on the agent's behalf. See the [proposal](UNIFIED-KNOWLEDGE-MEMORY-PROPOSAL.md) for the longer-term design and [testing](TESTING.md) for verification.
