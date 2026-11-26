/** Federated permission-scoped retrieval, wiki/graph tracing, history search, and memory recall. */
import { promises as fs } from 'node:fs';
import { redactSecrets } from '../../shared/analytics/text';
import {
  classifyIntent,
  isServableState,
  mergeEvidence,
  queryTerms,
  type CollectionGrant,
  type ContextPacket,
  type EvidenceConflict,
  type EvidenceProvider,
  type IntelligenceEvidence,
  type IntelligenceSearchRequest,
  type IntelligenceSearchResponse,
  type MemoryState,
  type MemoryType,
  type ProjectIdentity
} from '../../shared/intelligence';
import { buildKnowledgeGraph, type KnowledgeScope } from '../../shared/knowledge';
import { errorMessage } from '../util/async';
import type { IntelligenceContext } from './context';
import { LOCAL_LEARNING_ORIGIN } from './memory-store';
import { normalizeRoot } from './registry';
import {
  clip,
  getIntelligenceSettings,
  graphScopeOf,
  isGraphEnabled,
  memoryAuthority,
  passiveMatches,
  resolveProject,
  resolveVisibility,
  scopedHistory,
  scopeOf,
  wikiAuthority,
  type IntelligenceServiceDeps,
  type MemoryRecallResult,
  type TraceResult
} from './scope';

const MAX_FEDERATED_PROJECTS = 12;

/**
 * Federated, permission-scoped search. The order is fixed: resolve identity and grants, read the
 * intent, query only the sources the session may read, then merge by authority and freshness.
 */
