# Mission mode

Mission mode hands one task to a small team of sessions: a **Lead** that plans, coordinates and checks, and up to
three **Builders** that implement. You talk to the Lead; it talks to the Builders. When it is done, the Lead leaves a
pull request for you to review.

## Turning it on

- **New Session:** switch **Mission** on beside Permissions. Permissions lock to *Lead: Plan · Builders: Auto*, the
  worktree switch turns on (git folders), and a task is required.
- **Composer:** switch **Mission** on after the permission pill, or start the message with `/mission <task>`.
  - In an empty session, that session becomes the Lead.
  - In a session with history, your message starts a **new** Lead that carries the conversation as context; the
    original session is left as it was.
- Mission mode needs a harness that can lead: Claude Agent SDK, Codex (app-server), Pi or the native loop. Builders can
  also run on ACP agents. Codex exec, Cursor and Google Antigravity cannot take part.

## What happens

1. The Lead works out the objective and asks you **only at real forks, one question at a time**. There is no
   plan-approval step; the plan appears in the Lead's transcript and you can steer or stop at any time.
2. The Lead starts Builders. A Builder shares the Lead's worktree unless the Lead gives it its own (for overlapping
   work). Builders appear nested under the Lead in the sidebar with a status dot: working, waiting on the Lead, done,
   failed or stopped.
3. Builders implement, test and verify before reporting done, and ask the Lead instead of guessing. A Builder with its
   own worktree merges the Lead's branch into its own, resolves conflicts and tests there, then lands on the Lead's
   branch with a fast-forward the app runs one at a time.
4. The Lead checks each Builder's work and sends unfinished work back. After three failed checks on one task it must
   ask you.
5. The Lead finishes with a report (Task / Done / Decisions / Files / Verification / PR / Notes). The app pushes the
   mission branch once and opens a PR into the branch the mission started from, with the report as its description.
   Without a remote or a signed-in `gh`, the mission ends on a local branch. The app never force-pushes and never merges.

While the PR is open, a message to the Lead resumes work on the same branch and PR. When the PR is merged or closed the
mission ends and its worktrees and branches are cleaned up; work that never reached the Lead's branch is kept and listed.

## Permissions

- The Lead always runs in **Plan**: it reads, plans and uses the Mission tools, and never edits files.
- Builders use the tier set in **Settings → Session defaults → Mission mode** (Auto by default). A Builder's permission
  request goes to the Lead first. The Lead may approve requests that stay inside the mission's folders. These always
  reach **you**, with the Lead's recommendation on the card: anything outside the mission's folders, any push or
  publish, elevation (`sudo` and the like), downloads piped into a shell, and MCP tools the app cannot vouch for.
  The Lead can always deny.
- Turning Mission mode on authorizes the one normal push of the mission branch that opens the PR (and later pushes to
  that branch for follow-ups). Nothing else publishes without you.

## Status, stop and restart

The strip at the top of the Lead shows the mission's state, how many Builders are running, the branches and the PR
link, with **Stop** and **Resume**. If the app closes mid-mission, the mission shows **Interrupted**; nothing resumes
until you click Resume, which tells the Lead where each Builder stopped.

## Settings and instructions

- **Settings → Session defaults → Mission mode:** the Builders' harness (or *Same as Lead*), model, effort and
  permission tier.
- **Settings → Instructions → Mission Lead / Mission Builder:** text added to the built-in role prompts. Mission rules
  always come last and win over project instructions (for example a repository rule that says to merge PRs).

Design and invariants: [ARCHITECTURE.md](ARCHITECTURE.md#mission-mode).
