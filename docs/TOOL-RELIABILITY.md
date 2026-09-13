# Tool reliability

Tool labels retain each harness's spelling (`Read`, `read`, `read_file`). Casing alone does not explain error rates. Different models, prompts, tool schemas, workloads and permissions can all affect the comparison; these changes are not evidence of a measured reduction in model mistakes.

## Harness/tool analytics

Analytics → Tools & files includes **Harness/tool reliability**, alongside the existing model breakdown. The table reports calls, errors and declined operations for each harness/tool pair. Its error rate is `errors / (calls - declined)`; with no executed calls it shows `—`.

Only tool-name casing is combined. `Read` and `read` combine within a harness; `read_file` remains a distinct name. Compare the same model and workload across harnesses. The older model table still labels its own denominator as errors/calls.

Harness/tool attribution starts with newly recorded calls after this update. Historical aggregates are not guessed or replayed to populate the new dimension. Unknown sessions remain unattributed. All-time and selected-date views use their corresponding recorded counters. Recent duplicate terminal events are suppressed across restart using the latest 10,000 call identities persisted with the counters; older identities are retained only in process memory.

## Pi compatibility and permissions

Vocs Code retains Pi's own file/shell execution, output truncation, image handling, edit matching, streaming and settings. Same-name extension wrappers normalize these argument aliases **before validation and permission dispatch**:

| Tool | Accepted alias | Canonical Pi argument |
| --- | --- | --- |
| read, write, edit | `file_path` | `path` |
| edit | `old_string`, `new_string` | One `edits[]` entry with `oldText`, `newText` |
| bash | `timeout_ms` | `timeout`, divided by 1000 |

Canonical and legacy Pi edit inputs still work. Empty replacement strings are valid. Conflicting paths, edit shapes or timeout fields fail without executing. `timeout` continues to mean **seconds**; values are never guessed from their size. `replace_all: false` is accepted; `replace_all: true` is explicitly unsupported, with instructions to use unique, non-overlapping edits instead. Tool names are not renamed.

The inspected API target is Pi **0.85.1**. Vocs Code requires readiness from both shipped extensions before sending a prompt. Missing APIs, failed extension loading and competing overrides produce an actionable startup failure rather than silently running without the required extensions. The compatibility resource imports public APIs supplied by the running Pi; no new desktop dependency is installed.

User/plan-mode blocks are correlated by tool-call id through host approval responses or structured extension notifications. The adapter does not infer denial from tool output or error prose. Declined/failed writes do not report file changes. Missing approval infrastructure remains an error, not a successful operation or intentional denial.

The Pi gate includes optional PowerShell, follows existing file ancestors to detect junction/symlink escapes, and conservatively prompts for Pi-specific expanded path spellings. Invalid/unreadable permission-mode files revert to asking. Dangerous commands and outside-project file mutations still prompt below Full access despite a session grant. Pi extensions remain trusted code; these checks are not an OS sandbox or exhaustive shell-command analysis.

## Native tools

- **Shell:** bounded head-and-tail output, an explicit omitted count, exit code and timeout/cancellation status reach the model as well as the transcript. `timeout_ms` is milliseconds. There is no automatic mutation retry and no full-output spill file; commands needing complete logs should redirect explicitly.
- **Read:** validated text reads, cwd-aware errors, invalid-offset/EOF feedback and continuation offsets. Byte-limited pages include a UTF-8-safe `byte_offset` to continue even within a long line.
- **Mutations:** existing-file edits and overwrites require a fully observed current version. Read pages accumulate coverage only for the same content fingerprint. Unread, incompletely read or stale content is rejected. Own successful changes refresh the observation; restart and rewind clear it. The version is checked again immediately before replacing the file, including after approval. These checks reduce lost updates but are not filesystem compare-and-swap against external writers.
- **Search:** cap notices distinguish exactly-at-limit from overflow, matching line truncation is visible, and fallback skipped inputs are reported. Ripgrep and fallback use the same smart-case decision for common patterns; their regex/ignore semantics still differ. The JavaScript fallback runs regex matching in a cancellable worker rather than risking the main process.

## Verification tiers

The offline native regression suite requires `rg` (ripgrep) on PATH to exercise the real engine as well as the fallback; Ubuntu CI installs it explicitly. Windows shell tests also require a working shell and Node on PATH.

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e:ci

# Real Pi CLI, scripted provider, no credit. Missing selected runtime fails.
VOCS_CODE_PI_INTEGRATION=1 npx vitest run tests/pi-tool-compatibility.integration.test.ts

# Actual Electron → Pi → tools, no provider credit.
VOCS_CODE_PI_INTEGRATION=1 VOCS_CODE_E2E_UI=1 npx vitest run tests/e2e.pi-tools.test.ts

# Provider-backed adapter and approval checks.
HARNESS_SMOKE=1 HARNESS_SMOKE_RESUME=1 HARNESS_SMOKE_ONLY=pi,native,native-tools npx vitest run tests/smoke.live.test.ts
HARNESS_E2E=1 npx vitest run tests/e2e.approval.test.ts
```

The Pi integration runtime can be selected with `VOCS_CODE_PI_PACKAGE_DIR` (installed package directory). The CLI resource-loading tests accept `VOCS_CODE_PI_RESOURCES_DIR`; set it to `dist/win-unpacked/resources/pi` after `npm run dist:dir`. Electron suites for Pi tools, approvals and vision/analytics accept `HARNESS_E2E_EXE` to exercise the packaged application. Do not count excluded live suites as verification; inspect actual executed tests.
