# Releasing

How a merged change becomes an installable installer on the [Releases page](https://github.com/vocsong/VocsCode/releases).

## Branch model

- `develop` — integration branch. All PRs land here, squash-merged, with Conventional Commits titles.
- `master` — release gate. Updated only by the ship PR from `develop` and by release-please's release PR. Installers are built from `master` tags.

One-way flow: `develop` → `master` → tag → CI build → GitHub Release. `master` is merged back into `develop` after each release so the version bump doesn't drift.

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

1. Make sure `develop` is green — the latest merged PRs passed the verification bar.
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
3. release-please runs on that push and prepares the release commit (version bump + changelog) on `release-please--branches--master--components--vocs-code`. It cannot open the PR itself (see below), so open it by hand — title `chore(master): release X.Y.Z`, body the new `CHANGELOG.md` section, which the bot has already written to that branch — and rebase-merge it.
4. Push the tag and create the release by hand, so the tag push is a real `push` event that starts the installer build. The `release` workflow builds the installers and attaches them to that release; when it finishes, the release page has the artifacts.

   ```bash
   git tag vX.Y.Z origin/master && git push origin vX.Y.Z
   gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file <the new CHANGELOG section>
   ```
5. Sync back: cherry-pick the release commit onto a branch off `develop` and rebase-merge that PR, so `develop` gets the version bump and changelog. The tree-identity check is what proves the sync carried exactly that commit, and the CI on the PR verifies it.

   ```bash
   git checkout -b <agent>/sync-vX.Y.Z origin/develop
   git cherry-pick <release commit on master>   # no -x: keep the bot's message and authorship
   git diff origin/master HEAD --stat           # must be empty
   git push -u origin <agent>/sync-vX.Y.Z
   gh pr create --base develop --head <agent>/sync-vX.Y.Z --title "chore: sync the vX.Y.Z release commit into develop"
   gh pr merge --rebase
   ```

Steps 3 and 4 are hand-work because two one-time fixes are missing — see the next section.

## If the release PR or the build didn't start

This repository is hardened: `can_approve_pull_request_reviews` is `false` and `default_workflow_permissions` is `read`. The release-please action therefore does all of its work, pushes the release commit to its branch, and dies on its last step:

```
release-please failed: GitHub Actions is not permitted to create or approve pull requests.
```

There is also no `RELEASE_PAT` secret, so a tag pushed by the `github-actions` token would not trigger the build. Two one-time fixes make steps 3 and 4 automatic again:

- **Let Actions open pull requests:** Settings → Actions → General → enable "Allow GitHub Actions to create and approve pull requests".
- **Recommended:** create a fine-grained PAT on this repo with `contents: read/write`, add it as the `RELEASE_PAT` repository secret. The release-please workflow passes it through, so tag pushes trigger the build automatically.

Without them, the fallback for the build alone is Actions tab → **release** → **Run workflow** → enter the tag (`v0.5.0`).

## Signatures

Installers are unsigned. Windows SmartScreen and macOS Gatekeeper show first-run warnings — the README tells users how to get past them. Adding signing certificates later doesn't change this flow; it only removes the warnings.

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

Packaged builds check GitHub Releases themselves through `electron-updater` (issue #198). The feed is
the `latest.yml` / `latest-mac.yml` manifest `--publish always` writes onto each release; NSIS
differential updates ride on the `.blockmap` files, and macOS needs the `zip` targets in
`electron-builder.yml` (the DMG stays the user-facing download). Users can also check manually from
**Settings → About**; the title-bar pill only appears when there is something to act on, and a
restart-to-install prompt is held until every session is out of a live turn. Until a release has
shipped with a signed mac build, mac auto-updates are best-effort (Gatekeeper blocks unsigned
installers); Windows NSIS and Linux AppImage are the supported update paths.

## Later

- Further release-pipeline polish: signing/notarization for mac (and Windows), so auto-update works everywhere.
