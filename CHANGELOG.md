# Changelog

## [0.4.0](https://github.com/vocsong/VocsCode/compare/v0.3.0...v0.4.0) (2026-09-16)


### Features

* Accept knowledge pages from their row, or all at once ([b1291ee](https://github.com/vocsong/VocsCode/commit/b1291ee55c4c48caaebccb6502066924948259bf))
* Add Ctrl+Shift+N for a new session in the current folder ([#333](https://github.com/vocsong/VocsCode/issues/333)) ([86c805c](https://github.com/vocsong/VocsCode/commit/86c805ce5969416faf7ed02dc4b44bbe226651b0))
* Add the OpenCode Go provider ([d56266c](https://github.com/vocsong/VocsCode/commit/d56266c2da6d38d819efb54761839b8b64333677))
* Allow pin/unpin on archived sessions ([dd9641d](https://github.com/vocsong/VocsCode/commit/dd9641d47fd72d2f09623eee3e7d1efc16171857))
* Automate project knowledge ingestion with labels and a relation graph ([#321](https://github.com/vocsong/VocsCode/issues/321)) ([0f8f092](https://github.com/vocsong/VocsCode/commit/0f8f092984e82f5a6ae115b6b0ad23948cdc5285))
* Check a wiki page's anchors against GitNexus when it opens ([aafbeda](https://github.com/vocsong/VocsCode/commit/aafbedaecfaa34be82f003424d8d73cb2dbce06a))
* Create Claude agent definitions from the Subagents panel ([#355](https://github.com/vocsong/VocsCode/issues/355)) ([606d1c6](https://github.com/vocsong/VocsCode/commit/606d1c61b09bade19d7434ddc67ac200f95dfa4a))
* Give pi subagent children the session's MCP tools ([671f036](https://github.com/vocsong/VocsCode/commit/671f036ff5354c0639fde74ef0197ba7b6ab9cbd))
* Give projects a reviewed knowledge wiki every harness can read ([a2386ef](https://github.com/vocsong/VocsCode/commit/a2386efcf23866b2783fe1e9351ab2297dcf202f))
* Give the native loop the app's own MCP client ([7f436ee](https://github.com/vocsong/VocsCode/commit/7f436eef5c77629c23560ba0b82175e1ebb4c422))
* Hand /goal to the harness's own goal command ([#342](https://github.com/vocsong/VocsCode/issues/342)) ([bc770fc](https://github.com/vocsong/VocsCode/commit/bc770fc6ca6b3779515653c66973db3733724207))
* Harden remote access with an audit log and view-only mode ([dbf8c43](https://github.com/vocsong/VocsCode/commit/dbf8c439d1ad496c13ed04dbfb088d59919bd9a3))
* Let agents review drafts and recall past session history ([bedebd6](https://github.com/vocsong/VocsCode/commit/bedebd6cb704bb6306d04b8c7710845a2cd60cd7))
* Let Claude compact its own context instead of spending a turn on /compact ([#343](https://github.com/vocsong/VocsCode/issues/343)) ([780c365](https://github.com/vocsong/VocsCode/commit/780c365f066c5c9d82bc3f1de55f6203cdad4b7a))
* Make relay routing deny-by-default and rate-limited ([65a0408](https://github.com/vocsong/VocsCode/commit/65a04085acebc67af8d17a97d7ea6b825e579ce2))
* Mirror remote transcripts offline under an end-to-end key ([12dd4ef](https://github.com/vocsong/VocsCode/commit/12dd4ef3b4a9ec103c8e7ce416ab457b8d8984fb))
* Move the sidebar session row's pin to the left side ([ccf19ee](https://github.com/vocsong/VocsCode/commit/ccf19ee0824ee0016fe0f4cd4d71e9734c5ad66d))
* Offer an AGENTS.md memory snippet from the MCP panel ([#319](https://github.com/vocsong/VocsCode/issues/319)) ([5c467d5](https://github.com/vocsong/VocsCode/commit/5c467d585fc706ea9a422693b719927d64f51abd))
* Override a Claude built-in from its row in the Models view ([#362](https://github.com/vocsong/VocsCode/issues/362)) ([01c1f48](https://github.com/vocsong/VocsCode/commit/01c1f489f72fa697633a0b9cb7aff15117377090))
* Rebuild the Usage panel as a session analytics dashboard ([#318](https://github.com/vocsong/VocsCode/issues/318)) ([b7c5df8](https://github.com/vocsong/VocsCode/commit/b7c5df8da2c268b7ea3ba516f625c0f91bf9f41a))
* Right-click menus for the sidebar and transcript, with folder removal ([#359](https://github.com/vocsong/VocsCode/issues/359)) ([6ab43c0](https://github.com/vocsong/VocsCode/commit/6ab43c0c9d841a5bfcaa4563526255b9d3c8bfc5))
* Run Claude subagents on the session's model, configurable per agent type ([#354](https://github.com/vocsong/VocsCode/issues/354)) ([5823887](https://github.com/vocsong/VocsCode/commit/58238873e8ab2e214690229bf6b4bac334680ee5))
* Serve the web app at /app on the landing origin ([87afade](https://github.com/vocsong/VocsCode/commit/87afadee297d3cb5e8da0f6770b1b5f380649468))
* Show cache hit rate by harness and by harness × model ([#338](https://github.com/vocsong/VocsCode/issues/338)) ([bf38188](https://github.com/vocsong/VocsCode/commit/bf38188dac522d755bb76209fd3ad3ba14e2760b))
* Show Claude's subagent runs in the Subagents panel ([#344](https://github.com/vocsong/VocsCode/issues/344)) ([c6902c1](https://github.com/vocsong/VocsCode/commit/c6902c10450ddc90e290239383e7ec5ecdc85972))
* Show the goal a harness-owned /goal is working on ([#352](https://github.com/vocsong/VocsCode/issues/352)) ([257ab6e](https://github.com/vocsong/VocsCode/commit/257ab6ec0afea7aff8335611298bafbff65d41ab))
* Show the live session count beside the sidebar title ([#325](https://github.com/vocsong/VocsCode/issues/325)) ([6cf882f](https://github.com/vocsong/VocsCode/commit/6cf882f6e80232e950b6cbfebc950c66adda3324))
* Start issue sessions from the Git panel with a fix template ([#332](https://github.com/vocsong/VocsCode/issues/332)) ([31c50f7](https://github.com/vocsong/VocsCode/commit/31c50f72c4512264e66f130412b7bda6bd78f305))


### Bug Fixes

* Charge each session only for the spend it made itself ([#353](https://github.com/vocsong/VocsCode/issues/353)) ([d9abfc6](https://github.com/vocsong/VocsCode/commit/d9abfc6f62c9a5eb71031f453cba43d52525114f))
* Close the Layer 2 memory defects left open by [#320](https://github.com/vocsong/VocsCode/issues/320) ([#335](https://github.com/vocsong/VocsCode/issues/335)) ([cbfedfb](https://github.com/vocsong/VocsCode/commit/cbfedfb8a5f4de88112ad9c4b4259b68a663eb63))
* Count pi turns when the session stats request fails ([#345](https://github.com/vocsong/VocsCode/issues/345)) ([6d1727c](https://github.com/vocsong/VocsCode/commit/6d1727cca2d1f724cefb39a2c54d4a4a660f3fe2))
* Draw the key icon on the Providers & keys settings row ([#360](https://github.com/vocsong/VocsCode/issues/360)) ([cdcf44b](https://github.com/vocsong/VocsCode/commit/cdcf44b303dcb65ed467fef037330009df1a0b6e))
* Group every sidebar status count beside the wordmark ([4dcacf7](https://github.com/vocsong/VocsCode/commit/4dcacf771df7aba507c00797ac06f3cd05845d40))
* Keep composer input history when switching sessions ([#356](https://github.com/vocsong/VocsCode/issues/356)) ([acdb327](https://github.com/vocsong/VocsCode/commit/acdb327489924e879164181835e5dfc05407392c))
* Keep packaged e2e runs off the live update feed ([#309](https://github.com/vocsong/VocsCode/issues/309)) ([4c685f1](https://github.com/vocsong/VocsCode/commit/4c685f168fad39bb03c4526b32f4e96480dda9ad))
* Keep project knowledge in the project wiki and surface generation failures ([651cca7](https://github.com/vocsong/VocsCode/commit/651cca7a82ecd074c73831f70fb2010a8809bc77))
* Keep the right panel's bottom tab mounted across view changes ([f819752](https://github.com/vocsong/VocsCode/commit/f81975281e648cc8617cbd34aac20b354b863302))
* Keep unpackaged runs off the installed app's profile and identity ([#302](https://github.com/vocsong/VocsCode/issues/302)) ([550dd70](https://github.com/vocsong/VocsCode/commit/550dd70c114dc81961cf7397090f7d83d1d9d7fa))
* Lead the MCP panel with the AGENTS.md snippet card ([#328](https://github.com/vocsong/VocsCode/issues/328)) ([579632a](https://github.com/vocsong/VocsCode/commit/579632a9dc168db1e06506209f8c375b9c02c2c7))
* Offer the app's bundled catalogs on the Pi harness ([ec74824](https://github.com/vocsong/VocsCode/commit/ec7482465e7443389e16f752dfa3da6f470d482d))
* Offer worktree isolation only where a git repository exists ([#358](https://github.com/vocsong/VocsCode/issues/358)) ([378e867](https://github.com/vocsong/VocsCode/commit/378e867f643d08f24572c7747ecb1094279d2ee3))
* Order the sidebar by the user's last message, not agent activity ([#336](https://github.com/vocsong/VocsCode/issues/336)) ([5884cee](https://github.com/vocsong/VocsCode/commit/5884ceea6807338545fd1ca50ab1d70c5032b172))
* Preserve Pi prompts through Windows command shims ([3af686b](https://github.com/vocsong/VocsCode/commit/3af686b6da0c0a4c7851b6b9388bfdf8ad0d3d18))
* Price codex app-server samples at the model that produced them ([#347](https://github.com/vocsong/VocsCode/issues/347)) ([2f68976](https://github.com/vocsong/VocsCode/commit/2f689760e5727ef8fa11c734c7c79bf08bd9fe68))
* Price codex-exec turns so their spend is counted ([#346](https://github.com/vocsong/VocsCode/issues/346)) ([4e4cdb2](https://github.com/vocsong/VocsCode/commit/4e4cdb2d754c6ccb760f5abf0c3425ad485fe9be))
* Re-sync the Branches panel with the remote and mark branches deleted on the server ([6b4edd8](https://github.com/vocsong/VocsCode/commit/6b4edd826eec520d06dc0f8394d4dd58a3cae6f5))
* Record why Claude refused a subagent spawn, and raise the concurrent cap ([#357](https://github.com/vocsong/VocsCode/issues/357)) ([1400333](https://github.com/vocsong/VocsCode/commit/14003330e862f504995d1a11570de391cea1cda1))
* Reprice stored Claude spend the CLI billed at its fallback rates ([#351](https://github.com/vocsong/VocsCode/issues/351)) ([ee2d1ff](https://github.com/vocsong/VocsCode/commit/ee2d1ffee61dfefd0259676c6a0ae24d723e82fd))
* Select the next session when the active one is archived ([428b1a2](https://github.com/vocsong/VocsCode/commit/428b1a29e4aba43a29fcf62d143742e656b8cad9))
* Send the OpenCode Go key as x-api-key on Claude's Anthropic route ([#331](https://github.com/vocsong/VocsCode/issues/331)) ([809f043](https://github.com/vocsong/VocsCode/commit/809f043b023e5965085c3478792652925e2f1acb))
* Ship DeepSeek V4.1 Flash on the DeepSeek provider ([33f6cc2](https://github.com/vocsong/VocsCode/commit/33f6cc28575293a7538fe185e539810e3b645d1d))
* Show the pin only on pinned rows and offer unpin on hover ([#323](https://github.com/vocsong/VocsCode/issues/323)) ([32f4550](https://github.com/vocsong/VocsCode/commit/32f45506ea6a05e4258e3f3ab750de91424680a4))
* Stop a session and close its shells when it is archived ([#361](https://github.com/vocsong/VocsCode/issues/361)) ([f9fb708](https://github.com/vocsong/VocsCode/commit/f9fb70867a7da5304193705356dd3ddf6ed66b77))
* Stop Claude sessions over-reporting spend and output speed ([#341](https://github.com/vocsong/VocsCode/issues/341)) ([c848fbc](https://github.com/vocsong/VocsCode/commit/c848fbc6c5d84e364562ab03efa076e4cdac10bf))
* Stop the memory snippet promising an accept gate for knowledge_propose ([7069596](https://github.com/vocsong/VocsCode/commit/70695964518eed2e6e16a9e3e165d1db53ea95d5))
* Stop the Usage panel double-counting reasoning tokens ([#348](https://github.com/vocsong/VocsCode/issues/348)) ([942e1dc](https://github.com/vocsong/VocsCode/commit/942e1dc0f4d51506847824b28a1a9cfec53afaee))

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
