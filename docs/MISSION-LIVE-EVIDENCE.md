# Mission live evidence — 25 September 2026

**Status: live acceptance is not established.** The latest paid A-only run remains `bIKxvy` (11:49–11:50 UTC): it completed a real ordinary source discussion, then failed because its explicit Stop produced no positively observed Pi close event. No Mission was created. The narrow N2 driver correction and offline guards are now prepared, but **a fresh A is held until the coordinator's explicit GO after the remaining production fixes settle**; no additional provider invocation has occurred. The earlier `UKhbU5` run remains failed at 2,053,136 observed tokens before independent review, counted checks or delivery. B/C remain held. This is an execution report, not an offline certification. Runs use the unmocked production `SessionManager`, `SessionStore`, `MissionRuntime`, adapter registry, `RuntimeResolver`, capability handshake, Mission MCP tools, managed Windows Jobs, Git workspaces, verification and delivery services, but only the paths actually reached below are evidence. The driver is `tests/mission-live.integration.test.ts`; historical attempts used the production code present at their respective run times.

**Source-conversion gap:** the historical A/B drivers created a session titled “Normal discussion” and immediately created a Mission; those ordinary sessions contained no actual conversation. Their unchanged configuration and empty source snapshots do **not** certify conversion of a real discussion. The `bIKxvy` driver did obtain a genuine discussion, but refused capture at its erroneous Stop-proof boundary. Immutable conversion and model-owned source access remain unverified. Ordinary root exit alone would not prove an owned process tree stopped; this run did not even observe that root-close event.

## Tested environment and scope

- Windows `win32/x64`, OS release `10.0.26200`, Node `v22.23.1`, installed Pi `0.85.1`.
- Runtime: `C:\Users\vocs\AppData\Roaming\Vocs Code (Dev)\runtime\pi.cmd`.
- Explicit T5 preset `live-principal@1`: Pi, provider/connection `openai-codex`, model `gpt-6-astra`, runtime-default reasoning. This exact model appeared in Pi's real `get_available_models` response; each started lead's persisted `activeModel` matches it and `activeEffort` is `high`. The effort was observed, not inferred from T5. No alias, account substitution, mocked model or capability override was used.
- Authentication remains in the existing Pi CLI connection. The driver does not open, log or copy secret values and does not use the application's SecretStore.
- Disposable source repositories and isolated user data are retained under the artifact roots below. Their initial commits use the operator's exact repository-resolved Git identity, copied only as local Git configuration because no global identity is configured. No main checkout commit or publication is performed.
- **Pi-only, Windows-only scope. Claude and cross-harness operation are unverified.** Metadata availability is not a Mission driver certification.

## Initial historical commands and results

This section records the initial A/B/C attempts before the later production corrections. It is not a fresh verification of the current working tree.

```bash
VOCS_CODE_MISSION_METADATA=1 npx vitest run tests/mission-live.integration.test.ts -t metadata
# PASS: one metadata test; three live demos intentionally not selected. No model prompt.

npm run typecheck:test
# PASS.

VOCS_CODE_PI_INTEGRATION=1 npx vitest run tests/mission-pi.integration.test.ts tests/mission-pi-process.test.ts tests/mission-pi-recovery.test.ts
# PASS: 25 tests, three files; managed-Pi prerequisites before live sends.

VOCS_CODE_MISSION_LIVE=1 VOCS_CODE_MISSION_LIVE_PROVIDER=openai-codex VOCS_CODE_MISSION_LIVE_MODEL=gpt-6-astra VOCS_CODE_MISSION_LIVE_ONLY=A npx vitest run tests/mission-live.integration.test.ts
# First invocation: FAILED at disposable Git setup, before any model send (no global Git identity).
# Second invocation: FAILED at a real model/tool protocol boundary; details below.

VOCS_CODE_MISSION_LIVE=1 VOCS_CODE_MISSION_LIVE_PROVIDER=openai-codex VOCS_CODE_MISSION_LIVE_MODEL=gpt-6-astra VOCS_CODE_MISSION_LIVE_ONLY=B npx vitest run tests/mission-live.integration.test.ts
# FAILED: autonomous lead asked for coordination recovery after its plan update failed.

VOCS_CODE_MISSION_LIVE=1 VOCS_CODE_MISSION_LIVE_PROVIDER=openai-codex VOCS_CODE_MISSION_LIVE_MODEL=gpt-6-astra VOCS_CODE_MISSION_LIVE_ONLY=C npx vitest run tests/mission-live.integration.test.ts
# Invocation one: FAILED before provider send; worktree-local Vitest entry was unavailable.
# Invocation two: FAILED in driver telemetry rename while the actual provider was active.
# Invocation three: FAILED after the eight-minute bound, before the first worker interruption.

npm run typecheck:test
# PASS again after final driver changes (ownership guard, user-command acknowledgement and bounds).

VOCS_CODE_MISSION_METADATA=1 VOCS_CODE_MISSION_LIVE_PROVIDER=openai-codex VOCS_CODE_MISSION_LIVE_MODEL=gpt-6-astra npx vitest run tests/mission-live.integration.test.ts -t metadata
# PASS again: one metadata test; three live demos not selected. No model prompt.
```

Each initial selected live command ran its real metadata test plus the selected demo. The metadata pass and two unselected demos are **not** live-demo successes. All three initial demonstration outcomes were failures; no delivery check or counted fixture test was reached.

The Git setup issue was corrected by retaining the session repository's actual resolved name/email in each disposable repository, never by inventing a test author or modifying global settings. Full builds/offline/UI suites belong to the coordinating agents, not this delegated live run.

## Demo A — actual failed live run

