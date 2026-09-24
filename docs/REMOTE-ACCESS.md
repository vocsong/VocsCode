# Remote access: code.vocs.io (plan)

Design and decisions of record for remote access — the relay, pairing and e2e crypto, the web
client, and the P0–P4 phases. **Implemented and deployed**: §6.2 carries the live status, and
[REMOTE-ACCESS-ROADMAP.md](./REMOTE-ACCESS-ROADMAP.md) is the working backlog — what is live,
what is not, and in what order.

## 1. The idea

A hosted web client at `code.vocs.io`: log in, see your folders and sessions, chat with
your agents remotely. One sentence, two very different products hiding inside it:

- **Remote control** — the sessions still run on *your* machine; the web is a window into
  your desktop app.
- **Cloud execution** — sessions run on *our* infrastructure; the user's machine isn't
  involved at all.

These have wildly different cost, security, and effort profiles. The good news: the same
protocol and the same web client serve both, so we can start with the cheap one and keep
the door open.

## 2. Three shapes — decision: Model C, build A first

> **Decision:** Model C (hybrid) — build Model A (relay) first; Model B (cloud
> workspaces) is the committed later track that reuses the same protocol, web client,
> and auth. Cheapest path to a working product, smallest security surface, nothing
> thrown away. The models below are kept for context.

### Model A — Relay (remote control of your desktop)

The desktop app gains an outbound WebSocket connection to a relay service. The web client
connects to the same relay. The relay routes messages; sessions, PTYs, git, and files all
stay on the user's machine.

```
┌─────────────┐    WSS outbound (e2e encrypted)   ┌───────────────┐    HTTPS/WSS   ┌───────────────┐
│ Desktop app │ ────────────────────────────────▶ │ Relay service │ ◀───────────── │  Web client   │
│  (the host) │    no inbound ports, no config    │ routing +     │                │ code.vocs.io  │
│             │                                   │ presence      │                │ (our renderer)│
└─────────────┘                                   └───────────────┘                └───────────────┘
```

- Sessions, harness processes, worktrees, terminals: unchanged, on the user's machine.
- API keys: never leave the OS keychain (existing invariant holds for free).
- Desktop must be running and online for interactive use.
- Infra cost ≈ a stateful WebSocket router. Cheap.

### Model B — Cloud workspaces

Per-user sandbox (container/VM) runs the harness runtimes; the user's folders are cloned
or synced in; keys and harness logins live server-side.

- Always-on, works from any device with no desktop involved.
- Needs: sandbox orchestration, headless harness login flows, server-side secrets (KMS),
  folder sync, per-session compute billing. Large, separate program.

### Model C — Hybrid (chosen path)

Build A first. The relay protocol, auth, pairing, and web client are exactly the pieces
Model B needs later — a sandbox host just replaces the desktop app as the thing on the
other end of the wire. Nothing in A is throwaway.

### Comparison

| | A: Relay | B: Cloud workspaces |
| --- | --- | --- |
| Where agents run | user's machine | our containers |
| Desktop must be on | yes | no |
| Folders | real local folders, zero sync | clone / sync via git |
| API keys | stay in OS keychain | server-side store (KMS) |
| Harness logins | already logged in on desktop | headless device-code flows per CLI |
| Infra cost | ~zero (relay only) | per-session compute |
| Security surface | small (e2e optional) | large (multi-tenant sandboxing) |
| Effort | weeks | months |
| Risk | low | high |

## 3. What the codebase already gives us

Grounded in the current tree — this is why the relay path is unusually cheap:

- **Normalized event stream.** `SessionEvent` union (`src/shared/types.ts`) with
  `item.upsert` / `item.delta` / `approval.request` / `meta` / … wrapped in
  `SessionEventEnvelope`. All six harness adapters emit it. Streaming this over a
  WebSocket instead of `push:sessionEvent` IPC is a transport swap, not a redesign.
- **The IPC contract *is* the protocol.** `src/shared/ipc.ts` defines ~90 typed channels
  with request/response payload types, flowing 1:1 through the preload bridge. A WebSocket
  with request-id correlation can carry the exact same contract.
- **Node-generic core.** `session-manager.ts`, `terminal.ts`, `git.ts`, `store.ts`,
  `runtime.ts`, `settings.ts`, `analytics.ts`, `skills.ts`, all of `harness/*` and
  `models/*` have zero Electron imports. Only `index.ts`, `ipc.ts`, `secrets.ts`, and
  `preload/index.ts` touch Electron. A WS server can bind the same handler logic.
