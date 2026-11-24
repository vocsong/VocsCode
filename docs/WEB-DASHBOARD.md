# Unified analytics dashboard on code.vocs.io

Status: **spec and plan, not implemented.** Agreed with the owner on 2026-11-24. The web remote
client at `code.vocs.io/app` is replaced by a signed-in analytics dashboard at
`code.vocs.io/dashboard` that combines every Vocs Code computer on the account. The
assistant chat that later replaces remote session control is a separate track (the MCP and Dots
work); nothing here builds it.

## 1. Decisions of record

| # | Question | Decision |
| --- | --- | --- |
| 1 | How data reaches the web | Each desktop **uploads a snapshot** to its account on the relay. Signing in with Vocs Login is enough to see every computer, including ones that are asleep or off. The relay can read the aggregates (Cloudflare encrypts at rest). This is not end-to-end encryption. |
| 2 | The existing web remote client | **Removed** (session view, composer, terminal, browser pairing). The relay's pairing, mirror and control endpoints stay for now; the MCP track may build on them. |
| 3 | What leaves the machine | Desktop parity **minus raw paths**. Projects go by folder name. Session titles stay. Per-file paths are not uploaded. |
| 4 | Projects on several computers | **Merged by folder name**, with a per-computer split. A same-name clash between unrelated projects is an accepted edge case. |
| 5 | Desktop Analytics screen | **Unchanged** (local only). The combined view is web only. A combined view on the desktop is a possible follow-up. |
| 6 | Upload default | **On** for every computer connected through Connect with Vocs. A Settings toggle turns it off. Turning it off, disconnecting or revoking the computer deletes that computer's data on the relay. |
| 7 | Dashboard content | **Same tabs as the desktop** (Overview, Spend, Tokens, Activity, Tools, Sessions, Reliability, Code) and the same ranges (7, 30, 90 days, All time). Adds a computer switcher and a by-computer breakdown. Must work on a phone. |
| 8 | `code.vocs.io/` | Signed-out visitors see the landing page; its Sign in button goes to the dashboard. **Signed-in visitors are redirected to `/dashboard`.** |
| 9 | Path | The page lives at **`/dashboard`**. `/app` and `/app/*` permanently redirect there, keeping the query string, because released desktops open `/app?connect=…` for Connect with Vocs. |

## 2. What the user sees

- **Header:** account menu (sign out), a computer switcher (**All computers** · each computer with
  an online dot and "synced 4 min ago"), the range picker, and the tabs.
- **Computers strip** (on Overview): one card per computer showing name, platform, online/offline
  (relay presence), last sync, app version, and states for "sharing off", "never synced" and "stale" (no sync for over
  24 h while online).
- **All computers:** totals add up across computers. Overview, Spend, Tokens and Activity gain a
  **Computer** breakdown (series stacked by computer). Project rows merge by folder name;
  hovering or opening one shows the per-computer split.
- **Sessions tab:** title, computer, project folder, harness/model, cost, tokens. There is no click-through, because
  web session view is gone.
- **Reliability tab:** reports cannot be summed (Wilson intervals, percentiles, incidents). In
  **All computers** it compares the computers side by side; for a single computer it shows that computer's report. The
  execution drill-down (`analytics:executions`) is desktop-only and hidden on the web.
- **Code tab:** additive counts (lines added/removed by day, project, harness) are summed across computers. There is no file list.
- **Empty state:** no connected computers → explain Connect with Vocs (desktop Settings → Remote access).
- **Connect screen:** `/dashboard?connect=<nonceHash>` keeps today's approve-this-computer step, so desktops can still register.
- Days are **UTC**, as on the desktop.

## 3. Snapshot format

Built on the desktop from `AnalyticsFile` and the computed reports by an allowlist projection; nothing is copied through by default.

**Uploaded**

- `meta`: `schemaVersion`, `generatedAt`, `appVersion`, platform. The computer name comes from the
  relay's device record, not the snapshot.
- `days`: `UsageDay` per UTC date with `by.harness`, `by.model`, `by.harnessModel`,
  `by.project`, `by.tool`, `by.modelTool`, `by.harnessTool`, `by.harnessModelTool`.
  `by.project` is re-keyed to the folder **basename**. `by.file` is dropped.