- Artifact root: `C:\Users\vocs\AppData\Local\Temp\vocs-mission-live-eF4im0\A`.
- Mission: `m_cc29f0cf7745bf11592bbfd1c0ee0a98`; lead: `s_e52a0843517a38fb643221b026cd64c8`; linked normal session: `s_muglrprh1ltuj`.
- Source baseline commit: `7cf25ea6861906c44a17cc4f34d15569adb75077`; baseline/accepted tree: `58f967dba60b4b21d0eac1ed728a93ef34455661`.
- Real authenticated lead started, used Mission tools, created the novel read-only `api-scout` profile, and attempted to record its scout task/plan.
- `mission_plan_update` at revision 12 failed. Its payload changed the host-seeded required `behavior` criterion's description from `Required project verification: behavior` to a behavioral requirement. At the time of this run, `state.ts` required an existing required criterion to be exactly deep-equal, not merely non-weakened. A later read-only replay of the captured payload against the retained record through the real reducer reproduced `A model cannot remove or weaken an explicit required criterion.` No service, tool or stored state was mutated by this diagnosis; the live transport did not expose the reason to the model.
- **Historical production error-reporting gap:** at that time, `resources/pi/vocs-code-mcp.ts` caught the broker's JSON-RPC validation error and emitted only `Mission coordination request failed; the connection may have been revoked.` The next `mission_read` and `mission_yield` both succeeded, so the connection was not actually revoked.
- The lead ended with a visible coordination blocker and yielded for `coordination recovery`. Mission revision 14 remained `running/planning`, without a pending operation or persisted blocker. The driver failed after 100 seconds of settled inactivity rather than sending recovery tool mutations or pretending success.
- Exactly one real completed turn, six tool calls; runtime-reported usage: 25,215 input, 862 output, 103,808 cache-read, 27 reasoning tokens; reported cost `$0.399058` (not a billing guarantee).
- No question/answer cycle, execution authorization, worker attempt, implementation, review, check, integration or delivery occurred. Source file digest, index and HEAD remained unchanged; managed project workspaces stayed clean before authorization. Shutdown retained everything.
- Inspect `observed.json`, `events.jsonl`, `runtime.log`, `result.json`, `source-before.json`, `after-shutdown.json`, and `data/sessions/<lead>/transcript.jsonl`. The retained source artifact is `source-812e6fc1-d57e-44b8-af08-b73043125043-7dddb18efe5b3b4e02a0753c5a4898bf22fbdb531b5f36458e0459181fb63241`.

## Demo B — actual failed live run

- Artifact root: `C:\Users\vocs\AppData\Local\Temp\vocs-mission-live-tVREQm\B`.
- Mission: `m_2de84db2d44fa860e4fcb78b24b9a75b`; lead: `s_c5593af8312ff229798b25e280aee25b`.
- Source baseline: `446e68e291b6a48228f8b29f048f5984321c3f96`; tree: `313cbe241385213f710c2346054f72a257125305`.
- The real lead stated reasonable assumptions (`unique` counts case-sensitive distinct strings; slugging preserves punctuation), read Mission state and attempted `mission_plan_update` at revision 11. Read-only replay reproduced the same required-criterion rejection as A. Pi again returned the opaque connection error.
- The model legitimately asked a `purpose: blocker` question requesting coordination recovery. The driver failed on `waiting_for_user` at revision 12, rather than manufacturing a plan/task or granting unrelated authority. This was a blocker question, not an inappropriate routine product questionnaire.
- Eleven real tool calls were observed; no terminal turn had been recorded before shutdown. Persisted usage still reports 27,010 input, 1,570 output, 101,504 cache-read, 186 reasoning tokens and `$0.450104`. Zero completed turns does **not** mean zero provider activity or cost.
- No worker attempts, overlap, direct-lead implementation, review, checks, integration or delivery were demonstrated. Source digest/index/HEAD stayed unchanged; shutdown errors were empty.
- Retained source artifact: `source-f0401b80-0ad7-40c6-9948-e7ccffe1ec52-5ef9a58dc39fb473354577eec2518a136e8e45a53de4f634a4341f27dca325dd`. The record, full transcript, runtime/event logs, before/after source fingerprints and failure result remain in the root above.

## Demo C — actual failed live run; recovery stages not reached

- Artifact root: `C:\Users\vocs\AppData\Local\Temp\vocs-mission-live-wjWscV\C`.
- Mission: `m_c4b30e506b56b22452d5030306404d71`; lead: `s_49c45077471d200618e806f1ef1895bb`; real runtime host PID was `83772`.
- Source baseline: `e955bf9a2b0d4285d141e05bfa591f0307397b5a`; tree: `7502398baf090c2447a90aed3d5d48013466b614`.
- The real lead created novel `slug-specialist` and `stats-specialist` profiles. Plan updates at revisions 13 and 19 failed with the same opaque transport error; read-only reducer replay reproduced the required-criterion rejection for both. The second attempt did not duplicate an accepted plan or dispatched task.
- Two real completed turns, fourteen tool calls; combined persisted usage: 31,634 input, 3,853 output, 203,264 cache-read, 216 reasoning tokens, `$0.712254`. The final visible answer says plan submission failed again and no implementation tasks had been dispatched or claimed.
- At revision 21 the Mission remained `running/planning`, with zero tasks/attempts. The eight-minute wait expired. No worker pause, conflict injection, intended restart, duplicate-effect reconciliation, verification or delivery was demonstrated. Killing the host for timeout cleanup is **not** a successful recovery demo.
- Source tree/index/HEAD remained unchanged. `host-state.json`, `host-console.log`, `events.jsonl`, `runtime.log`, `result.json`, `source-before.json` and the full lead transcript are retained. Source artifact: `source-8337d16e-f32f-4bd5-bb59-5af5aca5c5af-c95b8af66b185f30a2a5f4b57de1456280f90c7567571cc26a9456cccbee37df`.
- **Additional actual ownership evidence:** after timeout cleanup, the real `inspectManagedPiOwnership` returned `state: unknown`, `quiescent: false`, `intents: 1`, detail `Managed Pi ownership intent/receipt is missing, unreadable or incomplete.` The ownership directory contains `97325e50-a154-40c7-8494-32fc1b388504.intent.json` and `.receipt.json.claimed`, but no final `.receipt.json`. No live supervisor with that exact intent argument was found by a later read-only process query; process absence is not teardown proof. The cause is not established, and successful managed teardown after this host kill is **not** claimed. No broad PID-based cleanup or fabricated receipt was used.

