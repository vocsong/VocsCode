# Missions

A Mission is a durable engineering objective with one principal engineer and generated specialists. It uses the normal session transcript, permissions, provider connections and panels; it is not another chat application or an OS sandbox.

**Implementation/certification status:** see [the acceptance ledger](MISSION-IMPLEMENTATION.md). Passing deterministic or scripted-runtime tests does not certify a live provider. Do not infer Mission support from the ordinary harness feature table.

## Configure and launch

In Settings → Missions, create reusable **execution presets**: harness, exact provider/model connection, and either an explicit supported reasoning effort or the runtime's **Default**. A preset is an execution configuration, not a specialist role. Default does not inherit the application's global effort setting.

Place presets in the five tier pools and select the default principal engineer from **T5**. T1–T4 may be empty. Several T5 alternatives are valid. The same model with a different harness, connection or effort is a different preset. Mission dispatch never silently downgrades a missing T5, substitutes another account, or treats a model-catalog entry as runtime certification.

Project overrides can narrow the available roster/providers and limits. Disabling/removing a preset prevents new dispatches while preserving historical attempt snapshots. Explicitly applying configuration to an existing Mission is a user action, not a model tool.

Launch from New Session, or from an ordinary conversation:

| Command | Meaning |
| --- | --- |
| `/mission <objective>` | Autonomous Mission: investigate, record reasonable assumptions, then execute without a routine plan gate. |
| `/mission plan <objective>` | Plan together, one consequential question at a time; source stays read-only until a specific plan is approved. |
| `/mission start -- <literal objective>` | Literal escape, including objectives beginning with a reserved command or containing flags. |
| `/mission` | Open the Mission surface/launch options. |
| `/mission status` | Inspect the current Mission. |
| `/mission execute` | Approve the current pending proposal, not an arbitrary earlier design message. |
| `/mission pause`, `/mission resume`, `/mission stop` | Control the current Mission through the host. |

`/missionary` is not a command. Control commands do not accept arguments. A linked launch keeps a complete authorized source snapshot, including prior discussion attachments and images attached to the submitted command, at its recorded cutoff; it does not inherit the discussion's spending or change its selected model. A source too large for the explicit 64 MiB limit fails rather than being silently truncated.

Images on `/mission <objective>` or `/mission plan <objective>` are retained as launch context, or as user steering in an existing Mission. Bare `/mission` and control/status commands do not accept images: they fail visibly and leave the draft/attachments intact. Add an objective or remove the images before opening the dialog or applying a control.

## Working with a Mission

The header/panel shows the objective, phase/status, plan revision, tasks, generated profiles, attempts, questions, evidence, blockers and actual delivery. The regular composer talks to the principal engineer. Specialists have read-only inspection and an **Ask lead about this** path, not separate user conversations or native delegation controls. Their permission cards remain accessible.

Use **Mission panel → Plan → Export plan.md** to save the latest structured plan through the desktop Save As dialog, including while paused, completed or archived. It includes questions/answers, assumptions, decisions, criteria, specialist profiles, task contracts/dependencies, configured checks and delivery limits. The export is a read-only snapshot, not an approval or import API; editing it never changes the Mission. No file is written until you choose a destination, and retained/uncertain managed workspaces remain protected even when selected through a filesystem alias. Exports over 1 MiB fail explicitly without truncation. Browser/remote views show an explicit desktop-required message; their read-only export getter grants no desktop save permission.

An earlier “ok” to a question is not permission to implement. A “yes” with new images is clarification context, not execution approval; the lead must consider that context before asking again. Proceed is bound to the pending proposal and exact specification/plan revision; material changes invalidate stale approval. Tool output, quoted messages and worker prose cannot authorize execution. Autonomous mode still obeys permission prompts and repository requirements for genuine approvals.

The principal engineer can claim implementation tasks directly. Every writer gets a managed worktree. Worker and lead changes become immutable host-captured candidates, not self-reported file lists. The accepted result workspace is distinct from a participant's tool workspace; inspecting a worker must not replace the main result diff. Integration is serialized and checked against the expected accepted content. Builds/tests run against isolated candidate or combined content, not the original checkout.

Completion requires current required outcomes, settled attempts/operations, substantive independent review, actual counted verification and a delivery receipt. An idle engine, accepted `send()`, exit-zero skipped suite, confident answer or `GOAL_COMPLETE` string cannot satisfy those gates.

Every completion atomically retains a **Vocs Code · Mission completion report**, visible as a final answer in the main lead conversation outside the collapsed Worked header. It summarizes final-content checks and actual counts, independent review, task outcomes, recorded limitations/exclusions, assumptions/decisions, check exceptions, policy holds and actual local/merge commit and PR identifiers. The Mission panel also shows those identifiers. The report survives restart and stays before later read-only questions in the conversation. It is generated after explicit Resume for recovered delivery receipts, even when the lead supplied no prose. Valid older completed journals without a cached report are reconstructed from their frozen facts and retained by the host, not sent back to a model. Optional lead narrative is labelled unverified and kept separate; it cannot invent checks, waive gates, declare completion or supply delivery IDs. The structured journal and genuine host receipts remain authoritative, not rendered text or Markdown.

