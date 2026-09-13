# Performance audit

Audit against `develop` at `05e123a`, rebased onto `4ff6263` for integration, September 2026. This is a source-level audit with
work-count regressions and Windows Electron integration checks, not a CPU/heap profile
or a claim that every workload is optimal.

## Coverage

Reviewed startup/runtime discovery, Git/background work, session management and persistence,
all seven adapters' streaming paths, native tools, provider/model clients, renderer store
subscriptions, transcript/Markdown rendering, terminal lifecycle, and local/remote transports.
The earlier startup PATH/probe/repository-root caching fixes are retained. The relay deployment
and other operating systems were not load-tested.

## Fixed in this change

| Area | Change | Regression boundary |
| --- | --- | --- |
| Streaming store | One transcript ID index and one clone per changed item per animation frame | 1,000 historical items plus interleaved bursts; exact text, thinking, tool cap and notification counts |
| Transcript loading | Share concurrent reads; discard responses after deletion; allow retry | Exact IPC counts, failure recovery, deletion/recreation races |
| Markdown | Do not cache intermediate prefixes; completed replies use a 4 MiB UTF-16-estimated / 500-entry LRU | Real parser/sanitizer calls, eviction, finalization with unchanged text, file links |
| Transcript rows | Memoize against constituent item identities, not freshly allocated grouping wrappers | Unchanged command groups do not rerender when only the answer changes |
| Deep search | Consume completed jumps, preserve command expansion, restore virtualization and correctly account for flex gaps | Component tests plus real Electron search into 400 historical replies and file-link activation afterward |
| Virtual scrolling | Binary-search offsets instead of scanning all preceding rows | Same deep viewport with fewer than 50 offset reads, versus 90,012 before |
| Git panel | Shared summary reads, 80 ms debounce, one pending refresh, independent diff selection, stale-response guards | Exact request counts, current-selection results, external edits after panel reopening, retained diff DOM |
| Git invalidation | Ignore agent completions in unrelated workspaces; retain shared-cwd invalidation | Background transcript still updates without foreground Git IPC; same-cwd changes refresh |
| Branch overview | At most four branch probes concurrently; use successful ahead counts for ancestry | Large mocked repository, exact branch states and bounded subprocess concurrency |
| Combined diff | 2,000,000-byte aggregate preview and 200 untracked candidate probes, with a visible warning | Complete patches, bounded reads including missing files, individual-file access preserved |
| Native grep | Incremental output parsing, global result cap and 512 KiB input budget; stop ripgrep at the limit | Chunked UTF-8, huge lines, exact result counts, errors and cancellation cleanup |
| Session metadata | Coalesce bursts into one pending durable snapshot, plus one follow-up during an in-flight write | 40 new sessions plus an update produce one index write; real-disk snapshots, failure injection, recovery and removal ordering |
| Transcript overlay | Replace quadratic persisted/live ID matching with set membership | Real manager/store, streamed overlays, exact ordering, teardown and store reload |
| Local browser transport | Reject excess outstanding requests at 256; never replay already-rejected disconnected calls; skip serialization without clients | Actual injected browser script with fake sockets; server broadcast serialization counts |

## Remaining work requiring separate measurement or lifecycle design

These are not presented as fixed or as proven latency regressions:

- Startup still eagerly imports terminal/UI code, discovers the first PATH hit synchronously,
  and restores terminal snapshots before creating the window. Measure cold-start CPU/I/O on
  representative profiles before moving those boundaries; lazy hydration must preserve shells
  and first-use behavior.
- Full history grouping and find-mode/deep-search highlighting still temporarily process or mount
  the complete transcript. This patch fixes persistent loss of virtualization, not fully indexed
  search or virtualization inside enormous expanded tool groups.
- Completed histories and adapter item maps remain resident. Eviction requires explicit late-event,
  approval and resume semantics; dropping references opportunistically is unsafe.
- Cursor emits accumulated snapshots alongside deltas; native history checkpoints and some
  terminal-item transcript upserts can write redundant full snapshots. Those adapter/durability
  changes need dedicated version acknowledgment, failure recovery and matching live-runtime tests.
- Folder polling, filename searches and terminal-driven Git invalidation can still duplicate work
  across consumers. A bounded shared filesystem index/scheduler needs invalidation and external-edit
  tests rather than an indefinitely stale cache.
- Local/remote WebSocket push backpressure and full reconnect resynchronization need a coordinated
  protocol change. Disconnecting slow clients or dropping transcript events alone is not safe.
- Sidebar grouping/row rendering and large analytics/diff views remain profiling candidates.

## Verification

Regression tests were first run against the old implementations and then against the fixes.
Required gates: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e:ci`.
Final results: typecheck/build passed; offline tests **775 passed**, with **25 opt-in cases
excluded**; the Electron guard **5 passed / 0 skipped**; native smoke **2 requested cases
passed**; live Electron **1 passed**; packaged terminal/files **2 passed**. Initial red regressions
and integration failures were corrected and rerun. In particular, the added deep-search E2E
caught flex-gap offset drift; Header/sidebar tests needed explicit asynchronous subscription cleanup.
Integration with the newer logging work also required allowing normal lifecycle logs while still
asserting that persistence produced no warnings or errors.
The offline suite intentionally excludes opt-in tiers; the Electron guard requires all five
named suites to execute without skips.

Additional exercised tiers:

```bash
HARNESS_SMOKE=1 HARNESS_SMOKE_ONLY=native,native-tools npx vitest run tests/smoke.live.test.ts
HARNESS_E2E=1 HARNESS_E2E_HARNESS=native npx vitest run tests/e2e.electron.test.ts
npm run dist:dir
HARNESS_E2E=1 VOCS_CODE_E2E_UI=1 HARNESS_E2E_EXE="$(pwd -W)/dist/win-unpacked/Vocs Code.exe" npx vitest run tests/e2e.terminal.test.ts tests/e2e.files.test.ts
```

Packaged checks cover startup, persisted transcript display, deep search/file navigation and
real PTY output/renderer reattachment. They do not prove every provider SDK or an Electron
process-restart resume round trip. Only native/native-tools were requested in the live smoke;
other harness smoke cases remain intentionally excluded.
