/** zustand store for session state, panel selection and toasts. Selectors must return stable references. */
import { create } from 'zustand';
import type { AppSettings, HarnessAvailability, HarnessId, ModelInfo, SessionEventEnvelope, SessionMeta, TranscriptItem } from '../../shared/types';
import type { TerminalInfo } from '../../shared/terminal';
import { invoke, on } from './api';

export type PanelTab = 'changes' | 'files' | 'goal' | 'usage' | 'terminal';
export type View = 'chat' | 'settings';

/** One entry of the title bar's back/forward history. */
export interface NavEntry {
  view: View;
  sessionId: string | null;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  text: string;
}

interface State {
  booted: boolean;
  settings: AppSettings | null;
  sessions: SessionMeta[];
  activeId: string | null;
  transcripts: Record<string, TranscriptItem[]>;
  loaded: Record<string, boolean>;
  models: Record<string, ModelInfo[]>;
  availability: Partial<Record<HarnessId, HarnessAvailability>>;
  /** Every session's terminals, as the main process reports them; the xterm instances live in terminal/host.ts. */
  terminals: TerminalInfo[];
  terminalsLoaded: boolean;
  /** Selected terminal tab per session. */
  activeTerminal: Record<string, string>;
  /** Bumped to move keyboard focus into the active terminal. */
  terminalFocusNonce: number;
  /** Text another part of the UI wants appended to the composer draft (e.g. terminal output). */
  composerInsert: { text: string; nonce: number } | null;
  view: View;
  sidebarOpen: boolean;
  panelOpen: boolean;
  panelTab: PanelTab;
  newSessionOpen: boolean;
  paletteOpen: boolean;
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
  navBack(): Promise<void>;
  navForward(): Promise<void>;
  toggleSidebar(): void;
  togglePanel(open?: boolean): void;
  setPanelTab(t: PanelTab): void;
  openNewSession(open: boolean): void;
  openPalette(open: boolean): void;
  toggleThinking(): void;
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: string): void;
  refreshAvailability(): Promise<void>;
  clearTranscriptLocal(id: string): void;
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
  settings: null,
  sessions: [],
  activeId: null,
  transcripts: {},
  loaded: {},
  models: {},
  availability: {},
  terminals: [],
  terminalsLoaded: false,
  activeTerminal: {},
  terminalFocusNonce: 0,
  composerInsert: null,
  view: 'chat',
  sidebarOpen: true,
  panelOpen: true,
  panelTab: 'changes',
  newSessionOpen: false,
  paletteOpen: false,
  showThinking: true,
  toasts: [],
  changesVersion: 0,
  history: [],
  historyIndex: -1,

  async boot() {
    const [settings, sessions, terminals] = await Promise.all([invoke('settings:get', undefined), invoke('sessions:list', undefined), invoke('terminal:list', undefined)]);
    set({ settings, sessions, terminals, terminalsLoaded: true, booted: true });
    if (!subscribed) {
      subscribed = true;
      on('push:sessionsChanged', (list) => get().setSessions(list));
      on('push:settingsChanged', (s) => get().setSettings(s));
      on('push:sessionEvent', (env) => get().applyEvent(env));
      on('push:focusSession', ({ sessionId }) => void get().setActive(sessionId));
      on('push:terminalsChanged', (list) => get().setTerminals(list));
    }
    const first = sessions.find((s) => !s.archived);
    if (first) await get().setActive(first.id);
    void get().refreshAvailability();
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
    const items = await invoke('sessions:transcript', { id });
    // The snapshot already contains any streamed text; deltas still queued for it would duplicate.
    dropPendingDeltas(id);
    set((s) => ({ transcripts: { ...s.transcripts, [id]: items }, loaded: { ...s.loaded, [id]: true } }));
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
    set({ settings });
  },
  setSessions(sessions) {
    set((s) => {
      const ids = new Set(sessions.map((x) => x.id));
      const removed = new Set<string>();
      for (const id of Object.keys(s.transcripts)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.loaded)) if (!ids.has(id)) removed.add(id);
      for (const id of Object.keys(s.activeTerminal)) if (!ids.has(id)) removed.add(id);
      if (removed.size === 0) return { sessions };
      const transcripts = { ...s.transcripts };
      const loaded = { ...s.loaded };
      const activeTerminal = { ...s.activeTerminal };
      for (const id of removed) {
        delete transcripts[id];
        delete loaded[id];
        delete activeTerminal[id];
      }
      // A removed session cannot stay active; drop it and let the caller pick a new one.
      const activeId = s.activeId && ids.has(s.activeId) ? s.activeId : null;
      return { sessions, transcripts, loaded, activeTerminal, activeId };
    });
  },
  setView(view) {
    set({ view });
    pushHistory(set, get, { view, sessionId: get().activeId });
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
  openPalette(paletteOpen) {
    set({ paletteOpen });
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
      set({ availability });
    } catch {
      /* ignore */
    }
  },
  clearTranscriptLocal(id) {
    set((s) => ({ transcripts: { ...s.transcripts, [id]: [] } }));
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

export function useActiveSession(): SessionMeta | undefined {
  return useStore((s) => s.sessions.find((x) => x.id === s.activeId));
}
