# Vocs Code

**One desktop app for every coding agent.** Pick your agent — Claude, Codex, Cursor, Pi, DeepSeek, Gemini, or any OpenAI-compatible model — per session, and get the same beautiful interface every time.

## Get started in one line

```bash
git clone https://github.com/vocsong/Vocs-Code.git && cd Vocs-Code && npm run setup
```

That's it. It installs everything (including dev dependencies, even if your environment sets `NODE_ENV=production`) and launches the app with hot reload.

On first launch the app starts with no agent configured — open **Settings → Harnesses** to see which runtimes were detected, install missing ones in one click, and add an API key. Keys are stored in your OS keychain, never in this repository.

## What you get

**Run every agent in one app.** Claude, Codex, Pi, DeepSeek, Gemini CLI, or any OpenAI-compatible model — switch per session, and everything works the same way through one unified interface.

**Your agents can work hands-off.** Pick a permission mode per session — Ask, Accept edits, Plan, Auto, or Full access — and every harness respects it the same way. Dangerous commands always ask first.

**Nothing gets lost.** Threads grouped by project, isolated git worktrees per session, diff review with per-file revert and commit, steer a running turn or queue your next message, `/goal` with an iteration guard.

**Built for long days.** Live model and effort switching, cost and context tracking, a real terminal in the side panel, slash commands and `@file` mentions, and notifications when a turn needs you.

**Private by default.** Keys in your keychain, encrypted at rest. Sessions resume after restart, whatever agent you used.

## Why you'll like it

It takes the best of the Codex and Claude Code desktop apps — threads grouped by project, isolated git worktrees, live multi-session sidebar, diff review with per-file revert and commit, `/goal` with an iteration guard — and makes it all work **across every agent**, not just one. There's even a Doctor page that shows which runtimes you have installed and logged in, so setup never guesswork.

## Documentation

Everything technical lives here:

| Doc | What's in it |
| --- | --- |
| [Architecture & harness reference](docs/ARCHITECTURE.md) | Source layout, harness engines, permission modes, security model |
| [Terminal reference](docs/TERMINAL.md) | PTY handling, shells, tabs, shortcuts, packaging notes |
| [Themes](docs/THEMES.md) | All thirteen themes and how they're built |
| [Testing & verification](docs/TESTING.md) | Dev commands, offline and live test suites |
| [Operations](docs/OPERATIONS.md) | Log locations, environment variables |

## Requirements

Windows 10+/macOS/Linux, Node 22+, npm. Harness runtimes are optional and detected automatically — the app tells you what's missing and installs it for you.

## License

MIT. See [LICENSE](LICENSE).
