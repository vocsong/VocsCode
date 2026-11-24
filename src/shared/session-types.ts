/**
 * Shared session lifecycle, event stream, search, and creation request types.
 * Keep this file free of Node/Electron/DOM imports.
 */
import type { EffortLevel, FastModeStatus, HarnessId, HarnessRef, ModelInfo, ModelRef, PermissionMode } from './harness-types';
import type { HarnessCommand } from './harness-commands';
import type { MissionOwnership } from './mission';
import type { OngoingItem, OngoingSource } from './ongoing';
import type { ApprovalDecision, ApprovalRequest, FileAttachment, ImageAttachment, SubagentCompletion, SubagentCost, SubagentRunUpdate, TranscriptItem } from './transcript-types';
import type { UsageTotals } from './usage-types';

export type SessionStatus = 'idle' | 'starting' | 'running' | 'awaiting' | 'error' | 'stopped' | 'pr' | 'merged';

export interface SessionConfig {
  harness: HarnessId;
  /** Project root chosen by the user (the git repo or folder). */
  projectRoot: string;
  model?: ModelRef;
  /** null explicitly omits effort; undefined inherits the app preference. Survives restart. */
  effort?: EffortLevel | null;
  /** Opt-in premium inference speed; never changes reasoning effort. Absent means standard. */
  fastMode?: boolean;
  permissionMode: PermissionMode;
  /** Run in an isolated git worktree under .vocs-code/worktrees. */
  useWorktree?: boolean;
  /**
   * Prefix of the branch a new worktree starts on (`feat` → `feat/<slug>`), stored without the
   * trailing slash; absent means `vocscode`. Forks of the session reuse it. See shared/branch-prefix.ts.
   */
  branchPrefix?: string;
  /** ACP agent preset id (for harness 'acp'). */
  acpAgent?: string;
  /** Free-form system prompt addition where supported. */
  appendSystemPrompt?: string;
  /** Soft spend ceiling in USD, enforced where the harness supports it. */
  maxBudgetUsd?: number;
  /** Optional Codex custom model provider (OpenAI-compatible) definition. */
  codexModelProvider?: { id: string; name: string; baseUrl: string; envKey?: string; wireApi?: 'chat' | 'responses' };
}

export interface GoalState {
  objective: string;
  status: 'active' | 'paused' | 'complete' | 'cleared';
  createdAt: number;
  updatedAt: number;
  iterations: number;
  maxIterations: number;
  autoContinue: boolean;
  tokenBudget?: number;
  notes?: string;
}

export interface SessionMeta {
  id: string;
  /** Stable provenance for local chat imports; also prevents importing the same conversation twice. */
  importedFrom?: { source: 'claude' | 'codex'; sessionId: string };
  title: string;
  /** The title is a temporary stand-in, eligible for opening-prompt naming. */
  titleIsPlaceholder?: boolean;
  /** Whether the app owns the title. Absent for older titles of unknown origin. */
  titleIsAutomatic?: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * Epoch ms of the last message the user sent here. The sidebar orders a folder's rows by it, so a
   * long agent turn cannot reshuffle the list; `updatedAt` keeps tracking every kind of activity.
   * Absent on sessions written before it existed — the sidebar falls back to `updatedAt` for those.
   */
  lastUserMessageAt?: number;
  config: SessionConfig;
  /**
   * The session this one was forked from. `fork` copies the source's transcript into the new
   * session, so the rows older than `createdAt` are the source's own history: they describe the
   * conversation the fork inherited, never work this session did. Spend is carried by neither —
   * the fork starts its counters at zero.
   */
  forkedFrom?: string;
  /** Host-allocated controller creation receipt; never accepted from ordinary create/patch. */
  controlCreation?: { operationId: string; requestHash: string };
  /** Host-managed Mission identity; absent for ordinary sessions. Children are not sidebar rows. */
  mission?: MissionOwnership;
  /** Effective working directory (worktree path if isolated), never the Mission integration view. */
  cwd: string;
  /**
   * The app-managed worktree this session owns and may remove. A fork of a worktree session gets
   * its own branch here; absent means the session shares a directory it must not remove.
   */
  worktreeBranch?: string;
  status: SessionStatus;
  statusDetail?: string;
  /** User-picked display label for the status badge; shown instead of the status name until cleared. */
  statusLabel?: string;
  /**
   * Epoch ms a turn ended while nobody was looking at this session (not on screen in the focused
   * window). Present means "done · not viewed"; cleared once the session is viewed or the user sends.
   */
  unseenAt?: number;
  /** The unviewed turn behind `unseenAt` failed; the session itself is usually back to idle by then. */
  unseenFailed?: boolean;
  /** Epoch ms this session last counted as viewed; the activity tray's Recent list orders by it. */
  lastViewedAt?: number;
  harnessRef: HarnessRef;
  /**
   * Set when the harness has to be handed the conversation on its next message: a fork into another
   * harness, and a same-harness fork that moved to its own worktree and so cannot resume the
   * provider session the source ran in. Written to `fork-context.md` and cleared once the harness
   * accepted the seeded message.
   */
  pendingForkContext?: boolean;
  /**
   * Set when a harness with no system prompt of its own has to be handed the app's instruction
   * layer on its first message (`withSessionPreamble`); cleared once the harness accepted it.
   */
  pendingAppInstructions?: boolean;
  /**
   * The project's knowledge digest for this session, kept beside the config rather than folded into
   * `config.appendSystemPrompt`: a fork copies the source's config, and a digest baked into it would
   * be duplicated by the copy's own priming. Read through `sessionAppendPrompt`.
   */
  knowledgeDigest?: string;
  /**
   * Set when the harness has no system prompt to add to (`capabilities.systemPrompt` false), so the
   * digest has to be prefixed to the first message instead. Cleared once the harness accepts it.
   */
  pendingKnowledgeDigest?: boolean;
  usage: UsageTotals;
  lastError?: string;
  /** Current model as reported by the harness (may differ from config after live switch). */
  activeModel?: ModelRef;
  activeEffort?: EffortLevel;
  /** Reset on restart/fork; a saved preference is not proof of an active provider tier. */
  fastModeStatus?: FastModeStatus;
  /**
   * Commands the running harness accepts itself — Claude's slash command names and their aliases, as
   * advertised by the CLI. Reported by the adapter at startup and on every later change, so `/goal`
   * can be handed to the harness when it has a goal of its own (see shared/goal-driver.ts).
   */
  harnessCommands?: string[];
  /**
   * The same commands with what the composer's `/` popover shows for them (description, argument
   * hint, kind). Unlike `harnessCommands` it survives a restart as the last list the harness gave:
   * it only offers names, it decides nothing, and the next start replaces it.
   */
  harnessCommandList?: HarnessCommand[];
  /** Set while the harness's own goal command answers `/goal` for this session; the app's goal stays out of the way. */
  nativeGoal?: string;
  goal?: GoalState;
  pinned?: boolean;
  /** Epoch ms when pinned; pinned rows sort by it ascending (first pin on top). Rewritten on drag-reorder. */
  pinnedAt?: number;
  archived?: boolean;
  /** Ordinary runtime writer claims persisted before writable startup. Only the same runtime's
   * positive disposal proof clears its claim; restart or a newer runtime cannot clear old debt. */
  workspaceWriterClaims?: string[];
  /** Number of queued (steer/follow-up) messages waiting. */
  queued?: number;
  /**
   * Ephemeral live autonomous background work (subagents, background harness tasks, hooks) that
   * can remain active after the parent turn returns to idle. Never persisted across restarts.
   */
  ongoing?: OngoingItem[];
}