export async function searchIntelligence(
  deps: IntelligenceServiceDeps,
  ctx: IntelligenceContext,
  request: IntelligenceSearchRequest
): Promise<IntelligenceSearchResponse> {
  const query = (request.query ?? '').trim();
  const wants = (provider: EvidenceProvider): boolean => !request.providers?.length || request.providers.includes(provider);
  const project = await resolveProject(deps, ctx);
  const includeCollections = request.scope === 'collection' && wants('collection');
  const scopeInfo: ContextPacket['scope'] = { projectId: project.id, projectName: project.name, ...(ctx.branch ? { branch: ctx.branch } : {}), collections: [] };
  const intent = classifyIntent(query);
  const terms = queryTerms(query);
  const missing: string[] = [];
  const conflicts: EvidenceConflict[] = [];
  if (!terms.length) return { query, intent, scope: scopeInfo, results: [], conflicts, missing: ['The question has no searchable words.'] };
  const limit = Math.max(1, Math.min(request.limit ?? 12, 40));
  const text = terms.join(' ');
  const candidates: IntelligenceEvidence[] = [];
  const scope = scopeOf(ctx);

  if (wants('wiki')) {
    if (await deps.knowledge.store.hasWiki(scope)) {
      candidates.push(...(await wikiEvidence(deps, scope, project, text, { limit, includeHistorical: request.includeHistorical === true, conflicts })));
    } else {
      missing.push('This project has no wiki yet, so there is no curated project knowledge to search.');
    }
  }

  const { visibility, grants } = await resolveVisibility(deps, ctx, project, includeCollections);
  if (wants('memory') || grants.length) {
    if (deps.memory.available) {
      const states: MemoryState[] = request.includeHistorical ? ['captured', 'candidate', 'verified', 'active', 'uncertain', 'superseded', 'expired'] : ['captured', 'candidate', 'verified', 'active', 'uncertain'];
      // Filter provider and authorized scope before FTS ranking/limit; private matches must not
      // crowd out authorized hits. Personal preferences are available through recall, not project search.
      const filter = { states, limit, includeExpired: request.includeHistorical === true, ...(!wants('memory') ? { scopes: ['collection' as const] } : {}) };
      for (const hit of deps.memory.search({ ...visibility, personal: false }, terms, filter)) {
        const record = hit.record;
        const provider: EvidenceProvider = record.scope === 'collection' ? 'collection' : 'memory';
        const grant = record.collectionId ? grants.find((g) => g.collectionId === record.collectionId) : undefined;
        candidates.push({
          provider,
          ...(record.origin === LOCAL_LEARNING_ORIGIN ? { localLearning: true } : {}),
          projectId: record.promotedFrom?.projectId ?? record.projectId ?? project.id,
          projectName: record.promotedFrom?.projectName ?? project.name,
          ref: record.id,
          title: record.title,
          text: hit.snippet || clip(record.text, 320),
          kind: record.kind,
          authority: memoryAuthority(record),
          // Episodes are what happened; an unverified record is a recollection. Neither is a present fact.
          historical: record.type === 'episodic' || !isServableState(record.state),
          scope: record.scope,
          ...(record.branch ? { branch: record.branch } : {}),
          ...(record.collectionId ? { collectionId: record.collectionId } : {}),
          score: hit.score,
          sources: record.sources,
          ...(record.verification?.revision ? { revision: record.verification.revision } : {}),
          updatedAt: record.updatedAt,
          why: grant ? `promoted into collection ${grant.collectionName}` : hit.partial ? `partial match in ${record.type} memory` : `matched in ${record.type} memory`
        });
      }
    } else if (wants('memory')) {
      missing.push(`Memory records are unavailable: ${deps.memory.reason ?? 'the ledger is not open'}`);
    }
  }

  if (wants('history') && !ctx.restricted) {
    if (deps.history) {
      const recall = scopedHistory(deps, ctx, project, text, Math.min(limit, 8), { includeArchived: request.includeHistorical === true });
      if (!recall.available) missing.push('Session history is unavailable: the transcript index is not open.');
      recall.results.forEach((hit, index) => {
        candidates.push({
          provider: 'history',
          projectId: project.id,
          projectName: project.name,
          ref: hit.itemId ? `${hit.sessionId}#${hit.itemId}` : hit.sessionId,
          title: hit.title,
          text: hit.snippet,
          kind: hit.kind,
          authority: 'history',
          historical: true,
          scope: hit.private ? 'session' : 'project',
          score: (1 - (index / Math.max(recall.results.length, 1)) * 0.6) * (recall.partial ? 0.6 : 1),
          sources: [{ type: 'session', ref: hit.sessionId }],
          ...(hit.at ? { updatedAt: hit.at } : {}),
          why: recall.partial ? 'partial match in a past session of this project' : 'matched in a past session of this project'
        });
      });
    } else {
      missing.push('Session history recall is not wired in this run.');
    }
  }

  const federated = grants.length ? await federatedEvidence(deps, ctx, project, grants, text, limit) : [];
  if (!grants.length && includeCollections) {
    if (ctx.restricted) missing.push('This session is not allowed to search collections.');
    else if (!getIntelligenceSettings(deps).collections) missing.push('Collection search is switched off in Settings, so only this project was searched.');
  }

  if (wants('graph')) {
    const graph = await graphEvidence(deps, ctx, project, text, limit);
    candidates.push(...graph.evidence);
    if (graph.missing) missing.push(graph.missing);
  }

  if (grants.length) {
    // Async providers may have run while membership changed. Recheck before returning any shared
    // evidence (including scope names). The provider-side allowlists are still enforced above.
    const live = await resolveVisibility(deps, ctx, project, true);
    const byId = new Map(live.grants.map((grant) => [grant.collectionId, grant]));
    scopeInfo.collections = live.grants.filter((grant) => grants.some((previous) => previous.collectionId === grant.collectionId)).map((grant) => grant.collectionName);
    for (let index = candidates.length - 1; index >= 0; index--) {
      const item = candidates[index];
      if (item.provider !== 'collection') continue;
      const current = deps.memory.available ? deps.memory.get(item.ref, live.visibility) : null;
      if (!current || !isServableState(current.state)) candidates.splice(index, 1);
    }
    candidates.push(...federated.filter((item) => item.collectionId && byId.get(item.collectionId)?.wikiProjectIds.includes(item.projectId)));
  }
  ctx.signal?.throwIfAborted();
  // Check the live opt-out and source session visibility after all async providers are done.
  if (wants('memory')) {
    for (const { record, score } of passiveMatches(deps, ctx, project, terms, limit, request.includeHistorical)) {
      candidates.push({
        provider: 'memory', projectId: project.id, projectName: project.name, ref: record.id, localLearning: true,
        title: redactSecrets(record.title), text: redactSecrets(record.text), kind: record.kind,
        authority: 'history', historical: true, scope: 'project', score: score * 0.65,
        sources: record.sources, updatedAt: record.updatedAt,
        why: 'Matched a lesson or outcome from an earlier reply; check current evidence before using it.'
      });
    }
  }
  if (!isGraphEnabled(deps, project)) {
    for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].provider === 'graph') candidates.splice(i, 1);
  }
  if (intent === 'structure') missing.push('Current code structure (callers, usages, impact) is not answered here: ask GitNexus (query, context, impact) and trust the working tree over any index.');
  return { query, intent, scope: scopeInfo, results: mergeEvidence(candidates, intent, limit), conflicts, missing };
}

