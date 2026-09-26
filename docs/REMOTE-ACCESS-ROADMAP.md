# Remote access: what's next (roadmap)

Forward-looking plan for the remote-access track. **[REMOTE-ACCESS.md](./REMOTE-ACCESS.md) is the
design and decisions of record** — this file is the working backlog: what is live, what is not,
what to do next, in what order, and how each piece is verified. Update it as workstreams land;
do not restate the design here.

Last reviewed 2026-09-25, after #407 (which completes #394) was merged and deployed.

## 1. Status snapshot

### Production (`code.vocs.io`), probed 2026-09-25

| Surface | State | How it was verified |
| --- | --- | --- |
| `code.vocs.io/` | Landing (Astro, `vocs-code` Worker, custom domain) | `curl` 200 |
| `code.vocs.io/app` | Web shell SPA (ungated until the login gate is enabled) | `/app/` and `/app/assets/*` 200; CSP and the security headers arrive through the landing; no `token=` in the bundle |
| `code.vocs.io/v1/*` | Relay from #407, deployed 2026-09-25 by the approved `deploy-relay` run 36033701244 | `/v1/devices` 401, `/v1/pair/start` 403, `POST /v1/ws/ticket` 401, `POST /v1/token/challenge` 401 |
| Pairing → handshake → invoke on production | **Verified live** | `npm run test:remote-live` against `code.vocs.io` executed and passed: pairing, sealed credential, proof-of-possession tokens, handshake, invoke, mirror key, revocation |

Still to clean up (**user**): the pre-#394 relay minted a new host device on **every** pairing, so
production almost certainly holds orphaned host devices with valid credentials, plus any the
earlier failed smoke left. Settings → Remote access lists every device, and **Revoke all** removes
everything but the computer pulling it. Desktops older than #407 cannot reach this relay until they
run the new code; they keep their pairings.

### What #407 delivered

Every roadmap item that does not need a credential, a production action or the separate `vocs.io`
repo is implemented, verified and live. Verification covered the offline suites, the Hub in
workerd (`npm run test:relay-do`), the full flow against the real Worker in local workerd on every
`npm test` (`tests/remote-workerd.test.ts`), the web app in a real browser (`e2e.remote-web`), and
the deployed smoke.

| Roadmap item | Delivered | Still needs (owner) |
| --- | --- | --- |
| §2.1 Login gate | Live on `code.vocs.io`: allowlisted GitHub sessions gate `/app`, own `/v1/me`, and drive Connect with GitHub owner routes | Deploy the per-account relay release and the same `ACCOUNT_ASSERTION_SECRET` on both Workers before adding more users (**user**) |
| §2.2 CI flakes | Timer attribution, analytics recovery, subagent cap race; post-merge CI on `develop` green | — |
| §2.3 Deploy loop | Protected `deploy-relay` workflow, run from release tags with approval; first deploy done; rollback runbook | Deploy this per-account relay release before the landing starts sending account assertions; `workers_dev: false` is part of that rollout |
| §2.4 Live path testable | Deployed smoke passing against production; the same flow against local workerd in `npm test`; real-browser e2e; 14 workerd DO tests. These found three runtime bugs no fake could (§2.4) | — |
| §2.5.1 PoP / short-lived tokens | Refresh credential + signed challenge → 1 h access token everywhere; sealed pairing delivery (no plaintext bearer at rest); non-extractable browser keys in IndexedDB with one-way migration | — |
| §2.5.2 CSP | Restrictive `_headers` policy, no-store bundle; zero violations in a real browser; served on the deployed origin | recheck after the account-assertion landing release |
| §2.5.3 Edge rate limits | Workers Rate Limiting on pairing and token endpoints before the Hub (namespaces 4101–4103) | — |
| §2.5.4 Mirror key lifecycle | Re-keyed whenever a browser that held it loses its pairing (revoke here or elsewhere, kill switch); mirror enable/disable audited | — |
| §2.5.5 `ENROLL_TOKEN` rotation | Enrolled desktops pair with their own credential, so rotation strands no paired computer; runbook rewritten | a production rotation rehearsal (**user**, optional) |
| §2.5 extras | Kill switch (Revoke all), device cap (10 browsers / 5 computers), revoking a desktop cascades to its browsers and drops its mirror, host device reused across pairings, remote push allowlist | — |
| §2.6 QR pairing | In-house QR encoder (no runtime dependency) in Settings; link follows the configured relay | — |
| §2.6 Multi-host UI | Several computers per browser, switcher with live presence, Add a computer, unpair revokes at the relay | — |
| §2.6 Mirror polish | Tail-first transcripts with Load earlier; relay copies of deleted or aged-out sessions removed; per-host catalogue (no blob loads); blobs sized to the 2 MB Durable Object value limit | — |
| §2.6 P3.5 terminal | Read-only first: plain-text terminal view polled while open; nothing typed, resized or attached | read/write: input, streaming output, coalescing, ack windows, snapshot-on-reconnect mid-PTY (next phase) |
| §2.7 Multi-account isolation | Implemented in this change: one Hub DO per GitHub subject, owner-session assertions, per-tenant enrollment binding, same-account claims/polls, and browser vault partitioning; incumbent remains `vocs-v1` | Relay release + landing deployment + shared assertion secret, then onboard allowlisted GitHub users (**user**) |

