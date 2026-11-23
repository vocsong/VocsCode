/**
 * Shared remote-access configuration, live state, audit, and device types.
 * Keep this file free of Node/Electron/DOM imports.
 */

/** Remote access (docs/REMOTE-ACCESS.md §6): config + live state surfaced to the renderer. */
export interface RemoteConfig {
  enabled: boolean;
  /** P4 view-only mode: paired browsers may browse but not send, approve or change anything. */
  viewOnly?: boolean;
  /** P4 offline mirror: upload sealed transcript snapshots so browsers can read history while
   *  this desktop is offline. Opt-in, off by default. */
  mirror?: boolean;
}

export interface DesktopFocus {
  /** The session the desktop window is on, or null while it is on Home. */
  sessionId: string | null;
  /** Epoch ms of the last change, so a client can tell a fresh report from a stale one. */
  at: number;
  /** Whether the desktop window is foregrounded; a browser only follows while it is. */
  windowFocused: boolean;
}

export interface RemoteState {
  status: 'off' | 'connecting' | 'online' | 'error';
  detail?: string;
  pairing?: { code: string; expiresAt: number };
  pendingRequest?: { code: string; name: string; platform: string };
  onlineClients: string[];
  /** Mirrors the view-only policy so both shells can hide write controls without a round trip. */
  viewOnly: boolean;
  /** Connect with Vocs in progress: the page opened in the browser, and the code it must show. */
  signIn?: { link: string; checkCode: string };
  /** This computer holds its own relay credential, live with every state push (remote:get also
   *  answers it from storage before remote access was ever enabled). */
  registered?: boolean;
}

/** What a remote audit record can describe (docs/REMOTE-ACCESS.md §6.5): who paired, connected
 *  or was revoked, and which remote actions were refused. */
export type RemoteAuditAction =
  | 'enable'
  | 'disable'
  | 'pair-start'
  | 'pair-request'
  | 'pair-approve'
  | 'pair-deny'
  | 'device-revoke'
  /** Every other device of the account revoked at once (the kill switch). */
  | 'revoke-all'
  /** The relay stopped accepting this desktop's credential (it was revoked). */
  | 'host-revoked'
  /** Connect with Vocs: the browser was opened to add this computer, and when it was added. */
  | 'sign-in-start'
  | 'sign-in-registered'
  /** The offline mirror was re-keyed because a browser that could read it lost its pairing. */
  | 'mirror-rotate'
  | 'mirror-enable'
  | 'mirror-disable'
  /** The relay did not confirm a mirror clear; it is retried until it does (then 'mirror-clear-recovered'). */
  | 'mirror-clear-failed'
  | 'mirror-clear-recovered'
  | 'client-connect'
  | 'client-disconnect'
  | 'handshake-failed'
  | 'channel-refused'
  | 'view-only-blocked'
  /** A browser's first keystroke into a terminal during one connection (P3.5), not every one. */
  | 'terminal-input'
  /** A browser opened a new terminal for a session. */
  | 'terminal-create';

/** One audit-trail line; `device` is the id the event concerns, when there is one. */
export interface RemoteAuditEntry {
  at: number;
  action: RemoteAuditAction;
  device?: string;
  detail?: string;
}

export interface RemoteDeviceInfo {
  deviceId: string;
  kind: 'host' | 'web';
  name: string;
  platform: string;
  lastSeen: number;
  /** Connected to the relay right now (absent from relays that predate presence). */
  online?: boolean;
}
