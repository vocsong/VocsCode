# Vocs relay

The routing service for Vocs Code remote access (see [docs/REMOTE-ACCESS.md](../docs/REMOTE-ACCESS.md)).
A Cloudflare Worker + one Hub Durable Object per account. It routes opaque end-to-end-encrypted
frames between paired desktops and web clients and holds the pairing registry. It can never
read payload content — it sees routing metadata and ciphertext only.

## Deploy and recovery

`.github/workflows/deploy-relay.yml` deploys a reviewed `develop` push that touches the relay,
its shared protocol types, or the workflow itself. Configure a protected GitHub environment
named `relay-production` with `CLOUDFLARE_API_TOKEN` (scoped to deploy this Worker and its DO)
and `CLOUDFLARE_ACCOUNT_ID` as environment secrets, plus required reviewers if desired. The
workflow checks the relay types and tests, verifies the generated web bundle and dry-run,
and fails loudly when credentials are absent. It does **not** create or rotate `ENROLL_TOKEN`.

For a manual deploy or recovery (run from a reviewed checkout, not an unmerged branch):

```bash
npm ci --include=dev
npm run typecheck:relay && npm run typecheck:relay-test && npm run typecheck:page
npx vitest run tests/relay-core.test.ts tests/relay-routes.test.ts tests/remote-e2e.test.ts tests/remote-mirror.test.ts tests/web-client.test.ts tests/relay-page-layout.test.ts
npm run test:relay-do  # real workerd/Hub sockets and storage
npm run relay:page && git diff --exit-code -- relay/public/app/app.js
cd relay
npx wrangler deploy --dry-run  # validate before touching production
npx wrangler deploy
```

For first setup, see [Enrollment-secret rotation](#enrollment-secret-rotation) below. Never kill a
running Wrangler command: forced termination during a config write can corrupt its local
credentials. For a bad deployment, use `wrangler versions list` and `wrangler rollback` from
`relay/`, then investigate before redeploying.

The landing Worker at `code.vocs.io` forwards `/app` and `/v1` (REST and WebSockets under
`/v1/ws/*`) through a service binding. It is a **separate repo and deployment** (`vocs.io`:
`npm run deploy:code`); a relay deployment does not update the landing Worker. After any deploy,
run the HTTP checklist in `docs/REMOTE-ACCESS-ROADMAP.md` Appendix A and the opt-in live remote
smoke. A green local fake relay suite does not exercise Durable Object socket tags. Until the
login gate is deployed, the web client at `/app` remains ungated; do not advertise it publicly.

## Enrollment-secret rotation

`ENROLL_TOKEN` authorizes **new pairing codes**, not existing device sessions. Rotating it does
not revoke paired devices, their bearer tokens, or previously uploaded mirror blobs. If a device
is lost or a bearer is exposed, revoke that device separately; do not treat rotation as an
account-wide kill switch.

1. Schedule a reviewed maintenance window and inventory **every** paired desktop. Pause new
   pairing during the change. Prepare a new independent, high-entropy secret in the approved
   secret manager; never put the value in the repo, shell command line, CI output, or a ticket.
2. From `relay/`, run `npx wrangler secret put ENROLL_TOKEN` and enter the new value at its
   interactive prompt. This updates the relay's production secret; it does not change desktop
   keychains. Do not terminate Wrangler mid-write. Verify the deployed Worker responds and an
   unauthenticated `/v1/pair/start` still returns 403; neither check proves the new value.
3. On **each** desktop, use Settings → Remote access → Connect with the existing relay URL and
   the new enrollment secret. This saves it to that desktop's secret store and reconnects.
   Start one new pairing code through the UI to confirm the new value is accepted; let that code
   expire or deny its claim so no test device remains. Do not use a credential in a `curl -H`
   argument (it appears in shell history and process listings).
4. Verify every desktop reconnects and can request a code. Run the deployed smoke only under
   its explicit opt-in and cleanup rules in [TESTING.md](../docs/TESTING.md), then inspect the
   registry for temporary devices. Record the rotation date and affected desktops without
   recording the secret.

A desktop still holding the old value can use its already-issued device token but cannot mint a
new code. If a rollout fails, repair each desktop with the **new** value; do not roll back to an
old value suspected of compromise. For a non-compromise operational rollback, an authorized
operator may re-enter the old secret interactively and repair the desktops again. A Worker code
rollback does not by itself restore the old secret.

## Layout

- `src/core.ts` — pairing state machine + device registry (storage-agnostic, unit-tested)
- `src/routes.ts` — the deny-by-default HTTP route table and its authentication (Cloudflare-free, unit-tested)
- `src/rate.ts` — in-memory fixed-window rate limiter for the public pairing endpoints
- `src/worker.ts` — the Worker + Hub Durable Object (REST + WebSocket glue)
- `src/web-client.ts` — the browser-side pairing + e2e transport (DOM-free, unit-tested)
- `src/page.ts` — the web page logic (bundled to `app/app.js` via `npm run relay:page` at the repo root)
- `public/app/` — the static web client, served at `/app` (pairing screen, sessions, transcripts, approvals)

## Local development

```bash
cd relay && npx wrangler dev   # http://localhost:8787
```
