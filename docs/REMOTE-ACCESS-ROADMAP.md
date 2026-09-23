# Remote access: what's next (roadmap)

Forward-looking plan for the remote-access track. **[REMOTE-ACCESS.md](./REMOTE-ACCESS.md) is the
design and decisions of record** — this file is the working backlog: what is live, what is not,
what to do next, in what order, and how each piece is verified. Update it as workstreams land;
do not restate the design here.

Last reviewed against the deployed relay and the 2026-09-23 implementation branch. The table below
is **production**, not an assertion that unmerged code is live.

## 1. Status snapshot

Production observations and prior evidence (a previously passing script does not supersede a newer failed smoke):

| Surface | State | How it was verified |
| --- | --- | --- |
| `code.vocs.io/` | Landing (Astro, `vocs-code` Worker, custom domain) | `curl -I` 200, headers |
| `code.vocs.io/app` | Web client SPA, **ungated** | 307 → `/app/` 200, `/app/app.js` 200 |
| `code.vocs.io/v1/*` | Relay REST + WebSockets (`/v1/ws/*`) via service binding | `/v1/devices` 401, `/v1/pair/start` 403 → 200 with the enroll secret, `/v1/ws/host` upgrades |
| Forwarded responses | Origin security policy applied | `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, COOP, `Permissions-Policy` present on `/app/` |
| `vocs-relay` Worker + `Hub` DO | Deployed, `ENROLL_TOKEN` set | prior deploy and HTTP/socket probes; full lifecycle needs a new green smoke |
| Pairing → handshake → invoke → mirror key | **Not currently verified live** | an earlier throwaway script passed, but the new reproducible smoke failed during approve/poll; treat this as red until diagnosed |
| View-only, audit trail, device list/revoke, mirror | Working | `tests/relay-routes.test.ts`, `tests/web-client.test.ts`, `tests/remote-mirror.test.ts`, live checks |

Not live: **login gate**, QR rendering, multi-host UI, terminal over WAN. The landing's
`remote.status` stays `in-development`, so its CTAs are inert. The code-as-URL pairing
fallback, signed login gate (vocs.io [#27](https://github.com/vocsong/vocs.io/pull/27)),
DO-runtime tests, and deploy workflow are under review; **none is a production claim**.
A first run of the new opt-in smoke against the deployed origin timed out after approval;
that is an unresolved live-path failure, not a green verification. It may have minted
untracked temporary devices: inspect/revoke them through an authenticated desktop before
another run. Do not activate login or announce remote access until the failing stage is
diagnosed, repaired, and retested.

### Requirement audit — implementation branch, not release sign-off

| Roadmap item | Implemented locally | Still missing / required proof |
| --- | --- | --- |
| §2.1 Login gate | Dormant landing Worker gate, allowlist, signed cookie/state, sign-out and offline tests in vocs.io #27 | GitHub OAuth app and secrets, enable flag, real allow/deny/logout test, authenticated CSP check; #27 is open |
| §2.2 CI flakes | Timer attribution and analytics recovery regressions pass locally | Green post-merge CI run |
| §2.3 Deploy loop | Protected relay workflow, dry-run/tests/bundle check, rollback runbook | Production environment credentials; workflow run on `develop`; vocs.io #26 merge; direct `workers.dev` bypass migration/shutdown |
| §2.4 Validation | Opt-in deployed smoke with private-capability cleanup recovery and fail-fast claim diagnostics; 8 real-workerd DO tests (including ticket replay and eviction between connections) | Earlier approve/poll failure remains unresolved; identify the deployed contract and rerun green with cleanup; live-socket eviction not proved |
| §2.5 Security | Role-bound sockets, host-signed/serialized pairing approval, private poll, REST bearer headers and hashed single-use 30-second browser upgrade tickets, replay checks, bounded queues, transaction-safe revocation and malformed-frame filtering, a browser socket OPEN queue, static CSP and a manual enrollment-secret rotation runbook **in this branch** | PoP/short-lived device tokens, non-extractable browser keys, mirror-key rotation, account-wide kill, device cap, edge rate limits and live CSP/secret-rotation verification; security review |
| §2.6 UX | Desktop copyable URL + browser prefill, distinct account sign-out | QR renderer/approval, multi-host UI, mirror pagination/cleanup, WAN terminal |
| §2.7 Cloud/product | Account-keyed primitives only | Multi-account ownership/isolation and cloud workspaces remain a separate program, not launch requirements |

**Release verdict: blocked.** `GOAL_COMPLETE` requires the missing roadmap deliverables and
required live verification, not just a passing offline suite. Do not merge or advertise a gate
or remote access based on this branch's tests alone.

## 2. Workstreams

### 2.1 Login gate — the last piece of the decided layout

**Goal.** `code.vocs.io` → login → `/app`, as decided. Today `/app` serves only the pairing
screen (every real call needs a device token or the enrollment secret), but nothing gates it.

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
  authenticate with the enrollment secret and device tokens, and the relay's route table stays the
  authority on auth.
- **`GET /v1/me`** (session-authed) so the SPA can show the account and offer log out.
- **Env:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, `ALLOWED_LOGINS` on
  the landing Worker. An explicit `AUTH_GATE_MODE=disabled` keeps the pre-activation preview
  behavior; once enabled, missing/invalid config fails closed (503), never silently opens `/app`.
- **Deliberately not per-account.** This gates the single provisioned account; it is an access
  gate, not isolation. Per-account is §2.7.

**Files.** vocs.io `code/worker/index.ts`, `code/wrangler.jsonc`, `code/worker/index.test.mjs`;
`code/src/data/code.ts` keeps copy truthful and `remote.status='in-development'` until the
live gate passes. Vocs-Code's
`relay/src/page.ts` offers account sign-out separately from unpairing. The relay route table
still owns enrollment/device auth; the landing forwards `/v1/*` except `/v1/me` without gating.

**Verification.** Offline Worker tests with injected GitHub fetch cover state, deny, success,
expiry, app/assets and WebSocket pass-through. The Electron `e2e.remote` suite drives the
*desktop panel*, not the landing Worker, so it cannot assert the gate redirect; test that in the
Worker and preview/live origin. OAuth credentials and live flow remain required before merging.

**Size.** 1–2 sessions.

### 2.2 Fix the flaky tests first

Two `develop` tests fail intermittently on CI; they cost reruns on every PR.

- **`tests/knowledge-anchors.test.ts`** — a real race, not slowness: `withinBudget()` resolves the
  `null` fallback and the caller then re-checks the clock with `spent()`, so a timer firing a hair
  early reports *"not indexed"* instead of *"ran out of time"*. Fix: return `{ value, timedOut }`
  from `withinBudget` and branch on the flag.
- **`tests/analytics.test.ts`** — asserts `rename` called **once**, gets **twice** under load
  (retry path). Assert the recovered outcome instead of the call count.

**Implemented locally:** timeout attribution now uses the race winner, with a regression
for a clock that still reads before the deadline; analytics asserts persisted recovery and
exactly one recorded call instead of a fragile rename count. A third suite flake surfaced in
`tests/subagent-extension.test.ts`: its cap assertion raced four unawaited starters and could
itself become a never-ending run; the test now waits for all eight reserved slots first.
`npm test` subsequently passed 1912 tests/78 opt-in skips. Verify CI after merge.

### 2.3 Close the deploy loop

- **Merge vocs.io #26 and `npm run deploy:code`** — the dead `/ws/*` forwarding rule currently
  exists only in the repo; deploying keeps the config and the deployed Worker in step.
- **Relay deploy automation chosen:** `.github/workflows/deploy-relay.yml` on reviewed `develop`
  pushes and explicit dispatch, with workerd/socket tests and bundle checks before upload.
  Provision the protected `relay-production` environment's `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` secrets before merging; missing credentials fail the workflow.
  `relay/README.md` and [OPERATIONS.md](./OPERATIONS.md) cover manual recovery/rollback.
- **`workers_dev: false`** once login covers `/app` — until then the relay is also reachable on
  `*.workers.dev`. A static-assets CSP is included locally for both origins, but disabling
  the bypass still requires migrating existing desktop/browser relay URLs and live gate checks.
- Record the runbook in `relay/README.md` and [OPERATIONS.md](./OPERATIONS.md).

### 2.4 Make the live path testable (highest ROI)

The Durable Object tag bug — pairing requests never reaching the desktop — passed **every** local
suite, because `tests/fake-relay.ts` iterates its socket map instead of matching tags. A throwaway
script against the deployed Worker found it in one run.

- **Opt-in smoke added:** `tests/smoke.remote-live.test.ts` exercises mint → claim → approve →
  handshake → invoke → mirror key → revoke, using a token file outside the repo and bounded
  cleanup. It is excluded from `npm test` and documented in [TESTING.md](./TESTING.md).
  Private-capability recovery can revoke a browser whose approved poll response was lost; a
  stale claim response now fails before blaming desktop delivery. **The first deployed-origin
  run failed during approve/poll**; investigate and rerun before
  any production claim. The pre-branch relay returned no claim capability or owner public keys,
  which would fail this newer protocol even earlier; the deployed SHA was not established, so
  that difference does not explain the earlier observed stage. A local workerd pass is not
  proof of the deployed version.
- **Real DO suite added:** `npm run test:relay-do` uses `@cloudflare/vitest-pool-workers` to
  exercise pairing fan-out, exact tags, routing, queue bounds and concurrent ticket consumption
  in CI. Eviction tests run between connections; forced eviction while live sockets remained
  attached timed out in the test pool, so live-socket hibernation still needs deployment
  verification.

### 2.5 Security backlog (ranked)

**Review found launch blockers ahead of token lifecycle:** a web device token could upgrade as
`host` (a role escalation; fixed locally by kind checking), any host could resolve any pending
code without a desktop signature, anyone holding an approved code could poll for a bearer token,
and a host could fill unbounded `q:<id>` storage for arbitrary destinations (locally bounded).
Also, encrypted invoke frames were accepted again on replay (locally rejected by per-peer inbound
counters), and a concurrent last-seen write could resurrect a revoked device (locally moved into
a single storage transaction with token validation). These are security changes, not mere UX; require review, DO tests and a green deployed
smoke before shipping. The design doc's non-extractable browser key and short-lived-token language
is a target, **not** the current `localStorage`/long-lived bearer implementation.
A further browser-only launch blocker was found: the page sent its initial `hello` while the
native WebSocket was still CONNECTING. The transport now buffers those frames until OPEN;
tests reproduce the browser's pre-OPEN exception. This is **local**, not deployed proof.

1. **Short-lived access tokens + proof-of-possession.** The browser device token remains a
   long-lived bearer in `localStorage`, able to authorize REST calls without the device key.
   This branch replaces its WebSocket query-string use with a 30-second, hashed, single-use
   ticket: `POST /v1/ws/ticket` authenticates via the bearer header and atomically replaces
   any outstanding ticket for that browser; a valid upgrade consumes it transactionally.
   Bearer URLs fail closed. This limits URL exposure, **not** stolen-bearer access or the
   current production version; the ticket path still needs security review and a green live
   smoke. Shorter access tokens alone do not fix storage: the *refresh* token must be bound
   to the device key (a relay challenge the device signs). The approved pairing poll also
   keeps the new browser bearer in a short-lived plaintext relay record; bind its delivery
   to the claimant without persisting the plaintext bearer before describing relay storage
   as hashes-only.
2. **CSP on `/app`.** `relay/public/_headers` now specifies a restrictive policy and
   `Cache-Control: no-store` for the unversioned static bundle locally; assert both on live
   origins after deployment. An XSS can still read the browser's current localStorage
   bearer/key until §2.5.1 migrates them.
3. **Edge rate limiting** (Cloudflare rules) in front of the in-memory limiter, which only guards a
   single isolate.
4. **Mirror key lifecycle.** Revoking a device does not rotate the mirror key, and mirror
   enable/disable is not audited. Decide the rotation story before inviting anyone else.
5. **`ENROLL_TOKEN` rotation.** Account-wide and long-lived; the manual
   [rotate-and-repair runbook](../relay/README.md#enrollment-secret-rotation) now covers every
   paired desktop and distinguishes rotation from revocation. It still needs an authorized
   production rehearsal and cleanup verification before it is a proven operational path.

### 2.6 Remote feature completion

- **QR pairing.** The code-as-URL fallback is implemented locally: the desktop shows a copyable,
  expiring `https://code.vocs.io/app?code=…` link and the browser validates/prefills it without
  auto-claiming. A real QR renderer still needs a runtime-dependency decision/approval.
- **Multi-host UI.** The web client stores one paired host; needs pairing a second desktop, a host
  switcher, and per-host online/offline state.
- **Mirror polish.** Tail-first pagination (long transcripts still replay whole), cleanup when a
  session is deleted, and a look at the O(sessions)-per-write prune.
- **P3.5 terminal over WAN.** Read-only first, then read/write: coalescing, larger ack windows,
  snapshot-on-reconnect mid-PTY.

### 2.7 Productization / cloud track (separate program)

- **Multi-account:** one Hub DO per account (replace the `RELAY_ACCOUNT` env with the session's
  account), per-account enrollment secrets, and the **pairing-ownership** change — codes are minted
  unassigned and bind to an account when a *logged-in* browser claims them. That is what makes
  pairing work for a second human; without it every device shares one registry.
- **Then:** signup/billing, email auth, allowlist onboarding.
- **Model B (cloud workspaces):** sandbox orchestration, headless harness logins, server-side KMS,
  folder sync, metering. Reuses the protocol, web client and auth built above.

## 3. Order of operations

```
2.2 flaky tests ──┬─▶ 2.1 login gate ──┬─▶ deploy code + flip remote.status ──▶ 2.6 QR / multi-host
                  │                     │
                  ├─▶ 2.4 live smoke ◀──┘ (verify the gate live)
                  │
                  └─▶ 2.3 deploy loop ──▶ 2.5 security backlog ──▶ 2.7 cloud track
```

1. **2.2** — unblocks every merge.
2. **2.1** — build dormant, in parallel with creating the OAuth app.
3. **2.5 launch blockers + 2.4** — review, run workerd and deployed smoke; resolve the
   currently failing approval/poll stage before activation.
4. **2.3** — provision the protected deploy environment, review/merge vocs.io #26 and #27,
   provision GitHub OAuth, enable the gate, deploy `code`, verify live, then flip `remote.status`.
5. **2.5** token/key lifecycle and `workers_dev: false` after migrating direct-origin clients.
6. **2.6** QR renderer/multi-host/mirror/terminal after the access boundary is sound.
7. **2.7**.

## 4. Open decisions

| # | Decision | Owner | Recommendation |
| --- | --- | --- | --- |
| 1 | Create the GitHub OAuth app (callback `https://code.vocs.io/auth/callback`, scope `read:user`) | user | Do it now so the gate can be activated the day it merges |
| 2 | Login scope: access gate on the single account, or per-account isolation now | user | Access gate implemented dormant; per-account remains §2.7 |
| 3 | Relay deploys: CI workflow or manual runbook | chosen locally | Workflow plus manual recovery; protected environment credentials still needed |
| 4 | Keep `workers.dev` public for debugging | user | Keep until login and client-origin migration, then off |
| 5 | QR renderer: add a small dependency, or code-as-URL only | user | URL fallback implemented without a new runtime dependency; QR image awaits decision |

## 5. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| CI flakiness | Every merge is a coin flip | §2.2 first |
| Manual relay deploys drift from `develop` | Production runs unreviewed or stale code | §2.3 |
| DO glue / deployed behavior drift | Shipped bugs (one already), new smoke failure | §2.4 workerd suite plus deployed smoke before activation |
| Unsigned pairing approval and public token poll | Code or wrong host can bypass the intended pairing authority | §2.5 launch blockers and regression tests |
| Single-account login gives no isolation | A second person shares one device registry | §2.7 before inviting anyone |
| Long-lived bearer device token + no CSP | XSS on the app origin takes over a device | §2.5 items 1–2 |
| `ENROLL_TOKEN` never rotated | A leaked secret keeps minting pairing codes | §2.5 item 5 |

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
curl -s -o /dev/null -w '%{http_code}\n' "$B/v1/devices"             # 401 without a device token
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/v1/pair/start" \
  -H 'content-type: application/json' -d '{"hostPub":{}}'            # 403 without the enroll secret
curl -sI "$B/app/" | grep -iE '^(x-frame|referrer|x-content|cross-origin|permissions|content-security-policy)'  # security headers
```

After activating login, test the OAuth allowlist, callback, session expiry and logout in a
browser, and confirm a valid cookie serves `/app/` with CSP; unauthenticated assets must still
redirect. WebSocket and full pairing are covered by the smoke suite (§2.4); the manual equivalent is
`wss://code.vocs.io/v1/ws/host?device=enrolling` with the enrollment secret as a bearer token
(opens), and a bad token (refused 401).

## Appendix B — deploy runbook

```bash
# Relay (Vocs-Code repo) — normal path: protected deploy-relay workflow on develop;
# manual recovery only, after the suite and dry-run in relay/README.md
cd relay && npx wrangler deploy
npx wrangler secret put ENROLL_TOKEN          # first setup or rotation; reads the value from stdin

# Landing + web client (vocs.io repo)
npm run deploy:code                            # builds the Astro landing and deploys vocs-code

# Regenerate the web-client bundle after editing relay/src/page.ts (Vocs-Code repo)
npm run relay:page
```

Gotchas:

- **Never kill a `wrangler` process.** A forced kill mid-write zero-fills
  `%APPDATA%\xdg.config\.wrangler\config\default.toml`, after which every API-backed command fails
  with `Invalid TOML document`; recovery is `npx wrangler login`.
- `wrangler deploy --dry-run` validates config and bundling without uploading — useful when a
  change touches `run_worker_first` or bindings.
- The relay's `workers.dev` origin stays up until §2.3's switch; both origins serve the same code.

## Appendix C — secret inventory

| Secret | Where | Used by | Rotation |
| --- | --- | --- | --- |
| `ENROLL_TOKEN` | relay Worker secret; desktop keychain (`Settings → Remote access`) | desktop requesting pairing codes | manual; every desktop re-enters it (§2.5.5) |
| `SESSION_SECRET` | landing `vocs-code` Worker secret (not provisioned) | session and OAuth state signing (§2.1) | invalidates all sessions |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | landing Worker secrets (not provisioned) | GitHub OAuth (§2.1) | rotate in the GitHub app settings |
| `ALLOWED_LOGINS` | landing Worker secret (not provisioned) | who may log in (§2.1) | update and invalidate excluded logins immediately |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | protected GitHub `relay-production` environment secrets (not provisioned) | relay deploy workflow | rotate in the Cloudflare dashboard |

Local development keeps the enrollment secret outside both repos (this machine:
`~/.vocs-code/relay-enroll-token.txt`). Nothing here belongs in a repository, a log or a transcript.

## Appendix D — test map

| Change | Required suites |
| --- | --- |
| Relay routing, auth, rate limiting (`relay/src/{core,routes,rate}.ts`) | `tests/relay-core.test.ts`, `tests/relay-routes.test.ts`, `tests/remote-e2e.test.ts`, `test:relay-do`, `e2e.remote` |
| Relay web app layout (`relay/public/app/**`, `relay/src/page.ts`) | `tests/relay-page-layout.test.ts` + `tests/web-client.test.ts` |
| Remote panel, `src/main/remote/**`, device/audit/view-only policy | `e2e.remote` + `tests/remote-audit.test.ts`, `tests/web-client.test.ts` |
| DO glue (`relay/src/worker.ts` WebSocket lifecycle, tags) | `npm run test:relay-do` (workerd); deployed smoke for actual rollout |
| Deployed relay or landing | Appendix A, authenticated CSP check after login, then `test:remote-live` (must execute, not skip) |
