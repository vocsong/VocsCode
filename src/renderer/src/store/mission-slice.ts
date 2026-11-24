/**
 * Mission mode, renderer side: the composer's armed switch (renderer-local, never persisted) and the
 * last `mission:get` view of each Lead, which the status strip and the transcript cards read. The host
 * owns every mission fact; `SessionMeta.mission` arrives with the session list.
 */
import type { MissionView } from '../../../shared/mission-mode';
import { invoke } from '../api';
import type { Getter, Setter, State } from './types';

type MissionSliceKeys = 'missionArmed' | 'missionViews' | 'setMissionArmed' | 'refreshMission' | 'putMissionView';

export function createMissionSlice() {
  /** The newest `mission:get` per session; an older answer that lands later is dropped. */
  const requests = new Map<string, number>();
  let counter = 0;
  return (set: Setter, get: Getter): Pick<State, MissionSliceKeys> => ({
    missionArmed: {},
    missionViews: {},

    setMissionArmed(sessionId, on) {
      set((s) => {
        if (on === !!s.missionArmed[sessionId]) return {};
        const next = { ...s.missionArmed };
        if (on) next[sessionId] = true;
        else delete next[sessionId];
        return { missionArmed: next };
      });
    },

    async refreshMission(sessionId) {
      const n = ++counter;
      requests.set(sessionId, n);
      let view: MissionView | null;
      try {
        view = await invoke('mission:get', { sessionId });
      } catch {
        if (requests.get(sessionId) === n) requests.delete(sessionId);
        // The strip keeps showing what the session list says; the next change asks again.
        return get().missionViews[sessionId] ?? null;
      }
      // A newer request for this session is in flight: its answer wins.
      if (requests.get(sessionId) !== n) return view;
      requests.delete(sessionId);
      if (view) get().putMissionView(view);
      else set((s) => {
        if (!(sessionId in s.missionViews)) return {};
        const next = { ...s.missionViews };
        delete next[sessionId];
        return { missionViews: next };
      });
      return view;
    },

    putMissionView(view) {
      set((s) => (s.missionViews[view.leadId] === view ? {} : { missionViews: { ...s.missionViews, [view.leadId]: view } }));
    }
  });
}
