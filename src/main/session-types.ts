/** Shared types and pure helpers used across SessionManager and its collaborators. */
import path from 'node:path';
import type {
  ApprovalDecision,
  AutoCompactionThreshold,
  GoalState,
  HarnessId,
  HarnessRef,
  ModelInfo,
  ModelRef,
  OngoingItem,
  OngoingSource,
  SessionEventEnvelope,
  SessionMeta,
  TranscriptItem
} from '../shared/types';
import { modelName } from '../shared/model-names';
import type { AnalyticsStore } from './analytics';
import type { HarnessAdapter } from './harness/types';
import type { ResolvedServer } from './mcp/effective';
import type { MissionHooks } from './mission-mode/hooks';
import type { RuntimeResolver } from './runtime';
import type { SettingsStore } from './settings';
import type { SessionStore } from './store';
import { shortId, type Deferred } from './util/async';

/** Handoff text written into a cross-harness fork's session dir, consumed by its first message. */
export const FORK_CONTEXT_FILE = 'fork-context.md';

export interface SessionManagerDeps {
  store: SessionStore;
  settings: SettingsStore;
  runtime: RuntimeResolver;
  analytics: AnalyticsStore;
  getSecret: (providerId: string) => Promise<string | undefined>;
  pushEvent: (env: SessionEventEnvelope) => void;
  pushSessions: (sessions: SessionMeta[]) => void;
  notify: (sessionId: string, title: string, body: string) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Whether this session is on screen in the focused desktop window (DesktopFocusTracker). A turn
   *  that ends while it is not is marked "done · not viewed"; absent counts as nobody looking. */
  isViewing?: (sessionId: string) => boolean;
  /** The shared GitNexus MCP endpoint, started lazily. */
  sharedGitnexus?: () => Promise<string | null>;
  /** Path to the scope proxy the harness spawns in place of the GitNexus binary. */
  gitnexusProxyPath?: string;
  /** Path to resources/mcp/vocs-memory.mjs, the Layer 2 wiki server. */
  memoryServerPath?: string;
  /** userData path, so the memory server can recall session history (search.db). */
  memoryUserData?: string;
  /** Mints a session's intelligence-gateway endpoint and token; null when the gateway is off. */
  memoryGateway?: (sessionId: string) => { url: string; token: string } | null;
  /** Mission mode (Lead/Builder sessions); absent in hosts and tests that do not run it. */
  mission?: () => MissionHooks | undefined;
  /** Path to resources/mcp/vocs-mission.mjs, the Mission tools' stdio client. */
  missionServerPath?: string;
  /** Connected Vocs MCP Hub connections, as loopback proxy servers (`vocs-hub.ts`); absent: none. */
  hubServers?: () => Promise<ResolvedServer[]>;
  /** A stopping runtime loses its memory capability before disposal settles. */
  revokeMemoryGateway?: (sessionId: string) => void;
  /** A runtime entering Plan must stop any in-flight writes through its memory gateway. */
  restrictMemoryGateway?: (sessionId: string) => void;
  /** Layer 2 digest for priming a new session's system prompt; absent disables priming. */
  knowledgeDigest?: (scope: { projectRoot: string; cwd: string; branch?: string }) => Promise<string | null>;
  /**
   * The app's own instruction layer for one harness (see `shared/app-instructions.ts`). Read live:
   * the three harnesses with a system prompt take it at start, the rest through the first message.
   */
  appInstructions?: (harness: HarnessId) => Promise<string | undefined>;
  /** Test seam: how long an ordinary Stop waits for its adapter's disposal before releasing the session. */
  disposeWaitMs?: number;
}

export interface ControlledTurnResult {
  outcome: 'succeeded' | 'failed' | 'interrupted' | 'unknown';
  inputId: string;
  runtimeId: string;
  turnId?: string;
  outputIds: string[];
}

export interface ControlledTurn {
  operationId: string;
  inputId: string;
  runtimeId: string;
  runtime?: ActiveSession;
  dispatched: boolean;
  started: boolean;
  canceled: boolean;
  uncertain: boolean;
  terminal?: ControlledTurnResult['outcome'];
  turnId?: string;
  outputIds: Set<string>;
  ended: Deferred<void>;
  writes: Set<Promise<void>>;
  writeFailed: boolean;
  /** Synchronous grant check, run again immediately before the runtime's adapter starts. */
  startAllowed: () => void;
}

export interface SessionActivity {
  /** An owned runtime still exists, including during disposal or an uncertain stop. */
  active: boolean;
  starting: boolean;
  turn: boolean;
  tools: number;
  /** Native children outlive the root turn and its delegation tool result. */
  nativeChildren?: number;
  /** An ordinary runtime still owns possible process writers/autonomous follow-ups. */
  processes?: boolean;
  approvals: number;
  compacting: boolean;
  queued: number;
  tearingDown: boolean;
  uncertain: boolean;
  quiescent: boolean;
}

