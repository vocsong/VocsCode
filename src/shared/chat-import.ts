export type ChatImportSource = 'claude' | 'codex';

/** Preview metadata only; source file paths and transcript content stay in the main process. */
export interface ChatImportCandidate {
  id: string;
  source: ChatImportSource;
  sourceSessionId: string;
  title: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  imported?: boolean;
}

export interface ChatImportPreview {
  candidates: ChatImportCandidate[];
  skipped: number;
  malformedLines?: number;
  truncated?: boolean;
}