### Earlier driver failures, preserved separately

- `vocs-mission-live-ffcrjD`: A stopped at fixture Git setup before a model prompt. Local identity handling was corrected as described above.
- `vocs-mission-live-DYdUE7\C`: no model prompt; the child used a nonexistent worktree-local Vitest path. The driver now resolves the installed `vitest/package.json` through `createRequire`.
- `vocs-mission-live-tTEbNU\C`: provider activity did occur before a Windows telemetry rename error. Mission `m_47bc542872d00afa1e4704e6823d5fdc`, lead `s_6d0659ca2466628ca6713806afd0e6cb`; shutdown left revision 20 paused, two generated specialist profiles, zero tasks/attempts, ten tool calls, zero terminal turns and no shutdown errors. Persisted usage: 19,685 input, 833 output, 65,408 cache-read, 97 reasoning tokens, `$0.303908`. The driver now uses the existing `writeJson` utility's Windows rename retries. This run is not recovery acceptance.

All paths in this subsection are under `C:\Users\vocs\AppData\Local\Temp`. The four initial runs with model activity report **$1.865324 in total**; this is a historical subtotal of runtime telemetry, not an invoice or a complete billing guarantee.

## Follow-up Demo A — usage-checkpoint CAS starvation (08:36–08:39 UTC)

This completes the interrupted `agent_6095c125` report from its retained artifacts; it is not a rerun or a claim that the later fix has passed live acceptance.

- Artifact root: `C:\Users\vocs\AppData\Local\Temp\vocs-mission-live-xaaynk\A`; metadata is at the parent root's `metadata.json`.
- Mission `m_cd49e426ac7ec4e1adf5c8f86283ef04`, lead `s_9891cffbe8d51e674bf3e513d37d290f`, linked normal session `s_mugpi4j51qut3`. The real runtime remained Pi `0.85.1`, `openai-codex/gpt-6-astra`, T5 `live-principal@1`; no substitute provider/model or credential inspection.
- The driver had already changed the earlier 450,000-token allowance to **2,000,000 aggregate observed tokens including cache reads**. Other limits remained $12 observed cost, 36 terminal-turn IDs, 160 distinct tool-call IDs and eight minutes. These are stop-on-observation thresholds, not provider billing caps.
- First failing real call: `mission_profile_upsert`, `expectedRevision: 11`, `idempotencyKey: profile-scout-1`, proposed read-only `api-scout@1` at T5. Exact error: `Mission coordination request failed: [MISSION_REVISION_CONFLICT] Expected revision 11; current revision is 14`. The full payload and error are at `data/sessions/s_9891cffbe8d51e674bf3e513d37d290f/transcript.jsonl`, first terminal result on line 11, call ID `call_VTNGRDyFK9lYxWZOIUdxwkJn|fc_09491dfd10f60b92016ab632940f0487d091a7e8ae3221d5e0`.
- `follow-up-audit.json` ties revisions 12–14 to `budget-usage_*` checkpoints between the read and mutation. Repeated fresh reads, corrected profile requests, blocker questions and even yields were rejected as stale. No accepted semantic plan/profile mutation was duplicated; there were none. Unlike the initial runs, this real tool error was actionable rather than the older opaque transport message.
- Production continued the lead after settled turns; the driver did not issue recovery mutations, answer a fabricated question or restart the demo. The independent driver and production budget guard stopped at **2,057,568 tokens** and reported **$3.116504**. Runtime components: 106,297 input, 2,087 output, 1,949,184 cache-read, zero cache-write; 233 reasoning tokens are already a subset, not added again. Eight terminal turns and 28 distinct tool calls were observed; neither token nor cost session totals were unknown. Provider billing may differ or arrive later.
- Final retained state: revision/sequence 103, `paused/planning`, explicit budget blocker. Exactly zero profiles, tasks, attempts, questions, candidates, reviews or check evidence; no authorization or delivery. This was coordination starvation before scouting, not a healthy large-context implementation stopped late in delivery.
- Source baseline `fe2d054a8b1e80c50d06fc7a6d3d540db47747d9`, accepted tree `58f967dba60b4b21d0eac1ed728a93ef34455661`; source digest, HEAD and index stayed unchanged. Shutdown errors were empty. The retained read-only follow-up audit records positive quiescent ownership proof for all nine Pi launch intents and each exact dispatch; this is not a crash-recovery demonstration.
- Preserve `observed.json`, `after-shutdown.json`, `events.jsonl`, `runtime.log`, `result.json`, `source-before.json`, `follow-up-audit.json`, the Mission journal and full transcript. B/C were held, not rerun. Historical reported spend through this attempt is **$4.981828** across five runs with model activity; unknown later billing is not zero.

### Boundary for the fresh A-only run

The coordinating agent corrected production usage accounting after the starvation run: host-only validated usage observations remain durably journaled without advancing the control revision; semantic stale writes still reject. The coordinator reported passing real-Pi read → usage → profile mutation/lost-ack deduplication coverage and focused budget/store suites; those are prerequisite reports, not commands rerun by this delegated task. Other production edits were ongoing, so this was a working-tree run, not a frozen release build. Only A was authorized. B/C require A to pass **and** the coordinator's agreement; no automatic whole-demo retry, cap increase or production edit was authorized.

## Fresh Demo A — implementation reached, stopped at observed-token cap (09:32–09:39 UTC)

Exactly one fresh live invocation was executed on 25 September 2026:

```bash
set -o pipefail
RUN_ROOT="$(node -e "process.stdout.write(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'vocs-mission-live-')))")"
printf 'A-only artifact root: %s\n' "$RUN_ROOT"
VOCS_CODE_MISSION_LIVE=1 VOCS_CODE_MISSION_LIVE_PROVIDER=openai-codex VOCS_CODE_MISSION_LIVE_MODEL=gpt-6-astra VOCS_CODE_MISSION_LIVE_ONLY=A VOCS_CODE_MISSION_LIVE_CHILD=0 VOCS_CODE_MISSION_LIVE_ROOT="$RUN_ROOT" npx vitest run tests/mission-live.integration.test.ts --pool=threads --maxWorkers=1 2>&1 | tee "$RUN_ROOT/console.log"
# FAIL (exit 1): Demo A failed; six tests passed (five driver telemetry guards + metadata).
# Two demos intentionally not selected: B and C. No live-demo pass.
# Vitest duration 421.51s; selected Demo A 419.444s, within the eight-minute bound.
```