export interface StreamCheckpoint {
  at: number;
  size: number;
}

export interface ActiveSession {
  adapter: HarnessAdapter;
  /** Input acceptance is not a terminal turn observation (including ordinary source writers). */
  turnPending?: symbol;
  startupDispatched: boolean;
  tearingDown: boolean;
  uncertain: boolean;
  disposal: Promise<void> | null;
  nativeChildren: Map<string, { startedAt: number; running: boolean; agent?: string; description?: string; mode?: 'foreground' | 'background'; turns?: number; toolUses?: number }>;
  /** Live ongoing items pushed per producer channel (`tasks`, `hooks`, `wakeup`, `threads`). */
  ongoingBySource: Map<OngoingSource, OngoingItem[]>;
  /** Parent turn finished while autonomous background work was still active; notify once it settles. */
  deferredTurnNotice: { ts: number; status: 'completed' | 'failed'; error?: string } | null;
  /** App-driven goal continuation deferred while autonomous background work is still active. */
  deferredGoalContinuation: { goal: GoalState } | null;
  /** Short grace timer after ongoing work clears so an immediate parent wakeup turn goes first. */
  ongoingSettleTimer: NodeJS.Timeout | null;
  approvals: Map<string, Deferred<ApprovalDecision>>;
  liveItems: Map<string, TranscriptItem>;
  /** Model active when each running tool call began, retained until its terminal upsert. */
  toolModels: Map<string, ModelRef>;
  dirty: Set<string>;
  lastAssistantText: string;
  starting: Promise<void> | null;
  /** Last list the harness reported, before app metadata and user overrides, so it can be re-published. */
  models: ModelInfo[] | null;
  /** Prevent repeated automatic requests until reported context falls below the threshold. */
  autoCompactionThreshold: AutoCompactionThreshold | undefined;
  autoCompactionLatched: boolean;
  autoCompactionRetryAt: number;
  autoCompactionRetryTimer: NodeJS.Timeout | null;
  compactionInFlight: Promise<boolean | void> | null;
  /** Window last handed to an engine that compacts itself; undefined means it still has its own. */
  autoCompactionWindow: number | undefined;
  /** Pending or waiting goal auto-continuation, so a newer turn can replace it instead of racing it. */
  goalContinuationTimer: NodeJS.Timeout | null;
  /** A goal set during another turn must first reach the harness, even when auto-continue is off. */
  pendingGoalKickoff: { goal: GoalState; resume: boolean } | null;
  /** Last on-disk copy of each still-streaming assistant item: when it was written and how big it was. */
  checkpoints: Map<string, StreamCheckpoint>;
  /** Wakes the checkpointer when an item has grown enough but was written too recently. */
  checkpointTimer: NodeJS.Timeout | null;
}

/**
 * Whether the session is still waiting to be named. Sessions written before `titleIsPlaceholder`
 * existed carry no flag, so the old marker — the untouched default title — still counts.
 */
export function isPlaceholderTitle(meta: SessionMeta): boolean {
  return meta.titleIsAutomatic !== false && (meta.titleIsPlaceholder === true || (meta.titleIsAutomatic === undefined && meta.title === 'New session'));
}

/** A mission session still doing or owning work: Housekeep must leave it alone. */
export function missionLive(meta: SessionMeta): boolean {
  const m = meta.mission;
  if (!m) return false;
  if (m.role === 'lead') return !['ended', 'stopped', 'done_local'].includes(m.state ?? 'running');
  return !['done', 'failed', 'stopped'].includes(m.builderState ?? 'working');
}

/** Model-independent estimate: Unicode code points / 4, not a provider tokenizer or bill. */
export function measureUserInput(sessionId: string, text: string): NonNullable<Extract<TranscriptItem, { kind: 'user' }>['userInput']> {
  let characters = 0;
  for (const _ of text) characters++;
  return { id: shortId('input_'), sessionId, ts: Date.now(), tokens: Math.ceil(characters / 4) };
}

/** `provider/model` for log lines, or 'default' when the harness picks. */
export function describeModel(model: ModelRef | undefined): string {
  return model ? modelName(model.provider, model.model) : 'default';
}

/** Which provider-side session a harness will try to resume, or '' for a fresh start. */
export function describeResume(ref: HarnessRef): string {
  if (ref.claudeSessionId) return `claude:${ref.claudeSessionId}${ref.forkOnResume ? ' (fork)' : ''}`;
  if (ref.codexThreadId) return `codex:${ref.codexThreadId}`;
  if (ref.piSessionFile) return `pi:${path.basename(ref.piSessionFile)}`;
  if (ref.acpSessionId) return `acp:${ref.acpSessionId}`;
  if (ref.cursorAgentId) return `cursor:${ref.cursorAgentId}`;
  if (ref.nativeHistory) return 'native:history';
  return '';
}
