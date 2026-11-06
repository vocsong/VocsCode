# Settings UX

Settings is organized around tasks rather than storage files. Existing IPC, configuration owners,
keychain boundaries, permissions and save semantics are unchanged.

## Find the right page

| Group | Pages |
| --- | --- |
| Workspace | General, Appearance, Shortcuts, Terminal, Voice |
| Agent behavior | Session defaults, Instructions, Mission, Vesta & utility |
| Connections | Providers & keys, Harnesses, Pi, ACP agents |
| System | Import chats, Remote access, About & doctor |

General is the starting point for daily preferences and common destinations. Appearance owns the
live theme preview and theme catalogue. Session defaults owns new-session defaults, compaction,
goals and worktree branch prefixes. Remembered per-project choices still take precedence for
new-session harness, permission and effort defaults. Compaction is app-wide and can affect existing
sessions at an idle boundary; the harness-native `/goal` preference updates existing sessions too.
Auto-continue and iteration defaults are copied when a new goal is created.

- Search finds settings by topic and vocabulary, including controls inside other pages. Enter opens
  the first result; Down moves into results; Escape clears the query even from a focused result and
  returns focus to search. Each new query starts at the top of the result list. Ctrl/Cmd+F focuses
  settings search while focus is in Settings.
- Selecting a result opens its page and focuses its setting group where a target is defined.
- Search hides rather than unmounts the current page, so clearing it preserves an editor’s draft.
- On compact panes, a grouped section selector replaces the sidebar; no destinations disappear.
- Page headers explain save behavior. Immediate preferences are distinct from explicit Save,
  import, connection, installation and security actions; a save hint is not a success indicator.
- Pi separates Preferences, Prompts, Resources, Packages and Subagents without discarding drafts
  when changing category. Instructions exposes scope selection, unsaved state and character count.

## Maintaining the UI

`src/renderer/src/settings-catalog.ts` is the section and search catalogue. Add a topic when adding
an important setting, including user-facing synonyms. Search only indexes static descriptive text:
never configuration values, credentials, user files or model account details. An optional `anchor`
should name the actual visible settings group. `openSettings()` remains the public deep-link entry;
View → Theme opens Appearance directly.

`SettingsPrimitives.tsx` provides titled, accessible groups and informational notes. Settings-specific
styles live in `components/settings.css`, scoped to `.settings` so other app surfaces are unaffected.
Use the app’s theme tokens, retain accessible field names and keep native checkboxes out of flexible
text-input width rules.

## Saving and consistency

- An Instructions or Pi prompt save acknowledges only the submitted text. Text edited while the
  request is pending remains an unsaved draft, including after switching scope/category or a failed
  save. Most harnesses load app instructions when starting; the native loop reads them before each
  model step.
- Clearing a Pi numeric override removes its key so the runtime default applies. Valid zero values
  survive reloads; invalid number text is not treated as an intentional deletion. A rejected update
  leaves the confirmed value visible. Vocs Code rereads subagent concurrency limits before each
  spawn, including in running sessions. When `maxConcurrent` is unset, the background/session caps
  are four/eight respectively; a configured value sets both caps.
- Pi snapshots are ordered by successfully applied responses. Refreshes invalidated by an
  overlapping mutation are reconciled after pending mutations settle, including failed mutations;
  a refresh never repeats a package command.
- `PiConfigStore` queues complete reads and read/merge/write operations per resolved agent directory
  across store instances in this process. Package commands hold that queue until their runner
  settles, including the existing best-effort timeout teardown. Other directories are independent.
  Atomic JSON replacement and this queue do **not** provide locking against external Pi processes
  or editors.
- App instruction reads and writes share the UTF-16 character budget used by the editor counter.
  Pi prompt files have a UTF-8 byte budget instead. Oversized previews never end halfway through a
  character and cannot be silently saved back as truncated text.
- External package resources can still be enabled/disabled, but unsupported editor actions are
  disabled and explained. The renderer check is lexical UX only; main-process validation remains
  authoritative and unchanged.

## Review screenshots

The following are curated crops of the real Electron app using an isolated fixture, not mockups.
No live conversations or credentials are included.

### General — dark

![General settings, dark theme](images/settings-redesign-general.png)

### Appearance — light

![Appearance settings, light theme](images/settings-redesign-appearance.png)

### Search

![Settings search results](images/settings-redesign-search.png)

### Compact layout

![Compact settings navigation](images/settings-redesign-compact.png)

To regenerate the original captures (gitignored):

```sh
npm run build
node scripts/e2e-guard.mjs tests/e2e.layout.test.ts
```

The suite also tests real preference writes, restart persistence, keyboard navigation, provider
filtering, every catalogue search anchor, search reset/Escape, and every page at multiple compact
widths. Section-specific suites continue to exercise their own production
boundaries; the navigation suite is not a substitute for those flows.
