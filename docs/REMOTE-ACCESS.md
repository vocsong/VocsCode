# Remote access: code.vocs.io (exploration)

Status: **ideation / planning** — not a committed roadmap. This doc maps the idea, the
shapes it could take, what the codebase already gives us, the hard problems, and a
phased path if we decide to build.

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

## 2. Three shapes

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

### Model C — Hybrid (recommended path)

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
   Small stateless-ish service; one connection per desktop, N per account.
3. **Web client** — `code.vocs.io`: the existing renderer built for the browser with a
   different `window.harness` transport, plus account/pairing screens and a few shims.

Key idea: **the web client is the existing renderer with a different transport.** The
less the renderer knows about how `window.harness` is backed, the more is reused.

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
  correlation; push channels arrive as server-initiated frames.
- On the desktop, extract the handler map from `src/main/ipc.ts` into a
  transport-agnostic registry keyed by channel; `ipcMain` binding and the WS server both
  bind the same registry. Handler logic stays identical.
- Reconnect semantics already exist conceptually: replay `sessions:list` +
  `sessions:transcript` + `terminal:attach` snapshot — the same boot sequence the
  renderer does today on window focus.

**Filtered surface.** Remote gets: `sessions:*`, `approvals:respond`, `terminal:*`,
read-mostly `git:*`, `fs:list/search/read`, `analytics:*`, `skills:list/read`,
`harness:availability/models`. Excluded or remapped: `window:*`, `app:pickFolder`,
`app:openPath`, `app:openInEditor`, `secrets:*`, `dialog` flows. The web client never
touches or needs API keys.

## 6. Auth, pairing, trust — detailed plan

The desktop user is the root of trust. The web login proves *who you are* to the relay;
pairing proves *to the desktop* that a specific browser on a specific machine may act for
you. The relay is untrusted infrastructure: it routes frames and stores routing metadata
only. (Pattern: WhatsApp-Web / OAuth device grant, with the desktop user as the human
root of trust.)

### 6.1 Principles

1. **No pairing without a human at the desktop.** The code alone is never sufficient
   trust — the desktop-side confirm step is what makes a device binding.
2. **The relay is blind.** It never holds private keys, shared keys, or plaintext
   payloads. Compromise of the relay yields routing metadata and opaque blobs only.
3. **Per-device identity.** Every browser is its own device with its own keypair; trust
   and revocation are per-device, never per-account.
4. **Private keys never leave their machine.** Desktop keys live in the existing
   safeStorage-backed secrets store; web keys are non-extractable WebCrypto keys in
   IndexedDB.
5. **Everything is revocable.** One toggle kills remote access entirely; each device is
   individually revocable from desktop or web.

### 6.2 Identities and key material

| Party | Identity | Key material | Storage |
| --- | --- | --- | --- |
| Account | code.vocs.io user id (GitHub OAuth; email fallback) | passwordless | relay DB |
| Desktop host | device id + human name ("Work PC") | Ed25519 signing + X25519 key-agreement keypair | private half via `secrets.ts` (safeStorage) |
| Web device | device id + human name ("Chrome on Windows") | Ed25519 signing + X25519 key-agreement keypair | non-extractable WebCrypto (IndexedDB) |
| Relay | routing registry | public keys + token **hashes** only | relay DB |

Token model: after pairing, both sides hold a random 256-bit refresh token (relay stores
only its hash) plus short-lived (~1 h) access tokens bound to the device's public key.
Refreshing = signing a relay-issued challenge with the device key (proof of possession).
A stolen token without the private key is useless.

### 6.3 Pairing flow

```
Web (browser)                Relay                      Desktop (host)
      │                        │                            │
      │                        │ ◀─ enable, request code ──│  (1)
      │                        │── code MVBT-K7Q2 ────────▶│  (2)
      │  enter code / scan QR  │                            │
      │── {code, web_pub} ────▶│  (3)                       │
      │                        │── pairing request ────────▶│  (4)
      │                        │                            │  human: Allow / Deny
      │                        │ ◀───────── approved ───────│
      │◀── handshake blobs ────┼───────────────────────────▶│  (5) relay is blind
      │    K = ECDH(...)       │        K = ECDH(...)       │
      │◀═══════ AEAD frames under K, routed by relay ═════▶│  (6)
```

1. **Enable (desktop).** Settings → Remote access → Enable. Desktop generates its device
   keypair, stores the private half in the secrets store, connects outbound WSS to the
   relay, and requests a pairing code.
