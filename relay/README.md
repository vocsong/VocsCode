# Vocs relay

The routing service for Vocs Code remote access (see [docs/REMOTE-ACCESS.md](../docs/REMOTE-ACCESS.md)).
A Cloudflare Worker + one Hub Durable Object per account. It routes opaque end-to-end-encrypted
frames between paired desktops and web clients and holds the pairing registry. It can never
read payload content — it sees routing metadata and ciphertext only.

## Deploy and recovery

`.github/workflows/deploy-relay.yml` deploys the relay with each release. Pushing the `vX.Y.Z` tag
that the installers are built from ([RELEASING.md](../docs/RELEASING.md#shipping-a-release)) starts
it, so production always speaks the protocol of the released desktop. The protected GitHub
environment `relay-production` holds `CLOUDFLARE_API_TOKEN` (an "Edit Cloudflare Workers" token
limited to this account) and `CLOUDFLARE_ACCOUNT_ID`, admits release tags only, and waits for the
owner's approval. The workflow checks the relay types and tests — including the full pairing flow
against this checkout's Worker in local workerd — verifies the generated web bundle and dry-run,
and fails loudly when credentials are absent. Redeploy a release with
`gh workflow run deploy-relay.yml --ref vX.Y.Z`. It does **not** create or rotate `ENROLL_TOKEN`.

For a manual deploy or recovery (run from a release tag's checkout, not an unmerged branch):

```bash
npm ci --include=dev
npm run typecheck:relay && npm run typecheck:relay-test && npm run typecheck:page
npx vitest run tests/relay-core.test.ts tests/relay-routes.test.ts tests/relay-edge.test.ts tests/remote-e2e.test.ts tests/remote-mirror.test.ts tests/remote-host-lifecycle.test.ts tests/web-client.test.ts tests/browser-socket.test.ts tests/relay-page-layout.test.ts tests/remote-workerd.test.ts
npm run test:relay-do  # real workerd/Hub sockets and storage
npm run relay:page && git diff --exit-code -- relay/public/app/app.js
cd relay
npx wrangler deploy --dry-run  # validate before touching production
npx wrangler deploy
```

For first setup, see [Enrollment secret](#enrollment-secret) below. Never kill a running Wrangler
command: forced termination during a config write can corrupt its local credentials. For a bad
deployment, use `wrangler versions list` and `wrangler rollback` from `relay/`, then investigate
before redeploying.

A relay protocol change reaches production with the release that carries the matching desktop,
because the deploy runs from the release tag. The proof-of-possession protocol (#407) is not
backward compatible: it went live on 2026-09-25, ahead of a release, and desktops older than it
cannot connect until they run the new code. They keep their pairings, because their old device
token is now their refresh credential; a browser simply reloads the page.

The rate limits in `wrangler.jsonc` (`ratelimits`, namespaces 4101–4103) are Workers Rate Limiting
bindings: checked at the edge before a request can wake the Hub, per Cloudflare location, eventually
consistent. Each `namespace_id` must be unique within the Cloudflare account; change them if another
Worker already uses those numbers.

The landing Worker at `code.vocs.io` forwards `/app` and `/v1` (REST and WebSockets under
`/v1/ws/*`) through a service binding. It is a **separate repo and deployment** (`vocs.io`:
`npm run deploy:code`); a relay deployment does not update the landing Worker. The landing's GitHub
gate is live. This relay change adds one Hub DO per allowlisted GitHub subject, verifies its
short-lived account assertions, and sets `workers_dev: false` so browser requests cannot bypass the
gate. Deploy the relay first, then deploy the landing Worker with the same `ACCOUNT_ASSERTION_SECRET`;
never enable additional logins between those deployments. After any deploy, run the HTTP checklist in
`docs/REMOTE-ACCESS-ROADMAP.md` Appendix A and the opt-in live smoke.

## Enrollment secret

`ENROLL_TOKEN` is the legacy/manual enrollment capability for the incumbent `vocs-v1` account and
is also the landing Worker's service credential for owner routes. On `/v1/owner/*`, the relay now
requires both that credential and a valid account assertion from the landing; the assertion scopes
computer list, enrollment grant and browser pair request to the signed-in GitHub subject. New GitHub
accounts enroll via **Connect with GitHub**; they must not be given the incumbent's manual secret.
An enrolled desktop starts every later pairing with its own device credential, so rotating the legacy
secret leaves paired devices working. Rotation does not revoke devices; to cut off a lost or
compromised device use Revoke (or Settings → Remote access → Revoke all, the kill switch).

To rotate the **legacy enrollment secret**:

1. Prepare a new independent, high-entropy secret in the approved secret manager; never put the
   value in the repo, a shell command line, CI output or a ticket.
2. From `relay/`, run `npx wrangler secret put ENROLL_TOKEN` and enter the value at its interactive
   prompt. Do not terminate Wrangler mid-write. An unauthenticated `/v1/pair/start` must still
   answer 403.
3. In the vocs.io repo, run `npx wrangler secret put RELAY_ENROLL_TOKEN -c code/wrangler.jsonc` with
   the same value; owner routes will refuse requests if the copies differ.
4. Only legacy `vocs-v1` desktops that have **never** paired need the enrollment secret, and only
   where sign-in is unavailable. New GitHub accounts use Connect with GitHub, which binds enrollment
   to their own account; the Settings fallback is hidden when the gate is available.
5. A desktop the relay no longer recognizes (revoked, or pointed at a different relay) may need the
   current legacy value to re-enroll. Start one pairing, then let the code expire or deny it, and
   confirm no temporary device remains in the device list.

## Account routing secrets

`ACCOUNT_ASSERTION_SECRET` (at least 32 random bytes) must match on both Workers. From `relay/`, run
`npx wrangler secret put ACCOUNT_ASSERTION_SECRET`; in the vocs.io repo run
`npx wrangler secret put ACCOUNT_ASSERTION_SECRET -c code/wrangler.jsonc`. Enter the same value at
each interactive prompt; never put it in a command argument, committed file, log or ticket. A
rotation requires coordinated updates and temporarily refuses signed-in account routes while values
differ; verify `/v1/me`, owner routes and two-account separation before adding users. This secret is
distinct from `ENROLL_TOKEN` and is never entered on desktops.

`DEVICE_ROUTE_SECRET` (at least 32 random bytes) is relay-only. It MACs account routing hints into
new device ids so arbitrary account names cannot create Durable Objects. Provision it with
`npx wrangler secret put DEVICE_ROUTE_SECRET` before account onboarding. Keep it stable: changing it
without a versioned device-id migration makes existing non-legacy device ids unroutable. It is not
an account credential and never leaves the relay.

If a legacy enrollment-secret rollout goes wrong, re-enter the new value on the affected desktop;
do not roll back to a value suspected of compromise. A Worker code rollback does not restore an old
secret.

## Layout

- `src/account.ts` — signed landing assertions and MACed tenant-routing hints (Cloudflare-free, unit-tested)
- `src/core.ts` — pairing state machine, device registry, refresh and access tokens, the offline
  mirror catalogue (storage-agnostic, unit-tested)
- `src/routes.ts` — the deny-by-default HTTP route table and its account/device authentication (Cloudflare-free, unit-tested)
- `src/hub.ts` — frame routing between desktops and browsers, shared by the Durable Object and the
  test relay (`tests/fake-relay.ts`) so local suites run the production rules
- `src/edge.ts` — the Worker's front door: `/v1` only, edge rate limits, bounded bodies
- `src/rate.ts` — in-memory fixed-window rate limiter inside the Hub
- `src/worker.ts` — the Worker, per-account Hub Durable Object and short-lived EnrollmentDirectory (platform glue)
- `src/web-client.ts` — the browser-side pairing, tokens, vault and e2e transport (DOM-free, unit-tested)
- `src/page.ts` — the web page logic (bundled to `app/app.js` via `npm run relay:page` at the repo root)
- `public/app/` — the static web client, served at `/app` (pairing, computer switcher, sessions,
  transcripts, approvals, read-only terminal)

## Local development

```bash
cd relay && npx wrangler dev   # http://localhost:8787 — state under relay/.wrangler (gitignored)
```

Use a gitignored `.dev.vars` for `ENROLL_TOKEN`, `ACCOUNT_ASSERTION_SECRET` and `DEVICE_ROUTE_SECRET`
when exercising signed-in multi-account routes. Without those secrets, local development can use
only the legacy `vocs-v1` account. Desktops always
connect to `https://code.vocs.io`; start a development build with
`VOCS_CODE_RELAY_URL=http://localhost:8787` to point it at this local relay instead. Tests start the
same Worker programmatically (`tests/support/local-relay.ts`) with a throwaway secret and state
directory, so no local setup is needed to run them.
