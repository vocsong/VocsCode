/**
 * The Vocs Intelligence contract: what every process agrees on about memory type, scope and
 * lifecycle, stable project identity, project collections, federated evidence and the bounded
 * context packet. Types and pure helpers only — no I/O, no runtime dependencies, so main, the
 * renderer and tests share one definition.
 *
 * Three ideas hold the design together (docs/MEMORY.md has the long form):
 *
 *   type is not scope   a decision is a decision whether it is project-local, collection-shared or
 *                       personal; visibility is a separate axis and is never inherited by topic.
 *   state is explicit   captured evidence, an extracted candidate and served guidance are different
 *                       things; only `active` and `verified` records are served as guidance.
 *   scope before search a query resolves what it may read first, then retrieves. Nothing is fetched
 *                       from an unauthorized project and filtered afterwards.
 */
import type { KnowledgeConfidence, KnowledgeSource } from './knowledge';

/* ------------------------------------------------------------------ */
/* Memory type, scope and state                                       */
/* ------------------------------------------------------------------ */

export const MEMORY_TYPES = ['working', 'episodic', 'semantic', 'procedural', 'preference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Where a record may be visible. A hierarchy of possible visibility, never automatic inheritance. */
export const MEMORY_SCOPES = ['session', 'branch', 'project', 'collection', 'personal'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_STATES = ['captured', 'candidate', 'verified', 'active', 'uncertain', 'superseded', 'expired', 'revoked', 'rejected'] as const;
export type MemoryState = (typeof MEMORY_STATES)[number];

export function isMemoryType(value: unknown): value is MemoryType {
  return (MEMORY_TYPES as readonly unknown[]).includes(value);
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  return (MEMORY_SCOPES as readonly unknown[]).includes(value);
}

export function isMemoryState(value: unknown): value is MemoryState {
  return (MEMORY_STATES as readonly unknown[]).includes(value);
}

/** How a claim was checked. `human-review` is the only method that verifies design intent. */
export const VERIFICATION_METHODS = ['human-review', 'commit', 'test', 'source-check'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export interface MemoryVerification {
  method: VerificationMethod;
  at: string;
  /** `human` or the checker that ran (`source-check`). */
  by?: string;
  /** The commit the evidence was checked against, when the method has one. */
  revision?: string;
  note?: string;
}

/** A knowledge source plus the revision it was read at, so a citation survives the file changing. */
export interface EvidenceSource extends KnowledgeSource {
  /** Full commit SHA the source was read at. */
  revision?: string;
  /** Stable project id of the repository the source lives in, when it is not the record's own. */
  projectId?: string;
}

export const MEMORY_KINDS = ['episode', 'attempt', 'failure', 'fix', 'lesson', 'procedure', 'preference', 'decision', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** One durable memory record in the app-owned ledger (never a second copy of a wiki page). */
export interface MemoryRecord {
  id: string;
  /** Null only for personal-scope records, which belong to the user rather than a project. */
  projectId: string | null;
  type: MemoryType;
  kind: MemoryKind;
  scope: MemoryScope;
  state: MemoryState;
  title: string;
  /** The lesson, outcome or preference itself; a record must stand alone without its session. */
  text: string;
  branch?: string;
  /** The session that produced it; evidence, not the content. */
  sessionId?: string;
  /** Set for collection-scope records. */
  collectionId?: string;
  sources: EvidenceSource[];
  /** `human`, or `agent:<what>` for anything a model wrote. */
  origin: string;
  confidence?: KnowledgeConfidence;
  verification?: MemoryVerification;
  supersedes?: string[];
  supersededBy?: string;
  /** Where a promoted record came from: its citation, never a grant to read the original. */
  promotedFrom?: { projectId: string; projectName?: string; recordId?: string; pageId?: string };
  createdAt: string;
  updatedAt: string;
  /** After this instant the record is history, not guidance. */
  expiresAt?: string;
}

export interface MemoryRecordInput {
  type: MemoryType;
  kind?: MemoryKind;
  scope?: MemoryScope;
  state?: MemoryState;
  title: string;
  text: string;
  branch?: string;
  sessionId?: string;
  collectionId?: string;
  sources?: EvidenceSource[];
  confidence?: KnowledgeConfidence;
  verification?: MemoryVerification;
  supersedes?: string[];
  promotedFrom?: MemoryRecord['promotedFrom'];
  expiresAt?: string;
}

/** States an agent may be handed as guidance. Everything else is history or a pending decision. */
export function isServableState(state: MemoryState): boolean {
  return state === 'active' || state === 'verified';
}

/** States that still appear in recall, labelled as unverified history rather than guidance. */
export function isRecallableState(state: MemoryState): boolean {
  return isServableState(state) || state === 'captured' || state === 'candidate' || state === 'uncertain';
}

const TRANSITIONS: Record<MemoryState, readonly MemoryState[]> = {
  captured: ['candidate', 'expired', 'revoked'],
  candidate: ['verified', 'active', 'uncertain', 'rejected', 'expired', 'revoked'],
  verified: ['active', 'uncertain', 'superseded', 'expired', 'revoked'],
  active: ['verified', 'uncertain', 'superseded', 'expired', 'revoked'],
  uncertain: ['candidate', 'verified', 'active', 'rejected', 'expired', 'revoked'],
  superseded: ['revoked'],
  expired: ['candidate', 'revoked'],
  revoked: [],
  rejected: []
};

export function canTransition(from: MemoryState, to: MemoryState): boolean {
  return from !== to && TRANSITIONS[from].includes(to);
}

/**
 * Whether a state change is allowed for this record and actor. Two rules sit on top of the bare
 * state machine: `verified` needs recorded verification, and a model can never verify design intent
 * or move anything out of project scope — those are human acts.
 */
export function transitionProblem(record: Pick<MemoryRecord, 'state' | 'type' | 'kind' | 'verification'>, to: MemoryState, actor: 'human' | 'agent'): string | null {
  if (!canTransition(record.state, to)) return `A ${record.state} record cannot become ${to}.`;
  if (to === 'verified') {
    if (!record.verification) return 'A record needs recorded verification (a human review, a commit, a test run or a source check) before it is verified.';
    if (actor === 'agent' && record.verification.method === 'human-review') return 'Only a human can record a human review.';
    if (actor === 'agent' && needsHumanVerification(record)) return 'Design intent and preferences are verified by a human, not by a model.';
  }
  return null;
}

/** Decisions and preferences state intent; no commit or test can prove what someone meant. */
export function needsHumanVerification(record: Pick<MemoryRecord, 'type' | 'kind'>): boolean {
  return record.type === 'preference' || record.kind === 'decision' || record.kind === 'preference';
}

/**
 * Whether a record may be promoted to a broader scope. Promotion is always a human act; this only
 * answers whether the record is eligible to be offered for it.
 */
export function promotionProblem(record: Pick<MemoryRecord, 'state' | 'scope' | 'sources' | 'verification'>, to: MemoryScope): string | null {
  const order: MemoryScope[] = ['session', 'branch', 'project', 'collection', 'personal'];
  if (to === record.scope) return `The record is already ${to}-scoped.`;
  if (to === 'session' || to === 'branch') return 'Promotion only widens scope.';
  if (to === 'personal' && record.scope === 'collection') return 'A collection record is not promoted to personal memory.';
  if (order.indexOf(to) < order.indexOf(record.scope)) return 'Promotion only widens scope.';
  if (to === 'project') return isRecallableState(record.state) ? null : `A ${record.state} record cannot be promoted.`;
  if (record.state !== 'verified' || !record.verification) return 'Only a verified record can be promoted beyond its project.';
  if (!record.sources.length) return 'A record promoted beyond its project must cite its original source.';
  return null;
}

/** True once `expiresAt` has passed; expiry is evaluated at read time so nothing needs a sweeper. */
export function isExpired(record: Pick<MemoryRecord, 'expiresAt' | 'state'>, now: number = Date.now()): boolean {
  if (record.state === 'expired') return true;
  if (!record.expiresAt) return false;
  const at = Date.parse(record.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/** Unverified episodic memory fades; verified lessons, procedures and preferences do not. */
export const DEFAULT_EPISODE_TTL_DAYS = 180;

/* ------------------------------------------------------------------ */
/* Stable project identity and collections                            */
/* ------------------------------------------------------------------ */

/**
 * One repository's durable identity. `id` is app-assigned and never derived from a folder name, so a
 * moved checkout, a second clone and a worktree all resolve to the same project, while a fork (a
 * different origin) stays a different one until the user links it.
 */
export interface ProjectIdentity {
  id: string;
  /** Display only — never used to match. */
  name: string;
  /** Normalized `host/owner/repo` of the origin remote, when the project has one. */
  origin?: string;
  /** SHA of the repository's root commit, the second half of a clone match. */
  rootCommit?: string;
  /** Every local checkout known to hold this project (normalized absolute paths). */
  roots: string[];
  createdAt: string;
  updatedAt: string;
}

/** What one member exposes to the rest of its collection. */
export type CollectionShare = 'promoted' | 'wiki';

export interface CollectionMember {
  projectId: string;
  /**
   * `promoted` (default): only records explicitly promoted into the collection are visible to other
   * members. `wiki`: the project's servable wiki pages are also searchable from other members.
   * Session history is never shared at either level.
   */
  share: CollectionShare;
}

export interface ProjectCollection {
  id: string;
  name: string;
  description?: string;
  members: CollectionMember[];
  createdAt: string;
  updatedAt: string;
}

/**
 * `git@github.com:Owner/Repo.git`, `https://user:pw@github.com/Owner/Repo/` and
 * `ssh://git@github.com:22/Owner/Repo` all become `github.com/owner/repo`. Credentials never
 * survive, and a local path remote returns null: a path is not a portable identity.
 */
export function normalizeRemoteUrl(url: string | null | undefined): string | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  let host = '';
  let pathname = '';
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(raw);
    if (!match) return null;
    if (/^file:/i.test(raw)) return null;
    host = match[1];
    pathname = match[2];
  } else if (scp && !/^[A-Za-z]$/.test(scp[1])) {
    host = scp[1];
    pathname = scp[2];
  } else {
    return null;
  }
  const clean = pathname
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+/, '');
  if (!host || !clean) return null;
  return `${host}/${clean}`.toLowerCase();
}

/** Display name for a project: the last path segment of its origin, else of its folder. */
export function projectDisplayName(origin: string | null | undefined, root: string): string {
  const fromOrigin = origin ? origin.split('/').pop() : '';
  if (fromOrigin) return fromOrigin;
  const parts = root.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || 'project';
}

/** The collections a project belongs to, and which other projects it may read through them. */
export interface CollectionGrant {
  collectionId: string;
  collectionName: string;
  /** Other members whose wiki this project may search (their own `share` is `wiki`). */
  wikiProjectIds: string[];
  /** Every other member, for labelling promoted records. */
  memberProjectIds: string[];
}

/**
 * Resolves what a project may read across its collections. This is the whole federation policy:
 * membership is explicit, a member decides what it exposes, and a project never reads itself twice.
 */
export function collectionGrantsFor(projectId: string, collections: ProjectCollection[]): CollectionGrant[] {
  const grants: CollectionGrant[] = [];
  for (const collection of collections) {
    if (!collection.members.some((m) => m.projectId === projectId)) continue;
    const others = collection.members.filter((m) => m.projectId !== projectId);
    grants.push({
      collectionId: collection.id,
      collectionName: collection.name,
      wikiProjectIds: others.filter((m) => m.share === 'wiki').map((m) => m.projectId),
      memberProjectIds: others.map((m) => m.projectId)
    });
  }
  return grants;
}

/* ------------------------------------------------------------------ */
/* Session capability                                                 */
/* ------------------------------------------------------------------ */

export const INTELLIGENCE_ACTIONS = ['read', 'record', 'promote', 'forget'] as const;
export type IntelligenceAction = (typeof INTELLIGENCE_ACTIONS)[number];

/**
 * What one session may do through the gateway. Bound to a session by the app; a harness only ever
 * holds the opaque token. Collections are resolved live from the registry on every call, so
 * removing a project from a collection takes effect without restarting the session.
 */
export interface IntelligenceGrant {
  sessionId: string;
  projectId: string;
  projectRoot: string;
  cwd: string;
  branch?: string;
  actions: IntelligenceAction[];
}

/* ------------------------------------------------------------------ */
/* Federated evidence                                                 */
/* ------------------------------------------------------------------ */

export const EVIDENCE_PROVIDERS = ['wiki', 'memory', 'history', 'graph', 'collection'] as const;
export type EvidenceProvider = (typeof EVIDENCE_PROVIDERS)[number];

/**
 * Authority of one piece of evidence, strongest first. Explicit project rules (AGENTS.md) and the
 * current source code sit above every rung here and are never returned by retrieval: the packet
 * says so instead.
 */
export const EVIDENCE_AUTHORITIES = ['human-reviewed', 'verified', 'accepted', 'graph-extracted', 'uncertain', 'history', 'graph-inferred', 'candidate'] as const;
export type EvidenceAuthority = (typeof EVIDENCE_AUTHORITIES)[number];

/** Lower is stronger; rungs follow docs/MEMORY.md (1 = project rules, 2 = current code). */
export function evidenceRung(authority: EvidenceAuthority): number {
  switch (authority) {
    case 'human-reviewed':
    case 'verified':
      return 3;
    case 'accepted':
    case 'graph-extracted':
      return 4;
    default:
      return 5;
  }
}

export interface IntelligenceEvidence {
  provider: EvidenceProvider;
  projectId: string;
  projectName: string;
  /** Provider-local id: a wiki page id, a memory record id, `session#item`, or a graph node id. */
  ref: string;
  title: string;
  /** The claim, lesson or matched excerpt. */
  text?: string;
  kind?: string;
  authority: EvidenceAuthority;
  /** True for past events and unverified recollection: evidence of what happened, not of what is. */
  historical: boolean;
  scope: MemoryScope;
  branch?: string;
  collectionId?: string;
  /** 0..1 within the result set, after intent weighting. */
  score: number;
  sources?: EvidenceSource[];
  /** Commit the evidence was indexed or verified at. */
  revision?: string;
  freshness?: 'fresh' | 'stale' | 'unknown';
  staleReason?: string;
  updatedAt?: string;
  /** Why this was retrieved, in one clause. */
  why: string;
}

export const QUERY_INTENTS = ['structure', 'rationale', 'history', 'cross-project', 'general'] as const;
export type QueryIntent = (typeof QUERY_INTENTS)[number];

/** Signals per intent, in tie-break order: a question about other projects is that before anything else. */
const INTENT_PATTERNS: Array<[QueryIntent, RegExp]> = [
  ['cross-project', /\b(other (projects?|repos?|services?)|which (projects?|repos?|services?)|across (the )?(projects?|repos?|services?)|collections?|shared patterns?|reused? (by|in|across))\b/gi],
  ['history', /\b(before|previous(ly)?|earlier|last time|try|tried|trying|attempt(ed|s)?|fail(ed|ure|s)?|regress(ion|ed)?|again|history|did we|have we|already)\b/gi],
  ['rationale', /\b(why|rationale|reason(s|ing)?|decision|decided?|choose|chose|chosen|design(ed)?|intent|intended|architecture|convention|invariant|must stay|trade-?offs?|supposed to)\b/gi],
  ['structure', /\b(where is|where are|who calls|callers?|called by|usages?|used by|references?|defined|definition|impact|what breaks|blast radius|depends on|dependenc(y|ies)|imports?|call (graph|chain))\b/gi]
];

/**
 * A cheap, deterministic read of what a question is after; it only steers provider weighting. The
 * intent with the most signals wins — "why did we choose this architecture" is a question about
 * rationale even though "did we" also sounds like history — and the list order breaks a tie.
 */
export function classifyIntent(query: string): QueryIntent {
  let best: QueryIntent = 'general';
  let top = 0;
  for (const [intent, pattern] of INTENT_PATTERNS) {
    const hits = query.match(pattern)?.length ?? 0;
    if (hits > top) {
      top = hits;
      best = intent;
    }
  }
  return best;
}

const STOPWORDS = new Set(
  'a an and are as at be been before after but by can could did do does for from had has have how i if in into is it its me my no not of on or our should than that the their then there these they this those to us was we were what when where which who whom why will with would you your'.split(' ')
);

/**
 * The content words of a question: lowercase, deduplicated, without the function words a person
 * types but no page is indexed under. Falls back to every word when the question is nothing else.
 */
export function queryTerms(query: string, max = 8): string[] {
  const all = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 1))];
  const content = all.filter((t) => !STOPWORDS.has(t));
  return (content.length ? content : all).slice(0, max);
}