2. **Code.** Relay returns a single-use code (`MVBT-K7Q2`, ~2^40 space, 8 chars from a
   32-symbol alphabet — no ambiguous glyphs) with a **5-minute TTL**, plus a QR payload
   (`https://code.vocs.io/pair?code=…`). Desktop shows code + QR and a status line.
3. **Claim (web).** Logged-in user opens "Add a computer", enters the code or scans the
   QR. The browser generates its keypair and posts `{code, web_public_key, device_name}`
   to the relay. Relay rate-limits attempts per account/IP (the TTL plus single-use
   already makes brute force impractical; rate limiting is defense in depth).
4. **Confirm (desktop).** Relay pushes a pairing request to the desktop: account,
   device name, browser/OS. Desktop shows a confirm dialog — **Allow / Deny**. Deny or
   timeout expires the code; nothing is recorded. This is the deliberate redundancy: the
   code alone proves nothing, the human at the desktop does.
5. **Handshake (relay goes blind).** On approval, both sides run a Noise-XX-style
   handshake *through* the relay: mutual ECDH + verification of each other's signatures
   → shared symmetric key `K`. The relay shuttles opaque handshake blobs only — it never
   sees `K`.
6. **Live.** Every payload frame after that is AEAD-encrypted (XChaCha20-Poly1305) with
   `K`, with per-direction counters for replay protection. The relay routes on
   `{account, device, seq}` metadata only: it can see *that* you chat, never *what*.

| Step | Why it exists |
| --- | --- |
| 5-min single-use code | A stale or shoulder-surfed code is worthless |
| Desktop confirm prompt | Possession ≠ trust; the human approves the actual device |
| Per-device keypairs | Revoking one browser breaks nothing else; private keys never cross the wire |
| Tokens bound to signing keys | A stolen token alone is useless without the device key |
| E2E under the relay | Relay compromise = timing metadata only; cannot read or forge |

### 6.4 What the relay stores

- Accounts, devices (id, name, platform, public keys, token hashes, last seen, status).
- Routing state: which desktop is online for which account; short-lived queues of
  *encrypted* payloads pending delivery.