**Status: gated, multi-account rollout pending.** The GitHub login gate is live, but production still
runs the released single-account relay until this change ships. Do not add other people's GitHub
logins to `ALLOWED_LOGINS` until the per-account relay and landing assertion secret are deployed.

### Web-shell overhaul (in review)

`relay/src/page.ts`'s hand-written DOM page is replaced by a React shell in `src/web/`, built by
plain Vite into the same `relay/public/app/` (`npm run build:web`; the committed bundle and
`relay:page` are gone). It reuses the desktop store and transcript over a capability-gated
transport: sequenced session events with a transcript-page floor, bounded remote responses, a
`desktop:focus` read and push, paged transcripts with Load earlier, offline mirror browsing (via
`MirrorIndex.focus`), and a phone layout with sheets and a sticky composer. Landed so far: the
shared channel manifest (PR 1), sequencing and the frame budget (PR 2), desktop focus (PR 3,
held), the renderer capability core (PR 4, held), the shell (PR 5, held) and the sessions home /
follow-my-computer / approval banner / control sheets (PR 6). The deploy workflow builds the
bundle and checks `relay/public/app/index.html` before the dry-run and the deploy.

## 2. Workstreams

### 2.1 Login gate and account identity

**Login gate: live.** `code.vocs.io/app` redirects signed-out visitors to GitHub OAuth. The landing
Worker checks `ALLOWED_LOGINS`, issues a signed session, and returns `/v1/me` for the signed-in
account. The desktop's **Connect with GitHub** flow and owner computer list are also live.

**This change adds isolation.** The landing maps the stable GitHub numeric user id to an account id
(`vocs-v1` for incumbent id `7744354`; `github:<id>` for others); existing pre-account sessions
require one fresh login. It signs each session-backed `/v1` request with a one-minute HMAC assertion
bound to account, method and pathname. The relay
verifies the assertion, routes to one Hub DO per account, and refuses code claims/polls without the
same signed account. `ENROLL_TOKEN` remains a legacy/manual capability for `vocs-v1`; new accounts
enroll through the signed Connect-with-GitHub grant. The browser vault is partitioned by account.

**Rollout prerequisite.** Provision the same `ACCOUNT_ASSERTION_SECRET` on both Workers and a stable
relay-only `DEVICE_ROUTE_SECRET`; deploy the relay release before the landing code that sends
assertions. Keep the incumbent login mapped to `vocs-v1` so existing devices and mirrors stay in
place. Add other GitHub logins to `ALLOWED_LOGINS` only after both deployments and cross-account
workerd tests pass.

