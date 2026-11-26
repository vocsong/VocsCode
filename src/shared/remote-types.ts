/**
 * Shared relay-connection configuration, live state, and device types.
 * Keep this file free of Node/Electron/DOM imports.
 */

/** The desktop's relay connection (docs/CONTROL-MCP.md, docs/WEB-DASHBOARD.md): config + live state
 *  surfaced to the renderer. */
export interface RemoteConfig {
  enabled: boolean;
  /** Upload this computer's analytics snapshot for the code.vocs.io dashboard
   *  (docs/WEB-DASHBOARD.md). On unless set to false; turning it off deletes the relay copy. */
  shareAnalytics?: boolean;
}

export interface DesktopFocus {
  /** The session the desktop window is on, or null while it is on Home. */
  sessionId: string | null;
  /** Epoch ms of the last change, so a reader can tell a fresh report from a stale one. */
  at: number;
  /** Whether the desktop window is foregrounded. */
  windowFocused: boolean;
}

export interface RemoteState {
  status: 'off' | 'connecting' | 'online' | 'error';
  detail?: string;
  /** Connect with Vocs in progress: the page opened in the browser, and the code it must show. */
  signIn?: { link: string; checkCode: string };
  /** This computer holds its own relay credential, live with every state push (remote:get also
   *  answers it from storage before the connection was ever turned on). */
  registered?: boolean;
}

export interface RemoteDeviceInfo {
  deviceId: string;
  /** 'web' records are browsers an older build paired; they can no longer reach this computer. */
  kind: 'host' | 'web';
  name: string;
  platform: string;
  lastSeen: number;
  /** Connected to the relay right now (absent from relays that predate presence). */
  online?: boolean;
}
