/** Ambient declarations for the renderer, including the window.harness bridge type. */
import type { VocsCodeApi } from '../../shared/ipc';

declare global {
  interface Window {
    harness: VocsCodeApi;
  }
}

export {};
