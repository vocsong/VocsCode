/**
 * The Vocs Intelligence Gateway: the one door a harness's memory tools go through.
 *
 * `resources/mcp/vocs-memory.mjs` is still the stdio MCP server every harness spawns, but with the
 * gateway on it is a thin client: each tool call is posted here and answered by the app's own
 * services, so there is one parser, one write path and one place where scope is decided. The script
 * keeps its local implementation only for sessions explicitly started without a gateway.
 *
 * A capability pins the session, checkout and branch at attachment. Every call also checks the
 * live grant: it can narrow the original permissions but cannot retarget the token or add actions.
 * Only tool data (not caller identity, a filesystem root, or an authority override) comes from JSON.
 *
 * The listener is loopback-only, refuses browser-originated requests and DNS-rebinding hosts, and
 * holds only token digests. It is not a boundary against a process that already runs as the user —
 * such a process can read the wiki from disk — it is what keeps an agent's tools inside the scope
 * its session was given. No Electron imports.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { EVIDENCE_PROVIDERS, INTELLIGENCE_ACTIONS, type EvidenceProvider, type EvidenceSource, type IntelligenceAction, type IntelligenceEvidence, type MemoryType } from '../../shared/intelligence';
import {
  KNOWLEDGE_KINDS,
  authorityLabel,
  buildKnowledgeGraph,
  isKnowledgeId,
  isServable,
  type KnowledgeAnchor,
  type KnowledgeKind,
  type KnowledgeSource,
  type KnowledgeSourceType
} from '../../shared/knowledge';
import type { KnowledgeService } from '../knowledge/service';
import type { StoredPage } from '../knowledge/store';
import { errorMessage } from '../util/async';
import type { IntelligenceContext, IntelligenceService } from './service';

export const GATEWAY_URL_ENV = 'VOCS_MEMORY_GATEWAY_URL';
export const GATEWAY_TOKEN_ENV = 'VOCS_MEMORY_GATEWAY_TOKEN';

const MAX_REQUEST_BYTES = 1_000_000;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
const SOURCE_TYPES: KnowledgeSourceType[] = ['file', 'doc', 'commit', 'transcript', 'session', 'url', 'human'];
const RECORDED_TYPES = ['semantic', 'procedural', 'episodic'] as const;
const RECALL_TYPES = [...RECORDED_TYPES, 'preference'] as const;

/** The six tools that predate the gateway; their results keep the shape the stdio script returns. */
export const LEGACY_MEMORY_TOOLS = ['knowledge_search', 'knowledge_read', 'knowledge_related', 'knowledge_propose', 'knowledge_status', 'session_history_search'] as const;
/** Tools that exist only through the gateway. */
export const INTELLIGENCE_TOOLS = ['intelligence_search', 'intelligence_trace', 'knowledge_record', 'knowledge_promote', 'memory_recall', 'memory_forget', 'context_compile'] as const;

type MemoryTool = (typeof LEGACY_MEMORY_TOOLS | typeof INTELLIGENCE_TOOLS)[number];

/** What each tool needs the session to be allowed to do. */
const TOOL_ACTION = {
  knowledge_search: 'read',
  knowledge_read: 'read',
  knowledge_related: 'read',
  knowledge_status: 'read',
  session_history_search: 'read',
  intelligence_search: 'read',
  intelligence_trace: 'read',
  memory_recall: 'read',
  context_compile: 'read',
  knowledge_propose: 'record',
  knowledge_record: 'record',
  knowledge_promote: 'promote',
  memory_forget: 'forget'
} satisfies Record<MemoryTool, IntelligenceAction>;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type Rule = (value: unknown) => boolean;
const string: Rule = (value) => typeof value === 'string';
const text: Rule = (value) => !!str(value);
const boolean: Rule = (value) => typeof value === 'boolean';
const positiveInteger: Rule = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const oneOf = (values: readonly string[]): Rule => (value) => typeof value === 'string' && values.includes(value);
const arrayOf = (test: Rule, nonempty = false): Rule => (value) => Array.isArray(value) && (!nonempty || value.length > 0) && value.every(test);
const object = (fields: Record<string, Rule>, required: string[] = []): Rule => (value) =>
  isObject(value) && required.every((key) => Object.hasOwn(value, key)) && Object.entries(value).every(([key, field]) => Object.hasOwn(fields, key) && fields[key](field));
