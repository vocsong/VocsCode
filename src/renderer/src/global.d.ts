/** Ambient declarations for the renderer, including the window.harness bridge type. */
import type { Transport as VocsCodeApi } from '../../shared/transport';

declare global {
  interface Window {
    harness: VocsCodeApi;
  }
}

export {};