- **Terminal protocol already WS-shaped.** `terminal:attach` returns
  `{ snapshot, seq }`; data flows as string frames with `seq`; flow control via
  `terminal:ack` (`src/main/terminal.ts`, `src/renderer/terminal/host.ts`). Headless
  xterm snapshots already exist. This maps 1:1 onto a socket.
- **Re-attach = replay.** Transcripts are append-only JSONL per session
  (`userData/sessions/<id>/transcript.jsonl`), deduped by item id, fully replayed on
  `sessions:transcript`. No cursor machinery needed; reconnect is cheap.
- **Concurrency already solved.** Multiple sessions run in parallel, one harness process
  each, multiplexed by `sessionId` in the envelope.
- **Renderer is a plain Vite SPA.** Pure React + zustand, no electron-vite renderer
  features, standard `index.html` with CSP. ~75% browser-ready; shims needed only for
  `app:pickFolder`, native paste, notifications, `app:openExternal/openPath`.
- **The web sidebar is nearly free.** "See your folders and sessions" = `sessions:list` +
  `settings:get` (`folders`, `recentProjects`, `folderStyles`) — all existing channels.

## 4. Target architecture (Model A)

New pieces:

1. **Desktop remote host** — `src/main/remote/`: outbound WSS client to the relay,
   opt-in, off by default. Exposes a *filtered* IPC surface (see §5).
2. **Relay service** — stateful router: accounts, devices, presence, message routing.
   **Cloudflare Workers + Durable Objects** on the existing vocs.io Cloudflare account;
   one DO per desktop connection, hibernation-friendly, no servers to patch.
   **Multi-host:** an account may pair several desktops (work PC, home PC, laptop);
   routing is keyed by `(account, host)` and every frame carries the target host id, so
   the web client can browse and drive any of its paired instances.
3. **Web client** — served at `code.vocs.io/app` on the **same origin as the landing page**: the
   landing Worker owns the hostname and forwards `/app` and `/v1` to the relay Worker
   (service binding), so the app, the API and the WebSocket share one origin with no CORS and no
   second DNS record. It is never pointed at a local machine's server; it reaches desktops only
   through the relay. A distinct web shell around the reused renderer core — different
   `window.harness` transport, browser-native chrome (desktop titlebar/menu hidden in web
   builds), slim account/device header, code.vocs.io branding, fully responsive layout (drawer
   sidebar, touch targets), account/pairing screens, and a few shims. The sidebar
   lists sessions across all paired hosts, grouped by host; interactive ops target the
   host that owns the selected session.

Key idea: **the web client is the existing renderer with a different transport.** The
less the renderer knows about how `window.harness` is backed, the more is reused.

The P1 localhost web server (`VOCS_CODE_WEB=1`) is the dev dogfood of exactly this
architecture — same Transport protocol, same registry, but served from the app and
bound to loopback. At P2 the *same web bundle* is deployed to code.vocs.io and the
same frames flow through the relay instead; the local server never participates in
the production path.

## 5. Protocol & transport

```ts
// src/shared/transport.ts (new) — the keystone abstraction
interface Transport {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, handler: (payload: unknown) => void): () => void;
}
```

- `LocalTransport` = today's `ipcRenderer.invoke/on` (unchanged desktop behavior).
- `RemoteTransport` = WebSocket, JSON frames `{ id, channel, payload }` with response
  correlation; push channels arrive as server-initiated frames — only the remote push surface
  (`push:sessionEvent`, `push:sessionsChanged`, `push:settingsChanged`, `push:remotePolicy`); PTY
  output, the assistant panel and the desktop's own remote state (which carries the live pairing
  code) never leave the machine.
- **Addressing:** relay frames carry a target host id — an account may pair several
  desktops, and the web client names the host it wants per connection/session. Hosts
  connect outbound and stay addressable by their device id; one host offline does not
  affect the others.
- On the desktop, extract the handler map from `src/main/ipc.ts` into a
  transport-agnostic registry keyed by channel; `ipcMain` binding and the WS server both
  bind the same registry. Handler logic stays identical.
- Reconnect semantics already exist conceptually: replay `sessions:list` +
  `sessions:transcript` + `terminal:attach` snapshot — the same boot sequence the
  renderer does today on window focus.

**Filtered surface.** Remote gets: `sessions:*`, `approvals:respond`, read-mostly
`git:*`, `fs:list/search/read`, `analytics:*`, `skills:list/read`,
`harness:availability/models`, and the read-only terminal view `terminal:list/screen` (P3.5,
step one: plain text, never attached, resized or typed into). Excluded or remapped: `window:*`,
`app:pickFolder`, `app:openPath`, `app:openInEditor`, `secrets:*`, `dialog` flows, terminal
input. The web client never touches or needs API keys.

