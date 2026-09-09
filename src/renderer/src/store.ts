import { create } from 'zustand';
import type { AppSettings, HarnessAvailability, HarnessId, ModelInfo, SessionEventEnvelope, SessionMeta, TranscriptItem } from '../../shared/types';
import { invoke, on } from './api';

export type PanelTab = 'changes' | 'files' | 'goal' | 'usage' | 'terminal';
export type View = 'chat' | 'settings';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface TerminalLine {
  runId: string;
  text: string;
  done?: boolean;
  exitCode?: number | null;
  command?: string;
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
  terminal: Record<string, TerminalLine[]>;
  view: View;
  sidebarOpen: boolean;
  panelOpen: boolean;
  panelTab: PanelTab;
  newSessionOpen: boolean;
  paletteOpen: boolean;
  showThinking: boolean;
  toasts: Toast[];
  changesVersion: number;

  boot(): Promise<void>;
  setActive(id: string | null): Promise<void>;
  loadTranscript(id: string): Promise<void>;
  applyEvent(env: SessionEventEnvelope): void;
  setSettings(s: AppSettings): void;
  setSessions(list: SessionMeta[]): void;
  setView(v: View): void;
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
  appendTerminal(sessionId: string, line: TerminalLine): void;
}

let toastCounter = 0;

/** Batches streaming deltas so the UI re-renders at most a few dozen times per second. */
const pendingDeltas: SessionEventEnvelope[] = [];
let flushScheduled = false;

export const useStore = create<State>((set, get) => ({
  booted: false,
  settings: null,
  sessions: [],
  activeId: null,
  transcripts: {},
  loaded: {},
  models: {},
  availability: {},
  terminal: {},
  view: 'chat',
  sidebarOpen: true,
  panelOpen: true,
  panelTab: 'changes',
  newSessionOpen: false,
  paletteOpen: false,
  showThinking: true,
  toasts: [],
  changesVersion: 0,

  async boot() {
    const [settings, sessions] = await Promise.all([invoke('settings:get', undefined), invoke('sessions:list', undefined)]);
    set({ settings, sessions, booted: true });
    const first = sessions.find((s) => !s.archived);
    if (first) await get().setActive(first.id);
    on('push:sessionsChanged', (list) => get().setSessions(list));
    on('push:settingsChanged', (s) => get().setSettings(s));
    on('push:sessionEvent', (env) => get().applyEvent(env));
    on('push:focusSession', ({ sessionId }) => void get().setActive(sessionId));
    void get().refreshAvailability();
  },

  async setActive(id) {
    set({ activeId: id, view: 'chat' });
    if (id) await get().loadTranscript(id);
  },

  async loadTranscript(id) {
    if (get().loaded[id]) return;
    const items = await invoke('sessions:transcript', { id });
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
              } else if (item.kind === 'tool' && ev.outputDelta) item.output = (item.output ?? '') + ev.outputDelta;
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
      case 'item.upsert': {
        // The upsert carries the item's full state; drop deltas still waiting in the batch for it.
        for (let i = pendingDeltas.length - 1; i >= 0; i--) {
          const d = pendingDeltas[i];
          if (d.sessionId === sessionId && d.event.type === 'item.delta' && d.event.id === event.item.id) pendingDeltas.splice(i, 1);
        }
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
      case 'shell.output':
        set((s) => {
          const lines = [...(s.terminal[sessionId] ?? [])];
          const idx = lines.findIndex((l) => l.runId === event.runId);
          if (idx >= 0) lines[idx] = { ...lines[idx], text: lines[idx].text + event.chunk, done: event.done ?? lines[idx].done, exitCode: event.exitCode ?? lines[idx].exitCode };
          else lines.push({ runId: event.runId, text: event.chunk, done: event.done, exitCode: event.exitCode });
          return { terminal: { ...s.terminal, [sessionId]: lines } };
        });
        if (event.done) set((s) => ({ changesVersion: s.changesVersion + 1 }));
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
    set({ sessions });
  },
  setView(view) {
    set({ view });
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
  appendTerminal(sessionId, line) {
    set((s) => ({ terminal: { ...s.terminal, [sessionId]: [...(s.terminal[sessionId] ?? []), line] } }));
  }
}));

export function useActiveSession(): SessionMeta | undefined {
  return useStore((s) => s.sessions.find((x) => x.id === s.activeId));
}