async function wikiEvidence(
  deps: Pick<IntelligenceServiceDeps, 'knowledge'>,
  scope: KnowledgeScope,
  project: ProjectIdentity,
  text: string,
  opts: { limit: number; includeHistorical: boolean; conflicts: EvidenceConflict[] }
): Promise<IntelligenceEvidence[]> {
  const knowledge = deps.knowledge;
  let partial = false;
  let results = await knowledge.search(scope, text, { limit: opts.limit, includeHistorical: opts.includeHistorical, match: 'all' });
  if (results.length < 3 && text.includes(' ')) {
    const relaxed = await knowledge.search(scope, text, { limit: opts.limit, includeHistorical: opts.includeHistorical, match: 'any' });
    if (relaxed.length > results.length) {
      partial = results.length === 0;
      const seen = new Set(results.map((r) => r.id));
      results = [...results, ...relaxed.filter((r) => !seen.has(r.id))];
    }
  }
  if (!results.length) return [];
  const pages = new Map((await knowledge.store.load(scope)).map((p) => [p.meta.id, p]));
  const top = Math.max(...results.map((r) => r.score), 1);
  const out: IntelligenceEvidence[] = [];
  for (const result of results) {
    const page = pages.get(result.id);
    if (!page) continue;
    if (page.meta.scope === 'branch' && page.meta.branch !== scope.branch) continue;
    const { authority, historical } = wikiAuthority(page);
    let freshness: IntelligenceEvidence['freshness'] = 'unknown';
    let staleReason: string | undefined;
    try {
      const stale = await knowledge.store.staleness(scope, page);
      freshness = stale.stale ? 'stale' : 'fresh';
      staleReason = stale.reasons[0];
    } catch {
      freshness = 'unknown';
    }
    const revision = page.meta.verification?.revision ?? page.meta.sources.find((s) => s.revision)?.revision;
    out.push({
      provider: 'wiki',
      projectId: project.id,
      projectName: project.name,
      ref: page.meta.id,
      title: page.meta.title,
      text: page.meta.claim ?? result.snippet,
      kind: page.meta.kind,
      authority,
      historical,
      scope: page.meta.scope === 'branch' ? 'branch' : 'project',
      ...(page.meta.scope === 'branch' && page.meta.branch ? { branch: page.meta.branch } : {}),
      score: result.score / top,
      sources: page.meta.sources,
      ...(revision ? { revision } : {}),
      freshness,
      ...(staleReason ? { staleReason } : {}),
      ...(page.meta.updatedAt ? { updatedAt: page.meta.updatedAt } : {}),
      why: result.snippet ? (partial ? 'partial match in the project wiki' : 'matched in the project wiki') : 'linked to a matching wiki page'
    });
    if (page.meta.status === 'uncertain') opts.conflicts.push({ a: `wiki:${page.meta.id}`, b: 'current guidance', reason: 'the page is marked uncertain' });
    for (const other of page.meta.contradicts) {
      if (pages.has(other)) opts.conflicts.push({ a: `wiki:${page.meta.id}`, b: `wiki:${other}`, reason: 'the pages are recorded as contradicting each other' });
    }
    if (page.meta.supersededBy) opts.conflicts.push({ a: `wiki:${page.meta.id}`, b: `wiki:${page.meta.supersededBy}`, reason: 'superseded by the newer page' });
  }
  return out;
}

