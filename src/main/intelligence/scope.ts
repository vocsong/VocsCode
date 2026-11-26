/** Shared types, scope resolution, visibility grants, and authority helpers for IntelligenceService. */
import { redactSecrets } from '../../shared/analytics/text';
import {
  resolveIntelligenceSettings,
  type CollectionGrant,
  type EvidenceAuthority,
  type EvidenceSource,
  type IntelligenceSettings,
  type MemoryRecord,
  type ProjectIdentity
} from '../../shared/intelligence';
import {
  authorityLabel,
  isServable,
  type KnowledgeAnchor,
  type KnowledgeKind,
  type KnowledgeScope,
  type KnowledgeVerification
} from '../../shared/knowledge';
import type { AppSettings } from '../../shared/types';
import type { KnowledgeCompleter } from '../knowledge/llm';
import type { KnowledgeService } from '../knowledge/service';
import type { StoredPage } from '../knowledge/store';
import type { IntelligenceContext } from './context';
import type { GraphifyProvider, GraphScope } from './graphify';
import type { MemorySearchHit, MemoryStore, MemoryVisibility } from './memory-store';
import { normalizeRoot, type ProjectRegistry } from './registry';

/** What the service needs to know about a session to scope history recall to a project. */
export interface SessionRef {
  id: string;
  title: string;
  projectRoot: string;
  archived?: boolean;
  /** Session-only history, when the app's session catalog marks it private. */
  private?: boolean;
}

export interface HistoryRecall {
  available: boolean;
  partial: boolean;
  results: Array<{ sessionId: string; itemId?: string; kind: string; ts: number; snippet: string }>;
}

export interface IntelligenceServiceDeps {
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  settings: () => AppSettings;
  knowledge: KnowledgeService;
  registry: ProjectRegistry;
  memory: MemoryStore;
  /** The optional graph provider; absent means the app was built without one. */
  graph?: GraphifyProvider;
  sessions: () => SessionRef[];
  /** Transcript recall restricted to the session ids passed in; absent disables history recall. */
  history?: (query: string, sessionIds: string[], limit: number, opts?: { strict?: boolean }) => HistoryRecall;
  /** Bounded plain-text transcript lines for one session, for reflection. */
  transcript?: (sessionId: string) => Promise<string[]>;
  completer?: KnowledgeCompleter;
  git?: {
    head: (cwd: string) => Promise<string | null>;
    resolveCommit: (cwd: string, revision: string) => Promise<string | null>;
  };
  /** Whether the gateway is listening and how many sessions hold a grant, for the panel. */
  gatewayState?: () => { listening: boolean; sessions: number };
  now?: () => number;
}

export interface KnowledgeRecordInput {
  title: string;
  claim: string;
  body?: string;
  /** `semantic` and `procedural` go to the project wiki; `episodic` to the memory ledger. */
  memoryType?: 'semantic' | 'procedural' | 'episodic';
  /** Review-only submission, never an update to an existing page. */
  draft?: boolean;
  kind?: string;
  scope?: 'project' | 'branch';
  pageId?: string;
  keywords?: string[];
  labels?: string[];
  sources?: EvidenceSource[];
  anchors?: KnowledgeAnchor[];
}

export interface KnowledgeRecordResult {
  stored: 'wiki' | 'memory' | 'none';
  id: string;
  /** The lifecycle state the record landed in. */
  state: string;
  authority: string;
  verification?: KnowledgeVerification;
  note: string;
}

export interface MemoryRecallResult {
  records: Array<MemoryRecord & { servable: boolean; snippet?: string }>;
  history: Array<{ sessionId: string; session: string; kind: string; at: string | null; snippet: string }>;
  note: string;
}

export interface TraceResult {
  source: 'wiki' | 'graph' | 'none';
  nodes: Array<{ id: string; title: string; kind?: string; file?: string }>;
  edges: Array<{ from: string; to: string; relation: string; confidence?: string }>;
  revision?: string;
  stale?: boolean;
  note: string;
}