// These segments are hidden/managed by the store, not addressable page names. In particular an
// explicit page_id must not replace a branch slice (branches/<other-branch>/...) under the wiki.
const pageId: Rule = (value) => {
  const id = str(value);
  return isKnowledgeId(id) && id.split('/').every((part) => part && part !== 'branches' && !part.startsWith('_'));
};
const recordId: Rule = (value) => /^mem_[0-9a-z]+$/.test(str(value));
const searchScope = oneOf(['project', 'collection']);
const proposal = {
  title: text, claim: text, body: text, page_id: pageId,
  keywords: arrayOf(string), labels: arrayOf(string),
  sources: arrayOf(object({ type: oneOf(SOURCE_TYPES), ref: text, note: string }, ['type', 'ref'])),
  anchors: arrayOf(object({ file: text, symbol: string }, ['file']))
};

// Mirror the packaged tools' input schemas at the HTTP trust boundary. The stdio client is not
// the authority: raw loopback callers must not pass identity or review fields, even in nested data.
const TOOL_ARGS: Record<MemoryTool, Rule> = {
  knowledge_search: object({ query: text, limit: positiveInteger, include_historical: boolean }, ['query']),
  knowledge_read: object({ page: pageId }, ['page']),
  knowledge_related: object({ page: pageId, path: text }),
  knowledge_propose: object({ ...proposal, kind: oneOf(KNOWLEDGE_KINDS) }, ['title', 'claim', 'body']),
  knowledge_status: object({}),
  session_history_search: object({ query: text, limit: positiveInteger, include_archived: boolean }, ['query']),
  intelligence_search: object({ query: text, scope: searchScope, sources: arrayOf(oneOf(EVIDENCE_PROVIDERS), true), limit: positiveInteger, include_historical: boolean }, ['query']),
  intelligence_trace: object({ from: text, to: text }, ['from']),
  context_compile: object({ query: text, scope: searchScope, budget_tokens: positiveInteger }, ['query']),
  memory_recall: object({ query: string, types: arrayOf(oneOf(RECALL_TYPES), true), limit: positiveInteger, include_unverified: boolean }),
  knowledge_record: object({ ...proposal, draft: boolean, kind: text, memory_type: oneOf(RECORDED_TYPES), scope: oneOf(['project', 'branch']) }, ['title', 'claim']),
  knowledge_promote: object({ page: pageId, record: recordId, to: oneOf(['collection', 'personal']), collection: text, reason: string }, ['to']),
  memory_forget: object({ id: recordId }, ['id'])
};

function isToolName(value: unknown): value is MemoryTool {
  return typeof value === 'string' && Object.hasOwn(TOOL_ACTION, value);
}

function permissionProblem(session: GatewaySession, tool: MemoryTool, args: Record<string, unknown>): string | null {
  const action = TOOL_ACTION[tool];
  if (!session.actions.includes(action) || (session.restricted && (action === 'promote' || action === 'forget'))) return `This session is not allowed to ${action} through the memory tools.`;
  if (session.restricted && tool === 'session_history_search') return 'This session is not allowed to search session history.';
  if (args.scope === 'collection' && (session.restricted || session.allowCollections !== true)) return 'This session is not allowed to search collection memory.';
  if (args.scope === 'branch' && !session.branch) return 'This session does not have a branch scope.';
  return null;
}

function argumentProblem(tool: MemoryTool, args: Record<string, unknown>): string | null {
  if (!TOOL_ARGS[tool](args)) return `Invalid arguments for ${tool}. Use the advertised tool schema.`;
  if (tool === 'knowledge_record' && args.memory_type !== 'episodic' && !str(args.body)) return 'Project knowledge needs a body: the claim, the rationale, and how to apply it.';
  if (tool === 'knowledge_promote' && (!!args.page === !!args.record || (args.to === 'personal' && args.collection))) return 'Name exactly one wiki page or memory record, and only name a collection when promoting to a collection.';
  return null;
}

