# Releasing

How a merged change becomes an installable installer on the [Releases page](https://github.com/vocsong/VocsCode/releases).

## Branch model

- `develop` — integration branch. All PRs land here, squash-merged, with Conventional Commits titles.
- `master` — release gate. Updated only by the ship PR from `develop` and by release-please's release PR. Installers are built from `master` tags.

One-way flow: `develop` → `master` → tag → CI build → GitHub Release. `master` is merged back into `develop` after each release so the version bump doesn't drift.

## Conventions that feed the bot

[release-please](https://github.com/googleapis/release-please) parses commit history on `master` to write `CHANGELOG.md` and pick the next version. It only sees conventional commits, which is why PR titles matter:

| Title prefix | Effect |
| --- | --- |
| `feat:` | minor bump (`0.2.0` → `0.3.0`), listed under Features |
| `fix:`, `perf:` | patch bump (`0.2.0` → `0.2.1`), listed under Bug Fixes |
| `feat!:` or a `BREAKING CHANGE:` footer | major bump |
| `chore:`, `docs:`, `ci:`, `test:`, `refactor:` | no entry, no bump on its own |

The bot reads master's **first-parent history**: it represents each merge commit by its PR title and parses direct commits as-is. That drives two merge rules:

- **Ship PR (`develop` → `master`): "Rebase and merge."** The individual conventional commits from develop land directly on master where the bot can parse them. A merge commit collapses them under one non-conventional PR title and the bot skips the entire ship.
- **Release PR (release-please's `chore(release): vX.Y.Z`): "Rebase and merge"** too, so the changelog commit sits on the first-parent chain.

## Shipping a release

1. Make sure `develop` is green — the latest merged PRs passed the verification bar.
2. Open the ship PR: `develop` → `master`. Merge it with **"Rebase and merge"** (see above for why).
3. release-please opens a `chore(release): vX.Y.Z` PR against `master` with the version bump and changelog. Review the notes, edit the PR description to add lines if you want, rebase-merge it.
4. Merging it pushes the `vX.Y.Z` tag and creates the GitHub Release. The `release` workflow then builds the three installers and attaches them to that release. When the workflow run finishes, the release page has the artifacts.
5. Sync back: open PR `master` → `develop` and merge it, so `develop` gets the version bump and changelog.

Until the first `RELEASE_PAT` secret is configured (below), step 4 does not start by itself — trigger the build manually (see next section).

## If the installer build didn't start

The tag is pushed by the `github-actions` token, and events created by that token do not trigger other workflows. Two ways around it:

- **Recommended one-time fix:** create a fine-grained PAT on this repo with `contents: read/write`, add it as the `RELEASE_PAT` repository secret. The release-please workflow passes it through, so tag pushes trigger the build automatically.
- **Manual trigger:** Actions tab → **release** → **Run workflow** → enter the tag (`v0.2.0`).

## Signatures

Installers are unsigned. Windows SmartScreen and macOS Gatekeeper show first-run warnings — the README tells users how to get past them. Adding signing certificates later doesn't change this flow; it only removes the warnings.

## Local sanity check before shipping

```bash
npm run dist:win   # NSIS installer + dist/win-unpacked/
npm run dist:dir   # unpacked only; used with HARNESS_E2E_EXE for packaged e2e suites
```

CI builds mac and linux images that cannot be built on a Windows dev machine — don't hand-edit release artifacts.

## History notes

- **v0.2.0 was bootstrapped by hand** (version bump + CHANGELOG + tag + release created directly, not by the bot): the pre-conventional history isn't parseable, so release-please had nothing to summarize. From v0.3.0 on, the bot does it all — provided ship PRs are rebased (see above).
- The first ship PR (#200) was merged with a merge commit, which taught us the rebase rule: the bot saw only "Release: develop into master" and skipped the release entirely.

## Later

- In-app auto-update via `electron-updater` is tracked in [#198](https://github.com/vocsong/VocsCode/issues/198). It reads these same GitHub Releases.
