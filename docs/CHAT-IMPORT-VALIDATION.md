# Chat import review validation

## Runtime and scope

The review follow-up is validated with **Node 22.16.0**, matching the Node 22 line in
`.github/workflows/ci.yml`, on macOS arm64. Both comparison checkouts use the same
dependency installation. Their unchanged `package-lock.json` SHA-256 is
`e24842aac491a57eba938e818a246cd19ce0d80a8803025cb4386dfb028f3648`.

All import histories are synthetic fixtures. No live provider tier is enabled. The
Electron suite launches a separate temporary profile and a mock keychain; it checks
the production desktop UI and persistence without reading the user's real history.

## Baseline versus reviewed PR

The earlier three failures came from two test files. The comparison below executes
both complete files, including all three named cases, with zero skips:

| Checkout | Revision | Runtime | Result |
| --- | --- | --- | --- |
| Tracked-clean upstream base | `72fb53d3345f9234710fab3adbe99a0176261597` | Node 22.16.0 | 36 passed, 0 failed, 0 skipped |
| Reviewed PR, before this follow-up | `b5bb93d800e3d429d416d4e38e6bba179424db16` | Node 22.16.0 | 36 passed, 0 failed, 0 skipped |
| Review follow-up in this PR | `codex/import-agent-sessions`, with the rollback and fork fixes | Node 22.16.0 | 36 passed, 0 failed, 0 skipped |

Identical command in both checkouts:

```sh
node node_modules/vitest/vitest.mjs run tests/split-view.test.tsx tests/mission-runtime.test.ts
```

The executable was `/Users/hussain/.nvm/versions/node/v22.16.0/bin/node`, explicitly
placed first in `PATH`. `TMPDIR` was resolved to its canonical `/private/var/...`
path so macOS's `/var` alias could not affect workspace-containment assertions.
The baseline and reviewed-PR runs completed in 44.88 and 44.87 seconds respectively.
The final review-follow-up run completed in 53.84 seconds using the same two files.

The previous Node 26.4.0 results are separate evidence, not passing validation:

| Case | Unchanged upstream on Node 26 | Reviewed PR on Node 26 | Node 22 comparison above |
| --- | --- | --- | --- |
| Mission runtime: `refreshes an initially divergent approved target through real MCP, captured checks and the immutable source boundary` | Failed; generated check artifact reported `Missing/ambiguous TAP summary: tests` | Same failure | Passes on both checkouts |
| Split view: `brings back the last split with both transcripts loaded and the saved pane active` | Failed at `localStorage.clear()` in setup | Same failure | Passes on both checkouts |
| Split view: `falls back to the first session when the saved split names sessions that are gone` | Same setup failure | Same failure | Passes on both checkouts |

The Mission fixture declares `node-tap`, while Node 26 emits spec output by default.
The split-view setup depends on `localStorage`, which Node 26 reported unavailable
without `--localstorage-file`. The old affected-suite result was 1,378 passed,
3 failed and 83 opt-in skips. Those three failures reproduced on the clean base;
the fresh Node 22 comparison establishes the passing result for the intended CI line.

## Review regressions

Codex `event_msg/thread_rolled_back` is replayed before materializing the imported
transcript or its continuation context. The parser counts real user-prompt boundaries
and structured agent instructions according to Codex's history rules, including
attachment-only prompts. It excludes contextual fragments and does not count mirrored
`user_message` or `task_started` events twice. Repeated rollback, replacement turns,
reused message IDs, zero/oversized counts and malformed mutation markers are covered.
Context matching includes valid hook prompts and the known synthetic compaction-summary
prefix; malformed or incorrectly cased custom-wrapper lookalikes remain real prompts.

The new parser tests fail against the original implementation. Separate lifecycle
regressions also fail against it because discarded text reaches the actual scripted
adapter prompt, for both direct continuation and a fork. These assertions exercise
the imported transcript, persisted `fork-context.md` and dispatched message.

The lifecycle matrix covers Claude and Codex independently, each with direct
continuation, a fork before continuation and a fork after continuation. It uses real
JSONL discovery, concurrent/repeated imports, real stores, restart and exact transcript
checks, streaming completion and teardown, and byte-for-byte unchanged source files.
Claude's resumed fork retains its Vocs-created provider reference; a fresh Codex fork
receives the conversation as a one-shot text handoff.

The Electron fixture imports both providers, checks that rolled-back Codex text is
absent from transcript and handoff, restarts the application, verifies both visible
conversations and duplicate detection, and checks the original source bytes.

These regressions use fresh profiles. A rescan does not rewrite an existing imported
copy or its later continuations; use a fresh profile when retesting an earlier import.

## Skip-reason diagnostics follow-up

Discovery now assigns exactly one aggregate reason to each rejected history file:
empty/no conversation text (including command-only histories), recognized subagent
history, missing/invalid project-directory metadata, invalid/unrecognized history,
per-file size limit, remaining scan byte budget, or unreadable file. Counts sum to
the skipped-file total. Root/directory failures are counted separately as scan
errors rather than mislabeled as rejected files. Missing optional history roots
remain normal empty discovery; unvisited entries and excluded layouts are not
invented as skipped files.