/** Wiki pages of other collection members that chose to share their wiki. Nothing else is read. */
async function federatedEvidence(
  deps: Pick<IntelligenceServiceDeps, 'settings' | 'registry' | 'knowledge' | 'log'>,
  ctx: IntelligenceContext,
  project: ProjectIdentity,
  grants: CollectionGrant[],
  text: string,
  limit: number
): Promise<IntelligenceEvidence[]> {
  const out: IntelligenceEvidence[] = [];
  const visited = new Set<string>([project.id]);
  for (const grant of grants) {
    for (const otherId of grant.wikiProjectIds) {
      if (visited.has(otherId) || visited.size > MAX_FEDERATED_PROJECTS) continue;
      ctx.signal?.throwIfAborted();
      visited.add(otherId);
      const other = await deps.registry.project(otherId);
      if (!other) continue;
      let root: string | null = null;
      for (const candidate of other.roots) {
        const scope = { projectRoot: candidate, cwd: candidate };
        const wiki = deps.knowledge.store.repoDir(scope);
        // A sharing member may not redirect the wiki read into an unconsenting checkout.
        const actual = await fs.realpath(wiki).catch(() => null);
        if (actual && normalizeRoot(actual) === normalizeRoot(wiki)) {
          root = candidate;
          break;
        }
      }
      if (!root) continue;
      const live = (await resolveVisibility(deps, ctx, project, true)).grants.find((entry) => entry.collectionId === grant.collectionId && entry.wikiProjectIds.includes(otherId));
      if (!live) continue;
      try {
        // Match only fields this grant exposes. A private body, source or graph edge must not
        // influence which pages match a collection query or how they rank.
        const pages = await deps.knowledge.store.load({ projectRoot: root, cwd: root });
        const terms = text.split(' ');
        const ranked = pages.flatMap((page): IntelligenceEvidence[] => {
          const { meta } = page;
          if (meta.scope !== 'repo' || meta.status !== 'current') return [];
          const title = redactSecrets(meta.title);
          const claim = meta.claim ? redactSecrets(meta.claim) : undefined;
          const haystack = `${title} ${claim ?? ''}`.toLowerCase();
          const matched = terms.filter((term) => haystack.includes(term)).length;
          if (!matched) return [];
          return [{
            provider: 'collection', projectId: other.id, projectName: other.name, ref: meta.id, title, text: claim,
            kind: meta.kind, authority: wikiAuthority(page).authority, historical: false, scope: 'collection', collectionId: live.collectionId,
            score: (matched / terms.length) ** 2,
            sources: [{ type: 'doc', ref: `wiki:${meta.id}`, projectId: other.id }],
            why: `shared by ${other.name} through collection ${live.collectionName}`
          }];
        });
        out.push(...ranked.sort((a, b) => b.score - a.score).slice(0, Math.min(limit, 6)));
      } catch (e) {
        deps.log('debug', `intelligence: federated search of ${other.name} failed: ${errorMessage(e)}`);
      }
    }
  }
  return out;
}

async function graphEvidence(
  deps: Pick<IntelligenceServiceDeps, 'settings' | 'graph'>,
  ctx: IntelligenceContext,
  project: ProjectIdentity,
  text: string,
  limit: number
): Promise<{ evidence: IntelligenceEvidence[]; missing?: string }> {
  const graph = deps.graph;
  if (!graph || !isGraphEnabled(deps, project)) return { evidence: [] };
  const scope = graphScopeOf(ctx, project);
  const status = await graph.status(scope, true);
  if (!isGraphEnabled(deps, project)) return { evidence: [] };
  if (!status.indexed) return { evidence: [], missing: !status.installed ? 'The bundled Graphify worker is unavailable.' : status.indexing ? 'Graphify is indexing this checkout.' : 'Graphify has no index for this checkout yet.' };
  const matches = await graph.query(scope, text, { limit: Math.min(limit, 8), revision: status.revision });
  if (!isGraphEnabled(deps, project)) return { evidence: [] };
  return {
    evidence: matches.map((match) => {
      const extracted = match.edges.some((e) => e.confidence === 'extracted') || match.node.type === 'code';
      const relations = match.edges
        .slice(0, 4)
        .map((e) => `${e.direction === 'out' ? e.relation : `${e.relation} from`} ${e.otherLabel}${e.confidence === 'extracted' ? '' : ` (${e.confidence})`}`)
        .join('; ');
      const where = match.node.file ? ` in ${match.node.file}${match.node.location ? `:${match.node.location}` : ''}` : '';
      return {
        provider: 'graph' as const,
        projectId: project.id,
        projectName: project.name,
        ref: match.node.id,
        title: match.node.label,
        text: `${match.node.type ?? 'node'}${where}${relations ? ` — ${relations}` : ''}`,
        ...(match.node.type ? { kind: match.node.type } : {}),
        authority: extracted ? ('graph-extracted' as const) : ('graph-inferred' as const),
        historical: false,
        scope: 'project' as const,
        score: match.score,
        ...(status.revision ? { revision: status.revision } : {}),
        freshness: status.stale === true ? ('stale' as const) : status.stale === false ? ('fresh' as const) : ('unknown' as const),
        ...(status.stale ? { staleReason: 'the checkout moved past the indexed commit' } : {}),
        ...(status.indexedAt ? { updatedAt: status.indexedAt } : {}),
        why: `Graphify: ${match.why}`
      };
    })
  };
}

