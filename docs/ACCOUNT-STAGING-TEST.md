# Vocs account + Hub catalog: staging desktop acceptance

This is an opt-in staging experiment, not a mandatory login gate or persistent account release. Local work remains available signed out. It does not install MCP servers, authorize tools, send coding prompts, run paid providers or change production.

## Targets and boundaries

- Issuer: `https://vocs-login-staging.vocs.workers.dev/api/auth`.
- Catalog: `https://vocs-mcp-staging.vocs.workers.dev/api/connections`.
- Public client: `vocs-code`; PKCE S256; `catalog:read`; callback `http://127.0.0.1:<ephemeral-port>/oauth/vocs`.
- Access is memory-only and expires after at most five minutes. Closing the app clears it. No refresh token, desktop client secret, OS-vault persistence or provider key is part of this slice.
- Catalog visibility is not a tool grant. Even a visible connection must not be installed, connected or invoked automatically.
- No token, authorization code, verifier, cookie, credential or authorization URL should be copied into a screenshot, issue, log attachment or chat. Report safe status and timestamps only.

## Before testing on your PC

1. Use the PR branch in a separate checkout/worktree, preserving your current work. Do not reset or overwrite an existing working directory.
2. Run `npm ci`, `npm run typecheck` and `npm run build`. Run the focused account suites and the new Electron account suite listed in the PR verification record. Do not count skipped tests as a pass.
3. Use an isolated app profile as described in `docs/TESTING.md`; do not overwrite your normal Vocs Code profile. Sign in only with your own already-authorized staging account. Do not enroll a new passkey or create an extra live account merely for a test.
4. No coding prompt is needed. Do not add an OpenRouter key or enable speech/audio execution to validate account sign-in.

## Manual acceptance matrix

| Case | Expected result |
| --- | --- |
| Open the Vocs account settings while signed out | Clearly identified staging environment and session limit; local app remains usable. No browser opens automatically. |
| Explicitly start sign-in | System browser opens the pinned staging issuer, not an embedded login form. Consent names Vocs Code and catalog-only access. |
| Complete sign-in and consent | Loopback completes; safe account/catalog status appears. No raw credential reaches renderer-visible state. |
| Cancel before consent, then finish the stale browser tab | Desktop remains signed out; stale callback cannot sign into a newer attempt. Retry requires a fresh explicit action. |
| Double-click sign-in, navigate away/back while waiting | No duplicate browser authorization, ghost success or abandoned request changing newer state. |
| Sign out during sign-in or catalog loading | Local credentials/catalog clear immediately; late responses do not restore them. Remote revocation failure must not keep the desktop signed in. |
| Refresh catalog | Fetches current account permissions. No tool grant or paid call happens. |
| Account has no Hub permissions | Empty/denied catalog is explained; no automatic provisioning or permission escalation. |
| Wait beyond five-minute expiry | App stops treating cached catalog as authorization and offers explicit sign-in. No silent refresh or persistent-login claim. |
| Disconnect network | Bounded error/retry state, not a spinning permanent wait; local work remains usable. No cached cloud authorization. |
| Restart app | Signed out; previous credentials/catalog do not return from disk. |
| Sign in as another already-authorized account | Old account data is cleared first. Only the new account's catalog appears. Do not create a second live account solely for this check. |
| Light/dark and narrow window | Labels/buttons remain readable, focusable and non-overlapping; cancellation/status is visible. |

An empty catalog may be correct: shared identity and current Hub membership are separate gates. Do not insert live permission rows or bypass admission just to make the screen show a connection.

## If sign-in is refused

Two separate staging databases gate this flow, and either one can refuse it:

- **Identity (Vocs Login staging, D1 `vocs-login-staging`).** Admission needs a live `vocs_invitation` row: not revoked and not past `expires_at`. Invitations expire, so an account that worked last week can be refused today. The issuer then sends `error=access_denied` back to the desktop loopback, and the app shows "Sign-in or catalog access could not be completed" within seconds. Before vocs.io PR 44 the browser stopped on `/login-error` and the app waited out its two-minute timeout. Check with an aggregate-only query, never printing emails: `SELECT datetime(expires_at/1000,'unixepoch'), revoked_at FROM vocs_invitation`. Renewing an invitation is an operator action; scope it to the intended row.
- **Hub (D1 `vocs-mcp-staging-login`).** Sign-in succeeds but the catalog is refused: the app says the account has no staging Hub catalog access. The catalog needs `dashboard:manage` in `hub_login_permission`, and OpenRouter also needs `models:read`. Setting `hub_login_principal.disabled_at` suspends the account without deleting grants.

## What a passing cloud fixture does not establish

Local protocol/IPC/UI tests can validate synthetic callbacks, token isolation, schema checks and races. They do not prove your PC's browser handoff, Windows firewall/loopback behavior, OS accessibility or real-account consent. Cloud Electron launch may be blocked by its Unix-socket environment; if so, the PR stays draft pending the actual PC E2E/visual run. Do not bypass app single-instance or sandbox behavior to claim a real app pass.

Record tested commit, OS, commands, executed test counts and manual outcomes. Screenshots should show safe UI only. Real-device acceptance remains separate from staging issuer/Hub public metadata checks.

## Windows PowerShell quick start

From an existing VocsCode checkout, choose a new worktree path that does not already contain work:

```powershell
git fetch origin voxy/staging-account-catalog
git worktree add ..\vocscode-staging-account --detach FETCH_HEAD
cd ..\vocscode-staging-account
npm ci
$env:NODE_OPTIONS = '--no-experimental-webstorage'
npm run typecheck
npm run build
npx vitest run tests/vocs-account.test.ts tests/vocs-account-settings.test.tsx tests/mcp-oauth.test.ts tests/mcp-oauth-transport-race.test.ts tests/handler-registry.test.ts tests/harness-setup-ipc.test.ts
$env:VOCS_CODE_E2E_UI = '1'
npx vitest run tests/e2e.vocs-account.test.ts tests/e2e.layout.test.ts
Remove-Item Env:VOCS_CODE_E2E_UI
$env:VOCS_CODE_ACCOUNT_REALM = 'staging'
$env:VOCS_CODE_USER_DATA = Join-Path $env:TEMP ('vocs-account-manual-' + [guid]::NewGuid())
npm run preview
```

Open **Settings → Connections → Vocs account**, then **Sign in to staging**. The automated Electron checks intentionally remain signed out and do not open a real authorization request; complete the manual matrix separately. The `VOCS_CODE_USER_DATA` value is a fresh profile, not your installed app's settings. Do not reuse another person's staging session. No Codex/Claude prompt, API key or paid tool call is part of these commands.

The existing owner staging principal was verified against the authenticated GitHub connector identity before receiving only `dashboard:manage` and `models:read` in the isolated Hub staging database. This does not change production access or enable provider execution. Other accounts are not implicitly admitted.
