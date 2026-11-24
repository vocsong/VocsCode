/** Fixed relevance labels for the pinned source and docs; no live project data. */
export const BENCHMARK_REVISION = '73bfe10c3fdeac82c9a704bcda1ee3becc03b15b';
export const REFRESH_TARGET = {
  revision: '8358d990faba096e4e02c922792618527307f3ca',
  query: 'FastModeElectric',
  file: 'src/renderer/src/components/FastModeElectric.tsx'
} as const;

type RetrievalCase = {
  id: string;
  kind: 'symbol' | 'question';
  query: string;
  grepTerms: string[];
  expectedPaths: string[];
  expectedWikiId?: string;
};

type BenchmarkWikiPage = {
  id: string;
  title: string;
  claim: string;
  body: string;
  keywords: string[];
  path: string;
};

// Feed query unchanged to Evidence; rank Git paths by distinct fixed-string grepTerms matched.
// Symbol labels point to declarations, not mentions. Question paths supply equivalent evidence.
export const retrievalCases: RetrievalCase[] = [
  {
    id: 'terminal-manager',
    kind: 'symbol',
    query: 'TerminalManager',
    grepTerms: ['TerminalManager'],
    expectedPaths: ['src/main/terminal.ts'],
  },
  {
    id: 'claude-subagent-runs',
    kind: 'symbol',
    query: 'ClaudeSubagentRuns',
    grepTerms: ['ClaudeSubagentRuns'],
    expectedPaths: ['src/main/harness/claude-subagents.ts'],
  },
  {
    id: 'mission-service',
    kind: 'symbol',
    query: 'MissionService',
    grepTerms: ['MissionService'],
    expectedPaths: ['src/main/mission/service.ts'],
  },
  {
    id: 'session-panes',
    kind: 'symbol',
    query: 'SessionPanes',
    grepTerms: ['SessionPanes'],
    expectedPaths: ['src/renderer/src/components/SessionPanes.tsx'],
  },
  {
    id: 'remote-terminal-streams',
    kind: 'symbol',
    query: 'RemoteTerminalStreams',
    grepTerms: ['RemoteTerminalStreams'],
    expectedPaths: ['src/main/remote/terminal-streams.ts'],
  },
  {
    id: 'transcript-page',
    kind: 'symbol',
    query: 'transcriptPage',
    grepTerms: ['transcriptPage'],
    expectedPaths: ['src/shared/transcript-page.ts'],
  },
  {
    id: 'mcp-effective-entries',
    kind: 'symbol',
    query: 'effectiveEntries',
    grepTerms: ['effectiveEntries'],
    expectedPaths: ['src/main/mcp/effective.ts'],
  },
  {
    id: 'apply-theme',
    kind: 'symbol',
    query: 'applyTheme',
    grepTerms: ['applyTheme'],
    expectedPaths: ['src/renderer/src/theme.ts', 'src/renderer/src/terminal/host.ts'],
  },
  {
    id: 'terminal-shell-lifetime',
    kind: 'question',
    query: 'Why does a terminal command keep running when I switch sessions or reload the renderer?',
    grepTerms: ['terminal', 'running', 'reload', 'renderer'],
    expectedPaths: ['docs/TERMINAL.md', 'src/main/terminal.ts'],
    expectedWikiId: 'benchmark/terminal-shell-lifetime',
  },
  {
    id: 'zen-side-pins',
    kind: 'question',
    query: 'Why do pinned sides in Zen stay open after a restart, and are those pins shared across windows?',
    grepTerms: ['pinned', 'Zen', 'restart', 'pins'],
    expectedPaths: ['docs/INTERFACE-MODES.md', 'src/renderer/src/pins.ts'],
    expectedWikiId: 'benchmark/zen-side-pins',
  },
  {
    id: 'session-view-dwell',
    kind: 'question',
    query: 'When does looking at a finished session in a split pane clear its not viewed badge?',
    grepTerms: ['session', 'pane', 'not viewed', 'badge'],
    expectedPaths: [
      'docs/superpowers/specs/2026-11-09-session-activity-tray-design.md',
      'src/renderer/src/desktop-focus.ts',
    ],
    expectedWikiId: 'benchmark/session-view-dwell',
  },
  {
    id: 'mcp-repo-opt-in',
    kind: 'question',
    query: 'Does checking out a repo with a new MCP server automatically enable it for everyone?',
    grepTerms: ['repo', 'MCP', 'server', 'enable'],
    expectedPaths: ['docs/MCP.md', 'src/main/mcp/effective.ts'],
    expectedWikiId: 'benchmark/mcp-repo-opt-in',
  },
  {
    id: 'palette-follows-os',
    kind: 'question',
    query: 'Can I keep my color palette but have light and dark mode follow the OS?',
    grepTerms: ['palette', 'light', 'dark', 'OS'],
    expectedPaths: ['docs/THEMES.md', 'src/renderer/src/theme.ts'],
    expectedWikiId: 'benchmark/palette-follows-os',
  },
  {
    id: 'background-work-after-turn',
    kind: 'question',
    query: 'Why does the activity tray still show a session as running after its turn ends with a background subagent?',
    grepTerms: ['activity tray', 'running', 'turn', 'background subagent'],
    expectedPaths: ['src/renderer/src/activity.ts'],
  },
  {
    id: 'remote-transcript-size',
    kind: 'question',
    query: 'How does the remote transcript stay usable when a tool prints a huge amount of output?',
    grepTerms: ['remote', 'transcript', 'tool', 'output'],
    expectedPaths: ['docs/REMOTE-ACCESS.md', 'src/shared/transcript-page.ts'],
  },
  {
    id: 'mission-skipped-suite',
    kind: 'question',
    query: 'Can a Mission finish if the test command succeeds but the whole suite was skipped?',
    grepTerms: ['Mission', 'test', 'suite', 'skipped'],
    expectedPaths: ['docs/MISSIONS.md', 'src/main/mission/verification.ts'],
  },
];