**Design.**

- **Session cookie**, no new dependencies: `HMAC-SHA256(SESSION_SECRET)` over `{login, accountId, exp}`,
  `HttpOnly; Secure; SameSite=Lax; Path=/`, ~7-day rolling. The numeric GitHub subject supplies the account identity; login remains the allowlist key and display name.
- **Routes (landing Worker)**: `GET /login` → 302 to GitHub with signed, browser-bound `state`;
  `GET /auth/callback` → verify state, exchange the code at GitHub, read `api.github.com/user`,
  check the allowlist, set the cookie, 302 `/app`; `POST /logout` → clear and 302 `/`.
  The relay's table only sees paths *under* `/v1` and must not own these browser routes.
- **Gate and account assertion live in the landing Worker**, not the relay: `/app` and `/app/*`
  require a valid session → else 302 `/login?next=/app`. Device-authenticated `/v1/*` still pass
  through without browser login; signed-in requests add a short-lived account assertion, and
  `/v1/pair/claim`, `/v1/pair/poll` and `/v1/owner/*` require it at the relay. Device tokens remain
  the authority for device operations.
- **`GET /v1/me`** (session-authed) so the SPA can show the account and offer log out.
- **Env:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, `ACCOUNT_ASSERTION_SECRET`,
  `ALLOWED_LOGINS` secrets and `LEGACY_GITHUB_USER_ID` setting on the landing Worker. The relay has
  the same `ACCOUNT_ASSERTION_SECRET`. An explicit `AUTH_GATE_MODE=disabled` keeps the pre-activation
  preview behavior; once enabled, missing/invalid config fails closed (503), never silently opens `/app`.
- **Allowlist is not signup.** Each admitted GitHub subject gets an isolated relay account, but
  signup, billing and account recovery remain out of scope. `ALLOWED_LOGINS` still controls access.

**Files.** vocs.io `code/worker/index.ts`, `code/wrangler.jsonc`, `code/worker/index.test.mjs`;
Vocs-Code's `relay/src/page.ts` partitions browser credentials by account and keeps account sign-out
separate from unpairing. `remote.status` remains `in-development` until the account-isolated relay
release is deployed. Desktop `h_` device traffic still authenticates at the relay without a browser
session; `w_` browser-device traffic, claim/poll and owner routes require the landing session.

**Verification.** Landing Worker tests cover numeric GitHub identity, legacy mapping, HMAC assertion
scope, spoofed-header replacement, session-only claim/poll, WebSocket pass-through and anonymous
desktop traffic. Vocs-Code workerd and browser tests prove distinct Hub registries, same-account
claims, and account-partitioned browser state. Staging/live rollout still requires credentials and
owner approval; do not add another login until that check passes.

### 2.2 Fix the flaky tests first — done

- `tests/knowledge-anchors.test.ts`: timeout attribution uses the race winner.
- `tests/analytics.test.ts`: asserts the persisted recovery, not a rename count.
- `tests/subagent-extension.test.ts`: waits for all reserved slots before the cap assertion.

Post-merge CI on `develop` passed (run 36020242688).

### 2.3 Close the deploy loop

- **Landing deploys are coordinated with relay releases.** Deploy the relay's account-assertion
  verifier first, then deploy the vocs.io landing that signs those assertions. `npm run deploy:code`
  updates only the landing; it does not release the Vocs-Code relay.
- **Relay deploys run from release tags — done.** `.github/workflows/deploy-relay.yml` starts on
  the `vX.Y.Z` tag push that also builds the installers (or an explicit dispatch on a tag), and
  publishes after approval in the protected `relay-production` environment, which admits release
  tags only and holds the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. Before
  uploading it typechecks, runs the relay suites including the full flow against the checkout's own
  Worker in local workerd, runs the workerd DO suite, checks the bundle is current and dry-runs.
  Because the production relay follows releases, not `develop`, it always speaks the released
  desktop's protocol ([RELEASING.md](./RELEASING.md#shipping-a-release) step 4).
