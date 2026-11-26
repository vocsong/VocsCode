# Security policy

## Reporting a vulnerability

Report security issues privately through GitHub: open this repository's **Security** tab and
choose **Report a vulnerability**
([direct link](https://github.com/vocsong/VocsCode/security/advisories/new)). Please do not open
a public issue, discussion or pull request for a suspected vulnerability.

Include what you can of:

- the affected version (Settings → About, or the release tag) or commit, and your OS;
- the component: desktop app, a harness integration, the desktop's relay connection
  (`src/main/remote/`), the relay (`relay/`), the code.vocs.io dashboard (`src/web`), External MCP
  control or the MCP bridge;
- steps to reproduce, ideally the smallest example, with what you expected and what happened;
- the impact you believe it has.

Do not send real API keys, tokens, session cookies or anyone else's data. Test only against
your own installation, accounts and registered computers; no denial-of-service, spam or social
engineering.

## What happens next

You get an acknowledgement through the advisory, usually within a few days, and updates there
while it is investigated. Fixes ship in a normal release; the advisory is published with the
fix and credits you unless you ask otherwise.

## Supported versions

Only the latest release receives security fixes. The app updates itself; please confirm an
issue still reproduces on the latest version.
