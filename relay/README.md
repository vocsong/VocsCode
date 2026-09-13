# Vocs relay

The routing service for Vocs Code remote access (see [docs/REMOTE-ACCESS.md](../docs/REMOTE-ACCESS.md)).
A Cloudflare Worker + one Hub Durable Object per account. It routes opaque end-to-end-encrypted
frames between paired desktops and web clients and holds the pairing registry. It can never
read payload content — it sees routing metadata and ciphertext only.

## Deploy

```bash
cd relay
npx wrangler deploy
npx wrangler secret put ENROLL_TOKEN   # generate once, e.g. openssl rand -base64 32
```

Put the same secret in the desktop app (Settings → Remote access → Enrollment secret) and the
relay URL (e.g. `https://vocs-relay.<account>.workers.dev`) in the desktop's Relay URL field.
The web client (this directory's `public/`) is served by the same Worker at the root path —
users pair by entering the code their desktop shows.

## Layout

- `src/core.ts` — pairing state machine + device registry (storage-agnostic, unit-tested)
- `src/worker.ts` — the Worker + Hub Durable Object (REST + WebSocket glue)
- `src/web-client.ts` — the browser-side pairing + e2e transport (DOM-free, unit-tested)
- `src/page.ts` — the web page logic (bundled to `public/app.js` via `npm run relay:page` at the repo root)
- `public/` — the static web client (pairing screen, sessions, transcripts, approvals)

## Local development

```bash
cd relay && npx wrangler dev   # http://localhost:8787
```
