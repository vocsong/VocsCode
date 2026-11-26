/**
 * The Vocs Intelligence Core: one place that decides what a session may read, fans a question out
 * to the sources allowed to answer it, and owns every durable memory write.
 *
 * It adds no new engine. The project wiki (KnowledgeService) stays the source of truth for what a
 * project means, session transcripts stay the record of what happened, GitNexus keeps answering
 * what the code does, and an optional graph provider contributes derived relationships. What this
 * service adds is the part none of them can own alone:
 *
 *   identity    a stable project id from the registry, so scope is not a folder path
 *   scope       project, branch, session, collection and personal visibility, resolved before any
 *               source is queried — a result from a project the session has no grant for is never
 *               fetched, so there is nothing to filter out afterwards
 *   lifecycle   captured → candidate → verified/active, with promotion beyond a project and every
 *               human-authority decision reserved for a person
 *   evidence    every result carries its provider, project, authority, revision and freshness, and
 *               history is kept apart from current knowledge
 *
 * Authority is enforced here, not in prompts. An agent can record a candidate and ask for a
 * promotion; it cannot verify design intent, widen a scope, or forget what a human wrote.
 * No Electron imports.
 */
import { redactSecrets } from '../../shared/analytics/text';
import {
  DEFAULT_CONTEXT_BUDGET,
  compileContextPacket,
  isRecallableState,
  type CollectionMember,
  type ContextPacket,
  type GraphIndexStatus,
  type IntelligenceSearchRequest,
  type IntelligenceSearchResponse,
  type IntelligenceSettings,
  type IntelligenceView,
  type MemoryExportBundle,
  type MemoryKind,
  type MemoryRecord,
  type MemoryState,
  type MemoryType,
  type ProjectCollection,
  type ProjectIdentity,
  type PromotionRequest
} from '../../shared/intelligence';
import { isKnowledgeId, type KnowledgeVerification } from '../../shared/knowledge';
import type { TranscriptItem } from '../../shared/types';
import { errorMessage } from '../util/async';
import type { IntelligenceContext } from './context';
import { graphCheckoutStamp } from './graph-snapshot';
import { LOCAL_LEARNING_ORIGIN } from './memory-store';
import type { PassiveObservation } from './passive-learning';
import { runDecidePromotion, runPromote, runRequestPromotion, type PromotionSource, type PromotionTarget } from './promotion';
import { fileProtectedChange, recordKnowledge } from './recording';
import { reflectionBlock, runReflection } from './reflection';
import { normalizeRoot } from './registry';
import { historySearchIntelligence, recallMemory, searchIntelligence, traceIntelligence } from './retrieval';
import {
  clip,
  getIntelligenceSettings,
  graphScopeOf,
  isGraphEnabled,
  resolveProject,
  resolveVisibility,
  scopeOf,
  stampOf,
  visibleRecord,
  type HistoryRecall,
  type IntelligenceServiceDeps,
  type KnowledgeRecordInput,
  type KnowledgeRecordResult,
  type MemoryRecallResult,
  type ReflectionResult,
  type SessionRef,
  type TraceResult
} from './scope';

export type {
  HistoryRecall,
  IntelligenceContext,
  IntelligenceServiceDeps,
  KnowledgeRecordInput,
  KnowledgeRecordResult,
  MemoryRecallResult,
  ReflectionResult,
  SessionRef,
  TraceResult
};

