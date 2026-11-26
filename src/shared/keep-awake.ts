/** Owner-window IPC only. Not part of the handler registry or session metadata. */
export const KEEP_AWAKE_CHANNEL = 'desktop:keepAwake';

export interface KeepAwakeBridge {
  /** With no `enabled`, read the current in-memory choice. Always returns the choice, not OS state. */
  preference(request: { id: string; enabled?: boolean }): Promise<boolean>;
}
