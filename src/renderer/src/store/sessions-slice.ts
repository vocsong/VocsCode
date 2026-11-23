/**
 * Sessions, transcripts, streaming delta batching, drafts, and composer history slice.
 */
import { resolveNewSessionDefaults } from '../../../shared/session-defaults';
import type { SessionConfig, SessionMeta, TranscriptItem } from '../../../shared/types';
import { invoke } from '../api';
import * as panes from '../panes';
import { affectsActiveWorkspace, dropPendingDeltas, replayBuffered, replacementFor, sameUsageTotals } from './helpers';
import { getStoreOptions } from './runtime';
import { COMPOSER_HISTORY_LIMIT, type Getter, type Setter, type State, type StoreRuntime } from './types';

type SessionsSliceKeys =
  | 'sessions'
  | 'transcripts'
  | 'loaded'
  | 'transcriptErrors'
  | 'transcriptFloors'
  | 'transcriptStarts'
  | 'models'
  | 'drafts'
  | 'composerHistory'
  | 'archiving'
  | 'changesVersion'
  | 'loadTranscript'
  | 'loadEarlier'
  | 'applyEvent'
  | 'setSessions'
  | 'createQuickSession'
  | 'clearTranscriptLocal'
  | 'replaceTranscript'
  | 'setLocalInfo'
  | 'setDraft'
  | 'pushComposerHistory'
  | 'setArchiving';

