# Unified analytics dashboard on code.vocs.io

Status: **live since v0.12.0.** The signed-in dashboard at `code.vocs.io/dashboard` replaced the
browser remote client and combines analytics from every Vocs Code computer on the account. The
remaining desktop Remote panel cleanup and the assistant/control plane are separate work.

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

- **Header:** the same Vocs Code wordmark, frosted bar and product switcher as the public site, with
  an account name and sign out. The workspace puts the computer scope (**All computers** or a
  sharing computer), date range and Refresh above the reports. The page refreshes itself every
  minute while visible.
- **Computers strip:** one card per computer on the account showing name, platform, online/offline
  (relay presence), app version, "Synced 4 min ago" or "Not sharing analytics yet", spend in the
  range, and a "stale" flag when an online computer has not synced for over 24 h. Clicking a card
  with analytics selects that computer; clicking it again goes back to all.
- **All computers:** totals add up across computers. Overview and Spend gain a **Spend by
  computer** chart, Tokens a tokens one and Activity a turns one (columns stacked by computer).
  Project rows merge by folder name.
- **Sessions tab:** title, computer, project folder, harness/model, cost, tokens. There is no click-through, because
  web session view is gone.
- **Reliability tab:** reports cannot be summed (Wilson intervals, percentiles, incidents). In
  **All computers** it compares the computers side by side; for a single computer it shows that computer's report. The
  execution drill-down (`analytics:executions`) is desktop-only and hidden on the web.
- **Code tab:** like Reliability, its rates (lines per million tokens, cost per thousand lines) do
  not add up, so **All computers** shows each computer's report in turn. There is no file list.
- **Empty state:** no connected computers → explain Connect with Vocs (desktop Settings → Remote access).
- **Connect screen:** `/dashboard?connect=<nonceHash>` keeps the approve-this-computer step, so
  desktops can still register. It no longer pairs the browser: once the computer has collected its
  credential, the page offers the dashboard.
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
then add the computers together. Run the shared `summarize` once over the merged data. The per-computer summaries
(`combineSnapshots(...).computers`) drive the cards, the by-computer charts and the per-computer
Reliability and Code sections.

## 4. Relay