export interface ReflectionResult {
  ok: boolean;
  captured: number;
  candidates: number;
  detail?: string;
  error?: string;
}

/** Kinds that state intent: no commit or file can prove what someone meant, so only a human verifies them. */
export const INTENT_KINDS = new Set<KnowledgeKind>(['architecture', 'decision', 'convention', 'concept']);
const MAX_PASSIVE_RECALL = 3;

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function wikiAuthority(page: StoredPage): { authority: EvidenceAuthority; historical: boolean } {
  // Check status before authorship: reviewing a page once does not make it current forever.
  if (page.meta.status === 'uncertain') return { authority: 'uncertain', historical: true };
  if (!isServable(page.meta)) return { authority: page.meta.status === 'deprecated' || page.meta.status === 'superseded' ? 'history' : 'candidate', historical: true };
  switch (authorityLabel(page.meta)) {
    case 'human-reviewed':
      return { authority: 'human-reviewed', historical: false };
    case 'verified':
      return { authority: 'verified', historical: false };
    case 'accepted':
      return { authority: 'accepted', historical: false };
    default:
      return { authority: 'candidate', historical: true };
  }
}

export function memoryAuthority(record: MemoryRecord): EvidenceAuthority {
  if (record.state === 'verified') return record.verification?.method === 'human-review' ? 'human-reviewed' : 'verified';
  if (record.state === 'active') return 'accepted';
  if (record.state === 'uncertain') return 'uncertain';
  return 'candidate';
}

export function getIntelligenceSettings(deps: Pick<IntelligenceServiceDeps, 'settings'>): IntelligenceSettings {
  return resolveIntelligenceSettings(deps.settings().intelligence);
}

export function nowOf(deps: Pick<IntelligenceServiceDeps, 'now'>): number {
  return deps.now?.() ?? Date.now();
}

export function stampOf(deps: Pick<IntelligenceServiceDeps, 'now'>): string {
  return new Date(nowOf(deps)).toISOString();
}

export function scopeOf(ctx: IntelligenceContext): KnowledgeScope {
  return { projectRoot: ctx.projectRoot, cwd: ctx.cwd, ...(ctx.branch ? { branch: ctx.branch } : {}) };
}

export function graphScopeOf(ctx: IntelligenceContext, project: ProjectIdentity): GraphScope {
  return { projectId: project.id, projectRoot: ctx.projectRoot, cwd: ctx.cwd };
}

export function isGraphEnabled(deps: Pick<IntelligenceServiceDeps, 'settings'>, project: ProjectIdentity): boolean {
  const graphify = getIntelligenceSettings(deps).graphify;
  return graphify.enabled && !graphify.excludedProjects.includes(project.id);
}

export async function resolveProject(
  deps: Pick<IntelligenceServiceDeps, 'registry'>,
  ctx: Pick<IntelligenceContext, 'projectRoot' | 'signal'>
): Promise<ProjectIdentity> {
  ctx.signal?.throwIfAborted();
  const project = await deps.registry.resolve(ctx.projectRoot);
  ctx.signal?.throwIfAborted();
  return project;
}

/** What this session may see in the ledger, decided before querying any provider. */
export async function resolveVisibility(
  deps: Pick<IntelligenceServiceDeps, 'settings' | 'registry'>,
  ctx: IntelligenceContext,
  project: ProjectIdentity,
  includeCollections = false
): Promise<{ visibility: MemoryVisibility; grants: CollectionGrant[] }> {
  const settings = getIntelligenceSettings(deps);
  const grants = includeCollections && !ctx.restricted && settings.collections ? await deps.registry.grantsFor(project.id) : [];
  ctx.signal?.throwIfAborted();
  return {
    visibility: {
      projectId: project.id,
      ...(ctx.branch ? { branch: ctx.branch } : {}),
      sessionId: ctx.sessionId,
      collectionIds: grants.map((g) => g.collectionId),
      collectionProjects: Object.fromEntries(grants.map((g) => [g.collectionId, [project.id, ...g.memberProjectIds]])),
      personal: !ctx.restricted && settings.personalMemory,
      excludeLocalLearning: ctx.modelFacing || ctx.restricted
    },
    grants
  };
}

