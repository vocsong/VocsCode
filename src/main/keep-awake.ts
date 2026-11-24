import type { SessionMeta } from '../shared/types';
import { hasOngoingWork } from '../shared/ongoing';
import type { Logger } from './log';
import { errorMessage } from './util/async';

/** The slice of Electron's powerSaveBlocker this service needs. */
export interface PowerBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

/**
 * A desktop-host choice, never session metadata. Only work in a live, opted-in ordinary session
 * counts, regardless of where the turn came from. One blocker prevents idle sleep, not explicit
 * system sleep, and does not require the display to stay on.
 */
export class KeepAwake {
  private optedIn = new Set<string>();
  private blockerId: number | null = null;
  private quitting = false;

  constructor(private readonly blocker: PowerBlocker, private readonly log: Logger) {}

  enabled(id: string): boolean {
    return this.optedIn.has(id);
  }

  set(id: string, enabled: boolean, sessions: readonly SessionMeta[]): boolean {
    if (this.quitting) return false;
    if (enabled) this.optedIn.add(id);
    else this.optedIn.delete(id);
    this.sync(sessions);
    return this.enabled(id);
  }

  sync(sessions: readonly SessionMeta[]): void {
    if (this.optedIn.size === 0 && this.blockerId === null) return;
    let wanted = false;
    if (!this.quitting && this.optedIn.size) {
      const eligible = new Set<string>();
      for (const { id, status, ongoing, mission, archived } of sessions) {
        if (!this.optedIn.has(id) || mission || archived) continue;
        eligible.add(id);
        wanted ||= status === 'starting' || status === 'running' || status === 'awaiting' || hasOngoingWork({ ongoing });
      }
      // Deleting or archiving a session revokes the choice rather than leaving stale opt-ins.
      this.optedIn = eligible;
    }
    if (!wanted) this.release();
    else if (this.blockerId === null) {
      try {
        this.blockerId = this.blocker.start('prevent-app-suspension');
      } catch (error) {
        this.log('warn', `keep-awake: could not start the power-save blocker: ${errorMessage(error)}`);
      }
    }
  }

  quit(): void {
    this.quitting = true;
    this.optedIn.clear();
    this.release();
  }

  private release(): void {
    if (this.blockerId === null) return;
    try {
      this.blocker.stop(this.blockerId);
      this.blockerId = null;
    } catch (error) {
      // It might still be held. Keep the ID for retry and never acquire a duplicate.
      this.log('warn', `keep-awake: could not stop the power-save blocker: ${errorMessage(error)}`);
    }
  }
}