- Artifact root: `C:\Users\vocs\AppData\Local\Temp\vocs-mission-live-UKhbU5\A`; `console.log` and `metadata.json` are in its parent directory. Mission `m_562c72823447bf28ba59e7f46bf2912f`; lead `s_7fb0dc4f5acd64d306ad1f06a318e973`; scout `s_cc51061c29fa05982cbdde75c72a34ac`; linked normal session `s_mugrigs81uktc`.
- Real Pi `0.85.1` again advertised and used `openai-codex/gpt-6-astra`. Both participating sessions persisted that exact model and observed `activeEffort: high`, from the T5 preset's runtime default. No credential reads, substituted models, capability mocks or manually invoked model tools were used.
- **Progress actually reached:** the lead created `api-scout@1` and delegated the read-only scout. The scout submitted findings and had one host-captured candidate with **zero changed paths**. The lead used those findings, asked the whitespace and case questions separately, incorporated both answers and presented the consolidated proposal. The only three driver user actions were those two answers and approval of proposal `normalize-execution`, specification revision 3.
- `before-authorization.json` records `awaiting_execution_approval`, revision 51/sequence 83, five terminal turns, 33 tool calls, **1,092,773 aggregate tokens and $2.299386** already observed. Source/managed-workspace cleanliness assertions passed throughout planning. No execution was authorized before both answers and the submitted scout.
- After approval at `09:38:07.926Z`, the lead claimed `implement-normalize` and received the real writable continuation. Two successful edits at `09:38:54.454Z` and `09:39:08.346Z` changed only `core.cjs` and `baseline.test.cjs` in the lead's isolated workspace. Retained files implement primitive-string validation/`TypeError` and trimming; the baseline test was preserved and three tests were added. **Four test declarations are not four passing tests:** no fixture suite was executed, and no implementation candidate was captured.
- **Exact stop and cost:** `Driver aggregate observed-token threshold 2000000 reached`, with **2,053,136 tokens, $4.412888, six terminal turns and 42 distinct tool calls**. Lead: 1,993,689 tokens/$4.161218; scout: 59,447 tokens/$0.251670. Aggregate components: 219,973 input, 7,755 output, 1,825,408 cache-read and zero cache-write; reasoning is already included. No participating session had unknown token/cost totals, but provider billing or delayed usage is not guaranteed by these observations. The lead's last reported context was 95,629 of 272,000 tokens. This was real planning/implementation progress with large repeated context, **not** the prior all-mutations-rejected starvation. The cap was not increased.
- Final state: `paused/executing`, revision **72**, journal sequence **114**, one profile, two tasks/two terminal attempts, two answered questions, one read-only unchanged candidate, **zero substantive candidates/reviews/check evidence/delivery**, and no pending operations. The implementation attempt was interrupted; its uncommitted edits remain retained. The production budget blocker explicitly reports `Mission token threshold reached (2053136 / 2000000)`. The canceled direct dispatch says `Canceled at a quiescent user-control boundary.`

### Exact tool outcomes and payload locations

All paths below are relative to the fresh `A` artifact root. `follow-up-audit.json` also retains each complete error payload, tool-call ID and transcript location; it was created by a read-only post-run audit, not a model-tool replay.

- The terminal implementation `mission_report` failed while the token guard fenced the runtime: `Mission coordination request failed; the connection may have been revoked.` Full input/result: `data/sessions/s_7fb0dc4f5acd64d306ad1f06a318e973/transcript.jsonl:194`, call `call_46UMXDWmrMHbTzixhPAI16OO|fc_06490b29ab0d6be8016ab6414ab21887d086caba3bdee4563b`, `expectedRevision: 64`, key `report-direct-normalize-1`, task `implement-normalize`, attempt `a_1478db0827f9f59c1be133805386ba7f`, result status `candidate`. That request is **not** an accepted report/candidate. Journal sequences 106–114 record the final usage observation, explicit budget blocker and quiescent pause; no independent transport regression is inferred from the generic message alone.
- Earlier `mission_plan_update` returned `Mission coordination request failed: Unknown affected task reference.` Full payload: the same lead transcript, line 127, key `consolidated-normalize-plan-1`, `expectedRevision: 48`, `material.affectedTaskIds: ["implement-normalize"]` while simultaneously introducing that task. The model re-read and corrected its own request with a new key; the corrected update at line 131 succeeded and preserved the required criteria. The driver did not manufacture or repair the plan.
- Three genuine stale coordination writes rejected and then succeeded after model-owned fresh reads: lead `mission_yield` (14 → 15, lead transcript line 42), scout `mission_report` (19 → 21, scout transcript line 63), and lead `mission_question_ask` (30 → 33, lead transcript line 70). The journal identifies dispatch-in-flight, lead-yield/turn completion, and scout candidate/capture-mail commits respectively, not usage-only revision changes.
- The read-only audit verified **42 durable host `budget-usage_*` observations**, each advancing sequence but preserving control revision. Successful profile/task/question/proposal/claim mutations demonstrate progress beyond the earlier CAS starvation; they do not certify the unvisited review/delivery paths.

### Retention and limits of this evidence

