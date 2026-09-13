/** zustand store for session state, panel selection and toasts. Selectors must return stable references. */
import { create } from 'zustand';
import type { AppSettings, HarnessAvailability, HarnessId, ImageAttachment, ModelInfo, SessionConfig, SessionEventEnvelope, SessionMeta, TranscriptItem } from '../../shared/types';
import type { TerminalInfo } from '../../shared/terminal';
import { invoke, on } from './api';

export type PanelTab = 'changes' | 'files' | 'branches' | 'goal' | 'usage' | 'terminal';
export type View = 'chat' | 'settings' | 'analytics' | 'skills';
export type AnalyticsTab = 'overview' | 'spend' | 'tokens' | 'activity' | 'tools' | 'sessions';
/** Days in the analytics range; 0 is all time. */
export type AnalyticsRange = 7 | 30 | 90 | 0;

/** One entry of the title bar's back/forward history. */
export interface NavEntry {
  view: View;
  sessionId: string | null;
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
  /** Bumped to move keyboard focus into the active terminal. */
  terminalFocusNonce: number;
  /** Text another part of the UI wants appended to the composer draft (e.g. terminal output). */
  composerInsert: { text: string; nonce: number } | null;
  view: View;
  /** The analytics dashboard remembers its tab and range while the app is open. */
  analyticsTab: AnalyticsTab;
  analyticsRange: AnalyticsRange;
  sidebarOpen: boolean;
  panelOpen: boolean;
  panelTab: PanelTab;
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
  toasts: Toast[];
  changesVersion: number;
  history: NavEntry[];
  historyIndex: number;

  boot(): Promise<void>;
  setActive(id: string | null): Promise<void>;
  loadTranscript(id: string): Promise<void>;
  applyEvent(env: SessionEventEnvelope): void;
  setSettings(s: AppSettings): void;
  setSessions(list: SessionMeta[]): void;
  setView(v: View): void;
  setAnalyticsView(patch: { tab?: AnalyticsTab; range?: AnalyticsRange }): void;
  navBack(): Promise<void>;
  navForward(): Promise<void>;
  toggleSidebar(): void;
  togglePanel(open?: boolean): void;
  setPanelTab(t: PanelTab): void;
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
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: string): void;
  refreshAvailability(): Promise<void>;
  /** Fetches one harness's model catalog, at most once per harness until the model overrides change. */
  ensureModelCatalog(harness: HarnessId): Promise<void>;
  clearTranscriptLocal(id: string): void;
  /** Upserts a renderer-local info line in a session's transcript; null text removes it. Not persisted by the main process. */
  setLocalInfo(sessionId: string, id: string, text: string | null, opts?: { level?: 'info' | 'warn' | 'error'; pending?: boolean }): void;
  setDraft(sessionId: string, text: string): void;
  setTerminals(list: TerminalInfo[]): void;
  setActiveTerminal(sessionId: string, terminalId: string): void;
  focusTerminal(): void;
  insertIntoComposer(text: string): void;
  clearComposerInsert(): void;
}

let toastCounter = 0;

/** Batches streaming deltas so the UI re-renders at most a few dozen times per second. */
const pendingDeltas: SessionEventEnvelope[] = [];
let flushScheduled = false;
/** IPC listeners are registered once per page, even if React StrictMode runs boot() twice. */
let subscribed = false;
/** StrictMode can run App's mount effect twice; share one startup request between both calls. */
let bootInFlight: Promise<void> | null = null;

function bootErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'An unexpected error occurred while loading Vocs Code.';
}

