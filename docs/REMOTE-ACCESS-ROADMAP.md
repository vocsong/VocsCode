# Remote access: what's next (roadmap)

Forward-looking plan for the remote-access track. **[REMOTE-ACCESS.md](./REMOTE-ACCESS.md) is the
design and decisions of record** — this file is the working backlog: what is live, what is not,
what to do next, in what order, and how each piece is verified. Update it as workstreams land;
do not restate the design here.

Last reviewed 2026-09-24 against the deployed relay and the implementation branch, PR #407 (which
completes #394). The first table is **production**; nothing on the branch is live until it is
merged and deployed.

## 1. Status snapshot

### Production (`code.vocs.io`), probed 2026-09-24

| Surface | State | How it was verified |
| --- | --- | --- |
| `code.vocs.io/` | Landing (Astro, `vocs-code` Worker, custom domain) | `curl` 200 |
| `code.vocs.io/app` | Web client SPA, **ungated**, pre-#394 build | `/app/` and `/app/app.js` 200; the bundle still puts `token=` in URLs; no CSP header |
| `code.vocs.io/v1/*` | Relay **predating #394** | `/v1/devices` 401, `/v1/pair/start` 403, `POST /v1/ws/ticket` **404** (the route #394 added) |
| Pairing → handshake → invoke on production | **Not verified live** | the deployed relay predates the protocol the #394 clients speak, so the deployed smoke cannot pass until the branch is deployed |

The earlier failed run of the deployed smoke is explained by that version gap. It may also have
left temporary devices, and the pre-#394 relay minted a new host device on **every** pairing (a bug,
fixed on the branch), so production almost certainly holds orphaned host devices with valid tokens.
Clean both up after deploying: Settings → Remote access lists every device, and **Revoke all**
removes everything but the computer pulling it.

### Implementation branch (PR #407, completing #394)

Every roadmap item below that does not need a credential, a production action or the separate
`vocs.io` repo is implemented and verified: offline suites, the Hub in workerd
(`npm run test:relay-do`), the full flow against the real Worker in local workerd on every
`npm test` (`tests/remote-workerd.test.ts`), and the web app in a real browser (`e2e.remote-web`).

| Roadmap item | Implemented on the branch | Still needs (owner) |
| --- | --- | --- |
| §2.1 Login gate | Landing gate staged disabled in vocs.io #27; the web app shows the account and a separate sign-out | GitHub OAuth app, landing secrets, review/merge #27, enable, live allow/deny/logout check (**user**) |
| §2.2 CI flakes | Timer attribution, analytics recovery, subagent cap race | a green post-merge CI run |
| §2.3 Deploy loop | Protected `deploy-relay` workflow, now also running the local-workerd flow; rollback runbook | `relay-production` secrets, merge vocs.io #26, first workflow run (**user**); `workers_dev: false` after the gate is live and clients use `code.vocs.io` |
| §2.4 Live path testable | Opt-in deployed smoke; the same flow against local workerd in `npm test`; real-browser e2e; 14 workerd DO tests. These found three runtime bugs no fake could (§2.4) | a deploy, then `npm run test:remote-live` against `code.vocs.io` (**user**) |
| §2.5.1 PoP / short-lived tokens | Refresh credential + signed challenge → 1 h access token everywhere; sealed pairing delivery (no plaintext bearer at rest); non-extractable browser keys in IndexedDB with one-way migration | security review of the branch |
| §2.5.2 CSP | Restrictive `_headers` policy, no-store bundle; verified in a real browser with zero violations | assert on the deployed origin |
| §2.5.3 Edge rate limits | Workers Rate Limiting on pairing and token endpoints before the Hub (namespaces 4101–4103) | none beyond deploy |
| §2.5.4 Mirror key lifecycle | Re-keyed whenever a browser that held it loses its pairing (revoke here or elsewhere, kill switch); mirror enable/disable audited | none beyond deploy |
| §2.5.5 `ENROLL_TOKEN` rotation | Enrolled desktops pair with their own credential, so rotation strands no paired computer; runbook rewritten | a production rotation rehearsal (**user**, optional) |
| §2.5 extras | Kill switch (Revoke all), device cap (10 browsers / 5 computers), revoking a desktop cascades to its browsers and drops its mirror, host device reused across pairings, remote push allowlist | — |
| §2.6 QR pairing | In-house QR encoder (no runtime dependency) in Settings; link follows the configured relay | — |
| §2.6 Multi-host UI | Several computers per browser, switcher with live presence, Add a computer, unpair revokes at the relay | — |
| §2.6 Mirror polish | Tail-first transcripts with Load earlier; relay copies of deleted or aged-out sessions removed; per-host catalogue (no blob loads); blobs sized to the 2 MB Durable Object value limit | — |
| §2.6 P3.5 terminal | Read-only first: plain-text terminal view polled while open; nothing typed, resized or attached | read/write: input, streaming output, coalescing, ack windows, snapshot-on-reconnect mid-PTY (next phase) |
| §2.7 Cloud/product | Account-keyed primitives only | separate program by design, not a launch requirement |

