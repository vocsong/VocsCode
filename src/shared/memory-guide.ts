/**
 * The AGENTS.md snippet the MCP panel offers for copying: how an agent should use the three
 * memory layers this app serves — GitNexus (L1), the project wiki (L2) and session history (L3).
 *
 * Kept as data in `src/shared` so the panel, the tests and any future harness-side injection read
 * one source. Tool names here are the bare MCP names, which every harness prefixes its own way.
 * Written as lines rather than a template literal because the text is dense with backticks.
 */
const LINES = [
  '## Memory — you have three layers',
  '',
  'Most questions here are already answered somewhere. Find the layer that owns the question',
  'before you grep, read widely, or infer. Authority runs highest to lowest: **AGENTS.md →',
  'reviewed wiki page → accepted → proposed → session history → your own inference.** Never',
  'override a higher layer silently.',
  '',
  '**L1 — the code graph.** What the code does right now: the repo indexed as symbols and the',
  'relationships between them.',
  '*When:* anything structural — where a symbol lives, what calls it, how a flow is wired end',
  'to end, what a change or rename would break. Text search cannot answer those.',
  '*How:* three steps, in order. `query` with the concept plus `task_context` to find the area.',
  '`context` on one symbol — pass the `uid` from the query result, not the name, so a common',
  'name cannot resolve to the wrong thing. `impact` with `direction: "upstream"` before you edit:',
  '`d=1` will break, `d=2` probably. Pass `include_content: true` rather than re-reading the',
  'file. Never pass `repo` — the repo is already scoped. The index is a snapshot; when it',
  'disagrees with the working tree, trust the tree and say a re-index is due.',
  '*Example — adding MFA to login:*',
  '```',
  'query({ query: "user login validation", task_context: "adding MFA" })',
  '  → flow: handleLogin → validateUser → issueSession, with uids',
  'context({ uid: "<validateUser uid from that result>" })',
  '  → 9 callers, 2 of them in other modules',
  'impact({ target: "validateUser", direction: "upstream" })',
  '  → d=1: the 9 callers. Those are the edits; now write the code.',
  '```',
  '',
  '**L2 — the project wiki.** What the project means: intent, decisions and invariants — what',
  'indexing can never regenerate.',
  '*When:* before changing an invariant, an architecture decision or a convention, and whenever',
  '*why is it like this* matters more than *what is it*.',
  '*How:* `knowledge_search` with words that appear in the page (every term must match, so keep',
  'it to two or three). Read the hit with `knowledge_read({ page })` — it carries the authority',
  'rung and provenance, so you can see whether a human reviewed it. `knowledge_related` follows',
  'the thread from a page or a file path. When you learn something durable — a decision, a',
  'constraint, a gotcha that outlives this task — file it with `knowledge_propose` and cite the',
  'evidence. That writes the page immediately — no draft, no queue, nothing waiting on a human:',
  'it lands as `current` (rung `accepted`), ranked below any page a human reviewed or wrote.',
  '*Example — about to add a cache in front of the session store:*',
  '```',
  'knowledge_search({ query: "session state store" })',
  '  → "One store owns session state" · human-reviewed',
  'knowledge_read({ page: "architecture/one-store-owns-session-state" })',
  '  → a second cache was tried and rejected; it split ownership on restart.',
  'Drop the cache, extend the store.',
  '```',
  '',
  '**L3 — session history.** What happened here before: the record of earlier sessions in this',
  'project.',
  '*When:* a bug, flake or dead end feels familiar, or before re-deriving something an earlier',
  'session already settled.',
  '*How:* `session_history_search` with distinctive words — an error string, a test name, a',
  'symbol. Hits are past events, not project truth: confirm against the code before acting, and',
  'never let them outrank L2 or AGENTS.md.',
  '*Example — a test fails only on Windows:*',
  '```',
  'session_history_search({ query: "windows path separator test" })',
  '  → a session last month traced it to a hardcoded "/" in the fixture.',
  'Check that line first instead of re-bisecting.',
  '```',
  '',
  'Grep and reading files are the fallback, not the opening move: for files you already know,',
  'for strings, comments, config and docs, and for anything newer than the index.'
];

/** The snippet, as markdown ready to paste into a project's AGENTS.md. */
export const MEMORY_GUIDE_MARKDOWN = LINES.join('\n');

/** Heading of the snippet, so the panel and tests name it in one place. */
export const MEMORY_GUIDE_TITLE = 'Memory — you have three layers';
