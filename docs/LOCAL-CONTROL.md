# Windows local CLI and stdio MCP (preview)

This read-only preview uses the running Vocs Code desktop. It requires a source checkout,
Node 22.23 or later, and Windows PowerShell 5.1 with permission to run the bundled helper.
It does not install a shell command, auto-launch the app, or require Vocs Login or a relay.
The [remote HTTPS MCP](CONTROL-MCP.md) rollout is separate.

## Try it

1. In the repository, install the locked dependencies with `npm ci --include=dev` and run
   `npm run dev`. Open a project folder and create an ordinary session, or use an existing one.
2. In **Settings → Remote access → Local CLI & MCP discovery**, select the projects, read and
   acknowledge what is shared, and click **Enable grant**. Copy the target descriptor. Choose
   it in the desktop profile you actually want to control.
3. With the app still running, run these commands from the checkout (PowerShell):

   ```powershell
   $target = '<copied target descriptor>'
   node scripts/vocs-code.mjs --target $target status --json
   node scripts/vocs-code.mjs --target $target projects list --json
   node scripts/vocs-code.mjs --target $target sessions list --project <project-id> --json
   ```

   Replace `<project-id>` with an ID from the project list. `--json` emits one JSON object;
   failures go to stderr and exit nonzero. Lists accept `--offset` and `--limit` (1–100).
   Use `nextOffset` until it is null, even if a page omitted unavailable sessions.
4. For a local MCP client, register `node` (or the absolute path to Node) as the stdio command,
   with arguments `["<absolute path to scripts/vocs-code.mjs>", "--target", "<descriptor>", "mcp", "serve", "--stdio"]`.
   The only tools are `capabilities`, `projects_list`, and project-bound `sessions_list`.
   Starting the adapter does not start a desktop or check out a project; a stale target fails
   when used. Copy a new descriptor and update the client after a restart or grant replacement.

## Authority and limits

- The desktop owner grants project discovery and ordinary session metadata (ID, title, status,
  harness). Titles can contain text from the opening prompt. Archived sessions are
  excluded. Canonical project and workspace checks apply. There are no transcripts, approval
  or grant-management tools, settings reads, arbitrary workspace paths, session writes, shell,
  credentials, or remote routing.
- No listener is created until the owner enables the grant from the trusted desktop page. An
  uncommitted enable is canceled if that page unloads. Revoking, removing an approved folder,
  or closing the app ends the grant. Replacing it closes the prior endpoint and rotates the
  descriptor. Nothing is enabled again on restart, copied from the remote OAuth journal, or
  written to cloud storage.
- The descriptor is not a token; it names one pipe process and birth time plus the profile and
  launch grant. Copy it from the intended owner panel. The helper opens a local-only Windows
  named pipe with an explicit current-user access list. The supplied client checks the native
  server identity before sending. The desktop checks the exact profile, launch and active grant.
  There is no discovery fallback to the Dev/installed profile or another machine.
- All programs running with the same Windows user's access share that local grant if they can
  reach the endpoint. This is not isolation from malicious software running as that user, a
  Windows administrator, or a sandbox for a coding harness. Keep approval scopes small and do not
  expose the stdio process through a remote bridge. PowerShell policy can refuse the native helper;
  the preview fails closed and does not override that policy.

## Verification

On Windows, from the repository:

```powershell
npx vitest run tests/local-control-windows.test.ts
npm run build
node scripts/e2e-guard.mjs tests/e2e.remote.test.ts
```

The native suite uses synthetic data on a fresh local pipe: it reads back the protected one-user
ACL, requires Windows to deny a restricted token at open while allowing the ordinary owner token
on that same pipe, checks PID and creation-time mismatches and exact frame limits, and checks
cleanup after abrupt loss of the watched owner process. No accounts or privileges are added.
The Electron case verifies the full CLI and SDK stdio path with disposable profile data. On hosted
Windows CI only, both cases first measure a cold helper launch on a disposable endpoint and close
it before testing. Each tested grant starts a fresh helper under the unchanged 30-second deadline.

A restricted token is **not a second Windows account**. For separate-account qualification in an
authorized lab, use two existing standard accounts with distinct user SIDs (`whoami /user`) and a
synthetic project. Confirm each account can run the preview against its own desktop. Keep the
first desktop running while the second runs `status --json` with the first desktop's descriptor:
require a nonzero exit and empty stdout. Repeat the same call as the first account and require
success. A closed desktop, an unreadable checkout, or a blocked PowerShell helper is not a valid
negative result. Revoke both test grants when done.

Separate-account and SMB denial, installed CLI distribution, and remote OAuth are not covered by
the offline suites. Do not change SMB, firewall, or PowerShell policy to run them.