export type SessionEvent =
  | { type: 'status'; status: SessionStatus; detail?: string }
  | { type: 'item.upsert'; item: TranscriptItem }
  | {
      type: 'item.delta';
      id: string;
      textDelta?: string;
      thinkingDelta?: string;
      outputDelta?: string;
    }
  | { type: 'approval.request'; request: ApprovalRequest }
  | { type: 'approval.resolved'; requestId: string; decision: ApprovalDecision }
  | { type: 'usage'; totals: UsageTotals; /** Subagent spend in this delta, per model, so it is attributed to the model that ran it. */ subagentCostByModel?: SubagentCost[] }
  | { type: 'subagent'; completion: SubagentCompletion }
  /** Live subagent run state for the panel; the durable record is the run file on disk. */
  | { type: 'subagent.run'; run: SubagentRunUpdate }
  /** Live autonomous background work per producer channel (replace semantics per source). */
  | { type: 'ongoing'; source: OngoingSource; items: OngoingItem[] }
  | { type: 'meta'; patch: Partial<SessionMeta> }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'models'; models: ModelInfo[] }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export interface SessionEventEnvelope {
  sessionId: string;
  event: SessionEvent;
  ts: number;
  /** Host-only binding for an exclusively admitted controller turn; not a completion receipt. */
  control?: { operationId: string; inputId: string; runtimeId: string; turnId?: string };
  /** Monotonic across every event this desktop pushes. A remote client takes a transcript snapshot
   *  together with the counter it reflects (`sessions:transcriptPage`'s `seq`) and applies only
   *  later events, so a follow-up stream cannot double text the snapshot already has. Absent on
   *  desktops that predate sequencing; clients fall back to their old heuristic then. */
  seq?: number;
}

export type SearchCategory = 'all' | 'title' | 'goal' | 'transcript' | 'tool';

/** Filters narrowing a session search by content and session scope. */
export interface SearchFilters {
  category?: SearchCategory;
  archived?: boolean;
  harness?: HarnessId;
  projectRoot?: string;
}

/** One deep-search hit: a title/goal match or a match inside a transcript item. */
export interface SearchResult {
  sessionId: string;
  /** Transcript item id for deep hits; absent for title/goal matches (nothing to scroll to). */
  itemId?: string;
  kind: 'meta' | 'user' | 'assistant' | 'tool' | 'info';
  ts: number;
  /** Snippet with \u0001/\u0002 around the matched terms; the renderer turns them into <mark>. */
  snippet: string;
}

export interface SearchResponse {
  /** False when node:sqlite/FTS5 is unavailable in this runtime; deep search is disabled then. */
  available: boolean;
  results: SearchResult[];
}

export interface CreateSessionRequest {
  config: SessionConfig;
  title?: string;
  initialPrompt?: string;
  /** Screenshots attached in the new-session dialog, sent together with the initial prompt. */
  initialImages?: ImageAttachment[];
  initialFiles?: FileAttachment[];
  goal?: string;
  /** Start the session in a worktree on this existing branch (reusing one when it exists). */
  checkoutBranch?: string;
  /** With `config.useWorktree`: the name after the branch prefix (slugified); absent derives it from the title or prompt. */
  worktreeName?: string;
  /** With `config.useWorktree`: the local branch the new branch starts from; absent is the repository's HEAD. */
  worktreeBase?: string;
}