export interface GatewaySession extends IntelligenceContext {
  actions: IntelligenceAction[];
  /** Wider reads are an explicit app grant, never a tool argument alone. */
  allowCollections?: boolean;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function textResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strList(value: unknown, cap: number): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim()).slice(0, cap) : [];
}

function sourcesOf(value: unknown): EvidenceSource[] {
  if (!Array.isArray(value)) return [];
  const out: EvidenceSource[] = [];
  for (const raw of value.slice(0, 24)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const ref = str(entry.ref);
    const type = str(entry.type) as KnowledgeSourceType;
    if (!ref || !SOURCE_TYPES.includes(type)) continue;
    const note = str(entry.note);
    out.push({ type, ref, ...(note ? { note: note.slice(0, 200) } : {}) });
  }
  return out;
}

function anchorsOf(value: unknown): KnowledgeAnchor[] {
  if (!Array.isArray(value)) return [];
  const out: KnowledgeAnchor[] = [];
  for (const raw of value.slice(0, 24)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const file = str(entry.file);
    if (!file) continue;
    const symbol = str(entry.symbol);
    out.push(symbol ? { file, symbol } : { file });
  }
  return out;
}

function evidenceOut(item: IntelligenceEvidence): Record<string, unknown> {
  return {
    provider: item.provider,
    project: item.projectName,
    ref: item.ref,
    title: item.title,
    ...(item.text ? { text: item.text } : {}),
    ...(item.kind ? { kind: item.kind } : {}),
    authority: item.authority,
    historical: item.historical,
    ...(item.provider === 'memory' && item.historical && item.sources ? { sources: item.sources.filter((source) => source.type === 'transcript') } : {}),
    scope: item.scope,
    ...(item.branch ? { branch: item.branch } : {}),
    ...(item.revision ? { revision: item.revision } : {}),
    ...(item.freshness ? { freshness: item.freshness } : {}),
    ...(item.staleReason ? { staleReason: item.staleReason } : {}),
    ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    why: item.why,
    score: item.score
  };
}

/** The summary shape `knowledge_search` has always returned. */
function pageSummary(page: StoredPage, extra: { degree?: number; snippet?: string; score?: number }): Record<string, unknown> {
  const meta = page.meta;
  return {
    id: meta.id,
    title: meta.title,
    kind: meta.kind,
    status: meta.status,
    authority: authorityLabel(meta),
    scope: meta.scope,
    ...(meta.branch ? { branch: meta.branch } : {}),
    ...(meta.claim ? { claim: meta.claim } : {}),
    keywords: meta.keywords,
    labels: meta.labels,
    ...(extra.degree !== undefined ? { degree: extra.degree } : {}),
    ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
    ...(meta.evidenceCount !== undefined ? { evidenceCount: meta.evidenceCount } : {}),
    ...(extra.snippet ? { snippet: extra.snippet } : {}),
    ...(extra.score !== undefined ? { score: Math.round(extra.score * 10) / 10 } : {})
  };
}

type ToolServices = {
  intelligence: Pick<IntelligenceService, 'search' | 'trace' | 'compile' | 'historySearch' | 'recall' | 'record' | 'requestPromotion' | 'forget'>;
  knowledge: KnowledgeService;
};

/**
 * Runs one memory tool for one session. Every tool is answered from the session's own scope; the
 * arguments can narrow what is returned but can never name another project.
 */