function dropPendingDeltas(sessionId: string, itemId?: string): void {
  for (let i = pendingDeltas.length - 1; i >= 0; i--) {
    const d = pendingDeltas[i];
    if (d.sessionId === sessionId && (itemId === undefined || (d.event.type === 'item.delta' && d.event.id === itemId))) pendingDeltas.splice(i, 1);
  }
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

export const useStore = create<State>((set, get) => ({
  booted: false,
  bootError: null,
  settings: null,
  sessions: [],
  activeId: null,
  transcripts: {},
  loaded: {},
  transcriptErrors: {},
  models: {},
  modelCatalog: {},
  availability: {},
  availabilityError: null,
  terminals: [],
  terminalsLoaded: false,
  activeTerminal: {},
  drafts: {},
  terminalFocusNonce: 0,
  composerInsert: null,
  view: 'chat',
  analyticsTab: 'overview',
  analyticsRange: 30,
  sidebarOpen: true,
  panelOpen: true,
  panelTab: 'changes',
  newSessionOpen: false,
  newSessionRoot: null,
  quickSessionOpen: false,
  quickSessionPrefill: undefined,
  paletteOpen: false,
  searchOpen: false,
  searchJump: null,
  showThinking: true,
  toasts: [],
  changesVersion: 0,
  history: [],
  historyIndex: -1,

  boot() {
    if (bootInFlight) return bootInFlight;
    if (get().booted && get().settings && !get().bootError) return Promise.resolve();
    set({ bootError: null, booted: false });
    bootInFlight = (async () => {
      try {
        const [settings, sessions, terminals] = await Promise.all([invoke('settings:get', undefined), invoke('sessions:list', undefined), invoke('terminal:list', undefined)]);
        set({ settings, sessions, terminals, terminalsLoaded: true, booted: true });
        if (!subscribed) {
          subscribed = true;
          on('push:sessionsChanged', (list) => get().setSessions(list));
          on('push:settingsChanged', (s) => get().setSettings(s));
          on('push:sessionEvent', (env) => get().applyEvent(env));
          on('push:focusSession', ({ sessionId }) => void get().setActive(sessionId).catch(toastError));
          on('push:terminalsChanged', (list) => get().setTerminals(list));
        }
        const first = sessions.find((s) => !s.archived);
        if (first) await get().setActive(first.id);
        void get().refreshAvailability();
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

  async loadTranscript(id) {
    if (get().loaded[id]) return;
    // Clear any previous failure so a retry shows the spinner again, not a stale error.
    set((s) => {
      if (!(id in s.transcriptErrors)) return {};
      const transcriptErrors = { ...s.transcriptErrors };
      delete transcriptErrors[id];
      return { transcriptErrors };
    });
    try {
      const items = await invoke('sessions:transcript', { id });
      // The snapshot already contains any streamed text; deltas still queued for it would duplicate.
      dropPendingDeltas(id);
      set((s) => ({ transcripts: { ...s.transcripts, [id]: items }, loaded: { ...s.loaded, [id]: true } }));
    } catch (e) {
      // Never throw: the transcript pane stays mounted with a retry instead of loading forever.
      set((s) => ({ transcriptErrors: { ...s.transcriptErrors, [id]: e instanceof Error ? e.message : String(e) } }));
    }
  },

  applyEvent(env) {
    const { event, sessionId } = env;
    if (event.type === 'item.delta') {
      pendingDeltas.push(env);
      if (!flushScheduled) {
        flushScheduled = true;
        requestAnimationFrame(() => {
          flushScheduled = false;
          const batch = pendingDeltas.splice(0);
          set((s) => {
            const transcripts = { ...s.transcripts };
            const touched = new Map<string, TranscriptItem[]>();
            for (const d of batch) {
              const ev = d.event;
              if (ev.type !== 'item.delta') continue;
              const list = touched.get(d.sessionId) ?? [...(transcripts[d.sessionId] ?? [])];
              const idx = list.findIndex((i) => i.id === ev.id);
              if (idx < 0) continue;
              const item = { ...list[idx] } as TranscriptItem;
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
              list[idx] = item;
              touched.set(d.sessionId, list);
            }
            for (const [sid, list] of touched) transcripts[sid] = list;
            return { transcripts };
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
          const bump = event.item.kind === 'tool' && event.item.status !== 'running' ? s.changesVersion + 1 : s.changesVersion;
          return { transcripts: { ...s.transcripts, [sessionId]: list }, changesVersion: bump };
        });
        break;
      }
      case 'models':
        set((s) => ({ models: { ...s.models, [sessionId]: event.models } }));
        break;
      case 'error':
        get().toast(event.message, 'error');
        break;
      case 'status':
        if (event.status === 'idle') set((s) => ({ changesVersion: s.changesVersion + 1 }));
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
    let replacement: SessionMeta | undefined;
    let removedTitle: string | undefined;
    set((s) => {
      const removed = new Set<string>();
      for (const id of Object.keys(s.transcripts)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.loaded)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.transcriptErrors)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.activeTerminal)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.models)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.drafts)) if (!ids.has(id)) removed.add(id);
      const activeRemoved = !!s.activeId && !ids.has(s.activeId);
      if (activeRemoved) {
        removedTitle = s.sessions.find((x) => x.id === s.activeId)?.title ?? s.activeId ?? 'active session';
        replacement = [...sessions]
          .filter((x) => !x.archived)
          .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0];
      }
      if (removed.size === 0 && !activeRemoved) return { sessions };
      const transcripts = { ...s.transcripts };
      const loaded = { ...s.loaded };
      const transcriptErrors = { ...s.transcriptErrors };
      const activeTerminal = { ...s.activeTerminal };
      const models = { ...s.models };
      const drafts = { ...s.drafts };
      for (const id of removed) {
        delete transcripts[id];
        delete loaded[id];
        delete transcriptErrors[id];
        delete activeTerminal[id];
        delete models[id];
        delete drafts[id];
      }
      return {
        sessions,
        transcripts,
        loaded,
        transcriptErrors,
        activeTerminal,
        models,
        drafts,
        activeId: activeRemoved ? replacement?.id ?? null : s.activeId
      };
    });
    if (removedTitle) {
      if (replacement) {
        get().toast(`Session "${removedTitle}" was removed; switched to "${replacement.title}".`, 'info');
        // This is reconciliation from the main process, not user navigation: loading directly
        // avoids adding a duplicate entry to the back/forward stack.
        void get().loadTranscript(replacement.id).catch((error) => get().toast(error instanceof Error ? error.message : String(error), 'error'));
      } else {
        get().toast(`Session "${removedTitle}" was removed; no active sessions remain.`, 'info');
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
  setPanelTab(panelTab) {
    set({ panelTab, panelOpen: true });
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
    const harness = settings.defaultHarness;
    const config: SessionConfig = {
      harness,
      projectRoot: root,
      model: settings.defaultModelByHarness[harness],
      effort: settings.defaultEffort,
      permissionMode: settings.defaultPermissionMode,
      useWorktree: settings.defaultUseWorktree ?? false,
      acpAgent: harness === 'acp' ? settings.acpAgents[0]?.id : undefined
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
    set((s) => ({ transcripts: { ...s.transcripts, [id]: [] } }));
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
