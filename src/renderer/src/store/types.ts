/**
 * Shared types and constants for the renderer Zustand store and its slices.
 */
import type { AgentState } from '../../../shared/agent';
import type { ProcessSummary } from '../../../shared/processes';
import type { TerminalInfo } from '../../../shared/terminal';
import type {
  AppSettings,
  DesktopFocus,
  FileAttachment,
  GitPullRequestDetail,
  HarnessAvailability,
  HarnessId,
  ImageAttachment,
  ModelInfo,
  SessionEventEnvelope,
  SessionMeta,
  TranscriptItem,
  UpdateState
} from '../../../shared/types';
import type { DropZone, PaneLayout, PaneOrientation, PaneSide } from '../panes';
import type { Pins, PinSide } from '../pins';

export type PanelTab = 'changes' | 'files' | 'branches' | 'goal' | 'usage' | 'terminal';
/** The Git panel's inner view: the repo, its worktrees, or the two GitHub lists. */
export type GitPanelView = 'branches' | 'worktrees' | 'prs' | 'issues';
/** The panel's lower half: live session services rather than workspace views. */
export type PanelBottomTab = 'mcp' | 'subagents' | 'knowledge' | 'desktop' | 'processes';
export type View = 'chat' | 'settings' | 'analytics' | 'skills' | 'mcp';
export type AnalyticsTab = 'overview' | 'spend' | 'tokens' | 'activity' | 'tools' | 'code' | 'reliability' | 'sessions';
/** Days in the analytics range; 0 is all time. */
export type AnalyticsRange = 7 | 30 | 90 | 0;

/** One entry of the title bar's back/forward history. */
export interface NavEntry {
  view: View;
  sessionId: string | null;
}

/** A folder a transcript link wants the Files tab to show; the Files tab clears it once opened. */
export interface FileReveal {
  sessionId: string;
  path: string;
}

/** A harness's shared model catalog, discovered independently of any session process. */
export interface ModelCatalogEntry {
  models: ModelInfo[];
  loading: boolean;
  error?: string;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  text: string;
}

/** What a host shell asks of the shared store (web shells configure it before mounting). */
export interface StoreOptions {
  /** Load transcripts tail-first from `sessions:transcriptPage`, with a sequence floor. */
  pagedTranscripts?: boolean;
  /** Skip the deferred availability probe at boot (a browser cannot install harnesses). */
  probeAvailabilityOnBoot?: boolean;
  /** Leave the first session unopened at boot (a web shell routes to its own default). */
  openFirstSessionOnBoot?: boolean;
}

/** How many sent prompts a session's ArrowUp history keeps. */
export const COMPOSER_HISTORY_LIMIT = 50;
/** Stable stand-in for a session with no history yet — selectors must not build a fresh array per render. */
export const NO_COMPOSER_HISTORY: readonly string[] = [];

