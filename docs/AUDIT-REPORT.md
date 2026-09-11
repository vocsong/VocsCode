# Vocs Code - Repository Audit

Scope: 64 TypeScript/TSX files, 13,730 lines under `src/` and `tests/`, at commit `8e6bf5e` on branch `harness/s-mtveeu94emc26` (2026-09-10). Method: ten domain auditors ran in parallel over disjoint file slices; all 76 raw findings then went through adversarial verification (at least one independent agent per finding, with the single exception of the stale README test count, which the baseline run confirmed first-hand; plus a second reproduction-focused verifier for every critical/high), 92 verification agent runs in total; 70 survived, five were refuted and dropped, one could not be verified, and after merging cross-slice duplicates 66 distinct verified findings remain. Two completeness critics then swept slice seams and the build/packaging/config surface: 10 additional findings were **not** adversarially verified, and an 11th critic candidate - the stale README test count - was confirmed first-hand by the baseline `npm test` run and is counted in the 66 rather than in the unverified set.

Headline: the runtime is broadly sound and the tests build is green, but the repository does **not** pass its own documented gate at this commit (`npm run typecheck` fails on a duplicate import), and the security model's central written promise - "any write outside the workspace always prompts below Full access" - is violated by model-reachable paths in the native and ACP harness layers; the git handlers (`git:revert`/`git:diff`) are a further, unvalidated IPC boundary of the same class whose exploitability depends on a compromised renderer (the verifiers on that finding split, two partially-confirmed to one confirmed).

## The systemic issue

The security findings in this report are not six unrelated bugs: they are one defect class. **The permission gate is a best-effort string/regex blocklist, not a capability check, and each adapter applies it inconsistently.**

- The native adapter re-implements containment with a raw `String.startsWith` at `native/index.ts:267` instead of the existing `isOutsideWorkspace` (`permissions.ts:41`).
- ACP's `writeTextFile` (`acp.ts:198`) never calls `gateAction` at all; its tool path calls `isDangerousCommand` directly and re-implements the gating block at `acp.ts:262-266` rather than `gateAction`.
- `claude.ts:210-214` returns the SDK's `updatedPermissions`, so a later matching call skips `canUseTool`/`gateAction` and the host-side dangerous-command and outside-workspace checks never run.
- The Codex legacy `applyPatchApproval` path (`codex-app-server.ts:377-381`) approves without reading `fileChanges` - though that request is unreachable for this client (see the refuted table).
- The 16-pattern dangerous-command list is duplicated verbatim in `resources/pi/vocs-code-approvals.ts:50-69` with a "keep in sync" comment, so the two copies will drift.
- The correct primitives already exist (`isOutsideWorkspace`; `isSubPath` at `src/main/util/fs.ts:114`) but are not used uniformly.

The Medium/Low containment findings - `git:revert`/`git:diff` traversal (`git.ts:106-109`, `:72-77`), `fs:read` (`ipc.ts:336-340`), `app:openPath` (`ipc.ts:63-65`) and the symlink gap (`permissions.ts:41-45`) - are the same class again, differing only in which boundary was missed. The fix is therefore one shared containment predicate plus one argv-based command classifier invoked at every adapter write/exec boundary, not N independent per-site patches. Fixing the six High findings individually would leave the systemic inconsistency this report most wants to prevent in place.

## How to read this report

**Severity levels** (as assigned by the audit, never raised during consolidation):

- **High** - a reachable security, data-loss or process-crash defect, or a systematic gate failure. 6 findings.
- **Medium** - a correctness, lifecycle, error-handling or test-coverage defect with a concrete user-visible or resource consequence, but a narrower trigger or a partial mitigation. 17 findings.
- **Low** - a real but low-impact defect, leak, or gap. 36 findings.
- **Info** - dead code, unused surfaces, documentation drift, maintainability. 7 findings.

Severities here are the final folded values. Where the original auditor claimed a higher severity, the finding's heading says so (e.g. the `git:revert`/`git:diff` finding was claimed critical, and six Medium findings were claimed high); the complete set of original auditor claims is in the source corpus.

**Status:**

