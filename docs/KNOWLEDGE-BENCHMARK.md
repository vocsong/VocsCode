# Knowledge and Memory benchmark: Vocs Code

This offline benchmark asks three different questions: how much work an index saves on reuse,
which evidence sources find a known answer, and whether a saved note adds anything beyond the
same session-history search. It does **not** grade model answers or estimate paid token savings.

## Reference results

Measured on Windows x64 (build 26200), Core i7-14700K, 63.8 GiB RAM, Node 22.23.5, Electron 44.2.0
and bundled Graphify 0.9.115. The measured application code was at
[`1aa05bb`](https://github.com/vocsong/VocsCode/commit/1aa05bb30c11c2adf8b83ba7d0b3b2a00e975bfa).
These timings are a baseline for this machine and workload, not product targets.

### Indexing and restart

| Operation | Measured result | Work done or avoided |
| --- | ---: | --- |
| First graph citation, no derived cache | **117.9 s** median (108.0–132.8 s, 3 runs) | 1,078 tracked paths in the reference; 10,671 graph nodes, 37,335 edges, 12.5 MiB graph cache |
| First graph citation after unchanged restart | **123 ms** median (123–141 ms, 3 runs) | Same persisted graph timestamp in all three pairs |
| First fresh citation after a four-path HEAD change | **131.0 s** (1 run) | Old graph remained available as stale while the new revision was indexed |
| Cold transcript index ready | **482.6 ms** median, 2,344.2 ms maximum (8 runs) | 56 full transcript reads per boot |
| Unchanged warm transcript index ready | **13.5 ms** median, 17.0 ms maximum (8 runs) | 0 full transcript reads and the same expected search hits |

Refreshing the graph after HEAD changed was much slower than reading it. The warm transcript
index cut median readiness time to about **1/36** of cold in this run. A separate
history-only run reproduced the **56 → 0** reads and a **257.9 → 7.7 ms** median improvement;
wall-clock times varied even on this host.

### Retrieval versus Git

| Warm search arm | p50 / p95 (80 requests) | Rank 1 (16 queries) | Top 3 (16 queries) | Exact symbols, top 3 | Design questions, rank 1 / top 3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ranked `git grep` over code and docs | 48.59 / 293.05 ms | 10/16 | 13/16 | 8/8 | 2/8 / 5/8 |
| Evidence with an empty wiki | **7.57 / 12.39 ms** | 8/16 | 8/16 | 8/8 | 0/8 / 0/8 |
| Evidence with five curated pages | 12.86 / 16.66 ms | **13/16** | 13/16 | 8/8 | **5/8 / 5/8** |

Rank was stable across all repeats. Mean reciprocal rank at 3 (credit 1, ½, ⅓, or 0 per query)
was 0.688 for Git, 0.500 for empty-wiki Evidence, and 0.813 with the curated pages. The curated
batch also had a single slowest lookup of 847 ms; the p95 is not a ceiling.

**Where it helped:** Exact symbols were fast with the graph but already easy for Git. Curated
Evidence put the right citation first for three more design questions than Git did. It found
relevant citations for all five questions with matching pages and none of the three without one. The top-three counts for Git and populated
Evidence are equal, but their hits differ. Evidence should complement source/doc search, not
replace it. The 16 compiled packets used a median **349 estimated tokens** (140–627) against a
1,500-token budget; none were truncated. This is packet size, not a reduction in provider usage.

| Design question, abbreviated | Git rank | Empty wiki | Curated wiki |
| --- | ---: | ---: | ---: |
| Why does the terminal command survive a reload? | 1 | — | 1 |
| Why do Zen pins persist? | 5 | — | 1 |
| When does a split pane clear the not-viewed badge? | 3 | — | 1 |
| Does a repository MCP definition enable the server? | 1 | — | 1 |
| Can the palette stay selected while colors follow the OS? | 4 | — | 1 |
| Why does the tray still show a background subagent? | 14 | — | — |
| How is large remote transcript output handled? | 3 | — | — |
| Can a Mission finish if all tests were skipped? | 3 | — | — |

`—` means no predeclared citation was returned, not necessarily zero results. Some unseeded
questions surfaced the unrelated MCP fixture page, which is a reason to verify the citation
rather than trust the first result. This was a small, known-answer retrieval check, not a held-out
accuracy study. The wiki content was authored for the fixture from checked-in docs.

### Passive Local recall versus Off

| Metric | Off: ordinary history retained | Local: same history plus recall |
| --- | ---: | ---: |
| Distinct answerable probes with the key phrase returned | 3/7 | **7/7** |
| Word-clipped details recovered | 0/4 | **4/4** |
| False hits across the two negative controls | 0/2 | 0/2 |
| Tool-dispatch p50 / p95 (108 requests each) | 1.16 / 1.66 ms | 1.72 / 2.52 ms |
| Median serialized response | 516 bytes | 1,123 bytes |
| Full transcript reads / model calls during recall | 0 / 0 | 0 / 0 |

The note brought back a complete takeaway when the normal indexed excerpt clipped it, with
about **0.57 ms** more median local lookup time and **607 bytes** more median serialized context
in this batch. Both arms returned the same 84 history snippets; one extra note was redundant.
This deliberately stresses excerpt clipping. It shows an opportunity to save a follow-up lookup,
not that every task needs the extra context or that an agent will use fewer tokens overall.

## How to reproduce

From a Vocs Code source checkout with dependencies installed and the benchmark commits in local Git
history (use a non-shallow clone), run:

```sh
node scripts/graphify-runtime.mjs prepare
npm run build
node scripts/benchmark-knowledge.mjs
```

The first command stages the private runtime if not already present. The benchmark itself uses
local Git objects and disposable app profiles; no credentials, models, system Python, or private
wiki/transcripts are needed. Allow several minutes. The runner requires the suites to emit
`desktop.json` and `history.json` and prints their paths. Neither report is written into the
project checkout. `node scripts/benchmark-knowledge.mjs --history-only` needs only Node 22+ with
SQLite/FTS5 and Git, not Electron or a staged runtime. Run on an idle machine for comparisons.

For behavior rather than timing, run the separate, keyless Knowledge regressions:

```sh
# Git Bash / POSIX shell; in PowerShell set $env:VOCS_CODE_GRAPHIFY_E2E='1' first.
VOCS_CODE_GRAPHIFY_E2E=1 node scripts/e2e-guard.mjs tests/e2e.knowledge.test.ts
```

That suite checks committed-only indexing, revision refresh and opt-out; cited recall through
real MCP, pending drafts and approval; and explicit sharing, revocation and Forget across restart.
Its loopback provider detects extra model requests. Do not use test-suite duration as query latency.

## Measurement protocol

- **Real repository.** The desktop suite locally fetches commit
  [`73bfe10`](https://github.com/vocsong/VocsCode/tree/73bfe10c3fdeac82c9a704bcda1ee3becc03b15b)
  into a temporary independent checkout. Three fresh profiles index it automatically; each is then
  restarted with its cache intact. The clock starts **after the window renders**, just before
  ensuring the benchmark session is selected, and ends at the first correct `TerminalManager`
  citation. This is remaining wait, not app startup time; scheduling may have begun if the
  session was already active. It includes remaining staging, extraction, cache loading, polling
  at 250 ms intervals, and search. No OS cache is flushed. A final in-place HEAD move to
  [`8358d99`](https://github.com/vocsong/VocsCode/commit/8358d990faba096e4e02c922792618527307f3ca)
  measures time after checkout to the new `FastModeElectric` citation, including background
  detection and status polling. The old revision must read as stale while the new one is pending.
  This is one observed refresh, not a refresh latency distribution or a parser-only timer.
- **Cited retrieval.** The [fixed probes](../tests/fixtures/knowledge-benchmark.ts) contain eight
  identifiers plus eight design questions. The `git grep` arm searches the same committed code
  **and docs**, with terms preselected from the prompt. It ranks file matches by declaration-like
  hits for symbols, then number of distinct terms, terms on one line, and hit lines. Evidence gets
  the original query through the real Electron renderer-to-main call, first with an empty wiki,
  then with five concise fixture pages distilled from committed docs. No history or memory
  matches are seeded in the desktop suite. A hit means a predeclared source file or exact fixture
  page with the right citation appears at the reported rank, not that an agent answered correctly.
  Rank is computed over usable citations, not raw rows: graph matches in one file count once and
  wiki pages count by ID. Quality scores use the first repeat and the JSON flags any rank
  instability. Each arm runs one warm-up pass and five timed repeats. Git and empty-wiki queries
  are interleaved with fixed arm order per probe; the populated wiki runs afterward. Treat the
  batch timings as descriptive, not a causal estimate of wiki overhead. Timing includes Git
  process launch and ranking, or Evidence IPC and citation extraction. It excludes human prompt
  formulation, UI rendering and model inference. Percentiles use nearest rank; repeated timings
  do not create new relevance queries.
- **Synthetic history.** The history suite exercises production transcript persistence and
  SQLite indexes with 56 synthetic Vocs Code–themed sessions (9,240 items), not your actual chats.
  Eight measured cold/warm pairs compare the time from store load to index readiness. Cold
  means no derived DB; warm still checks transcript file metadata. Twelve rounds of nine probes
  compare Local and Off via the production `memory_recall` dispatcher; both consult the *same*
  transcript index and Off retains ordinary history. Four probes deliberately place a detail
  beyond the ordinary excerpt window; two are history-only, one note is redundant, and two are
  negative controls (different project and no match). Timing includes serialized tool results,
  not MCP transport or an agent round trip. Payload size is UTF-8 bytes, not model input tokens.

## What to investigate next

1. **Profile commit refresh before optimizing warm queries.** Split the next run into Git snapshot,
   parser, and promotion/load phases. If unchanged files dominate, evaluate incremental reuse with
   a controlled one-file edit. Keep the prior revision visibly stale rather than withholding it.
2. **Measure downstream usefulness on held-out tasks.** Select new questions before writing wiki
   pages; include sparse and noisy projects. For token savings, compare the same model and prompts
   with recall on/off using sanitized fixtures, grade correctness independently, and log actual
   provider input tokens and turn time per correct answer. The offline run measures lookup cost
   and coverage, not that downstream result.
