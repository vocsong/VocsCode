/**
 * Imperative runtime state for the renderer store.
 * Keeping every mutable counter, timer, and in-flight map in one object ensures
 * `reset()` clears all per-host state atomically.
 */
import type { StoreRuntime } from './types';

export function createStoreRuntime(): StoreRuntime {
  return {
    toastCounter: 0,
    pendingDeltas: [],
    flushScheduled: false,
    subscribed: false,
    bootInFlight: null,
    transcriptLoads: new Map(),
    storeGeneration: 0,
    availabilityTimer: null,
    navigating: false,
    persistLayout: false,
    fileNonce: 0,
    availabilityRequest: 0,
    availabilityOverrides: {}
  };
}

/** Resets all per-host imperative state while preserving the once-per-page push subscription flag. */
export function resetStoreRuntime(rt: StoreRuntime): void {
  rt.storeGeneration++;
  rt.pendingDeltas.length = 0;
  rt.flushScheduled = false;
  rt.transcriptLoads.clear();
  rt.bootInFlight = null;
  rt.navigating = false;
  rt.persistLayout = false;
  rt.availabilityRequest++;
  rt.availabilityOverrides = {};
  if (rt.availabilityTimer) {
    clearTimeout(rt.availabilityTimer);
    rt.availabilityTimer = null;
  }
}