/** How much each provider's evidence counts for an intent (primary 1.0, supporting below). */
export function providerWeight(intent: QueryIntent, provider: EvidenceProvider): number {
  const table: Record<QueryIntent, Record<EvidenceProvider, number>> = {
    structure: { wiki: 0.6, memory: 0.4, history: 0.3, graph: 1, collection: 0.4 },
    rationale: { wiki: 1, memory: 0.6, history: 0.35, graph: 0.6, collection: 0.7 },
    history: { wiki: 0.55, memory: 1, history: 0.9, graph: 0.3, collection: 0.4 },
    'cross-project': { wiki: 0.7, memory: 0.5, history: 0.2, graph: 0.7, collection: 1 },
    general: { wiki: 1, memory: 0.7, history: 0.5, graph: 0.6, collection: 0.6 }
  };
  return table[intent][provider];
}

/** Case, punctuation and whitespace are noise when deciding two results say the same thing. */
export function evidenceKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export interface EvidenceConflict {
  a: string;
  b: string;
  reason: string;
}

/**
 * Merges per-provider candidates into one ranked list. Scores arrive normalized per provider
 * (0..1); intent weighting, authority and freshness adjust them, and two results that state the same
 * thing collapse into the stronger one. Returns at most `limit`.
 */
export function mergeEvidence(candidates: IntelligenceEvidence[], intent: QueryIntent, limit = 12): IntelligenceEvidence[] {
  const scored = candidates.map((item) => {
    const rung = evidenceRung(item.authority);
    const authority = rung === 3 ? 0.15 : rung === 4 ? 0.05 : 0;
    const freshness = item.freshness === 'stale' ? -0.1 : 0;
    const score = Math.max(0, Math.min(1, item.score)) * providerWeight(intent, item.provider) + authority + freshness;
    return { ...item, score: Math.round(Math.max(0, score) * 1000) / 1000 };
  });
  scored.sort((a, b) => b.score - a.score || evidenceRung(a.authority) - evidenceRung(b.authority));
  const seen = new Map<string, IntelligenceEvidence>();
  const out: IntelligenceEvidence[] = [];
  for (const item of scored) {
    const key = evidenceKey(item.text || item.title);
    const earlier = key ? seen.get(key) : undefined;
    if (earlier) {
      // Same statement from two places: keep the stronger authority, remember the corroboration.
      if (evidenceRung(item.authority) < evidenceRung(earlier.authority)) {
        const at = out.indexOf(earlier);
        const merged = { ...item, score: Math.max(item.score, earlier.score), why: `${item.why}; also ${earlier.provider} ${earlier.ref}` };
        out[at] = merged;
        seen.set(key, merged);
      } else if (!earlier.why.includes(item.ref)) {
        earlier.why = `${earlier.why}; also ${item.provider} ${item.ref}`;
      }
      continue;
    }
    if (key) seen.set(key, item);
    out.push(item);
  }
  return out.slice(0, Math.max(1, Math.min(limit, 40)));
}

