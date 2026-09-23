# Remote access: what's next (roadmap)

Forward-looking plan for the remote-access track. **[REMOTE-ACCESS.md](./REMOTE-ACCESS.md) is the
design and decisions of record** — this file is the working backlog: what is live, what is not,
what to do next, in what order, and how each piece is verified. Update it as workstreams land;
do not restate the design here.

Last updated after the first production deploy (`code.vocs.io` serving the web client).

## 1. Status snapshot

Verified live, not assumed:

| Surface | State | How it was verified |
| --- | --- | --- |
| `code.vocs.io/` | Landing (Astro, `vocs-code` Worker, custom domain) | `curl -I` 200, headers |
| `code.vocs.io/app` | Web client SPA, **ungated** | 307 → `/app/` 200, `/app/app.js` 200 |
| `code.vocs.io/v1/*` | Relay REST + WebSockets (`/v1/ws/*`) via service binding | `/v1/devices` 401, `/v1/pair/start` 403 → 200 with the enroll secret, `/v1/ws/host` upgrades |
| Forwarded responses | Origin security policy applied | `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, COOP, `Permissions-Policy` present on `/app/` |
| `vocs-relay` Worker + `Hub` DO | Deployed, `ENROLL_TOKEN` set | `wrangler deploy`, live smoke below |
| Pairing → handshake → invoke → mirror key | Working end to end | real `RemoteHost` + `RelayClient` through `https://code.vocs.io` (throwaway script; devices revoked after) |
| View-only, audit trail, device list/revoke, mirror | Working | `tests/relay-routes.test.ts`, `tests/web-client.test.ts`, `tests/remote-mirror.test.ts`, live checks |

Not built: **login gate**, QR pairing, multi-host UI, terminal over WAN. The landing's
`remote.status` stays `in-development`, so its CTAs are inert.

## 2. Workstreams

### 2.1 Login gate — the last piece of the decided layout

**Goal.** `code.vocs.io` → login → `/app`, as decided. Today `/app` serves only the pairing
screen (every real call needs a device token or the enrollment secret), but nothing gates it.

**Blocked on.** A GitHub OAuth app (client id + secret). Everything else is buildable and
mergeable now, dormant until the env vars exist.

**Design.**

- **Session cookie**, no new dependencies: `HMAC-SHA256(SESSION_SECRET)` over `{login, exp}`,
  `HttpOnly; Secure; SameSite=Lax; Path=/`, ~7-day rolling.
- **Routes** (relay, added to the deny-by-default table): `GET /login` → 302 to GitHub with a
  signed `state`; `GET /auth/callback` → verify state, exchange the code at
  `github.com/login/oauth/access_token`, read `api.github.com/user`, check the allowlist, set the
  cookie, 302 `/app`; `POST /logout` → clear and 302 `/`.
- **Gate lives in the landing Worker**, not the relay: `/app` and `/app/*` require a valid session
  → else 302 `/login?next=/app`. `/v1/*` is untouched — the desktop host and paired browsers
  authenticate with the enrollment secret and device tokens, and the relay's route table stays the
  authority on auth.
- **`GET /v1/me`** (session-authed) so the SPA can show the account and offer log out.
- **Env:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, `ALLOWED_LOGINS`. Absent →
  gate off, one warning log, dev/preview unaffected.
- **Deliberately not per-account.** This gates the single provisioned account; it is an access
  gate, not isolation. Per-account is §2.7.

**Files.** vocs.io `code/worker/index.ts` (gate + redirect), `code/wrangler.jsonc`
(`run_worker_first` += `/login`, `/auth/*`, `/logout`), `code/src/data/code.ts`
(`remote.status → 'live'` once verified). Relay `src/auth.ts` (new), `src/routes.ts` (routes +
session auth class), `src/worker.ts` (env), `relay/wrangler.jsonc` (secret names in a comment).

**Verification.** Unit tests with an injected `fetch` (state mismatch, denied login, happy path),
route tests for the gate, `tests/e2e.remote.test.ts` gains "gated → redirects to `/login`", then
the live smoke (§2.4) against the real origin.

**Size.** 1–2 sessions.

### 2.2 Fix the flaky tests first

Two `develop` tests fail intermittently on CI; they cost reruns on every PR.

- **`tests/knowledge-anchors.test.ts`** — a real race, not slowness: `withinBudget()` resolves the
  `null` fallback and the caller then re-checks the clock with `spent()`, so a timer firing a hair
  early reports *"not indexed"* instead of *"ran out of time"*. Fix: return `{ value, timedOut }`
  from `withinBudget` and branch on the flag.
- **`tests/analytics.test.ts`** — asserts `rename` called **once**, gets **twice** under load
  (retry path). Assert the recovered outcome instead of the call count.

**Do this before anything else** — every later workstream lands as a PR.

### 2.3 Close the deploy loop

- **Merge vocs.io #26 and `npm run deploy:code`** — the dead `/ws/*` forwarding rule currently
  exists only in the repo; deploying keeps the config and the deployed Worker in step.
- **Relay deploys are manual.** A merged relay change is not live until someone runs
  `cd relay && npx wrangler deploy`. This already bit us once: the DO tag fix was live before its
  PR merged. Choose: a workflow (`.github/workflows/deploy-relay.yml`, push to `develop` touching
  `relay/**`, `CLOUDFLARE_API_TOKEN` secret) or a written manual runbook (Appendix B).
- **`workers_dev: false`** once login covers `/app` — until then the relay is also reachable on
  `*.workers.dev`, without the origin's security headers.
- Record the runbook in `relay/README.md` and [OPERATIONS.md](./OPERATIONS.md).

