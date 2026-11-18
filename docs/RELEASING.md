# Releasing

How a merged change becomes an installable installer on the [Releases page](https://github.com/vocsong/VocsCode/releases).

## Branch model

- `develop` — integration branch. All PRs land here, squash-merged, with Conventional Commits titles.
- `master` — release gate. Updated only by the ship PR from `develop` and by release-please's release PR. Installers are built from `master` tags.

One-way flow: `develop` → `master` → tag → CI build → GitHub Release. `master` is merged back into `develop` after each release so the version bump doesn't drift.

Branch rulesets (Settings → Rules → Rulesets):

- **`master requires the full CI tier`** — required status checks, **no bypass**: all four CI jobs
  (`typecheck · test · build (ubuntu)`, `e2e, no provider credit (windows)`,
  `Windows ownership and recovery (offline)`, `Windows packaged-app smoke (offline)`) must pass on a
  PR before it can merge into `master`.
- **`develop requires the fast CI gate`** — required status check, **no bypass**:
  `typecheck · test · build (ubuntu)`.
- **`master require PR and approval`** — PR, approval, no deletion and no force-push; this review
  ruleset keeps its admin bypass (pull requests only), so an admin can merge their own ship and
  release PRs without a second reviewer. The bypass does not reach the status-check ruleset above.

Because every hand-off in that flow is a rebase, the two branches never share commit SHAs: they hold the same content as different commits, and their merge base drifts far into the past. GitHub therefore reports **both** `develop` → `master` and `master` → `develop` as `CONFLICTING`, and no merge method is available for either. Every hand-off below is a branch that already carries the right content on top of its target, not a merge of the two long-lived branches.

## Conventions that feed the bot

[release-please](https://github.com/googleapis/release-please) parses commit history on `master` to write `CHANGELOG.md` and pick the next version. It only sees conventional commits, which is why PR titles matter:

| Title prefix | Effect |
| --- | --- |
| `feat:` | minor bump (`0.2.0` → `0.3.0`), listed under Features |
| `fix:`, `perf:` | patch bump (`0.2.0` → `0.2.1`), listed under Bug Fixes |
| `feat!:` or a `BREAKING CHANGE:` footer | major bump |
| `chore:`, `docs:`, `ci:`, `test:`, `refactor:` | no entry, no bump on its own |

This repo's squash settings are `COMMIT_OR_PR_TITLE` + `COMMIT_MESSAGES`, so the squash subject comes
from the **head commit** when the PR has one commit, and from the **PR title** when it has several.
Give a one-commit PR the Conventional Commits title on the commit itself, or merge with
`gh pr merge --squash --subject "<conventional title>"`; a multi-commit PR only needs it on the PR.

The bot reads master's **first-parent history**: it represents each merge commit by its PR title and parses direct commits as-is. That drives two merge rules:

- **Ship PR (a branch off `master` carrying `develop`'s commits — not `develop` itself, see [Shipping a release](#shipping-a-release)): "Rebase and merge."** The individual conventional commits from develop land directly on master where the bot can parse them. A merge commit collapses them under one non-conventional PR title and the bot skips the entire ship.
- **Release PR (release-please's `chore(release): vX.Y.Z`): "Rebase and merge"** too, so the changelog commit sits on the first-parent chain.

## Shipping a release

1. Make sure `develop` is green — the latest merged PRs passed the develop tier. The full tier
   (whole offline suite, every no-provider E2E suite, Windows recovery) first runs on the ship PR
   below; if it fails, fix it on `develop` with a normal PR, then rebuild the ship branch. Do not
   merge a ship PR with a red check.
2. Cut the ship branch off `master` carrying exactly `develop`'s new commits, open the ship PR from it, and rebase-merge it (see above for why the commits have to land on `master` individually):

   ```bash
   git fetch origin
   # the sync-back lands the previous release commit on develop, so everything after it is new work
   boundary=$(git log --format=%H --grep '^chore(master): release' -1 origin/develop)
   git checkout -b <agent>/ship-vX.Y.Z origin/develop
   git rebase --onto origin/master "$boundary"
   git diff origin/develop HEAD --stat   # must be empty: the ship carries develop unchanged
   git push -u origin <agent>/ship-vX.Y.Z
   gh pr create --base master --head <agent>/ship-vX.Y.Z --title "chore: ship develop to master for the next release"
   gh pr merge --rebase
   ```

   A commit that `master` already has by content is dropped by the rebase, so a `boundary` from an earlier release is harmless.
3. release-please runs on that push and prepares the release commit (version bump + changelog) on `release-please--branches--master--components--vocs-code`. It cannot open the PR itself (see below), so open it by hand — title `chore(master): release X.Y.Z`, body the new `CHANGELOG.md` section, which the bot has already written to that branch — and rebase-merge it once **all four** required checks have passed, including the Windows ownership and recovery job (about 45 minutes); the ruleset blocks the merge until then.
4. Push the tag from `master`, then create an **empty draft** attached to that tag. The tag must
   equal `v` plus the tagged `package.json` version. The real tag push starts the installer build; `release.yml` alone
   publishes the draft, after all three platform bundles and all 14 assets validate. Do not publish
   the draft in the GitHub UI. release-please deliberately uses `skip-github-release: true`: it
   prepares the release PR, not tags or public releases. Both tag workflows first run the
   [release tag gate](#release-tag-gate), which waits for master CI on the exact release commit —
   tagging right after the merge is fine.

   ```bash
   git tag vX.Y.Z origin/master && git push origin vX.Y.Z
   gh release create vX.Y.Z --draft --verify-tag --title vX.Y.Z --notes-file <the new CHANGELOG section>
   gh release view vX.Y.Z --json tagName,isDraft
   ```

   Confirm `tagName` is `vX.Y.Z` and `isDraft` is `true` while the build runs.
   For a prerelease, use the matching version suffix and add `--prerelease` when creating the
   draft. Publication preserves that flag, the title, and the human-authored notes.

   The same tag push starts `deploy-relay`, which waits for approval in the protected
   `relay-production` environment. Approve it when the installers are on the release page, so the
   production relay and the desktop that speaks its protocol ship together. Then run the live
   checklist and the deployed smoke (see [relay/README.md](../relay/README.md#deploy-and-recovery)).
   Every release redeploys the relay, even when it did not change.
5. Sync back: cherry-pick the release commit onto a branch off `develop` and rebase-merge that PR, so `develop` gets the version bump and changelog. The tree-identity check is what proves the sync carried exactly that commit, and the CI on the PR verifies it.

   ```bash
   git checkout -b <agent>/sync-vX.Y.Z origin/develop
   git cherry-pick <release commit on master>   # no -x: keep the bot's message and authorship
   git diff origin/master HEAD --stat           # must be empty
   git push -u origin <agent>/sync-vX.Y.Z
   gh pr create --base develop --head <agent>/sync-vX.Y.Z --title "chore: sync the vX.Y.Z release commit into develop"
   gh pr merge --rebase
   ```

Opening the PR in step 3 depends on the Actions settings described below. Creating the tag and
empty draft in step 4 is intentional; enabling Actions PR creation does not automate publication.

## Complete-set publication and recovery

`release.yml` serializes whole runs per tag (`cancel-in-progress: false`). The three build legs
have `contents: read` plus narrowly scoped OIDC/attestation write permissions, no release-publication
token, and no persisted checkout credentials. They run
`electron-builder --publish never` with the GitHub publish configuration intact: the locked builder
still emits `app-update.yml` and the updater manifests, including one merged dual-architecture mac
feed. `releaseType: draft` is also the builder default. Do not replace publish config with `null`
or restore `--publish always`.

Only allowlisted output files are staged in `release-windows`, `release-macos`, and `release-linux`
Actions bundles (14-day retention). Their names are stable within a run, so **Re-run failed jobs**
can reuse successful legs; they do not include `run_attempt`. Each bundle has a private JSON
manifest recording platform, tag, verified commit SHA, package version, sizes, SHA-256 and SHA-512.
The publisher downloads the bundles into separate directories and validates the exact file sets,
all digests and updater YAML version/references/hashes/sizes (including legacy path/hash fields)
before any GitHub mutation. Bundle JSON is not a public release asset.

The public set is exactly **14 assets** (binary/sidecar names begin `Vocs-Code-X.Y.Z-`):

| Platform | Required public assets |
| --- | --- |
| Windows x64 (3) | `win-x64.exe`, `win-x64.exe.blockmap`, `latest.yml` |
| macOS x64 + arm64 (9) | each architecture's `mac-<arch>.dmg`, `.dmg.blockmap`, `.zip`, `.zip.blockmap`, plus one merged `latest-mac.yml` referencing all four binaries |
| Linux x86_64 (2) | `linux-x86_64.AppImage`, `latest-linux.yml` (the builder's AppImage spelling is `x86_64`, not `x64`) |

One publish job needs **both** all build legs and `verify-tag`, and checks out the same verified
SHA. It requires an existing draft; it never creates a release or generates/replaces human notes.
Before the first upload it appends a hidden `vocs-release-provenance` marker containing the verified
SHA, tag and version. Keep this marker when editing notes. A marker from another SHA is a hard
failure even if `target_commitish` looks correct: that field is not tag provenance. An unmarked
draft must be empty; preexisting assets without provenance are refused.

The publisher can reconcile changed, missing, duplicate or stale assets **only on that marked
draft**. It rechecks tag/SHA, draft identity, provenance and prerelease status before every write.
It compares remote state, size and GitHub's SHA-256 digest; if no digest exists it streams and hashes
the authenticated asset download. After all uploads it freshly lists and verifies the **entire**
remote set before the final `draft: false` PATCH. That is the only public transition. It then reads
back the public set. No asset is uploaded directly from an unpacked build directory.

- **Build or upload interrupted:** leave the draft hidden, fix the transient problem and re-run
  failed jobs in the same run. Accepted uploads/deletes and even a lost final publication response
  are resumable. If bundles expired, a new run must rebuild every platform; changed bytes are safe
  to reconcile only while the release remains a matching marked draft.
- **Draft missing:** create the empty draft as above, then rerun the publisher's failed job.
- **Draft has an `untagged-…` placeholder:** find its current `tagName` with
  `gh release list --json name,tagName,isDraft` and confirm it is the intended empty draft. Attach the existing tag with
  `gh release edit <draft-tag> --tag vX.Y.Z --verify-tag --draft`, then rerun the failed publish job.
- **Tag moved / wrong provenance / invalid bundle:** stop. Do not remove or rewrite the marker,
  re-tag a public version, or bypass the exact-master-CI gate. Fix the source and cut a new version.
- **Already public and identical:** a rerun succeeds read-only: **zero uploads, deletes, or release
  edits**, even if every remote digest needs the streamed fallback.
- **Already public and changed, missing, extra or unverified assets:** refuse with **zero mutations**.
  Public releases are immutable. Use a new version; any exceptional repair needs separate explicit
  authorization and a different procedure. There is **no repair override** in this publisher.

Do not upload/delete assets or publish a draft manually while the workflow owns it. Per-tag Actions
concurrency coordinates this workflow, not external API/UI writers; GitHub has no conditional atomic
compare-and-publish operation. Tag protection and single-writer discipline remain required. Rechecks
fail closed when another writer or a moved tag is observed; they cannot make external writes atomic.

**Qualification:** offline coverage runs the real publisher/client against fake GitHub (exact write
order/count, streamed comparisons, every lost-response mutation boundary, tag movement and immutable
reruns) and the locked builder's real metadata pipeline. Before the next production release, qualify
in an explicitly authorized disposable repository: real Windows/macOS/Linux installer production,
artifact transfers and failed-leg reruns, a hidden interrupted draft/resume, final complete-set
publication, then an identical public rerun and a changed/missing public-asset refusal. Offline tests
do not prove those live GitHub/runner behaviors; never use a production release to qualify repairs.

## Release tag gate

A `v*` tag only produces installers (`release.yml`) and a relay deployment (`deploy-relay.yml`)
when the tagged commit is on `master` **and** the `CI` workflow passed on that exact commit. Both
workflows start with a `verify-tag` job (the reusable `.github/workflows/verify-release-tag.yml`)
that every build and deploy job `needs:`; it has only `actions: read` and `contents: read`. It:

1. Validates the tag name (`vX.Y.Z`, optional pre-release suffix) and resolves it through the API,
   peeling an annotated tag down to its commit. When the run was started from the tag itself, the
   tag must still point at the commit the run started with.
2. Fetches `master`'s commit history (no trees or blobs) and requires the commit to be an ancestor of,
   or equal to, `origin/master`.
3. Lists `ci.yml` runs for that head SHA and accepts only a completed, successful run from a `push`
   to `master` or a `workflow_dispatch`, in which **every** job concluded `success` (a skipped
   release-tier job does not count). Pull-request runs tested a different commit and are ignored.

Build, publish and deploy jobs then check out the verified SHA the gate outputs, not the tag name,
so a tag moved after the check cannot change the code they execute. The publisher also resolves the
tag again before each mutation and refuses a moved tag. In `deploy-relay` the gate runs before the
`relay-production` environment, so approval is only requested for a verified commit; the
environment and its approval are unchanged.

**Waiting policy.** The release commit's master CI run takes about 45 minutes and is usually still
running when the tag is pushed, so the gate polls once a minute for up to 75 minutes (the job times
out at 85). It fails fast when every matching run has already finished without a pass, and waits at
most 10 minutes for a run to appear at all. Each failure says what to do next:

- **CI failed or was cancelled** (a newer push to `master` cancels the in-progress master run):
  re-run it (`gh run rerun <ci run id> --failed`) or start a fresh one on the tag
  (`gh workflow run ci.yml --ref vX.Y.Z` — a dispatch runs the full tier), and once it is green
  re-run the gated workflow's failed jobs (`gh run rerun <run id> --failed`). A real failure is a
  `develop` fix and a new release, not a re-tag.
- **Still running after 75 minutes:** wait for CI to pass, then re-run the gated workflow's failed jobs.
- **Not on master:** the tag points at the wrong commit; tag the release commit on `origin/master`.

**Manual runs go through the same gate.** Dispatch `release` **from that same tag** with a matching
tag input (`gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z`). The build requires the event,
workflow and verified checkout SHA to match, so its signed provenance cannot name a different source;
dispatching from `master` with an older tag input fails before building. The tag gate still applies;
`gh workflow run deploy-relay.yml --ref vX.Y.Z` (the documented redeploy) verifies the tag it was
started from. A redeploy of an older release still passes as long as its CI run has not been deleted.

Limits: a tag workflow runs the workflow file from the tagged commit (and a dispatch the file from the
dispatched ref), so the gate protects releases cut from reviewed code but cannot stop someone with
write access who tags or dispatches a commit whose workflow drops it. The protected `relay-production`
environment's approval remains the human check on the relay.

## Pinned actions

Every `uses:` in `.github/workflows/` is pinned to a full commit SHA with the release it came from
as a trailing comment (`tests/ci-workflow.test.ts` enforces it):

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

To update a pin, resolve the new tag to its commit and replace both the SHA and the comment, in
every workflow that uses the action:

```bash
gh api repos/actions/checkout/git/ref/tags/v4.4.0 --jq '.object.type + " " + .object.sha'
# "tag <sha>" is an annotated tag: peel it to the commit
gh api repos/actions/checkout/git/tags/<sha> --jq '.object.type + " " + .object.sha'
```

Keep the same major version unless the upgrade is the point of the change, and read the release notes
between the two versions before bumping.

## If the release PR or the build didn't start

This repository is hardened: `can_approve_pull_request_reviews` is `false` and `default_workflow_permissions` is `read`. The release-please action therefore does all of its work, pushes the release commit to its branch, and dies on its last step:

```
release-please failed: GitHub Actions is not permitted to create or approve pull requests.
```

Enabling Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"
lets the bot open the version/changelog PR. `RELEASE_PAT`, if configured, is passed to release-please,
but `skip-github-release: true` still prevents it from creating a tag or exposing a release. Keep
creating the tag and empty draft explicitly, as in step 4.

Events made by the default `github-actions` token do not start other workflows. If a tag push did
not start the build, use Actions → **release** → **Run workflow** → select the existing tag as the
workflow ref **and** enter that same tag input (for example `v0.5.0`). The dispatched build and publisher use the same [release tag gate](#release-tag-gate)
and require the precreated draft; dispatch is not a publication or repair bypass.

## Build provenance

Each platform attests its validated bundle bytes using GitHub's keyless OIDC build-provenance action
before the Actions upload. Attestations are stored by GitHub, not added to the 14 release assets;
no publisher private key or certificate is needed. A failed attestation blocks the platform bundle
and therefore publication. Both the workflow source and invocation must be the verified build SHA.

For a release produced by this workflow, download the desired asset and verify it against the exact
release commit (replace the example filename/version and SHA):

```bash
gh attestation verify Vocs-Code-X.Y.Z-win-x64.exe --repo vocsong/VocsCode \
  --signer-workflow vocsong/VocsCode/.github/workflows/release.yml \
  --source-digest <release-commit-sha> --signer-digest <release-commit-sha> \
  --source-ref refs/tags/vX.Y.Z --deny-self-hosted-runners
```

The command hashes the local file and verifies the attestation signature, repository, workflow and
source identity. A filename or unsigned checksum alone proves none of those. Verify updater manifests
and sidecars the same way. Older releases do not retroactively gain attestations. Qualification in
the disposable repository must include a real verification and refusal after changing local bytes;
offline workflow tests do not establish that GitHub issued an attestation.

This proves the workflow's source/build claim, not absence of malicious source or a trusted Windows/
Apple publisher signature. Certificate provisioning and Apple notarization remain deferred by the
maintainer; retain the existing ad-hoc macOS fallback and OS warning guidance below.

## Signatures

No installer is signed with a publisher certificate. Windows SmartScreen and macOS Gatekeeper show first-run warnings — the README tells users how to get past them. Adding signing certificates later doesn't change this flow; it only removes the warnings.

macOS builds are **ad-hoc signed** (`mac.identity: "-"` in `electron-builder.yml`), not notarized. Left unsigned, electron-builder ships the Electron binary's leftover linker signature, which fails `codesign --verify`; Gatekeeper then reports a quarantined download as "damaged and can't be opened" and offers no way past it. An ad-hoc signature is valid, so Gatekeeper shows its ordinary "could not verify" prompt and **Privacy & Security → Open Anyway** works. `hardenedRuntime` is off because, with an ad-hoc identity, its library validation would stop the app launching. Check a local build with `codesign --verify --deep --strict -v "dist/mac-arm64/Vocs Code.app"`.

The real fix is a Developer ID certificate plus notarization: it needs the maintainer's paid Apple Developer account and its credentials as CI secrets, and then `mac.identity` goes back to automatic discovery with `hardenedRuntime` on. Until then, mac auto-update stays best-effort (see [In-app auto-update](#in-app-auto-update)).

## Local sanity check before shipping

```bash
npm run dist:win   # NSIS installer + dist/win-unpacked/
npm run dist:dir   # unpacked only; used with HARNESS_E2E_EXE for packaged e2e suites
```

CI builds mac and linux images that cannot be built on a Windows dev machine — don't hand-edit release artifacts.

## History notes

- **v0.2.0 was bootstrapped by hand** (version bump + CHANGELOG + tag + release created directly, not by the bot): the pre-conventional history isn't parseable, so release-please had nothing to summarize. From v0.3.0 on the bot writes the version bump and changelog — provided ship PRs are rebased (see above) — while the release PR, the tag and the release itself are cut by hand, because of the Actions settings described in [If the release PR or the build didn't start](#if-the-release-pr-or-the-build-didnt-start).
- The first ship PR (#200) was merged with a merge commit, which taught us the rebase rule: the bot saw only "Release: develop into master" and skipped the release entirely.

## In-app auto-update

Packaged builds check GitHub Releases through `electron-updater` at startup and every hour while
open. The feed uses `latest.yml`, `latest-mac.yml` and `latest-linux.yml`, generated with `--publish never`
and exposed together by the complete-set publisher. NSIS differential updates use `.blockmap` files.
The `zip` targets in `electron-builder.yml` supply the macOS updater, and users install from the DMG.
New versions download automatically. Users can check immediately from
**Settings → About & doctor → Check for updates**. Download progress appears beside **Settings** in the
sidebar. Once the download is ready and sessions are idle, **Install update** restarts Vocs Code.
Updates also install on a clean quit for Windows NSIS and Linux AppImage.
macOS installation from the updater is best-effort with the current ad-hoc signature. Reliable macOS
updates require Developer ID signing.

## Later

- Further release-pipeline polish: signing/notarization for mac (and Windows), so auto-update works everywhere.