/* ------------------------------------------------------------------ */
/* Context packet                                                     */
/* ------------------------------------------------------------------ */

export interface ContextSection {
  heading: string;
  note?: string;
  items: IntelligenceEvidence[];
}

export interface ContextPacket {
  query: string;
  intent: QueryIntent;
  scope: { projectId: string; projectName: string; branch?: string; collections: string[] };
  budgetTokens: number;
  usedTokens: number;
  /** True when evidence was dropped to stay inside the budget. */
  truncated: boolean;
  sections: ContextSection[];
  conflicts: EvidenceConflict[];
  /** Sources that could not answer (provider off, index missing), stated rather than hidden. */
  missing: string[];
  /** The rendered packet: what an agent actually reads. */
  text: string;
}

/** Roughly four characters per token; an estimate is enough to keep a packet bounded. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const DEFAULT_CONTEXT_BUDGET = 1500;
export const MAX_CONTEXT_BUDGET = 6000;

function citation(item: IntelligenceEvidence): string {
  const parts = [`${item.provider}:${item.ref}`, item.projectName, item.authority];
  if (item.branch) parts.push(`branch ${item.branch}`);
  if (item.revision) parts.push(`@${item.revision.slice(0, 12)}`);
  if (item.freshness === 'stale') parts.push(`stale${item.staleReason ? ` (${item.staleReason})` : ''}`);
  return parts.join(' · ');
}

function evidenceLine(item: IntelligenceEvidence): string {
  const text = (item.text ?? '').replace(/[\u0001\u0002]/g, '').replace(/\s+/g, ' ').trim();
  const body = text && evidenceKey(text) !== evidenceKey(item.title) ? ` — ${text.length > 320 ? `${text.slice(0, 319)}…` : text}` : '';
  return `- ${item.title}${body} [${citation(item)}]`;
}

/**
 * Compiles ranked evidence into a bounded, cited packet. Current knowledge and history are kept in
 * separate sections so a past event is never read as a present fact, and whatever does not fit the
 * budget is dropped from the weakest end and reported as truncated.
 */
