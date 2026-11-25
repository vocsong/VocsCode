/** Structural RemoteHost surface consumed by IPC handlers, keeping handlers/ decoupled from remote/host.ts. */
import type { RemoteAuditEntry, RemoteDeviceInfo, RemoteState } from '../../shared/remote-types';

export interface RemoteHostPort {
  state(): RemoteState;
  isRegistered(): Promise<boolean>;
  listDevices(): Promise<RemoteDeviceInfo[]>;
  auditEntries(): RemoteAuditEntry[];
  clearAudit(): void;
  signIn(relayUrl: string, open: (url: string) => Promise<void>, hostName?: string): Promise<void>;
  enable(relayUrl: string, enrollToken: string): Promise<void>;
  disable(): Promise<void>;
  startPairing(hostName: string): Promise<{ code: string; expiresAt: number }>;
  respondPairing(decision: 'approve' | 'deny'): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  revokeAll(): Promise<void>;
  broadcastPolicy(): Promise<void>;
  auditMirror(enabled: boolean): void;
}
