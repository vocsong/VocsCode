import type { VocsCodeApi } from '../../shared/ipc';

declare global {
  interface Window {
    harness: VocsCodeApi;
  }
}

export {};
