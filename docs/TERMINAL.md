# Terminal Reference

Technical details for the built-in terminal (moved out of the README).

The Terminal tab in the side panel is a full terminal, not a command runner. Each tab is a pseudo-terminal (ConPTY on Windows, `forkpty` elsewhere, via a prebuilt `node-pty`) rendered by xterm.js, so interactive programs, prompts, colors, progress bars, `vim`/`less`/REPLs, Ctrl+C and your shell profile all behave as they would in Windows Terminal or iTerm.

## Details

- **Shells.** New tabs start the session's working directory in the shell from *Settings → Terminal*: Auto (PowerShell on Windows, `$SHELL` elsewhere), or any detected shell — PowerShell 7, Windows PowerShell, cmd, Git Bash, WSL, zsh, bash, fish — or a custom executable. The `+` button's menu opens a one-off tab in another shell.
- **Tabs.** Several per session; titles follow the shell's own title (the running command in cmd/PowerShell), or double-click to rename. Middle-click or `×` closes; a clean `exit` closes the tab, a failed shell stays readable with a **Restart** bar.
- **Lives in the main process.** Shells keep running while you switch panel tabs, sessions, or reload the renderer; the panel re-attaches to an exact snapshot of the screen. On quit every screen is saved and the tabs come back on the next launch with their scrollback (the shell starts again when you open one) — toggle under *Settings → Terminal*.
- **Find** (`Ctrl+F`, case / regex options), **Select all**, **Clear**, **Kill process** for a hung command, clickable URLs, 10 000 lines of scrollback by default.
- **Send to agent.** The sparkle button puts the selection — or the last screenful of output — into the composer as a fenced block, so a failing build lands in the chat with one click. Output going idle also refreshes the Changes tab.
- **From the composer.** Start a draft with `!` to run it as a shell command in the session's terminal instead of sending it to the agent: the command stays local, the Terminal tab opens on it, and the transcript is untouched.
- **Shortcuts.** ``Ctrl+` `` focuses the terminal (again: back to the composer), ``Ctrl+Shift+` `` opens a new one, `Ctrl+Shift+C` / `Ctrl+Shift+V` copy and paste everywhere; on Windows/Linux `Ctrl+C` copies while text is selected (otherwise it interrupts) and `Ctrl+V` pastes. Right-click copies the selection or pastes. App chords (`Ctrl+N/K/B/J/,` and `Ctrl+1…9`) win over the shell.

## Packaging

`@lydell/node-pty` ships N-API prebuilds per platform as optional dependencies, so no compiler or `electron-rebuild` step is needed; `electron-builder.yml` unpacks it from the asar because the `.node` binaries and ConPTY DLLs must be real files. Never bundle it.