The desktop preview forwards only these counts, not filenames, message text or raw
errors. Settings/onboarding show nonzero reasons beneath the neutral skipped-file
summary, refresh them after import, and clear them when switching sources. Malformed
line counts and scan-truncation warnings remain separate. The change does not alter
which conversations are accepted, the `/clear` sanitation rule, or existing copies.

Regression coverage includes exact reason totals and privacy, invalid Codex rollback
counts, unreadable files versus directory failures, per-file versus total-byte limits
(including growth after stat and later files that still fit), and UI refresh/reset.
The Electron fixture scans an importable Claude conversation alongside command-only,
missing-project and invalid histories; it checks the breakdown, switching to Codex,
full restart, duplicate detection and byte-for-byte unchanged sources.

Verification for this diagnostic-only follow-up, on Node 22.16.0/macOS with a
canonical `TMPDIR` for Git-backed suites:

| Command | Skip-diagnostics result |
| --- | --- |
| `npm run typecheck` | Pass, all five TypeScript projects |
| `npm run test:changed` | 108 files / 1,469 tests passed; 6 optional files / 83 tests skipped; 0 failures |
| `npm run test:pr` | 29 files / 702 tests passed, 0 failures, 0 skips |
| `npm run build` | Pass, Electron and web bundles |
| `node scripts/e2e-guard.mjs tests/e2e.instructions.test.ts` | 2 tests passed, 0 failures, 0 skips |

The six import/handler/fork-context suites also pass directly (168 tests, zero
skips). New parser, registered-handler and UI assertions fail against the earlier
implementation. The changed run completed in 637.49 seconds. All histories were
synthetic; optional skips are not live-provider verification. The separate review
findings concerning accepted history, lifecycle races and folder registration are
not addressed by this diagnostics change.

## Claude local-command formatting follow-up

Claude can persist local CLI command records as user text without `isMeta`. The
importer now omits complete `/clear` envelopes with redundant command labels and
empty arguments, and standalone user-side `local-command-stdout`,
`local-command-stderr` and `local-command-caveat` blocks. They no longer become
transcript rows, default titles, message counts or continuation/fork handoffs.
Other complete command envelopes with redundant labels are normalized to readable
`/name args` prompts, preserving custom/namespaced commands and multiline arguments.
Prose, fenced examples, incomplete/unknown envelopes, nonredundant command-message
text and assistant examples are retained. Individual text blocks are processed
before joining so a local artifact does not discard a separate genuine prompt.

This is formatting/import hygiene, not a change to Claude history replay: `/clear`
markers do not authorize deleting earlier imported messages. Existing imported
copies and source files remain untouched; use a fresh profile to retest.

Parser and real-store/scripted-adapter regressions reproduce the old title and
continuation-context bug before the fix. The extended Electron fixture also fails
against the original build because the picker is titled with the raw command
rather than the genuine question. It covers clean picker/sidebar titles, persisted
text and context, a full app restart, duplicate detection and unchanged sources.
These checks use synthetic histories, not private histories or live provider calls.

Follow-up verification on Node 22.16.0/macOS, with a canonical `TMPDIR` for the
Git-backed suites (separate from the original PR results below):

| Command | Follow-up result |
| --- | --- |
| `npm run typecheck` | Pass, all five TypeScript projects |
| `npm run test:changed` | 108 files / 1,460 tests passed; 6 optional files / 83 tests skipped; 0 failures |
| `npm run test:pr` | 29 files / 693 tests passed, 0 failures, 0 skips |
| `npm run build` | Pass, Electron and web bundles |
| `node scripts/e2e-guard.mjs tests/e2e.instructions.test.ts` | 2 tests passed, 0 failures, 0 skips |

The changed-suite run completed in 586.14 seconds. The optional skips do not
constitute live-provider verification. No provider credentials or private history
were used for the follow-up.

## Original PR verification commands

Run with Node 22.16.0 first in `PATH` and a canonical macOS `TMPDIR`:

```sh
npm run typecheck
npm run test:changed
npm run test:pr
npm run test:relay-do
npm run build
node scripts/e2e-guard.mjs tests/e2e.instructions.test.ts
```

Final results for the frozen review-follow-up source tree:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass, all five TypeScript projects |
| `npm run test:changed` | 108 files / 1,439 tests passed, 0 failures; 6 optional files / 83 opt-in tests skipped |
| `npm run test:pr` | 29 requested files / 672 tests passed, 0 failures, 0 skips |
| `npm run test:relay-do` | 14 tests passed, 0 failures |
| `npm run build` | Pass, Electron main/preload/renderer and web bundle |
| `node scripts/e2e-guard.mjs tests/e2e.instructions.test.ts` | 2 desktop tests passed, 0 failures, 0 skips; guard confirms both tests executed |

The affected-suite run completed in 1,295.84 seconds on this machine. It includes both
complete files containing the three earlier Node 26 failures. Optional/live-provider
suites are not claimed as desktop or live-provider coverage.

## Upstream CI is still a merge gate

The original upstream [CI run](https://github.com/vocsong/VocsCode/actions/runs/41371845896)
reports `action_required` and **zero jobs**. It did not validate the PR. The author has
no upstream write or administration permission and cannot approve that run.
Local results do not replace upstream CI; a maintainer must approve the revised
fork workflow and obtain a passing run before merging. The PR remains unmerged.
