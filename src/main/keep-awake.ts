import type { SessionMeta } from '../shared/types';
import type { Logger } from './log';

/** The slice of Electron's `powerSaveBlocker` this module needs. */
export interface PowerBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

/** A turn is in flight; an idle, stopped or errored session has nothing left to protect. */
export function isSessionActive(session: Pick<SessionMeta, 'status'>): boolean {
  return session.status === 'running' || session.status === 'awaiting' || session.status === 'starting';
}

/**
 * Keeps the machine from idle-sleeping while a session that asked for it is working. One blocker is
 * held for the whole app and released the moment no opted-in session is active, so the machine
 * sleeps normally once the work is done. It prevents idle sleep only: closing the lid or choosing
 * Sleep still suspends the machine.
 */
export class KeepAwake {
  private blockerId: number | null = null;

  constructor(private readonly blocker: PowerBlocker, private readonly log: Logger) {}

  get held(): boolean {
    return this.blockerId !== null;
  }

  /** Reconcile the blocker with the current session list; cheap enough to call on every change. */
  sync(sessions: readonly SessionMeta[]): void {
    const wanted = sessions.some((session) => session.keepAwake === true && !session.archived && isSessionActive(session));
    if (wanted && this.blockerId === null) {
      this.blockerId = this.blocker.start('prevent-app-suspension');
      this.log('info', 'keep-awake: holding a power-save blocker while an opted-in session is working');
    } else if (!wanted) {
      this.release();
    }
  }

  release(): void {
    if (this.blockerId === null) return;
    const id = this.blockerId;
    this.blockerId = null;
    try {
      this.blocker.stop(id);
    } catch (e) {
      this.log('warn', `keep-awake: releasing the power-save blocker failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.log('info', 'keep-awake: released the power-save blocker');
  }
}