New routes, added to both `relay/src/routes.ts` and the edge allowlist in `relay/src/edge.ts`:

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /v1/analytics` | host (access token) | This computer's committed manifest, so a restart skips unchanged parts |
| `PUT /v1/analytics/part?id=` | host | Store one part: `{hash, data}` with gzip JSON in base64, at most 1.4 MB compressed |
| `PUT /v1/analytics/manifest` | host | Commit a manifest whose every part is stored with that hash; drop parts it no longer lists |
| `DELETE /v1/analytics` | host | Remove this computer's snapshot (sharing turned off) |
| `GET /v1/owner/analytics` | owner (account assertion) | Every computer on the account: name, platform, online, last seen, manifest, received at |
| `GET /v1/owner/analytics/part?host=&id=` | owner | One committed part (content-addressed, so cacheable) |

- Keys: `analytics:${accountId}:${hostId}:manifest`, `…:parts` (a catalogue of stored parts and
  sizes) and `…:part:${id}@${hash}`. Keying parts by hash means a part re-uploaded ahead of its
  manifest never changes what the committed manifest serves. Account isolation follows the
  per-account Hub.
- `revokeDevice` / `revokeAllExcept` clear the analytics keys alongside the mirror.
- The landing already proxies every `/v1/owner/*` GET with the account assertion and owner
  credential, so the owner routes need no landing change.
- Rate limits: 30 manifest commits per minute per caller in the Hub; the edge budgets part uploads
  like mirror uploads.

## 5. Desktop

- **Uploader:** a new `src/main/remote/analytics-sync.ts`. It runs when `remote.enabled` is
  set and the computer is enrolled, because credentials load only then. It syncs once after
  connecting, then on analytics changes (debounced about 2 minutes) and hourly as a heartbeat.
  It calls the relay through `RemoteHost.analyticsRequest`, which uses the same access tokens as
  the mirror and returns nothing while remote access is off. The host's `onOnline` hook re-reads the
  relay's manifest after every (re)connect.
- **Setting:** `remote.shareAnalytics`, default `true`. Settings → Remote access gets a "Share
  analytics with code.vocs.io" toggle with a one-line disclosure of what is uploaded. Off →
  `DELETE /v1/analytics`.
- **Connect link:** `connectLink()` (`src/shared/pairing.ts`) points at `/dashboard?connect=`.
- **Remote panel cleanup** (its own PR after the web dashboard): remove the browser-pairing
  link/QR, the pairing request, view-only mode and the transcript-mirror toggle. Keep **External MCP
  control** (`ControlSettings`), the device list with Revoke all, and anything the MCP track depends
  on. Stop mirror uploads and send a one-time `DELETE /v1/mirror` on upgrade.

## 6. Web (`src/web`)

- The shell is the dashboard (`src/web/shell/DashboardApp.tsx`, `src/web/dashboard/`). The page
  calls only same-origin owner routes (`src/web/owner-api.ts`); the screens, sheets, terminal,
  transport and browser vault of the remote client are deleted, and the bundle no longer includes
  `relay/src/web-client.ts`.
- The shell and Connect with Vocs stage use the same
  [Vocs UI assets as the signed-out landing](../src/web/design-system/VENDORED.md): the Code
  palette, system light/dark themes, and same-origin Inter and Geist Mono. The web CSS bridges those
  tokens to the shared charts and reports without changing the desktop appearance.
- The tab strip and tab bodies are shared (`components/analytics/AnalyticsView.tsx`); the desktop
  wraps them with `invoke`, the web with the snapshot loader. An `AnalyticsEnv` context
  (`components/analytics/env.tsx`) turns off what only the desktop can do: the reliability
  drill-down and opening live sessions. It also names each session's computer.
- Move `summarize` and its helpers out of `src/main/analytics.ts` into `src/shared/analytics/`
  (browser-safe). The desktop keeps calling the same function.
- Build: `vite.config.web.ts` `base: '/dashboard/'`, output `relay/public/dashboard`;
  `relay/public/_headers` allows same-origin fonts and fetches, without inline style or script
  permission. The relay answers `/app*` with a 301 to `/dashboard*`, query preserved
  (`relay/src/legacy-app.ts`), and its
  `run_worker_first` covers `/app*` so a stale build left in `relay/public/app` can never shadow
  the redirect.

## 7. Landing (`vocs.io` repo, `code/worker`)

- Gate and proxy `/dashboard` and `/dashboard/*` exactly as `/app` is today.
- Signed-in `GET /` → 302 `/dashboard`. `/` is currently a static asset, so add it to
  `run_worker_first` and fall through to the asset when signed out.
- Sign in button and post-login default `next` → `/dashboard`.
- The source is `code/worker/index.ts` on the `vocs.io` repo's `origin/develop` (a local checkout
  of that repo may be stale). It already proxies every `/v1/owner/*` GET.

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
   of the remote client, `/dashboard` build, `/app` redirect, `connectLink`. Tests: renderer
   analytics tests still pass on the extracted view; `tests/web-dashboard.test.tsx` covers the
   loader cache, switcher, by-computer breakdown, per-computer reports, stale and empty states and
   the Connect screen; `e2e.remote-web` is replaced by `e2e.web-dashboard` (two real hosts join
   through the page and upload); web-only tests for deleted code are removed with it.
4b. **Desktop Remote panel cleanup.** Pairing UI, view-only mode and the mirror toggle go; mirror
   uploads stop with a one-time relay clear. `tests/remote-ui.test.tsx` and `e2e.remote` follow.
5. **Landing.** `/dashboard` gate and proxy, signed-in `/` redirect, Sign in target. Landing Worker tests.

**Rollout order.** The landing change that proxies `/dashboard` (step 5's first half) deploys first.
It is harmless while the relay has no `/dashboard`. Then a Vocs Code release deploys the relay
(steps 1–4) through `deploy-relay`. Then the landing's signed-in `/` redirect. Update desktops so
they upload; until then their cards read "never synced". Run Appendix A of
[REMOTE-ACCESS-ROADMAP.md](REMOTE-ACCESS-ROADMAP.md) with `/dashboard` substituted.

## 9. Coordination and open items

- **MCP / Dots track** edits `relay/src/routes.ts`, `edge.ts` and the Remote panel too. Rebase
  carefully, and do not remove relay pairing, mirror or control endpoints in this track.
- **Dev profile:** a `Vocs Code (Dev)` build connected to the production relay registers as its
  own computer, named after the machine like the installed app, so the two cards share a name
  (they differ in app version). Not addressed yet; renaming a computer is a possible follow-up.
- Docs to update as the steps land: [REMOTE-ACCESS.md](REMOTE-ACCESS.md),
  [REMOTE-ACCESS-ROADMAP.md](REMOTE-ACCESS-ROADMAP.md) (status snapshot, test map), [TESTING.md](TESTING.md).
