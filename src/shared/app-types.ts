/**
 * Shared app-level updater, secret-store status, and doctor diagnostics types.
 * Keep this file free of Node/Electron/DOM imports.
 */
import type { HarnessAvailability, HarnessId } from './harness-types';

/** In-app auto-update state (issue #198); pushed to the renderer on every transition. */
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'restart-pending' | 'up-to-date' | 'error';

export interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface UpdateState {
  status: UpdateStatus;
  /** Target version once the check or download knows it. */
  version?: string;
  /** Download progress; present only while downloading. */
  progress?: UpdateProgress;
  /** Human-readable failure; present only in the error status. */
  error?: string;
  /** The update is downloaded but the restart prompt is held while any session is live. */
  deferred?: boolean;
  /** When the last check finished (either outcome), for the About panel. */
  checkedAt?: number;
}

export interface SecretStatus {
  /** Whether the OS-backed safeStorage provider is available. */
  encryptionAvailable: boolean;
  /** Whether one or more stored values use the reversible fallback encoding. */
  hasFallback: boolean;
  /** Provider ids whose stored values use the reversible fallback encoding. */
  fallbackProviderIds: string[];
}

export interface DoctorReport {
  node: string;
  electron: string;
  platform: string;
  harnesses: Record<HarnessId, HarnessAvailability>;
  providers: { id: string; name: string; hasKey: boolean; envKeyPresent: boolean }[];
  userData: string;
}
