# Shared Skills

In the desktop sidebar, open **Skills → Shared** (or enter `/skill` by itself). This is your personal library across projects on this computer, backed by `~/.agents/skills/<name>/SKILL.md`. Existing compatible files appear in the library without copying them. **Native & built-in** still manages each harness's own skills and includes app actions such as `/housekeep`.

## Create, review, and use

1. Choose **New shared skill** or select an existing skill. **Edit** changes that one file. A Shared skill is plain UTF-8 Markdown (up to 32 KiB) with unique `name` and `description` frontmatter and a non-empty body. Its folder must match its lowercase, hyphenated name. Linked files/folders and additional frontmatter fields aren't supported in the Shared library; this doesn't change native harness support for those files.
2. Read the preview, then choose **Mark as reviewed**. The desktop stores consent for that exact file revision separately from the skills and the synced settings. A subsequent edit or a change made outside Vocs Code requires review of the new revision. **Disable** withdraws consent for Vocs Code invocation; it doesn't delete or uninstall the file.
3. Choose **Use in session** to stage the command in an open session, or type `/skill <name> [task]` directly. For example, `/skill verify-change test the CSV export with an empty report`. Staging doesn't send anything. Picking a skill pins the selected revision while you edit the task. When you send, Vocs Code rechecks the reviewed revision and sends its body once as part of an ordinary user turn. If a newer revision was approved elsewhere, select it again rather than sending it under an older draft.

Shared invocation targets **Codex** (app-server and exec), **Claude**, **Pi**, and **Google Antigravity** in ordinary idle desktop sessions. It does not change the native paths: e.g. Pi still owns `/skill:verify-change`, and a native `/skill` command remains reachable as `//skill`. A repository skill with the same name isn't used in place of a Shared skill. Codex and Pi can also discover `~/.agents/skills` under their own rules; Vocs Code's review toggle controls only the Vocs-owned path.

## Privacy and boundaries

- Previewing, editing, and reviewing read or write local files. The Shared catalog and invocation are available only to the trusted desktop window, not paired browsers or agent/user RPC. Merely joining a project or switching harnesses never automatically injects a Shared skill.
- On Send, the active runtime and its model provider receive the selected text. They may retain it or echo it in the reply, and that reply follows the session's usual history and sharing settings. The app-authored user row records what you typed and the skill name/revision, without duplicating the expanded body. Don't include secrets in skills. Bundled resources are not read or executed by the Shared feature.
- Skills are instructions, not permissions. The normal harness permission mode and approval path still apply. The v1 path rejects queueing, steering, attachments, archived/controller-created sessions, active Goals or Missions, and edit-and-resend of a Shared turn. It also refuses sessions whose harness owns `/goal`, because the app can't confirm their private goal state. If dispatch can't be confirmed, inspect the transcript and session before retrying. Vocs Code won't automatically replay it after failure or restart.

## Portable workflows

Start with `verify-change` (produce proof for a change), then `resume-from-evidence` (reuse only proof that still applies). Use `reproduce-and-compare` for a pinned baseline versus candidate. Project rules and existing scripts decide what each check does. These are examples of personal skills, not preinstalled content. Use [verification records](VERIFICATION-RECORDS.md) when another session or harness will pick up the task. Neither a skill nor a passing record supplies merge or deploy authorization.

## Verification

- Offline manager/catalog tests and the guarded Electron `tests/e2e.shared-skills.test.ts` prove the UI, selected payload, persistence, and refusal paths with a scripted runtime. They don't prove a live vendor connection.
- The live Shared Skills smoke uses a disposable, synthetic, no-tool skill. It goes through the owner route, asks for a fixed reply, and checks a single completed turn and terminal idle. Only run it with already-configured runtimes and authorization for the provider calls. A failed or unavailable provider is not a pass. The smoke uses a temporary home by default. To test a subscription that needs files on disk, point `HARNESS_SMOKE_SHARED_HOME` at a separately prepared, signed-in test home; do not point it at your normal home or copy credentials into the checkout.

```bash
HARNESS_SMOKE=1 HARNESS_SMOKE_SHARED=1 HARNESS_SMOKE_ONLY=codex,claude,pi,antigravity npm run test:smoke -- -t 'Shared skill'
```
