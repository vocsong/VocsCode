/** zustand store for session state, panel selection and toasts. Selectors must return stable references. */
import { create } from 'zustand';
import type { AgentState } from '../../shared/agent';
import { EMPTY_AGENT_STATE } from '../../shared/agent';
import type { AppSettings, DesktopFocus, HarnessAvailability, HarnessId, ImageAttachment, ModelInfo, SessionConfig, SessionEventEnvelope, SessionMeta, TranscriptItem, UpdateState } from '../../shared/types';
import type { TerminalInfo } from '../../shared/terminal';
import { resolveNewSessionDefaults } from '../../shared/session-defaults';
import { invoke, on, canInvoke } from './api';
import { recencyAt, sortSessionRows } from './sessionOrder';

export type PanelTab = 'changes' | 'files' | 'branches' | 'goal' | 'usage' | 'terminal';
/** The Git panel's inner view: the repo, its worktrees, or the two GitHub lists. */
export type GitPanelView = 'branches' | 'worktrees' | 'prs' | 'issues';
/** The panel's lower half: live session services rather than workspace views. */
export type PanelBottomTab = 'mcp' | 'subagents' | 'knowledge' | 'desktop';
export type View = 'chat' | 'settings' | 'analytics' | 'skills' | 'mcp';
export type AnalyticsTab = 'overview' | 'spend' | 'tokens' | 'activity' | 'tools' | 'code' | 'reliability' | 'sessions';
/** Days in the analytics range; 0 is all time. */
export type AnalyticsRange = 7 | 30 | 90 | 0;

/** One entry of the title bar's back/forward history. */
export interface NavEntry {
  view: View;
  sessionId: string | null;
}

/** A path a transcript file link wants the Files tab to show; the Files tab clears it once opened. */
export interface FileReveal {
  sessionId: string;
  path: string;
  /** Line to scroll to when the mention carried one. */
  line?: number;
}

/** A harness's model list fetched without a running session, so a not-yet-started session still has models. */
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

interface State {
  booted: boolean;
  /** Human-readable startup failure; when set, App shows a retry instead of an endless spinner. */
  bootError: string | null;
  settings: AppSettings | null;
  sessions: SessionMeta[];
  activeId: string | null;
  transcripts: Record<string, TranscriptItem[]>;
  loaded: Record<string, boolean>;
  /** Last transcript load failure per session; the transcript pane offers a retry instead of spinning forever. */
  transcriptErrors: Record<string, string>;
  /** Event floor per session: events at or below it are already in the loaded window (web shells). */
  transcriptFloors: Record<string, number>;
  /** First item index of each paged transcript; greater than zero means earlier items exist. */
  transcriptStarts: Record<string, number>;
  models: Record<string, ModelInfo[]>;
  /** Per-harness catalog, keyed by harness id, used until that session's process reports its own list. */
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
   * The Git panel's inner view. It lives here for the same reason `panelBottomOpened` does: the panel
   * unmounts and mounts again on a session switch — opening a session from a PR row does exactly that —
   * and a local state would drop the user back on Branches every time.
   */
  gitPanelView: GitPanelView;
  /** One-shot request to show a file in the Files tab, set by transcript file links. */
  fileReveal: FileReveal | null;
  /** One-shot request to open one subagent run, set by a subagent tool card. */
  subagentReveal: { sessionId: string; runId: string } | null;
  newSessionOpen: boolean;
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
  /** Where the desktop window is looking, from desktop:focus / push:desktopFocus. */
  desktopFocus: DesktopFocus | null;
  /** The host's remote policy, pushed over the e2e session; view-only gates write controls. */
  remoteAccess: { viewOnly: boolean };
  /** Text another part of the UI wants Vesta's composer to start from. */
  agentPrefill: { text: string; nonce: number } | null;
  toasts: Toast[];
  changesVersion: number;
  history: NavEntry[];
  historyIndex: number;

  boot(): Promise<void>;
  setActive(id: string | null): Promise<void>;
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
  setPanelBottomTab(t: PanelBottomTab): void;
  /** Opens the Files tab on a path (workspace-relative or absolute inside the session cwd). */
  revealFile(sessionId: string, path: string, line?: number): void;
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
  createQuickSession(root: string, first?: { prompt?: string; images?: ImageAttachment[] }): Promise<void>;
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
  /** Fetches one harness's model catalog, at most once per harness until the model overrides change. */
  ensureModelCatalog(harness: HarnessId): Promise<void>;
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

let toastCounter = 0;
/** How many sent prompts a session's ArrowUp history keeps. */
export const COMPOSER_HISTORY_LIMIT = 50;
/** Stable stand-in for a session with no history yet — selectors must not build a fresh array per render. */
export const NO_COMPOSER_HISTORY: readonly string[] = [];
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'turns', 'contextWindow', 'contextTokens'] as const;

