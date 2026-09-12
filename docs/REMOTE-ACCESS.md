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

## 6. Auth, pairing, trust

- **Account** on code.vocs.io (GitHub OAuth is the natural fit for a dev tool; email as
  fallback).
- **Pairing** (device authorization flow, like SSH agent trust):
  1. Desktop: Settings → Remote access → Enable → shows a short pairing code + QR
     (valid ~5 minutes).
  2. Web: log in → "Add computer" → enter code.
  3. Relay links the desktop to the account; desktop issues a per-device credential.
  4. Both sides derive a symmetric key from the pairing exchange; **all payload frames
     are end-to-end encrypted** — the relay sees routing metadata only, never content.
- **Devices are revocable** (desktop settings lists paired devices, kill switch is the
  same toggle). Every remote action lands in an audit log.

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
| **P2 — Pairing + relay, read-only** | Relay service (accounts, devices, routing); desktop remote host (opt-in, e2e encrypted); web login + pairing; browse folders, sessions, transcripts live | 2–3 wk |
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