export function compileContextPacket(input: {
  query: string;
  intent: QueryIntent;
  scope: ContextPacket['scope'];
  evidence: IntelligenceEvidence[];
  conflicts?: EvidenceConflict[];
  missing?: string[];
  budgetTokens?: number;
}): ContextPacket {
  const budgetTokens = Math.max(200, Math.min(input.budgetTokens ?? DEFAULT_CONTEXT_BUDGET, MAX_CONTEXT_BUDGET));
  const conflicts = input.conflicts ?? [];
  const missing = input.missing ?? [];
  const scopeLine = [`project ${input.scope.projectName}`, input.scope.branch ? `branch ${input.scope.branch}` : '', input.scope.collections.length ? `collections ${input.scope.collections.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ');
  const header = [
    `# Context — ${input.query.replace(/\s+/g, ' ').trim().slice(0, 200)}`,
    '',
    `Scope: ${scopeLine}. Intent: ${input.intent}.`,
    'Explicit project rules (AGENTS.md) and the current source code outrank everything below. History is what happened, not what is true now.'
  ];
  const tail: string[] = [];
  if (conflicts.length) {
    tail.push('', '## Conflicts and uncertainty');
    for (const c of conflicts.slice(0, 8)) tail.push(`- ${c.a} vs ${c.b}: ${c.reason}`);
  }
  if (missing.length) {
    tail.push('', '## Missing evidence');
    for (const m of missing.slice(0, 8)) tail.push(`- ${m}`);
  }
  const groups: Array<{ heading: string; note?: string; pick: (e: IntelligenceEvidence) => boolean }> = [
    { heading: 'Current knowledge', pick: (e) => !e.historical && e.provider !== 'graph' },
    { heading: 'History', note: 'Past events and unverified recollection — confirm against the code before acting.', pick: (e) => e.historical && e.provider !== 'graph' },
    { heading: 'Graph references', note: 'Derived from an index at the cited revision; verify against the working tree.', pick: (e) => e.provider === 'graph' }
  ];
  const fixed = estimateTokens([...header, ...tail].join('\n'));
  let used = fixed;
  let truncated = false;
  // Spend the budget in rank order across all sections, then lay the survivors out by section.
  const kept = new Set<IntelligenceEvidence>();
  for (const item of input.evidence) {
    const cost = estimateTokens(evidenceLine(item)) + 1;
    if (used + cost > budgetTokens) {
      truncated = true;
      continue;
    }
    used += cost;
    kept.add(item);
  }
  const sections: ContextSection[] = [];
  const lines = [...header];
  for (const group of groups) {
    const items = input.evidence.filter((e) => kept.has(e) && group.pick(e));
    if (!items.length) continue;
    sections.push({ heading: group.heading, ...(group.note ? { note: group.note } : {}), items });
    lines.push('', `## ${group.heading}`);
    if (group.note) lines.push(group.note);
    for (const item of items) lines.push(evidenceLine(item));
  }
  if (!kept.size) lines.push('', input.evidence.length ? 'Evidence was found but none fits the token budget; raise the budget or narrow the question.' : 'No evidence matched. Treat any answer as inference, not as project knowledge.');
  lines.push(...tail);
  if (truncated) lines.push('', `Truncated to ${budgetTokens} tokens: ${input.evidence.length - kept.size} weaker result(s) were dropped.`);
  const text = lines.join('\n');
  return { query: input.query, intent: input.intent, scope: input.scope, budgetTokens, usedTokens: estimateTokens(text), truncated, sections, conflicts, missing, text };
}