function sameUsageTotals(a: SessionMeta['usage'], b: SessionMeta['usage']): boolean {
  return USAGE_FIELDS.every((field) => a[field] === b[field]);
}

/** Batches streaming deltas so the UI re-renders at most a few dozen times per second. */
const pendingDeltas: SessionEventEnvelope[] = [];
let flushScheduled = false;
/** IPC listeners are registered once per page, even if React StrictMode runs boot() twice. */
let subscribed = false;
/** StrictMode can run App's mount effect twice; share one startup request between both calls. */
let bootInFlight: Promise<void> | null = null;
/** Share transcript reads; removing an entry also invalidates its delayed response. */
const transcriptLoads = new Map<string, Promise<void>>();
/** Share the "load earlier" reads of a paged transcript, keyed by session. */
const transcriptEarlier = new Map<string, Promise<void>>();
/** Events that arrived while a page was in flight; replayed once the page's floor is known. */
const bufferedEvents = new Map<string, SessionEventEnvelope[]>();
/** Bumped by reset(): in-flight reads from the previous host must not write into the new one. */
let storeGeneration = 0;
/** The deferred boot-time availability probe; a second boot must not stack a second timer. */
let availabilityTimer: ReturnType<typeof setTimeout> | null = null;

/** What a host shell asks of the shared store (web shells configure it before mounting). */
export interface StoreOptions {
  /** Load transcripts tail-first from `sessions:transcriptPage`, with a sequence floor. */
  pagedTranscripts?: boolean;
  /** Skip the deferred availability probe at boot (a browser cannot install harnesses). */
  probeAvailabilityOnBoot?: boolean;
  /** Leave the first session unopened at boot (a web shell routes to its own default). */
  openFirstSessionOnBoot?: boolean;
}

let storeOptions: StoreOptions = {};

/** Set before the first boot; later calls merge, so a test can turn one behavior on alone. */
export function configureStore(options: StoreOptions): void {
  storeOptions = { ...storeOptions, ...options };
}

/** Background sessions in another worktree do not change the foreground diff. */
function affectsActiveWorkspace(s: State, sessionId: string): boolean {
  if (s.activeId === sessionId) return true;
  const cwd = s.sessions.find((session) => session.id === sessionId)?.cwd;
  return !!cwd && s.sessions.some((session) => session.id === s.activeId && session.cwd === cwd);
}

function bootErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'An unexpected error occurred while loading Vocs Code.';
}

/**
 * Which session takes over once `activeId` leaves the visible list. Follows the sidebar: the row
 * directly below it in its own folder, or — when it was that folder's last row — the one above it.
 * The rows are ordered as the user was looking at them, active session included, so "below" means
 * the row that sat under the one that left rather than whatever ends up adjacent without it.
 *
 * Only a folder with nothing else left to show falls back to the most recent session anywhere, and
 * only a list with no active session at all leaves nothing to select.
 */
function replacementFor(previous: SessionMeta[], next: SessionMeta[], activeId: string): SessionMeta | undefined {
  const visible = next.filter((x) => !x.archived);
  const root = previous.find((x) => x.id === activeId)?.config.projectRoot;
  const rows = sortSessionRows(previous.filter((x) => !x.archived && x.config.projectRoot === root));
  const at = rows.findIndex((x) => x.id === activeId);
  const neighbour = at === -1 ? undefined : rows[at + 1] ?? rows[at - 1];
  const picked = neighbour && visible.find((x) => x.id === neighbour.id);
  if (picked) return picked;
  return visible.sort((a, b) => recencyAt(b) - recencyAt(a) || b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0];
}

function dropPendingDeltas(sessionId: string, itemId?: string): void {
  for (let i = pendingDeltas.length - 1; i >= 0; i--) {
    const d = pendingDeltas[i];
    if (d.sessionId === sessionId && (itemId === undefined || (d.event.type === 'item.delta' && d.event.id === itemId))) pendingDeltas.splice(i, 1);
  }
}

/** Replays what arrived while a page was loading. The floor set with the page decides which of
 *  those events the snapshot already contains; the rest apply in arrival order. */
function replayBuffered(get: Getter, id: string): void {
  const events = bufferedEvents.get(id);
  bufferedEvents.delete(id);
  if (!events?.length) return;
  for (const env of events) get().applyEvent(env);
}

/** Set while back/forward is replaying an entry, so the replay does not push new history. */
let navigating = false;

type Setter = (partial: Partial<State> | ((s: State) => Partial<State>)) => void;
type Getter = () => State;