export class IntelligenceService {
  private readonly reflecting = new Map<string, Promise<ReflectionResult>>();
  private promotionChanges: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: IntelligenceServiceDeps) {
    // A refused change to a human-reviewed page becomes a candidate a person can still apply.
    deps.knowledge.onProtectedChange((change) => fileProtectedChange(this.deps, change));
    deps.knowledge.useProjectIds(async (scope) => (await this.deps.registry.resolve(scope.projectRoot)).id);
  }

  settings(): IntelligenceSettings {
    return getIntelligenceSettings(this.deps);
  }

  project(ctx: Pick<IntelligenceContext, 'projectRoot' | 'signal'>): Promise<ProjectIdentity> {
    return resolveProject(this.deps, ctx);
  }

  /* ------------------------------------------------------------------ */
  /* Retrieval                                                          */
  /* ------------------------------------------------------------------ */

  search(ctx: IntelligenceContext, request: IntelligenceSearchRequest): Promise<IntelligenceSearchResponse> {
    return searchIntelligence(this.deps, ctx, request);
  }

  /** A bounded, cited packet for one task: the search above, compiled under a token budget. */
  async compile(ctx: IntelligenceContext, request: { query: string; budgetTokens?: number; scope?: 'project' | 'collection' }): Promise<ContextPacket> {
    const found = await this.search(ctx, { query: request.query, ...(request.scope ? { scope: request.scope } : {}), limit: 24 });
    return compileContextPacket({
      query: found.query,
      intent: found.intent,
      scope: found.scope,
      evidence: found.results,
      conflicts: found.conflicts,
      missing: found.missing,
      budgetTokens: request.budgetTokens ?? DEFAULT_CONTEXT_BUDGET
    });
  }

  trace(ctx: IntelligenceContext, request: { from: string; to?: string }): Promise<TraceResult> {
    return traceIntelligence(this.deps, ctx, request);
  }

  historySearch(ctx: IntelligenceContext, query: string, opts: { limit?: number; includeArchived?: boolean; strict?: boolean } = {}): Promise<{ available: boolean; sessions: number; results: MemoryRecallResult['history'] }> {
    return historySearchIntelligence(this.deps, ctx, query, opts);
  }

  recall(ctx: IntelligenceContext, request: { query?: string; types?: MemoryType[]; limit?: number; includeUnverified?: boolean }): Promise<MemoryRecallResult> {
    return recallMemory(this.deps, ctx, request);
  }

  /* ------------------------------------------------------------------ */
  /* Recording                                                          */
  /* ------------------------------------------------------------------ */

  record(ctx: IntelligenceContext, input: KnowledgeRecordInput, origin: string): Promise<KnowledgeRecordResult> {
    return recordKnowledge(this.deps, ctx, input, origin);
  }

  /* ------------------------------------------------------------------ */
  /* Promotion                                                          */
  /* ------------------------------------------------------------------ */

  private withPromotionChange<T>(change: () => Promise<T>): Promise<T> {
    const job = this.promotionChanges.then(change);
    this.promotionChanges = job.catch(() => undefined);
    return job;
  }

  /**
   * An agent's request to widen a record's scope. It only queues the request: nothing becomes
   * visible outside the project until the user approves it in the Knowledge panel.
   */
  async requestPromotion(ctx: IntelligenceContext, input: PromotionSource & { to: PromotionTarget; collection?: string; reason?: string }, requestedBy: string): Promise<PromotionRequest> {
    if (ctx.restricted) throw new Error('This session is not allowed to request promotion.');
    if (input.to !== 'collection' && input.to !== 'personal') throw new Error('Promote to "collection" or "personal".');
    return this.withPromotionChange(() => runRequestPromotion(this.deps, ctx, input, requestedBy));
  }

  /**
   * The human act of promotion. The approving person is the reviewer, so the promoted snapshot is
   * recorded as human-reviewed; it cites where it came from and carries nothing else across.
   */
  async promote(ctx: IntelligenceContext, input: PromotionSource & { to: PromotionTarget; collectionId?: string }): Promise<MemoryRecord> {
    if (ctx.restricted) throw new Error('This session is not allowed to promote memory.');
    if (input.to !== 'collection' && input.to !== 'personal') throw new Error('Promote to "collection" or "personal".');
    return this.withPromotionChange(() => runPromote(this.deps, ctx, input));
  }

  /** Approves or rejects a queued request. Approval re-reads the source: a stale request promotes nothing. */
  async decidePromotion(ctx: IntelligenceContext, id: string, decision: 'approve' | 'reject'): Promise<MemoryRecord | null> {
    if (ctx.restricted) throw new Error('This session is not allowed to promote memory.');
    if (decision !== 'approve' && decision !== 'reject') throw new Error('Unknown promotion decision.');
    return this.withPromotionChange(() => runDecidePromotion(this.deps, ctx, id, decision));
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  /** Withdraw pending previews and shared snapshots after a user removes or rejects a wiki page. */
  async retireWikiPromotions(ctx: IntelligenceContext, pageId: string): Promise<void> {
    if (ctx.restricted || !isKnowledgeId(pageId)) throw new Error('A valid wiki page id is required to retire promotions.');
    await this.withPromotionChange(async () => {
      const project = await this.project(ctx);
      ctx.signal?.throwIfAborted();
      if (this.deps.memory.available) this.deps.memory.retireWikiPromotions(project.id, pageId);
      await this.deps.registry.removeWikiPromotions(project.id, pageId);
    });
  }

  /** A person's decision about one record: verify, activate, mark uncertain, reject, expire or revoke. */
  async decide(ctx: IntelligenceContext, id: string, to: MemoryState, opts: { note?: string } = {}): Promise<MemoryRecord> {
    return this.withPromotionChange(async () => {
      const record = await visibleRecord(this.deps, ctx, id);
      ctx.signal?.throwIfAborted();
      const verification: KnowledgeVerification | undefined = to === 'verified' ? { method: 'human-review', at: stampOf(this.deps), by: 'human', ...(opts.note ? { note: clip(redactSecrets(opts.note), 200) } : {}) } : undefined;
      const changed = this.deps.memory.transition(record.id, to, 'human', { ...(verification ? { verification } : {}), by: 'human' });
      if (to === 'revoked' || to === 'rejected') await this.deps.registry.removeRecordPromotions(id);
      return changed;
    });
  }

  /**
   * Deletes a memory record and everything derived from it. An agent may only forget what an agent
   * recorded inside its own project; anything a person wrote, verified or shared is theirs to remove.
   */
  async forget(ctx: IntelligenceContext, id: string, actor: 'human' | 'agent'): Promise<{ forgotten: boolean; derived: number }> {
    if (actor === 'agent' && ctx.restricted) throw new Error('Only the user can remove this memory.');
    return this.withPromotionChange(async () => {
      const record = await visibleRecord(this.deps, ctx, id, actor === 'human');
      ctx.signal?.throwIfAborted();
      if (actor === 'agent' && (!record.origin.startsWith('agent:') || record.verification?.method === 'human-review' || this.deps.memory.derivedFrom(record.id).length)) {
        throw new Error('This record was written, reviewed or shared by a person; only the user can forget it.');
      }
      // A queued request has a copy of the claim even though it was never published.
      await this.deps.registry.removeRecordPromotions(record.id, ctx.signal);
      ctx.signal?.throwIfAborted();
      return this.deps.memory.forgetWithDerived(record.id, actor);
    });
  }

  /**
   * Writes a memory record into the project wiki as a human-reviewed page — how a candidate change
   * to a reviewed page is applied, and how a lesson becomes durable project knowledge.
   */
  async applyToWiki(ctx: IntelligenceContext, id: string): Promise<{ pageId: string }> {
    const record = await visibleRecord(this.deps, ctx, id);
    if (record.scope === 'collection' || record.scope === 'personal' || record.scope === 'session') throw new Error('Only this project’s own project or branch records can be written into its wiki.');
    if (!isRecallableState(record.state)) throw new Error('Only a live record can be written into the wiki.');
    ctx.signal?.throwIfAborted();
    const target = record.sources.find((s) => s.ref.startsWith('wiki:'))?.ref.slice(5);
    const [first, ...rest] = record.text.split(/\n\s*\n/);
    const claim = clip(first, 400);
    const body = rest.join('\n\n').trim() || record.text;
    const scope = scopeOf(ctx);
    const result = await this.deps.knowledge.propose(
      scope,
      {
        title: record.title.replace(/^Proposed change:\s*/i, ''),
        claim,
        body,
        kind: record.kind === 'decision' ? 'decision' : record.type === 'procedural' ? 'convention' : 'gotcha',
        memoryType: record.type === 'procedural' ? 'procedural' : 'semantic',
        ...(record.scope === 'branch' ? { scope: 'branch' as const } : {}),
        ...(target ? { pageId: target } : {}),
        sources: record.sources.filter((s) => !s.ref.startsWith('wiki:')).map((s) => ({ type: s.type, ref: s.ref, ...(s.note ? { note: s.note } : {}), ...(s.revision ? { revision: s.revision } : {}) }))
      },
      'human',
      record.sessionId,
      ctx.signal
    );
    if (result.rejected || !result.id) throw new Error('That claim is tombstoned in this wiki; remove the rejection first.');
    await this.deps.knowledge.review(scope, result.id, 'accept', { by: 'human' });
    // Keep a promoted record as the provenance of any snapshots that still cite its id.
    if (!this.deps.memory.derivedFrom(record.id).length) this.deps.memory.purge([record.id], 'human', `applied to wiki page ${result.id}`);
    return { pageId: result.id };
  }

  /** Adds a record by hand: a preference the user declares, or a lesson they want kept. */
  async addRecord(ctx: IntelligenceContext, input: { type: MemoryType; title: string; text: string; scope: 'project' | 'personal'; kind?: MemoryKind }): Promise<MemoryRecord> {
    if (!this.deps.memory.available) throw new Error(`Memory records are unavailable: ${this.deps.memory.reason ?? 'the ledger is not open'}`);
    const project = await this.project(ctx);
    ctx.signal?.throwIfAborted();
    const record = this.deps.memory.create(
      input.scope === 'personal' ? null : project.id,
      {
        type: input.type,
        kind: input.kind ?? (input.type === 'preference' ? 'preference' : input.type === 'procedural' ? 'procedure' : 'lesson'),
        scope: input.scope,
        state: 'verified',
        title: input.title,
        text: input.text,
        sources: [{ type: 'human', ref: 'entered in the Knowledge panel' }],
        verification: { method: 'human-review', at: stampOf(this.deps), by: 'human' }
      },
      'human'
    );
    if (!record) throw new Error('This was forgotten before and is tombstoned.');
    this.deps.memory.audit({ action: 'memory.add', actor: 'human', projectId: project.id, ref: record.id, detail: `${record.scope} ${record.type}` });
    return record;
  }

  /** Main-only ingestion of one completed turn. No transcript re-read, wiki writes or model calls. */
  async captureLocalTurn(ctx: IntelligenceContext, observation: PassiveObservation, current: () => boolean): Promise<MemoryRecord | null> {
    const allowed = () => this.deps.memory.available && this.settings().reflection === 'local' && !ctx.restricted && !ctx.signal?.aborted && current();
    if (!allowed()) return null;
    const signal = ctx.signal ?? new AbortController().signal;
    const known = await this.deps.registry.known(ctx.projectRoot);
    const checkout = known ? null : await graphCheckoutStamp(ctx.projectRoot, signal);
    if (!allowed()) return null;
    const project = known ?? await this.deps.registry.resolve(ctx.projectRoot, { commonDir: checkout?.commonDir, signal });
    if (!allowed()) return null;
    const { text, kind, inputId, answerId } = observation;
    const title = `${kind === 'lesson' ? 'Lesson' : 'Outcome'}: ${clip(text, 135)}`;
    return this.deps.memory.captureLocalTurn(project.id, ctx.sessionId, inputId, {
      kind, title, text, branch: ctx.branch,
      sources: [{ type: 'transcript', ref: `${ctx.sessionId}#${answerId}`, note: 'Assistant reply in a completed turn; not independently verified.' }]
    });
  }

  /** An edit/clear can remove the only cited answer. Reuse the saved replacement, never reread disk. */
  onTranscriptRewritten(sessionId: string, replacement: readonly TranscriptItem[]): number {
    if (!this.deps.memory.available) return 0;
    try {
      const local = this.deps.memory.forSession(sessionId).filter((r) => r.origin === LOCAL_LEARNING_ORIGIN && r.state !== 'verified');
      if (!local.length) return 0;
      const remaining = new Set(replacement.filter((item) => item.kind === 'assistant').map((item) => `${sessionId}#${item.id}`));
      const removed = local.filter((r) => !r.sources.some((s) => s.type === 'transcript' && remaining.has(s.ref))).map((r) => r.id);
      return this.deps.memory.purge(removed, 'app', 'the source reply was removed from the transcript');
    } catch {
      this.deps.log('warn', 'intelligence: could not clean up notes after a transcript rewrite');
      return 0;
    }
  }

  /** A deleted session takes its unverified leftovers with it; verified lessons stand on their own. */
  onSessionRemoved(sessionId: string): number {
    if (!this.deps.memory.available) return 0;
    try {
      this.deps.memory.dropLocalTurnReceipts(sessionId);
      const doomed = this.deps.memory
        .forSession(sessionId)
        .filter((r) => r.scope === 'session' || (r.state !== 'verified' && r.sources.every((s) => (s.type === 'session' || s.type === 'transcript') && s.ref.startsWith(sessionId))))
        .map((r) => r.id);
      return doomed.length ? this.deps.memory.purge(doomed, 'app', 'the session it came from was deleted') : 0;
    } catch (e) {
      this.deps.log('warn', `intelligence: could not clean up memory for ${sessionId}: ${errorMessage(e)}`);
      return 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Reflection                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Session-end reflection: one captured episode, plus up to three candidate lessons when a utility
   * model is configured. Opt-in — `off` refuses, `manual` runs only when asked, `auto` also runs when
   * a session is archived or merged. Nothing here is promoted, verified or written to the wiki.
   */
  reflect(ctx: IntelligenceContext, session: { title: string }, trigger: 'manual' | 'auto'): Promise<ReflectionResult> {
    const blocked = reflectionBlock(this.deps, ctx, trigger);
    if (blocked) return Promise.resolve(blocked);
    const running = this.reflecting.get(ctx.sessionId);
    if (running) return running;
    const job = runReflection(this.deps, ctx, session, trigger)
      .catch((e): ReflectionResult => ({ ok: false, captured: 0, candidates: 0, error: errorMessage(e) }))
      .finally(() => this.reflecting.delete(ctx.sessionId));
    this.reflecting.set(ctx.sessionId, job);
    return job;
  }

  /* ------------------------------------------------------------------ */
  /* Collections, graph and the panel                                   */
  /* ------------------------------------------------------------------ */

  async saveCollection(input: { id?: string; name: string; description?: string; members: CollectionMember[] }): Promise<ProjectCollection> {
    return this.withPromotionChange(async () => {
      const saved = await this.deps.registry.saveCollection(input);
      this.deps.memory.audit({ action: input.id ? 'collection.update' : 'collection.create', actor: 'human', ref: saved.id, detail: `${saved.members.length} member(s)` });
      return saved;
    });
  }

  /** Deleting a collection revokes everything promoted into it: a scope that is gone serves nothing. */
  async deleteCollection(id: string): Promise<boolean> {
    return this.withPromotionChange(async () => {
      const removed = await this.deps.registry.deleteCollection(id);
      if (removed && this.deps.memory.available) this.deps.memory.removeCollection(id, 'human');
      if (removed) this.deps.memory.audit({ action: 'collection.delete', actor: 'human', ref: id });
      return removed;
    });
  }

  async graphStatus(ctx: IntelligenceContext): Promise<GraphIndexStatus> {
    const project = await this.project(ctx);
    const enabled = isGraphEnabled(this.deps, project);
    if (!this.deps.graph) return { provider: 'graphify', enabled, installed: false, indexed: false };
    return this.deps.graph.status(graphScopeOf(ctx, project), enabled);
  }

  /** Local desktop selection is the only trigger for automatic work, never search/trace. */
  async refreshGraph(ctx: IntelligenceContext, signal: AbortSignal): Promise<void> {
    if (!this.deps.graph || !this.settings().graphify.enabled || ctx.restricted || signal.aborted) return;
    const checkout = await graphCheckoutStamp(ctx.cwd, signal);
    if (!checkout || signal.aborted) return;
    const root = normalizeRoot(ctx.cwd) === normalizeRoot(ctx.projectRoot) ? checkout : await graphCheckoutStamp(ctx.projectRoot, signal);
    if (!root || normalizeRoot(root.commonDir) !== normalizeRoot(checkout.commonDir) || signal.aborted) return;
    const project = await this.deps.registry.resolve(ctx.projectRoot, { commonDir: root.commonDir, signal });
    if (!signal.aborted && isGraphEnabled(this.deps, project)) {
      await this.deps.graph.refresh(graphScopeOf(ctx, project), signal, checkout.revision);
    }
  }

  /** Owner-requested refresh, with the same exclusion policy as background indexing. */
  async graphIndex(ctx: IntelligenceContext): Promise<GraphIndexStatus> {
    const project = await this.project(ctx);
    if (!this.deps.graph) return { provider: 'graphify', enabled: false, installed: false, indexed: false, error: 'No graph provider is available in this run.' };
    const scope = graphScopeOf(ctx, project);
    if (!isGraphEnabled(this.deps, project)) return { ...(await this.deps.graph.status(scope, false)), error: 'Graphify is not enabled for this project.' };
    return this.deps.graph.index(scope);
  }

  /** Clears the derived graph cache. Authoritative records are untouched. */
  async graphClear(ctx: IntelligenceContext): Promise<boolean> {
    return this.deps.graph ? this.deps.graph.clear(graphScopeOf(ctx, await this.project(ctx))) : false;
  }

  async view(ctx: IntelligenceContext): Promise<IntelligenceView> {
    const project = await this.project(ctx);
    const { visibility } = await resolveVisibility(this.deps, ctx, project, true);
    const settings = this.settings();
    const available = this.deps.memory.available;
    const states: MemoryState[] = ['captured', 'candidate', 'verified', 'active', 'uncertain', 'superseded', 'expired', 'revoked', 'rejected'];
    const all = available ? this.deps.memory.list({ ...visibility, personal: !ctx.restricted }, { states, includeExpired: true, limit: 400 }) : [];
    return {
      available,
      ...(available ? {} : { reason: this.deps.memory.reason ?? 'The memory ledger is not open.' }),
      project,
      settings,
      records: all.filter((r) => r.scope === 'project' || r.scope === 'branch' || r.scope === 'session'),
      personal: all.filter((r) => r.scope === 'personal'),
      shared: all.filter((r) => r.scope === 'collection'),
      collections: await this.deps.registry.collections(),
      projects: await this.deps.registry.projects(),
      promotions: (await this.deps.registry.promotions(project.id)).map(({ binding: _binding, ...request }) => request),
      graph: await this.graphStatus(ctx),
      gateway: { enabled: settings.gateway, ...(this.deps.gatewayState?.() ?? { listening: false, sessions: 0 }) },
      audit: this.deps.memory.auditTrail(project.id, 30)
    };
  }

  /** This project's own records as a portable bundle; collection and personal memory stay behind. */
  async exportMemory(ctx: IntelligenceContext): Promise<MemoryExportBundle> {
    const project = await this.project(ctx);
    const records = this.deps.memory.available
      ? this.deps.memory.list({ projectId: project.id, collectionIds: [], personal: false, ...(ctx.branch ? { branch: ctx.branch } : {}) }, { states: ['captured', 'candidate', 'verified', 'active', 'uncertain'], limit: 500 })
      : [];
    return {
      format: 'vocs-memory-export',
      version: 1,
      exportedAt: stampOf(this.deps),
      project: { id: project.id, name: project.name, ...(project.origin ? { origin: project.origin } : {}), ...(project.rootCommit ? { rootCommit: project.rootCommit } : {}) },
      records
    };
  }

  async importMemory(ctx: IntelligenceContext, bundle: unknown): Promise<{ imported: number; skipped: number }> {
    if (!this.deps.memory.available) throw new Error(`Memory records are unavailable: ${this.deps.memory.reason ?? 'the ledger is not open'}`);
    const data = bundle as Partial<MemoryExportBundle> | null;
    if (!data || data.format !== 'vocs-memory-export' || data.version !== 1 || !Array.isArray(data.records)) throw new Error('That file is not a Vocs memory export.');
    const project = await this.project(ctx);
    ctx.signal?.throwIfAborted();
    return this.deps.memory.importRecords(project.id, data.records.slice(0, 2_000), 'human');
  }
}