## Questions after completion

Use **Ask lead** in the same completed conversation for explanations of retained checks, decisions and delivery. Each genuine user question gets one actual model answer with only `mission_read` and `mission_context_read`; it is not an FAQ, a resumed implementation loop or another Mission. The completed status, report, specification, configuration, tasks, progress, evidence and delivery remain unchanged. New implementation requires the user to explicitly start a linked follow-up with `/mission start -- <objective>`; a request in Q&A grants no execution authority.

Each answer has separate observed usage and bounds: one turn, two minutes after capacity admission, 32 observed tool calls and 16,000 observed output tokens. Retained conversation/cache input does not consume that additional output allowance, but still counts toward the original whole-Mission token/USD limits. Those limits, current preset/connection revocation and global/account capacity still apply. Q&A usage is not execution progress or a billing total; absent/unchanged telemetry remains unknown and in-flight/delayed counters can overshoot. This short answer watchdog does not impose a time limit on implementation work.

**Cancel answer** (or Pause/Stop while answering) cancels only the answer and preserves the completed outcome. Archive first positively disposes owned answer activity; uncertain teardown holds its capacity and prevents new questions/cleanup. Restart never replays the prompt: an interrupted answer needs a new explicit question after positive ownership reconciliation. Unknown recovered answer processes continue to count against global/account capacity, including after limits are tightened.

## Baseline, permissions and resources

- Planning can inspect a dirty source. Execution requires an explicit clean Git baseline. Non-Git/unborn repositories, unresolved conflicts and unsafe indexes are blockers; Mission does not initialize, stash, reset or discard them for you.
- Source snapshots and candidates are content-bound. Unexpected worktree drift is retained for reconciliation, not overwritten. Git worktrees share repository administration and are **not** security isolation from arbitrary code.
- Capture/refresh/integration holds an exclusive application-owned admission lease. Model startup/dispatch and shell startup cannot race that lease. An idle poll is not proof of quiescence.
- Registered native delegation/goal controls are disabled for managed participants. This does not make shell execution or third-party programs a sandbox.
- Host verification/delivery follows the selected permission ceiling and actual user approval channel. Remote view-only access cannot mutate Mission state or invoke privileged controls through ordinary session aliases.
- Verification isolates home/profile/temp/XDG directories and exposes cooperative `PORT`/`VOCS_MISSION_PORT` allocation. Checks must honor those values and the application's user-data override. Hardcoded ports or explicitly chosen external profiles are not automatically isolated.
- Required test evidence needs an executed-test report. Missing tools/credentials, unsupported reporters and skipped required checks remain visible blockers. Builds without test counts are valid build evidence, not test evidence.

## Project delivery and check policy

Mission reads repository instructions (`AGENTS.md`, `CLAUDE.md`, `.vocs-code/INSTRUCTIONS.md`) and relevant local testing/release links. It retains the policy provenance. No publishing instruction means **local commit**, not permission to push or deploy. Ambiguous targets, conflicting grants or unreadable policy block delivery.

To override publication **downward for this Mission**, use its panel's **Delivery → Keep Mission local** (no push/PR/merge), or **Open PR only** (no merge). Only an existing merge endpoint can become open PR/local commit; an open-PR endpoint can become local commit. These explicit genuine-user controls pause owned work, record immutable user-action provenance and an append-only publication ceiling, and require an explicit Resume after reconciliation. The ceiling survives restart, repository policy rereads and approved-target refresh. It cannot be lifted for this Mission, and cannot change its remote, branch or URL, grant permissions, waive checks or independent review, or clear holds/conflicts. A local-only policy reread still discovers required checks/holds but does not probe the remote target.

Natural-language steering such as “keep this Mission local” is not parsed as policy authority. The lead can request that you use the explicit Delivery control through a question; neither the model, quoted text nor an answer can grant an endpoint. Use the control rather than relying on a model's promise not to publish.

Narrowing is **not rollback**. Already-admitted remote delivery or target activity may finish before its owned boundary settles. The UI warns and retains a blocker/old intent for receipt reconciliation; it does not erase an existing commit/PR, force/reset a delivery branch, or silently replay under a new operation ID. In particular, a local commit already created under a remote-delivery intent is retained, not relabeled as a fresh successful local delivery. Late or uncertain delivery may remain blocked; pre-delivery narrowing can finish at a verified local commit normally. All recorded checks, reviews and holds remain intact.

For a precise policy, commit `.vocs-code/mission-delivery.json`. Version 1 accepts `local_commit`, `open_pr` or `merge_pr`. Remote endpoints require explicit `remote`, `targetBranch` and `allowPush`; merge additionally requires `allowMerge`. No branch name such as `develop` is universal.

Example for a dependency-free Node project:

```json
{
  "version": 1,
  "endpoint": "local_commit",
  "requireIndependentReview": true,
  "checks": [
    {
      "id": "behavior-tests",
      "name": "Feature behavior",
      "kind": "test",
      "command": "node --test --test-reporter=tap tests/feature.test.cjs",
      "criterionIds": ["feature-behavior"],
      "required": true,
      "heavy": true,
      "testReport": {
        "format": "node-tap",
        "minimumTests": 1,
        "maximumSkipped": 0
      },
      "timeoutMs": 60000
    }
  ]
}
```