export interface State {
  booted: boolean;
  /** Human-readable startup failure; when set, App shows a retry instead of an endless spinner. */
  bootError: string | null;
  settings: AppSettings | null;
  sessions: SessionMeta[];
  /** The active pane's session; every global panel follows it. Kept equal to `layout`'s active pane. */
  activeId: string | null;
  /** The split conversation workspace (panes.ts); a single pane is the app as it always was. */
  layout: PaneLayout;
  transcripts: Record<string, TranscriptItem[]>;
  loaded: Record<string, boolean>;
  /** Last transcript load failure per session; the transcript pane offers a retry instead of spinning forever. */
  transcriptErrors: Record<string, string>;
  /** Event floor per session: events at or below it are already in the loaded window (web shells). */
  transcriptFloors: Record<string, number>;
  /** First item index of each paged transcript; greater than zero means earlier items exist. */
  transcriptStarts: Record<string, number>;
  models: Record<string, ModelInfo[]>;
  /** Per-harness catalog shared by New Session, settings and existing session model pickers. */
  modelCatalog: Partial<Record<HarnessId, ModelCatalogEntry>>;
  availability: Partial<Record<HarnessId, HarnessAvailability>>;
  /** Set when the last availability check failed; setup surfaces a retry instead of an endless spinner. */
  availabilityError: string | null;
  /** Every session's terminals, as the main process reports them; the xterm instances live in terminal/host.ts. */
  terminals: TerminalInfo[];
  terminalsLoaded: boolean;
  /** Selected terminal tab per session. */
  activeTerminal: Record<string, string>;
  /** Unsent composer text per session, kept so switching sessions does not lose the draft. */
  drafts: Record<string, string>;
  /** Prompts already sent per session, newest first, so ArrowUp can recall them after a remount. */
  composerHistory: Record<string, string[]>;
  /** Bumped to move keyboard focus into the active terminal. */
  terminalFocusNonce: number;
  /** Sessions with an archive request in flight; rows show a blinking Archiving pill meanwhile. */
  archiving: Record<string, true>;
  /** Text another part of the UI wants appended to the composer draft (e.g. terminal output). */
  composerInsert: { text: string; nonce: number } | null;
  view: View;
  /** The analytics dashboard remembers its tab and range while the app is open. */
  analyticsTab: AnalyticsTab;
  analyticsRange: AnalyticsRange;
  sidebarOpen: boolean;
  panelOpen: boolean;
  panelTab: PanelTab;
  panelBottomTab: PanelBottomTab;
  /**
   * Bottom-half tabs that have been opened this app run. The half mounts a tab the first time it is
   * opened (MCP probes servers, Subagents lists run files), so this has to outlive the panel — which
   * unmounts whenever the user leaves the chat view, e.g. for Settings.
   */
  panelBottomOpened: PanelBottomTab[];
  /**
   * Which half of the panel was asked for last. Standard shows both halves; Zen's drawer shows one
   * view at a time, and this picks it.
   */
  panelFocus: 'top' | 'bottom';
  /**
   * Zen: something other than the pointer asked for the panel (a file link, the branch crumb, a
   * shortcut), so its drawer slides out without being hovered. It folds back when the pointer leaves
   * the drawer or a press lands outside it.
   */
  panelPeek: boolean;
  /** Zen: sides held open instead of folding back to their rails (see pins.ts). */
  pins: Pins;
  /**
   * The Git panel's inner view. It lives here for the same reason `panelBottomOpened` does: the panel
   * unmounts and mounts again on a session switch — opening a session from a PR row does exactly that —
   * and a local state would drop the user back on Branches every time.
   */
  gitPanelView: GitPanelView;
  gitPullRequestPreview: { sessionId: string; url: string; number: number; detail: GitPullRequestDetail | null } | null;
  /** One-shot request to show a folder in the Files tab, set by transcript folder links. */
  fileReveal: FileReveal | null;
  /** One-shot request to open one subagent run, set by a subagent tool card. */
  subagentReveal: { sessionId: string; runId: string } | null;
  newSessionOpen: boolean;
  onboardingOpen: boolean;
  onboardingDismissed: boolean;
  onboardingHarness: HarnessId | null;
  openOnboarding(harness?: HarnessId): void;
  dismissOnboarding(): void;
  /** Project folder the new session dialog is targeting; null until a folder is picked. */
  newSessionRoot: string | null;
  /** Ctrl+N quick picker: choose a known folder, then start a session with defaults. */
  quickSessionOpen: boolean;
  /** First prompt the quick picker starts with, e.g. seeded from a GitHub issue. */
  quickSessionPrefill?: string;
  paletteOpen: boolean;
  /** Ctrl+Shift+F deep search modal over titles and transcript contents. */
  searchOpen: boolean;
  /** Pending jump-to-match: Transcript scrolls to the item once its session is loaded. */
  searchJump: { sessionId: string; itemId: string; n: number } | null;
  showThinking: boolean;
  /** Vesta's transcript, mirrored from the main process. */
  agent: AgentState;
  /** In-app auto-update state (issue #198); idle (never transitions) in dev and web builds. */
  updateState: UpdateState;
  /** Tracked process counts, pushed as they change, for the Processes tab badge. */
  processSummary: ProcessSummary | null;
  /** Where the desktop window is looking, from desktop:focus / push:desktopFocus. */
  desktopFocus: DesktopFocus | null;
  /** The sessions in the panes actually on screen (SessionPanes); empty while another view hides them. */
  visibleSessionIds: string[];
  /** The host's remote policy, pushed over the e2e session; view-only gates write controls. */
  remoteAccess: { viewOnly: boolean };
  /** Text another part of the UI wants Vesta's composer to start from. */
  agentPrefill: { text: string; nonce: number } | null;
  toasts: Toast[];
  changesVersion: number;
  history: NavEntry[];
  historyIndex: number;