**Release verdict: ready for review, not for launch.** Merging needs a security review (auth,
tokens, keys). Launch needs the deploy, a green deployed smoke, the production cleanup above and
the login gate — each an action only the user can take.

## 2. Workstreams

### 2.1 Login gate — the last piece of the decided layout

**Goal.** `code.vocs.io` → login → `/app`, as decided. Today `/app` serves only the pairing
screen (every real call needs a device credential or the enrollment secret), but nothing gates it.

**Blocked on.** A GitHub OAuth app (client id + secret). Everything else is buildable and
mergeable now, dormant until the env vars exist.

**Design.**

- **Session cookie**, no new dependencies: `HMAC-SHA256(SESSION_SECRET)` over `{login, exp}`,
  `HttpOnly; Secure; SameSite=Lax; Path=/`, ~7-day rolling.
- **Routes (landing Worker)**: `GET /login` → 302 to GitHub with signed, browser-bound `state`;
  `GET /auth/callback` → verify state, exchange the code at GitHub, read `api.github.com/user`,
  check the allowlist, set the cookie, 302 `/app`; `POST /logout` → clear and 302 `/`.
  The relay's table only sees paths *under* `/v1` and must not own these browser routes.
- **Gate lives in the landing Worker**, not the relay: `/app` and `/app/*` require a valid session
  → else 302 `/login?next=/app`. `/v1/*` is untouched — the desktop host and paired browsers
  authenticate with their own device credentials, and the relay's route table stays the
  authority on auth.
- **`GET /v1/me`** (session-authed) so the SPA can show the account and offer log out.
- **Env:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, `ALLOWED_LOGINS` on
  the landing Worker. An explicit `AUTH_GATE_MODE=disabled` keeps the pre-activation preview
  behavior; once enabled, missing/invalid config fails closed (503), never silently opens `/app`.
- **Deliberately not per-account.** This gates the single provisioned account; it is an access
  gate, not isolation. Per-account is §2.7.

**Files.** vocs.io `code/worker/index.ts`, `code/wrangler.jsonc`, `code/worker/index.test.mjs`;
`code/src/data/code.ts` keeps copy truthful and `remote.status='in-development'` until the
live gate passes. Vocs-Code's `relay/src/page.ts` offers account sign-out separately from
unpairing. The landing forwards `/v1/*` except `/v1/me` without gating, which covers the relay's
new `/v1/token*`, `/v1/devices/revoke-all` and `/v1/mirrors` routes with no landing change.

**Verification.** Offline Worker tests with injected GitHub fetch cover state, deny, success,
expiry, app/assets and WebSocket pass-through. Test the redirect in the Worker and on a
preview/live origin; OAuth credentials and the live flow remain required before enabling.

### 2.2 Fix the flaky tests first — done on the branch

- `tests/knowledge-anchors.test.ts`: timeout attribution uses the race winner.
- `tests/analytics.test.ts`: asserts the persisted recovery, not a rename count.
- `tests/subagent-extension.test.ts`: waits for all reserved slots before the cap assertion.

Verify CI after merge.

### 2.3 Close the deploy loop

- **Merge vocs.io #26 and `npm run deploy:code`** — the dead `/ws/*` forwarding rule currently
  exists only in the repo; deploying keeps the config and the deployed Worker in step.