- Original fixture branch `main`, HEAD `2f95af6dd9f4e46c3556f304d4905c14c417955e`, index and source-file digest match `source-before.json` exactly. The integration/scout workspaces remain clean at the baseline commit. Only the lead workspace retains the two authorized edits; nothing was integrated or committed as delivery. The linked normal session remains idle with its original configuration and no model work.
- Shutdown errors were empty. Read-only calls to the real `inspectManagedPiOwnership` returned positive quiescent proof for all **seven** launches (six lead, one scout), including each exact dispatch nonce/generation/start time. This is orderly budget-stop evidence, not Demo C crash-recovery acceptance.
- Retain `before-authorization.json`, `observed.json`, `after-shutdown.json`, `result.json`, `follow-up-audit.json`, `source-before.json`, `user-actions.jsonl`, `events.jsonl`, `runtime.log`, the full transcripts and `data/missions/m_562c72823447bf28ba59e7f46bf2912f/journal.jsonl`. Partial implementation is under `data/mission-workspaces/worktrees/w_7fb0dc4f5acd64d306ad1f06a318e973`.
- The post-run Node audit passed its source equality, exact state/count, post-authorization edit, telemetry-sequence and production ownership assertions. No fixture tests were run manually to substitute for Mission evidence. No broad build, typecheck, offline suite, source commit, push or PR was performed in this delegated follow-up. `tests/mission-live.integration.test.ts` and its existing acceptance assertions/limits were unchanged by this follow-up.
- The application checkout remained on `vocscode/s-mugezz2t53j91y`, HEAD `66aa41b40b55888182d6fb2bb28eadd6d0a6fa22`, with no staged changes; other agents' ongoing work was not frozen or modified by this task. The code index predates the untracked Mission implementation; no re-index or release-build provenance is claimed.
- Historical reported spend across the six runs with model activity documented here is now **$9.394716**, not a complete invoice. A remains failed; **no second fresh A invocation, no B/C, and no silent budget increase** followed. Further execution needs the coordinating agent's budget/stage decision; independent review, counted checks and actual local delivery remain required.

## Historical driver preparation — real discussion and explicit bounds (no paid run at this stage)

Only `tests/mission-live.integration.test.ts` and this report changed in that delegated preparation. Production fixes remained with the coordinating agents. The proposed next stage was **one new A**, after those fixes and explicit permission to run, with separately approved **6,000,000 or 8,000,000 tokens / $20 / 20 minutes**; 36 turns and 160 tools stayed unchanged. Neither choice had been used at preparation time. The later single authorized 8,000,000-token invocation is recorded below. **B/C are held pending A and coordinator agreement.** There is no automatic whole-Mission retry.

### Historically prepared source-conversation proof (superseded by N2 below; not live acceptance)

- A/B first send one genuine user discussion prompt through ordinary `SessionManager.send` to the explicitly selected real Pi model, with `permissionMode: 'plan'` and no Mission ownership. The prompt requests a short API/design discussion, not implementation; A leaves both material product choices unresolved for later Mission questions. No assistant answer, turn, profile or task is seeded by the host.
- Conversion requires a nonempty actual assistant answer, exactly one normalized `completed` source turn, idle/quiescent activity, then an explicit ordinary-session Stop. A successful `stop()` promise alone is insufficient: the driver waits for that Pi adapter's normalized `stopped` event with `pi exited (…)` detail and verifies inactive/quiescent state before capture. This is ordinary Pi close evidence, **not** a managed-process-tree receipt or crash-recovery claim.
- `MissionRecord.originSessionId`, `sourceCwd`, `sourceCutoffId` and `sourceSnapshotId` must identify the real retained `MissionSource.items`. Every original transcript item and original transcript-file byte prefix must remain unchanged through delivery, allowing only the production “Mission created” informational link. The original configuration, usage and session identity are preserved; its permission remains `plan`, with no Mission ownership. The new lead's actual typed `SessionMeta.mission.sourceAccess` must initially be `read_only` (and still be so before A approval).
- The model is asked to retrieve the discussion through its own `mission_context_read` calls. Before A authorization and at A/B completion, the driver checks successful actual tool inputs/results against the retained bytes, including pagination coverage through the full source. It never calls a model tool to manufacture access. New evidence files are `source-user-actions.jsonl`, `source-discussion.json`, `source-conversion.json` and `source-access.json`; full source and lead transcripts remain under `data/sessions/`.
- Original source-tree/HEAD/index equality is checked throughout the ordinary discussion and Mission. Extra permission requests are denied. Host Mission actions remain genuine user question answers and Proceed; plans, work, review, checks and delivery remain model-owned.

### Effective bound contract

| Environment override | Default | Validation |
| --- | --- | --- |
| `VOCS_CODE_MISSION_LIVE_MAX_TOKENS` | `2000000` | Finite positive safe integer, at most the production maximum `1000000000000`; includes cache reads. |
| `VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD` | `12` | Finite positive number, at most the production maximum `1000000`; fractional dollars allowed. |
| `VOCS_CODE_MISSION_LIVE_DEADLINE_MS` | `480000` (8 minutes) | Finite positive integer milliseconds, at most `2147363647` so the test timer plus cleanup allowance cannot overflow. |

Unset values retain defaults. Empty strings, zero, negatives, NaN/Infinity, invalid numeric strings, integer fractions and overflow reject before runtime discovery or a model send. Explicit larger values do not authorize a run themselves. The pending next-A proposal would set `MAX_TOKENS=6000000` **or** `8000000`, `MAX_BUDGET_USD=20`, and `DEADLINE_MS=1200000` (each with the full prefix above), plus explicit `VOCS_CODE_MISSION_LIVE_ONLY=A`; the coordinator must choose and authorize it first.

`metadata.json` records the effective bounds even for a metadata-only check. Each demo's `driver-bounds.json` retains the same bounds, start time and absolute deadline, also copied into observed/shutdown/result artifacts. The deadline is now **one whole-demo deadline**: source discussion and conversion do not reset it, and C's real host restart reloads it rather than granting another phase allowance. This is deliberately tighter than the historical per-phase wait. C host metadata uses separate `metadata-host-<pid>.json` files. Metadata writes are exclusive, and a reused demo directory fails rather than overwriting an earlier failed run; use a fresh root for each separately authorized invocation.