### 2.4 Make the live path testable (highest ROI)

The Durable Object tag bug — pairing requests never reaching the desktop — passed **every** local
suite, because `tests/fake-relay.ts` iterates its socket map instead of matching tags. A throwaway
script against the deployed Worker found it in one run.

- **Promote that script** to `tests/smoke.remote-live.test.ts`: opt-in (`REMOTE_LIVE=1` plus a
  token file path), excluded from `npm test` like the other opt-in tiers, documented in
  [TESTING.md](./TESTING.md). It covers mint → claim → approve → handshake → invoke → mirror key →
  revoke against any origin, and cleans up the devices it creates.
- **Deeper fix:** `@cloudflare/vitest-pool-workers` (a new devDependency) to exercise `Hub`'s
  WebSocket lifecycle, tags and hibernation in CI. Until then, treat any DO-glue change as
  unverified by local suites.

### 2.5 Security backlog (ranked)

1. **Short-lived access tokens + proof-of-possession.** Today's device token is a long-lived
   bearer in `localStorage` and rides the WebSocket query string. Shorter tokens alone do not fix
   it — the *refresh* token is what sits in storage, so the refresh must be bound to the device key
   (a relay challenge the device signs).
2. **CSP on `/app`.** None today, on the landing or the forwarded app; an XSS there can read the
   device token. See the note in `code/public/_headers`.
3. **Edge rate limiting** (Cloudflare rules) in front of the in-memory limiter, which only guards a
   single isolate.
4. **Mirror key lifecycle.** Revoking a device does not rotate the mirror key, and mirror
   enable/disable is not audited. Decide the rotation story before inviting anyone else.
5. **`ENROLL_TOKEN` rotation.** Account-wide and long-lived; needs a documented rotate-and-repair
   path (every paired desktop re-enters it).

### 2.6 Remote feature completion

- **QR pairing.** Payload is already `https://code.vocs.io/app?code=…`; needs the app to prefill
  from `?code=`, plus a QR renderer (a runtime-dependency decision — ask first) or the code-as-URL
  fallback.
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
3. **2.3** — merge #26, redeploy `code`; flip `remote.status` once login is verified live.
4. **2.4** — so the next DO bug does not ship.
5. **2.3** automation, then `workers_dev: false`.
6. **2.5**, then **2.6**.
7. **2.7**.

## 4. Open decisions

| # | Decision | Owner | Recommendation |
| --- | --- | --- | --- |
| 1 | Create the GitHub OAuth app (callback `https://code.vocs.io/auth/callback`, scope `read:user`) | user | Do it now so the gate can be activated the day it merges |
| 2 | Login scope: access gate on the single account, or per-account isolation now | user | Access gate now; per-account with §2.7 |
| 3 | Relay deploys: CI workflow or manual runbook | user | Workflow — manual deploys already drifted once |
| 4 | Keep `workers.dev` public for debugging | user | Keep until login lands, then off |
| 5 | QR renderer: add a small dependency, or code-as-URL only | user | Decide with §2.6 |

## 5. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| CI flakiness | Every merge is a coin flip | §2.2 first |
| Manual relay deploys drift from `develop` | Production runs unreviewed or stale code | §2.3 |
| DO glue untested locally | Shipped bugs (one already) | §2.4 |
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
curl -s -o /dev/null -w '%{http_code}\n' "$B/app/"                   # 200 web client
curl -s -o /dev/null -w '%{http_code}\n' "$B/app/app.js"             # 200 bundle
curl -s -o /dev/null -w '%{http_code}\n' "$B/v1/devices"             # 401 without a device token
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/v1/pair/start" \
  -H 'content-type: application/json' -d '{"hostPub":{}}'            # 403 without the enroll secret
curl -sI "$B/app/" | grep -iE '^(x-frame|referrer|x-content|cross-origin|permissions)'  # 5 headers
```

WebSocket and full pairing are covered by the smoke suite (§2.4); the manual equivalent is
`wss://code.vocs.io/v1/ws/host?device=enrolling` with the enrollment secret as a bearer token
(opens), and a bad token (refused 401).

## Appendix B — deploy runbook

```bash
# Relay (Vocs-Code repo) — manual until §2.3 lands
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
| `SESSION_SECRET` | relay Worker secret (planned) | session cookie signing (§2.1) | invalidates all sessions |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | relay Worker secrets (planned) | GitHub OAuth (§2.1) | rotate in the GitHub app settings |
| `ALLOWED_LOGINS` | relay var (planned) | who may log in (§2.1) | edit the var |
| `CLOUDFLARE_API_TOKEN` | CI secret (planned, §2.3) | deploy workflow | rotate in the Cloudflare dashboard |

Local development keeps the enrollment secret outside both repos (this machine:
`~/.vocs-code/relay-enroll-token.txt`). Nothing here belongs in a repository, a log or a transcript.

## Appendix D — test map

| Change | Required suites |
| --- | --- |
| Relay routing, auth, rate limiting (`relay/src/{routes,rate}.ts`) | `tests/relay-routes.test.ts` + `tests/remote-e2e.test.ts`, `e2e.remote` |
| Relay web app layout (`relay/public/app/**`, `relay/src/page.ts`) | `tests/relay-page-layout.test.ts` + `tests/web-client.test.ts` |
| Remote panel, `src/main/remote/**`, device/audit/view-only policy | `e2e.remote` + `tests/remote-audit.test.ts`, `tests/web-client.test.ts` |
| DO glue (`relay/src/worker.ts` WebSocket lifecycle, tags) | **no local coverage** — run the live smoke (§2.4) |
| Deployed relay or landing | Appendix A, then the live smoke |
