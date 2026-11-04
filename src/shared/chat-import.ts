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
  /** The existing chat is saved, but its stored project is absent from registered folders. */
  registrationPending?: boolean;
}

export const CHAT_IMPORT_SKIP_REASON_LABELS = {
  empty: 'Empty or no conversation text',
  subagent: 'Subagent history',
  missingProject: 'Missing or invalid project directory metadata',
  invalidHistory: 'Unrecognized or invalid history',
  unsupportedHistory: 'Linked Codex history is not supported',
  tooLarge: 'File exceeds the size limit',
  scanBudget: 'File exceeds the remaining scan budget',
  unreadable: 'History file could not be read',
} as const;

export type ChatImportSkipReason = keyof typeof CHAT_IMPORT_SKIP_REASON_LABELS;
/** One reason per skipped file; omitted categories have zero occurrences. */
export type ChatImportSkipCounts = Partial<Record<ChatImportSkipReason, number>>;

export interface ChatImportPreview {
  candidates: ChatImportCandidate[];
  skipped: number;
  skippedReasons?: ChatImportSkipCounts;
  /** Root/directory read failures, not included in the skipped file count. */
  scanErrors?: number;
  malformedLines?: number;
  truncated?: boolean;
}
