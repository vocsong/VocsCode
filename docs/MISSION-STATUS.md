# Mission status and support

Missions are **experimental**. This page is the release report that the
[specification](MISSION-SPEC-v0.2.md) asks for in §22.6: which combinations were tested, which
verification tiers ran, and what is still unverified. How to use a Mission is in
[MISSIONS.md](MISSIONS.md).

## Support matrix

| Combination | Status |
| --- | --- |
| Pi presets for the lead and workers, Windows 10/11, Pi 0.85.1 | Supported for testing. Deterministic, scripted-runtime and installed-Pi offline suites pass. No live end-to-end Mission has completed yet. |
| Claude presets | Not supported. Claude's runtime cannot report the exact model, effort and connection before a prompt, so dispatch refuses it. |
| Codex, Cursor, ACP and native presets | Not supported. They have no Mission readiness driver. |
| macOS and Linux | Not supported. Managed process ownership relies on Windows Job Objects. Ordinary sessions on these platforms are unaffected. |
| Local commit delivery | Covered by real-Git tests. |
| Open PR and merge PR delivery | Covered only with a scripted `gh` and local bare remotes. Never run against real GitHub. Needs the `gh` CLI signed in. |

## Verification tiers

VERIFICATION_RESULTS_PLACEHOLDER

## Live demonstrations (§22.5)

None has passed yet.

- **Demo A** (plan together → implement → independent review → verify → local commit): four paid
  attempts, none passed. The furthest reached a real read-only scout, two answered questions, an
  approved plan and two direct edits by the lead, then hit its 2M-token bound before any candidate
  capture, review, counted check or delivery. The earlier attempts failed on coordination bugs that
  have since been fixed. The latest stopped in the test driver before a Mission was created; that
  driver defect has also been fixed.
- **Demo B** (autonomous parallel feature with a cross-harness worker) and **Demo C**
  (interruption, integration conflict, restart and Resume): one early attempt each. Both failed at
  coordination or driver boundaries before reaching their intended stages, and neither has been
  rerun. Demo B's cross-harness part also needs a second supported harness, which does not exist
  yet.

Running them spends provider credit, so each paid run needs the user's explicit go-ahead. The driver
and its environment variables are described in [TESTING.md](TESTING.md#live-suites-provider-credit-or-a-logged-in-runtime).

## Acceptance scenarios

Each of the 72 scenario IDs in spec §22.2–22.4 (P01–P22, R01–R24, V01–V26) maps to deterministic
tests against the real Mission service, store, scheduler, Git workspaces and registered handlers,
with scripted harness boundaries (`tests/mission-*.test.ts`), plus the Electron flows in
`tests/e2e.mission*.test.ts`. None is certified by a live provider run. Scenarios that depend on
model behaviour — the quality of questions and plans, real parallel workers, cross-harness
dispatch (P08, R08, Demo B), real GitHub PR/merge endpoints and acknowledgment loss (V09, V10,
V12, V18) — stay unverified until the demonstrations pass.

## Known gaps

KNOWN_GAPS_PLACEHOLDER
