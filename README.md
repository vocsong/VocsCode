# Vocs Code

**One desktop app for every coding agent.** Pick your agent — Claude, Codex, Cursor, Pi, DeepSeek, Gemini, or any OpenAI-compatible model — per session, and get the same beautiful interface every time.

[![Download latest](https://img.shields.io/github/v/release/vocsong/VocsCode?sort=semver&label=download)](https://github.com/vocsong/VocsCode/releases/latest)

## Install

Grab the latest installer from [Releases](https://github.com/vocsong/VocsCode/releases/latest) — no Node.js required:

| Platform | File |
| --- | --- |
| Windows 10+ | `Vocs-Code-<version>-win-x64.exe` |
| macOS (Apple silicon) | `Vocs-Code-<version>-mac-arm64.dmg` |
| macOS (Intel) | `Vocs-Code-<version>-mac-x64.dmg` |
| Linux | `Vocs-Code-<version>-linux-x86_64.AppImage` |

Installers are currently unsigned, so expect one first-run prompt: Windows SmartScreen → **More info → Run anyway**; macOS → right-click the app → **Open** the first time.

On first launch the app starts with no agent configured — open **Settings → Harnesses** to see which runtimes were detected, install missing ones in one click, and add an API key. Keys are stored in your OS keychain, never in this repository.

To update, download and install the newer installer from [Releases](https://github.com/vocsong/VocsCode/releases/latest) — it installs over the old one. (In-app auto-update is tracked in [#198](https://github.com/vocsong/VocsCode/issues/198).)

**Prefer to run it from source?** You'll need Node 22+ and npm:

```bash
git clone -b master https://github.com/vocsong/VocsCode.git && cd VocsCode && npm run setup
```

That installs everything (including dev dependencies, even if your environment sets `NODE_ENV=production`) and launches the app in dev mode. `npm run update` later pulls, rebuilds, and relaunches.

## What you get

**Run every agent in one app.** Claude, Codex, Pi, DeepSeek, Gemini CLI, or any OpenAI-compatible model — switch per session, and everything works the same way through one unified interface.

**Your agents can work hands-off.** Pick a permission mode per session — Ask, Accept edits, Plan, Auto, or Full access — and every harness respects it the same way. Dangerous commands always ask first.

**Nothing gets lost.** Threads grouped by project, isolated git worktrees per session, diff review with per-file revert and commit, steer a running turn or queue your next message, `/goal` with an iteration guard.

**Git without the ceremony.** A brand-new folder gets a guided setup — initialize, first commit, and publish to GitHub, one click through the GitHub CLI or step by step on github.com.

**Built for long days.** Live model and effort switching, cost and context tracking, a real terminal in the side panel, slash commands and `@file` mentions, and notifications when a turn needs you.

**MCP where you want it.** Add a server once — globally, or in a repo's `.mcp.json` — and Claude, both Codex adapters and any ACP agent pick it up. Test a server before you rely on it; secrets stay in your keychain, never in the repo.

**Private by default.** Keys in your keychain, encrypted at rest. Sessions resume after restart, whatever agent you used.

## Why you'll like it

It takes the best of the Codex and Claude Code desktop apps — threads grouped by project, isolated git worktrees, live multi-session sidebar, diff review with per-file revert and commit, `/goal` with an iteration guard — and makes it all work **across every agent**, not just one. There's even a Doctor page that shows which runtimes you have installed and logged in, so setup is never guesswork.

## Contributing

Vocs Code is developed agent-first — most changes land via coding agents. Prerequisites: Git, Node 22+, npm.

```bash
git clone https://github.com/vocsong/VocsCode.git && cd VocsCode && npm run setup
```

The default branch is `develop`; all PRs land there. Before opening one, read [AGENTS.md](AGENTS.md) — it sets the working agreements: every change must pass `npm run typecheck`, `npm test`, and `npm run build`; behavior changes need a test that fails before the fix; adapters, permissions, and persistence carry extra coverage rules.

PRs are squash-merged, and titles follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, …) — the squash commit's message is what the release bot parses to write the changelog and pick version bumps. How a merged PR becomes an installer on the Releases page is documented in [Releasing](docs/RELEASING.md).

## Documentation

| Doc | What's in it |
| --- | --- |
| [Architecture & harness reference](docs/ARCHITECTURE.md) | Source layout, harness engines, permission modes, security model |
| [Terminal reference](docs/TERMINAL.md) | PTY handling, shells, tabs, shortcuts, packaging notes |
| [Themes](docs/THEMES.md) | All 23 themes and how they're built |
| [Testing & verification](docs/TESTING.md) | Dev commands, offline and live test suites |
| [Operations](docs/OPERATIONS.md) | Log locations, environment variables |
| [Releasing](docs/RELEASING.md) | Branch model, ship checklist, release-please and CI build pipeline |
| [MCP servers](docs/MCP.md) | Global and per-repo MCP servers: storage, per-harness injection, UI, trust model, phasing |

## Requirements

- **Using the app:** Windows 10+, macOS, or Linux. Agent runtimes (Claude Code, Codex CLI, …) are optional and detected automatically — the app tells you what's missing and installs it for you.
- **From source:** Node 22+, npm, Git.

## License

MIT. See [LICENSE](LICENSE).