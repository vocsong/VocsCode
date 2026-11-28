/**
 * Shared transcript item, attachment, approval, and subagent reporting types.
 * Keep this file free of Node/Electron/DOM imports.
 */
import type { HarnessId, ModelRef } from './harness-types';
import type { ApprovalMissionRoute, MissionMessageMeta } from './mission-mode';
import type { SubagentRunMode, SubagentRunStatus } from './subagents';
import type { UsageTotals } from './usage-types';

/** Live view of a Vocs Code subagent run, as the pi extension reports it. */
export interface SubagentRunUpdate {
  runId: string;
  agent: string;
  description: string;
  mode: SubagentRunMode;
  status: SubagentRunStatus;
  provider?: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
  costUsd?: number;
  turns?: number;
  toolUses?: number;
  error?: string;
}

export interface ImageAttachment {
  mimeType: string;
  /** Base64 data without the data: prefix. */
  data: string;
  name?: string;
}

export interface FileAttachment {
  name: string;
  mimeType: string;
  /** Base64 data without the data: prefix. */
  data: string;
}

/** Persisted reference to a file copied into the session's attachment directory. */
export interface AttachedFile {
  name: string;
  mimeType: string;
  path: string;
}

export type SendMode = 'now' | 'steer' | 'queue';

export interface UserInput {
  text: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  mode?: SendMode;
  /** Internal link to the persisted user item; adapters use it to checkpoint rewindable context. */
  transcriptItemId?: string;
}

export interface FileChange {
  path: string;
  kind: 'add' | 'delete' | 'update' | 'rename';
  diff?: string;
  oldPath?: string;
}

export type ToolKindHint = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'mcp' | 'agent' | 'other';

export type TranscriptItem =
  | {
      id: string;
      kind: 'user';
      ts: number;
      text: string;
      images?: ImageAttachment[];
      files?: AttachedFile[];
      /** Set instead of `images` when a remote projection dropped them to fit the relay frame
       *  budget; the count is what the bubble reports as not shown. */
      imagesOmitted?: number;
      queuedAs?: SendMode;
      /** Host-measured original message text, before prompt assembly. Absent on legacy/automated input.
       * The receipt survives replay; its owner prevents copied fork history being counted again. */
      userInput?: { id: string; sessionId: string; ts: number; tokens: number };
      /** Host receipt of the Shared skill revision dispatched for this command, never the skill body. */
      sharedSkill?: import('./shared-skills').SharedSkillReceipt;
      /** Written by Mission mode, not typed by the user: a kickoff, a Lead↔Builder message or a report. */
      origin?: 'mission';
      mission?: MissionMessageMeta;
    }
  | {
      id: string;
      kind: 'assistant';
      ts: number;
      text: string;
      thinking?: string;
      model?: string;
      streaming?: boolean;
      /** Codex distinguishes commentary from the final answer. */
      phase?: 'commentary' | 'final' | 'plan';
    }
  | {
      id: string;
      kind: 'tool';
      ts: number;
      name: string;
      title?: string;
      hint?: ToolKindHint;
      input?: unknown;
      /** Pretty summary of the input (command line, path...). */
      summary?: string;
      output?: string;
      status: 'running' | 'done' | 'error' | 'declined';
      exitCode?: number | null;
      durationMs?: number;
      changes?: FileChange[];
      /** Parent tool (subagent) id when nested. */
      parentId?: string | null;
      /** Model id that produced this call when the harness reports it per message (Claude); a subagent's differs from the session's. */
      model?: string;
      /** Subagent run this card reports, so it can link into the Subagents panel. */
      runId?: string;
    }
  | {
      id: string;
      kind: 'approval';
      ts: number;
      request: ApprovalRequest;
      decision?: ApprovalDecision;
      decidedAt?: number;
      /** Mission mode: whether the Builder's Lead or the user answered. Absent means the user. */
      decidedBy?: 'lead' | 'user';
    }
  | {
      id: string;
      kind: 'info';
      ts: number;
      level: 'info' | 'warn' | 'error';
      text: string;
      /** Set while a renderer-local operation (e.g. /pr) is still running; shows a spinner. */
      pending?: boolean;
    }
  | {
      id: string;
      kind: 'turn';
      ts: number;
      status: 'completed' | 'interrupted' | 'failed';
      durationMs?: number;
      usage?: Partial<UsageTotals>;
      costUsd?: number;
      /**
       * Set on a turn copied in from the session this one was forked from. Its tokens describe the
       * context the fork inherited, so they are kept, but its `costUsd` is zero: that money was
       * spent — and counted — by the session it came from. Distinguishes such a row from a
       * completed turn the tracker genuinely recorded at zero (see `TurnUsageTracker.beginProcess`).
       */
      carried?: boolean;
      error?: string;
    }
  | {
      id: string;
      kind: 'plan';
      ts: number;
      entries: { content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: string }[];
    };

export type ApprovalKind = 'command' | 'file_change' | 'tool' | 'permission' | 'question' | 'elicitation';

export interface ApprovalOption {
  id: string;
  label: string;
  kind: 'allow' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always' | 'cancel';
  description?: string;
}

export interface ApprovalQuestion {
  id: string;
  header?: string;
  question: string;
  options?: { label: string; description?: string }[];
  allowOther?: boolean;
  multiSelect?: boolean;
  secret?: boolean;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  harness: HarnessId;
  kind: ApprovalKind;
  title: string;
  description?: string;
  toolName?: string;
  command?: string;
  cwd?: string;
  input?: unknown;
  changes?: FileChange[];
  options: ApprovalOption[];
  questions?: ApprovalQuestion[];
  /** Raw extension dialogs may need an exact scalar response and cannot carry extra context. */
  supportsQuestionComment?: boolean;
  /** Optional serialized response budget for a single-question RPC envelope. */
  maxQuestionResponseLength?: number;
  createdAt: number;
  /** Related transcript tool item id, when known. */
  toolItemId?: string;
  /** Mission mode: a Builder's request, routed to its Lead first. */
  mission?: ApprovalMissionRoute;
}


export interface ApprovalDecision {
  optionId: string;
  note?: string;
  answers?: Record<string, string>;
  /** Selected option labels for multi-select questions, keyed by question id. */
  multiAnswers?: Record<string, string[]>;
  /** For 'allow' with edited input (e.g. modified command). */
  updatedInput?: unknown;
}

/** Subagent spend to move off the parent model; a null pair explicitly means unknown identity. */
export type SubagentCost = { costUsd: number } & (ModelRef | { provider: null; model: null });

/** A finished pi-subagents run, reported to the app so its work is counted and attributed. */
export interface SubagentCompletion {
  agentId: string;
  description?: string;
  /** Terminal pi-subagents status: completed, error, stopped, aborted. */
  status: string;
  /** The model the run actually used; null explicitly means unknown, never the parent's model. */
  model?: ModelRef | null;
  /** Internal tool calls the run made; these never enter the parent transcript. */
  toolUses: number;
  costUsd?: number;
  tokens?: number;
  durationMs?: number;
  error?: string;
  /** Agent type that ran (Vocs Code subagents report `Explore`, `Plan`, ...). */
  agentType?: string;
  /**
   * Token breakdown a background run produced that the harness totals do not include yet. Foreground
   * runs omit it: pi folds their usage into the session totals through the tool result, and counting
   * it here as well would double the spend.
   */
  usage?: Partial<UsageTotals>;
}