/* ------------------------------------------------------------------ */
/* Graph provider contract                                            */
/* ------------------------------------------------------------------ */

/** Health of one derived graph index, reported to the caller rather than hidden behind a result. */
export interface GraphIndexStatus {
  provider: string;
  /** The user opted this project in. */
  enabled: boolean;
  /** The engine is installed and runnable. */
  installed: boolean;
  /** A graph artifact exists for this project. */
  indexed: boolean;
  indexing?: boolean;
  version?: string;
  /** Commit the artifact was built at, when known. */
  revision?: string;
  indexedAt?: string;
  nodes?: number;
  edges?: number;
  /** True when the checkout's HEAD moved past `revision`. */
  stale?: boolean;
  error?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  /** `code`, `document`, `concept`, … as the engine reports it. */
  type?: string;
  file?: string;
  location?: string;
  community?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  /** `extracted` is read from the source; `inferred` and `ambiguous` are lower-confidence candidates. */
  confidence: 'extracted' | 'inferred' | 'ambiguous';
  score?: number;
  file?: string;
}

/* ------------------------------------------------------------------ */
/* Settings and app-facing views                                      */
/* ------------------------------------------------------------------ */

/** Used at both dispatch boundaries; these operations never originate from a paired client or agent. */
export function isIntelligenceOwnerRequest(channel: string, req: unknown): boolean {
  return channel.startsWith('intelligence:') || (channel === 'settings:update' && !!req && typeof req === 'object' && 'intelligence' in req);
}