- `sessions`: `id`, `title`, `harness`, `provider`, `model`, `projectRoot` (holding the folder
  name only), `createdAt`, `updatedAt`, `usage`, `toolCalls`, `durationMs`, `speed`.
- Tool maps: `tools`, `modelTools`, `harnessTools`, `harnessModelTools`.
- `reports[range]` for 7, 30, 90 and 0: `reliability` and `codeOutput`. Reliability project rows
  are cut to folder names, executable rows and signature fields that contain a slash or backslash
  to their last segment, and signature `examples` (execution ids) are dropped.

**Never uploaded:** `files`, absolute project roots, delta baselines (`recorded`), replay receipts
(`recordedTools`, `recordedUserInputs`), the execution log, transcripts, prompts.

**Partitioning.** A Durable Object value is capped near 2 MB and the production `analytics.json` is
7.1 MB and unbounded. The snapshot is therefore split into gzip-compressed parts:

- one part per month of `days`;
- one part per month of `sessions`, keyed by `createdAt`;
- one `reports` part;
- one `tools` part;
- a `manifest` listing each part's id, content hash and byte size.

The desktop uploads only parts whose hash changed, then the manifest last. A reader never sees a
manifest that points at a missing part. A part over the cap is a hard error with a test, not
a silent truncation.

**Merge (browser).** Sum `UsageDay` by date with the existing `usage-rollup` helpers. Union slice
session lists. Prefix session ids with the host id, because ids are only unique per machine.
Compute totals **per computer first** (summarize takes the max of session and day totals),
then add the computers together. Run the shared `summarize` once over the merged data. Add a
`byComputer` dimension.

## 4. Relay

New routes, added to both `relay/src/routes.ts` and the edge allowlist in `relay/src/edge.ts`:

| Route | Auth | Purpose |
| --- | --- | --- |
| `PUT /v1/analytics/part/:id` | host (access token) | Store one compressed part, at most 1.9 MB |
| `PUT /v1/analytics/manifest` | host | Commit the manifest; prune parts it no longer lists |
| `DELETE /v1/analytics` | host | Remove this computer's snapshot (sharing turned off) |
| `GET /v1/owner/analytics` | owner (account assertion) | Hosts on the account with manifests, name, platform, online, last seen |
| `GET /v1/owner/analytics/:host/part/:id` | owner | One part |

- Keys: `analytics:${accountId}:${hostId}:manifest` and `…:part:${id}`. Account isolation follows
  the existing per-account Hub.
- `revokeDevice` / `revokeAllExcept` clear the analytics keys alongside the mirror.
- The landing already proxies `/v1/owner/*` with the account assertion. Confirm that the new
  routes need no landing change beyond that.
- Rate limits: one manifest write per host per minute; bulk part writes follow the mirror precedent.

## 5. Desktop

- **Uploader:** a new `src/main/remote/analytics-sync.ts`. It runs when `remote.enabled` is
  set and the computer is enrolled, because credentials load only then. It syncs once after
  connecting, then on analytics changes (debounced about 2 minutes) and hourly as a heartbeat.
  It uses `host.relayFetch` / `accessToken()` as the mirror does.
- **Setting:** `remote.shareAnalytics`, default `true`. Settings → Remote access gets a "Share
  analytics with code.vocs.io" toggle with a one-line disclosure of what is uploaded. Off →
  `DELETE /v1/analytics`.
- **Connect link:** `connectLink()` (`src/shared/pairing.ts`) points at `/dashboard?connect=`.
- **Remote panel cleanup:** remove the browser-pairing link/QR, the paired-browser list and the
  transcript-mirror toggle. Keep **External MCP control** (`ControlSettings`) and anything the MCP
  track depends on. Stop mirror uploads and send a one-time `DELETE /v1/mirror` on upgrade.

## 6. Web (`src/web`)

- Replace the shell with the dashboard. Keep `ConnectScreen` and the enroll-grant call in
  `relay/src/web-client.ts`; delete the screens, sheets, terminal and transport used only by remote
  session control.