/**
 * How two things are related, with the evidence for each step. Wiki pages are traced over the
 * wiki's own relation graph; anything else goes to the cached code index if enabled.
 */
export async function traceIntelligence(
  deps: Pick<IntelligenceServiceDeps, 'settings' | 'registry' | 'knowledge' | 'graph'>,
  ctx: IntelligenceContext,
  request: { from: string; to?: string }
): Promise<TraceResult> {
  ctx.signal?.throwIfAborted();
  const from = (request.from ?? '').trim();
  const to = (request.to ?? '').trim();
  if (!from) return { source: 'none', nodes: [], edges: [], note: 'A trace needs a starting point.' };
  const scope = scopeOf(ctx);
  const pages = await deps.knowledge.store.load(scope);
  const byId = new Map(pages.map((p) => [p.meta.id, p]));
  if (byId.has(from) && (!to || byId.has(to))) {
    const graph = buildKnowledgeGraph(pages);
    const node = (id: string) => ({ id, title: byId.get(id)?.meta.title ?? id, kind: byId.get(id)?.meta.kind });
    if (!to) {
      const edges = graph.edges.filter((e) => e.from === from || e.to === from).slice(0, 40);
      const ids = new Set<string>([from]);
      for (const e of edges) ids.add(e.from === from ? e.to : e.from);
      return { source: 'wiki', nodes: [...ids].map(node), edges: edges.map((e) => ({ from: e.from, to: e.to, relation: e.type })), note: `${edges.length} relation(s) of ${from} in the project wiki.` };
    }
    // Breadth-first over undirected relations: the shortest chain of authored and derived links.
    const previous = new Map<string, { id: string; relation: string }>();
    const queue = [from];
    const seen = new Set([from]);
    while (queue.length && !seen.has(to)) {
      const current = queue.shift() as string;
      for (const e of graph.edges) {
        const other = e.from === current ? e.to : e.to === current ? e.from : null;
        if (!other || seen.has(other)) continue;
        seen.add(other);
        previous.set(other, { id: current, relation: e.type });
        queue.push(other);
      }
    }
    if (!seen.has(to)) return { source: 'wiki', nodes: [node(from), node(to)], edges: [], note: `No chain of relations connects ${from} and ${to} in the project wiki.` };
    const chain: string[] = [to];
    const edges: TraceResult['edges'] = [];
    for (let at = to; at !== from; ) {
      const step = previous.get(at) as { id: string; relation: string };
      edges.unshift({ from: step.id, to: at, relation: step.relation });
      chain.unshift(step.id);
      at = step.id;
    }
    return { source: 'wiki', nodes: chain.map(node), edges, note: `${edges.length} step(s) through the project wiki's relation graph.` };
  }
  const project = await resolveProject(deps, ctx);
  const provider = deps.graph;
  if (!provider || !isGraphEnabled(deps, project)) {
    return { source: 'none', nodes: [], edges: [], note: `"${from}" is not a wiki page id, and no graph provider is enabled for this project. For code relationships use GitNexus (context, impact).` };
  }
  const graphScope = graphScopeOf(ctx, project);
  const status = await provider.status(graphScope, true);
  if (!status.indexed) return { source: 'none', nodes: [], edges: [], note: 'Graphify is enabled for this project but has no index yet.' };
  const disabled = (): TraceResult => ({ source: 'none', nodes: [], edges: [], note: 'Graphify is disabled for this project.' });
  if (!isGraphEnabled(deps, project)) return disabled();
  const provenance = { ...(status.revision ? { revision: status.revision } : {}), ...(status.stale ? { stale: true } : {}) };
  const staleNote = status.stale ? ' The index is older than the checkout: verify against the working tree.' : '';
  if (!to) {
    const hood = await provider.neighbors(graphScope, from, { limit: 30, revision: status.revision });
    if (!isGraphEnabled(deps, project)) return disabled();
    if (!hood) return { source: 'graph', nodes: [], edges: [], ...provenance, note: `No graph node matches "${from}".` };
    const nodes = [{ id: hood.node.id, title: hood.node.label, ...(hood.node.type ? { kind: hood.node.type } : {}), ...(hood.node.file ? { file: hood.node.file } : {}) }, ...hood.edges.map((e) => ({ id: e.otherId, title: e.otherLabel }))];
    return { source: 'graph', nodes, edges: hood.edges.map((e) => ({ from: e.from, to: e.to, relation: e.relation, confidence: e.confidence })), ...provenance, note: `${hood.edges.length} relation(s) of ${hood.node.label} in the Graphify index.${staleNote}` };
  }
  const route = await provider.trace(graphScope, from, to, { revision: status.revision });
  if (!isGraphEnabled(deps, project)) return disabled();
  if (!route) return { source: 'graph', nodes: [], edges: [], ...provenance, note: `No path between "${from}" and "${to}" in the Graphify index.` };
  return {
    source: 'graph',
    nodes: route.nodes.map((n) => ({ id: n.id, title: n.label, ...(n.type ? { kind: n.type } : {}), ...(n.file ? { file: n.file } : {}) })),
    edges: route.edges.map((e) => ({ from: e.from, to: e.to, relation: e.relation, confidence: e.confidence })),
    ...provenance,
    note: `${route.edges.length} step(s) in the Graphify index; inferred and ambiguous edges are candidates, not facts.${staleNote}`
  };
}