Check kinds are `build`, `test`, and `behavior`. Tests require `node-tap` or `vitest-json`, counts, and the actual report; an optional relative `testReport.path` names the generated report. Arrange dependency/setup commands explicitly for fresh verification worktrees rather than relying on the original checkout's ignored build output. Setup is part of the approved command, not a planning-time side effect. Count exceptions must be explicit project policy; an all-skipped requested suite is never implicitly approved.

Present npm `typecheck`, `test` and `build` scripts are baseline gates when no manifest is supplied. An unrecognized test reporter requires explicit configuration. The principal engineer adds behavior-specific checks without removing existing required outcomes or widening publishing rights.

`holdConditions` records explicit human-review reasons. `holdIsEndpoint: true` permits the configured review hold to be reported as the final policy outcome; it is never reported as a merge. Documented permission/secrets review conditions are checked again against actual captured change paths before publishing. Delivery records exact commit/PR/merge identifiers and uses operation receipts to reconcile acknowledgment loss instead of repeating remote actions blindly.

## Pause, restart and cleanup

Pause/Stop fences new admission first, then reconciles positively owned activity. A timeout, root-process exit or failed kill request is not proof all descendants stopped. Uncertain ownership remains blocked and cannot be replaced with another writer on the same mutable workspace.

Restart restores records but does **not** automatically resume execution. Inspect retained state and choose Resume. An empty new SessionManager is not evidence that old external effects finished. Missing or ambiguous dispatch/process/integration/remote receipts need reconciliation rather than automatic replay.

Retain worktrees by default. Explicit cleanup only removes positively owned, quiescent, fully accounted work; dirty/untracked uncaptured content and the original checkout are never force-deleted. Archive/delete/rewind/fork/revert and generic Git/shell controls are guarded at the host boundary, not merely hidden in the UI.

## Limits and support

The defaults are four workers per Mission, ten global agent turns, one global heavy check and no nested worker delegation. The five pools remain empty until explicitly configured. Capacity remains owned through tool/approval waits and uncertain teardown; a principal-engineer scheduling opportunity is reserved.

Verification progress means a new captured finding, not a fresh request key or evidence ID. A first executed failing test, changed failure output, or changed input can expose a new finding; repeated identical outcomes on the same check/content do not. Duplicate pending verification requests are refused. The existing `maxTaskAttemptsBeforeLeadDiagnosis` limit also bounds repeated unsuccessful same-input verification: reaching it pauses automation and retains every receipt and artifact. Resume alone does not reset this bound; the lead must record and resolve a decision referencing the latest failure and a diagnosed changed approach, or verify changed input. An actual user approval denial pauses immediately without implementation-failure attribution or automatic approval re-prompts.

Settings offers optional **observed Mission cost (USD)** and **token thresholds**, with no monetary or time default. Each covers the entire Mission: all lead generations, workers, repeated attempts and resumed sessions. The Mission cap is not copied into every session. Admission rechecks the aggregate before dispatch; advancing normalized usage and settled-turn checkpoints can pause automation and reconcile owned work. A paused Mission needs an explicit Resume after the user applies a sufficient threshold or removes it.

These are observed-usage controls, **not guaranteed spending ceilings**. Concurrent/in-flight calls, delayed telemetry and interruption latency can overshoot. Cost may be reported or API-equivalent estimated usage, not a subscription invoice or a certified provider balance. A zero or unchanged cost counter after work is unknown billing, not free execution; an explicit USD threshold conservatively pauses in that case. Missing token telemetry also pauses when a token threshold is configured. Each settled dispatch needs its own observed advance; an earlier paid turn does not certify later missing telemetry. Old history without that observation remains unknown. No elapsed-time/silent-chat budget kills healthy long work.

Usage comes from owned session cumulative ledgers, with durable high-water checkpoints for restart—not sums of every usage event, turn row, reasoning subset or native-child notification. Source discussion spend is not part of the Mission; reasoning is already included in output, and cache traffic is included in token totals. Already-observed usage is not refunded by a retry, restart, or a stale session-index write.

**Account capacity** is a separate app-wide setting: up to 64 explicit connection IDs, each with 1–128 turn slots. The key is the preset's connection ID, or provider ID when it has no separate connection. Production scheduler startup and settings updates use that map for all Missions, leads and workers; existing leases drain normally when capacity is tightened. A full account queues work without changing the account, model, effort or billing path. Project overrides cannot replace these app-wide account limits. The map is only a concurrency limit, not account provisioning or provider-quota detection.

Current certification evidence and unresolved requirements live in [MISSION-IMPLEMENTATION.md](MISSION-IMPLEMENTATION.md). Claude's prompt-free API cannot yet establish all required effective model/effort/connection observations, so its Mission driver remains unverified. Ordinary Claude sessions are unaffected. Cross-harness, macOS/Linux, and live-provider Mission support must be demonstrated independently, not inferred from the Windows/scripted Pi tests.