  boot(): Promise<void>;
  /** Opens a session in the active pane (or focuses it where shown), unless explicitly opened to the right. */
  setActive(id: string | null, pane?: 'right'): Promise<void>;
  /** Makes a pane active, so its session becomes the context for the global panels. */
  focusPane(paneId: string): void;
  /** Splits a pane (the active one by default); the new pane is active and shows `sessionId` or a picker. */
  splitPane(orientation: PaneOrientation, opts?: { paneId?: string; sessionId?: string | null; side?: PaneSide }): void;
  /** Removes a pane from the split. Its session keeps running and stays in the sidebar. */
  closePane(paneId: string): void;
  /** A session dragged onto a pane: shown in it (`center`) or in a new pane on that edge. */
  dropSession(paneId: string, zone: DropZone, sessionId: string): void;
  resizePanes(sizes: number[]): void;
  /** `force` reloads a transcript that is already marked loaded (resync); items stay until it lands. */
  loadTranscript(id: string, force?: boolean): Promise<void>;
  /** Prepends the page before a paged transcript's first item (web shells). */
  loadEarlier(id: string): Promise<void>;
  /** Re-reads the list, settings and focus, then replaces the active transcript window. */
  resync(): Promise<void>;
  /** Clears per-host state on a computer switch; push subscriptions stay in place. */
  reset(): void;
  applyEvent(env: SessionEventEnvelope): void;
  setSettings(s: AppSettings): void;
  setSessions(list: SessionMeta[]): void;
  setView(v: View): void;
  setAnalyticsView(patch: { tab?: AnalyticsTab; range?: AnalyticsRange }): void;
  navBack(): Promise<void>;
  navForward(): Promise<void>;
  toggleSidebar(): void;
  togglePanel(open?: boolean): void;
  setPanelTab(t: PanelTab | 'mcp'): void;
  setGitPanelView(v: GitPanelView): void;
  openPullRequestLink(sessionId: string, url: string): boolean;
  closePullRequestPreview(): void;
  setPanelBottomTab(t: PanelBottomTab): void;
  endPanelPeek(): void;
  togglePin(side: PinSide): void;
  /**
   * Opens a path a session names (workspace-relative, shortened, or absolute inside its folder). A
   * file opens a preview and a folder opens for browsing, both in the Files tab. A path outside the
   * folder is only shown in the system file manager. `exact` skips the shortened-name lookup.
   */
  revealFile(sessionId: string, path: string, line?: number, opts?: { exact?: boolean }): void;
  closeFilePreview(): void;
  consumeFileReveal(): void;
  /** Opens the Subagents tab on one run, used by a transcript tool card. */
  revealSubagentRun(sessionId: string, runId: string): void;
  consumeSubagentReveal(): void;
  openNewSession(open: boolean): void;
  /** Opens the new session dialog for a folder; without one, asks the user to pick a project folder first. */
  startNewSession(root?: string | null): Promise<void>;
  /** Opens the quick picker; `prefill` seeds the first prompt (cleared again on close). */
  openQuickSession(open: boolean, prefill?: string): void;
  /** Starts a session for a known folder straight from settings defaults, skipping the dialog. */
  createQuickSession(root: string, first?: { prompt?: string; images?: ImageAttachment[]; files?: FileAttachment[] }): Promise<boolean>;
  openPalette(open: boolean): void;
  openSearch(open: boolean): void;
  /** Closes the search modal, activates the session and scrolls to the matched item. */
  jumpToSearchMatch(sessionId: string, itemId?: string): void;
  toggleThinking(): void;
  setAgentState(s: AgentState): void;
  /** Expands Vesta and seeds its composer; used by the "Set up with Vesta" entry points. */
  openVesta(prefill?: string): void;
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: string): void;
  refreshAvailability(): Promise<void>;
  recordHarnessAvailability(harness: HarnessId, availability: HarnessAvailability): void;
  /** Fetches one harness's model catalog only when it has no cached or pending entry. */
  ensureModelCatalog(harness: HarnessId): Promise<void>;
  /** Re-probes the selected runtime; preserves usable models on failure and fences stale responses. */
  /** `refresh` skips main's 7-day catalog cache: the user's explicit recheck. */
  refreshModelCatalog(harness: HarnessId, context?: { acpAgent?: string; projectRoot?: string; refresh?: boolean }): Promise<ModelCatalogEntry>;
  clearTranscriptLocal(id: string): void;
  /** Replaces a loaded transcript after a server-side rewrite (for example, editing a past prompt). */
  replaceTranscript(id: string, items: TranscriptItem[]): void;
  /** Upserts a renderer-local info line in a session's transcript; null text removes it. Not persisted by the main process. */
  setLocalInfo(sessionId: string, id: string, text: string | null, opts?: { level?: 'info' | 'warn' | 'error'; pending?: boolean }): void;
  setDraft(sessionId: string, text: string): void;
  /** Records a sent prompt as the session's most recent history entry; re-sending an old prompt moves it back to the front. */
  pushComposerHistory(sessionId: string, text: string): void;
  setArchiving(id: string, on: boolean): void;
  setTerminals(list: TerminalInfo[]): void;
  setActiveTerminal(sessionId: string, terminalId: string): void;
  focusTerminal(): void;
  insertIntoComposer(text: string): void;
  clearComposerInsert(): void;
}