- **The #407 protocol went live on 2026-09-25, ahead of a release**, by an approved dispatch from
  `develop`: only desktops holding the enrollment secret can use the relay, so the only clients
  affected were the owner's. Desktops older than #407 cannot connect until they run the new code;
  their pairings survive (the stored token becomes the refresh credential), and browsers migrate
  their keys on the next load.
- **`workers_dev: false`** ships with the per-account relay release. It removes the direct
  `*.workers.dev` path so browser account assertions and the GitHub landing gate cannot be bypassed.
  Desktops already connect to `code.vocs.io`; the service binding keeps that origin unchanged.
- Runbooks: `relay/README.md` and [OPERATIONS.md](./OPERATIONS.md).

### 2.4 Make the live path testable

The Durable Object tag bug — pairing requests never reaching the desktop — passed every local suite
when the test relay re-implemented routing. Now:

- **One routing implementation.** `relay/src/hub.ts` is the frame router for both the Durable Object
  and `tests/fake-relay.ts`, which also serves REST through the real route table and whose sockets
  throw on send after close like a Durable Object's. Diverging from the fake is how the host
  re-mint bug (below) hid.
- **The real Worker in every test run.** `tests/remote-workerd.test.ts` starts `relay/wrangler.jsonc`
  in local workerd (`tests/support/local-relay.ts`) and runs the smoke flow over real sockets in
  about four seconds. Running the Worker for real found three bugs no fake could: a refused request's
  unread body ended the `wrangler dev` session (the entry now reads bounded bodies first), revoking a
  connected desktop answered 500 after the revocation committed (fan-out sent to the socket it had
  just closed), and a synchronously rejected auth promise surfaced as unhandled in workerd.
- **A real browser.** `e2e.remote-web` (in `test:e2e:ci`) drives the web app in Electron's Chromium
  against that local relay. Reverting the socket's pre-OPEN queue — the browser bug #394 found by
  hand — turns it red.
- **The deployed smoke** (`npm run test:remote-live`) runs the same flow against a real origin.
  It passed against `code.vocs.io` on 2026-09-25; run it after every relay or landing deploy.

### 2.5 Security backlog

All items are live since 2026-09-25.

1. **Short-lived access tokens + proof of possession.** Pairing gives each device a refresh
   credential that authorizes nothing by itself. A device signs a one-time relay challenge with its
   key for a one-hour access token, which every REST route and the desktop socket require; a browser
   socket needs a 30-second single-use ticket bought with it. The browser's credential is sealed to
   the key it claimed with, so the relay never stores a bearer in plaintext. Browser keys are
   non-extractable CryptoKeys in IndexedDB, and a page with no IndexedDB refuses to pair rather than
   fall back to exportable keys.
2. **CSP on `/app`.** `relay/public/_headers`: restrictive policy, `Cache-Control: no-store` for the
   unversioned bundle. Zero violations in a real browser and served on the deployed origin; recheck
   signed-in app, API and WebSocket paths after the account-assertion landing release.
3. **Edge rate limiting.** Workers Rate Limiting bindings guard `pair/start`, `pair/claim`,
   `pair/poll` and the token endpoints before a request can wake the Hub; the counters survive the
   Hub hibernating, which resets its in-memory limiter. Token endpoints key on device and address.
4. **Mirror key lifecycle.** Revoking a browser (from the desktop, from another browser, or through
   the kill switch) re-keys the mirror: the relay copy is dropped, snapshots re-upload under the new
   key, and still-paired browsers receive it over e2e. Revoking a desktop drops its mirror. Mirror
   enable/disable is audited.