// Fixture-only decisions distilled from the checked-in Markdown at BENCHMARK_REVISION.
export const benchmarkWiki: BenchmarkWikiPage[] = [
  {
    id: 'benchmark/terminal-shell-lifetime',
    title: 'Terminal shells outlive their renderer views',
    claim: 'The main process keeps the shell running when the terminal panel is hidden or the renderer reloads.',
    body: 'The renderer can reattach to a screen snapshot without starting the command over. Quitting is different: restored tabs can recover scrollback, but start a new shell when opened.',
    keywords: ['terminal', 'shell', 'reload', 'renderer', 'scrollback'],
    path: 'docs/TERMINAL.md',
  },
  {
    id: 'benchmark/zen-side-pins',
    title: 'Zen pins belong to the window layout',
    claim: 'Pins keep either side of Zen open and are saved per window across restarts.',
    body: 'A pinned sidebar or panel takes space alongside the conversation. Unpinning lets it fold back to the rail; the pin state lives in localStorage rather than app-wide preferences.',
    keywords: ['Zen', 'pinned', 'pins', 'sidebar', 'restart', 'windows'],
    path: 'docs/INTERFACE-MODES.md',
  },
  {
    id: 'benchmark/session-view-dwell',
    title: 'Clearing the finished-session badge takes a focused dwell',
    claim: 'Viewing clears the not viewed mark only after a session has been visible in a focused desktop window for 1.5 seconds.',
    body: 'Either visible split pane can count; the session need not be the active pane. A quick glance does not count, and losing focus or leaving the pane cancels the timer.',
    keywords: ['finished session', 'split pane', 'badge', 'not viewed', 'focus'],
    path: 'docs/superpowers/specs/2026-11-09-session-activity-tray-design.md',
  },
  {
    id: 'benchmark/mcp-repo-opt-in',
    title: 'Repository MCP definitions require local opt-in',
    claim: 'A checked-in MCP server definition does not enable the server for anyone by itself.',
    body: 'The repository file shares the definition with teammates. The enable decision is kept separately for each user and project, so checking out the repo does not start a new server.',
    keywords: ['repo', 'MCP', 'server', 'enable', 'opt-in'],
    path: 'docs/MCP.md',
  },
  {
    id: 'benchmark/palette-follows-os',
    title: 'Color palette and light/dark mode are independent',
    claim: 'Any color palette can stay selected while System mode follows the OS light or dark setting.',
    body: 'Every palette has both variants. In System mode an OS appearance change switches the variant in place without selecting a different palette.',
    keywords: ['color palette', 'light', 'dark', 'OS', 'System mode'],
    path: 'docs/THEMES.md',
  },
];