export type ReflectionMode = 'off' | 'manual' | 'auto';

/** App-wide intelligence switches (Settings → Project knowledge). Every default is the safe one. */
export interface IntelligenceSettings {
  /** Route the memory MCP tools through the app-owned gateway (one parser, one write path). */
  gateway: boolean;
  /** Session-end reflection: never, only when asked, or after each finished session. */
  reflection: ReflectionMode;
  /** Federated search across the collections a project belongs to. */
  collections: boolean;
  /** Serve personal-scope preferences to sessions. Off until the user turns it on. */
  personalMemory: boolean;
  graphify: GraphifySettings;
}

export interface GraphifySettings {
  /** Index opened Git checkouts locally using the bundled code parser. */
  enabled: boolean;
  /** Stable ids explicitly excluded from indexing and graph retrieval. */
  excludedProjects: string[];
}

export const DEFAULT_INTELLIGENCE_SETTINGS: IntelligenceSettings = {
  gateway: true,
  reflection: 'manual',
  collections: true,
  personalMemory: false,
  graphify: { enabled: true, excludedProjects: [] }
};

export function resolveIntelligenceSettings(stored: Partial<IntelligenceSettings> | undefined | null): IntelligenceSettings {
  const reflection = stored?.reflection;
  const graphify = stored?.graphify;
  return {
    gateway: typeof stored?.gateway === 'boolean' ? stored.gateway : DEFAULT_INTELLIGENCE_SETTINGS.gateway,
    reflection: reflection === 'off' || reflection === 'manual' || reflection === 'auto' ? reflection : DEFAULT_INTELLIGENCE_SETTINGS.reflection,
    collections: typeof stored?.collections === 'boolean' ? stored.collections : DEFAULT_INTELLIGENCE_SETTINGS.collections,
    personalMemory: typeof stored?.personalMemory === 'boolean' ? stored.personalMemory : DEFAULT_INTELLIGENCE_SETTINGS.personalMemory,
    graphify: {
      // Keep a saved off switch (including from the pilot); never use a saved executable override.
      enabled: graphify === undefined ? DEFAULT_INTELLIGENCE_SETTINGS.graphify.enabled : graphify?.enabled === true,
      excludedProjects: Array.isArray(graphify?.excludedProjects)
        ? [...new Set(graphify.excludedProjects.filter((p): p is string => typeof p === 'string' && !!p))].sort()
        : []
    }
  };
}

