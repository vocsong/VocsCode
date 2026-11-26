# Vocs relay

The service behind the desktop's relay connection (see [docs/RELAY.md](../docs/RELAY.md)).
A Cloudflare Worker + one Hub Durable Object per account. It registers computers through Connect
with Vocs, holds the device registry and access tokens, routes External MCP controller requests to
a computer's host socket ([docs/CONTROL-MCP.md](../docs/CONTROL-MCP.md)), stores analytics
snapshots for the dashboard ([docs/WEB-DASHBOARD.md](../docs/WEB-DASHBOARD.md)) and serves the
dashboard at `/dashboard`.

**Paired-browser access is retired on the desktop.** From the first release after v0.14.0,
desktops no longer pair browsers, relay end-to-end encrypted browser sessions or upload transcript
mirrors. The relay's pairing, mirror, `/v1/ws/client`, `/v1/ws/ticket`, `/v1/owner/hosts` and
`/v1/owner/pair-request` routes, documented below, stay only because released desktops (v0.14.0
and older) still call them; they are removed in a follow-up once those desktops are gone
([docs/RELAY.md](../docs/RELAY.md#retired-paired-browser-access)).

## Deploy and recovery

`.github/workflows/deploy-relay.yml` deploys the relay with each release. Pushing the `vX.Y.Z` tag
that the installers are built from ([RELEASING.md](../docs/RELEASING.md#shipping-a-release)) starts
it, so production always speaks the protocol of the released desktop. The protected GitHub
environment `relay-production` holds `CLOUDFLARE_API_TOKEN` (an "Edit Cloudflare Workers" token
limited to this account) and `CLOUDFLARE_ACCOUNT_ID`, admits release tags only, and waits for the
owner's approval. The workflow checks the relay types and tests — including the controller route
against this checkout's Worker in local workerd — builds the dashboard bundle, dry-runs, and fails
loudly when credentials are absent. Redeploy a release with
`gh workflow run deploy-relay.yml --ref vX.Y.Z`. Tag pushes and redeploys alike first pass the
[release tag gate](../docs/RELEASING.md#release-tag-gate): the tag's commit must be on `master` with
a green CI run. It does **not** create or rotate `ENROLL_TOKEN`.

For a manual deploy or recovery (run from a release tag's checkout, not an unmerged branch):

```bash
npm ci --include=dev
npm run typecheck:relay && npm run typecheck:relay-test
npx vitest run tests/relay-core.test.ts tests/relay-routes.test.ts tests/relay-edge.test.ts tests/remote-host-lifecycle.test.ts tests/control-relay.test.ts tests/browser-socket.test.ts tests/web-router.test.ts tests/web-dashboard.test.tsx tests/relay-analytics.test.ts tests/control-relay-workerd.test.ts
npm run test:relay-do  # real workerd/Hub sockets and storage
npm run build:web && test -f relay/public/dashboard/index.html  # the dashboard is built, not committed
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
cannot connect until they run the new code. They keep their registration, because their old
device token is now their refresh credential.

The rate limits in `wrangler.jsonc` (`ratelimits`, namespaces 4101–4105) are Workers Rate Limiting
bindings: checked at the edge before a request can wake the Hub, per Cloudflare location, eventually
consistent. Each `namespace_id` must be unique within the Cloudflare account; change them if another
Worker already uses those numbers.

## Request budgets

`src/edge.ts` classifies every `/v1` request before the Worker reads its body, selects an account or
wakes a Durable Object. A route the Hub does not serve is answered there (404/405). Every served
route — authenticated ones included, because authentication has not happened yet — then passes, in
order:

1. **An edge rate limit** keyed on method, route and caller (an IPv4 address, or the /64 of an IPv6
   one). Pairing uses `PAIR_LIMIT` (10/min), token exchange `TOKEN_LIMIT` (30/min, however many
   device ids a caller names), polling and owner routes `POLL_LIMIT` (120/min); each of these
   routes has its own counter. Socket, device and mirror routes together share one total per
   address, `ADDRESS_LIMIT` (400/min), whatever route or device id a request names.
2. **A declared-size check**: a `Content-Length` over the route's budget is refused (413) unread.
   Mirror uploads (`PUT /v1/mirror`, `PUT /v1/mirror/<id>`) get 2,500,000 bytes; every other route
   16 KiB.
3. **A credential-shape check**: device routes need a `device` id and a bearer of the relay-minted
   token shape, sockets their bearer or ticket, enrollment its bearer secret. Nothing is looked up,
   so the refusal is the same whether or not the device exists. Pairing and owner routes are
   refused by the Worker's account-assertion check, also before any body is read. A route that
   takes no body (GET) is refused one (400).
4. **A per-device limit** on socket, device and mirror routes, `DEVICE_LIMIT` (300/min per route,
   device and address; every session id under `/v1/mirror/` shares one): room for a desktop's first
   mirror sync or many active sessions re-uploading, so devices behind one NAT are not squeezed into
   one device's budget.
5. **A bounded, timed body read**: bytes are counted as they stream, so a missing or understated
   `Content-Length` is cut off at the budget (413), and a body that has not arrived in full within
   10 s (60 s for mirror uploads) is abandoned (408).

The Hub keeps its own in-memory per-caller limits, counting callers the same way, and verifies every
credential. The controller endpoint (`/v1/control/mcp`, disabled in production) is rate limited here
and bounds its own body. Edge limits are counted per Cloudflare location.

The landing Worker at `code.vocs.io` forwards `/dashboard`, `/app` and `/v1` (REST and WebSockets
under `/v1/ws/*`) through a service binding. It is a **separate repo and deployment** (`vocs.io`:
`npm run deploy:code`); a relay deployment does not update the landing Worker. The landing's login
gate is live. The relay keeps one Hub DO per account, verifies the landing's short-lived account
assertions, and sets `workers_dev: false` so browser requests cannot bypass the gate. Deploy the
relay first, then deploy the landing Worker with the same `ACCOUNT_ASSERTION_SECRET`; never enable
additional logins between those deployments. After any deploy, run the
[live verification checklist](../docs/RELAY.md#live-verification).

## Enrollment secret

`ENROLL_TOKEN` is the legacy/manual enrollment capability for the incumbent `vocs-v1` account and
is also the landing Worker's service credential for owner routes. On `/v1/owner/*`, the relay now
requires both that credential and a valid account assertion from the landing; the assertion scopes
computer list, enrollment grant and browser pair request to the signed-in account. Desktops from
this version on never use the secret: they register only through **Connect with Vocs**. New
accounts must not be given the incumbent's manual secret. A registered desktop uses its own device
credential, so rotating the legacy secret leaves registered computers working. Rotation does not
revoke devices; to cut off a lost or compromised device use Remove (or Settings → MCP control →
Remove all, the kill switch).

To rotate the **legacy enrollment secret**:

1. Prepare a new independent, high-entropy secret in the approved secret manager; never put the
   value in the repo, a shell command line, CI output or a ticket.
2. From `relay/`, run `npx wrangler secret put ENROLL_TOKEN` and enter the value at its interactive
   prompt. Do not terminate Wrangler mid-write. An unauthenticated `/v1/pair/start` must still
   answer 403.
3. In the vocs.io repo, run `npx wrangler secret put RELAY_ENROLL_TOKEN -c code/wrangler.jsonc` with
   the same value; owner routes will refuse requests if the copies differ.
4. Only released desktops (v0.14.0 and older) on the legacy `vocs-v1` account that have **never**
   paired could use the enrollment secret, and only where sign-in was unavailable. Current desktops
   have no field for it and use Connect with Vocs, which binds enrollment to their own account.
5. A desktop the relay no longer recognizes (revoked, or pointed at a different relay) registers
   again with Connect with Vocs. Confirm no temporary device remains in the device list.

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

If a legacy enrollment-secret rollout goes wrong, re-enter the new value on the affected released
desktop (or update it and use Connect with Vocs); do not roll back to a value suspected of
compromise. A Worker code rollback does not restore an old
secret.

## Layout

- `src/account.ts` — signed landing assertions and MACed tenant-routing hints (Cloudflare-free, unit-tested)
- `src/core.ts` — facade over the device registry, refresh and access tokens (`devices.ts`),
  Connect with Vocs enrollment (`enrollment.ts`), and the legacy pairing state machine and offline
  mirror catalogue (`pairing.ts`, `mirror-store.ts`) (storage-agnostic, unit-tested)
- `src/analytics.ts` — dashboard analytics snapshots: part and manifest storage, owner reads
- `src/control-auth.ts`, `src/control-host.ts`, `src/control-mcp.ts` — the External MCP controller
  route: controller assertions, RPC over authenticated host sockets, and the stateless MCP server
- `src/legacy-app.ts` — the `/app*` → `/dashboard*` redirect released desktops' Connect links need
- `src/routes.ts` — the deny-by-default HTTP route table and its account/device authentication (Cloudflare-free, unit-tested)
- `src/hub.ts` — frame routing between desktops and browsers, shared by the Durable Object and the
  test relay (`tests/fake-relay.ts`) so local suites run the production rules
- `src/edge.ts` — the Worker's front door: the edge route table, rate limits, credential shapes, body budgets and deadlines
- `src/rate.ts` — in-memory fixed-window rate limiter inside the Hub, and how both limiters key a caller
- `src/entry.ts` — deployed exports and the optional [binding-only MCP discovery entrypoint](../docs/CONTROL-MCP.md#mcp-hub-discovery-preview-for-dots-and-muse)
- `src/worker.ts` — the public Worker, per-account Hub Durable Object and short-lived EnrollmentDirectory (platform glue)
- `src/web-client.ts` — the retired browser client's pairing, tokens, vault and e2e transport, kept
  as a test client for the legacy browser routes (DOM-free)
- `public/dashboard/` — the analytics dashboard built from `src/web` by `npm run build:web` at the
  repo root (gitignored), served at `/dashboard`; `public/_headers` sets its CSP

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
