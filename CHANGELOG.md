# Changelog

## [0.3.0](https://github.com/vocsong/VocsCode/compare/v0.2.0...v0.3.0) (2026-09-14)


### Features

* Add a model argument to Vesta's create_session tool ([#279](https://github.com/vocsong/VocsCode/issues/279)) ([d213e33](https://github.com/vocsong/VocsCode/commit/d213e333f54ebe355977e845c33f6ee878043af9))
* Classify tool failures instead of trusting raw harness error counts ([0fab17b](https://github.com/vocsong/VocsCode/commit/0fab17b96aa2a1b06b49004a72cb03e38d1ece45))
* Confirm the PR review prompt before starting the session ([07493f6](https://github.com/vocsong/VocsCode/commit/07493f655bfd707847f379e63c9fe8721cb18403))
* Guide git setup on the Git tab, with GitHub as the example ([bfb58a3](https://github.com/vocsong/VocsCode/commit/bfb58a32572b2dd5dc4a5f5597ef50d5f7018fc3))
* Improve tool reliability across Pi and native harnesses ([#227](https://github.com/vocsong/VocsCode/issues/227)) ([c9e20ee](https://github.com/vocsong/VocsCode/commit/c9e20eeae353a406d38da60a18c0a5fd976e4afa))
* Let GitNexus run as one shared server or one per repo ([#252](https://github.com/vocsong/VocsCode/issues/252)) ([cccec25](https://github.com/vocsong/VocsCode/commit/cccec2510d98f132ce706ff3fc106b1de43f396f))
* Let the model picker accept a custom model id ([7090d7c](https://github.com/vocsong/VocsCode/commit/7090d7c0a855ace3d10c59a88c0df9a1a3be162c))
* Let the project manage its own subagent definitions ([#295](https://github.com/vocsong/VocsCode/issues/295)) ([93fd60f](https://github.com/vocsong/VocsCode/commit/93fd60f8a1acf1709fa37e0b8f4b05ac7a5309b1))
* Log session lifecycle, failures and renderer crashes with secret redaction ([253d92b](https://github.com/vocsong/VocsCode/commit/253d92bfdc2d1f2eb34d94d008e9cf9086097c8a))
* Name analytics models by provider from the slice key ([966317c](https://github.com/vocsong/VocsCode/commit/966317c784407b84495440f28c4eaf4e2d778150))
* Name models by provider across the picker, header, sidebar and analytics ([940c127](https://github.com/vocsong/VocsCode/commit/940c1277914f800f5dab2eeac29752cefd26a00d))
* Name the native loop's model by provider in its system prompt ([#259](https://github.com/vocsong/VocsCode/issues/259)) ([4712992](https://github.com/vocsong/VocsCode/commit/4712992875e1d2490088e853620663b45a09e726))
* Put the GitNexus off switch on the built-in card of the MCP page ([a37aee3](https://github.com/vocsong/VocsCode/commit/a37aee3011587661ed1b0a8ffc48f660dacc3824))
* Read subagent definitions from the project, not the app ([#292](https://github.com/vocsong/VocsCode/issues/292)) ([4b2020d](https://github.com/vocsong/VocsCode/commit/4b2020d288ede454ce9ac96510da4521f2852534))
* Rename Agatho to Vesta and let it take pasted images ([#272](https://github.com/vocsong/VocsCode/issues/272)) ([34b8681](https://github.com/vocsong/VocsCode/commit/34b8681bd983a9894d94faad4283d05738770b84))
* Run Agatho on pi and anchor its panel to the bottom edge ([#271](https://github.com/vocsong/VocsCode/issues/271)) ([ee9d013](https://github.com/vocsong/VocsCode/commit/ee9d0135344fc87bea7cc95acba18cf5190fe6f0))
* Ship GitNexus scoped to each repo, and bridge MCP into pi ([#246](https://github.com/vocsong/VocsCode/issues/246)) ([3981637](https://github.com/vocsong/VocsCode/commit/3981637b187ea6aa26937c731b83514cfd8c1b2e))
* Show OpenRouter and DeepSeek models for Claude Code ([68740fb](https://github.com/vocsong/VocsCode/commit/68740fb5f1ee1963d00f77c0292c928c94900bc7))
* Show the cache hit rate of each model on the Tokens tab ([dc44f1a](https://github.com/vocsong/VocsCode/commit/dc44f1a1f0afbe7379f36a671bc51a69bbc32d9a))
* Show the harness error rate in the same matrix as the model tables ([#265](https://github.com/vocsong/VocsCode/issues/265)) ([c090793](https://github.com/vocsong/VocsCode/commit/c090793671062f8b658759a0fef04c4e445bcae9))
* simplify the MCP panel workflow ([9be4b1b](https://github.com/vocsong/VocsCode/commit/9be4b1bf455f288cb102ba4ec5637419109c7d0c))
* Start a PR review session from the PR table's new session action ([e69c615](https://github.com/vocsong/VocsCode/commit/e69c6151cc22b55329465202d9379538ec2dfda9))
* Update the app in place from GitHub Releases ([#281](https://github.com/vocsong/VocsCode/issues/281)) ([9c7a61c](https://github.com/vocsong/VocsCode/commit/9c7a61c364e7a88c859989ad32570ac668b9db78))
* Warn that Settings → Pi edits the global pi configuration ([#288](https://github.com/vocsong/VocsCode/issues/288)) ([8fe29ed](https://github.com/vocsong/VocsCode/commit/8fe29ed4dfa55e0426a620b4880a8a6b56ce909b))
* Wire Claude Code to Anthropic-compatible providers ([3d43c57](https://github.com/vocsong/VocsCode/commit/3d43c57c2045d57208f61b1683c13986dae4f494))


### Bug Fixes

* Ask for a git identity before the first commit ([872f744](https://github.com/vocsong/VocsCode/commit/872f744df93598fed0ded340f212827a9050a679))
* Count cached input once in Codex usage ([#278](https://github.com/vocsong/VocsCode/issues/278)) ([dbee77c](https://github.com/vocsong/VocsCode/commit/dbee77c0e98613921926dde63dbe9c9a913a794f))
* Count completed pi turns again ([#238](https://github.com/vocsong/VocsCode/issues/238)) ([35ca17c](https://github.com/vocsong/VocsCode/commit/35ca17c8507a83a3f8ba1902da76c8094f7b8a0b))
* Don't claim local pi package folders are deleted on removal ([#287](https://github.com/vocsong/VocsCode/issues/287)) ([4fdcf34](https://github.com/vocsong/VocsCode/commit/4fdcf34041a5bd0deb4ffe7476223bb41ca7ccfe))
* Keep commits attributed only to Vocs Ong ([05e123a](https://github.com/vocsong/VocsCode/commit/05e123a51ffb9dafc3e8001a287fb7c3f4070d3c))
* Only show the git setup guide before a repository is published ([55c72e6](https://github.com/vocsong/VocsCode/commit/55c72e6af0403fb42472fee6883f456e4e70b963))
* Order the pi system prompt tabs System, Append, Agent ([fb3274a](https://github.com/vocsong/VocsCode/commit/fb3274a654724fbfe7975f4b15f8200c439b5f5a))
* Publish live Claude and Pi usage updates ([#283](https://github.com/vocsong/VocsCode/issues/283)) ([5428b53](https://github.com/vocsong/VocsCode/commit/5428b53a29ecb186aed71dc4dfb2334d7b82b694))
* Read OpenRouter reasoning effort from the live catalog ([#247](https://github.com/vocsong/VocsCode/issues/247)) ([104f81b](https://github.com/vocsong/VocsCode/commit/104f81bd876ca94d917452714b697ca908f4ec2b))
* Repair Codex cached-input double-count in recorded analytics ([054f592](https://github.com/vocsong/VocsCode/commit/054f592b4f6a2c7394eafdfa1d4e1f72b4a71369))
* Show minimize, not close, on Vesta's collapse control ([#276](https://github.com/vocsong/VocsCode/issues/276)) ([3d3a1a7](https://github.com/vocsong/VocsCode/commit/3d3a1a7f42665c2d637098d73f1c6d49658606a2))
* Start the shared GitNexus server on Windows and show its tools to pi ([ce9c3fd](https://github.com/vocsong/VocsCode/commit/ce9c3fdd39f9587ea45148d5e3d79df8266c0fb6))
* Stop Codex from starting a second GitNexus server beside the shared one ([b7dc835](https://github.com/vocsong/VocsCode/commit/b7dc8350bb7a30600a8b9c8ec89d3f0d24805cf7))
* Stop stale and leaked subagent runs from looking live ([#293](https://github.com/vocsong/VocsCode/issues/293)) ([0048c6b](https://github.com/vocsong/VocsCode/commit/0048c6b374c957b5f8efcb800b1e00246bd97274))
* Treat forcibly terminated and signalled runs as control flow ([3a92676](https://github.com/vocsong/VocsCode/commit/3a9267675da6db037c53e4cdf05af5c91ff84e91))
* Update usage panel during live turns ([#285](https://github.com/vocsong/VocsCode/issues/285)) ([90cce30](https://github.com/vocsong/VocsCode/commit/90cce3018ce70816632198bdf29b396821556a8c))

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
