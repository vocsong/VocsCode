/** The capabilities the shared renderer core adapts to (docs/REMOTE-ACCESS.md §4). The desktop
 *  provides today's behavior by default; the web shell narrows it with a provider. Every check is
 *  UX only: the host still refuses a channel the client thinks it can use. */
import React, { createContext, useContext, useMemo } from 'react';
import type { IpcChannel } from '../../shared/ipc';
import { canInvoke } from './api';
import { useStore } from './store';

export interface TranscriptCapabilities {
  /** Right-click menu on transcript rows. */
  contextMenu: boolean;
  /** Edit and resend a past user message. */
  editAndResend: boolean;
  /** File links open the host's Files view. */
  openFile: boolean;
  /** Extra content above the transcript rows (web banners); nothing on the desktop. */
  header?: React.ReactNode;
}

const DESKTOP: TranscriptCapabilities = { contextMenu: true, editAndResend: true, openFile: true };

const TranscriptCapabilitiesContext = createContext<TranscriptCapabilities>(DESKTOP);

export function TranscriptCapabilitiesProvider({ value, children }: { value: TranscriptCapabilities; children: React.ReactNode }) {
  return <TranscriptCapabilitiesContext.Provider value={value}>{children}</TranscriptCapabilitiesContext.Provider>;
}

export function useTranscriptCapabilities(): TranscriptCapabilities {
  return useContext(TranscriptCapabilitiesContext);
}

/** Reactive channel gate: re-renders when the remote policy changes view-only mode. */
export function useCanInvoke(channel: IpcChannel): boolean {
  const viewOnly = useStore((s) => s.remoteAccess.viewOnly);
  return useMemo(() => canInvoke(channel), [channel, viewOnly]);
}