5. **`ENROLL_TOKEN` rotation.** An enrolled desktop starts pairings with its own credential, so the
   secret matters only for a desktop's first pairing and rotation strands no paired computer. See
   [the runbook](../relay/README.md#enrollment-secret).

Found and fixed during this work: every pairing minted a new host device and re-keyed the desktop,
stranding every browser paired before it (the real Hub routes by the greeted host id); the desktop
pushed its whole push stream, including the live pairing code, PTY output and the assistant panel,
to paired browsers (now an allowlist); the pairing link was hard-coded to `code.vocs.io` whatever
relay the desktop used; mirror blobs up to 8 MB could never be written to a 2 MB Durable Object
value, and every mirror write loaded all blobs; claims and pairing starts stored unbounded,
unvalidated names and keys.

### 2.6 Remote feature completion

- **QR pairing — done.** Settings shows the link as a QR code from an in-house encoder
  (`src/shared/qr.ts`). Its tests decode every version and level with `jsqr` (dev-only) and check
  each Reed–Solomon block and the format and version bits exactly.
- **Multi-host UI — done.** A browser keeps a pairing per computer, switches between them, shows
  which are online from the relay's presence, adds computers and unpairs one at a time.
- **Mirror polish — done.** Tail-first transcripts, cleanup of deleted sessions, no O(sessions)
  blob loads per write.
- **P3.5 terminal over WAN — read-only done.** Next: read/write — input, streaming output with
  coalescing, larger ack windows, snapshot-on-reconnect mid-PTY, and whether a remote viewer may
  resize.

### 2.7 Productization / cloud track (separate program)

- **Multi-account isolation — implemented in this change.** The landing's signed GitHub subject
  selects one Hub DO per account; MACed device ids route device-authenticated traffic, Connect with
  GitHub grants bind a desktop nonce to one account through a short-lived directory, and code claims
  and polls require the same signed-in account as the host. Browser vaults are account-partitioned.
  No per-account enrollment secret is needed for this flow; `ENROLL_TOKEN` remains legacy-only for
  `vocs-v1`. Deploy the relay and landing together before admitting another login.
- **Then:** signup/billing, email auth, allowlist onboarding.
- **Model B (cloud workspaces):** sandbox orchestration, headless harness logins, server-side KMS,
  folder sync, metering. Reuses the protocol, web client and auth built above.

## 3. Order of operations

1. ~~Review and merge #407~~ — merged 2026-09-24 (`cd18ac7`); it superseded #394.
2. ~~Provision `relay-production`, deploy~~ — secrets provisioned, approval required; deployed
   2026-09-25.
3. ~~Verify live~~ — Appendix A and `npm run test:remote-live` passed against `code.vocs.io`.
4. **Clean up production:** revoke orphaned host devices and smoke leftovers (Settings → Remote
   access; Revoke all if in doubt), after updating each desktop to the new code.
5. **Per-account rollout:** land the relay and landing changes in their respective `develop`
   branches; provision the same `ACCOUNT_ASSERTION_SECRET` on both Workers and keep
   `LEGACY_GITHUB_USER_ID=7744354`; release/deploy the relay first, then deploy the landing Worker.
   Verify the incumbent still sees its existing devices and a second allowlisted account sees only
   its own before adding further logins.
6. **`workers_dev: false`** is included in the relay config so `/app` and account routes cannot
   bypass the landing gate; verify the deployed hostname is unavailable after the release.
7. **P3.5 read/write terminal.**
8. **Productization:** signup, billing, email auth and account recovery remain deferred.

## 4. Decisions

| # | Decision | Owner | State |
| --- | --- | --- | --- |
| 1 | Create the GitHub OAuth app (callback `https://code.vocs.io/auth/callback`, scope `read:user`) | user | provisioned; gate is live |
| 2 | Login scope: access gate or per-account isolation | user | per-account isolation approved and implemented here; production rollout remains gated |
| 3 | Relay deploys: CI workflow or manual runbook, from which ref | user | workflow from release tags with approval; manual runbook for recovery |
| 4 | Keep `workers.dev` public for debugging | user | disable in the per-account relay release; browsers must pass through the landing |
| 5 | QR renderer: a runtime dependency, or code-as-URL only | — | resolved: in-house encoder, no runtime dependency |
| 6 | Device cap | — | ten browsers and five computers per account; change `MAX_WEB_DEVICES` / `MAX_HOST_DEVICES` |

## 5. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Relay and desktop deployed out of step | Released desktops fail against a newer or older relay (as the first deployed smoke did) | the relay deploys from the release tag (§2.3); the workflow runs the full flow against its own Worker first |
| Production relay drifts from the release | Production runs unreleased or stale code | deploys only from release tags, with approval (§2.3) |
| Orphaned devices in production | Valid tokens for devices nobody holds | §3 step 4 cleanup; the kill switch |
| Relay and landing deploy out of step | A session assertion is rejected, or a release still routes all users to `vocs-v1` | Deploy the relay first, then landing; verify two-account isolation before adding logins |
| XSS on the app origin | Can use (not steal) the browser's keys while the page is open | CSP (§2.5.2); non-extractable keys; one-hour access tokens |
| Leaked enrollment secret | Can request pairing codes (a desktop still approves) | rotate per the runbook; paired desktops are unaffected |

## 6. Non-goals (for now)

Billing and signup, native mobile apps, cloud workspaces (§2.7), and any change to the desktop's
permission ladder — remote access reuses it unchanged.

---

## Appendix A — live verification checklist

Run after any relay or landing deploy:

```bash
B=https://code.vocs.io
curl -s -o /dev/null -w '%{http_code}\n' "$B/"                       # 200 landing
curl -s -o /dev/null -w '%{http_code}\n' "$B/app/"                   # 302 to /login when signed out
curl -s -o /dev/null -w '%{http_code}\n' "$B/app/app.js"             # 302 to /login when signed out
curl -s -o /dev/null -w '%{http_code}\n' "$B/v1/devices"             # 401 without an access token
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/v1/pair/start" \
  -H 'content-type: application/json' -d '{"hostPub":{}}'            # 403 without the enroll secret
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/v1/ws/ticket"   # 401 (404 means a pre-#394 relay)
curl -s -o /dev/null -w '%{http_code}\n' "$B/v1/owner/hosts"        # 401 signed out
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/v1/pair/claim" # 401 without a signed-in account assertion
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/v1/token/challenge?device=w_x" \
  -H 'authorization: Bearer nope'                                    # 401
curl -sI "$B/app/" | grep -iE '^(x-frame|referrer|x-content|cross-origin|permissions|content-security-policy|cache-control)'
```

Test the OAuth allowlist, callback, session expiry and logout in a browser, and confirm a valid
cookie serves `/app/` with CSP; unauthenticated assets and code claims must still be refused. After a
per-account release, run `npm run test:remote-live` against the incumbent account (it must execute,
not skip) and the two-account isolation smoke in staging.

## Appendix B — deploy runbook

```bash
# Relay (Vocs-Code repo) — normal path: the release tag starts the protected deploy-relay
# workflow; approve it in Actions. Redeploy a release: gh workflow run deploy-relay.yml --ref vX.Y.Z
# Manual recovery only, from the release tag's checkout, after the suites and dry-run in relay/README.md
cd relay && npx wrangler deploy
npx wrangler secret put ENROLL_TOKEN          # legacy v1/manual enrollment secret
npx wrangler secret put DEVICE_ROUTE_SECRET   # relay-only; keep stable for existing device ids
npx wrangler secret put ACCOUNT_ASSERTION_SECRET # must match the landing Worker's value

# Landing + web client (vocs.io repo) — deploy only after the relay supports assertions
npx wrangler secret put ACCOUNT_ASSERTION_SECRET -c code/wrangler.jsonc # same value as relay secret
npm run deploy:code                            # builds the Astro landing and deploys vocs-code

# Regenerate the web-client bundle after editing relay/src/page.ts (Vocs-Code repo)
npm run relay:page
```

Gotchas:

- **Never kill a `wrangler` process.** A forced kill mid-write zero-fills
  `%APPDATA%\xdg.config\.wrangler\config\default.toml`, after which every API-backed command fails
  with `Invalid TOML document`; recovery is `npx wrangler login`. Tests start the relay through
  wrangler's programmatic API and stop it with `dispose()` for this reason.
- A running `wrangler dev` holds files under `node_modules` open: stop it before `npm ci`, or the
  install fails with EBUSY and can leave `node_modules` half removed.
- `wrangler deploy --dry-run` validates config and bindings without uploading.
- The relay's `workers.dev` origin stays up until §2.3's switch; both origins serve the same code.

## Appendix C — secret inventory

| Secret | Where | Used by | Rotation |
| --- | --- | --- | --- |
| `ENROLL_TOKEN` | relay Worker secret; the landing holds a copy as `RELAY_ENROLL_TOKEN` | legacy `vocs-v1` manual enrollment and signed owner routes; new accounts use Connect with GitHub | [runbook](../relay/README.md#enrollment-secret); paired desktops keep working |
| `ACCOUNT_ASSERTION_SECRET` | identical secret on landing `vocs-code` and relay `vocs-relay` | signed account assertions | rotate both Workers together; a mismatch fails closed |
| `DEVICE_ROUTE_SECRET` | relay `vocs-relay` only; keep stable | MACed tenant routing hints in new device ids | do not rotate without a versioned device-id migration; it is not an account credential |
| Device refresh credentials | desktop secret store (`secrets.ts`, safeStorage); account-partitioned browser IndexedDB | buying access tokens, with a device-key signature | revoke the device; re-pair |
| `SESSION_SECRET` | landing `vocs-code` Worker secret | session and OAuth state signing (§2.1) | invalidates all sessions |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | landing Worker secrets | GitHub OAuth (§2.1) | rotate in the GitHub app settings |
| `ALLOWED_LOGINS` | landing Worker secret | who may log in (§2.1); each allowed GitHub ID gets a separate account | add/remove login; revoke devices for removed users separately |
| `LEGACY_GITHUB_USER_ID` | landing Worker var (`7744354`) | maps the incumbent GitHub subject to `vocs-v1` | do not change without a data migration |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | protected GitHub `relay-production` environment secrets (not provisioned) | relay deploy workflow | rotate in the Cloudflare dashboard |

Local development keeps both relay secrets outside the repos. The workerd suites generate throwaway
values; never put production values in a repository, command argument, log or transcript.

## Appendix D — test map

| Change | Required suites |
| --- | --- |
| Relay routing, account isolation, auth, tokens, rate limiting (`relay/src/{account,core,routes,edge}.ts`) | `tests/relay-account.test.ts`, `tests/relay-core.test.ts`, `tests/relay-routes.test.ts`, `tests/relay-edge.test.ts`, `tests/remote-e2e.test.ts`, `tests/remote-workerd.test.ts`, `test:relay-do`, `e2e.remote` |
| Relay frame routing and DO glue (`relay/src/{hub,worker}.ts`) | `test:relay-do`, `tests/remote-workerd.test.ts`; the deployed smoke for rollout |
| Relay web app and account-partitioned vault (`relay/public/app/**`, `relay/src/{page,web-client}.ts`) | `tests/relay-page-layout.test.ts`, `tests/web-client.test.ts`, `tests/browser-socket.test.ts`, `e2e.remote-web` |
| Remote panel, `src/main/remote/**`, device/audit/view-only policy, pairing QR | `e2e.remote`, `tests/remote-host-lifecycle.test.ts`, `tests/remote-audit.test.ts`, `tests/remote-ui.test.tsx`, `tests/qr.test.ts` |
| Deployed relay or landing | Appendix A, authenticated CSP check after login, then `test:remote-live` (must execute, not skip) |