- Extract a pure `AnalyticsView` from `AnalyticsDashboard.tsx` that takes a summary plus
  capability flags (`drillDown`, `liveSessions`). The desktop wraps it with `invoke`, the web wraps
  it with the relay fetch. `ReliabilityTab` drill-down and `SessionsTab`'s live-store lookup
  become optional props.
- Move `summarize` and its helpers out of `src/main/analytics.ts` into `src/shared/analytics/`
  (browser-safe). The desktop keeps calling the same function.
- Build: `vite.config.web.ts` `base: '/dashboard/'`, output `relay/public/dashboard`;
  `relay/public/_headers` CSP moves with it. The relay serves `/app*` as a 301 to `/dashboard*`
  with the query preserved.

## 7. Landing (`vocs.io` repo, `code/worker`)

- Gate and proxy `/dashboard` and `/dashboard/*` exactly as `/app` is today.
- Signed-in `GET /` → 302 `/dashboard`. `/` is currently a static asset, so add it to
  `run_worker_first` and fall through to the asset when signed out.
- Sign in button and post-login default `next` → `/dashboard`.
- The landing `code/` tree was found only in `vocs.io` worktrees, not on its `develop`. Confirm
  the live source branch before editing.

## 8. Delivery plan

Each step is one PR into `develop`, independently reviewable.

1. **Shared aggregation and snapshot (no behavior change).** Move `summarize` to shared; add
   `buildAnalyticsSnapshot`, partitioning and `mergeSnapshots`. Tests: desktop summary output
   unchanged on a fixture, a privacy test that the serialized snapshot contains no absolute path,
   no `files` and no receipts, merge tests (per-computer totals then sum, folder-name merge,
   session-id prefix, UTC days), and part-size enforcement.
2. **Relay storage and routes.** Routes, edge allowlist, revoke cleanup, manifest commit and prune.
   Tests: `relay-routes`, `relay-edge`, `relay-core`, `test:relay-do`, `remote-workerd`; account
   isolation (account B cannot read A), host cannot write another host's keys, revoke clears data.
3. **Desktop uploader and setting.** `analytics-sync`, `remote.shareAnalytics`, toggle UI. Tests:
   uploads only changed parts, manifest last, toggle off deletes, not running when not enrolled,
   restart does not re-upload unchanged parts; `e2e.remote` updated for the toggle.
4. **Web dashboard replaces the remote client.** `AnalyticsView` extraction, new web shell, deletion
   of the remote client, `/dashboard` build, `/app` redirect, `connectLink`, Remote panel cleanup.
   Tests: renderer analytics tests still pass on the extracted view, web dashboard tests for the
   switcher, by-computer breakdown, stale and empty states, Connect screen; `e2e.remote-web` is
   rewritten as a dashboard suite against local workerd with two seeded hosts; web-only tests for
   deleted code are removed with it.
5. **Landing.** `/dashboard` gate and proxy, signed-in `/` redirect, Sign in target. Landing Worker tests.

**Rollout order.** The landing change that proxies `/dashboard` (step 5's first half) deploys first.
It is harmless while the relay has no `/dashboard`. Then a Vocs Code release deploys the relay
(steps 1–4) through `deploy-relay`. Then the landing's signed-in `/` redirect. Update desktops so
they upload; until then their cards read "never synced". Run Appendix A of
[REMOTE-ACCESS-ROADMAP.md](REMOTE-ACCESS-ROADMAP.md) with `/dashboard` substituted.

## 9. Coordination and open items

- **MCP / Dots track** edits `relay/src/routes.ts`, `edge.ts` and the Remote panel too. Rebase
  carefully, and do not remove relay pairing, mirror or control endpoints in this track.
- **Dev profile:** a `Vocs Code (Dev)` build connected to the production relay appears as its own
  computer. Default: it shares like any other; the card shows "(Dev)".
- Docs to update as the steps land: [REMOTE-ACCESS.md](REMOTE-ACCESS.md),
  [REMOTE-ACCESS-ROADMAP.md](REMOTE-ACCESS-ROADMAP.md) (status snapshot, test map), [TESTING.md](TESTING.md).
