/** Structural RemoteHost surface consumed by IPC handlers, keeping handlers/ decoupled from remote/host.ts. */
import type { RemoteDeviceInfo, RemoteState } from '../../shared/remote-types';

export interface RemoteHostPort {
  state(): RemoteState;
  isRegistered(): Promise<boolean>;
  listDevices(): Promise<RemoteDeviceInfo[]>;
  signIn(relayUrl: string, open: (url: string) => Promise<void>, hostName?: string): Promise<void>;
  enable(relayUrl: string): Promise<void>;
  disable(): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  revokeAll(): Promise<void>;
}