- **confirmed** - the cited code was read verbatim by at least one verifier, the mechanism was traced end to end, and at least one verifier reproduced the behaviour (statically or by executing the exact code). Critically, "confirmed" does not mean "reproduced live"; see the limits below.
- **partially-confirmed** - the code and mechanism are real but a verifier established that part of the original claim (a trigger sequence, an impact, a line range, or a mitigating guard) was wrong or overstated. The `Caveats and counter-evidence` field says which part.
- **unverified** - the 10 completeness-critic findings listed in the critic section. These got a second careful sweep but no adversarial refutation, and their confidence is marked medium or low accordingly. (The critics' 11th candidate, the stale README test count, was confirmed first-hand by the baseline `npm test` run and is counted in the 66, not in the unverified set.)

**Refuted findings are excluded from the verified counts** and listed separately at the end. Publishing them stops the same non-issues being re-raised.

**Limits of this audit.** It is static analysis plus one real `npm run typecheck` / `npm test` / `npm run build` run at the audited commit. There was **no live harness run**, **no packaged build** (`npm run dist:dir`/`dist:win` never executed), **no network**, and no execution of any opt-in suite (`tests/smoke.live.test.ts`, `tests/e2e.*.test.ts`). win32 and POSIX branches were not both exercised: most live checks were done on win32, so platform-specific claims (macOS paths, POSIX `which`, symlink resolution) are reasoned from code, not observed. Where a verifier executed something, this report says so; where it did not, the finding is static.

## Verification baseline

These commands were actually run against `8e6bf5e` in this worktree. `node_modules` did not exist; it was installed with `npm ci --include=dev` (a plain `npm install` skips devDependencies because `NODE_ENV=production` here). `package-lock.json` was not modified.

| Command | Result | Detail |
| --- | --- | --- |
| `npm run typecheck` | **FAILS** | `TS2300 Duplicate identifier 'invoke'` at `src/renderer/src/components/SettingsView.tsx(7,10)` and `(8,10)`. `typecheck:node` passes; `typecheck:web` fails. This is the gate AGENTS.md requires before any change is called done. |
| `npm test` | PASSES | 4 files, 44 tests, ~2.2 s: `terminal` 16, `unit` 19, `review-fixes` 6, `format` 3. |
| `npm run build` | PASSES | `out/main/index.js` 246.87 kB; `out/preload/index.cjs` 0.45 kB; renderer `index-pkLKLeeD.js` 1,532.60 kB as a single chunk. esbuild silently dedupes the duplicate import binding. |

What this means: **the repository does not pass its own documented gate at this commit.** AGENTS.md requires `npm run typecheck`, `npm test`, and `npm run build` before a change is called done, and README documents the same. At `8e6bf5e`, typecheck fails deterministically. The reason build and test stayed green while typecheck fails is that esbuild dedupes the duplicate named import into a single binding (`import { invoke, isMac } from "./a"`), so the bundler never sees the conflict - only `tsc` does, and only the web project. This is a gate-integrity failure, not a runtime failure.

### SettingsView.tsx declares `invoke` twice, so `typecheck:web` fails at the audited commit

- **Severity:** Medium | **Confidence:** high | **Status:** confirmed
- **Category:** gate integrity / crash | **Files:** `src/renderer/src/components/SettingsView.tsx:7-8`
- **What is wrong:**

```tsx
import { invoke } from '../api';
import { invoke, isMac, platform } from '../api';
```

Both `invoke`, `isMac` and `platform` are genuinely exported by `../api`; the second import was added to bring in `isMac`/`platform` and accidentally re-imported `invoke`. Verified first-hand: `node_modules/.bin/tsc --noEmit -p tsconfig.web.json` emits exactly the two TS2300 errors, exit code 2. `SettingsView` is rendered by `App.tsx:114`, so this is on the main path, not dead code.

- **Why it matters:** AGENTS.md's verification bar cannot be satisfied at this commit: `npm run typecheck` fails. A reviewer or CI job that requires the documented gate cannot pass. Runtime impact is nil because esbuild dedupes the binding, so `npm run build` and `npm test` stay green - which is precisely why the break could sit unnoticed.
- **Verification:** two verifiers. The first reproduced the exact `tsc` output and confirmed both names are used (`invoke` at lines 18/113/196/202/…, `isMac` at 117/176, `platform` at 137), but corrected the claim that "esbuild also rejects the duplicate binding" - esbuild dedupes, it does not reject. The second confirmed the lines verbatim at HEAD, established via `git blame` that line 7 is from the initial commit (`364dec2`) and line 8 was added by `dba90de` ("Replace the one-shot command runner with a real PTY terminal", merged in `5673b54`), and located a commit `f2b54ce` that fixes it. **Corrected after the report was written:** the second verifier's follow-on claim that this fix is on `origin/develop` and is an ancestor of HEAD is false, and has been removed. `f2b54ce` ("Add ten themes, four of them navy, one animated") does contain the line "Fixed a duplicate `invoke` import that broke typecheck:web" and its tree does have a single `invoke` import, but `git merge-base --is-ancestor f2b54ce` is false against both `develop` and HEAD - it sits on an unmerged theme branch. `develop` itself still carries the duplicate import, so the break is live on the integration branch, not merely on this worktree branch.
- **Suggested fix:** delete line 7 (`import { invoke } from '../api';`); line 8 already imports `invoke`, `isMac` and `platform`. Add no test; instead fix the process gap - a CI/pre-commit step that actually runs `npm run typecheck` (the present failure survived because build/test do not exercise the web program's duplicate-binding check).
- **Caveats and counter-evidence:** the automated fold adjusted the original auditor claim from *critical* to *medium* (esbuild dedupes, so there is zero runtime impact); both completeness critics rated it critical/high. The `baseline.settingsViewDuplicate.assessedSeverity` records the disagreement: auditor critical, fold medium, critics critical/high, and the first-hand reproduction is deterministic. There is no reason to downgrade it on the grounds that it is "already fixed": a fix exists in the tree (`f2b54ce`) but is **not merged into `develop` and not an ancestor of HEAD**, and `develop` still contains the duplicate import. An earlier draft of this report claimed otherwise; that claim was checked against `git merge-base` and removed. Scope note: this same finding is counted once in the 66; it is cross-referenced from the Medium section below.

## Summary

| Severity | Count |
| --- | --- |
| High | 6 |
| Medium | 17 |
| Low | 36 |
| Info | 7 |
| **Total verified** | **66** |

- Raw audit findings: **76**. After adversarial verification: **70 survived**; 5 were refuted and dropped; 1 could not be verified. Merging cross-slice duplicates leaves **66 distinct verified findings**.
- Adversarial verification runs performed: **92** (one or more per finding, with the stale README count the single exception, checked first-hand instead; plus a second reproduction-focused verifier on every critical/high).
- Refuted and dropped: **5**. Could not be verified: **1**.
- Additional findings contributed by the two completeness critics and **not** adversarially verified: **10**. (The critics' 11th candidate, the stale README test count, was confirmed first-hand by the baseline `npm test` run and is counted in the 66.)
- Auditors run: **10** over **64 files** / **13,730 lines**.

## High severity

### Native adapter outside-workspace prefix check

- **Severity:** High | **Confidence:** high | **Status:** confirmed
- **Category:** security | **Files:** `src/main/harness/native/index.ts:267`, `src/main/harness/native/tools.ts:141`, `src/main/harness/permissions.ts:41`
- **What is wrong:** In native permission modes `accept-edits`/`auto`, `gateAction` returns `'allow'` for `write_file`/`edit_file`, and the only thing that forces an approval for an out-of-workspace path is the `outsideCwd` boolean. It is computed with a raw `String.startsWith`, which is false for any path whose *text* begins with the cwd string:

```ts
const outsideCwd = def.isEdit && typeof args.path === 'string' && !resolveInCwd(cwd, args.path as string).startsWith(path.resolve(cwd));
let verdict = gateAction(mode, { mutating: true, isEdit: def.isEdit, command, sessionAllowed: this.sessionAllowed.has(call.name) });
if (outsideCwd && mode !== 'full-auto' && verdict === 'allow') verdict = 'ask';
```

`resolveInCwd` itself is a pure resolver that returns absolute inputs **un-normalized**:

```ts
export function resolveInCwd(cwd: string, p: string | undefined): string {
  if (!p) return cwd;
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
```

The correct helper already exists and is used by the sibling adapters but not here: `isOutsideWorkspace` at `permissions.ts:41`; the claude adapter calls it at `claude.ts:192` and ACP at `acp.ts:247`.

- **Why it matters:** invariant 4 in AGENTS.md - "any write outside the workspace always prompts below Full access, even after 'Allow for session'" - is bypassed, and a prompt-injected or malicious model can write outside the project with no card. Exact trigger:
  1. User is in `accept-edits` (or `auto`), so `ctx.permissionMode()` returns that (native's modes are `ask`/`accept-edits`/`plan`/`auto`/`full-auto`).
  2. The model emits `write_file`/`edit_file` with an absolute `args.path` whose text begins with the workspace root but resolves outside - e.g. `<cwd>\..\..\secret.txt` or `<cwd>-backup\f.ts`.
  3. `resolveInCwd` returns the absolute path verbatim; `startsWith(path.resolve(cwd))` is true, so `outsideCwd` is false and the write runs unprompted.
- **Verification:** four independent verifiers, all confirmed, all high. They read the quoted regions verbatim, traced the full call path from `runTurn` -> `executeTool` -> `gateAction`/`runBash`, established that the naive check is the *only* outside guard for structured edit tools (`writeFileTool`/`editFileTool` call `resolveInCwd` then `fs.writeFile` with no workspace check), and evaluated the exact string arithmetic on win32.
- **Suggested fix:** one line - replace the prefix test with the existing helper: `const outsideCwd = def.isEdit && isOutsideWorkspace(cwd, typeof args.path === 'string' ? (args.path as string) : undefined, path);` and import `isOutsideWorkspace`. Add a native-adapter test asserting an out-of-workspace write asks even in `accept-edits`/`auto`.
- **Caveats and counter-evidence:** `resolveInCwd` *normalizes relative* paths, so the obvious `write_file({ path: '../secret' })` attack is caught (`outsideCwd=true`); the bypass needs an absolute path that shares the workspace string prefix. Verifier corrections: (a) the cited `permissions.ts:33-35` is a loose span - the `full-auto` return is at line 29 (one verifier says 31) and `outsideWorkspace` at 33; (b) the helper is `isOutsideWorkspace` at `permissions.ts:41-46`; (c) one verifier says the escape is *not* limited to prefix-matching siblings, because absolute inputs are returned verbatim, so an absolute path containing `..` after the workspace prefix also passes. Mitigation: the shipped default mode is `ask` (`src/main/settings.ts:175`), so a fresh session still prompts; the exploit needs `auto`/`accept-edits` or a prior session grant. In `auto` mode the incremental capability is near zero because `bash` is already auto-allowed for non-dangerous commands.

### ACP writeTextFile writes anywhere on disk with no prompt in auto/accept-edits, bypassing the outside-workspace gate

- **Severity:** High | **Confidence:** high | **Status:** confirmed
- **Category:** security | **Files:** `src/main/harness/acp.ts:121`, `src/main/harness/acp.ts:198`, `src/main/harness/permissions.ts:33`
- **What is wrong:** The ACP adapter advertises `clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }` (acp.ts:121) and implements `writeTextFile` with only plan/ask gating:

```ts
writeTextFile: async (params: acp.WriteTextFileRequest) => {
  const p = params as { path: string; content: string };
  const abs = path.isAbsolute(p.path) ? p.path : path.join(cwd(), p.path);
  const mode = this.ctx.permissionMode();
  if (mode === 'plan') throw new Error('Plan mode: writes are disabled');
  if (mode === 'ask') { /* requestApproval ... */ }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, p.content, 'utf8');
```

It never computes `isOutsideWorkspace`, unlike the tool-permission path at `acp.ts:247` (`const outsideWorkspace = (tc.locations ?? []).some((l) => isOutsideWorkspace(cwd, l.path, path));`) or `gateAction` (`permissions.ts:33 if (action.outsideWorkspace) return 'ask';`).

- **Why it matters:** Below Full access, a write outside the project directory (e.g. `~/.ssh/authorized_keys`, or a file in another repository) applies silently in `auto`/`accept-edits`, breaking the AGENTS.md:52 / README.md:156 promise. Because `writeTextFile: true` is advertised, a conforming ACP agent is entitled to route an edit through this capability instead of a permission-gated tool call.
- **Verification:** two independent verifiers, both confirmed, both high. They read the quoted regions verbatim, confirmed the capability advertisement against the ACP schema (`FileSystemCapabilities`), traced `AcpAdapter.start()` -> `ClientSideConnection` -> `fs/write_text_file` -> `writeTextFile`, and verified the call path is deterministic from the code (no live ACP agent is installed, so execution was static).
- **Suggested fix:** route the write through `gateAction`: compute `outsideWorkspace = isOutsideWorkspace(cwd(), abs, path)` and require approval whenever `mode !== 'full-auto'` and the flag is set, instead of the ad-hoc plan/ask checks.
- **Caveats and counter-evidence:** the ACP agent is spawned unsandboxed (`spawnTool(command, preset.args, { cwd: meta.cwd, env })`, no sandbox flag), so the agent process can already write `~/.ssh/authorized_keys` with its own tools without touching this client handler; the handler is a cooperative convenience, not the privilege boundary. Well-behaved agents that call `session/request_permission` for their own tools never hit the hole. Verifier corrections: the handler body runs through `acp.ts:225` (the `fs.writeFile` is at 223), not 220 as cited; and "applies silently" is accurate only for `auto`/`accept-edits` - in `ask` the handler *does* prompt, and in `full-auto` it writes silently by design. Reproduction requires an actual ACP agent to choose the `fs/write_text_file` capability; no ACP agent is installed (`presets` resolve via `npx`).

### bash live output is streamed and accumulated without any cap, so one chatty command can exhaust main- and renderer-process memory

- **Severity:** High | **Confidence:** high | **Status:** confirmed
- **Category:** resource-leak (more precisely: unbounded transient peak memory) | **Files:** `src/main/harness/native/tools.ts:207`, `src/main/harness/native/index.ts:311`, `src/renderer/src/store.ts:210`
- **What is wrong:** `MAX_OUTPUT` (30,000, `tools.ts:139`) only bounds the string returned to the model. The callback still appends every stdout/stderr chunk to `item.output` in the main process and emits each chunk over IPC, where the renderer appends it too:

```ts
const push = (d: Buffer) => {
  const s = d.toString();
  if (out.length < MAX_OUTPUT) out += s;   // only the internal copy is capped
  onOutput?.(s);                            // every chunk is still forwarded, unbounded
};
```

```ts
await runBash(cwd, String(args.command ?? ''), Number(args.timeout_ms ?? 120_000), signal, (chunk) => {
  item.output = (item.output ?? '') + chunk;
  this.ctx.emit({ type: 'item.delta', id: item.id, outputDelta: chunk });
})
```

```ts
} else if (item.kind === 'tool' && ev.outputDelta) item.output = (item.output ?? '') + ev.outputDelta;
```

- **Why it matters:** a model-chosen `yes`, `cat <large-file>`, or a recursive build grows unbounded (tens of GB over the 120 s default / 600 s max timeout) in both processes, likely OOM-killing the app. The final `finish()` overwrites `item.output` with the truncated result, so the memory is wasted, not observable to the user.
- **Verification:** two independent verifiers, both confirmed, both high. They read the quotes verbatim, confirmed none of the potential guards exists (no `StringDecoder`, no `setEncoding`, no cap on the callback), measured `MAX_OUTPUT = 30_000` and the timeout clamp `Math.min(Math.max(timeoutMs, 1000), 600_000)`, and traced `executeTool` -> `emit item.upsert` -> `session-manager.emit` -> `active.liveItems.set` -> renderer `store.ts`.
- **Suggested fix:** cap the live channel as well: stop invoking `onOutput` (or stop appending) once a streamed-length counter exceeds `MAX_OUTPUT`, and emit a single `[output truncated]` marker.
- **Caveats and counter-evidence:** verifier corrections: (a) category "resource-leak" is imprecise - the strings are not leaked; `finish` replaces `item.output` with the truncated result, so this is unbounded *transient peak* memory; (b) a second verifier says the finding **understates** scope: there are actually three independent unbounded copies in this path - the local `item` (`native/index.ts:312`), `session-manager` `liveItems` (line 452), and the renderer (`store.ts:210`) - plus a fourth accumulator it attributes to `codex-app-server` (its citation is truncated in the source data, so treat that fourth one as unconfirmed here). Mitigation: `bash` is `mutating: true`, so in the default `ask` mode every command needs approval before it can run; unattended triggering needs `auto`/`full-auto` or a prior "allow for session". Steady-state memory does not leak.

### Dangerous-command regex is defeated by split/whole-word rm flags, silently auto-running destructive deletes in auto mode and after a session grant

- **Severity:** High (auditor claimed **critical**) | **Confidence:** high | **Status:** confirmed
- **Category:** security | **Files:** `src/main/harness/types.ts:63`, `src/main/harness/permissions.ts:32`
- **What is wrong:**

```ts
/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
/\brm\s+-rf?\s+[\/~]/i,
```

```ts
if (action.command && isDangerousCommand(action.command)) return 'ask';
if (action.outsideWorkspace) return 'ask';
if (action.sessionAllowed) return 'allow';
if (mode === 'auto') return 'allow';
```

Pattern 1 requires `r` and `f` inside one flag token; pattern 2 requires the flag token immediately followed by `/` or `~`. Evaluated against the real 16-pattern list: `rm -r -f /home` MISS, `rm -f -r /home` MISS, `rm --recursive --force /` MISS, `dd of=/dev/sda if=/dev/zero` MISS, `chmod 777 -R /` MISS, `git clean -d -f` MISS. Positive controls (`rm -rf /`, `rm -rf ~`, `rm -rf /home`, `dd if=/dev/zero of=/dev/sda`, `git clean -fdx`, `sudo rm -r -f /home`) all hit.

- **Why it matters:** a model-emitted `rm -r -f /` or `rm --recursive --force $HOME` runs unprompted in `auto` mode and after one "Allow for session" on bash/write tools, deleting arbitrary files. Invariant 4 ("dangerous commands always prompt below Full access, even after allow-for-session") is broken. The same fragility defeats `dd of=`, `chmod 777 -R`, and `git clean -d -f`.
- **Verification:** two independent verifiers, both confirmed, both high. They copied the exact 16 patterns into node and evaluated the claimed inputs: every claimed MISS reproduced, and the canonical controls returned true. They traced the only call path (`gateAction` is called for every mutating action; `types.ts:81` `isDangerousCommand` is the sole detector) and confirmed the dangerous check precedes the `sessionAllowed` and `auto` short-circuits.
- **Suggested fix:** do not pattern-match raw shell text. Either tokenize the command (split on whitespace/`;|&&` respecting quotes) and classify argv, or at minimum normalize whitespace and collapse separated short flags before matching, and add whole-word variants (`rm\s+(--recursive\s+--force|--force\s+--recursive)`, `dd\s+.*\bif=`). Extend `tests/review-fixes.test.ts` with the bypass strings above.
- **Caveats and counter-evidence:** the list is explicitly a best-effort blocklist, and `auto` mode is documented as "confirm only dangerous shell commands" - the user has already accepted unprompted shell execution, and many destructive commands bypass it with no flag-splitting trick at all. The canonical and most likely destructive spellings are caught. Verifier corrections: (1) `acp.ts:245` does **not** call `gateAction` - it calls `isDangerousCommand` directly and re-implements the gating block at `acp.ts:262-266`; the conclusion is unchanged; (2) the identical pattern list is duplicated in `resources/pi/vocs-code-approvals.ts:50-69` (loaded via `pi.ts:89`), so any fix must touch both copies; (3) one verifier notes `codex-exec` is not a "regex miss" path (the note is truncated in the source data).

### Force-push gate bypassed by +refspec and by any git global option before `push`

- **Severity:** High | **Confidence:** high | **Status:** confirmed
- **Category:** security | **Files:** `src/main/harness/types.ts:65`
- **What is wrong:**

```ts
/\bgit\s+push\b.*(--force|-f)\b/i,
```

Evaluated: `git push origin +main` MISS; `git -c user.name=x push --force` MISS; `git -C /repo push -f` MISS. The regex anchors on `git` immediately followed by `push`, so any `-c`/`-C`/`--git-dir` option escapes it, and it never considers the `+` refspec force syntax. The identical regex is duplicated at `resources/pi/vocs-code-approvals.ts:53` with a "Keep in sync" comment.

- **Why it matters:** in `auto` mode or after a session grant, `git push origin +main` or `git -c ... push --force` force-rewrites a remote branch with no prompt. Destructive and irreversible on shared remotes.
- **Verification:** two independent verifiers, both confirmed, both high. They ran the exact regex against the claimed inputs (all MISS), confirmed `isDangerousCommand` (`types.ts:81-83`) is the only detector, and confirmed `gateAction` evaluates the dangerous check before the `sessionAllowed` (line 35) and `mode === 'auto'` (line 37) short-circuits.
- **Suggested fix:** strip leading `git` global options and then flag any `push` that carries `--force`, `-f`, or a `+<refspec>` after the remote. At minimum add `/(^|\s)[+]\S+/` for push refspecs and a `git\s+(-\S+\s+)*push` allowance.
- **Caveats and counter-evidence:** dangerous-command detection is an inherently incomplete blocklist, and a user in Auto mode has explicitly opted into fewer prompts, so "no prompt" is partly expected; a plain fast-forward `git push` is likewise silent. What rescues the finding is `README.md:156`, which makes the prompt an explicit invariant, not an aspiration. Verifier correction: the claim "any git global option before `push` escapes it" is slightly overstated - `git --git-dir=/repo/.git push --force` actually tests TRUE, but only by accident (the `\bgit` matches the `.git ` fragment at the end of the path immediately before `push`).

### Windows destructive commands bypass the list (del with a non-/s first flag, rd/rmdir, PowerShell aliases and -EncodedCommand, format.com)

- **Severity:** High | **Confidence:** high | **Status:** confirmed
- **Category:** security | **Files:** `src/main/harness/types.ts:71-73`
- **What is wrong:**

```ts
/\bformat\s+[a-z]:/i,
/\bdel\s+\/[sq]/i,
/\bRemove-Item\b.*-Recurse/i,
```

Evaluated: `del /f /s /q C:\` MISS (pattern requires `/s` or `/q` to be the FIRST flag); `rd /s /q C:\` MISS; `rmdir /s /q C:\` MISS; `ri -r -fo C:\` MISS (PowerShell alias of `Remove-Item`); `format.com c:` MISS; `powershell -EncodedCommand <base64>` MISS. `del /s /q` happens to match; `del /q` and `del /s` also match.

- **Why it matters:** on Windows - the platform this app primarily targets - a generated `del /f /s /q`, `rd /s /q`, `ri -r -fo` or an encoded PowerShell payload passes the dangerous check and is auto-approved in `auto`/session modes.
- **Verification:** two independent verifiers, both confirmed, both high. They executed the real `DANGEROUS_COMMAND_PATTERNS` array in node and reproduced every claimed miss, then traced the only consumer (`permissions.ts:32` -> `isDangerousCommand` -> `gateAction` for every mutating action).
- **Suggested fix:** match flags order-independently (`del\s+(\/[a-z]+\s+)*\/[sq]`, `(rd|rmdir)\s+(\/[a-z]+\s+)*\/s`, `(rm|ri|Remove-Item)\b` with any recursive flag), handle `format(\.com)?`, and treat `-EncodedCommand`/`-e`/`-enc` as dangerous.
- **Caveats and counter-evidence:** the harness's own shell selection limits the practical exploit: `detectShell()` (`native/tools.ts:159-168`) prefers Git Bash on Windows and otherwise PowerShell, where bare `del /f /s /q` and `rd /s /q` do not behave as cmd.exe builtins. The guard is explicitly a best-effort denylist; `README.md:156` enumerates only "rm -rf, force-push, sudo, piping curl into a shell", so a `rd`/`rmdir` miss can be framed as coverage not claimed - except that AGENTS.md's invariant is worded as a general promise. Verifier corrections: "Only `del /s /q` happens to match" is slightly overstated (`del /q`, `del /s`, and `Remove-Item -Force -Recurse` match); and the stated reason for the `format.com` miss is wrong - it is the dot, not the `\b`, that breaks the match.

## Medium severity

### Permission and path containment

#### git:revert / git:diff path traversal from renderer

- **Severity:** Medium (auditor claimed **critical**) | **Confidence:** high | **Status:** confirmed (verifiers split: two partially-confirmed, one confirmed)
- **Category:** security | **Files:** `src/main/git.ts:106-109`, `src/main/git.ts:72-77`, `src/main/ipc.ts:287`
- **What is wrong:** `ipc.ts:287` is `handle('git:revert', ({ sessionId, path: p }) => gitRevertFile(cwdOf(sessionId), p));`. `gitRevertFile` runs `git ls-files --error-unmatch -- <file>` and, on nonzero exit, `fs.rm(path.join(root, file), { force: true })`; `gitDiff` does `path.join(root, file)` then `fs.readFile(abs, 'utf8')`. Neither validates containment, and neither `ipc.ts` nor `git.ts` imports `isOutsideWorkspace`. `path.join('/repo', '../../../../etc/passwd')` normalizes to `/etc/passwd`, and `git ls-files --error-unmatch` exits 128 ("is outside repository") for an outside path, taking the `fs.rm`/`fs.readFile` branch. Verified against the real repo: the `--error-unmatch` call does exit nonzero for an outside path.
- **Why it matters:** a renderer IPC payload (or any code that reaches `window.harness`) can delete any writable file via `fs.rm(..., {force:true})` and read any UTF-8 file via the synthesized diff. The UI itself only passes in-repo relative paths, so this is a pure boundary-validation hole.
- **Verification:** three verifiers. One stayed *confirmed/high*: it verified the generic `handle()` wrapper (`ipc.ts:31`) has no sender check, the preload exposes `invoke` with no allowlist, and `isOutsideWorkspace` is imported only by `acp.ts`/`claude.ts`. Two were *partially-confirmed* (low and medium) because no normal UI path and no demonstrated XSS reaches it.
- **Suggested fix:** in the git handlers (or at the top of `gitDiff`/`gitRevertFile`), resolve root and reject when `path.relative(root, path.resolve(root, file))` starts with `..` or is absolute, reusing `isOutsideWorkspace`; return `{ok:false,error:'Path outside workspace'}`.
- **Caveats and counter-evidence:** the renderer is sandboxed, context-isolated, loads only local content, and the only named injection route (agent markdown) is DOMPurify-sanitized under `script-src 'self'`. Verifier corrections: the renderer citation should be `src/renderer/src/components/RightPanel.tsx:114` (not `src/renderer/src/RightPanel.tsx`); the quoted revert block is `git.ts:106-109` (cited 104-109; 104-105 are `gitRoot`); `fs:list` at `ipc.ts:293-294` *does* enforce a root check while `fs:read` does not - so the IPC layer is not uniformly unchecked. The deepest caveat: the same renderer already has an entirely ungated, more powerful path - `terminal:create`/`terminal:input` reach the PTY with no permission gate at all - so a compromised renderer does not need this hole.

#### Forwarding SDK permission suggestions to the CLI lets a later dangerous command skip canUseTool, defeating the app's dangerous-command gate

- **Severity:** Medium (auditor claimed **high**; verifiers split: one confirmed/high, one partially-confirmed/medium) | **Confidence:** medium-high | **Status:** partially-confirmed
- **Category:** security | **Files:** `src/main/harness/claude.ts:210-214`, `src/main/harness/claude.ts:193`, `src/main/harness/permissions.ts:32-33`
- **What is wrong:**

```ts
if (decision.optionId === 'allow_session') {
  this.sessionAllowed.add(toolName);
  // Keep the grant in the CLI's session memory only; never persist it to settings files.
  const sessionOnly = suggestions?.map((s) => ({ ...s, destination: 'session' as const }));
  return { behavior: 'allow', updatedInput: input, updatedPermissions: sessionOnly };
}
```

`gateAction` (`claude.ts:193`) is the only place the dangerous-command and outside-workspace rules are enforced. By also returning the SDK's `suggestions` as `updatedPermissions` with `destination: 'session'`, the adapter hands the grant to the CLI, which applies it as a session permission rule and auto-approves matching invocations without calling `canUseTool` again - so `isDangerousCommand`/`outsideWorkspace` never run.
- **Why it matters:** below Full access, a grant created for one benign invocation (e.g. `git push`, `npm ...`) can auto-allow a later `git push --force`, `rm -rf`, or a piped install. The host's own `sessionAllowed` set would still re-prompt for dangerous commands; the CLI-side rule bypasses that. The first verifier traced the shipped CLI's embedded JS and confirmed the mechanism for at least one dangerous command.
- **Verification:** two verifiers. One confirmed/high and traced the CLI rule resolution. One partially-confirmed/medium: SDK types say returning `updatedPermissions` is the intended "always allow" contract, and the CLI has `suppressAlwaysAllowRule` machinery.
- **Suggested fix:** do not return `updatedPermissions`; rely solely on the in-process `sessionAllowed` set so every subsequent call still passes through `canUseTool` and `gateAction`.
- **Caveats and counter-evidence:** this is the SDK's documented contract (`sdk.d.ts` tells hosts to return the suggestion set as `updatedPermissions` for "always allow"), and the CLI's own permission dialog applies exactly these suggestions. The bypass therefore depends on CLI rules being broader than intended. Verifier corrections: the `rm tmp/x` example is wrong - `tmp/x` fails the CLI's two-token-prefix regex, so it produces an exact rule that cannot match `rm -rf ...`; and the `sdk.d.ts:217-221` citation is a range miss (the quoted sentence is at 213-214, the return guidance at 217-218). The `gateAction` line quoted is `claude.ts:193` alone, inside the private `canUseTool` field.

#### app:openTerminal on Windows interpolates a renderer-supplied cwd into a cmd.exe command line with windowsVerbatimArguments, allowing command injection

- **Severity:** Medium (auditor claimed **high**) | **Confidence:** high | **Status:** confirmed (one verifier partially-confirmed)
- **Category:** security | **Files:** `src/main/ipc.ts:87`
- **What is wrong:** when `wt` is not found, the handler runs `spawn(process.env.ComSpec || 'cmd.exe', ['/c', `start "" /D "${cwd}" cmd.exe`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: false })`. The contract accepts any `cwd` string and the handler validates nothing. `windowsVerbatimArguments: true` makes libuv pass the argument verbatim, so a `cwd` containing `"` closes the `/D "..."` quote and a following `&` becomes a command separator. The safe `quoteWin` helper exists at `src/main/harness/spawn.ts:6` but is not used here.
- **Why it matters:** `invoke('app:openTerminal', { cwd: 'C:\\x" & calc & rem "' })` runs attacker-chosen commands with the user's privileges whenever `wt` is not installed.
- **Verification:** one verifier reproduced the cmd.exe parse locally on win32; the other confirmed the code and mechanism statically (it did not claim execution).
- **Suggested fix:** route the fallback through a non-shell spawn with `quoteWin`-style quoting of `cwd`, or pass the directory as a spawn `cwd` option after validating it.
- **Caveats and counter-evidence:** the vulnerable branch is dead whenever `which('wt')` resolves (on the dev machine `wt.exe` was present, so `which('wt')` returned truthy), and Windows forbids `"` in directory names, so the "open a folder whose name contains a quote" trigger cannot exist. Getting a quote-bearing `cwd` in requires arbitrary renderer JS already. Verifier corrections: the handler is `ipc.ts:80`, the win32 branch starts at `:82`, and `quoteWin` is `spawn.ts:6`, not `:8`.

### Process and resource lifecycle

#### Codex app-server child is never killed when start() fails after spawn - one orphaned process per retry

- **Severity:** Medium (auditor claimed **high**) | **Confidence:** high | **Status:** confirmed
- **Category:** resource-leak | **Files:** `src/main/harness/codex-app-server.ts:125`, `src/main/session-manager.ts:244-259`
- **What is wrong:** `start()` does `const child = spawnTool(bin.path, ['app-server'], { cwd: meta.cwd, env });` and then awaits `initialize` (30 s timeout), `thread/resume`, and `thread/start` with no outer try/finally. On failure, `ensureActive`'s catch does `this.active.delete(id)` and rethrows, and `stop()`'s `if (!active) return;` means the entry is already gone. The only teardown is `dispose()` (`:613-624`), reached via `stop()` and one fatal-error path.
- **Why it matters:** if `initialize` times out or a thread request rejects (bad workspace, bad provider config, hung server), the `codex app-server` keeps running with its stdin pipe open and no JS reference. Each retry creates a fresh adapter and spawns another process, accumulating long-lived Codex processes.
- **Verification:** two verifiers, both confirmed, both adjusted to medium. They verified every cited line, confirmed `start()` has no try/finally, and traced `ensureActive` -> `send` -> retry.
- **Suggested fix:** wrap the post-spawn part of `start()` in try/catch and close the transport before rethrowing (`rpc?.close()`); or have `session-manager` call `adapter.dispose()` in its start-failure catch before `this.active.delete(id)`.
- **Caveats and counter-evidence:** the leak is self-limiting - when the Electron main process exits, the parent side of the stdin pipe closes and the app-server typically exits on EOF, so orphans do not outlive the app. Three of six adapters share the pattern, which could suggest it is deliberate. Verifier corrections: `stop()`'s early return is at `:305` (cited 306-307); `dispose()` spans `:613-624`; and "reached only via stop()" is inaccurate - it is also called from the fatal-error handler at `session-manager.ts:496`, which does not cover start failures.

#### No 'error' listener on codex app-server stdin - an EPIPE after the child dies is an uncaught exception in the main process

- **Severity:** Medium (auditor claimed **high**) | **Confidence:** high | **Status:** confirmed (one verifier partially-confirmed)
- **Category:** crash | **Files:** `src/main/harness/jsonrpc.ts:60-62`
- **What is wrong:**

```ts
if (this.closed || !this.child.stdin?.writable) throw new Error('RPC transport is closed');
this.child.stdin.write(JSON.stringify(payload) + '\n');
```

The constructor attaches `child.on('close')` and `child.on('error')` to the ChildProcess only; those do not receive errors emitted by the `child.stdin` Socket (a separate EventEmitter). Repo-wide grep confirms no `child.stdin.on('error')` anywhere, and no `process.on('uncaughtException'|'unhandledRejection')` under `src/main`.
- **Why it matters:** if the app-server exits or is killed while a `request()` write is in flight, the pipe can return EPIPE asynchronously and `child.stdin` emits `'error'`, which Node turns into an uncaught exception in the Electron main process, taking down every open session. The `writable` guard only closes the deterministic window, not the race. One verifier established the exact trigger sequence and observed the emitted error.
- **Verification:** two verifiers, one confirmed and one partially-confirmed, both adjusted to medium.
- **Suggested fix:** in the `JsonRpcStdioClient` constructor add `child.stdin?.on('error', (e) => { this.closed = true; for (const [, p] of this.pending) p.d.reject(e); this.pending.clear(); });`.
- **Caveats and counter-evidence:** the reproducible crash requires the child to stop consuming stdin long enough for >64 KB to remain buffered, or a write to land in the tiny post-exit/pre-`close` gap; on Windows the `writable` flag is already false by the `'exit'` event, so writes at that point were observed to survive in testing. Verifier corrections: the constructor handlers are at `jsonrpc.ts:47-56`, not 51-57; the guard is not purely cosmetic - it converts the deterministic post-exit write into a rejected promise.

#### start() rejects after spawning on handshake timeout, orphaning the Pi/ACP child process because the failed session is deleted without dispose()

- **Severity:** Medium (auditor claimed **high**; one verifier adjusted to high) | **Confidence:** high | **Status:** confirmed
- **Category:** resource-leak | **Files:** `src/main/harness/acp.ts:103`, `src/main/harness/pi.ts:114`, `src/main/session-manager.ts:248-260`
- **What is wrong:** ACP spawns (`acp.ts:103`) then awaits a timed handshake (`initialize` 120 s; `newSession` 180 s) with no try/catch anywhere in `start()`. Pi spawns (`pi.ts:114`) then awaits `get_state` (60 s), likewise unguarded. On rejection the adapter throws with the child still running. The sole caller, `ensureActive`, catches, does `active.starting = null; this.active.delete(id); ...; throw e;`, and never disposes the adapter; after `delete(id)` nothing references it, so the child is never killed. Contrast the fatal-error path at `session-manager.ts:493-496`, which *does* call `active.adapter.dispose()`.
- **Why it matters:** a harness that spawns but hangs during its handshake leaks one live agent process per failed start. `send()` re-enters `ensureActive` on every retry, accumulating orphaned processes that still hold injected provider API keys.
- **Verification:** two verifiers, both confirmed; one raised to high, one held medium. The most natural failure (binary does not exist) does **not** orphan anything - `spawn` emits `error`, the adapter emits a fatal error, and session-manager disposes - so the leak needs a successfully spawned then hung handshake.
- **Suggested fix:** make `start()` self-cleaning in both adapters (wrap the post-spawn handshake in try/catch and `await this.dispose()` before rethrowing), or dispose in `ensureActive`'s catch.
- **Caveats and counter-evidence:** requires a hung or unauthenticated agent rather than a happy path; a fast-exiting CLI is reaped by nature. Verifier corrections: the ACP `initialize` block is `acp.ts:118-126` (cited 116-125); `this.active.delete(id)` removes the in-memory `ActiveSession`, not the persisted `meta` (which is marked `error`).

#### runCapture's timeout only fires child.kill() and never settles the promise, so a probe can hang forever

- **Severity:** Medium | **Confidence:** high | **Status:** confirmed
- **Category:** error-handling | **Files:** `src/main/runtime.ts:77-93`
- **What is wrong:**

```ts
const t = setTimeout(() => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}, opts.timeoutMs ?? 15_000);
...
child.on('error', (e) => { clearTimeout(t); resolve({ code: null, stdout, stderr: stderr + String(e) }); });
child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
```

Resolution depends entirely on the child emitting `error`/`close`. On Windows `spawnTool` wraps `.cmd` shims in `cmd.exe` (`spawn.ts:16-27`) and killing that wrapper does not close stdout/stderr if a grandchild inherited the pipes, so Node's `close` may never fire. `withTimeout` exists in `src/main/util/async.ts` but is not used here.
- **Why it matters:** a CLI that ignores SIGTERM or wraps a child makes `runCapture` never resolve: the About/doctor panel and harness readiness badges spin forever, and `install()` (600 s timeout) leaves the Settings button stuck with no result.
- **Verification:** one verifier confirmed/high; it verified the quote, the caller chain (`availability` -> `app:doctor`, `harness:availability`, `harness:install`, `refreshAvailability`), and the absence of any `Promise.race` wrapper.
- **Suggested fix:** in the timeout callback, settle the promise once (with a `timed out` marker) and call `killTree(child)`; or wrap every `runCapture` call in `withTimeout`.
- **Caveats and counter-evidence:** normal calls do settle - a direct child killed by `child.kill()` closes its stdio and fires `close`, and `--version` probes almost always exit on their own; the hang needs an abnormal condition. Verifier corrections: the quoted block is `runtime.ts:77-93` (94-95 are `child.stdin.end()`); `harness:availability` starts at `ipc.ts:219` with its `Promise.all` at 222-233; `spawnTool` is `spawn.ts:16-27`.

#### Setting or resuming a goal starts the harness with `void this.send(...)` and no .catch, so a failed harness start is an unhandled rejection

- **Severity:** Medium | **Confidence:** high | **Status:** confirmed
- **Category:** error-handling | **Files:** `src/main/session-manager.ts:574`, `src/main/session-manager.ts:583`
- **What is wrong:** `if (meta.status === 'idle') void this.send(id, { text: this.goalKickoffPrompt(meta.goal) });` and the resume branch at `:583` have no `.catch`, while all three sibling fire-and-forget sends do (`:142`, `:144` emit an error item; `:554` logs a warning). `send()` -> `ensureActive()`, whose catch ends with `throw e;`, so `send()` rejects.
- **Why it matters:** reachable from the Goal panel whenever the harness cannot start while the session is idle (pi not installed, claude binary missing, ACP spawn failure). `void` swallows the rejection; the `goal()` promise still resolves and the IPC caller returns success, so the UI can show "Goal set" while the kickoff turn never ran, and the main process gets an unhandled rejection.
- **Verification:** one verifier confirmed/high; verified both lines, the sibling `.catch` handlers, and `ensureActive`'s rethrow.
- **Suggested fix:** use the `create()` pattern - `void this.send(...).catch((e) => this.emit(id, { type: 'error', message: errorMessage(e) }))` - in both branches.
- **Caveats and counter-evidence:** `ensureActive` already emits a user-visible `Failed to start harness: ...` error item and sets `status='error'`, so the UI does not silently show success; the missing `.catch` changes only whether Node reports an unhandled rejection. Verifier corrections: `throw e;` is at `session-manager.ts:260`, not 262; the cited 237-262 is the `active.starting = adapter.start()...` block, not the whole method.

### Write, stream and adapter correctness

#### edit_file accepts an empty old_string and, with replace_all, interleaves new_string between every character of the file

- **Severity:** Medium | **Confidence:** high | **Status:** confirmed
- **Category:** correctness | **Files:** `src/main/harness/native/tools.ts:287-290`
- **What is wrong:**

```ts
const count = before.split(args.old_string).length - 1;
if (count === 0) return { error: 'old_string was not found in the file. ...' };
if (count > 1 && !args.replace_all) return { error: `old_string matches ${count} times; ...` };
const after = args.replace_all ? before.split(args.old_string).join(args.new_string) : before.replace(args.old_string, args.new_string);
```

No layer rejects an empty `old_string`: the schema (`tools.ts:69-83`, `required: ['path','old_string','new_string']`) has no `minLength`; `drivers.ts parseArgs` returns raw parsed JSON; `executeTool` dispatches straight to `editFileTool`. For `'abc'`, `'abc'.split('')` is `['a','b','c']` (count 2) and `'abc'.split('').join('X')` is `'aXbXc'`.
- **Why it matters:** a model passing `{old_string: "", replace_all: true}` rewrites the whole file with `new_string` spliced between every character, destroying it, and the change is rendered as a normal diff and written.
- **Verification:** one verifier confirmed/high; it proved the JS semantics with node and traced every layer for a guard (none).
- **Suggested fix:** reject empty `old_string` in `previewEdit`/`editFileTool` (`if (!args.old_string) return { error: 'old_string must not be empty.' }`) and add `minLength: 1` to the schema.
- **Caveats and counter-evidence:** the default Ask path builds the diff for approval before the write, and for files of 3+ chars without `replace_all` the existing `count > 1` guard already rejects the empty case; so the destructive path requires the model to explicitly pass `replace_all: true`. Verifier correction: the corrupting path begins at **2** characters, not 3 (the finding's threshold was too high).

#### A provider stream that throws after emitting text leaves the assistant transcript item stuck streaming and drops that partial turn from history

- **Severity:** Medium | **Confidence:** high | **Status:** confirmed
- **Category:** correctness | **Files:** `src/main/harness/native/index.ts:140-171`, `src/renderer/src/store.ts`
- **What is wrong:** `onText` upserts the assistant item with `streaming: true` and emits `item.delta`, but the normalization that sets `streaming = false` (lines 169-171) is only reached when the provider step returns normally. Anthropic `stream.finalMessage()` and the OpenAI `for await` loop both throw on a mid-stream socket error after bytes have arrived; the catch (lines 216-219) sets the *turn* item to failed and never touches the in-flight assistant item. The renderer store's switch has no case that resets the flag.
- **Why it matters:** the user sees a permanently blinking "streaming" bubble, and the partial assistant text never enters `this.history`, so the next request's context omits text the user can see, letting the model contradict its own visible output.
- **Verification:** one verifier confirmed/high; it read both files end to end and traced the event path through session-manager and the renderer.
- **Suggested fix:** move the `assistant.streaming = false; emit upsert` finalization into the catch/finally for the in-flight assistant item; optionally push the partial assistant message into history on abort/failure.
- **Caveats and counter-evidence:** the original claim pointed at the wrong layer - there is no `turn` `SessionEvent` at all in the `SessionEvent` union; native emits the turn as `item.upsert` with `kind: 'turn'`, which the store already handles. The real mechanism is that the assistant item's `streaming` flag is never cleared. Verifier also confirmed `flushLive` explicitly `continue`s past any assistant item still marked streaming, so the session-manager layer does not rescue it.

#### Turn outcome is derived only from `subtype`, so API errors and interrupts are reported as completed and can restart a goal loop

- **Severity:** Medium | **Confidence:** high | **Status:** confirmed
- **Category:** correctness | **Files:** `src/main/harness/claude.ts:435-446`, `src/main/session-manager.ts:520-535`
- **What is wrong:**

```ts
const isError = msg.subtype !== 'success';
...
status: isError ? 'failed' : 'completed',
```

The SDK allows `subtype: 'success'` with `is_error: true` (error text in `result`), and defines `terminal_reason` (`'aborted_streaming' | 'aborted_tools'`). Neither `msg.is_error` nor `terminal_reason` is ever read by the adapter. So a turn that ends on an API error but has `subtype === 'success'` is recorded as `completed` with the error discarded; a user interrupt is likewise never marked `interrupted`.
- **Why it matters:** the renderer shows "Turn complete" and the user is not told the turn failed; `onTurnFinished` fires a "Turn finished" notification and, in a session with an active goal and `autoContinue`, immediately enqueues the next goal prompt. No claude turn is ever marked `interrupted`, so the abort path is misclassified (every other adapter maps it: `codex-app-server.ts:254`, `acp.ts:445`, `native/index.ts:212-214`, `codex-exec.ts:103`).
- **Verification:** one verifier confirmed/medium-high; it confirmed the quote verbatim and that the adapter never reads `is_error`/`terminal_reason` anywhere.
- **Suggested fix:** `const isError = msg.is_error || msg.subtype !== 'success';` and derive the status as `msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools' ? 'interrupted' : isError ? 'failed' : 'completed'`.
- **Caveats and counter-evidence:** the only evidence that API errors arrive as `subtype: 'success'` is the SDK type comment; if the installed CLI emits the dedicated error subtypes for actual API failures, claude.ts already marks them `failed` and the headline collision is narrower. Verifier corrections: `SDKResultSuccess` declares `is_error` at `sdk.d.ts:5023` (the finding cited 4962, which is inside `SDKResultError`); and the "every other adapter maps interrupts" claim needs the caveat that native maps terminal reasons in a slightly different spot.

#### LineSplitter corrupts UTF-8 split across chunks

- **Severity:** Medium | **Confidence:** high | **Status:** confirmed
- **Category:** correctness | **Files:** `src/main/util/async.ts:84`, `src/main/util/async.ts:86`, `src/main/harness/pi.ts`, `src/main/harness/jsonrpc.ts:43-46`
- **What is wrong:**

```ts
this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
...
while ((idx = this.buffer.indexOf('\n')) >= 0) {
```

The Buffer branch decodes each raw chunk independently, so a codepoint straddling the chunk boundary becomes U+FFFD and the continuation bytes are lost. `LineSplitter` is what `JsonRpcStdioClient` uses for stdout/stderr. The buffer also has no cap: a stdout line that never terminates accumulates without bound.
- **Why it matters:** agent text and tool output containing non-ASCII (emoji, CJK, accented text) is silently mangled whenever a >1-byte codepoint straddles a ~64 KB pipe chunk.
- **Verification:** two verifiers, both confirmed/high. One reproduced it with a live child process (a 65,536-byte chunk ending mid-codepoint produced U+FFFD), the other with a direct `Buffer.toString` split. Grep found no `StringDecoder`/`setEncoding` guard.
- **Suggested fix:** use a `StringDecoder('utf8')` for Buffer chunks, or concatenate Buffers and only `toString` on complete newline-terminated records; add a max-buffer guard.
- **Caveats and counter-evidence:** corruption requires a pipe read boundary inside a multi-byte sequence; small records (the common case) are almost always delivered whole. Verifier corrections: for a 4-byte codepoint split 2+2, node actually emits **3** U+FFFD chars, not 2; the pi stdout handler is at `pi.ts:117` (not 115-116); and "the existing test only pushes strings" is true only of the dedicated `LineSplitter` test - the same file's `JsonRpcStdioClient` test pushes a Buffer, though not one split inside a multibyte sequence.

#### ACP start() mutates shared settings preset args

- **Severity:** Medium | **Confidence:** high | **Status:** confirmed
- **Category:** race-condition | **Files:** `src/main/harness/acp.ts:72`, `src/main/harness/acp.ts:99`, `src/main/settings.ts:243-245`, `src/main/session-manager.ts:195`
- **What is wrong:** `resolvePreset()` returns the live settings object, not a copy (`const preset = s.acpAgents.find((a) => a.id === id) ?? s.acpAgents[0];`, acp.ts:72). `HarnessContext.settings()` returns the live store object. `start()` then reassigns in place: `preset.args = ['-y', '@deepseek-ai/dsh', ...preset.args];` (acp.ts:99). On any later `start()` for the same preset, `preset.command` is still `'dsh'`, so the npx fallback fires again and prepends a second `-y @deepseek-ai/dsh`.
- **Why it matters:** the second and every later ACP session using the default `dsh` preset without a global install launches as `npx -y @deepseek-ai/dsh -y @deepseek-ai/dsh --profile acp`, so the extra args are forwarded to dsh and the agent fails or misbehaves. The array grows across restarts once persisted.
- **Verification:** one verifier confirmed/medium; it read the cited code and traced every link for a copy (none).
- **Suggested fix:** build a local array instead of mutating settings: `const args = command === npx ? ['-y', '@deepseek-ai/dsh', ...preset.args] : preset.args;` and pass that to `spawnTool`.
- **Caveats and counter-evidence:** only reachable when `which('dsh')` fails AND `which('npx')` succeeds; a user with a global `dsh` or the separate `dsh-npx` preset never triggers it. Whether dsh rejects the duplicate is runtime-dependent and unverified. Verifier corrections: `resolvePreset`'s `find` is line 72 (cited 73-75); growth "across restarts" holds only after a `SettingsStore.update()` persists the mutated array.

### Renderer state correctness

#### Composer local state (draft, image attachments, history) is not scoped to the session

- **Severity:** Medium | **Confidence:** high | **Status:** confirmed
- **Category:** correctness | **Files:** `src/renderer/src/App.tsx:118-119`, `src/renderer/src/components/Composer.tsx:14-18`
- **What is wrong:** `App.tsx` renders `<Composer session={session} />` with no `key`, so React reconciles and preserves Composer's `useState` across a session switch. Composer keeps `text`, `images` and `history` locally and the only effect keyed on the session is a focus effect; `send()` submits to the currently rendered prop (`sessions:send` with `session.id`).
- **Why it matters:** type a prompt (or attach an image) in session A, switch to session B, press Enter out of habit, and the message is delivered to B's agent under B's permission mode, with A's attachment riding along. Multi-repo correctness hazard, not just cosmetics.
- **Verification:** one verifier confirmed/high; it traced `Sidebar`/`CommandPalette` -> `setActive` -> App re-render -> same Composer instance.
- **Suggested fix:** give the composer an identity per session (`<Composer key={session.id} ... />`) or move the draft into a per-session record and reset local state in a `useEffect` on `session.id`.
- **Caveats and counter-evidence:** the contamination is *visible* before Enter - A's text is still shown in B's textarea and A's thumbnail in B's attachment strip - so this is a misfire, not a silent misroute. Verifier correction: the finding says the focus effect is "the only effect keyed on the session"; the @-mention search effect at `Composer.tsx:80-87` also depends on `session.id`, though it only refetches results and does not reset the draft.

#### ChangesTab keeps the previous session's file selection and can finish an in-flight refresh after a session switch

- **Severity:** Medium | **Confidence:** high | **Status:** partially-confirmed
- **Category:** correctness | **Files:** `src/renderer/src/components/RightPanel.tsx:54`, `:59-74`
- **What is wrong:** `ChangesTab` (an inline function in `RightPanel.tsx`, not a separate file) holds `selected` in session-independent state. `refresh` captures `session` in a closure and writes `setSummary`/`setDiff` with no check that the session is still active, and the effect `[session.id, version, selected]` fires on the id change. `RightPanel` is rendered without a `key` (`App.tsx:140`), so the same instance serves both sessions.
- **Why it matters:** the Changes panel can show session A's diff while B is selected, and a click on Revert then runs `git:revert` in session B for a path taken from A's diff. The selection carry-over alone is deterministic on every switch, no race needed. The single verifier was partially-confirmed and adjusted the finding to medium (the stale-diff outcome is bounded, see caveats).
- **Verification:** one verifier partially-confirmed/medium; it read `RightPanel.tsx`, `DiffView.tsx`, `App.tsx`, the store, `ipc.ts` and `git.ts`.
- **Suggested fix:** reset `selected`/`diff` in a `useEffect` keyed on `session.id`, guard async writes with the session id captured at call time, or put `key={session.id}` on the tab.
- **Caveats and counter-evidence:** every git operation is scoped by the session id passed at call time, so the deterministic carry-over produces either session B's *own* diff for the same path or an empty diff rendered as "No textual changes." with no Revert button; A's diff is not what gets reverted. Verifier corrections: there is no `ChangesTab` file; the `useEffect` is 72-74 (cited 71-74), `refresh` spans 59-70, and `onRevert` is 113-121 (cited 105-112).

### Test coverage and gate integrity

#### Session resume after restart is not covered by any test (invariant 1)

- **Severity:** Medium (auditor claimed **high**) | **Confidence:** high | **Status:** confirmed (one verifier partially-confirmed)
- **Category:** test-gap | **Files:** `tests/unit.test.ts`, `tests/terminal.test.ts`, `tests/smoke.live.test.ts`, `tests/e2e.electron.test.ts`, `src/main/session-manager.ts`
- **What is wrong:** `package.json:27` runs only `unit`, `format`, `review-fixes`, `terminal`. `grep -rln "session-manager\|SessionManager" tests/` returns nothing. `tests/smoke.live.test.ts` only asserts a `harnessRef` was populated (`expect(meta.harnessRef.codexThreadId).toBeTruthy();`, `expect(meta.harnessRef.piSessionFile).toBeTruthy();`) and never disposes and re-creates an adapter from persisted state; `tests/e2e.electron.test.ts` asserts the session is listed in the sidebar but does not relaunch the app against the same `userData`.
- **Why it matters:** the resume path can break for any harness without a test failing, and resume is an explicit invariant and data-loss-adjacent.
- **Verification:** two verifiers, one confirmed and one partially-confirmed/medium; the second enumerated every test file and confirmed no test imports `SessionManager`, `SessionStore` or `store.ts`.
- **Suggested fix:** add an offline native-adapter test that writes history/`harnessRef`, constructs a fresh adapter over the same sessionDir, and asserts the conversation continues; ideally a `session-manager` test that persists, reloads, and verifies the adapter is re-created with the stored ref.
- **Caveats and counter-evidence:** smoke already covers half the contract - it asserts each adapter writes the exact ref that resume consumes - so a regression that stops persisting those refs would fail a test; only the re-creation half is untested. Verifier corrections: the smoke assertions are at lines 124 and 153, not 121 and 150; and `session-manager.ts:626` is inside `fork(id)`, not the resume path.

#### SettingsView.tsx duplicate `invoke` import (gate integrity)

- **Severity:** Medium | **Confidence:** high | **Status:** confirmed
- **Category:** gate integrity | **Files:** `src/renderer/src/components/SettingsView.tsx:7-8`
- **What is wrong:** full analysis, reproduction (`tsc` exit 2, TS2300 on both lines), the `dba90de` introduction, the esbuild-dedupe explanation and the split assessments are in the **Verification baseline** section above; this is the same finding, cross-referenced here so the Medium count stays addressable.
- **Why it matters / caveats:** the documented gate fails at this commit and `develop` still carries the same duplicate import; runtime impact is nil because esbuild dedupes. A fix exists on an unmerged branch (`f2b54ce`) but is not in `develop`'s history. See the baseline entry for the verifier corrections and the auditor/fold/critic severity disagreement.

## Low and informational

The 43 low/info findings. Each bullet is `path:line` - defect; fix; caveat.

**Security / containment**

- **Low · partially-confirmed** - `src/main/secrets.ts:50,39` - when `safeStorage` encryption is unavailable the key is written to disk as reversible base64 (`'b64:' + ...`) and decoded on read; refuse to persist when `encryptionAvailable` is false (or keep the key for the process only) and surface an error. *Caveat:* the fallback is deliberately documented in the file's own header ("Falls back to obfuscated storage when OS encryption is unavailable") and only triggers where the OS keychain is absent (e.g. Linux without a keyring); the base64 file is local user data. Verifier corrections: `encryptionAvailable` spans lines 21-26, not 22-24.
- **Low · partially-confirmed** - `src/main/ipc.ts:336-340` - `fs:read` resolves absolute paths verbatim and never checks containment (the sibling `fs:list` at `:293-294` does); drop the `path.isAbsolute` branch, resolve against root, and reject via `isOutsideWorkspace`; also clamp `maxBytes`. *Caveat:* the renderer is not an untrusted principal (sandboxed, CSP, sanitized markdown), and the already-ungated `terminal:input` path is more powerful; verifier corrections: `cwdOf` is at `ipc.ts:280-284` (cited 275-279).
- **Low · partially-confirmed** - `src/main/harness/permissions.ts:41-45` - `isOutsideWorkspace` uses `resolve`+`relative` and never `realpath`, so a symlink inside the workspace pointing outside is treated as contained; realpath the deepest existing ancestor (async) or document the gap. *Caveat:* in `auto` mode native `bash` is already auto-allowed with no path containment, so the file tools are not the primary escape; verifier notes the finding overstates by listing `auto` mode for the file-tool path.
- **Info · partially-confirmed** - `src/main/harness/claude.ts:517-523` - `setPermissionMode` never clears `sessionAllowed`, so tightening the mode leaves prior session-wide grants in place; call `this.sessionAllowed.clear()` when moving to a stricter mode. *Caveat:* `gateAction` re-checks dangerous commands and outside-workspace writes *before* consulting the grant, so the practical impact is limited to non-dangerous tools; verifier correction: the finding wrongly implies Claude is the lone omission - `native/index.ts:43` also holds a `sessionAllowed` set that `setPermissionMode` (`:371`) does not clear.

**Process, resource and error lifecycle**

- **Low · confirmed** - `src/main/session-manager.ts:78-90` - `before-quit` does not drain debounced persists, so metadata changes in the last 300 ms are lost for sessions not in `active` (and `persistTimers` is only cleared by `cancelPersist`); add a `flushPendingPersists()` and include it in the before-quit `Promise.all`. *Caveat:* `stop()` upserts the same mutated `meta` for every session still in `active`, so only already-inactive sessions are at risk. Verifier corrections: `stopAll` is `:324-326`; the timer callback also self-deletes at `:86`.
- **Low · partially-confirmed** - `src/main/session-manager.ts:441-442,502` - transcript and error-item writes use `void this.deps.store.appendTranscript(...)` with no `.catch`, so a failed append is an unhandled rejection; add a `private append(sessionId, item)` helper that calls `void this.deps.store.appendTranscript(sessionId, item).catch((e) => this.deps.log('warn', 'transcript append failed: ' + errorMessage(e)))`, replace both `void this.deps.store.appendTranscript(...)` calls (`:441-442`, `:502`), and use `void this.flushLive(...).catch(...)` in the status case. *Caveat:* the dirty-set retry mostly kills the data-loss impact - items stay dirty while active and `flushLive` only clears them after a successful append. Verifier correction: `TRANSIENT_RENAME_ERRORS` is at `util/fs.ts:29`, not 39-40.
- **Low · confirmed** - `src/main/store.ts:24-31`, `src/main/settings.ts` - a valid-JSON but wrong-shaped `sessions.json`/`settings.json` (non-array / non-object) makes `load()` iterate/assign invalid data and the app can abort boot with no window; validate shape in `load()` and coerce `Array.isArray` for `providers`/`acpAgents`. *Caveat:* the app cannot self-inflict the input - it always writes an array via the atomic temp+rename path - so this requires external corruption. Verifier corrections: provider normalization is `settings.ts:213-224` (cited 150-158, which is inside `BUILTIN_PROVIDERS`).
- **Low · partially-confirmed** - `src/main/session-manager.ts:462-465` - the `status: stopped` branch deletes the `ActiveSession` without cancelling pending approvals or disposing the adapter, leaving an approval card whose buttons do nothing; mirror the fatal-error path (`cancelApprovals`, `adapter.dispose`). *Caveat:* the only user paths that kill a session (Stop, Escape, Sidebar, delete) all call `interrupt()`/`stop()`, which cancel approvals first; verifier correction: the pending-approval action block is `Transcript.tsx:231-233` (cited 186-196).
- **Low · partially-confirmed** - `src/main/session-manager.ts:436-440,510-517` - `liveItems` retains every item for the life of an open session and `transcript()` overlays it with an O(n·m) scan; drop non-streaming flushed items and build the overlay from a Set of disk ids. *Caveat:* `loadTranscript` short-circuits on `loaded[id]`, so the held-open session is loaded once while `liveItems` is nearly empty; verifier correction: tool output is capped at 40k by adapters (`claude.ts:404`, `pi.ts:246`, etc.), not 20k, and assistant/user text is uncapped.
- **Low · partially-confirmed** - `src/main/harness/claude.ts:106,389,402` - `toolItems` keeps every tool call (with full input) for the life of the session; delete the entry after the `tool_result` is handled. *Caveat:* the same object is already held by `active.liveItems` and `transcript.jsonl`, so `toolItems` is not a unique retention; the finding overstates.
- **Low · confirmed** - `src/main/harness/codex-exec.ts:75` - a refused/stale `resumeThread` leaves the broken `Thread` cached, so every later `send` fails; catch the resume failure, clear `this.thread`/`codexThreadId`, and retry with `startThread`. *Caveat:* the trigger is external - nothing in the repo deletes the ref, and the CLI does not GC sessions - so it needs a wiped `~/.codex` or changed provider config. Verifier corrections: `if (this.thread) return this.thread;` is line 65; catch/emit is 101-104.
- **Low · partially-confirmed** - `src/main/harness/codex-app-server.ts:172,561,539,598` - `thread/start`, `turn/start`, `turn/steer`, `thread/interrupt` and compact have no timeout (`withTimeout` is only on `initialize`, `model/list`, `unsubscribe`), so a hung app-server wedges the session; wrap each in `withTimeout(...)` and reset `_busy` on rejection. *Caveat:* the "spawns and answers nothing" scenario is already bounded by the `initialize` 30 s timeout, so the wedge requires a server that passes initialize and then hangs. Verifier correction: the impact claim using that scenario is refuted.
- **Low · partially-confirmed** - `src/main/harness/codex-app-server.ts:263-265` - queued turn dispatch uses `void this.send(...)` with no `.catch` while `send()` rethrows, so a rejected `turn/start` becomes an unhandled rejection; attach a `.catch` that surfaces an info/error item. *Caveat:* the cited "app-server has died" trigger cannot flow through this code (the queue only drains at line 263, and a dead server closes the queue path); the reachable trigger is narrow. Verifier corrections: the rethrow catch is `:563-566`, and it rethrows all `turn/start` rejections, not only transport failures.
- **Low · partially-confirmed** - `src/main/harness/jsonrpc.ts:65-83` - `JsonRpcStdioClient.request()` has no per-request timeout and only drains `pending` on child exit, so a caller that wraps a request in `withTimeout` leaks the entry; add an optional per-request timeout or expose `cancel(id)`. *Caveat:* the finding's own model-picker reproduction is wrong - that path uses a one-shot client whose `finally` calls `rpc.close()` and `killTree`, so nothing leaks there.
- **Low · partially-confirmed** - `src/main/harness/native/index.ts:226-231` - a failure in the turn `finally` (specifically `await this.persist()`) rejects an un-awaited promise and skips the idle status; wrap the persistence in try/catch and always emit idle. *Caveat:* `_busy`/`abort` are already reset and the turn upsert already emitted before `persist()`, so the adapter is mostly recovered even on rejection. Verifier corrections: `void this.runTurn();` is `:111`, and the `finally` is `220-233`.
- **Low · partially-confirmed** - `src/main/harness/claude.ts:335-340` - a failed `supportedModels()` call is swallowed by `.catch(() => undefined)` and `modelsEmitted` is left `true`, so the in-session model picker is never populated and the call is never retried (medium confidence); reset `this.modelsEmitted = false` in the `.catch` so the next `init` retries, or emit a fallback catalog (e.g. `ANTHROPIC_STATIC_MODELS`). *Caveat/correction:* the verifier corrected the mechanism - `supportedModels()` is `(await this.initialization).models`, i.e. the already-started SDK initialization promise, not a fresh per-call fetch that can "transiently fail" - and the code is at `claude.ts:335-340`, not the cited 356-362.

**Correctness and write safety**

- **Low · partially-confirmed** - `src/main/harness/native/tools.ts:261,299` - `write_file`/`edit_file` use a direct truncating `fs.writeFile`, so a crash or failed write destroys the existing file; write to a sibling temp then rename (as `util/fs.ts writeJsonOnce` does). *Caveat:* `write_file` is documented as an overwrite, native tool calls are serialized (no concurrent lost update in one turn), and the project's atomic writer is only used for JSON persistence.
- **Low · confirmed** - `src/main/harness/native/drivers.ts:52-60`, `native/index.ts:310-314` - malformed/truncated tool-call JSON is converted to `{_raw}`, so `bash` runs an empty command and reports success; return a distinguishable parse error and have `executeTool` return `isError:true` instead of executing with empty args. *Caveat:* a stream actually cut mid-tool-call throws inside the SDK iterator before `parseArgs`; only a model emitting syntactically invalid JSON as a complete call reaches this. Verifier correction: `parseArgs`'s signature is line 52.
- **Low · confirmed** - `src/main/harness/native/tools.ts:356-361` - the grep fallback compiles a model-supplied regex with no timeout (only invalid syntax is caught), so catastrophic backtracking can freeze the main process; bound the fallback (length/complexity heuristic, worker, or prefer `rg`). *Caveat:* the model supplying the regex already holds `bash`, so this is an accidental-hang risk, not privilege escalation.
- **Low · confirmed** - `src/main/models/static-models.ts:61-64` - `findPricing` does a reverse-prefix fuzzy match (`x.id.startsWith(bare)`), so a short live id like `gpt-5` is priced using `gpt-5.6-luna`'s rates; only match longer live ids against shorter static ids, or bound the reverse match with a separator check. *Caveat:* data-dependent - it fires only if the live `/models` response contains a bare id that is a strict prefix of a catalog id and absent as an exact entry; no fixture demonstrates it. Verifier correction: the call site is `providers.ts:67`, not 74.
- **Low · partially-confirmed** - `src/shared/diff-parse.ts:98` - the unified-diff parser's final `files.filter((f) => f.hunks.length || f.binary)` drops mode-only and rename-only changes; keep files with metadata lines (a `meta`-only hunk or `modeChange`/`renamed` flag). *Caveat:* the drop is intentional and the UI says "No textual changes."; also the rename-only scenario is refuted for the Changes panel because `git.ts:26` uses `--no-renames`, and binary files are already kept. Verifier correction: the filter is line 98, not 88.
- **Low · partially-confirmed** - `src/main/runtime.ts:243-250` - the ACP branch hard-codes `available: true` and ignores `v.code`, so a broken `dsh` reports available; use `available: v.code === 0` and surface `stderr`. *Caveat:* ACP availability is deliberately a "launcher exists" check, `availability` is advisory only, and selection checks `binaryPath` separately.
- **Low · confirmed** - `src/main/harness/acp.ts:261` - `if (mode === 'full-auto') return selected(pick(['allow_always', 'allow_once']) ?? options[0].optionId);` throws a TypeError when an agent sends an empty `options` array; use the safe `pick(...)` idiom already used by the `allow()` helper. *Caveat:* no conforming ACP agent should send empty options (v2 schema requires `minItems: 1`), and the SDK's JSON-RPC layer catches a throwing handler rather than hanging. Verifier correction: `pick` is `acp.ts:232-238`.

**Renderer, UI and persistence correctness**

- **Low · partially-confirmed** - `src/renderer/src/store.ts:27,210,236-243` - the renderer transcript has no cap or windowing and every rAF flush is linear in transcript size; cap items and per-item `output`, use an id->index Map in the flush, and window the list. *Caveat:* the completing upsert overwrites streamed tool output with a truncated value (30k native, 40k others), so per-item growth is bounded for completed items; verifier correction: the claim that tool output is "the least bounded" is wrong for completed items.
- **Low · confirmed** - `src/renderer/src/markdown.ts:16-35`, `components/Transcript.tsx:129` - streaming re-parses and re-sanitises the whole accumulated message every flush and the render cache retains up to 500 growing prefixes; render plain text while `item.streaming` and parse once on completion, and budget the cache by bytes. *Caveat:* `store.ts` already coalesces deltas through `requestAnimationFrame`, capping the flush rate; verifier correction: the memo only misses on `textDelta` flushes, not thinking/tool flushes.
- **Low · confirmed** - `src/renderer/src/components/Composer.tsx:77-85` - the @-mention search fires an uncancellable full-tree walk per keystroke and seeds the popover with the previous query's results; debounce (~150 ms), clear results while in flight, and cap the walk. *Caveat:* the exploitable window is a single local IPC round-trip; the walk stops at depth 8 and a result limit, and the `cancelled` flag discards out-of-order replies. Verifier corrections: the effect is 77-85, the walk 311-336; the Enter/Tab branch opens at 202.
- **Low · confirmed** - `src/renderer/src/store.ts:27` - deleted sessions are never pruned from `transcripts`/`loaded`, so their content (including base64 images) stays in renderer memory for the run; prune `transcripts`/`loaded`/`activeTerminal` for ids no longer present inside `setSessions` and clear `activeId` if it is gone. *Caveat:* there is no eviction API at all, so this is an unbounded append-only cache regardless of deletes. Verifier correction: the "title bar points at a dead id" impact is wrong - `useActiveSession` returns `undefined` for a stale id.
- **Low · confirmed** - `src/renderer/src/components/TerminalPanel.tsx:31-33`, `main.tsx:8-10` - React StrictMode double-invokes the terminal auto-create effect on mount, spawning two PTYs for one panel open in dev; set a `creatingRef` synchronously before the `await` and reset it in the effect cleanup (or track the in-flight create promise) so the second StrictMode invocation no-ops. *Caveat:* unobservable in the production/e2e bundle (StrictMode is a no-op there) and could not be confirmed with a live dev session. Verifier correction: switching to a session with no terminal does *not* double-spawn.
- **Low · partially-confirmed** - `src/renderer/src/terminal/host.ts:218-221`, `src/main/terminal.ts:528-531` - the renderer fires `terminal:input`/`terminal:resize` with unguarded `void invoke`, and main's `must(id)` throws after the tab closes, producing unhandled rejections; add `.catch(() => undefined)` or make those methods no-ops for unknown ids. *Caveat:* `close()` deletes the term and pushes the list synchronously, so the race is sub-millisecond. Verifier corrections: `must` is `terminal.ts:528-531` (cited 520-524), resize's `must` is `:269`, `input` is `:264-266`.
- **Low · partially-confirmed** - `src/renderer/src/components/RightPanel.tsx:147-155` - `FilesTab` shows the previous session's listing when the new session's `fs:list` rejects and never resets the browsed path; reset `path`/`entries`/`preview` on `session.id` change and ignore stale responses. *Caveat:* `fs:read` resolves against the *new* session's cwd, so a stale row cannot open the old repo's file - only a same-relative-path file in the new repo; verifier correction: the `fs:read` handler is at line 188 (cited 174-183).

**Informational / maintainability**

- **Info · confirmed** - `src/main/harness/codex-app-server.ts:104,556,591` - `modeOverridePending` is set twice and never read (the next turn recomputes the policies anyway); delete the field and its assignments, or implement the gating it implies. *Caveat:* a hidden getter/reflection read was ruled out (no base class, no bracket access).
- **Info · partially-confirmed** - `src/shared/ipc.ts` - six contract channels have a handler but no caller (`app:notify`, `secrets:has`, `providers:list`, `sessions:get`, `git:stageAll`, `terminal:detach`); remove them or wire callers, and type `pushToRenderer` as `channel: keyof PushPayloads`. *Caveat:* no current failure - every push site passes a `PUSH_CHANNELS.*` const, so the loose type has never produced a wrong channel. Verifier corrections: several cited line numbers are wrong (e.g. `app:notify` is line 36, `secrets:has` is 49, `providers:list` is 51).
- **Info · partially-confirmed** - `src/shared/ipc.ts:61-64`, `src/main/ipc.ts:236` - `harness:models` drops the `acpAgent` and `projectRoot` fields the contract and `NewSessionDialog` send; remove them from the contract or thread them into `listHarnessModels`. *Caveat:* the fields are optional extras, their presence is needed for the renderer object literal to typecheck, and the ACP path returns a fixed model list. Verifier corrections: the contract block is 61-64, and the ACP fixed return is `registry.ts:81-82`.
- **Info · confirmed** - `src/renderer/src/markdown.ts:61-62`, `src/main/ipc.ts:60-62` - the renderer accepts `mailto:` and forwards it, but the main handler only opens `http(s)`, so mailto links silently do nothing; allow `mailto:` in main or drop it from the renderer allowlist and `ALLOWED_URI_REGEXP`. *Caveat:* the http(s)-only restriction is a deliberate multi-layer policy (`main/index.ts:198,209` independently restrict `openExternal`); this is a mismatch, not a security bug. Verifier correction: the href/openExternal block is `markdown.ts:61-62` (cited 65-67).
- **Info · confirmed** - `src/main/harness/claude.ts` / tests - no offline test exercises `claude.ts` event normalisation or permission mapping; add a `tests/unit.test.ts` case that constructs `ClaudeAdapter` with a fake `HarnessContext` and feeds representative `SDKMessage`s (success+`is_error`, aborted `terminal_reason`, `tool_use`/`tool_result`) plus a `canUseTool` decision, asserting the emitted `SessionEvent`s (`handle` is private, so extract a small pure mapping helper to test). *Caveat:* AGENTS.md routes harness-adapter validation to the opt-in live suites, so the absence is a documented process choice; `gateAction` itself *is* tested. Verifier correction: the shared gate is covered; only the adapter mapping is not.
- **Info · partially-confirmed** - `src/shared/ipc.ts`, `src/main/ipc.ts` - `terminal:detach` (and `TerminalManager.detach`) is registered but never invoked by the renderer; remove it or document that hidden instances stay attached. *Caveat:* "unreachable" is inaccurate - the channel is registered and preload exposes raw `invoke`, so any renderer JS can call it - and `host.ts:83` documents the attached behaviour.
- **Low · confirmed** - `README.md:48` - the offline test count is stale (`37 tests` in the README versus 44 actual: 19 unit + 3 format + 6 review-fixes + 16 terminal); update or drop the number. *Caveat:* cosmetic documentation drift; this is the critics' 11th candidate, but the count is verified first-hand by the baseline `npm test` run (which is why it is counted in the 66 rather than in the unverified critic set) and also by the completeness critic.

**Test-gap findings (low/info)**

- **Low · confirmed** - `tests/` - no offline test exercises any harness adapter's `SessionEvent` normalisation (only pure mappers like `piModelToInfo`/`codexModelToInfo` are imported); add cases to `tests/unit.test.ts` using its existing `fakeChild` pattern that feed each adapter a recorded/synthetic stdin chunk or fake child and assert the emitted `SessionEvent[]` sequence. *Caveat:* AGENTS.md explicitly covers this via the opt-in live suites. Verifier corrections: the smoke `enabled` guard is line 18 (cited 20) and `createAdapter` is exercised elsewhere.
- **Low · partially-confirmed** - `src/main/harness/types.ts:62-79` - the dangerous-command patterns are 11/16 untested (only 5 are exercised); add a table-driven test in `tests/review-fixes.test.ts` (or `tests/unit.test.ts`) asserting each pattern matches a representative string and that a benign near-miss (e.g. `rm -r` without force, `git status`, `npm test`) does not. *Caveat:* `review-fixes.test.ts:9` already asserts the dangerous check precedes the session grant, so the ordering contract is partly guarded. Verifier corrections: the array is lines 62-79 (cited 59-75) and the untested count is 11/16, not 13/16.
- **Low · partially-confirmed** - `src/renderer/src/markdown.ts:29-33` - markdown sanitisation has no test; add a jsdom/node unit test (in `tests/unit.test.ts`) over `<script>`, `<img onerror>`, `javascript:` and `data:text/html` samples. *Caveat:* the claimed XSS impact is neutralised by defense-in-depth - strict CSP `script-src 'self'` at `index.html:7` and a strict URI allowlist - so this is regression protection, not a live hole.
- **Low · partially-confirmed** - `src/main/secrets.ts`, `tests/` - `SecretStore`/keychain handling is never tested; add to `tests/unit.test.ts` (or a new `tests/secrets.test.ts`) a test with a stubbed `safeStorage` (encrypt/decrypt round-trip, clear, unavailable fallback) and assert `providers:save` returns `hasApiKey` rather than the key. *Caveat:* no key reaches the persistence path - `secrets.set` is the only writer and targets `secrets.json`, while `providers:save` is typed to a `ProviderConfig` that declares `hasApiKey`. Verifier correction: "settings.json contains only `hasApiKey: boolean`" is wrong; the provider object carries other fields.
- **Low · confirmed** - `tests/smoke.live.test.ts:179-184,195-196` - the native live-smoke tests `return` early when no provider key is set, so they report "passed" with zero assertions; use `it.runIf(key)` or `ctx.skip()` so the report shows "skipped". *Caveat:* the first block does `console.warn('native smoke skipped: no provider API key in env')`, so an operator watching sees it; the second block is silent.
- **Low · confirmed** - `src/shared/ipc.ts`, `src/main/ipc.ts`, `tests/` - IPC contract completeness is not enforced by any test (the contract currently declares 68 channels and `ipc.ts` registers 68, but nothing asserts equality); in `tests/unit.test.ts` (or a new `tests/ipc-contract.test.ts`) export the handled-channel list from `src/main/ipc.ts` (or a constant array) and assert set equality against `keyof IpcContract`/`PUSH_CHANNELS`. *Caveat:* the contract is currently 100% in sync and the e2e suite would exercise IPC at runtime; this is future drift protection.

## Findings the completeness critics added (unverified)

The 10 findings below were produced by the two completeness critics during a seam/build-surface sweep. **They were not adversarially verified**; treat them as medium/low confidence and confirm before acting. None is a fabricated code quote - the critics read the cited regions - but no independent refuter tested the claims. The critics' 11th candidate, the stale README offline test count, was independently confirmed first-hand by the baseline `npm test` run (44 actual vs the README's 37) and is therefore listed once in the Low/Info section rather than repeated here; it is counted in the verified 66, not in this unverified set.

1. **ACP resolves harness binaries from the app-runtime root, but installs put them in `<root>/bin` on POSIX** (medium, unverified). `src/main/harness/acp.ts:93` calls `which(command, [this.ctx.runtime.runtimePaths.appRuntimeDir]);`, while `RuntimeResolver.appRuntimeBin()` returns `isWin ? [base] : [path.join(base, 'bin')]` and `install()` (`npm install -g --prefix <base>`) writes shims to `<base>/bin` on macOS/Linux but directly under `<base>` on Windows. Tentative impact: on macOS/Linux a harness installed through Settings is not found by the ACP adapter even though `availability('acp')` reports it ready; Windows hides the bug. Fix: expose the bin dir (make `appRuntimeBin()` public) and use it here, matching `RuntimeResolver.resolve`. *Caveat:* the `npx` fallback may still launch the agent, so this may degrade to "uses npx instead of the installed shim" rather than a hard failure; unverified.

2. **Streaming assistant replies are persisted after their tool calls, so a reloaded session shows the reply below its tool cards** (medium, unverified). In the `case 'item.upsert'` block of the `emit` handler in `src/main/session-manager.ts`, where `const streaming = item.kind === 'assistant' && item.streaming; if (!streaming || !active) void this.deps.store.appendTranscript(sessionId, item);`, a streaming assistant bubble is withheld while a subsequent tool upsert is appended immediately, and `readTranscript` collapses in first-occurrence order, so post-reload the tool card precedes the assistant text. Fix: add a monotonic `order`/`seq` field to transcript items and sort by it in `SessionStore.readTranscript` on read, or persist the assistant item (with its first-seen order) when it is created rather than only on completion. *Caveat:* this is a persistence/ordering seam; the live view is correct, and the fix touches both `session-manager.ts` and `store.ts`.

3. **Terminal `create` leaks the headless xterm and its addon when the shell fails to spawn** (low, unverified). `create()` does `const t = this.newTerm(...); this.spawnInto(t, shell); this.terms.set(id, t);` - if `spawnInto` throws (bad custom shell path, missing executable), `t` is never inserted into `this.terms` and can never be closed, and its disposables still run. Fix: try/catch `spawnInto`; on failure dispose `t.screen` and rethrow, inserting only after success. *Caveat:* requires repeated failed creations (e.g. a stale custom shell path); no measurement of the leak was made.

4. **`providers:delete` clears the stored key even for builtin providers it refuses to delete** (low, unverified). The handler keeps builtin providers in `next` (`p.id !== id || p.builtin`) but runs `await secrets.clear(id)` unconditionally, so calling the exposed channel with `anthropic` drops the encrypted API key while leaving the provider configured. Fix: look up the provider first and only `secrets.clear(id)` when the provider is actually removed (`!p.builtin`). *Caveat:* the UI only shows Delete for non-builtins; this requires a direct IPC call.

5. **tsconfig project boundaries do not enforce the main/renderer layering AGENTS.md claims** (medium, unverified). `include` globs are not fences; measured with `npx tsc -p tsconfig.node.json --listFilesOnly`, the node program already contains `src/renderer/src/format.ts` (pulled in by `tests/format.test.ts`), and 13 `src/main` files import neither `node:*` nor `electron` (including `permissions.ts`, `static-models.ts`, `util/async.ts`, `native/drivers.ts`), so a renderer import could pass `tsconfig.web.json` today. `tsconfig.web.json` sets `types: []`, which removes Node globals but does not reject the import. Fix (cheapest enforceable option): add a test in `tests/` that runs `npx tsc -p tsconfig.web.json --listFilesOnly` and asserts no `src/main/**` path appears, and correct the AGENTS.md sentence that claims the boundary is "enforced by tsconfig project boundaries". *Caveat:* no cross-boundary import exists today; this is a convention gap, not an exploited hole. The core input's `tsconfigBoundaries` confirms the mechanism.

6. **"Any write outside the project directory always prompts below Full access" is not enforced for native bash or Codex applyPatchApproval** (medium, unverified). README.md:156 and AGENTS.md:52 promise the invariant covers any write; in `native/index.ts:267-269` the check is scoped to edit tools and only upgrades an already-allow verdict, so `bash` (mutating but not `isEdit`) is auto-allowed for non-dangerous writes in `auto` mode; the Codex legacy `applyPatchApproval` path (`codex-app-server.ts:377-381`) returns `approved` for every non-ask mode without reading `fileChanges`. Fix: detect out-of-workspace shell writes where possible (or stop claiming the guarantee for free-form bash) and re-check patch paths below full-auto. *Caveat:* the Codex legacy request is likely unreachable - see the refuted findings table - and the native-bash half is the real, documented gap. This overlaps the High native finding and should be fixed together with it.

7. **The documented permission-gating e2e can exit green without testing anything** (medium, unverified; reported in the corrected, narrower form - see `baseline.approvalE2eCorrection`). `tests/e2e.approval.test.ts:13` gates the whole suite with `describe.runIf(enabled)` where `enabled = HARNESS_E2E === '1' && (DEEPSEEK_API_KEY || OPENAI_API_KEY)`. With no key the suite is **skipped** (reported as skipped, not passed), but the permission-gating e2e that AGENTS.md names is never exercised by the default `npm test` gate, and a `HARNESS_E2E=1` run without a provider key exits green having tested nothing. By contrast `tests/smoke.live.test.ts` uses per-test `it.runIf` with an early `return`, which is a genuinely green no-op test. Fix: fail (not skip) under `HARNESS_E2E=1` when no key is present, print a skip reason, and add the key requirement to README/AGENTS.md alongside the command. *Caveat:* the original critic phrasing - "silently passes without doing anything when no provider key is set" - is wrong; the suite is skipped, not passed. The corrected risk is the narrower one above.

8. **Pi permission-mode changes can be silently dropped** (low, unverified). `src/main/harness/pi.ts:479-481` writes the mode file with `await fs.writeFile(this.modeFile, mode, 'utf8').catch(() => undefined);`. The only enforcement path is `resources/pi/vocs-code-approvals.ts` -> `refreshMode()`, which reads that file and falls back to the env var set at spawn. If the write fails the promise resolves as if the mode changed and the UI already applied it. Fix: surface the write failure instead of swallowing it, and re-verify the mode file when treating a pi approval request as authorised. *Caveat:* requires a filesystem write failure; the host-side `gateAction` is not applied to pi's approval requests, so nothing else catches drift.

9. **app:openPath forwards any renderer-supplied path to shell.openPath** (low, unverified). `src/main/ipc.ts:63-65` calls `shell.openPath(p)` with no validation or session scoping, while `app:openExternal` beside it checks `/^https?:\/\//i`. Every current caller passes `session.cwd`. Tentative impact: a compromised renderer can ask the OS to launch any executable. Fix: take a `sessionId` and require `isSubPath(session.cwd, path)` (or drop absolute-path support). *Caveat:* defense-in-depth; no XSS path was demonstrated.

10. **macOS quits the whole app when the last window closes** (low, unverified). `src/main/index.ts:133-135` registers `app.on('window-all-closed', () => { app.quit(); });` without a `process.platform !== 'darwin'` guard, even though the same file special-cases darwin for the menu and traffic lights and `electron-builder.yml` ships a `mac: dmg` target. `app.on('activate')` is registered but can never fire. Fix: guard the quit with `if (process.platform !== 'darwin')`. *Caveat:* static read of a platform branch that was not executed; standard Electron lifecycle.

## Refuted and unverified findings

The five findings below were **refuted** by their adversarial verifiers and dropped; the sixth **could not be verified**. Publishing them prevents the same non-issues being re-raised.

| Finding | Claimed severity | Why it was dropped |
| --- | --- | --- |
| A delayed transcript write re-creates the session directory after `delete()` removed it, leaving orphaned `sessions/<id>/` trees | low | The quoted snippets exist, but the trigger does not survive the SDK code `dispose()` actually calls. `ClaudeAdapter.dispose()` calls `this.q?.close()`; SDK `Query.close()` -> `performCleanup(undefined)`, whose terminal branch is `if (e) this.inputStream.error(e); else this.inputStream.done()`. With no `sessionStore` mirror batcher, the transcript write never runs after delete. |
| `dispose()` during `start()`'s API-key await lets `start()` create a query after disposal | medium | `src/main/secrets.ts:29-41` `get(id)` has no `await` in its body; awaiting that resolved promise resumes in the same microtask checkpoint, so `query()` at `claude.ts:174` cannot be scheduled after `dispose()` at `:534-544` in the way claimed. |
| Legacy `applyPatchApproval` auto-approves every non-ask mode without checking paths | medium | The path-unguarded code at `codex-app-server.ts:377-381` is real, but the legacy `ApplyPatchApproval` server request is never sent to this client: codex labels it DEPRECATED and reserves it for turns started via the legacy APIs. Unreachable for this client. |
| Snapshot `seq` counts output fed to the headless parser but not yet parsed, so a chunk arriving during attach is neither in the snapshot nor pushed | medium | `net.Socket.pause()` synchronously halts `'data'` events (empirically verified: server writes 20 ms/60 ms after `client.pause()` arrived only after `resume()`), and node-pty's `pause()` is exactly `this._socket.pause()` on the ConPTY output socket, so no chunk is lost in the window claimed. |
| The Escape branch of the composer key handler has no IME guard, unlike Enter, so cancelling a composition can interrupt the running turn | low | The trigger requires `text === ''` while an IME composition is active; that is contradicted by the preedit: while composing, `text` holds the IME preedit, so `if (busy && !text)` is false and the interrupt is not invoked. |
| **Unverified:** `dialog.showOpenDialog`/`showSaveDialog` pass an `undefined` double-cast into a native `BrowserWindow` slot | low | Cited in `src/main/ipc.ts`; passing `undefined` where a `BrowserWindow` is required is not one of Electron's supported overloads, so on the null-window path it can reject with an argument-conversion TypeError, surfacing as a failed export. Latent, only on the rare closed-window path; could not be verified statically. Fix: branch on the window (`win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts)`) and drop the double cast. |

Separately, the completeness critic's approval-e2e claim was **corrected** rather than refuted: the suite is skipped (not passed) without a provider key, and the real risk is the narrower one stated in the critic-only section above. Use the corrected version; the original critic wording ("silently passes without doing anything") is inaccurate.

## Coverage and blind spots

**Examined.** Ten auditors covered disjoint slices of all 64 TS/TSX files in `src/` and `tests/` (13,730 lines): the shared IPC contract and harness metadata; the main entry/settings/store/secrets/runtime/git/ipc layers; the terminal manager; the util, models and native-driver helpers; each of the six harness adapters; the renderer store, App and the settings/right-panel components; and all nine test files. The build/packaging/config surface (`package.json`, `electron-builder.yml`, the tsconfigs, `AGENTS.md`, `README.md`, `vitest.config.ts`) was swept by the two completeness critics, and the baseline commands were executed first-hand.

**Explicitly not examined** (from `criticUnexamined`, plus the stated limits):

- `src/renderer/src/styles.css` - in the declared scope via `components/*` but not defect-audited.
- `src/renderer/src/components/ui.tsx` and `Resizer.tsx` - skimmed only; `Dropdown`/`Modal` focus and keyboard behaviour were not audited.
- **Packaged output**: `electron-builder.yml` was inspected statically but `npm run dist:dir` and the packaged-app e2e (`HARNESS_E2E_EXE`) were never run, so asar/`extraResources` behaviour and the `@lydell/node-pty` unpacking are inferred, not executed. The packaged path resolver may hand a path inside `app.asar` to `child_process.spawn` - `runtime.ts nodeModulesDirs()` returns `.../app.asar/node_modules`, `.../app.asar.unpacked/node_modules`, ... - which was reasoned about but not tested.
- **Live harness behaviour**: `tests/smoke.live.test.ts` and the `HARNESS_E2E` suites were not run (they need installed/logged-in runtimes and spend credit), so adapter protocol assumptions (Codex app-server methods, pi RPC shapes, ACP capabilities) are static.
- `resources/pi/vocs-code-approvals.ts` correctness against the actual pi extension loader (TypeScript extension loading from `process.resourcesPath` was not exercised); it is outside the per-auditor slice and was reviewed only for mode/dangerous-command parity with `src/main/harness/types.ts`.
- Real offline `npm test` execution of the terminal test under a real PTY, and the opt-in suites in general (guards, include globs and assertions were read, not run).
- Error paths not driven: revoked/expired OAuth tokens and offline behaviour in `src/main/models/providers.ts`; a workspace/worktree deleted underneath a running session; UI components other than `SettingsView.tsx` were skimmed for imports/IPC only, and no test covers `store.ts`/`App.tsx`/`Transcript.tsx`/`DiffView.tsx`/`Composer.tsx` keyboard or rendering logic.

**Open risks that remain because of the untested surface:**

- **win32 vs POSIX.** Most live checks ran on win32. `isOutsideWorkspace`'s separator handling, ACP's `<root>/bin` layout, `which()` semantics and macOS lifecycle branches were not exercised on both platforms; the ACP bin-dir finding is a POSIX-only bug that Windows hides.
- **Packaged/asar path.** Native modules are configured to stay unpacked, but a packaged run would be the only way to confirm the `app.asar`/`app.asar.unpacked` split and the spawn path resolver.
- **Live adapters.** The adapter/CLI contract (Codex app-server JSON-RPC, pi mode-file extension, ACP permission flow) only fails visibly against a logged-in runtime; the security findings in `claude.ts` (SDK permission suggestions) and `acp.ts` (writeTextFile) in particular were verified statically or against the shipped CLI's embedded JS, not end to end.
- **Any change requiring real credit or a logged-in runtime** - the opt-in smoke/e2e suites - is unverified in this audit.

## Recommended next actions

### Fix before the next release

1. **Unify path containment on the existing helpers.** One fix covers several findings and should be done as a single change: use `isOutsideWorkspace` (or `isSubPath` at `src/main/util/fs.ts:114`) everywhere instead of ad-hoc string checks. Files: `src/main/harness/native/index.ts:267` (raw `startsWith`), `src/main/harness/acp.ts:198-225` (`writeTextFile` never checks), `src/main/git.ts:72-77,106-109` plus `src/main/ipc.ts:287` (`git:diff`/`git:revert` traversal), `src/main/ipc.ts:336-340` (`fs:read`), `src/main/ipc.ts:63-65` (`app:openPath`). Make containment an async `realpath`-based check to close the symlink gap (`permissions.ts:41-45`). Test: a new `tests/review-fixes.test.ts` case per surface asserting an out-of-workspace target returns an error/asks even in `accept-edits`/`auto`, plus a symlink case.
2. **Rewrite dangerous-command detection; stop matching raw shell text.** Fixes High 4, High 5, High 6 in one place, and must be applied to the duplicated list in `resources/pi/vocs-code-approvals.ts:50-69` (`pi.ts:89`) as well as `src/main/harness/types.ts:62-79`. Either tokenize argv or normalize whitespace and collapse separated flags, then match order-independently across `rm`, `dd`, `chmod`, `git clean`/`push`, `del`, `rd`/`rmdir`, PowerShell aliases, `format.com`, and `-EncodedCommand`. Test: extend `tests/review-fixes.test.ts` with the exact bypass strings from the three High findings (`rm -r -f /home`, `rm --recursive --force /`, `dd of=... if=...`, `chmod 777 -R /`, `git push origin +main`, `git -c x push --force`, `del /f /s /q C:\`, `rd /s /q C:\`, `ri -r -fo C:\`, `format.com c:`, `powershell -EncodedCommand ...`) and with benign near-misses.
3. **Cap the live bash output channel.** `src/main/harness/native/index.ts:311-314` still forwards every chunk to both the main-process item and the renderer after `MAX_OUTPUT` was reached in `native/tools.ts:207-210`. Stop calling `onOutput` past the cap and emit one truncation marker. Test: a tool test that runs a command emitting >`MAX_OUTPUT` and asserts the emitted deltas stop at the cap; check the renderer accumulation in `src/renderer/src/store.ts:210`.
4. **Fix the gate break.** Delete `src/renderer/src/components/SettingsView.tsx:7` (line 8 already imports `invoke`, `isMac` and `platform`). `develop` carries the same duplicate import, so fix it there too. A fix exists on the unmerged branch `f2b54ce` and can be cherry-picked instead, but neither `develop` nor this branch contains it. Then add a CI step that runs `npm run typecheck`; the failure survived because `npm run build` and `npm test` do not catch the duplicate binding. No test needed.

### Worth doing

5. **Make child-process lifecycle fail-safe.** Add teardown on failed `start()` to `codex-app-server.ts` (never kills the spawned child), `acp.ts:103`, and `pi.ts:114` (handshake timeout orphans), and have `session-manager.ensureActive`'s catch call `adapter.dispose()`. In the same pass, settle `runCapture`'s timeout (`runtime.ts:77-93`), add an optional request timeout to `JsonRpcStdioClient` (`jsonrpc.ts:65-83`) and a `child.stdin.on('error')` handler to `jsonrpc.ts`, dispose the headless terminal when `spawnInto` fails (`terminal.ts create()`), and add `withTimeout` to the unguarded codex requests (`codex-app-server.ts:172,561,539,598`). Test: a unit test with a fake child that rejects the handshake and asserts `dispose`/kill was called; extend `tests/unit.test.ts`'s existing `fakeChild` pattern.
6. **Close the permission-mode drift paths.** Do not return `updatedPermissions` from `claude.ts:210-214`; clear `sessionAllowed` in `setPermissionMode` (`claude.ts:517-523`, `native/index.ts:371`); surface the pi mode-file write failure (`pi.ts:479-481`); cancel approvals and dispose on the `status: stopped` branch (`session-manager.ts:462-465`). Test: `tests/review-fixes.test.ts` - after a session grant, assert a dangerous command still asks, and after tightening the mode a non-dangerous grant no longer auto-allows.
7. **Fix persistence correctness.** Persist the assistant item with its first-seen order or add a monotonic order field and sort on read (`session-manager.ts` + `store.ts`); validate index/settings shape in `load()` (`store.ts:24-31`, `settings.ts`); drain debounced persists in `before-quit` (`session-manager.ts:78-90` + `index.ts`); log rather than swallow transcript append failures (`session-manager.ts:441-442,502`); and make `write_file`/`edit_file` atomic (`native/tools.ts:261,299`). Test: a store round-trip test (persist, reload, assert order) and a `before-quit` flush test.
8. **Scope renderer state to the session.** `key={session.id}` or a `session.id`-keyed reset on `Composer` (`App.tsx:118-119`), `ChangesTab` and `FilesTab` (`RightPanel.tsx`); prune deleted sessions in `setSessions` (`store.ts:27`); guard StrictMode double-create in `TerminalPanel.tsx:31-33`. Test: a renderer test that switches sessions with a draft/selection present and asserts it is cleared; none exists today.
9. **Convert the silent no-op test guards into skips.** `tests/smoke.live.test.ts:179-184,195-196` and `tests/e2e.approval.test.ts:13` - use `it.runIf`/`ctx.skip()` so a no-key run reports skipped, and fail loudly under `HARNESS_E2E=1` with no provider key. Update README/AGENTS.md to state the key requirement and fix the stale test count (`README.md:48`, 37 vs 44).
10. **Add the missing offline coverage.** Adapter `SessionEvent` normalisation (feed synthetic chunks via the `fakeChild` pattern in `tests/unit.test.ts`), session resume after restart (`session-manager` + native adapter re-creation), a table-driven dangerous-command test (already covered in item 2), markdown sanitisation (`tests/unit.test.ts`), `SecretStore` with a stubbed `safeStorage` (`tests/unit.test.ts` or a new `tests/secrets.test.ts`), and IPC contract completeness (in `tests/unit.test.ts` or a new `tests/ipc-contract.test.ts`, assert `keyof IpcContract` equals the registered set). These are the five test-gap findings and the one resume finding, and each runs without Electron or network.
11. **Clean up dead/unused surface.** Delete `modeOverridePending` (`codex-app-server.ts:104`) and either remove or wire the six unused channels / type `pushToRenderer` (`src/shared/ipc.ts`, `src/main/ipc.ts:37`); decide whether `mailto:` is supported and make the renderer and main allowlists agree (`markdown.ts:61-62`, `ipc.ts:60-62`); and either thread or drop `acpAgent`/`projectRoot` in `harness:models` (`shared/ipc.ts:61-64`, `ipc.ts:236`).