/**
 * Past-session excerpts for this project only. The session ids are resolved from the project's
 * stable identity before the index is queried, so another project's transcript is never read.
 */
export async function historySearchIntelligence(
  deps: Pick<IntelligenceServiceDeps, 'registry' | 'sessions' | 'history'>,
  ctx: IntelligenceContext,
  query: string,
  opts: { limit?: number; includeArchived?: boolean; strict?: boolean } = {}
): Promise<{ available: boolean; sessions: number; results: MemoryRecallResult['history'] }> {
  if (!deps.history || ctx.restricted) return { available: false, sessions: 0, results: [] };
  const project = await resolveProject(deps, ctx);
  const { available, sessions, results } = scopedHistory(deps, ctx, project, query, Math.max(1, Math.min(opts.limit ?? 6, 20)), opts);
  return { available, sessions, results: results.map(({ sessionId, title, kind, at, snippet }) => ({ sessionId, session: title, kind, at, snippet })) };
}

/** Episodes, lessons and preferences this session may see, plus matching past-session excerpts. */
export async function recallMemory(
  deps: Pick<IntelligenceServiceDeps, 'settings' | 'registry' | 'sessions' | 'memory' | 'history'>,
  ctx: IntelligenceContext,
  request: { query?: string; types?: MemoryType[]; limit?: number; includeUnverified?: boolean }
): Promise<MemoryRecallResult> {
  const project = await resolveProject(deps, ctx);
  const { visibility } = await resolveVisibility(deps, ctx, project);
  const limit = Math.max(1, Math.min(request.limit ?? 8, 30));
  const query = (request.query ?? '').trim();
  const terms = queryTerms(query);
  const includeUnverified = request.includeUnverified !== false;
  const states: MemoryState[] = includeUnverified ? ['captured', 'candidate', 'verified', 'active', 'uncertain'] : ['verified', 'active'];
  const records: MemoryRecallResult['records'] = [];
  if (deps.memory.available) {
    const filter = { states, ...(request.types?.length ? { types: request.types } : {}), limit };
    if (terms.length) {
      for (const hit of deps.memory.search(visibility, terms, filter)) records.push({ ...hit.record, servable: isServableState(hit.record.state), snippet: hit.snippet });
    } else {
      for (const record of deps.memory.list(visibility, filter)) records.push({ ...record, servable: isServableState(record.state) });
    }
  }
  const rawHistory = terms.length ? scopedHistory(deps, ctx, project, terms.join(' '), Math.min(limit, 8)).results : [];
  const history = rawHistory.map(({ sessionId, title, kind, at, snippet }) => ({ sessionId, session: title, kind, at, snippet }));
  if (includeUnverified && (!request.types?.length || request.types.includes('episodic'))) {
    for (const { record } of passiveMatches(deps, ctx, project, terms, limit - records.length)) {
      records.push({ ...record, title: redactSecrets(record.title), text: redactSecrets(record.text), servable: false });
    }
  }
  const note = !deps.memory.available
    ? `Memory records are unavailable (${deps.memory.reason ?? 'the ledger is not open'}); only session history was searched.`
    : 'Memory is what happened and what was learned, not project truth. Records that are not servable are unverified recollection: confirm against the code before acting.';
  return { records, history, note };
}