/** Only this project's live session addresses, never collection members. */
export function historySessions(
  deps: Pick<IntelligenceServiceDeps, 'sessions'>,
  ctx: IntelligenceContext,
  project: ProjectIdentity,
  includeArchived?: boolean
): SessionRef[] {
  if (ctx.restricted) return [];
  const roots = new Set(project.roots);
  return deps.sessions().filter((s) => roots.has(normalizeRoot(s.projectRoot)) && (includeArchived || !s.archived) && (!s.private || s.id === ctx.sessionId));
}

/** The allowlist is sent to the transcript index; collection members are never added to it. */
export function scopedHistory(
  deps: Pick<IntelligenceServiceDeps, 'sessions' | 'history'>,
  ctx: IntelligenceContext,
  project: ProjectIdentity,
  query: string,
  limit: number,
  opts: { includeArchived?: boolean; strict?: boolean } = {}
) {
  ctx.signal?.throwIfAborted();
  if (!deps.history || ctx.restricted) return { available: false, sessions: 0, partial: false, results: [] };
  const sessions = new Map(historySessions(deps, ctx, project, opts.includeArchived).map((s) => [s.id, s]));
  if (!sessions.size) return { available: true, sessions: 0, partial: false, results: [] };
  const recall = deps.history(query, [...sessions.keys()], limit, { strict: opts.strict === true });
  return {
    available: recall.available,
    sessions: sessions.size,
    partial: recall.partial,
    results: recall.results.flatMap((hit) => {
      const session = sessions.get(hit.sessionId);
      if (!session) return [];
      const at = new Date(hit.ts);
      return [{ ...hit, title: redactSecrets(session.title), private: session.private === true, at: Number.isFinite(at.getTime()) ? at.toISOString() : null, snippet: redactSecrets(hit.snippet) }];
    })
  };
}

/** Topic-matched excerpts only, under the same session visibility rules as transcript history. */
export function passiveMatches(
  deps: Pick<IntelligenceServiceDeps, 'settings' | 'sessions' | 'memory'>,
  ctx: IntelligenceContext,
  project: ProjectIdentity,
  terms: string[],
  limit: number,
  includeHistorical?: boolean
): MemorySearchHit[] {
  if (!ctx.modelFacing || ctx.restricted || !deps.memory.available || !terms.length || limit < 1 || getIntelligenceSettings(deps).reflection !== 'local') return [];
  const sessionIds = historySessions(deps, ctx, project, includeHistorical).map((session) => session.id);
  if (!sessionIds.length) return [];
  return deps.memory.search(
    { projectId: project.id, collectionIds: [], personal: false },
    terms,
    { localLearningFrom: sessionIds, states: ['captured', 'candidate', 'verified', 'uncertain'], limit: Math.min(MAX_PASSIVE_RECALL, limit) }
  );
}

export async function visibleRecord(
  deps: Pick<IntelligenceServiceDeps, 'settings' | 'registry' | 'memory'>,
  ctx: IntelligenceContext,
  id: string,
  forPanel = true
): Promise<MemoryRecord> {
  if (!deps.memory.available) throw new Error(`Memory records are unavailable: ${deps.memory.reason ?? 'the ledger is not open'}`);
  const project = await resolveProject(deps, ctx);
  const { visibility } = await resolveVisibility(deps, ctx, project, forPanel);
  // Exclude other scopes before fetching: only the human panel can mutate shared/personal items.
  const record = deps.memory.get(id, { ...visibility, personal: forPanel && !ctx.restricted });
  if (!record) throw new Error('No such memory record in this project.');
  return record;
}
