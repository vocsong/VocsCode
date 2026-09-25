# Conventions

Code, commit and repository conventions for Vocs Code. These moved out of `AGENTS.md`; the working
agreements stay there.

## Language and formatting

- TypeScript strict, ESM, 2-space indent, single quotes, semicolons, trailing commas.
- `@shared/*` (main) and `@renderer/*` (renderer) aliases are configured in `electron.vite.config.ts`
  and the tsconfigs.
- Comments and file headers are short and explanatory; match the existing terse style rather than
  narrating every line.
- Keep platform-specific behavior tested on Windows and POSIX paths; the test suites branch on
  `process.platform` deliberately.

## Commit messages

- Inside a multi-commit PR, messages are imperative sentence case with no prefix
  (`Show the shell's directory in the terminal strip`).
- Only the PR title carries the Conventional Commits prefix
  (`feat: Show the shell's directory in the terminal strip`).
- A one-commit PR must carry that Conventional Commits title on the commit itself, because the squash
  takes the commit subject. See [RELEASING.md](RELEASING.md#conventions-that-feed-the-bot) for why the
  prefix matters and how the ship PR is merged.
- Never append `Co-Authored-By` or "Generated with …" trailers. Every commit is authored and
  committed under the committing person's own git identity (`git config user.name`/`user.email`),
  never a fixed name or an identity override.

## GitHub text

GitHub turns `#` followed by digits into a link to that issue or PR wherever it renders text. That
covers PR titles and descriptions, issue and PR comments, review bodies, inline review comments and
commit messages. It also adds a "mentioned" event to that issue's timeline, and editing the text
afterwards does not remove it. So a review point written as `#3` links to, and leaves a backlink on,
whatever issue or PR 3 happens to be.

- Write `#N` only to reference issue or PR N on purpose (`follow-up to #392`). A closing keyword in
  front of it (`fixes #3`, `closes #3`) also closes that issue once the text lands on `develop`, the
  default branch.
- Refer to numbered points in words: "review item 3", "point 3", "item 3 of the first review". A
  markdown ordered list (`1.`) is fine, because it renders as a list, not a link.
- To show the literal text in a comment, description or review, put it in a code span: `#3` inside
  backticks is not linked. Commit messages are plain text rather than markdown, so leave a hash
  followed by digits out of them entirely unless it is a real reference.
- Before posting, run `grep -n '#[0-9]'` over the body and confirm every hit is an intended reference.
  To see what GitHub actually rendered, read the item's HTML and look for `issue-link` anchors:
  `gh api -H "Accept: application/vnd.github.full+json" <api path> --jq .body_html`.

## What never gets committed

- Build output (`out/`, `dist/`), `node_modules/`, and `tests/artifacts/`.
- API keys or anything read from the OS keychain — not in settings, logs, transcripts, MCP
  definitions, or the repository.

## Development environment

- `NODE_ENV=production` is set in some environments, so a plain `npm install` omits every
  devDependency. If `typecheck`/`test`/`build` report missing modules (`typescript`, `vitest`,
  `@types/node`, `electron-vite`), run `npm install --include=dev`.
