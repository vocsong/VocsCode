/** Ambient declarations for the renderer, including the window.harness bridge type. */
import type { VocsCodeApi } from '../../shared/ipc';
import type { KeepAwakeBridge } from '../../shared/keep-awake';

declare global {
  interface Window {
    harness: VocsCodeApi;
    keepAwake?: KeepAwakeBridge;
  }
}

export {};
