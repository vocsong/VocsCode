import type { VocsDeskApi } from '../../shared/ipc';

declare global {
  interface Window {
    harness: VocsDeskApi;
  }
}

export {};