export type Setter = (partial: Partial<State> | ((s: State) => Partial<State>)) => void;
export type Getter = () => State;

/** Imperative runtime state kept outside Zustand snapshots and reset atomically on host switch. */
export interface StoreRuntime {
  toastCounter: number;
  /** Batches streaming deltas so the UI re-renders at most a few dozen times per second. */
  pendingDeltas: SessionEventEnvelope[];
  flushScheduled: boolean;
  /** IPC listeners are registered once per page, even if React StrictMode runs boot() twice. */
  subscribed: boolean;
  /** StrictMode can run App's mount effect twice; share one startup request between both calls. */
  bootInFlight: Promise<void> | null;
  /** Share transcript reads; removing an entry also invalidates its delayed response. */
  transcriptLoads: Map<string, Promise<void>>;
  /** Share the "load earlier" reads of a paged transcript, keyed by session. */
  transcriptEarlier: Map<string, Promise<void>>;
  /** Events that arrived while a page was in flight; replayed once the page's floor is known. */
  bufferedEvents: Map<string, SessionEventEnvelope[]>;
  /** Bumped by reset(): in-flight reads from the previous host must not write into the new one. */
  storeGeneration: number;
  /** The deferred boot-time availability probe; a second boot must not stack a second timer. */
  availabilityTimer: ReturnType<typeof setTimeout> | null;
  /** Set while back/forward is replaying an entry, so the replay does not push new history. */
  navigating: boolean;
  /** Off until the desktop boot has restored the last split, so the initial empty layout never overwrites it. */
  persistLayout: boolean;
  /** Numbers each file preview request, so opening the same file again still reloads it. */
  fileNonce: number;
  availabilityRequest: number;
  availabilityOverrides: Partial<Record<HarnessId, number>>;
}