export async function callIntelligenceTool(deps: ToolServices, session: GatewaySession, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  if (!isToolName(name)) return errorResult('Unknown memory tool.');
  const problem = permissionProblem(session, name, args) ?? argumentProblem(name, args);
  if (problem) return errorResult(problem);
  signal?.throwIfAborted();
  const { intelligence, knowledge } = deps;
  const scope = { projectRoot: session.projectRoot, cwd: session.cwd, ...(session.branch ? { branch: session.branch } : {}) };
  const context = { ...session, signal, modelFacing: true };

  switch (name) {
    case 'knowledge_search': {
      const query = str(args.query);
      const pages = await knowledge.store.load(scope);
      signal?.throwIfAborted();
      const byId = new Map(pages.map((p) => [p.meta.id, p]));
      const degrees = new Map(buildKnowledgeGraph(pages).nodes.map((n) => [n.id, n.degree]));
      const results = await knowledge.search(scope, query, { limit: Number(args.limit) || 12, includeHistorical: args.include_historical === true });
      const out = results.flatMap((r) => {
        const page = byId.get(r.id);
        return page ? [pageSummary(page, { degree: degrees.get(r.id), snippet: r.snippet, score: r.score })] : [];
      });
      return textResult({ project: knowledge.store.repoDir(scope), count: out.length, results: out });
    }
    case 'knowledge_read': {
      const id = str(args.page);
      const page = await knowledge.store.read(scope, id);
      if (!page) return errorResult(`No knowledge page "${id}". Use knowledge_search first.`);
      const meta = page.meta;
      return textResult({
        id: meta.id,
        title: meta.title,
        kind: meta.kind,
        status: meta.status,
        authority: authorityLabel(meta),
        scope: meta.scope,
        ...(meta.branch ? { branch: meta.branch } : {}),
        ...(meta.claim ? { claim: meta.claim } : {}),
        keywords: meta.keywords,
        labels: meta.labels,
        ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
        ...(meta.updatedBy ? { updatedBy: meta.updatedBy } : {}),
        ...(meta.evidenceCount !== undefined ? { evidenceCount: meta.evidenceCount } : {}),
        ...(meta.verification ? { verification: meta.verification } : {}),
        sources: meta.sources,
        anchors: meta.anchors,
        ...(meta.supersededBy ? { supersededBy: meta.supersededBy } : {}),
        body: page.body
      });
    }
    case 'knowledge_related': {
      const pages = await knowledge.store.load(scope);
      const explicit = str(args.page) ? pages.find((p) => p.meta.id === str(args.page)) : undefined;
      const pathArg = str(args.path).replace(/\\/g, '/');
      const matching = pathArg ? pages.filter((p) => p.meta.anchors.some((a) => a.file.replace(/\\/g, '/') === pathArg) || p.meta.sources.some((s) => s.ref.replace(/\\/g, '/') === pathArg)) : [];
      const base = explicit ?? matching[0];
      if (!base) return errorResult(`No page or anchor matched ${pathArg || '(no page given)'}.`);
      const best = new Map<string, { type: string; weight: number }>();
      for (const edge of buildKnowledgeGraph(pages).edges) {
        if (edge.from !== base.meta.id && edge.to !== base.meta.id) continue;
        const other = edge.from === base.meta.id ? edge.to : edge.from;
        if (other === base.meta.id) continue;
        const current = best.get(other);
        if (!current || edge.weight > current.weight) best.set(other, edge);
      }
      const byId = new Map(pages.map((p) => [p.meta.id, p]));
      const related = [...best.entries()]
        .filter(([id]) => byId.has(id))
        .sort((a, b) => b[1].weight - a[1].weight)
        .map(([id, edge]) => ({ id, title: byId.get(id)?.meta.title ?? id, edge: edge.type }));
      return textResult({ page: base.meta.id, related });
    }
    case 'knowledge_propose': {
      const title = str(args.title);
      const claim = str(args.claim);
      const body = str(args.body);
      const requestedId = str(args.page_id);
      const kind = (KNOWLEDGE_KINDS as readonly string[]).includes(str(args.kind)) ? (str(args.kind) as KnowledgeKind) : undefined;
      try {
        const result = await knowledge.propose(
          scope,
          {
            title,
            claim,
            body,
            ...(kind ? { kind } : {}),
            ...(requestedId ? { pageId: requestedId } : {}),
            keywords: strList(args.keywords, 12),
            labels: strList(args.labels, 24),
            sources: sourcesOf(args.sources) as KnowledgeSource[],
            anchors: anchorsOf(args.anchors)
          },
          'agent:mcp',
          session.sessionId,
          signal
        );
        if (result.rejected) return textResult({ id: '', targetPageId: '', status: 'rejected', saved: false, rejected: true, note: 'This claim was rejected before and is tombstoned in _rejected.json; nothing was written.' });
        if (result.protected === 'refused') {
          return textResult({ id: result.id, targetPageId: result.id, status: 'candidate', saved: false, protected: true, note: `Page ${result.id} is human-reviewed and was not changed. A different claim requires human review.` });
        }
        const page = await knowledge.store.read(scope, result.id);
        const pageScope = page?.meta.scope ?? 'repo';
        return textResult({
          id: result.id,
          targetPageId: result.id,
          status: 'current',
          saved: true,
          scope: pageScope,
          note:
            result.protected === 'kept'
              ? `Page ${result.id} is human-reviewed: its text was kept and your sources were added as evidence.`
              : pageScope === 'branch'
                ? `Recorded in the project wiki, on branch ${page?.meta.branch ?? session.branch ?? ''}.`
                : 'Recorded in the project wiki automatically.'
        });
      } catch (e) {
        return errorResult(errorMessage(e));
      }
    }
    case 'knowledge_status': {
      const pages = await knowledge.store.load(scope);
      const graph = buildKnowledgeGraph(pages);
      const labels = new Set<string>();
      for (const page of pages) for (const label of page.meta.labels) labels.add(label);
      const servable = pages.filter((p) => isServable(p.meta)).length;
      const awaitingReview = (await knowledge.store.proposals(scope)).length;
      return textResult({
        wikiDir: knowledge.store.repoDir(scope),
        branchWikiDir: knowledge.store.branchDir(scope),
        pages: pages.length,
        servable,
        labels: labels.size,
        graph: { nodes: graph.nodes.length, edges: graph.edges.length },
        awaitingReview,
        toolHint: servable ? 'Use knowledge_search before changing an invariant.' : 'No pages yet; knowledge_propose records durable findings in the wiki automatically.'
      });
    }
    case 'session_history_search': {
      const query = str(args.query);
      if (!query.split(/[^\p{L}\p{N}_*]+/u).some((term) => term.replace(/\*/g, '').length > 1)) return errorResult('session_history_search needs a query of at least two letters.');
      const found = await intelligence.historySearch(context, query, { limit: Number(args.limit) || 6, includeArchived: args.include_archived === true, strict: true });
      if (!found.available) return textResult({ available: false, reason: 'Session history is unavailable (no index).' });
      if (!found.sessions) return textResult({ available: true, projectRoot: session.projectRoot, count: 0, results: [], note: 'No sessions recorded for this project yet.' });
      return textResult({
        available: true,
        projectRoot: session.projectRoot,
        count: found.results.length,
        results: found.results,
        note: 'Episodic memory: what happened in past sessions on this project. Not project truth — use knowledge_search for that.'
      });
    }
    case 'intelligence_search': {
      const query = str(args.query);
      const providers = args.sources as EvidenceProvider[] | undefined;
      const found = await intelligence.search(context, {
        query,
        scope: args.scope === 'collection' ? 'collection' : 'project',
        ...(providers?.length ? { providers } : {}),
        ...(Number(args.limit) ? { limit: Number(args.limit) } : {}),
        includeHistorical: args.include_historical === true
      });
      return textResult({
        query: found.query,
        intent: found.intent,
        scope: found.scope,
        count: found.results.length,
        results: found.results.map(evidenceOut),
        conflicts: found.conflicts,
        missing: found.missing,
        note: 'Authority, strongest first: project rules (AGENTS.md) and the current code, then human-reviewed and verified knowledge, then accepted knowledge, then history. `historical` results are what happened, not what is true now.'
      });
    }
    case 'intelligence_trace': {
      const from = str(args.from);
      return textResult(await intelligence.trace(context, { from, ...(str(args.to) ? { to: str(args.to) } : {}) }));
    }
    case 'context_compile': {
      const query = str(args.query);
      const packet = await intelligence.compile(context, { query, ...(Number(args.budget_tokens) ? { budgetTokens: Number(args.budget_tokens) } : {}), scope: args.scope === 'collection' ? 'collection' : 'project' });
      return textResult(packet.text);
    }
    case 'memory_recall': {
      const types = args.types as MemoryType[] | undefined;
      const recalled = await intelligence.recall(context, {
        ...(str(args.query) ? { query: str(args.query) } : {}),
        ...(types?.length ? { types } : {}),
        ...(Number(args.limit) ? { limit: Number(args.limit) } : {}),
        includeUnverified: args.include_unverified !== false
      });
      return textResult({
        count: recalled.records.length,
        records: recalled.records.map((r) => ({
          id: r.id,
          type: r.type,
          kind: r.kind,
          scope: r.scope,
          state: r.state,
          servable: r.servable,
          historical: r.type === 'episodic' || !r.servable,
          title: r.title,
          text: r.text.length > 1_200 ? `${r.text.slice(0, 1_199)}…` : r.text,
          ...(r.branch ? { branch: r.branch } : {}),
          ...(r.verification ? { verification: r.verification } : {}),
          sources: r.sources,
          updatedAt: r.updatedAt
        })),
        history: recalled.history,
        note: recalled.note
      });
    }
    case 'knowledge_record': {
      const memoryType = args.memory_type === 'procedural' || args.memory_type === 'episodic' ? args.memory_type : 'semantic';
      try {
        const result = await intelligence.record(
          context,
          {
            title: str(args.title),
            claim: str(args.claim),
            ...(str(args.body) ? { body: str(args.body) } : {}),
            memoryType,
            ...(args.draft === true ? { draft: true } : {}),
            ...(str(args.kind) ? { kind: str(args.kind) } : {}),
            scope: args.scope === 'branch' ? 'branch' : 'project',
            ...(str(args.page_id) ? { pageId: str(args.page_id) } : {}),
            keywords: strList(args.keywords, 12),
            labels: strList(args.labels, 24),
            sources: sourcesOf(args.sources),
            anchors: anchorsOf(args.anchors)
          },
          'agent:record'
        );
        return textResult(result);
      } catch (e) {
        return errorResult(errorMessage(e));
      }
    }
    case 'knowledge_promote': {
      const to = args.to === 'personal' ? 'personal' : args.to === 'collection' ? 'collection' : null;
      if (!to) return errorResult('knowledge_promote needs `to`: "collection" or "personal".');
      try {
        const request = await intelligence.requestPromotion(
          context,
          { ...(str(args.page) ? { pageId: str(args.page) } : {}), ...(str(args.record) ? { recordId: str(args.record) } : {}), to, ...(str(args.collection) ? { collection: str(args.collection) } : {}), ...(str(args.reason) ? { reason: str(args.reason) } : {}) },
          'agent:mcp'
        );
        return textResult({ requested: true, id: request.id, to: request.to, title: request.title, note: 'Nothing was promoted. The request is waiting for the user to approve it in the Knowledge panel; only a person can widen a record’s scope.' });
      } catch (e) {
        return errorResult(errorMessage(e));
      }
    }
    case 'memory_forget': {
      const id = str(args.id);
      try {
        const result = await intelligence.forget(context, id, 'agent');
        return textResult({ ...result, note: result.forgotten ? 'The record and its search index entry were deleted; the same statement will not be re-captured.' : 'Nothing was deleted.' });
      } catch (e) {
        return errorResult(errorMessage(e));
      }
    }
  }
}

