# The relay connection

The desktop keeps one optional, outbound connection to the Vocs relay at `code.vocs.io`. It
registers the computer with the owner's Vocs account. It carries:

- **External MCP control and discovery.** MCP clients such as Dots and Muse find and reach this
  computer through the relay, limited to the grants the owner sets on the desktop
  ([CONTROL-MCP.md](CONTROL-MCP.md); the controller routes stay disabled in production until their
  rollout gates pass).
- **The analytics dashboard.** A connected computer uploads its analytics snapshot for
  `code.vocs.io/dashboard` unless sharing is off ([WEB-DASHBOARD.md](WEB-DASHBOARD.md)).

The connection is off by default, and nothing on the computer listens for incoming traffic.
Paired-browser access was retired ([below](#retired-paired-browser-access)).

Code: `src/main/remote/` — `host.ts` (`RemoteHost`: lifecycle, socket, revocation, upgrade cleanup),
`host-sign-in.ts` (Connect with Vocs), `relay-client.ts` (REST client and access tokens),
`host-control.ts` (controller frames), `analytics-sync.ts` (dashboard upload), `relay-url.ts`
(which relay). The relay itself is `relay/` ([relay/README.md](../relay/README.md)).

## Settings and IPC

**Settings → MCP control** (Connections group, `RelayConnectionSection.tsx`) has three groups:

- **Vocs relay connection:** Connect with Vocs (or **Connect** once registered), Disconnect, the
  status line, **Share analytics with code.vocs.io**, the **Your computers** list with Remove per
  computer, and **Remove all** (the kill switch). A note counts browsers an earlier version paired
  that are still on the account.
- **External MCP control:** the controller grants ([CONTROL-MCP.md](CONTROL-MCP.md#owner-setup-after-a-separately-approved-rollout)).
- **Local CLI & MCP discovery:** Windows only ([LOCAL-CONTROL.md](LOCAL-CONTROL.md)).

Settings hold only `remote: { enabled, shareAnalytics? }` (`RemoteConfig`). The relay is not a
setting: desktops use `https://code.vocs.io`, and `VOCS_CODE_RELAY_URL` points a development build or
a test at another relay. That URL must be HTTPS/WSS outside literal loopback, and credential-bearing
requests never follow redirects ([OPERATIONS.md](OPERATIONS.md#credential-endpoint-transport)).

| Channel | Does |
| --- | --- |
| `remote:get` | config, state, the account's devices (while enabled), relay URL, `registered`, `signInAvailable` |
| `remote:signIn` | turns the connection on; registers through Connect with Vocs, or just connects a registered computer |
| `remote:disable` | turns it off and closes the socket; the credential stays |
| `remote:revoke` | removes one device from the account |
| `remote:revokeAll` | removes every other device; this computer stays connected |
| `remote:setShareAnalytics` | turns dashboard uploads on or off (off deletes the relay copy) |

`push:remoteState` carries `RemoteState` (`status`, `detail`, `registered`, and `signIn` while Connect
with Vocs is waiting). A connection left on resumes at startup with the stored credential.
`signInAvailable` probes `/v1/me` (401 means the landing's login gate is there); a bare development
relay has no sign-in, so it cannot register a new computer.

## Connect with Vocs

Connect with Vocs is the only way to register a computer.

1. The desktop generates a one-time secret (32 random bytes) and opens
   `<relay>/dashboard?connect=<its SHA-256>` in the default browser. The secret itself never leaves
   the desktop. Released desktops open `/app?connect=…`, which the relay redirects to `/dashboard`
   with the query kept (`relay/src/legacy-app.ts`).
2. After sign-in (the link survives the login redirect), the page shows a check code derived from
   the hash, which the desktop shows too (`connectCheckCode`), and asks before it grants anything.
3. **Add this computer** binds the hash to the signed-in account for ten minutes
   (`POST /v1/owner/enroll-grant`). A short-lived EnrollmentDirectory stores only
   `nonce hash → account id`; the tenant Hub stores the grant. Re-granting a live hash to a different
   account is refused.
4. Meanwhile the desktop polls `POST /v1/enroll/redeem` every two seconds with the secret, its public
   keys, name and platform. Unknown, expired, revoked and not-yet-granted secrets all answer
   `pending`. Once granted, the relay returns the host device id and the refresh credential sealed to
   the desktop's ECDH key (`enrollTokenContext`). A key already registered to that account keeps its
   host id; the account holds at most five computers.
5. The desktop stores the credential and connects. After ten minutes without a grant it stops with
   "the sign-in page expired"; Disconnect cancels the wait.

A Connect with Vocs link someone else sent would register the sender's computer into the account
that adds it. The page warns first, the check code must match the one on the desktop that opened it,
owner writes are same-origin only, and every registered computer is listed in Settings, where it can
be removed.

### Accounts

The landing authenticates through Vocs Login (`auth.vocs.io`). Its `VOCS_ACCOUNTS` map preserves
established relay account ids (`vocs-v1` for the incumbent owner, `github:<id>` for earlier
accounts); never remap one without a data migration. With `PUBLIC_CODE_ACCOUNTS=true` on the
landing, a verified subject with no entry gets its own tenant, `vocs:<digest>` (SHA-256 of the
versioned Code purpose, pinned issuer and subject, unpadded base64url). Each account has one Hub
Durable Object holding its devices, grants and analytics. Deploy the compatible relay before
enabling the flag. Turning the flag off ends self-service browser sessions, not desktop credentials;
use Vocs Login suspension to block a subject, and remove its computers separately.

- **Account assertion.** For each signed-in `/v1/*` request the landing strips caller-supplied
  identity headers and signs `accountId + expiry + method + pathname` with
  `ACCOUNT_ASSERTION_SECRET`, valid for one minute. The relay verifies it before routing an
  account-scoped request and never accepts an unsigned account id. Cookies never cross the service
  binding.
- **Device routing.** New device ids carry a relay-MACed routing hint (`DEVICE_ROUTE_SECRET`). The
  hint authorizes nothing: the selected Hub still checks proof of possession. Old untagged ids route
  only to `vocs-v1`.
- **Owner routes.** `/v1/owner/*` require the landing's `RELAY_ENROLL_TOKEN` plus the assertion. The
  landing replaces any browser Authorization and refuses writes whose `Origin` is not
  `https://code.vocs.io`.

## Credentials and access tokens

The desktop's identity is a P-256 ECDSA signing key and a P-256 ECDH key (`generateIdentity`).
`SecretStore` keeps them with the relay registration under `remote-host`:
`{ identity, relayUrl, deviceId?, deviceToken?, legacyMirror? }`. `remote-host` is a reserved id
(`src/main/secret-ids.ts`), never reachable as a provider key, and session-only: without OS
encryption it stays in memory for that run and is never written, so the computer must Connect with
Vocs again after a restart. Neither keys nor tokens appear in settings or logs.

`deviceToken` is a refresh credential. It authorizes no call by itself; the relay stores only its
hash. To act, the desktop asks for a one-time challenge (`POST /v1/token/challenge`, the refresh
credential as bearer), signs `['relay.token', deviceId, challenge]` with its device key, and trades
the signature for an access token valid for an hour (`POST /v1/token`). `RelayClient` keeps it in
memory, refreshes it a minute before expiry, shares one refresh among concurrent callers, and on a
401 proves possession once more and retries. A stolen refresh credential without the private key
gets nothing, and neither token ever appears in a URL.

A 401 on the challenge means the relay no longer accepts the credential (removed, or issued by a
different relay). The desktop drops `deviceToken`, stops reconnecting, keeps its identity and shows
"connect with Vocs to register it again"; registering again reuses the same key.

## The host socket and the controller channel

With a fresh access token the desktop opens `GET /v1/ws/host?device=<id>` with the token in
Authorization. On open it reports `online`, runs the [upgrade cleanup](#upgrading-from-paired-browser-builds)
and starts an analytics sync. A closed socket reconnects after three seconds; a refused upgrade
drops the cached token so the next attempt proves possession again. A late reconnect stands down
while another socket is open or opening.

The only inbound frames the desktop serves are `control.request`; it answers `control.response`.
Anything else, including frames meant for the retired browser channel, is ignored.
`HostControlRunner` drops a request that is oversized, arrives on a superseded socket, names
another host, or carries an expiry or principal validity more than 30 seconds out or already past.
It allows 16 requests in flight and 1,024 remembered ids, and answers `conflict` to a repeated id.
The `ControlService` then checks the grant, project, action, harness and permission mode itself.
The trust model, receipts and gateway boundaries are in [CONTROL-MCP.md](CONTROL-MCP.md). Unlike
the retired browser channel, controller traffic is not end-to-end encrypted: the gateway and
relay see readable content.

## Removal and the kill switch

- **Disconnect** closes the socket. It revokes nothing; Connect resumes with the same credential.
- **Remove** (`DELETE /v1/devices?target=<id>`) revokes one device at the relay. Removing a
  computer also revokes any browser paired with it and drops its mirror and analytics. A computer
  that removes itself keeps its identity and needs Connect with Vocs again.
- **Remove all** (`POST /v1/devices/revoke-all`, host-authenticated) revokes every other device of
  the account (computers and any legacy browsers), cancels pending pairing codes and enrollment
  grants, drops revoked computers' mirrors and analytics, and raises the account's revocation epoch
  in the same commit. Grants and redemptions carry the epoch they were issued under and are
  rechecked inside the transaction that mints a device, so authority issued before a Remove all
  mints nothing after it. This computer keeps its identity and stays connected.

## Upgrading from paired-browser builds

On startup the desktop clears a stored `remote-enroll` secret (the legacy enrollment secret, which
only ever registered a computer through a browser approving a pairing) and deletes
`<userData>/remote-audit.jsonl`.

`loadCreds` reads an older `remote-host` record and drops `clients` (paired-browser trust anchors),
`mirrorKey` and `enrollToken`; they are gone from the next save. If the record had a mirror key it
sets `legacyMirror`. On each connect while that marker is set, the desktop sends one
`DELETE /v1/mirror`. A 2xx or 404 clears the marker; any other answer or a network failure leaves it
set, and the delete is retried on the next connect. Log lines: `remote: deleted the transcript mirror
an earlier version left at the relay` and `remote: could not delete the old transcript mirror yet;
retrying on the next connect`.

## Deploy

The relay and the landing are separate deployments.

- **Relay** (this repo): `.github/workflows/deploy-relay.yml` runs on the `vX.Y.Z` tag push that also
  builds the installers, after the [release tag gate](RELEASING.md#release-tag-gate), and publishes
  after approval in the protected `relay-production` environment (release tags only). It typechecks
  the relay, runs the relay, relay-connection and control suites (including
  `tests/control-relay-workerd.test.ts` against this checkout's Worker in local workerd) and
  `npm run test:relay-do`, builds the dashboard (`npm run build:web`, checks
  `relay/public/dashboard/index.html`), and dry-runs. Production therefore follows releases, not
  `develop`. Redeploy a release with `gh workflow run deploy-relay.yml --ref vX.Y.Z`. Manual
  recovery and rollback: [relay/README.md](../relay/README.md#deploy-and-recovery).
- **Landing** (`vocs.io` repo, `code/`): `npm run deploy:code`. It owns `code.vocs.io`, the login
  gate and `/mcp`, and forwards `/app`, `/dashboard` and `/v1` (REST and `/v1/ws/*`) to the relay
  through a service binding. Deploy a relay that supports a change before the landing that depends
  on it.
- **`workers_dev: false`** in `relay/wrangler.jsonc`: the relay has no direct `*.workers.dev` origin,
  so nothing bypasses the landing's gate.

Wrangler gotchas:

- **Never kill a `wrangler` process.** A forced kill mid-write zero-fills
  `%APPDATA%\xdg.config\.wrangler\config\default.toml`; every API-backed command then fails with
  `Invalid TOML document` until `npx wrangler login`. Tests start the Worker through wrangler's
  programmatic API and stop it with `dispose()` for this reason.
- A running `wrangler dev` holds files under `node_modules` open: stop it before `npm ci`, or the
  install fails with EBUSY and can leave `node_modules` half removed.
- `wrangler deploy --dry-run` validates config and bindings without uploading.

### Secret inventory

| Secret | Where | Used by | Rotation |
| --- | --- | --- | --- |
| `ENROLL_TOKEN` | relay Worker; the landing holds a copy as `RELAY_ENROLL_TOKEN` | the landing's owner credential on `/v1/owner/*`; also still gates the legacy `vocs-v1` pairing start that released desktops call | [runbook](../relay/README.md#enrollment-secret); registered computers are unaffected |
| `ACCOUNT_ASSERTION_SECRET` | identical on landing `vocs-code` and relay `vocs-relay` | signed account assertions | rotate both Workers together; a mismatch fails closed |
| `DEVICE_ROUTE_SECRET` | relay only; keep stable | MACed routing hints in device ids | not without a versioned device-id migration; not an account credential |
| Device refresh credential | desktop `SecretStore` `remote-host` (memory only without OS encryption) | buying access tokens, with a device-key signature | remove the computer; Connect with Vocs again |
| `SESSION_SECRET` | landing Worker | session and login state signing | invalidates all sessions |
| `VOCS_ACCOUNTS` | landing Worker | `<vocs subject>=<relay account id>`; the owner maps to `vocs-v1` | preserve mappings; never remap without a data migration |
| `vocs-code-web` SSO client | Vocs Login `vocs_sso_client` row | the landing's sign-in handoff | disable the row to stop new sign-ins |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub `relay-production` environment | the deploy workflow | rotate in the Cloudflare dashboard |

Local development keeps relay secrets outside the repos (a gitignored `relay/.dev.vars`). The workerd
suites generate throwaway values; never put production values in a repository, command argument,
log or transcript.

### Live verification

Run after any relay or landing deploy:

```bash
B=https://code.vocs.io
curl -s -o /dev/null -w '%{http_code}\n' "$B/"                     # 200 landing
curl -s -o /dev/null -w '%{http_code}\n' "$B/dashboard/"           # 302 to the login when signed out
curl -s -o /dev/null -w '%{http_code}\n' "$B/app?connect=x"        # a redirect, never 200
curl -s -o /dev/null -w '%{http_code}\n' "$B/v1/me"                # 401 signed out (Connect with Vocs probes this)
curl -s -o /dev/null -w '%{http_code}\n' "$B/v1/devices"           # 401 without an access token
curl -s -o /dev/null -w '%{http_code}\n' "$B/v1/owner/analytics"   # 401 signed out
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/v1/token/challenge?device=h_x" \
  -H 'authorization: Bearer nope'                                  # 401
curl -sI "$B/dashboard/" | grep -iE '^(x-frame|referrer|x-content|cross-origin|permissions|content-security-policy|cache-control)'
```

Then, signed in: the dashboard loads under its CSP with no violations; a desktop on the released
version connects from **Settings → MCP control**, shows `online`, lists itself under Your computers
and appears on the dashboard; and the relay's `*.workers.dev` hostname does not answer. Before
admitting another login, check that a second account sees only its own computers.

Suites for each part are in [TESTING.md](TESTING.md#which-suite-a-change-must-keep-passing).

## Retired: paired-browser access

From the first release after v0.14.0, a web browser can no longer drive desktop sessions. Removed
from the desktop:

- pairing codes, the QR code, Allow/Deny pairing requests and the paired-browser device list;
- the end-to-end encrypted session bridge, browser terminal streams (P3.5), the offline transcript
  mirror, view-only mode and the remote audit trail;
- the legacy enrollment-secret flow (it only registered a computer through a browser pairing);
- the `VOCS_CODE_WEB=1` localhost web server, the renderer's browser-mode branches and
  `sessions:transcriptPage` paging;
- IPC `remote:enable`, `remote:pairStart`, `remote:pairRespond`, `remote:setViewOnly`,
  `remote:setMirror`, `remote:clearAudit`, `push:remotePolicy`, `push:remoteTerminal`,
  `terminal:watch`/`unwatch`/`watchAck`, and the `audit` field of `remote:get`.

The browser client itself was replaced by the dashboard in v0.12.0
([WEB-DASHBOARD.md](WEB-DASHBOARD.md)). Browsers paired earlier stay on the account until removed;
Remove all clears them.

The relay is deliberately unchanged: released desktops (v0.14.0 and older) still call its pairing,
mirror and browser routes, and the relay deploys only from release tags. `relay/src/web-client.ts`
remains as a test client. **Follow-up**, once released desktops no longer call them: remove the
relay's pairing routes (`/v1/pair/*`), mirror routes (`/v1/mirror*`, `/v1/mirrors`), `/v1/ws/client`,
`/v1/ws/ticket`, `/v1/owner/hosts`, `/v1/owner/pair-request`, and `kind: 'web'` device records.
