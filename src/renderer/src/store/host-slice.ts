/**
 * Host lifecycle (boot/resync/reset), settings, model catalog, availability,
 * onboarding, terminals, Vesta agent, updates, remote policy, and toast notifications slice.
 */
import { EMPTY_AGENT_STATE } from '../../../shared/agent';
import type { AppSettings, HarnessId } from '../../../shared/types';
import { canInvoke, invoke, on } from '../api';
import * as panes from '../panes';
import { applyLayout, bootErrorMessage } from './helpers';
import { getStoreOptions, resetStoreRuntime } from './runtime';
import type { Getter, ModelCatalogEntry, Setter, State, StoreRuntime } from './types';

type HostSliceKeys =
  | 'booted'
  | 'bootError'
  | 'settings'
  | 'modelCatalog'
  | 'availability'
  | 'availabilityError'
  | 'terminals'
  | 'terminalsLoaded'
  | 'activeTerminal'
  | 'terminalFocusNonce'
  | 'composerInsert'
  | 'onboardingOpen'
  | 'onboardingDismissed'
  | 'onboardingHarness'
  | 'agent'
  | 'updateState'
  | 'processSummary'
  | 'desktopFocus'
  | 'remoteAccess'
  | 'agentPrefill'
  | 'toasts'
  | 'boot'
  | 'resync'
  | 'reset'
  | 'setSettings'
  | 'setAgentState'
  | 'openVesta'
  | 'toast'
  | 'dismissToast'
  | 'openOnboarding'
  | 'dismissOnboarding'
  | 'recordHarnessAvailability'
  | 'refreshAvailability'
  | 'ensureModelCatalog'
  | 'refreshModelCatalog'
  | 'setTerminals'
  | 'setActiveTerminal'
  | 'focusTerminal'
  | 'insertIntoComposer'
  | 'clearComposerInsert';