function pushHistory(set: Setter, get: Getter, entry: NavEntry): void {
  if (navigating) return;
  const { history, historyIndex } = get();
  const current = history[historyIndex];
  if (current && current.view === entry.view && current.sessionId === entry.sessionId) return;
  // A new destination truncates anything ahead, exactly like a browser.
  const next = [...history.slice(0, historyIndex + 1), entry].slice(-50);
  set({ history: next, historyIndex: next.length - 1 });
}

async function applyNav(set: Setter, get: Getter, entry: NavEntry, index: number): Promise<void> {
  navigating = true;
  set({ historyIndex: index });
  try {
    if (entry.sessionId !== get().activeId) await get().setActive(entry.sessionId);
    set({ view: entry.view });
  } finally {
    navigating = false;
  }
}

/** Adds a bottom-half tab to the opened set, keeping the array identity when it is already there. */
function markPanelBottomOpened(list: PanelBottomTab[], tab: PanelBottomTab): PanelBottomTab[] {
  return list.includes(tab) ? list : [...list, tab];
}

export const useStore = create<State>((set, get) => ({
  booted: false,
  bootError: null,
  settings: null,
  sessions: [],
  activeId: null,
  transcripts: {},
  loaded: {},
  transcriptErrors: {},
  transcriptFloors: {},
  transcriptStarts: {},
  models: {},
  modelCatalog: {},
  availability: {},
  availabilityError: null,
  terminals: [],
  terminalsLoaded: false,
  activeTerminal: {},
  drafts: {},
  composerHistory: {},
  terminalFocusNonce: 0,
  archiving: {},
  composerInsert: null,
  view: 'chat',
  analyticsTab: 'overview',
  analyticsRange: 30,
  sidebarOpen: true,
  panelOpen: true,
  panelTab: 'changes',
  panelBottomTab: 'mcp',
  panelBottomOpened: [],
  gitPanelView: 'branches',
  fileReveal: null,
  subagentReveal: null,
  newSessionOpen: false,
  newSessionRoot: null,
  quickSessionOpen: false,
  quickSessionPrefill: undefined,
  paletteOpen: false,
  searchOpen: false,
  searchJump: null,
  showThinking: true,
  agent: EMPTY_AGENT_STATE,
  updateState: { status: 'idle' },
  desktopFocus: null,
  remoteAccess: { viewOnly: false },
  agentPrefill: null,
  toasts: [],
  changesVersion: 0,
  history: [],
  historyIndex: -1,

  boot() {
    if (bootInFlight) return bootInFlight;
    if (get().booted && get().settings && !get().bootError) return Promise.resolve();
    set({ bootError: null, booted: false });
    bootInFlight = (async () => {
      // Install the push subscriptions before any round trip: a boot that fails halfway must not
      // leave the store deaf to events, and a reconnect must not need a second boot to listen.
      if (!subscribed) {
        try {
          on('push:sessionsChanged', (list) => get().setSessions(list));
          on('push:settingsChanged', (s) => get().setSettings(s));
          on('push:sessionEvent', (env) => get().applyEvent(env));
          on('push:focusSession', ({ sessionId }) => void get().setActive(sessionId).catch(toastError));
          on('push:terminalsChanged', (list) => get().setTerminals(list));
          on('push:agentState', (s) => get().setAgentState(s));
          on('push:updateState', (s) => set({ updateState: s }));
          on('push:desktopFocus', (focus) => set({ desktopFocus: focus }));
          on('push:remotePolicy', ({ viewOnly }) => set({ remoteAccess: { viewOnly } }));
          subscribed = true;
        } catch {
          // No usable bridge (a torn-down test window, a failed preload): the invoke below reports
          // the failure; a later boot retries the subscriptions.
        }
      }
      try {
        const [settings, sessions] = await Promise.all([invoke('settings:get', undefined), invoke('sessions:list', undefined)]);
        // A web shell cannot list local terminals: ask only for what this host can serve.
        const terminals = canInvoke('terminal:list') ? await invoke('terminal:list', undefined) : [];
        set({ settings, sessions, terminals, terminalsLoaded: true, booted: true, remoteAccess: { viewOnly: settings.remote?.viewOnly === true } });
        // Refused channels are never invoked: a browser cannot update the app or read Vesta's state.
        if (canInvoke('update:state')) void invoke('update:state', undefined).then((s) => set({ updateState: s })).catch(() => undefined);
        if (canInvoke('agent:state')) void invoke('agent:state', undefined).then((s) => get().setAgentState(s)).catch(() => undefined);
        if (canInvoke('desktop:focus')) void invoke('desktop:focus', undefined).then((focus) => set({ desktopFocus: focus })).catch(() => undefined);
        const first = sessions.find((s) => !s.archived);
        if (first && storeOptions.openFirstSessionOnBoot !== false) await get().setActive(first.id);
        // Availability probes spawn one subprocess per harness; kicking them off right as the
        // window opens competes with the first git calls and stalls startup under antivirus.
        // On-demand refreshes (dialogs, settings, fork menus) stay immediate.
        if (storeOptions.probeAvailabilityOnBoot !== false) {
          if (availabilityTimer) clearTimeout(availabilityTimer);
          availabilityTimer = setTimeout(() => {
            availabilityTimer = null;
            void get().refreshAvailability();
          }, 2_500);
        }
      } catch (error) {
        set({ booted: false, bootError: bootErrorMessage(error) });
      }
    })().finally(() => {
      bootInFlight = null;
    });
    return bootInFlight;
  },

  async setActive(id) {
    set({ activeId: id, view: 'chat' });
    pushHistory(set, get, { view: 'chat', sessionId: id });
    if (id) await get().loadTranscript(id);
  },

  async navBack() {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    await applyNav(set, get, history[historyIndex - 1], historyIndex - 1);
  },

  async navForward() {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    await applyNav(set, get, history[historyIndex + 1], historyIndex + 1);
  },

  loadTranscript(id, force = false) {
    const pending = transcriptLoads.get(id);
    if (pending) return pending;
    if (!force && get().loaded[id]) return Promise.resolve();
    const generation = storeGeneration;
    const paged = storeOptions.pagedTranscripts === true;
    // A paged read has no floor until it lands; hold its events so the snapshot and the stream can
    // be reconciled by sequence instead of the events landing on an empty list.
    if (paged) bufferedEvents.set(id, []);
    // Register before invoking IPC or notifying subscribers, which may request the same load.
    const request = Promise.resolve().then(async () => {
      if (transcriptLoads.get(id) !== request) return;
      // Clear any previous failure so a retry shows the spinner again, not a stale error.
      set((s) => {
        if (!(id in s.transcriptErrors)) return s;
        const transcriptErrors = { ...s.transcriptErrors };
        delete transcriptErrors[id];
        return { transcriptErrors };
      });
      try {
        if (paged) {
          const page = await invoke('sessions:transcriptPage', { id });
          if (transcriptLoads.get(id) !== request || generation !== storeGeneration) return;
          set((s) => ({
            transcripts: { ...s.transcripts, [id]: page.items },
            loaded: { ...s.loaded, [id]: true },
            transcriptFloors: page.seq === undefined ? s.transcriptFloors : { ...s.transcriptFloors, [id]: page.seq },
            transcriptStarts: { ...s.transcriptStarts, [id]: page.start }
          }));
          replayBuffered(get, id);
        } else {
          const items = await invoke('sessions:transcript', { id });
          if (transcriptLoads.get(id) !== request || generation !== storeGeneration) return;
          // The snapshot already contains any streamed text; queued deltas would duplicate it.
          dropPendingDeltas(id);
          set((s) => ({ transcripts: { ...s.transcripts, [id]: items }, loaded: { ...s.loaded, [id]: true } }));
        }
      } catch (e) {
        if (transcriptLoads.get(id) !== request || generation !== storeGeneration) return;
        // Never throw: the transcript pane stays mounted with a retry instead of loading forever.
        set((s) => ({ transcriptErrors: { ...s.transcriptErrors, [id]: e instanceof Error ? e.message : String(e) } }));
        if (paged) replayBuffered(get, id);
      }
    }).finally(() => {
      if (transcriptLoads.get(id) === request) transcriptLoads.delete(id);
    });
    transcriptLoads.set(id, request);
    return request;
  },

  loadEarlier(id) {
    const start = get().transcriptStarts[id];
    if (storeOptions.pagedTranscripts !== true || start === undefined || start <= 0) return Promise.resolve();
    const pending = transcriptEarlier.get(id);
    if (pending) return pending;
    const generation = storeGeneration;
    // The older page brings no floor of its own: events during the read keep counting against the
    // current one, so replay holds them until it returns and then applies them in order.
    bufferedEvents.set(id, []);
    const request = Promise.resolve()
      .then(async () => {
        try {
          const page = await invoke('sessions:transcriptPage', { id, end: start });
          if (generation !== storeGeneration || transcriptEarlier.get(id) !== request) return;
          set((s) => ({
            transcripts: { ...s.transcripts, [id]: [...page.items, ...(s.transcripts[id] ?? [])] },
            transcriptStarts: { ...s.transcriptStarts, [id]: page.start }
          }));
        } catch (e) {
          if (generation !== storeGeneration) return;
          get().toast(e instanceof Error ? e.message : String(e), 'error');
        } finally {
          if (generation === storeGeneration) replayBuffered(get, id);
        }
      })
      .finally(() => {
        if (transcriptEarlier.get(id) === request) transcriptEarlier.delete(id);
      });
    transcriptEarlier.set(id, request);
    return request;
  },

  async resync() {
    const generation = storeGeneration;
    const [settings, sessions] = await Promise.all([invoke('settings:get', undefined), invoke('sessions:list', undefined)]);
    if (generation !== storeGeneration) return;
    set({ settings, sessions, remoteAccess: { viewOnly: settings.remote?.viewOnly === true } });
    if (canInvoke('desktop:focus')) {
      void invoke('desktop:focus', undefined).then((focus) => {
        if (generation === storeGeneration) set({ desktopFocus: focus });
      }).catch(() => undefined);
    }
    const active = get().activeId;
    // Force the window even when it is marked loaded; the current items stay on screen until the
    // fresh page replaces them, so a reconnect never blanks the transcript.
    if (active) await get().loadTranscript(active, true);
  },

  reset() {
    storeGeneration++;
    transcriptLoads.clear();
    transcriptEarlier.clear();
    bufferedEvents.clear();
    bootInFlight = null;
    if (availabilityTimer) {
      clearTimeout(availabilityTimer);
      availabilityTimer = null;
    }
    // The push subscriptions from boot stay in place: they resolve the store dynamically, and a
    // computer switch must not double-subscribe when the new host boots.
    set({
      booted: false,
      bootError: null,
      settings: null,
      sessions: [],
      activeId: null,
      transcripts: {},
      loaded: {},
      transcriptErrors: {},
      transcriptFloors: {},
      transcriptStarts: {},
      models: {},
      modelCatalog: {},
      availability: {},
      availabilityError: null,
      terminals: [],
      terminalsLoaded: false,
      activeTerminal: {},
      drafts: {},
      composerHistory: {},
      desktopFocus: null,
      remoteAccess: { viewOnly: false },
      history: [],
      historyIndex: -1
    });
  },

  applyEvent(env) {
    const { event, sessionId } = env;
    // A page in flight has no floor yet: hold the event until the page lands, then replay past it.
    const buffered = bufferedEvents.get(sessionId);
    if (buffered) {
      buffered.push(env);
      return;
    }
    // Paged clients get a floor with the window; anything at or below it is already in the list.
    // `seq` is absent from an older desktop, in which case nothing is dropped.
    const floor = get().transcriptFloors[sessionId];
    if (floor !== undefined && env.seq !== undefined && env.seq <= floor) return;
    if (event.type === 'item.delta') {
      pendingDeltas.push(env);
      if (!flushScheduled) {
        flushScheduled = true;
        requestAnimationFrame(() => {
          flushScheduled = false;
          const batch = pendingDeltas.splice(0);
          if (!batch.length) return;
          set((s) => {
            const touched = new Map<string, { list: TranscriptItem[]; indices: Map<string, number>; cloned: Set<number> }>();
            for (const d of batch) {
              const ev = d.event;
              if (ev.type !== 'item.delta') continue;
              let session = touched.get(d.sessionId);
              if (!session) {
                const list = s.transcripts[d.sessionId] ?? [];
                const indices = new Map<string, number>();
                // One history scan per session, preserving the first match for duplicate ids.
                list.forEach((item, index) => {
                  const id = item.id;
                  if (!indices.has(id)) indices.set(id, index);
                });
                session = { list, indices, cloned: new Set() };
                touched.set(d.sessionId, session);
              }
              const idx = session.indices.get(ev.id);
              if (idx === undefined) continue;
              if (!session.cloned.size) session.list = [...session.list];
              if (!session.cloned.has(idx)) {
                session.list[idx] = { ...session.list[idx] };
                session.cloned.add(idx);
              }
              const item = session.list[idx];
              if (item.kind === 'assistant') {
                if (ev.textDelta) item.text += ev.textDelta;
                if (ev.thinkingDelta) item.thinking = (item.thinking ?? '') + ev.thinkingDelta;
              } else if (item.kind === 'tool' && ev.outputDelta) {
                // Cap accumulated tool output so unbounded streamed deltas cannot balloon memory.
                const cur = item.output ?? '';
                if (cur.length < 30_000) {
                  const next = cur + ev.outputDelta;
                  item.output = next.length > 30_000 ? `${next.slice(0, 30_000)}\n[output truncated]` : next;
                }
              }
            }
            let transcripts: State['transcripts'] | undefined;
            for (const [sid, session] of touched) {
              if (!session.cloned.size) continue;
              transcripts ??= { ...s.transcripts };
              transcripts[sid] = session.list;
            }
            return transcripts ? { transcripts } : s;
          });
        });
      }
      return;
    }
    switch (event.type) {
      case 'approval.resolved': {
        set((s) => {
          const list = s.transcripts[sessionId];
          if (!list) return {};
          const idx = list.findIndex((i) => i.id === event.requestId);
          if (idx < 0 || list[idx].kind !== 'approval') return {};
          const cur = list[idx] as Extract<TranscriptItem, { kind: 'approval' }>;
          if (cur.decision) return {};
          const next = [...list];
          next[idx] = { ...cur, decision: event.decision, decidedAt: Date.now() };
          return { transcripts: { ...s.transcripts, [sessionId]: next } };
        });
        break;
      }
      case 'item.upsert': {
        // The upsert carries the item's full state; drop deltas still waiting in the batch for it.
        dropPendingDeltas(sessionId, event.item.id);
        set((s) => {
          const list = [...(s.transcripts[sessionId] ?? [])];
          const idx = list.findIndex((i) => i.id === event.item.id);
          if (idx >= 0) list[idx] = event.item;
          else list.push(event.item);
          const bump = event.item.kind === 'tool' && event.item.status !== 'running' && affectsActiveWorkspace(s, sessionId) ? s.changesVersion + 1 : s.changesVersion;
          return { transcripts: { ...s.transcripts, [sessionId]: list }, changesVersion: bump };
        });
        break;
      }
      case 'usage':
        // Usage is also sent as a session event so the active panel can update without waiting for
        // a full sessionsChanged snapshot. The main process still publishes that snapshot for the
        // sidebar and non-renderer clients; ignore an identical value to avoid a duplicate render.
        set((s) => {
          const current = s.sessions.find((session) => session.id === sessionId);
          if (!current || sameUsageTotals(current.usage, event.totals)) return {};
          return { sessions: s.sessions.map((session) => session.id === sessionId ? { ...session, usage: event.totals } : session) };
        });
        break;
      case 'models':
        set((s) => ({ models: { ...s.models, [sessionId]: event.models } }));
        break;
      case 'error':
        get().toast(event.message, 'error');
        break;
      case 'status':
        if (event.status === 'idle') set((s) => affectsActiveWorkspace(s, sessionId) ? { changesVersion: s.changesVersion + 1 } : s);
        break;
      default:
        break;
    }
  },

  setSettings(settings) {
    set((s) => {
      // Overrides are baked in when the catalog is fetched, so a change to them invalidates it.
      const stale = !!s.settings && JSON.stringify(s.settings.modelOverrides) !== JSON.stringify(settings.modelOverrides);
      return stale ? { settings, modelCatalog: {} } : { settings };
    });
  },
  setSessions(sessions) {
    const ids = new Set(sessions.map((x) => x.id));
    for (const id of transcriptLoads.keys()) {
      if (!ids.has(id)) {
        transcriptLoads.delete(id);
        dropPendingDeltas(id);
      }
    }
    let replacement: SessionMeta | undefined;
    let departedTitle: string | undefined;
    let departedArchived = false;
    set((s) => {
      const removed = new Set<string>();
      for (const id of Object.keys(s.transcripts)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.loaded)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.transcriptErrors)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.transcriptFloors)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.transcriptStarts)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.activeTerminal)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.models)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.drafts)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.composerHistory)) if (!ids.has(id)) removed.add(id);
      const activeId = s.activeId;
      const before = activeId ? s.sessions.find((x) => x.id === activeId) : undefined;
      const after = activeId ? sessions.find((x) => x.id === activeId) : undefined;
      // The active session left the visible list: deleted outright, or archived by this same push.
      // Only the transition counts — clicking an archived row in the Archived view selects an
      // already-archived session, and the next unrelated push must not throw that selection away.
      const activeRemoved = !!activeId && (!after || (!before?.archived && !!after.archived));
      if (activeRemoved && activeId) {
        departedTitle = before?.title ?? activeId;
        departedArchived = !!after?.archived;
        replacement = replacementFor(s.sessions, sessions, activeId);
      }
      if (removed.size === 0 && !activeRemoved) return { sessions };
      const transcripts = { ...s.transcripts };
      const loaded = { ...s.loaded };
      const transcriptErrors = { ...s.transcriptErrors };
      const transcriptFloors = { ...s.transcriptFloors };
      const transcriptStarts = { ...s.transcriptStarts };
      const activeTerminal = { ...s.activeTerminal };
      const models = { ...s.models };
      const drafts = { ...s.drafts };
      const composerHistory = { ...s.composerHistory };
      for (const id of removed) {
        delete transcripts[id];
        delete loaded[id];
        delete transcriptErrors[id];
        delete transcriptFloors[id];
        delete transcriptStarts[id];
        delete activeTerminal[id];
        delete models[id];
        delete drafts[id];
        delete composerHistory[id];
      }
      return {
        sessions,
        transcripts,
        loaded,
        transcriptErrors,
        transcriptFloors,
        transcriptStarts,
        activeTerminal,
        models,
        drafts,
        composerHistory,
        activeId: activeRemoved ? replacement?.id ?? null : s.activeId
      };
    });
    if (departedTitle) {
      const what = departedArchived ? 'archived' : 'removed';
      if (replacement) {
        get().toast(`Session "${departedTitle}" was ${what}; switched to "${replacement.title}".`, 'info');
        // This is reconciliation from the main process, not user navigation: loading directly
        // avoids adding a duplicate entry to the back/forward stack.
        void get().loadTranscript(replacement.id).catch((error) => get().toast(error instanceof Error ? error.message : String(error), 'error'));
      } else {
        get().toast(`Session "${departedTitle}" was ${what}; no active sessions remain.`, 'info');
      }
    }
  },
  setView(view) {
    set({ view });
    pushHistory(set, get, { view, sessionId: get().activeId });
  },
  setAnalyticsView(patch) {
    set((s) => ({ analyticsTab: patch.tab ?? s.analyticsTab, analyticsRange: patch.range ?? s.analyticsRange }));
  },
  toggleSidebar() {
    set((s) => ({ sidebarOpen: !s.sidebarOpen }));
  },
  togglePanel(open) {
    set((s) => ({ panelOpen: open ?? !s.panelOpen }));
  },
  setPanelTab(tab) {
    // MCP moved to the lower half; asking for that tab opens the half instead of an empty top pane.
    if (tab === 'mcp') set((s) => ({ panelBottomTab: 'mcp', panelBottomOpened: markPanelBottomOpened(s.panelBottomOpened, 'mcp'), panelOpen: true }));
    else set({ panelTab: tab, panelOpen: true });
  },
  setGitPanelView(gitPanelView) {
    set({ gitPanelView });
  },
  setPanelBottomTab(panelBottomTab) {
    set((s) => ({ panelBottomTab, panelBottomOpened: markPanelBottomOpened(s.panelBottomOpened, panelBottomTab), panelOpen: true }));
  },
  revealFile(sessionId, path, line) {
    set({ fileReveal: line ? { sessionId, path, line } : { sessionId, path }, panelTab: 'files', panelOpen: true });
  },
  consumeFileReveal() {
    set((s) => (s.fileReveal ? { fileReveal: null } : {}));
  },
  revealSubagentRun(sessionId, runId) {
    set((s) => ({ subagentReveal: { sessionId, runId }, panelBottomTab: 'subagents', panelBottomOpened: markPanelBottomOpened(s.panelBottomOpened, 'subagents'), panelOpen: true }));
  },
  consumeSubagentReveal() {
    set((s) => (s.subagentReveal ? { subagentReveal: null } : {}));
  },
  openNewSession(newSessionOpen) {
    set({ newSessionOpen });
  },
  async startNewSession(root) {
    if (!root) {
      const r = await invoke('app:pickFolder', { defaultPath: get().settings?.recentProjects[0] });
      if (!r.path) return;
      root = r.path;
    }
    set({ newSessionOpen: true, newSessionRoot: root });
  },
  openQuickSession(quickSessionOpen, quickSessionPrefill) {
    set(quickSessionOpen ? { quickSessionOpen, quickSessionPrefill } : { quickSessionOpen, quickSessionPrefill: undefined });
  },
  async createQuickSession(root, first) {
    const settings = get().settings;
    if (!settings) return;
    // Same memory as the dialog: the folder's remembered choices, app-wide defaults for the rest.
    const defaults = resolveNewSessionDefaults(settings, root);
    const harness = defaults.harness;
    const config: SessionConfig = {
      harness,
      projectRoot: root,
      model: defaults.model,
      effort: defaults.effort || undefined,
      permissionMode: defaults.permissionMode,
      useWorktree: defaults.useWorktree,
      acpAgent: harness === 'acp' ? defaults.acpAgent : undefined
    };
    try {
      const meta = await invoke('sessions:create', {
        config,
        initialPrompt: first?.prompt?.trim() || undefined,
        initialImages: first?.images?.length ? first.images : undefined
      });
      await get().setActive(meta.id);
    } catch (e) {
      get().toast(String((e as Error).message ?? e), 'error');
    }
  },
  openPalette(paletteOpen) {
    set({ paletteOpen });
  },
  openSearch(searchOpen) {
    set({ searchOpen });
  },
  jumpToSearchMatch(sessionId, itemId) {
    set((s) => ({ searchOpen: false, searchJump: itemId ? { sessionId, itemId, n: (s.searchJump?.n ?? 0) + 1 } : null }));
    void get().setActive(sessionId).catch(toastError);
  },
  toggleThinking() {
    set((s) => ({ showThinking: !s.showThinking }));
  },
  setAgentState(agent) {
    set({ agent });
  },
  openVesta(prefill) {
    const current = get().settings?.agent ?? {};
    set((s) => ({ agentPrefill: prefill ? { text: prefill, nonce: (s.agentPrefill?.nonce ?? 0) + 1 } : null }));
    void invoke('settings:update', { agent: { ...current, enabled: true, collapsed: false } }).catch(toastError);
  },
  toast(text, kind = 'info') {
    const id = `t${++toastCounter}`;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  async refreshAvailability() {
    try {
      const availability = await invoke('harness:availability', undefined);
      set({ availability, availabilityError: null });
    } catch (e) {
      set({ availabilityError: e instanceof Error ? e.message : String(e) });
    }
  },

  async ensureModelCatalog(harness) {
    // Present means fetched, failed or in flight: one round trip per harness, not per session.
    if (get().modelCatalog[harness]) return;
    const put = (entry: ModelCatalogEntry) => set((s) => ({ modelCatalog: { ...s.modelCatalog, [harness]: entry } }));
    put({ models: [], loading: true });
    try {
      const r = await invoke('harness:models', { harness });
      put({ models: r.models, error: r.error, loading: false });
    } catch (e) {
      put({ models: [], error: (e as Error).message, loading: false });
    }
  },
  clearTranscriptLocal(id) {
    set((s) => {
      // A cleared transcript starts a new window: the old floor must not hide the new events.
      const floors = { ...s.transcriptFloors };
      delete floors[id];
      return { transcripts: { ...s.transcripts, [id]: [] }, transcriptFloors: floors, transcriptStarts: { ...s.transcriptStarts, [id]: 0 } };
    });
  },
  replaceTranscript(id, items) {
    dropPendingDeltas(id);
    set((s) => {
      const floors = { ...s.transcriptFloors };
      delete floors[id];
      return { transcripts: { ...s.transcripts, [id]: items }, loaded: { ...s.loaded, [id]: true }, transcriptFloors: floors };
    });
  },
  setLocalInfo(sessionId, id, text, opts) {
    set((s) => {
      const list = s.transcripts[sessionId] ?? [];
      const idx = list.findIndex((i) => i.id === id);
      if (text === null) {
        if (idx < 0) return {};
        return { transcripts: { ...s.transcripts, [sessionId]: list.filter((i) => i.id !== id) } };
      }
      const item: TranscriptItem = {
        id,
        kind: 'info',
        ts: idx >= 0 ? list[idx].ts : Date.now(),
        level: opts?.level ?? 'info',
        text,
        pending: opts?.pending
      };
      const next = [...list];
      if (idx >= 0) next[idx] = item;
      else next.push(item);
      return { transcripts: { ...s.transcripts, [sessionId]: next } };
    });
  },
  setDraft(sessionId, text) {
    set((s) => (s.drafts[sessionId] === text ? {} : { drafts: { ...s.drafts, [sessionId]: text } }));
  },
  pushComposerHistory(sessionId, text) {
    set((s) => {
      const current = s.composerHistory[sessionId] ?? [];
      // Newest first, and re-sending an earlier prompt moves it back to the front instead of duplicating it.
      const next = [text, ...current.filter((entry) => entry !== text)].slice(0, COMPOSER_HISTORY_LIMIT);
      return { composerHistory: { ...s.composerHistory, [sessionId]: next } };
    });
  },
  setArchiving(id, on) {
    set((s) => {
      if (on === !!s.archiving[id]) return {};
      const next = { ...s.archiving };
      if (on) next[id] = true;
      else delete next[id];
      return { archiving: next };
    });
  },
  setTerminals(terminals) {
    set({ terminals, terminalsLoaded: true });
  },
  setActiveTerminal(sessionId, terminalId) {
    set((s) => (s.activeTerminal[sessionId] === terminalId ? {} : { activeTerminal: { ...s.activeTerminal, [sessionId]: terminalId } }));
  },
  focusTerminal() {
    set((s) => ({ terminalFocusNonce: s.terminalFocusNonce + 1 }));
  },
  insertIntoComposer(text) {
    set((s) => ({ composerInsert: { text, nonce: (s.composerInsert?.nonce ?? 0) + 1 } }));
  },
  clearComposerInsert() {
    set({ composerInsert: null });
  }
}));

/** Reports a rejected fire-and-forget action as an error toast instead of an unhandled rejection. */
export function toastError(error: unknown): void {
  useStore.getState().toast(error instanceof Error ? error.message : String(error), 'error');
}

export function useActiveSession(): SessionMeta | undefined {
  return useStore((s) => s.sessions.find((x) => x.id === s.activeId));
}