The append-only normalized event journal covers ordinary source plus every Mission participant. Aggregate usage includes those sessions once at their observed cumulative high-water marks; source and Mission breakdowns and unknown-session lists remain explicit in A/B artifacts. Source tokens/cost, terminal turns, distinct tool calls and elapsed time all count against the same driver limits. The production Mission budget still accounts only for Mission-owned sessions; the **independent driver** enforces the broader source-plus-Mission total. Neither layer promises a hard billing ceiling, and missing telemetry is never reported as free usage.

### Verification actually executed in this preparation

```bash
VOCS_CODE_MISSION_LIVE=0 VOCS_CODE_MISSION_METADATA=0 VOCS_CODE_MISSION_LIVE_CHILD=0 npx vitest run tests/mission-live.integration.test.ts -t 'live driver'
# PASS: 18 offline parameter/telemetry guards; metadata and three paid demos intentionally not selected.

VOCS_CODE_MISSION_LIVE=0 VOCS_CODE_MISSION_METADATA=0 VOCS_CODE_MISSION_LIVE_CHILD=0 VOCS_CODE_MISSION_LIVE_MAX_TOKENS=8000000 VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD=20 VOCS_CODE_MISSION_LIVE_DEADLINE_MS=1200000 npx vitest run tests/mission-live.integration.test.ts -t 'live driver'
# PASS: the same 18 guards with raised environment bounds; four opt-in tests not selected.

npm run typecheck:test
# PASS after correcting a driver optional-payload narrowing error found by the first invocation.

RUN_ROOT="$(node -e "process.stdout.write(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'vocs-mission-metadata-')))")"
VOCS_CODE_MISSION_LIVE=0 VOCS_CODE_MISSION_METADATA=1 VOCS_CODE_MISSION_LIVE_CHILD=0 VOCS_CODE_MISSION_LIVE_ONLY=A VOCS_CODE_MISSION_LIVE_PROVIDER=openai-codex VOCS_CODE_MISSION_LIVE_MODEL=gpt-6-astra VOCS_CODE_MISSION_LIVE_MAX_TOKENS=8000000 VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD=20 VOCS_CODE_MISSION_LIVE_DEADLINE_MS=1200000 VOCS_CODE_MISSION_LIVE_ROOT="$RUN_ROOT" npx vitest run tests/mission-live.integration.test.ts -t 'metadata: real available'
# PASS: one real Pi metadata test; 20 other tests not selected. No provider prompt.
```

Metadata artifact: `C:\Users\vocs\AppData\Local\Temp\vocs-mission-metadata-T5zWaR\metadata.json`, captured at `2026-09-25T10:37:39.225Z`. It records Pi `0.85.1`, the actual `openai-codex/gpt-6-astra` catalog entry and effective **8,000,000 / $20 / 1,200,000 ms / 36 turns / 160 tools**. No source/Mission session was started by that check. Offline coverage verifies default/override validation, aggregate source-plus-participant token/cost caps, unchanged turn/tool caps, cumulative deduplication, unknown telemetry, journal reload, deadline non-reset/non-widening and refusal to replace a missing/different Mission during the explicit C restart. Those passing tests are **not** live source-conversion, review, delivery or recovery coverage. Broad typecheck/test/build gates were intentionally left to the coordinator.

**Gap at preparation:** the newly prepared actual conversation → positive Stop → immutable source conversion → model-owned source access path had not run live. Neither that preparation nor the metadata pass changed `UKhbU5`'s failed outcome: **2,053,136 tokens / $4.412888**, no substantive candidate/review/counted check/delivery. All previous failure artifacts and the **$9.394716** historical observed subtotal through that stage remain as documented. A still needs a successful run covering independent review, counted checks and actual local delivery; B's real overlapping workers and C's intended pause/conflict/crash/restart/positive-ownership reconciliation remain unvisited. The preparation itself spent no additional provider credit.

## Single authorized Demo A — genuine discussion, blocked at ordinary Stop proof (11:49–11:50 UTC)

The coordinator explicitly authorized **one** diagnostic A on the current production working tree with **8,000,000 aggregate observed tokens / $20 observed cost / 1,200,000 ms**. The 36-turn/160-tool limits were unchanged. These remain stop-on-observation thresholds, not provider billing guarantees. No B/C, automatic retry, production mutation, fabricated source/model state or manually invoked Mission model tool followed.

```bash
VOCS_CODE_MISSION_LIVE=1 VOCS_CODE_MISSION_LIVE_ONLY=A VOCS_CODE_MISSION_LIVE_PROVIDER=openai-codex VOCS_CODE_MISSION_LIVE_MODEL=gpt-6-astra VOCS_CODE_MISSION_LIVE_MAX_TOKENS=8000000 VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD=20 VOCS_CODE_MISSION_LIVE_DEADLINE_MS=1200000 npx vitest run tests/mission-live.integration.test.ts
# FAIL (exit 1): Demo A failed; 19 passed (18 driver guards plus real metadata).
# B and C were intentionally not selected (two skipped), not successful demonstrations.
# Tool timeout: 1600 seconds. Actual selected Demo A: 25.532s; Vitest: 27.71s.
# Complete invocation including startup/teardown: 29.092s.
```

A fresh `VOCS_CODE_MISSION_LIVE_ROOT` was supplied solely to retain the console alongside driver artifacts; inherited child-host/resume selectors were unset. The exact command, UTC timestamps and checkout HEAD are retained in `invocation.json`. No additional suite selection or worker flags were added.