- **Relay deploy automation chosen:** `.github/workflows/deploy-relay.yml` on reviewed `develop`
  pushes and explicit dispatch. Before uploading it typechecks, runs the relay suites including the
  full flow against the checkout's own Worker in local workerd, runs the workerd DO suite, checks the
  bundle is current and dry-runs. Provision the protected `relay-production` environment's
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets first; missing credentials fail it.
- **Ship relay and desktop together.** The branch's protocol (access tokens, sealed pairing,
  socket tickets) is incompatible with the deployed relay. Existing pairings survive: their stored
  token becomes their refresh credential, and browsers migrate their keys on the next load.
- **`workers_dev: false`** once login covers `/app` and desktops point at `code.vocs.io` — until then
  the relay is also reachable on `*.workers.dev`, which serves the same code and CSP but no gate.
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
- **The deployed smoke** (`npm run test:remote-live`) runs the same flow against a real origin. It
  must be run after the deploy; until then production is unverified.

### 2.5 Security backlog

All items are implemented on the branch; none is deployed.

1. **Short-lived access tokens + proof of possession.** Pairing gives each device a refresh
   credential that authorizes nothing by itself. A device signs a one-time relay challenge with its
   key for a one-hour access token, which every REST route and the desktop socket require; a browser
   socket needs a 30-second single-use ticket bought with it. The browser's credential is sealed to
   the key it claimed with, so the relay never stores a bearer in plaintext. Browser keys are
   non-extractable CryptoKeys in IndexedDB, and a page with no IndexedDB refuses to pair rather than
   fall back to exportable keys.
2. **CSP on `/app`.** `relay/public/_headers`: restrictive policy, `Cache-Control: no-store` for the
   unversioned bundle. Verified with zero violations in a real browser; assert on the deployed
   origin after deploy.
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

- **Multi-account:** one Hub DO per account (replace the `RELAY_ACCOUNT` env with the session's
  account), per-account enrollment secrets, and the **pairing-ownership** change — codes are minted
  unassigned and bind to an account when a *logged-in* browser claims them. That is what makes
  pairing work for a second human; without it every device shares one registry.
- **Then:** signup/billing, email auth, allowlist onboarding.
- **Model B (cloud workspaces):** sandbox orchestration, headless harness logins, server-side KMS,
  folder sync, metering. Reuses the protocol, web client and auth built above.

## 3. Order of operations

1. **Review and merge #407** (security review: tokens, keys, sealing, revocation). It contains
   #394, which it supersedes.
2. **Provision** `relay-production` secrets; **deploy** the relay (workflow or runbook) and release
   the desktop update together.
3. **Verify live:** Appendix A, then `npm run test:remote-live` against `code.vocs.io`.
4. **Clean up production:** revoke orphaned host devices and smoke leftovers (Settings → Remote
   access; Revoke all if in doubt).
5. **Login gate:** create the OAuth app, review/merge vocs.io #26 and #27, enable, verify live, then
   flip `remote.status`.
6. **`workers_dev: false`** once every desktop points at `code.vocs.io`.
7. **P3.5 read/write terminal.**
8. **2.7**.

## 4. Decisions

| # | Decision | Owner | State |
| --- | --- | --- | --- |
| 1 | Create the GitHub OAuth app (callback `https://code.vocs.io/auth/callback`, scope `read:user`) | user | open |
| 2 | Login scope: access gate on the single account, or per-account isolation now | user | access gate staged; per-account is §2.7 |
| 3 | Relay deploys: CI workflow or manual runbook | — | workflow, with the manual runbook for recovery |
| 4 | Keep `workers.dev` public for debugging | user | keep until login and client migration, then off |
| 5 | QR renderer: a runtime dependency, or code-as-URL only | — | resolved: in-house encoder, no runtime dependency |
| 6 | Device cap | — | ten browsers and five computers per account; change `MAX_WEB_DEVICES` / `MAX_HOST_DEVICES` |