export interface IntelligenceGatewayDeps {
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** The app's current record of a session, or null once it is gone or may no longer use the tools. */
  session: (sessionId: string) => GatewaySession | null;
  call: (session: GatewaySession, tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>;
  /** The Settings switch; off means no session is handed a token and existing ones stop working. */
  enabled: () => boolean;
  now?: () => number;
}

interface Capability {
  nonce: Buffer;
  digest: string;
  session: GatewaySession;
  expiresAt: number;
  active: Set<AbortController>;
}

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const sameIdentity = (a: GatewaySession, b: GatewaySession): boolean =>
  a.sessionId === b.sessionId && a.projectRoot === b.projectRoot && a.cwd === b.cwd && a.branch === b.branch;

export class IntelligenceGateway {
  private server?: Server;
  private starting?: Promise<void>;
  private endpoint?: string;
  private readonly signingKey = randomBytes(32);
  private readonly capabilities = new Map<string, Capability>();
  private readonly issued = new Map<string, Capability>();
  private readonly sockets = new Set<Socket>();

  constructor(private readonly deps: IntelligenceGatewayDeps) {}

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.endpoint) return;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        // Neither service exception details nor inbound headers/tool data belong in app logs.
        this.deps.log('debug', 'intelligence: gateway request failed');
        this.reject(req, res, 500, 'The intelligence gateway request failed.');
      });
    });
    server.requestTimeout = 120_000;
    server.headersTimeout = 10_000;
    this.server = server;
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    const starting = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        this.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/call`;
        resolve();
      });
    }).catch(() => {
      this.server = undefined;
      server.close();
      this.deps.log('warn', 'intelligence: could not start the loopback gateway; gateway-backed memory is unavailable');
    }).finally(() => {
      this.starting = undefined;
    });
    this.starting = starting;
    await starting;
  }

  /** A null attachment is an authorization or availability failure, not permission to fall back. */
  attach(sessionId: string): { url: string; token: string } | null {
    if (!this.endpoint || !this.enabled()) return null;
    const session = this.currentSession(sessionId);
    if (!session?.actions.length) {
      this.revoke(sessionId);
      return null;
    }
    const previous = this.issued.get(sessionId);
    if (previous && !this.expired(previous) && sameIdentity(previous.session, session)) {
      return { url: this.endpoint, token: this.tokenFor(previous.nonce) };
    }
    if (previous) this.drop(previous);
    const nonce = randomBytes(32);
    const token = this.tokenFor(nonce);
    const cap: Capability = { nonce, digest: digest(token), session, expiresAt: this.now() + TOKEN_TTL_MS, active: new Set() };
    this.capabilities.set(cap.digest, cap);
    this.issued.set(sessionId, cap);
    return { url: this.endpoint, token };
  }

  revoke(sessionId: string): void {
    const cap = this.issued.get(sessionId);
    if (cap) this.drop(cap);
  }

  /** A running grant may be narrowed, not widened. Abort outstanding work on that grant. */
  restrictToRead(sessionId: string): void {
    const cap = this.issued.get(sessionId);
    if (!cap || cap.session.actions.every((action) => action === 'read')) return;
    cap.session.actions = cap.session.actions.filter((action) => action === 'read');
    for (const controller of cap.active) controller.abort();
  }

  revokeAll(): void {
    for (const cap of this.issued.values()) this.drop(cap);
  }

  state(): { listening: boolean; sessions: number } {
    if (this.enabled()) {
      for (const cap of this.issued.values()) if (this.expired(cap)) this.drop(cap);
    }
    return { listening: !!this.endpoint, sessions: this.issued.size };
  }

  async close(): Promise<void> {
    if (this.starting) await this.starting;
    this.revokeAll();
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private expired(cap: Capability): boolean {
    return cap.expiresAt <= this.now();
  }

  /** Reproduce the bearer for a re-resolved launch definition without storing it in either map. */
  private tokenFor(nonce: Buffer): string {
    return createHmac('sha256', this.signingKey).update(nonce).digest('base64url');
  }

  private drop(cap: Capability): void {
    this.capabilities.delete(cap.digest);
    if (this.issued.get(cap.session.sessionId) === cap) this.issued.delete(cap.session.sessionId);
    for (const controller of cap.active) controller.abort();
  }

  private enabled(): boolean {
    if (this.deps.enabled()) return true;
    this.revokeAll();
    return false;
  }

  private currentSession(id: string): GatewaySession | null {
    const current = this.deps.session(id);
    if (!current || current.sessionId !== id || !current.projectRoot || !current.cwd) return null;
    return {
      sessionId: id,
      projectRoot: current.projectRoot,
      cwd: current.cwd,
      ...(current.branch ? { branch: current.branch } : {}),
      actions: INTELLIGENCE_ACTIONS.filter((action) => current.actions.includes(action)),
      allowCollections: current.allowCollections === true,
      restricted: current.restricted === true
    };
  }

  private authorize(cap: Capability): { session: GatewaySession } | { status: number; error: string } {
    if (this.capabilities.get(cap.digest) !== cap || this.expired(cap)) {
      this.drop(cap);
      return { status: 401, error: 'Unauthorized' };
    }
    if (!this.enabled()) return { status: 403, error: 'The intelligence gateway is switched off' };
    const current = this.currentSession(cap.session.sessionId);
    if (!current || !sameIdentity(cap.session, current)) {
      this.drop(cap);
      return { status: 403, error: 'This session may no longer use the memory tools' };
    }
    return {
      session: {
        ...current,
        actions: cap.session.actions.filter((action) => current.actions.includes(action)),
        allowCollections: cap.session.allowCollections && current.allowCollections,
        restricted: cap.session.restricted || current.restricted
      }
    };
  }

  private json(res: ServerResponse, status: number, value: unknown, token?: string): void {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(token ? body.replaceAll(token, '<redacted>') : body);
  }

  private reject(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
    if (res.destroyed || res.writableEnded) return;
    res.setHeader('Connection', 'close');
    this.json(res, status, { error });
    req.resume();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Reject browser traffic (even an empty Origin), duplicate auth/routing headers and host aliases.
    const host = this.endpoint ? new URL(this.endpoint).host : '';
    const headers = req.headersDistinct;
    if (!host || headers.host?.length !== 1 || headers.host[0] !== host || headers.origin || headers['sec-fetch-site'] || req.url !== '/call') return this.reject(req, res, 403, 'Forbidden');
    const token = headers.authorization?.length === 1 ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(headers.authorization[0])?.[1] : undefined;
    const cap = token ? this.capabilities.get(digest(token)) : undefined;
    if (!cap || !token) return this.reject(req, res, 401, 'Unauthorized');
    if (req.method !== 'POST') return this.reject(req, res, 405, 'Expected POST');
    if (headers['content-type']?.length !== 1 || !JSON_CONTENT_TYPE.test(headers['content-type'][0])) return this.reject(req, res, 415, 'Expected application/json');
    const accepted = this.authorize(cap);
    if ('status' in accepted) return this.reject(req, res, accepted.status, accepted.error);
    if (Number(req.headers['content-length']) > MAX_REQUEST_BYTES) return this.reject(req, res, 413, 'Request too large');
    const chunks: Buffer[] = [];
    let bytes = 0;
    // Do not destroy the socket via the iterator on overflow: the bounded failure must reach the client.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const data = chunk as Buffer;
      bytes += data.length;
      if (bytes > MAX_REQUEST_BYTES) return this.reject(req, res, 413, 'Request too large');
      chunks.push(data);
    }
    if (res.destroyed) return;
    const grant = this.authorize(cap); // Streaming the body can outlive the grant.
    if ('status' in grant) return this.reject(req, res, grant.status, grant.error);
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      return this.reject(req, res, 400, 'Invalid JSON');
    }
    if (!isObject(message) || Object.keys(message).length !== 2 || typeof message.tool !== 'string' || !isObject(message.arguments)) return this.reject(req, res, 400, 'Expected a tool and an arguments object');
    const { tool, arguments: args } = message;
    if (!isToolName(tool)) return this.json(res, 200, { result: errorResult('Unknown memory tool.') });
    const problem = permissionProblem(grant.session, tool, args) ?? argumentProblem(tool, args);
    if (problem) return this.json(res, 200, { result: errorResult(problem) });
    if (JSON.stringify(args).includes(token)) return this.reject(req, res, 400, 'A credential cannot be used as tool data');

    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.once('close', onClose);
    cap.active.add(controller);
    const expiry = setTimeout(() => this.drop(cap), Math.max(0, cap.expiresAt - this.now()));
    expiry.unref();
    try {
      let result: ToolResult;
      try {
        result = await this.deps.call(grant.session, tool, args, controller.signal);
      } catch {
        if (!controller.signal.aborted) this.deps.log('debug', 'intelligence: gateway tool failed');
        result = errorResult('The intelligence gateway could not complete the tool call.');
      }
      if (res.destroyed) return;
      const live = this.authorize(cap);
      if ('status' in live) return this.reject(req, res, live.status, live.error);
      const denied = permissionProblem(live.session, tool, args);
      if (denied) return this.json(res, 200, { result: errorResult(denied) });
      if (controller.signal.aborted) return;
      // A narrower read grant during dispatch must also prevent a wider in-flight result escaping.
      if ((!grant.session.restricted && live.session.restricted) || (grant.session.allowCollections && !live.session.allowCollections)) {
        return this.json(res, 200, { result: errorResult('This session’s memory grant changed before the call completed.') });
      }
      this.json(res, 200, { result }, token);
    } finally {
      clearTimeout(expiry);
      cap.active.delete(controller);
      res.removeListener('close', onClose);
    }
  }
}