export interface IntelligenceSearchRequest {
  query: string;
  /** `project` (default) stays inside the session's project; `collection` adds what its collections grant. */
  scope?: 'project' | 'collection';
  providers?: EvidenceProvider[];
  limit?: number;
  includeHistorical?: boolean;
}

export interface IntelligenceSearchResponse {
  query: string;
  intent: QueryIntent;
  scope: ContextPacket['scope'];
  results: IntelligenceEvidence[];
  conflicts: EvidenceConflict[];
  missing: string[];
}

/** A request to widen a record's scope, waiting for the user. Agents can only ask. */
export interface PromotionRequest {
  id: string;
  projectId: string;
  projectName: string;
  /** What is being promoted: a wiki page or a memory record of that project. */
  source: { pageId?: string; recordId?: string };
  title: string;
  text: string;
  to: 'collection' | 'personal';
  collectionId?: string;
  requestedBy: string;
  sessionId?: string;
  reason?: string;
  createdAt: string;
}

/** One row of the audit trail: who changed authority or scope, never the content itself. */
export interface IntelligenceAuditEntry {
  at: string;
  action: string;
  actor: string;
  projectId?: string;
  ref?: string;
  detail?: string;
}

/** The payload the Knowledge panel's Memory and Collections views render. */
export interface IntelligenceView {
  available: boolean;
  /** Why the ledger is unavailable, when it is. */
  reason?: string;
  project: ProjectIdentity;
  settings: IntelligenceSettings;
  records: MemoryRecord[];
  /** Personal-scope records, listed separately because they belong to the user, not the project. */
  personal: MemoryRecord[];
  /** Collection records visible to this project. */
  shared: MemoryRecord[];
  collections: ProjectCollection[];
  /** Every project the registry knows, for collection membership pickers. */
  projects: ProjectIdentity[];
  promotions: PromotionRequest[];
  graph: GraphIndexStatus;
  gateway: { enabled: boolean; listening: boolean; sessions: number };
  audit: IntelligenceAuditEntry[];
}

/** Portable bundle of app-owned memory for one project (records only; caches are rebuilt). */
export interface MemoryExportBundle {
  format: 'vocs-memory-export';
  version: 1;
  exportedAt: string;
  project: Pick<ProjectIdentity, 'id' | 'name' | 'origin' | 'rootCommit'>;
  records: MemoryRecord[];
}