export function createHostSlice(rt: StoreRuntime, toastError: (error: unknown) => void) {
  return (set: Setter, get: Getter): Pick<State, HostSliceKeys> => ({
    booted: false,
    bootError: null,
    settings: null,
    modelCatalog: {},
    availability: {},
    availabilityError: null,
    terminals: [],
    terminalsLoaded: false,
    activeTerminal: {},
    terminalFocusNonce: 0,
    composerInsert: null,
    onboardingOpen: false,
    onboardingDismissed: false,
    onboardingHarness: null,
    agent: EMPTY_AGENT_STATE,
    updateState: { status: 'idle' },
    processSummary: null,
    desktopFocus: null,
    remoteAccess: { viewOnly: false },
    agentPrefill: null,
    toasts: [],

    boot() {
      if (rt.bootInFlight) return rt.bootInFlight;
      if (get().booted && get().settings && !get().bootError) return Promise.resolve();
      set({ bootError: null, booted: false });
      const storeOptions = getStoreOptions();
      rt.bootInFlight = (async () => {
        // Install the push subscriptions before any round trip: a boot that fails halfway must not
        // leave the store deaf to events, and a reconnect must not need a second boot to listen.
        if (!rt.subscribed) {
          try {
            on('push:sessionsChanged', (list) => get().setSessions(list));
            on('push:settingsChanged', (s) => get().setSettings(s));
            on('push:sessionEvent', (env) => get().applyEvent(env));
            on('push:focusSession', ({ sessionId }) => void get().setActive(sessionId).catch(toastError));
            on('push:terminalsChanged', (list) => get().setTerminals(list));
            on('push:agentState', (s) => get().setAgentState(s));
            on('push:updateState', (s) => set({ updateState: s }));
            on('push:processSummary', (summary) => set({ processSummary: summary }));
            on('push:desktopFocus', (focus) => set({ desktopFocus: focus }));
            on('push:remotePolicy', ({ viewOnly }) => set({ remoteAccess: { viewOnly } }));
            rt.subscribed = true;
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
          if (storeOptions.openFirstSessionOnBoot !== false) {
            // A split from the last run comes back when its sessions still exist; otherwise the first
            // session opens exactly as it did before split view existed.
            const restored = panes.restoreLayout(panes.loadStoredLayout(), (id) => sessions.some((s) => s.id === id && !s.archived));
            if (restored && restored.panes.length > 1) await applyLayout(rt, set, get, restored);
            else if (first) await get().setActive(first.id);
            rt.persistLayout = true;
          }
          // Availability probes spawn one subprocess per harness; kicking them off right as the
          // window opens competes with the first git calls and stalls startup under antivirus.
          // On-demand refreshes (dialogs, settings, fork menus) stay immediate.
          if (storeOptions.probeAvailabilityOnBoot !== false) {
            if (rt.availabilityTimer) clearTimeout(rt.availabilityTimer);
            rt.availabilityTimer = setTimeout(() => {
              rt.availabilityTimer = null;
              void get().refreshAvailability();
            }, 2_500);
          }
        } catch (error) {
          set({ booted: false, bootError: bootErrorMessage(error) });
        }
      })().finally(() => {
        rt.bootInFlight = null;
      });
      return rt.bootInFlight;
    },

    async resync() {
      const generation = rt.storeGeneration;
      const [settings, sessions] = await Promise.all([invoke('settings:get', undefined), invoke('sessions:list', undefined)]);
      if (generation !== rt.storeGeneration) return;
      // The remote policy is live (`push:remotePolicy`) and boot owns its initial value; a resync
      // must not overwrite a newer push with a settings read that raced it.
      set({ settings, sessions });
      if (canInvoke('desktop:focus')) {
        void invoke('desktop:focus', undefined).then((focus) => {
          if (generation === rt.storeGeneration) set({ desktopFocus: focus });
        }).catch(() => undefined);
      }
      const active = get().activeId;
      // Force the window even when it is marked loaded; the current items stay on screen until the
      // fresh page replaces them, so a reconnect never blanks the transcript.
      if (active) await get().loadTranscript(active, true);
    },

    reset() {
      resetStoreRuntime(rt);
      // The push subscriptions from boot stay in place: they resolve the store dynamically, and a
      // computer switch must not double-subscribe when the new host boots.
      set({
        booted: false,
        bootError: null,
        settings: null,
        sessions: [],
        activeId: null,
        layout: panes.singlePaneLayout(),
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
        archiving: {},
        gitPullRequestPreview: null,
        fileReveal: null,
        subagentReveal: null,
        searchJump: null,
        processSummary: null,
        desktopFocus: null,
        remoteAccess: { viewOnly: false },
        history: [],
        historyIndex: -1
      });
    },

    setSettings(settings) {
      set((s) => {
        // Discovery and its last-good fallback belong to this configuration. Do not resurrect a
        // removed endpoint or an old runtime's catalog after a settings change or in-flight probe.
        const catalogInputs = (value: AppSettings) => [value.modelOverrides, value.providers, value.binaries, value.claude];
        const stale = !!s.settings && JSON.stringify(catalogInputs(s.settings)) !== JSON.stringify(catalogInputs(settings));
        return stale ? { settings, modelCatalog: {} } : { settings };
      });
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
      const id = `t${++rt.toastCounter}`;
      set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000);
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    openOnboarding(harness) {
      set({ onboardingOpen: true, onboardingHarness: harness ?? null });
    },

    dismissOnboarding() {
      // Dismissal is transient. Only the guide's explicit Finish/Skip actions persist completion.
      set({ onboardingOpen: false, onboardingDismissed: true, modelCatalog: {} });
    },

    recordHarnessAvailability(harness, availability) {
      // A setup card is fresher than an already-in-flight whole-app check. Preserve that card's
      // result without discarding the old check's still-useful results for the other harnesses.
      rt.availabilityOverrides[harness] = rt.availabilityRequest;
      set((s) => ({ availability: { ...s.availability, [harness]: availability } }));
    },

    async refreshAvailability() {
      const request = ++rt.availabilityRequest;
      try {
        const availability = await invoke('harness:availability', { refresh: true });
        if (request === rt.availabilityRequest) {
          const fresh = Object.fromEntries(Object.entries(availability).filter(([id]) => (rt.availabilityOverrides[id as HarnessId] ?? 0) < request));
          set((s) => ({ availability: { ...s.availability, ...fresh }, availabilityError: null }));
        }
      } catch (e) {
        if (request === rt.availabilityRequest) set({ availabilityError: e instanceof Error ? e.message : String(e) });
      }
    },

    async ensureModelCatalog(harness) {
      // Present means fetched, failed or in flight: one round trip per harness, not per session.
      if (get().modelCatalog[harness]) return;
      await get().refreshModelCatalog(harness);
    },

    async refreshModelCatalog(harness, context) {
      const previous = get().modelCatalog[harness];
      const put = (entry: ModelCatalogEntry) => set((s) => ({ modelCatalog: { ...s.modelCatalog, [harness]: entry } }));
      const pending: ModelCatalogEntry = { models: previous?.models ?? [], loading: true };
      put(pending);
      let result: ModelCatalogEntry;
      try {
        const r = await invoke('harness:models', { harness, ...context });
        if (!Array.isArray(r?.models)) throw new Error('Harness model discovery returned an invalid catalog.');
        result = { models: r.error && previous?.models.length ? previous.models : r.models, error: r.error, loading: false };
      } catch (e) {
        result = { models: previous?.models ?? [], error: e instanceof Error ? e.message : String(e), loading: false };
      }
      // Settings invalidation or a newer refresh owns the catalog now; never resurrect an old request.
      if (get().modelCatalog[harness] === pending) put(result);
      return result;
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
  });
}