## 6. Auth, pairing, trust — detailed plan

The desktop user is the root of trust. The web login proves *who you are* to the relay;
pairing proves *to the desktop* that a specific browser on a specific machine may act for
you. The relay is untrusted infrastructure: it routes frames and stores routing metadata
only. (Pattern: WhatsApp-Web / OAuth device grant, with the desktop user as the human
root of trust.)

### 6.1 Principles

1. **No pairing without a human at the desktop.** The code alone is never sufficient
   trust — the desktop-side confirm step is what makes a device binding.
2. **The relay cannot read session payloads.** It never holds private or shared
   session keys; it does hold plaintext pairing-code lookup keys, device metadata,
   refresh- and access-token hashes, a browser's freshly minted credential sealed to that
   browser's key until it polls, and encrypted blobs. A compromised relay can disrupt routing or
   pairing even though established e2e payloads remain unreadable.
   e2e is **mandatory in shipped builds, not a setting** (§11): no TLS-only mode ships;
   a dev-only client flag may bypass the AEAD layer for relay debugging.
3. **Per-device identity.** Every browser is its own device with its own keypair; trust
   and revocation are per-device, never per-account.
4. **Private keys never leave their machine.** Desktop keys live in the safeStorage-backed
   secrets store. A browser creates its keys **non-extractable** and keeps them as CryptoKeys in
   IndexedDB: page script can sign with them but never read them out. A pairing an older page left
   in `localStorage` is re-imported non-extractable once and the exportable copy deleted.
5. **Revocation and pause are distinct.** A paired device can be revoked at the relay.
   The desktop toggle closes its socket but leaves relay tokens and an uploaded mirror intact;
   the account-wide kill switch is Settings → Remote access → **Revoke all** (§6.5).

### 6.2 Identities and key material

| Party | Identity | Key material | Storage |
| --- | --- | --- | --- |
| Account | Single configured account id (`RELAY_ACCOUNT`); GitHub identity will gate `/app`, not isolate registry rows | passwordless gate planned | DO storage (Workers) |
| Desktop host | device id + human name ("Work PC") | P-256 ECDSA + ECDH | private JWK via `secrets.ts` (safeStorage) |
| Web device | device id + human name ("Chrome on Windows"), one per paired computer | P-256 ECDSA + ECDH | non-extractable CryptoKeys in IndexedDB |
| Relay | routing registry | public keys, refresh- and access-token hashes; an approved poll record holds the browser's credential sealed to its key, never in plaintext | DO storage (Workers) |

**Token model (live since 2026-09-25).** After pairing, each device holds a
random 256-bit **refresh credential**; the relay stores only its hash, and it authorizes no API
call by itself. To act, a device asks for a one-time challenge (`POST /v1/token/challenge`, the
refresh credential in Authorization), signs it with its device key
(`['relay.token', deviceId, challenge]`, domain-separated from handshake and approval signatures),
and trades the signature for an **access token** valid for an hour (`POST /v1/token`). Every REST
route and the desktop socket require that access token; a browser socket needs a 30-second,
single-use upgrade ticket bought with it. A stolen refresh credential without the private key gets
nothing, a leaked access token expires within the hour, and neither ever appears in a URL. A
challenge is spent by any attempt, a device keeps at most four live access tokens, and the
relay stores hashes of all of them. At pairing the browser's credential is **sealed to the ECDH
key it claimed with** (ECIES: ephemeral P-256 → HKDF-SHA-256 → AES-256-GCM, bound to the code and
device id), so what the relay holds until the claimant polls is ciphertext only that browser can
open. Pairings made under the previous long-lived bearer keep working: that token is their
refresh credential now.

v1 account model: **accounts-lite** — a single provisioned account, no signup or
billing flow. The device registry and routing are account-keyed from day one, so
productizing later means adding signup + billing, not rework.