## 5. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Relay and desktop deployed out of step | New clients fail against an old relay (as the first deployed smoke did) | ship together (§2.3); the deploy workflow runs the full flow against its own Worker first |
| Manual relay deploys drift from `develop` | Production runs unreviewed or stale code | §2.3 workflow |
| Orphaned devices in production | Valid tokens for devices nobody holds | §3 step 4 cleanup; the kill switch |
| Single-account login gives no isolation | A second person shares one device registry | §2.7 before inviting anyone |
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
curl -s -o /dev/null -w '%{http_code}\n' "$B/app/"                   # 302 to /login after activation (200 before)
curl -s -o /dev/null -w '%{http_code}\n' "$B/app/app.js"             # 302 to /login after activation (200 before)
curl -s -o /dev/null -w '%{http_code}\n' "$B/v1/devices"             # 401 without an access token
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/v1/pair/start" \
  -H 'content-type: application/json' -d '{"hostPub":{}}'            # 403 without the enroll secret
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/v1/ws/ticket"   # 401 (404 means a pre-#394 relay)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/v1/token/challenge?device=w_x" \
  -H 'authorization: Bearer nope'                                    # 401
curl -sI "$B/app/" | grep -iE '^(x-frame|referrer|x-content|cross-origin|permissions|content-security-policy|cache-control)'
```

After activating login, test the OAuth allowlist, callback, session expiry and logout in a browser,
and confirm a valid cookie serves `/app/` with CSP; unauthenticated assets must still redirect.
Then run `npm run test:remote-live` against the origin (it must execute, not skip).

## Appendix B — deploy runbook

```bash
# Relay (Vocs-Code repo) — normal path: the protected deploy-relay workflow on develop;
# manual recovery only, after the suites and dry-run in relay/README.md
cd relay && npx wrangler deploy
npx wrangler secret put ENROLL_TOKEN          # first setup or rotation; enter the value at its prompt

# Landing + web client (vocs.io repo)
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
| `ENROLL_TOKEN` | relay Worker secret; desktop secret store (`secrets.ts`, safeStorage), entered in `Settings → Remote access` | a desktop's first pairing | [runbook](../relay/README.md#enrollment-secret); paired desktops keep working |
| Device refresh credentials | desktop secret store (`secrets.ts`, safeStorage); browser IndexedDB | buying access tokens, with a device-key signature | revoke the device; re-pair |
| `SESSION_SECRET` | landing `vocs-code` Worker secret (not provisioned) | session and OAuth state signing (§2.1) | invalidates all sessions |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | landing Worker secrets (not provisioned) | GitHub OAuth (§2.1) | rotate in the GitHub app settings |
| `ALLOWED_LOGINS` | landing Worker secret (not provisioned) | who may log in (§2.1) | update and invalidate excluded logins immediately |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | protected GitHub `relay-production` environment secrets (not provisioned) | relay deploy workflow | rotate in the Cloudflare dashboard |

Local development keeps the enrollment secret outside both repos (this machine:
`~/.vocs-code/relay-enroll-token.txt`). Nothing here belongs in a repository, a log or a transcript.

## Appendix D — test map

| Change | Required suites |
| --- | --- |
| Relay routing, auth, tokens, rate limiting (`relay/src/{core,routes,edge,rate}.ts`) | `tests/relay-core.test.ts`, `tests/relay-routes.test.ts`, `tests/relay-edge.test.ts`, `tests/remote-e2e.test.ts`, `tests/remote-workerd.test.ts`, `test:relay-do`, `e2e.remote` |
| Relay frame routing and DO glue (`relay/src/{hub,worker}.ts`) | `test:relay-do`, `tests/remote-workerd.test.ts`; the deployed smoke for rollout |
| Relay web app (`relay/public/app/**`, `relay/src/{page,web-client}.ts`) | `tests/relay-page-layout.test.ts`, `tests/web-client.test.ts`, `tests/browser-socket.test.ts`, `e2e.remote-web` |
| Remote panel, `src/main/remote/**`, device/audit/view-only policy, pairing QR | `e2e.remote`, `tests/remote-host-lifecycle.test.ts`, `tests/remote-audit.test.ts`, `tests/remote-ui.test.tsx`, `tests/qr.test.ts` |
| Deployed relay or landing | Appendix A, authenticated CSP check after login, then `test:remote-live` (must execute, not skip) |
