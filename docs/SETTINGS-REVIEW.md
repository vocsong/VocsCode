# Settings redesign review

## Scope

Reviewed the merged redesign (`bc05dc5`, PR [476](https://github.com/vocsong/VocsCode/pull/476))
against its parent, then exercised the current app and reviewed the remediation diff. The review
covers navigation/catalogue, shared settings styling, provider/default controls, Voice,
Instructions, Pi, Mission settings, and their persistence/IPC boundaries. Several defects were
pre-existing in the settings editors/backend, rather than introduced by the visual redesign.

Independent passes covered editor races, accessibility/layout, helper controls and persistence;
subsequent independent passes checked the backend and renderer fixes. Findings were reproduced
or checked against current source before being accepted. The code graph was stale, so working-tree
source and executable tests were authoritative.

## Confirmed findings and resolution

| Priority | Finding | Resolution and regression evidence |
| --- | --- | --- |
| P2 | Concurrent Pi read/merge/write operations could discard sibling updates; serializing only final JSON writes was insufficient. | `src/main/pi-config.ts` queues complete operations and public reads per resolved directory, across store instances. `tests/pi-config.test.ts` verifies preferences, resources, package filters, subagents, unknown-key preservation, ordered snapshots, rejected patches and disk-write recovery against real temporary files. |
| P2 | A package timeout returned before asynchronous tree teardown, permitting a queued mutation to start early. | The runner awaits the existing teardown promise and prevents an early close event from reporting success. A deferred teardown test verifies exact completion counts and preservation of the CLI's final write. The shared teardown remains best-effort; see limits below. |
| P2 | Older full Pi snapshots could overwrite newer state; refreshes overlapping mutations could disappear, including when a later mutation failed. | `PiSettings.tsx` applies success-ordered snapshots and coalesces invalidated refreshes after pending mutations settle. Deferred tests cover both response orders, failed later writes, reads started before/during mutations, and package refresh without repeating the command. |
| P2 | Saving Instructions or Pi prompts deleted edits entered while the save was pending. | Editors clear only a draft matching the submitted snapshot. `tests/instructions-ui.test.tsx` and `tests/pi-settings.test.tsx` cover newer edits, scope/category switches, failures and successful acknowledgments. |
| P2 | App instructions accepted a character budget but read a byte budget, truncating legal non-ASCII content and making it non-editable. | `app-instructions.ts` uses the same UTF-16 budget on read/write and avoids split surrogate previews. Backend boundary tests and a real Electron 6,000-character CJK save/reopen prove round-trip behavior. |
| P2 | Pi prompt writes counted characters while reads enforced bytes, accepting content that could not round-trip. | Writes enforce the UTF-8 byte budget; truncated previews retain complete characters. Tests cover multibyte boundaries, exact limits and rejection without replacing existing content. |
| P2 | Clearing numeric Pi overrides silently did nothing; fields could misrepresent rejected or refreshed values. | Numeric controls send null deletion patches, retain unsubmitted edits and return to confirmed values after rejection. Invalid native number input is not mistaken for deliberate clearing. Renderer tests cover all eight numeric controls; Electron tests use real `1e` invalid input and disk readback. |
| P2 | Zero max retries was accepted on write but discarded on read. | The reader preserves zero. Backend and Electron reopen tests verify it remains configured and visible. |
| P2 | Pi resource toggles lacked accessible names; external package resources offered an editor action that main rejected. | Toggles identify their resource and support keyboard Space. Unsupported editor actions are disabled with an explanation; lexical directory/case/separator tests preserve the unchanged authoritative main guard. |
| P2 | Escape did not exit search from a focused result, and a query inherited the previous page/result scroll position. | Settings handles Escape throughout active search, preserves the mounted draft, restores search focus and resets query scrolling. Unit and Electron regressions cover both paths. |
| P2 | The generic Settings focus outline was clipped inside Voice's segmented engine control. | A scoped inset focus offset restores the ring. Electron keyboard tests verify both engines and capture the actual focus rings. |
| P3 | Scope notices incorrectly said running sessions never change; native instructions and Pi subagent concurrency reload sooner than the copy claimed. Pi also described both unset concurrency defaults as four. | Session defaults distinguishes startup defaults, idle-boundary compaction and live `/goal` changes. Instructions explains native per-model-step reload. Pi explains per-spawn concurrency reload and the unset background/session defaults of four/eight. Copy tests and existing compaction/instruction/subagent tests verify the statements without changing adapters. |

The two search cases, scope-copy case, focus-ring case, persistence/Unicode/editor cases, timeout
queue case and both final refresh orderings failed before their respective fixes. Tests assert
visible editor state, persisted files, exact calls/counts or real Electron behavior—not a second
implementation of the production logic.

## Requirement-to-evidence audit

| Requirement | Evidence |
| --- | --- |
| Comprehensive Settings navigation/layout check | `e2e.layout` visits all 16 pages at 960, 820, 650, 600 and 480px; no horizontal overflow. All 26 catalogue anchors become visible, focused and in the viewport. The isolated audit recorded no renderer page errors. |
| Preserve search privacy and drafts | Static catalogue only; no indexing of values, keys, account data or user files. Existing mounted-page/provider-filter draft tests remain, with new search Escape/draft retention coverage. |
| Preserve runtime/storage/permission contracts | No new dependencies, IPC channels, configuration fields, keychain changes or adapter changes. Existing patch deletion, malformed-file refusal, package CLI authority and main editor guard remain. Backend changes repair ordering and matching size budgets. |
| Verify persistence through production boundaries | Real temporary JSON/prompt files, injected atomic rename failure and recovery, registered-handler tests, Electron preference writes and reopen/restart assertions. |
| Verify accessibility and usable compact controls | Named toggles exercised with Space, scoped focus rings inspected in real screenshots, search focus/keyboard tests, all-page responsive checks. This is not a full screen-reader/WCAG certification. |
| Keep matching suites current | Updated `e2e.layout`, `e2e.instructions`, `e2e.pi-settings`, `e2e.dictation`; `e2e.themes` also ran. New Instructions renderer suite and expanded Pi/navigation/backend regressions. `docs/TESTING.md` maps the ownership explicitly. |
| Document behavior and limitations | `docs/SETTINGS.md` records save acknowledgment, snapshot reconciliation, queue scope, numeric clearing and character/byte budgets. |

## Verification

- `npm run typecheck` — passed all five TypeScript projects.
- `npm run build` — passed desktop and web builds.
- `npx vitest run tests/pi-config.test.ts tests/app-instructions.test.ts tests/pi-settings.test.tsx tests/instructions-ui.test.tsx tests/settings-navigation.test.tsx tests/claude-project-instructions.test.ts tests/pi-startup-compatibility.test.ts tests/fork-context.test.ts tests/handler-registry.test.ts tests/context-compaction.test.ts tests/branch-prefix-settings-ui.test.tsx tests/context-ui.test.tsx tests/dictation-cloud.test.ts tests/dictation-local.test.ts tests/dictation-service.test.ts tests/composer-dictation.test.tsx` — 289 passed across 16 suites.
- `npx vitest run tests/pi-settings.test.tsx tests/subagent-agents.test.ts tests/subagent-extension.test.ts` — 106 passed, including the final Pi scope-copy correction.
- `node scripts/e2e-guard.mjs tests/e2e.layout.test.ts tests/e2e.themes.test.ts tests/e2e.instructions.test.ts tests/e2e.pi-settings.test.ts tests/e2e.dictation.test.ts` — 9 passed across five suites, no failures/skips.
- `node scripts/e2e-guard.mjs tests/e2e.pi-settings.test.ts` — 1 passed again after the final Pi copy correction, no skips.
- `node scripts/test-changed.mjs --reporter=verbose` (the `npm run test:changed` entry point) — exit 0, 544 passed across 39 offline suites in 921.13 seconds. Eight opt-in Electron tests in four suites were skipped by this offline invocation; all eight actually executed in the guarded runs above. The initial `npm run test:changed` exceeded its 600-second tool budget while Mission service was still working; it was stopped and restarted without excluding tests or changing test timeouts.
- `git diff --check` and staged diff validation — passed. Nonblocking jsdom canvas warnings occurred; no canvas dependency was added.

## Limits and recommended follow-up

- This is a develop-tier review, not the release gate. Full offline/release Electron, live-provider,
  packaged-updater, macOS/Linux UI and comprehensive assistive-technology runs are not claimed.
- Pi's queue is process-local, not an inter-process transaction protocol. External editors/Pi
  processes can still race app writes. A package operation can hold reads and mutations for its
  directory while it runs. Shared process teardown is still bounded and best-effort; this change
  awaits it but does not certify the death of every possible descendant.
- First, I recommend a separate cross-process Pi persistence/termination qualification if stronger
  guarantees are required: begin with an external-writer and an uncooperative-child fixture, then
  choose a compatible locking/termination contract. This is multi-platform lifecycle work, not a
  small settings patch.
- Second, I recommend refreshing the code graph after integration. This is a tooling-only step and
  prevents future reviews from following obsolete symbol bodies and call edges.
