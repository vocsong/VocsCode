/** Shared transcript primitives: row timestamp, image-expand callback type, and session link context. */
import React, { createContext } from 'react';
import { fmtStamp, fmtStampFull } from '../../format';
import type { LightboxImage } from '../ImageLightbox';

export type OnImageExpand = (images: LightboxImage[], index: number) => void;

export interface TranscriptSessionContextValue {
  cwd: string | undefined;
  canOpenPr: boolean;
}

/**
 * Provided once by `Transcript` so individual `AssistantMessage` rows do not subscribe to
 * `s.sessions.find(...)` on every store update. Standalone renders (e.g. unit tests mounting
 * `WorkGroup` directly) receive `null` and fall back to primitive store selectors.
 */
export const TranscriptSessionContext = createContext<TranscriptSessionContextValue | null>(null);

/**
 * When a message, step or thought happened. Standard shows it quietly on every row; Zen keeps it
 * out of sight until the row is pointed at (ui-zen.css). The tooltip carries the full date to the
 * second, plus whatever `detail` the row adds (how long a step took, when an approval was answered).
 */
export function Stamp({ ts, className = '', detail }: { ts: number; className?: string; detail?: string }) {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const full = fmtStampFull(ts);
  return (
    <time className={`stamp ${className}`} dateTime={new Date(ts).toISOString()} title={detail ? `${full} · ${detail}` : full}>
      {fmtStamp(ts)}
    </time>
  );
}