**Status:** P0–P3 implemented. P0 transport extraction; P1 localhost web client + shims +
responsive shell; P2 relay + desktop host + e2e crypto + Settings UI + relay web client
(pairing, read-only browsing); P3 interactive remote chat — `sessions:send/interrupt/stop/
create/rename/setModel/setEffort/setPermissionMode` opened to paired clients, the web page
gained a composer, interrupt/stop controls and a native-dialog-free new-session flow
(folders come from the host's known folders, harnesses from live availability), and the
canonical-JSON bug that broke void-returning invoke results was fixed. P4 hardening is
implemented: a durable **audit trail** (pairing, approval, connection, revocation,
refused actions and mirror blocks in Settings → Remote access and `remote:get`),
**view-only mode** (a desktop policy that refuses every write channel at dispatch, shows a
web badge and hides write controls), **cross-client device management** (the web client
lists and revokes any paired device; the relay's `/devices` read is authenticated and
returns public metadata only), and the **offline encrypted transcript mirror** — opt-in on
the desktop, which seals an index plus per-session snapshots with a shared mirror key
(handed to each browser sealed inside the e2e session) and uploads them as opaque, bounded,
30-day-TTL blobs; the web client opens them locally and renders a read-only sidebar and
transcript while the desktop is unreachable. The relay's HTTP surface is now a
**deny-by-default route table** (`relay/src/routes.ts`): every route declares the auth it needs
(`public`/`enroll`/`device`/`web`/`host`), the dispatcher authorizes before the handler runs, and the
whole surface is unit-tested in plain Node (`tests/relay-routes.test.ts`) instead of relying on
review. The public pairing endpoints also carry in-memory fixed-window rate limits.
**Deployed.** The relay runs at `https://vocs-relay.vocs.workers.dev` (Worker + one Hub Durable
Object + the `ENROLL_TOKEN` secret), and the landing Worker at `code.vocs.io` forwards `/app`
and `/v1` — REST plus the WebSocket endpoints under `/v1/ws/*` — to it through a service binding — one origin, no CORS, no second DNS record
(vocs.io PR #18). Verified live: `/app/` serves the web client, `/v1/devices` is 401 without a
device token, `/v1/pair/start` is 403 without the enrollment secret and mints a code with it, and
an enrolling-host WebSocket opens while a bad token is refused.

A login gate is **not yet live**: `/app` is currently public. `remote.status` stays
`in-development` so landing CTAs remain inert until GitHub OAuth is provisioned, the
landing Worker gate is enabled and verified, and the direct Worker bypass is resolved.

Relay deploys run from **release tags**: `.github/workflows/deploy-relay.yml` publishes from the
`vX.Y.Z` tag the installers are built from, after approval in the protected `relay-production`
environment, so the production relay speaks the released desktop's protocol. `develop` merges
are not live until a release ships them.

**Live since 2026-09-25** (#407, deployed through that workflow; the live checklist and the
deployed smoke passed against `code.vocs.io`): the token model above; non-extractable browser
keys; a per-account device cap; the kill switch; mirror re-keying on revocation; QR pairing; the
multi-computer web client; tail-first transcripts; a read-only terminal view (P3.5, step one);
edge rate limits. Remaining: activate the login gate (needs a GitHub OAuth app for
`code.vocs.io`), then interactive terminal (P3.5 read/write). The login code lives in the
**landing Worker**, not the relay's `/v1` route table: the latter receives only paths stripped of
`/v1`. The gate is an access screen for the single account, not per-account isolation or a
replacement for paired-device authorization.

Implementation notes: crypto primitives are P-256 ECDSA + ECDH, HKDF-SHA-256 and
AES-256-GCM — all via WebCrypto so the identical module runs in Node and browsers with
zero new dependencies (the X25519/Ed25519/XChaCha choice in §6.2 needed a library; the
WebCrypto-universal set has the same trust properties and was adopted instead). A browser's
private keys are non-extractable CryptoKeys in IndexedDB; its refresh credential and the mirror
key sit beside them and are readable by page script, which is why the refresh credential alone
authorizes nothing. Pausing remote closes the outbound desktop socket but does not revoke relay
device tokens (the kill switch does). Revoking a browser re-keys the mirror (§6.5). v1 adds an
**enrollment secret** (`ENROLL_TOKEN`): a desktop presents it for its **first** pairing only, so
random parties cannot spam desktops with pairing prompts. An enrolled desktop pairs again as its
own device, so rotating the secret never strands it.

### 6.3 Pairing flow

```
Web (browser)                Relay                      Desktop (host)
      │                        │                            │
      │                        │ ◀─ enable, request code ──│  (1)
      │                        │── code MVBTK7Q2 ─────────▶│  (2)
      │  enter code / open URL │                            │
      │── {code, web_pub} ────▶│  (3)                       │
      │                        │── pairing request ────────▶│  (4)
      │                        │                            │  human: Allow / Deny
      │                        │ ◀───────── approved ───────│
      │◀── handshake blobs ────┼───────────────────────────▶│  (5) relay is blind
      │    K = ECDH(...)       │        K = ECDH(...)       │
      │◀═══════ AEAD frames under K, routed by relay ═════▶│  (6)
```

1. **Enable (desktop).** Settings → Remote access → paste the enrollment secret → Connect. The relay
   is not a setting: desktops always use `https://code.vocs.io` (`VOCS_CODE_RELAY_URL` points a
   development build or a test at another relay). Desktop generates its device keypair, stores the
   private half in the secrets store, connects outbound WSS to the relay, and requests a pairing
   code.
2. **Code.** Relay returns a single-use 8-character code (e.g. `MVBTK7Q2`, ~2^40 space, no
   ambiguous glyphs) with a **5-minute TTL**. The desktop shows it, a copyable link to the web
   client on the relay it is connected to (`<relay>/app?code=…`), and that link as a **QR code**
   (an in-house encoder, no runtime dependency). The link prefills the browser without claiming.
3. **Claim (web).** The browser enters/prefills the code, generates a non-extractable keypair,
   and posts `{code, web_public_key, device_name}`. `/v1/pair/claim` is public even when the
   landing login gate is enabled; knowing the code alone cannot approve pairing, but login is
   not checked here. Claims and polls are rate-limited at the Cloudflare edge before they reach
   the Hub, and again per address inside it; a full account (the device cap) is refused here.
4. **Confirm (desktop).** Relay pushes a pairing request to the desktop: account,
   device name, browser/OS. Desktop shows a confirm dialog — **Allow / Deny**. Deny or
   timeout expires the code; nothing is recorded. This is the deliberate redundancy: the
   code alone proves nothing, the human at the desktop does.
5. **Handshake (relay goes blind).** On approval, both sides run a Noise-XX-style
   handshake *through* the relay: mutual ECDH + verification of each other's signatures
   → shared symmetric key `K`. The relay sees public handshake metadata but never
   derives `K`.
6. **Live.** Every payload frame after that is AEAD-encrypted (AES-256-GCM) with
   `K`; receivers also enforce inbound counters against replay. The relay routes on
   `{account, device, seq}` metadata only: it can see *that* you chat, never *what*.

| Step | Why it exists |
| --- | --- |
| 5-min single-use code | Limits the claim window; desktop confirmation is still required if the code leaks |
| Desktop confirm prompt | Possession ≠ trust; the human approves the actual device |
| Per-device keypairs | Revoking one browser breaks nothing else; private keys never cross the wire |
| Tokens bound to signing keys | An access token is issued only for a signature by the device key; the refresh credential alone authorizes nothing |
| E2E under the relay | Established session payloads are opaque; a compromised relay can still deny service, misroute and manipulate pairing metadata |

### 6.4 What the relay stores

- Accounts, devices (id, name, platform, public keys, token hashes, last seen, status)
  — held in Durable Object storage on the existing vocs.io Cloudflare account.
- Routing state: which desktop is online for which account; short-lived queues of
  *encrypted* payloads pending delivery. One hashed, expiring, single-use
  WebSocket upgrade ticket per paired browser is also stored until consumed or replaced.
- Pairing codes, as plaintext lookup keys with an enforced TTL and single-use state. Hashing a
  40-bit code at rest would not resist offline guessing, and a code alone cannot pair (the
  desktop approves, and the credential is sealed to the claimant's key), so it is not done. The
  approved poll record holds the browser's credential **sealed** to the claimant until its
  five-minute expiry; refresh credentials, access tokens and socket tickets are stored as hashes.
- **Offline mirror blobs** (P4, opt-in): the sealed session index and transcript snapshots,
  keyed by `(account, host)`, capped at 200 sessions and 1.9M base64 characters per blob (a
  SQLite-backed Durable Object stores at most 2 MB per key and value) with a 30-day TTL, plus a
  per-host catalogue so pruning and clearing never load the blobs themselves. The
  key is generated on the desktop, stored in the OS keychain, and handed to each browser
  sealed inside its e2e session — the relay stores only IVs, ciphertext and plaintext
  routing metadata (session id, size, timestamp).
- **Never:** plaintext payloads, keys, transcripts.

### 6.5 Session lifecycle and revocation

- **Reconnect.** A device proves possession of its key for a fresh access token when the last
  one nears expiry; nothing else changes.
- **Revoke one device.** Desktop settings device list, or the web account page — either
  side invalidates the device at the relay and drops the route. The two are independent
  escape hatches (lost laptop → revoke from the desktop; lost desktop → revoke from web).
  Revoking a desktop also revokes the browsers paired with it and drops its mirror. Desktops
  reconcile their paired-browser lists against the relay's registry, and re-key the mirror a
  revoked browser could read.
- **Revoke all (the kill switch).** Settings → Remote access revokes every other device of the
  account — browsers and other computers — cancels pending pairing codes, drops revoked hosts'
  mirrors and re-keys this desktop's. The desktop keeps its identity and stays connected.
- **Pause remote access.** The toggle closes the desktop socket and drops live sessions; it does
  **not** invalidate relay tokens or delete a previously uploaded mirror (use Revoke all).
- **A revoked desktop** (its refresh credential rejected) keeps its identity and paired list and
  falls back to enrolling; re-pairing registers it again, and reconciliation drops browsers the
  relay no longer lists.
- **Audit.** Pairing, approval, revocation, and connection events land in the audit log
  (§8) with device name, timestamp, and action class.
- **Device cap.** Ten browsers and five computers per account, checked at claim and again inside
  the approval transaction; a full account answers `409 device-limit`.

### 6.6 Edge cases

| Case | Behavior |
| --- | --- |
| Code expires / wrong code | No device is minted; start over with a fresh code |
| Deny or ignore at desktop | Pairing never completes; web sees "request denied/expired" |
| Two browsers | Two devices, two pairings, both receive pushes; approvals resolve first-wins (§8.1) |
| Multiple paired desktops | Each pairing is its own browser device; the web client keeps them all and switches between them, showing which are online |
| Re-pair the same computer | The new pairing replaces the old one, and the old browser device is revoked |
| New browser on same machine | New pairing: fresh code + desktop confirm — no codeless/auto path in v1 (codeless-with-confirm is a v2 convenience) |
| Desktop reinstall / wiped userData | New desktop identity; revoke the old device from the web account page |
| Desktop offline during claim | No pending pairing request is queued in v1; the claim expires and must be restarted while the desktop is online |
| Replayed/late frames | AEAD authenticates content; host and web receiver counter checks reject duplicate or stale ciphertext |
| Lost device | Revoke from desktop or web account page to invalidate it at the relay; the desktop re-keys the mirror and re-uploads it, so the lost browser's old key opens nothing new |

### 6.7 UI touchpoints

- **Desktop Settings → Remote access:** the relay it uses (named, not editable), the enrollment
  secret, Connect/Disconnect, pairing code, link and QR code
  with countdown, paired-device list (name, platform, last seen) with per-device revoke,
  **Revoke all** kill switch, recent activity feed.
- **Confirm dialog:** account, device name, browser/OS, Allow / Deny — mirrors the
  existing approval-prompt styling (§5 of the approval flow, same pattern).
- **Web:** login will precede `/app`; today code entry, waiting-for-approval, a computer switcher
  with online state, Add a computer, device management and a read-only terminal view are in the
  web client.

### 6.8 Approvals ride signed, encrypted frames

Approval decisions (§5 filtered surface) travel inside the e2e channel and are signed
with the responding device's key. The desktop verifies the signature before resolving a
pending approval, so neither a stolen token nor a compromised relay can forge an approval
— tying directly into the §7 threat model.

### 6.9 Sizing

- Pairing itself (code + claim + confirm + handshake, both clients) ≈ **2–3 days inside
  P2**. The relay device registry + token service it requires is the real work (~1 wk).

The code + desktop confirmation decision is resolved; QR rendering remains an open
runtime-dependency decision (§11).

## 7. Threat model

This turns a local app into an internet-facing control plane for code execution — the
security bar must go up, not sideways:

- **Compromised web client → code exec on the user's machine.** Mitigations: device
  pairing with explicit desktop-side confirmation, per-device revocable tokens, approval
  parity (dangerous commands always prompt, even remotely — the existing invariant),
  timeout = default-deny on approvals, optional "view-only" remote mode, audit log.
- **Compromised/malicious relay → can it drive sessions?** Established e2e session
  frames and approval decisions are encrypted and signed by paired devices; the relay
  holds no session keys. It can still deny service, replay/misroute unauthenticated
  handshake metadata and interfere with pairing. The user's desktop confirmation and
  device identity checks matter; an access cookie alone does not secure the relay.
- **Desktop exposure.** Remote access is off by default, requires explicit opt-in,
  and shows a persistent indicator; the toggle closes active desktop sessions but
  does not revoke tokens or delete a stored mirror.
- **Transport.** TLS + e2e payload encryption; replayed ciphertext is rejected, and API access
  needs short-lived proof-of-possession tokens.

## 8. The honest list of hard problems

1. **Approval UX across two clients.** If desktop and web are both open, who sees the
   approval prompt? Both (first responder wins) with a presence system. Needs design.
2. **Two clients driving one session.** Concurrent typing into the same session needs
   rules (last-writer-wins on input, queued sends already exist — may be enough).
3. **Desktop offline.** Interactive features die gracefully; to make the web useful
   while offline, mirror encrypted transcripts to relay storage (opt-in) for read-only
   browsing. This is the main "make it feel always-on" investment.
4. **Terminal over WAN** (deferred to P3.5 — chat-first launch, §11). String frames +
   seq + ack flow control exist, but WAN latency and reconnect-mid-PTY need tuning
   (coalescing, larger ack windows, snapshot-on-reconnect).
5. **Transcript replay size.** The web client loads transcripts tail-first
   (`sessions:transcriptPage`, newest 150 items, Load earlier on demand) and coalesces refreshes
   during a streaming turn instead of replaying the whole transcript on every event.
6. **Secrets invariant.** Holds trivially in Model A (keys never leave the machine) —
   but it must be *tested*: no channel in the remote surface may ever resolve a secret.
7. **Platform bits.** ConPTY-specific terminal behavior, native notifications, and
   `app:open*` need browser-side shims or graceful degradation.

## 9. Cloud workspaces (Model B) — committed later track

When we go there, the pieces A builds are reused as-is: protocol, web client, auth,
pairing-less (server-side) trust. What's new:

- Per-user sandbox with the harness runtimes installed (Containers/Firecracker/VM —
  sizing per active session, not per user).
- Headless harness logins (device-code flows where CLIs support them).
- Server-side secrets with KMS; keys never in logs or transcripts (existing invariant).
- Folder onboarding via git clone + selective sync.
- Billing/metering per active minute; sandbox teardown and snapshot/restore.

This is a separate program (months, not weeks). Nothing in Model A is wasted.

## 10. Phasing and sizing

Assumes one engineer + agent assist; weeks are rough, sequencing matters more than dates.

| Phase | Scope | Size |
| --- | --- | --- |
| **P0 — Transport extraction** | `src/shared/transport.ts`; extract handler registry from `src/main/ipc.ts`; renderer `window.harness` rides on Transport; zero user-visible change; handler registry unit-tested in plain Node | ~1 wk |
| **P1 — Web client shell** | Build renderer as a plain SPA inside a distinct web shell: browser-native chrome (desktop titlebar/menu hidden), slim account/device header, code.vocs.io branding, responsive layout (drawer sidebar, touch targets); shims for paste/notify/openExternal/pickFolder; serve it from a localhost Node server wrapping the handler registry. Dogfood: run Vocs Code in a browser tab on the same machine | 3 wk |
| **P2 — Pairing + relay, read-only** | Relay service (accounts, devices, multi-host routing keyed by `(account, host)` — accounts-lite: single provisioned v1 account, account-keyed registry from day one); desktop remote host (opt-in, e2e encrypted); web login + pairing (§6); web bundle deployed to code.vocs.io; browse folders, sessions, transcripts across paired hosts | 2–3 wk |
| **P3 — Interactive** | Send prompts, remote approvals (presence, timeouts, audit), session lifecycle (create/stop/rename). No terminal in v1 (§11) | 2–4 wk |
| **P3.5 — Terminal over WAN** (post-launch) | Read-only first, then read/write; PTY streaming + flow-control tuning (coalescing, ack windows, reconnect mid-PTY) | 1–2 wk |
| **P4 — Hardening** | Multi-device management + revocation UI, offline encrypted transcript mirror (read-only), audit log surface, view-only mode | 2–4 wk |

**Relay MVP → beta: roughly 8–11 weeks (chat-first; terminal lands in P3.5 after).**
Cloud workspaces: separate track afterward.

**Status:** P0 implemented — transport extraction (`src/shared/transport.ts`,
`src/main/handlers.ts`, registry tests). P1 implemented — localhost web server +
WebSocket transport (`VOCS_CODE_WEB=1`, per-boot token), browser shims (openExternal,
notify, pickFolder, clipboard paste), web badge, and the responsive layer (drawer
sidebar with backdrop, touch targets under 900px). Remaining before P2: packaged-app
static-path check; the relay-side account/pairing header is P2 scope.

## 11. Decisions and open questions

**Resolved:**

- **Which model?** Model C (hybrid) — build A (relay) first; cloud workspaces (B) is the
  committed later track (§9).
- **Is "desktop must be online for chat" acceptable for v1?** Yes — implied by starting
  with Model A; always-on arrives with cloud workspaces later.
- **Personal first, product later.** The relay and protocol are multi-tenant-capable
  structurally account-keyed, but the deployed Hub uses one `RELAY_ACCOUNT` and one
  provisioned account without per-account isolation or billing. Full auth + billing becomes the P4 → cloud-track on-ramp,
  not P2 scope.

- **Chat-first launch.** v1 remote is chat + transcript + approvals — no terminal in
  the web client. Terminal over WAN is deferred to P3.5 (read-only first, then
  read/write): skips the hardest WAN tuning on the critical path and keeps the phone UX
  clean. The agent still runs commands in the workspace either way; deferred is the
  human typing into their own shell remotely.

- **e2e encryption: default and mandatory.** The §6.3 handshake is not a setting; every
  paired session is end-to-end encrypted in shipped builds — the relay cannot read or
  forge established session payloads. It can still disrupt pairing and availability.
  Relay-side debugging is metadata-only; a dev-only client flag may bypass the
  AEAD layer during development, never shipped as a user-facing toggle.

- **Distinct web identity.** The web client is a dedicated web shell around the reused
  renderer core: browser-native chrome (desktop titlebar/menu hidden in web builds), a
  slim account/device header, code.vocs.io branding. The renderer underneath is
  unchanged; the shell carries the identity. Branding deepens with the cloud track.

- **One origin: landing at the root, app under `/app`.** `code.vocs.io` is the landing page;
  a login gates the web client, which lives at `code.vocs.io/app` and talks to the relay at
  `/v1` (REST and `/v1/ws/*` sockets) on that same origin. Cloudflare binds a hostname to one
  Worker, and path routes to a second Worker on the same host depend on route precedence, so
  the landing Worker keeps the custom domain and forwards the app paths to the relay through a
  service binding instead. One origin means one cookie scope, no CORS, and no second DNS
  record. The earlier `app.code.vocs.io` split is dropped.

- **Fully responsive from day one.** The web client is responsive at launch: sidebar
  collapses to a drawer, panels adapt, touch-friendly targets. The renderer's
  desktop-laid-out styles get a responsive layer under P1/P3 — phones are a first-class
  remote surface, not a degraded view.

**Open (resolve one at a time, before P2):**

Pairing-level questions from §6.9:

- **QR rendering: resolved.** An in-house encoder (`src/shared/qr.ts`, byte mode, all versions
  and error-correction levels) renders the link; `jsqr` is a dev-only decoder in its tests. No
  runtime dependency was added.

**Open (resolve one at a time, before P2):**

- **Code + confirm, always.** Every pairing — including later devices — needs a fresh
  code and the desktop-side Allow. Codeless pairing (logged-in request, desktop still
  confirms) is the deliberate v2 convenience; silent auto-approve never ships (§6.1
  principle 1).

**Open (resolve one at a time, before P2):**

- **Relay on Cloudflare Workers + Durable Objects** (vocs.io already runs on
  Cloudflare). One Hub DO per account, WebSocket-native with hibernation for idle
  sockets; a multi-account tenancy migration remains §2.7 of the roadmap.

- **GitHub-only auth in v1.** Passwordless, no email infrastructure, and the audience
  is coders — a GitHub account is a given. v1 allowlists the provisioned account at the
  provider. The auth provider is a swappable module (the registry is account-keyed);
  email magic-link arrives with signup + billing at productization.

**Open today:** live OAuth setup and gate verification, the production deploy and deployed smoke,
interactive terminal, and the checks listed in [the roadmap](./REMOTE-ACCESS-ROADMAP.md). The
original P0 sketch (§12) is historical.

## 12. The first PR (P0 sketch)

Status: **P0 is implemented** — `src/shared/transport.ts` (Transport interface, the type
behind `window.harness`), `src/main/handlers.ts` (the Electron-free registry),
`src/main/ipc.ts` (binds it to `ipcMain` + supplies the DesktopBridge), and
`tests/handler-registry.test.ts` (registry driven in plain Node). The renderer and the
IPC contract are unchanged.

1. Add `src/shared/transport.ts` — `Transport` interface + a typed client generated from
   the existing channel maps in `src/shared/ipc.ts`.
2. Refactor `src/main/ipc.ts` — extract `createHandlerRegistry(deps)`; `ipcMain.handle`
   bindings consume it; behavior identical.
3. Renderer — `window.harness` becomes a wrapper over `Transport`; **zero call-site
   changes** across the renderer.
4. Tests — the handler registry runs in plain Node (the core already has no Electron
   imports); add a suite driving sessions/terminal through the registry directly.
5. `npm run typecheck`, `npm test`, `npm run build` must stay green; existing suites
   (including `tests/review-fixes.test.ts`) untouched in behavior.

P0 has no user-visible change and no new dependencies — it is pure de-risking, and every
later phase (including cloud workspaces) stands on it.