export function createSessionsSlice(rt: StoreRuntime, toastError: (error: unknown) => void) {
  return (set: Setter, get: Getter): Pick<State, SessionsSliceKeys> => ({
    sessions: [],
    transcripts: {},
    loaded: {},
    transcriptErrors: {},
    transcriptFloors: {},
    transcriptStarts: {},
    models: {},
    drafts: {},
    composerHistory: {},
    archiving: {},
    changesVersion: 0,

    loadTranscript(id, force = false) {
      const pending = rt.transcriptLoads.get(id);
      if (pending) return pending;
      if (!force && get().loaded[id]) return Promise.resolve();
      const generation = rt.storeGeneration;
      const paged = getStoreOptions().pagedTranscripts === true;
      // A paged read has no floor until it lands; hold its events so the snapshot and the stream can
      // be reconciled by sequence instead of the events landing on an empty list.
      if (paged) rt.bufferedEvents.set(id, []);
      // Register before invoking IPC or notifying subscribers, which may request the same load.
      const request = Promise.resolve().then(async () => {
        if (rt.transcriptLoads.get(id) !== request) return;
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
            if (rt.transcriptLoads.get(id) !== request || generation !== rt.storeGeneration) return;
            set((s) => ({
              transcripts: { ...s.transcripts, [id]: page.items },
              loaded: { ...s.loaded, [id]: true },
              transcriptFloors: page.seq === undefined ? s.transcriptFloors : { ...s.transcriptFloors, [id]: page.seq },
              transcriptStarts: { ...s.transcriptStarts, [id]: page.start }
            }));
            replayBuffered(rt, get, id);
          } else {
            const items = await invoke('sessions:transcript', { id });
            if (rt.transcriptLoads.get(id) !== request || generation !== rt.storeGeneration) return;
            // The snapshot already contains any streamed text; queued deltas would duplicate it.
            dropPendingDeltas(rt, id);
            set((s) => ({ transcripts: { ...s.transcripts, [id]: items }, loaded: { ...s.loaded, [id]: true } }));
          }
        } catch (e) {
          if (rt.transcriptLoads.get(id) !== request || generation !== rt.storeGeneration) return;
          // Never throw: the transcript pane stays mounted with a retry instead of loading forever.
          set((s) => ({ transcriptErrors: { ...s.transcriptErrors, [id]: e instanceof Error ? e.message : String(e) } }));
          if (paged) replayBuffered(rt, get, id);
        }
      }).finally(() => {
        if (rt.transcriptLoads.get(id) === request) rt.transcriptLoads.delete(id);
      });
      rt.transcriptLoads.set(id, request);
      return request;
    },

    loadEarlier(id) {
      const start = get().transcriptStarts[id];
      if (getStoreOptions().pagedTranscripts !== true || start === undefined || start <= 0) return Promise.resolve();
      const pending = rt.transcriptEarlier.get(id);
      if (pending) return pending;
      const generation = rt.storeGeneration;
      // The older page brings no floor of its own: events during the read keep counting against the
      // current one, so replay holds them until it returns and then applies them in order.
      rt.bufferedEvents.set(id, []);
      const request = Promise.resolve()
        .then(async () => {
          try {
            const page = await invoke('sessions:transcriptPage', { id, end: start });
            if (generation !== rt.storeGeneration || rt.transcriptEarlier.get(id) !== request) return;
            set((s) => ({
              transcripts: { ...s.transcripts, [id]: [...page.items, ...(s.transcripts[id] ?? [])] },
              transcriptStarts: { ...s.transcriptStarts, [id]: page.start }
            }));
          } catch (e) {
            if (generation !== rt.storeGeneration) return;
            get().toast(e instanceof Error ? e.message : String(e), 'error');
          } finally {
            if (generation === rt.storeGeneration) replayBuffered(rt, get, id);
          }
        })
        .finally(() => {
          if (rt.transcriptEarlier.get(id) === request) rt.transcriptEarlier.delete(id);
        });
      rt.transcriptEarlier.set(id, request);
      return request;
    },

    applyEvent(env) {
      const { event, sessionId } = env;
      // A page in flight has no floor yet: hold the event until the page lands, then replay past it.
      const buffered = rt.bufferedEvents.get(sessionId);
      if (buffered) {
        buffered.push(env);
        return;
      }
      // Paged clients get a floor with the window; anything at or below it is already in the list.
      // `seq` is absent from an older desktop, in which case nothing is dropped.
      const floor = get().transcriptFloors[sessionId];
      if (floor !== undefined && env.seq !== undefined && env.seq <= floor) return;
      if (event.type === 'item.delta') {
        rt.pendingDeltas.push(env);
        if (!rt.flushScheduled) {
          rt.flushScheduled = true;
          requestAnimationFrame(() => {
            rt.flushScheduled = false;
            const batch = rt.pendingDeltas.splice(0);
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
          dropPendingDeltas(rt, sessionId, event.item.id);
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

    setSessions(sessions) {
      const ids = new Set(sessions.map((x) => x.id));
      for (const id of rt.transcriptLoads.keys()) {
        if (!ids.has(id)) {
          rt.transcriptLoads.delete(id);
          dropPendingDeltas(rt, id);
        }
      }
      let replacement: SessionMeta | undefined;
      let departedTitle: string | undefined;
      let departedArchived = false;
      /** A pane left waiting for a pick after its neighbour closed, filled the way a lone pane would be. */
      let refilled: string | undefined;
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
        const activeRemoved = !!activeId && (!after || after.mission?.role === 'worker' || (!before?.archived && !!after.archived));
        if (activeRemoved && activeId) {
          departedTitle = before?.title ?? activeId;
          departedArchived = !!after?.archived;
          replacement = replacementFor(s.sessions, sessions, activeId);
        }
        // Any pane whose session left closes; the last pane takes the replacement instead.
        const departed = (id: string) => {
          const was = s.sessions.find((x) => x.id === id);
          const now = sessions.find((x) => x.id === id);
          return !now || now.mission?.role === 'worker' || (!was?.archived && !!now.archived);
        };
        let layout = panes.withoutSessions(s.layout, departed, activeRemoved ? replacement?.id ?? null : null);
        if (layout.panes.length < s.layout.panes.length) {
          // A pane closed and its neighbour took over. A neighbour still waiting for a pick gets the
          // sidebar's replacement, exactly as a lone pane would, rather than leaving an empty screen.
          const next = panes.activePane(layout).sessionId;
          if (next) {
            if (activeRemoved) replacement = sessions.find((x) => x.id === next);
          } else {
            const gone = s.layout.panes.find((p) => p.sessionId && departed(p.sessionId))!.sessionId!;
            const pick = replacement ?? replacementFor(s.sessions, sessions, gone);
            if (pick && !panes.paneShowing(layout, pick.id)) {
              layout = panes.openSession(layout, pick.id);
              if (!activeRemoved) refilled = pick.id;
            }
          }
        }
        const activeAfter = layout === s.layout ? s.activeId : panes.activePane(layout).sessionId;
        if (removed.size === 0 && !activeRemoved && layout === s.layout) return { sessions };
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
          layout,
          activeId: activeAfter
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
      if (refilled) void get().loadTranscript(refilled).catch(toastError);
    },

    async createQuickSession(root, first) {
      const settings = get().settings;
      if (!settings) return false;
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
        branchPrefix: defaults.branchPrefix,
        acpAgent: harness === 'acp' ? defaults.acpAgent : undefined
      };
      try {
        const meta = await invoke('sessions:create', {
          config,
          initialPrompt: first?.prompt?.trim() || undefined,
          initialImages: first?.images?.length ? first.images : undefined,
          initialFiles: first?.files?.length ? first.files : undefined
        });
        await get().setActive(meta.id);
        return true;
      } catch (e) {
        get().toast(String((e as Error).message ?? e), 'error');
        return false;
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
      dropPendingDeltas(rt, id);
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
    }
  });
}