- **Artifacts:** `C:\Users\vocs\AppData\Local\Temp\vocs-mission-live-bIKxvy\A`; parent files `console.log`, `invocation.json`, `metadata.json`. Source session: `s_mugwf7kj10554`. **No Mission ID exists.** Checkout HEAD was `66aa41b40b55888182d6fb2bb28eadd6d0a6fa22`; this is current-working-tree evidence, not a frozen release build. The graph index predates the untracked Mission implementation.
- **Actual runtime/model:** installed Pi `0.85.1`, `openai-codex/gpt-6-astra`, present in the real model catalog and persisted as the source's `activeModel`; `activeEffort: high` was observed. The isolated configuration selected the exact T5 preset `live-principal@1`, but **no Mission lead or T5-owned attempt started**. Existing CLI authentication was used without reading, copying or logging credentials.
- **Genuine source activity:** one user discussion prompt, two successful actual `read` calls (`core.cjs`, `baseline.test.cjs`), one nonempty final assistant discussion and exactly one completed terminal turn (14.156s). The model left whitespace-only handling and case preservation explicitly unresolved. Its session remained ordinary, `permissionMode: plan`, no Mission ownership; no command, write, delegation, question answer or Proceed occurred. There were **no model/tool errors or extra permission requests**. Full inputs/results are in `data/sessions/s_mugwf7kj10554/transcript.jsonl`; append-only updates are deduplicated by item ID when counting.
- **Exact failure:** `Source Pi close was not positively observed; refusing Mission capture.` The genuine Stop was recorded at `2026-09-25T11:50:11.211Z` in `source-user-actions.jsonl`; `runtime.log` records `stopping pi` at `.212Z`. The driver then exhausted its ten-second positive-close observation window. `events.jsonl` has zero normalized `stopped` events; the last source status is `idle`. This is the failing driver assertion at `tests/mission-live.integration.test.ts:379`, not a failed model tool or a budget stop.
- **Read-only boundary diagnosis:** current `SessionManager.stop()` deletes the active entry before calling adapter disposal (`src/main/session-manager.ts:1331`). The `current()` predicate requires that same entry (`:932`), and `buildContext` gates `emit` on it (`:872`). Pi emits its close-derived `stopped` event through that context (`src/main/harness/pi.ts:381–389`). Therefore this driver's post-Stop event cannot traverse the current manager boundary even if Pi closes. No production fix or weakened driver assertion was applied. This static explanation is **not** evidence that the ordinary process tree stopped.
- **Usage:** **9,191 aggregate observed tokens / $0.073926**, all from the ordinary source: 6,191 input, 184 output, 2,816 cache-read, zero cache-write/reasoning. One terminal turn, two distinct tool calls; no unknown token/cost sessions. No Mission participant exists; its empty usage list is not a fabricated zero-cost session. Including this invocation, the historical observed subtotal documented here is **$9.468642**, not an invoice or hard billing ceiling.
- **Retained final state:** `observed.json` and `after-shutdown.json` both contain zero Mission records; the Mission directory is empty. Zero questions, execution authorizations, profiles, tasks, attempts, candidates, reviews, counted checks, integrations or delivery. `source-discussion.json`, `source-conversion.json`, `source-access.json`, `before-authorization.json` and Mission `user-actions.jsonl` were not written because the prerequisite failed. The actual source transcript remains retained, but immutable conversion/model retrieval were not reached and are not certified.
- **Source preservation:** baseline and post-run HEAD `254f35b9add573973109e97b39416e6fb365a6d9`, index, clean status and file digest `ceb5dcf3356a632bd34a53040d7d16214ec98b2e5383c6118002deb6ac7ea0ea` match exactly. A separate read-only post-run audit recomputed them and checked the retained terminal state, successful reads, exact model and aggregate telemetry. It did not run fixture tests to substitute for Mission evidence.
- **Teardown limitation:** `closeErrors` is empty, but a successful `stop()` return and idle metadata do **not** prove the ordinary process tree is gone. No ordinary ownership directory/receipt was retained, and no close event was observed. **Ordinary owned-tree teardown remains unproven.** No managed participant was launched, so there is no managed teardown receipt to inspect and no positive managed-tree claim. Unknown ownership and all artifacts were preserved; no process enumeration, broad kill or fabricated receipt was used in follow-up.

```bash
node 'C:/Users/vocs/AppData/Local/Temp/vocs-mission-live-bIKxvy/A/follow-up-audit.cjs'
# PASS: read-only retained-evidence/source-equality assertions; demo outcome remains FAILED.
```

The audit writes only the exclusive evidence file `follow-up-audit.json` beside its retained `follow-up-audit.cjs`; neither invokes a provider or production service. This delegated run changed only this evidence report in the checkout. Broad typecheck/test/build gates remain with the coordinator; no commit, push or PR was performed. Preserve all prior failures, including `UKhbU5` and C's unknown ownership receipt. **A acceptance is still absent; no further paid run is authorized by this report.**

## N2 driver preparation — read-only source stays idle; fresh paid A held

The coordinator confirmed this is a **driver defect**, not a core ownership redesign: spec §3.1 (`docs/MISSION-SPEC-v0.2.md:133`) permits a read-only source conversation to remain uninterrupted. The failed `bIKxvy` Stop tried to observe a late adapter event that `SessionManager.stop()` deliberately fences. Its failed outcome, source transcript, **9,191 tokens / $0.073926**, and teardown limitations above remain historical evidence; they are not relabeled as success.

Only `tests/mission-live.integration.test.ts` and this report changed for N2:

- The real driver still sends exactly one ordinary plan-mode discussion prompt and requires an actual nonempty final assistant discussion and exactly one completed turn. It now leaves that source **idle**, without Stop or a post-Stop close-event requirement. Source tool history may contain only `read`, `rg`, `glob` and `ls`; every latest tool result must be successful and settled. Pending/failed/declined reads, writable tools, an incomplete turn, queued activity or uncertainty refuse capture. The persisted source transcript is checked independently of event observations.
- The source retention artifact records `settledAt`, the actual completed turn, deduplicated settled read tools and observed activity, rather than inventing a stopped event. Original transcript items/byte prefix, configuration, usage ledger, identity, cwd, cutoff/snapshot links and unchanged source HEAD/index/tree remain asserted through the existing conversion/delivery path. Actual model-owned retrieval via `mission_context_read` is still required.
- `runDemo` still calls the real `MissionRuntime.service.create` directly. Production admission, quiescence and baseline provisioning remain responsible for capture; **no externally acquired non-reentrant lease surrounds create**. This fixed read-only fixture does not weaken or certify the separate N1 ordinary-writable/background-writer guard.
- Ordinary idle/quiescent observations are **not owned-tree teardown proof**. Managed Mission shutdown/recovery still requires production-owned teardown and real exact ownership receipts. No ownership inspector, shutdown policy, production file, model state, credential handling, driver answer/Proceed policy or spending limit changed. Offline observation fixtures test only the driver's retention boundary; they never seed a live model/session or stand in for live acceptance.