- Pairing codes (hashed, TTL'd, single-use).
- **Never:** plaintext payloads, keys, transcripts. (The offline transcript mirror, if
  enabled later (§8.3), is stored encrypted under a key derived from the pairing — still
  opaque to the relay.)

### 6.5 Session lifecycle and revocation

- **Reconnect.** Tokens are refreshed by signing relay challenges; a device key that is
  gone (cleared IndexedDB, new browser profile) simply fails refresh → new pairing.
- **Revoke one device.** Desktop settings device list, or the web account page — either
  side invalidates the token at the relay and drops the route. The two are independent
  escape hatches (lost laptop → revoke from the desktop; lost desktop → revoke from web).
- **Pause remote access.** One toggle on the desktop invalidates all tokens and drops all
  routes; the persistent "remote connected" indicator is the same surface.
- **Audit.** Pairing, approval, revocation, and connection events land in the audit log
  (§8) with device name, timestamp, and action class.
- **Device cap.** Start with a small per-account device limit (e.g. 10) to bound abuse.

### 6.6 Edge cases

| Case | Behavior |
| --- | --- |
| Code expires / wrong code | Nothing is recorded; start over with a fresh code |
| Deny or ignore at desktop | Pairing never completes; web sees "request denied/expired" |
| Two browsers | Two devices, two pairings, both receive pushes; approvals resolve first-wins (§8.1) |
| New browser on same machine | New pairing, fresh code — no auto-approve in v1 |
| Desktop reinstall / wiped userData | New desktop identity; revoke the old device from the web account page |
| Desktop offline during claim | Relay queues the pairing request for the code TTL; expires after |
| Replayed/late frames | Per-direction AEAD counters; replayed frames fail decryption and drop |
| Lost device | Revoke from desktop or web account page; token dead, key never had value without the token |

### 6.7 UI touchpoints

- **Desktop Settings → Remote access:** enable/disable toggle, pairing code + QR display
  with countdown, paired-device list (name, platform, last seen) with per-device revoke,
  "pause all" kill switch, recent activity feed.
- **Confirm dialog:** account, device name, browser/OS, Allow / Deny — mirrors the
  existing approval-prompt styling (§5 of the approval flow, same pattern).
- **Web:** login → "Add a computer" → code entry → waiting-for-approval state → device
  connected. Account page lists paired desktops with last-seen + revoke.

### 6.8 Approvals ride signed, encrypted frames

Approval decisions (§5 filtered surface) travel inside the e2e channel and are signed
with the responding device's key. The desktop verifies the signature before resolving a
pending approval, so neither a stolen token nor a compromised relay can forge an approval
— tying directly into the §7 threat model.

### 6.9 Sizing and open questions

- Pairing itself (code + claim + confirm + handshake, both clients) ≈ **2–3 days inside
  P2**. The relay device registry + token service it requires is the real work (~1 wk).
- Open: QR code mandatory or optional? Auto-approve subsequent devices for a known
  account (later convenience, v1: no)? Where is the relay hosted (region/data-residency
  requirements)? Email fallback auth in v1 or GitHub-only?

## 7. Threat model

This turns a local app into an internet-facing control plane for code execution — the
security bar must go up, not sideways:

- **Compromised web client → code exec on the user's machine.** Mitigations: device
  pairing with explicit desktop-side confirmation, per-device revocable tokens, approval
  parity (dangerous commands always prompt, even remotely — the existing invariant),
  timeout = default-deny on approvals, optional "view-only" remote mode, audit log.
- **Compromised/malicious relay → can it drive sessions?** With e2e encryption the relay
  can only route opaque frames; it cannot forge approved actions because decisions are
  signed inside the encrypted channel. Relay holds no keys.
- **Desktop exposure.** Remote access is off by default, requires explicit opt-in,
  shows a persistent indicator when connected, and one click kills all remote sessions.
- **Transport.** TLS + e2e payload encryption; replay-resistant framing (nonce/counter);
  short-lived tokens refreshed over the paired channel.

## 8. The honest list of hard problems

1. **Approval UX across two clients.** If desktop and web are both open, who sees the
   approval prompt? Both (first responder wins) with a presence system. Needs design.
2. **Two clients driving one session.** Concurrent typing into the same session needs
   rules (last-writer-wins on input, queued sends already exist — may be enough).
3. **Desktop offline.** Interactive features die gracefully; to make the web useful
   while offline, mirror encrypted transcripts to relay storage (opt-in) for read-only
   browsing. This is the main "make it feel always-on" investment.
4. **Terminal over WAN.** String frames + seq + ack flow control exist, but WAN latency
   and reconnect-mid-PTY need tuning (coalescing, larger ack windows, snapshot-on-reconnect).
5. **Transcript replay size.** Long sessions replay fully over the socket today (fine on
   IPC, different on mobile). Will need pagination / tail-first loading in the web client.
6. **Secrets invariant.** Holds trivially in Model A (keys never leave the machine) —
   but it must be *tested*: no channel in the remote surface may ever resolve a secret.
7. **Platform bits.** ConPTY-specific terminal behavior, native notifications, and
   `app:open*` need browser-side shims or graceful degradation.

## 9. Cloud workspaces (Model B) — later track

When/if we go there, the pieces A builds are reused as-is: protocol, web client, auth,
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
| **P1 — Web-buildable renderer** | Build renderer as a plain SPA; shims for paste/notify/openExternal/pickFolder; serve it from a localhost Node server wrapping the handler registry. Dogfood: run Vocs Code in a browser tab on the same machine | 1–2 wk |
| **P2 — Pairing + relay, read-only** | Relay service (accounts, devices, routing); desktop remote host (opt-in, e2e encrypted); web login + pairing (§6); browse folders, sessions, transcripts live | 2–3 wk |
| **P3 — Interactive** | Send prompts, remote approvals (presence, timeouts, audit), terminal read/write over WAN, session lifecycle (create/stop/rename) | 3–5 wk |
| **P4 — Hardening** | Multi-device management + revocation UI, offline encrypted transcript mirror (read-only), audit log surface, terminal WAN tuning, view-only mode | 2–4 wk |

**Relay MVP → beta: roughly 6–10 weeks.** Cloud workspaces: separate track afterward.

## 11. Open questions (need product answers before P2)

1. Personal tool first, or multi-user product from day one? (drives auth, billing, relay
   tenancy, and how paranoid the pairing UX must be)
2. Is "desktop must be online for chat" acceptable for v1? (Model A's core constraint)
3. Is interactive terminal required at launch, or is chat + transcript + approvals enough?
4. e2e encryption as default, or opt-in?
5. Does the web client get a distinct visual identity, or is it the same UI in a tab?
6. Mobile: is phone-sized layout in scope for v1? (renderer is desktop-laid-out today)

## 12. If we start: the first PR (P0 sketch)

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