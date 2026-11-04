import type { ChatImportCandidate } from '../shared/chat-import';
import type { SessionMeta } from '../shared/types';

/** A provider conversation can already belong to an ordinary Vocs session, not just an import. */
export function representsChatImport(session: SessionMeta, candidate: Pick<ChatImportCandidate, 'source' | 'sourceSessionId'>): boolean {
  const { source, sourceSessionId } = candidate;
  if (session.importedFrom?.source === source && session.importedFrom.sessionId === sourceSessionId) return true;
  if (source === 'claude') return session.config?.harness === 'claude' && session.harnessRef?.claudeSessionId === sourceSessionId;
  return (session.config?.harness === 'codex' || session.config?.harness === 'codex-exec') && session.harnessRef?.codexThreadId === sourceSessionId;
}
