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

## What never gets committed

- Build output (`out/`, `dist/`), `node_modules/`, and `tests/artifacts/`.
- API keys or anything read from the OS keychain — not in settings, logs, transcripts, MCP
  definitions, or the repository.

## Development environment

- `NODE_ENV=production` is set in some environments, so a plain `npm install` omits every
  devDependency. If `typecheck`/`test`/`build` report missing modules (`typescript`, `vitest`,
  `@types/node`, `electron-vite`), run `npm install --include=dev`.
