# Changelog

## 0.2.0 (2026-09-13)

Initial public release.

- One desktop app across seven harness adapters — Claude Agent SDK, Codex app-server, Codex exec SDK, Cursor, Pi, ACP, and a native loop — plus DeepSeek and Gemini via OpenAI-compatible endpoints.
- Per-session permission modes (Ask, Accept edits, Plan, Auto, Full access) enforced uniformly across harnesses, with dangerous-command prompting below Full access.
- Threads grouped by project, isolated git worktrees per session, diff review with per-file revert and commit.
- Steer a running turn, queue the next message, `/goal` with an iteration guard, fork a session.
- Live model and effort switching, cost and context tracking, analytics per model and turn.
- Real PTY terminal in the side panel, slash commands, `@file` mentions, notifications when a turn needs you.
- 23 themes; sessions resume after restart for every harness; keys live only in the OS keychain.
- CI-built installers for Windows (NSIS), macOS (dmg, x64 + arm64), and Linux (AppImage).