Verification actually run:

```bash
VOCS_CODE_MISSION_LIVE=0 VOCS_CODE_MISSION_METADATA=0 VOCS_CODE_MISSION_LIVE_CHILD=0 npx vitest run tests/mission-live.integration.test.ts -t 'live driver source retention guards'
# RED before the fix: one executed regression failed at the Stop trap:
# Read-only source retention must not request Stop.

VOCS_CODE_MISSION_LIVE=0 VOCS_CODE_MISSION_METADATA=0 VOCS_CODE_MISSION_LIVE_CHILD=0 npx vitest run tests/mission-live.integration.test.ts -t 'live driver'
# PASS after the fix: 22 executed offline guards, including four new source-retention regressions.
# Metadata and all three paid demos intentionally not selected (four skipped), not live successes.

VOCS_CODE_MISSION_LIVE=0 VOCS_CODE_MISSION_METADATA=0 VOCS_CODE_MISSION_LIVE_CHILD=0 VOCS_CODE_MISSION_LIVE_MAX_TOKENS=8000000 VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD=20 VOCS_CODE_MISSION_LIVE_DEADLINE_MS=1200000 npx vitest run tests/mission-live.integration.test.ts -t 'live driver'
# PASS: the same 22 guards with the prepared bounds; four opt-in tests not selected.

npm run typecheck:test
# First invocation FAIL outside the owned files while other agents' work is in progress:
# src/main/mission/state.ts:165,182,581 — completion-report schema/builder missing deliveryPolicy.
# tests/mission-ui.test.tsx:380,403,406,417,422 — exact is not a ByRoleOptions property.
# Second invocation FAIL: only those five mission-ui.test.tsx diagnostics remained.
# No error was reported in tests/mission-live.integration.test.ts; no out-of-scope edits were made.
```

The next command is **prepared, not executed and not automatic authorization**. Await explicit coordinator GO on a settled production snapshot and notify immediately before invocation. Run it once with a **1600-second tool timeout**; keep 36 turns/160 tools, retain the first failure, and do not retry the whole Mission or run B/C:

```bash
VOCS_CODE_MISSION_LIVE=1 VOCS_CODE_MISSION_LIVE_ONLY=A VOCS_CODE_MISSION_LIVE_PROVIDER=openai-codex VOCS_CODE_MISSION_LIVE_MODEL=gpt-6-astra VOCS_CODE_MISSION_LIVE_MAX_TOKENS=8000000 VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD=20 VOCS_CODE_MISSION_LIVE_DEADLINE_MS=1200000 npx vitest run tests/mission-live.integration.test.ts
```

No paid run, metadata probe, full heavy gate, credential read, production edit, checkout commit, push or PR was performed in this preparation. Full integration gates and PR ownership remain with the coordinator. **No new live conversion, review, counted-check, delivery or teardown result is claimed; the historical observed subtotal remains $9.468642.**

## Repeatability and safety

- `VOCS_CODE_MISSION_LIVE=1` is required to spend provider credit. Missing runtime/model/authentication fails a requested live run; it never becomes an offline fixture or successful skip.
- Paid execution now requires explicit `VOCS_CODE_MISSION_LIVE_ONLY=A|B|C`; omitting it or supplying an invalid selection fails, never implicitly running B/C. The metadata test alone does not satisfy live acceptance.
- **Default driver limits:** one eight-minute whole-demo deadline, 36 distinct terminal-turn IDs, 160 distinct tool-call IDs, two concurrent workers, three turn slots, one heavy check, **2,000,000 aggregate observed tokens including cache reads** and **$12 aggregate observed cost**. Only the three validated explicit overrides above change tokens/cost/deadline; source discussion counts against every driver limit. The initial runs used a historical 450,000-token allowance, and later runs used 2,000,000; neither is retroactively relabeled. Observations are not provider-side billing caps and may overshoot. C reloads both the append-only usage journal and original absolute deadline. Unknown token/cost session totals stay explicitly unknown, never silently zero/free. A/B/C also stop after 100 seconds of settled Mission inactivity. There are no automatic whole-demo retries.
- A/B drivers send a real ordinary plan-mode Pi discussion and leave it idle only after its actual completed turn and successful settled allowed read tools; they no longer require the impossible post-Stop event used by `bIKxvy`. This is not ordinary owned-tree proof and does not authorize a writable source exemption. Later stages require the actual retained transcript, genuine user answers to material Mission questions, and approval of a pending execution proposal. Models supply the discussion and create plans/profiles/tasks, claim/delegate, edit, read source context, review, request checks/integration and finish themselves. Source transcript/configuration and tree/HEAD/index checks are intended to continue through local delivery. Unexpected extra permission requests are denied and fail the run.
- C is intended to pause an active worker, Resume, kill a separate real Node/Vitest runtime host at a recorded integration operation, inject one safe retained external integration edit, restart from the same isolated store, Resume explicitly, and require preserved IDs/no duplicate candidate or integration effect. The final driver additionally requires positive production ownership receipts **before** injecting the conflict or restarting; an absent/unknown proof fails closed. It records cleanup proof, requires the exact retained Mission ID on the replacement host (missing/different state fails before new Mission creation), waits for acknowledgement of the actual Resume action, and checks local-delivery/test evidence if recovery completes. These post-blocker paths remain unexercised; they are test design, not evidence.
- Initial blockers above are historical findings, not claims that later production fixes are still missing. Live acceptance remains outstanding until genuine model-owned planning, implementation, independent review, counted checks and local delivery pass. The earlier authorization for one 8,000,000-token / $20 / 20-minute A was used by the failed `bIKxvy` invocation. A separately proposed single fresh A with those same bounds is prepared but **held until explicit coordinator GO after production fixes settle**; no automatic retry is implied and B/C remain held. No production fix or manual model-tool invocation was made by this delegated driver/report task.
