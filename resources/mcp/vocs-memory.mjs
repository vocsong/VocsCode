#!/usr/bin/env node
/**
 * A dependency-free MCP stdio server for project knowledge and memory.
 *
 * The app injects one copy per session. Configured sessions need only the loopback endpoint and
 * capability; their project, checkout and permissions are resolved in the app.
 *
 * Tools are deliberately pull-based and narrow — search, read, related, propose, status — because
 * a wiki that is pasted into every prompt is just context bloat. `propose` writes durable knowledge
 * straight into the wiki (status: current, updated_by: agent:mcp); a claim tombstoned in
 * `_rejected.json` is refused instead. Pages carry labels, and retrieval walks the relation graph
 * derived from related / supersedes / contradicts / wikilinks / shared anchors / shared labels.
 *
 * With the app's intelligence gateway configured (`VOCS_MEMORY_GATEWAY_URL` plus a per-session
 * `VOCS_MEMORY_GATEWAY_TOKEN`), this process is a thin client: every tool call is posted to the app
 * and answered by its own services, which is where scope, lifecycle and the single write path live,
 * and seven more tools appear (federated search, trace, recall, record, promote, forget, context).
 * Only when both gateway variables are absent can the server use `VOCS_MEMORY_ROOT` and the other
 * standalone wiki settings. An invalid, denied or unavailable gateway never selects this mode.
 *
 * The frontmatter subset here must stay in lockstep with src/shared/knowledge.ts. That pairing is
 * covered by tests/knowledge-mcp.test.ts, which writes with one side and reads with the other.
 */
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { knowledgeCollision, sameKnowledgeClaim, sameRejectedKnowledgeClaim, withKnowledgeWriteLock, writeKnowledgeFileAtomic } from './knowledge-write.mjs';

const MAX_PAGES = 800;
const MAX_BODY_CHARS = 20000;
const MAX_SNIPPET = 220;
const MAX_QUERY_TERMS = 8;
/** One chatty session must not drown the rest of the project's history. */
const MAX_SESSION_HITS = 3;
/** Retrieval walks the relation graph out from this many strongest lexical matches. */
const MAX_SEARCH_SEEDS = 8;
const GRAPH_HOPS = 2;
const GRAPH_DECAY = 0.5;
/** A page id must survive the app's isKnowledgeId check, or the store never reads the page back. */
const ID_RE = /^[a-z0-9][a-z0-9/_-]*$/;

/** Mirrors src/shared/analytics/text.ts: nothing read out of a transcript is served raw. */
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<private-key>'],
  [/\b(sk|rk|pk)-(?:[a-z]+-)?[A-Za-z0-9_-]{16,}\b/g, '<secret>'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g, '<secret>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '<secret>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<secret>'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '<secret>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<jwt>'],
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1<credentials>@'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 <secret>'],
  [/\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|credential|auth(?:orization)?|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)\s*([:=]+)\s*(["']?)(?!<)[^\s"',;&|]{4,}\3/gi, '$1$2<redacted>'],
  [/(--?(?:token|password|passwd|secret|api-?key|key|auth|access-token|client-secret)(?:[=\s]+))(["']?)[^\s"']{4,}\2/gi, '$1<redacted>']
];

export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Quotes every term so FTS operators in a user query cannot change its meaning; `*` = prefix. */
export function ftsQuery(query) {
  const parts = String(query ?? '')
    .split(/[^\p{L}\p{N}_*]+/u)
    .map((t) => t.trim())
    .filter((t) => t.replace(/\*/g, '').length > 1)
    .slice(0, MAX_QUERY_TERMS);
  if (!parts.length) return null;
  return parts.map((t) => (t.endsWith('*') ? `"${t.slice(0, -1).replace(/"/g, '""')}"*` : `"${t.replace(/"/g, '""')}"`)).join(' ');
}

const KINDS = ['architecture', 'component', 'concept', 'decision', 'convention', 'flow', 'gotcha', 'testing', 'migration'];
const SOURCE_TYPES = ['file', 'doc', 'commit', 'transcript', 'session', 'url', 'human'];

/* ────────────────────────────── frontmatter ─────────────────────────────── */

function stripQuotes(value) {
  const t = String(value).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try {
      return t.startsWith('"') ? JSON.parse(t) : t.slice(1, -1);
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

function parseInlineList(value) {
  const inner = value.trim().slice(1, -1);
  if (!inner.trim()) return [];
  return inner
    .split(',')
    .map((part) => stripQuotes(part))
    .filter(Boolean);
}

/** Parses the narrow frontmatter subset the app writes; extra keys are ignored. */
export function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return null;
  const raw = {};
  let key = null;
  let item = null;
  let list = null;
  for (const line of normalized.slice(4, end).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      const at = trimmed.indexOf(':');
      if (at < 0) continue;
      key = trimmed.slice(0, at).trim();
      const rest = trimmed.slice(at + 1).trim();
      item = null;
      if (!rest) {
        list = [];
        raw[key] = list;
      } else if (rest.startsWith('[') && rest.endsWith(']')) {
        list = null;
        raw[key] = parseInlineList(rest);
      } else {
        list = null;
        raw[key] = stripQuotes(rest);
      }
      continue;
    }
    if (!key || !Array.isArray(list)) continue;
    if (trimmed.startsWith('- ')) {
      const rest = trimmed.slice(2).trim();
      const at = rest.indexOf(':');
      if (at > 0) {
        item = { [rest.slice(0, at).trim()]: stripQuotes(rest.slice(at + 1)) };
        list.push(item);
      } else {
        item = null;
        list.push(stripQuotes(rest));
      }
      continue;
    }
    if (item && indent >= 2) {
      const at = trimmed.indexOf(':');
      if (at > 0) item[trimmed.slice(0, at).trim()] = stripQuotes(trimmed.slice(at + 1));
    }
  }
  return { raw, body: normalized.slice(end + 4).replace(/^\n+/, '').replace(/\s+$/, '') };
}

function list(value, cap = 12) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim()).slice(0, cap);
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

/** Mirrors normalizeLabel in src/shared/knowledge.ts: `Auth & Security` → `auth-security`. */
function normalizeLabel(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function normalizeLabels(values) {
  const out = new Set();
  for (const value of values) {
    const label = normalizeLabel(value);
    if (label) out.add(label);
    if (out.size >= 24) break;
  }
  return [...out];
}

function isValidPageId(value) {
  return typeof value === 'string' && value.length <= 160 && ID_RE.test(value) && value.split('/').every((part) => part && part !== 'branches' && !part.startsWith('_'));
}

function sourcesOf(raw) {
  if (!Array.isArray(raw.sources)) return [];
  const out = [];
  for (const entry of raw.sources) {
    if (!entry || typeof entry !== 'object') continue;
    const ref = typeof entry.ref === 'string' ? entry.ref.trim() : '';
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (!ref || !SOURCE_TYPES.includes(type)) continue;
    out.push({ type, ref, ...(entry.note ? { note: String(entry.note) } : {}), ...(typeof entry.revision === 'string' && entry.revision.trim() ? { revision: entry.revision.trim() } : {}) });
  }
  return out;
}

/** Frontmatter keys this script models; every other key is carried through a rewrite untouched. */
const MODELLED_KEYS = new Set([
  'id', 'title', 'kind', 'status', 'scope', 'branch', 'confidence', 'claim', 'target_page', 'keywords', 'labels', 'sources', 'anchors',
  'related', 'supersedes', 'superseded_by', 'contradicts', 'created_at', 'updated_at', 'updated_by', 'evidence_count',
  'review_state', 'reviewed_by', 'reviewed_at', 'review_note'
]);
/** Recorded verification belongs to the claim it checked; it does not survive a different claim. */
const VERIFICATION_KEYS = ['verified_by', 'verified_at', 'verified_actor', 'verified_revision', 'verified_note'];

/**
 * Keys this script does not model — lifecycle fields the app writes (memory_type, project_id,
 * verified_*, valid_*) and anything a person added by hand — in file order, so a page rewritten
 * here loses nothing the app or its author put there.
 */
function extraOf(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (MODELLED_KEYS.has(key) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value)) {
      if (value.every((v) => typeof v === 'string')) out[key] = value;
      else out[key] = value.filter((v) => v && typeof v === 'object').map((entry) => Object.fromEntries(Object.entries(entry).filter(([, v]) => typeof v === 'string')));
    }
  }
  return out;
}

function extraLines(extra) {
  const lines = [];
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (MODELLED_KEYS.has(key)) continue;
    if (typeof value === 'string') lines.push(`${key}: ${quoteValue(value)}`);
    else if (value.every((v) => typeof v === 'string')) {
      if (value.length) lines.push(`${key}:`, ...value.map((v) => `  - ${quoteValue(v)}`));
    } else {
      const entries = value.filter((entry) => Object.keys(entry).length);
      if (!entries.length) continue;
      lines.push(`${key}:`);
      for (const entry of entries) Object.entries(entry).forEach(([k, v], i) => lines.push(`${i === 0 ? '  - ' : '    '}${k}: ${quoteValue(v)}`));
    }
  }
  return lines;
}

function anchorsOf(raw) {
  if (!Array.isArray(raw.anchors)) return [];
  const out = [];
  for (const entry of raw.anchors) {
    if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string' || !entry.file.trim()) continue;
    out.push(entry.symbol ? { file: entry.file, symbol: String(entry.symbol) } : { file: entry.file });
  }
  return out;
}

/* ───────────────────────────── wiki access ─────────────────────────────── */

function toPage(text, abs, complete = false) {
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;
  const raw = parsed.raw;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const title = typeof raw.title === 'string' ? raw.title : '';
  if (!id || !title) return null;
  const evidenceRaw = raw.evidence_count;
  const evidence = typeof evidenceRaw === 'number' ? evidenceRaw : /^\d+$/.test(String(evidenceRaw ?? '')) ? Number(evidenceRaw) : undefined;
  return {
    id,
    title,
    kind: KINDS.includes(raw.kind) ? raw.kind : 'concept',
    status: typeof raw.status === 'string' ? raw.status : 'draft',
    scope: raw.scope === 'branch' ? 'branch' : 'repo',
    branch: typeof raw.branch === 'string' ? raw.branch : undefined,
    claim: typeof raw.claim === 'string' ? raw.claim : undefined,
    confidence: typeof raw.confidence === 'string' ? raw.confidence : undefined,
    keywords: list(raw.keywords, complete ? Infinity : 12),
    labels: normalizeLabels(list(raw.labels, 24)),
    sources: sourcesOf(raw),
    anchors: anchorsOf(raw),
    related: list(raw.related, complete ? Infinity : 12),
    supersedes: list(raw.supersedes, complete ? Infinity : 12),
    contradicts: list(raw.contradicts, complete ? Infinity : 12),
    supersededBy: typeof raw.superseded_by === 'string' ? raw.superseded_by : undefined,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : undefined,
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : undefined,
    updatedBy: typeof raw.updated_by === 'string' ? raw.updated_by : undefined,
    reviewState: typeof raw.review_state === 'string' ? raw.review_state : undefined,
    reviewedBy: typeof raw.reviewed_by === 'string' ? raw.reviewed_by : undefined,
    reviewedAt: typeof raw.reviewed_at === 'string' ? raw.reviewed_at : undefined,
    reviewNote: typeof raw.review_note === 'string' ? raw.review_note : undefined,
    evidenceCount: evidence,
    verified: typeof raw.verified_by === 'string' && typeof raw.verified_at === 'string',
    extra: extraOf(raw),
    body: complete ? parsed.body : parsed.body.slice(0, MAX_BODY_CHARS),
    abs
  };
}

async function listMarkdown(fs, path, dir, depth = 0) {
  if (depth > 4) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    // `branches` holds other branches' pages; the app points VOCS_MEMORY_BRANCH_ROOT at the one slice.
    if (entry.name.startsWith('_') || entry.name.startsWith('.') || entry.name === 'branches') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMarkdown(fs, path, abs, depth + 1)));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(abs);
  }
  return out;
}

// A selected project root may itself be an alias; repo-controlled descendants may not follow
// links. When used standalone without a project root, the supplied wiki's parent is that anchor.
async function unlinkedWikiPath(fs, path, base, target) {
  let current = path.resolve(base);
  const rel = path.relative(current, target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return false;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  }
  return true;
}

function pageInSlice(page, branch) {
  return page && (branch ? page.scope === 'branch' && page.branch === branch : page.scope === 'repo');
}

export async function loadPages({ root, branchRoot, projectRoot, branch }) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const base = projectRoot ?? path.dirname(path.resolve(root));
  const byId = new Map();
  for (const dir of [root, branch && branchRoot].filter(Boolean)) {
    if (!(await unlinkedWikiPath(fs, path, base, dir))) continue;
    for (const abs of await listMarkdown(fs, path, dir)) {
      try {
        const page = toPage(await fs.readFile(abs, 'utf8'), abs);
        if (pageInSlice(page, dir === branchRoot ? branch : null) && byId.size < MAX_PAGES) byId.set(page.id, page);
      } catch {
        /* an unreadable page is not a reason to fail a tool call */
      }
    }
  }
  return [...byId.values()];
}

export function servable(page) {
  return page.status === 'current' || page.status === 'uncertain';
}

function authorityOf(page) {
  if (isHumanAuthored(page)) return 2;
  if (page.status === 'current') return 3;
  if (page.status === 'uncertain' || page.status === 'deprecated') return 4;
  return 5;
}

/** A page a person reviewed or wrote: an agent may add evidence to it, never change what it says. */
function isHumanAuthored(page) {
  return page.reviewState === 'reviewed' || page.updatedBy === 'human' || (typeof page.updatedBy === 'string' && page.updatedBy.startsWith('human:'));
}

function authorityLabel(page) {
  if (authorityOf(page) <= 2) return 'human-reviewed';
  if (page.status === 'current' && page.verified) return 'verified';
  if (page.status === 'current') return 'accepted';
  if (page.status === 'uncertain') return 'uncertain';
  if (page.status === 'deprecated') return 'deprecated';
  if (page.status === 'superseded') return 'superseded';
  return 'proposed';
}

function tokenize(query) {
  return [...new Set(String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1))].slice(0, 8);
}

function occur(haystack, term) {
  if (!haystack) return 0;
  const hay = String(haystack).toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(term, from);
    if (at < 0) break;
    count++;
    from = at + term.length;
    if (count > 8) break;
  }
  return count;
}

function snippet(body, terms) {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  const lower = flat.toLowerCase();
  let at = -1;
  let term = terms[0] ?? '';
  for (const t of terms) {
    const found = lower.indexOf(t);
    if (found >= 0) {
      at = found;
      term = t;
      break;
    }
  }
  if (at < 0) return flat.slice(0, MAX_SNIPPET);
  const start = Math.max(0, at - 70);
  const end = Math.min(flat.length, at + 110);
  return `${start > 0 ? '…' : ''}${flat.slice(start, at)}\u0001${flat.slice(at, at + term.length)}\u0002${flat.slice(at + term.length, end)}${end < flat.length ? '…' : ''}`;
}

export function searchPages(pages, query, { limit = 12, includeHistorical = false, graph } = {}) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const out = [];
  for (const page of pages) {
    if (!includeHistorical && !servable(page)) continue;
    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      const total =
        occur(page.id, term) * 6 + occur(page.title, term) * 6 + occur(page.keywords.join(' '), term) * 4 + occur(page.claim ?? '', term) * 3 + Math.min(occur(page.body, term), 5);
      if (total === 0) matchedAll = false;
      score += total;
    }
    if (!matchedAll || score <= 0) continue;
    score += Math.max(0, 4 - authorityOf(page));
    if (page.status === 'uncertain') score -= 1;
    out.push({ page, score, snippet: snippet(page.body, terms) });
  }
  const ranked = out.sort((a, b) => b.score - a.score);
  // Graph-aware recall: a page linked to the strongest matches surfaces even when it shares no
  // query terms, which is what labels and relations are for.
  const boost = expandQuery(graph ?? buildGraph(pages), ranked.slice(0, MAX_SEARCH_SEEDS).map((r) => r.page.id), GRAPH_HOPS, GRAPH_DECAY);
  if (boost.size) {
    const matched = new Set(out.map((r) => r.page.id));
    for (const [id, value] of boost) {
      if (matched.has(id)) continue;
      const page = pages.find((p) => p.id === id);
      if (!page || (!includeHistorical && !servable(page))) continue;
      out.push({ page, score: value * 4 + Math.max(0, 4 - authorityOf(page)) });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.min(limit, 40));
}

function summaryOf({ page, score, snippet: text }, degrees) {
  const degree = degrees?.get(page.id);
  return {
    id: page.id,
    title: page.title,
    kind: page.kind,
    status: page.status,
    authority: authorityLabel(page),
    scope: page.scope,
    ...(page.branch ? { branch: page.branch } : {}),
    ...(page.claim ? { claim: page.claim } : {}),
    keywords: page.keywords,
    labels: page.labels,
    ...(degree !== undefined ? { degree } : {}),
    ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
    ...(page.evidenceCount !== undefined ? { evidenceCount: page.evidenceCount } : {}),
    ...(text ? { snippet: text } : {}),
    ...(score !== undefined ? { score: Math.round(score * 10) / 10 } : {})
  };
}

/* ─────────────────────────── relation graph ────────────────────────────── */

/** `[[page-id]]`, `[[page-id|label]]` and a relative markdown link are all edges. */
function wikilinkIds(body) {
  const out = [];
  const wiki = /\[\[([a-z0-9][a-z0-9/_-]*)(?:\|[^\]]*)?\]\]/g;
  let match;
  while ((match = wiki.exec(body))) out.push(match[1]);
  const markdown = /\]\(\.?\/?([a-z0-9][a-z0-9/_-]*)\.md\)/g;
  while ((match = markdown.exec(body))) out.push(match[1]);
  return out;
}

/** Links every member of a group to its next few peers, so a popular label stays cheap. */
function groupEdges(ids, type, weight, add) {
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length && j <= i + 8; j++) add(unique[i], unique[j], type, weight);
  }
}

/** Mirrors buildKnowledgeGraph in src/shared/knowledge.ts over the flat page shape used here. */
export function buildGraph(pages) {
  const known = new Set(pages.map((p) => p.id));
  const edges = new Map();
  const add = (from, to, type, weight) => {
    if (from === to || !known.has(from) || !known.has(to)) return;
    const key = `${from}\u0000${to}\u0000${type}`;
    const existing = edges.get(key);
    if (existing) existing.weight = Math.max(existing.weight, weight);
    else edges.set(key, { from, to, type, weight });
  };
  const byAnchor = new Map();
  const byLabel = new Map();
  for (const page of pages) {
    for (const id of page.related) add(page.id, id, 'related', 2);
    for (const id of page.supersedes) add(page.id, id, 'supersedes', 3);
    for (const id of page.contradicts) add(page.id, id, 'contradicts', 3);
    for (const id of wikilinkIds(page.body)) add(page.id, id, 'link', 1);
    for (const anchor of page.anchors) {
      const key = anchor.file.replace(/\\/g, '/');
      const group = byAnchor.get(key);
      if (group) group.push(page.id);
      else byAnchor.set(key, [page.id]);
    }
    for (const label of page.labels) {
      const group = byLabel.get(label);
      if (group) group.push(page.id);
      else byLabel.set(label, [page.id]);
    }
  }
  for (const ids of byAnchor.values()) groupEdges(ids, 'anchor', 1, add);
  for (const ids of byLabel.values()) groupEdges(ids, 'label', 1, add);
  const adjacency = new Map();
  for (const edge of edges.values()) {
    adjacency.set(edge.from, (adjacency.get(edge.from) ?? 0) + 1);
    adjacency.set(edge.to, (adjacency.get(edge.to) ?? 0) + 1);
  }
  return {
    builtAt: new Date().toISOString(),
    nodes: pages.map((p) => ({ id: p.id, kind: p.kind, status: p.status, labels: p.labels, degree: adjacency.get(p.id) ?? 0 })),
    edges: [...edges.values()]
  };
}

/** Mirrors expandKnowledgeQuery: a BFS whose contribution decays with distance. */
export function expandQuery(graph, seeds, hops = 2, decay = 0.5) {
  const neighbours = new Map();
  const push = (id, entry) => {
    const group = neighbours.get(id);
    if (group) group.push(entry);
    else neighbours.set(id, [entry]);
  };
  for (const edge of graph.edges) {
    push(edge.from, { id: edge.to, weight: edge.weight });
    push(edge.to, { id: edge.from, weight: edge.weight });
  }
  const seen = new Set(seeds);
  const boost = new Map();
  let frontier = [...new Set(seeds)].filter((id) => neighbours.has(id));
  for (let hop = 1; hop <= hops && frontier.length; hop++) {
    const next = [];
    for (const id of frontier) {
      for (const { id: other, weight } of neighbours.get(id) ?? []) {
        if (seen.has(other)) continue;
        seen.add(other);
        boost.set(other, (boost.get(other) ?? 0) + weight * decay ** (hop - 1));
        next.push(other);
      }
    }
    frontier = next;
  }
  return boost;
}

/* ────────────────────────────── proposing ──────────────────────────────── */

function slugify(title) {
  return (
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'note'
  );
}

function claimKey(claim) {
  const text = String(claim)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function yamlLine(key, value) {
  return `${key}: ${quoteValue(value)}`;
}

function quoteValue(value) {
  const text = String(value);
  return /^[A-Za-z0-9 .:/_#@+-]+$/.test(text) ? text : JSON.stringify(text);
}

export function serializeProposal(meta, body) {
  const lines = ['---', yamlLine('id', meta.id), yamlLine('title', meta.title), `kind: ${meta.kind}`, 'status: proposed', `scope: ${meta.scope}`];
  if (meta.branch) lines.push(yamlLine('branch', meta.branch));
  if (meta.claim) lines.push(yamlLine('claim', meta.claim));
  if (meta.targetPageId) lines.push(yamlLine('target_page', meta.targetPageId));
  if (meta.keywords.length) lines.push(`keywords: [${meta.keywords.map((k) => quoteValue(k)).join(', ')}]`);
  if (meta.sources.length) {
    lines.push('sources:');
    for (const s of meta.sources) {
      lines.push(`  - type: ${s.type}`, `    ref: ${/^[A-Za-z0-9 .:/_#@+-]+$/.test(s.ref) ? s.ref : JSON.stringify(s.ref)}`);
      if (s.note) lines.push(`    note: ${/^[A-Za-z0-9 .:/_#@+-]+$/.test(s.note) ? s.note : JSON.stringify(s.note)}`);
    }
  }
  if (meta.anchors.length) {
    lines.push('anchors:');
    for (const a of meta.anchors) {
      lines.push(`  - file: ${/^[A-Za-z0-9 .:/_#@+-]+$/.test(a.file) ? a.file : JSON.stringify(a.file)}`);
      if (a.symbol) lines.push(`    symbol: ${/^[A-Za-z0-9 .:/_#@+-]+$/.test(a.symbol) ? a.symbol : JSON.stringify(a.symbol)}`);
    }
  }
  lines.push(`created_at: ${meta.createdAt}`, `updated_at: ${meta.createdAt}`, `updated_by: ${meta.origin}`, '---', '');
  return `${lines.join('\n')}${String(body).replace(/\s+$/, '')}\n`;
}

/** Keeps every distinct source/anchor when a page is updated rather than dropping the old ones. */
function mergeSources(a, b) {
  const out = [];
  const seen = new Set();
  for (const source of [...a, ...b]) {
    const key = `${source.type}\u0000${source.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out.slice(0, 24);
}

function mergeAnchors(a, b) {
  const out = [];
  const seen = new Set();
  for (const anchor of [...a, ...b]) {
    const key = `${anchor.file}\u0000${anchor.symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(anchor);
  }
  return out.slice(0, 24);
}

/** Writes a current page the app's own parser reads back; `labels` is the graph's grouping key. */
export function serializePage(meta, body) {
  const lines = ['---', yamlLine('id', meta.id), yamlLine('title', meta.title), `kind: ${meta.kind}`, `status: ${meta.keepStatus ?? 'current'}`, `scope: ${meta.scope}`];
  if (meta.branch) lines.push(yamlLine('branch', meta.branch));
  if (meta.confidence) lines.push(`confidence: ${meta.confidence}`);
  if (meta.claim) lines.push(yamlLine('claim', meta.claim));
  if (meta.keywords.length) lines.push(`keywords: [${meta.keywords.map((k) => quoteValue(k)).join(', ')}]`);
  if (meta.labels.length) lines.push(`labels: [${meta.labels.map((l) => quoteValue(l)).join(', ')}]`);
  if (meta.sources.length) {
    lines.push('sources:');
    for (const s of meta.sources) {
      lines.push(`  - type: ${s.type}`, `    ref: ${quoteValue(s.ref)}`);
      if (s.note) lines.push(`    note: ${quoteValue(s.note)}`);
      if (s.revision) lines.push(`    revision: ${quoteValue(s.revision)}`);
    }
  }
  if (meta.anchors.length) {
    lines.push('anchors:');
    for (const a of meta.anchors) {
      lines.push(`  - file: ${quoteValue(a.file)}`);
      if (a.symbol) lines.push(`    symbol: ${quoteValue(a.symbol)}`);
    }
  }
  if (meta.related?.length) lines.push(`related: [${meta.related.map((v) => quoteValue(v)).join(', ')}]`);
  if (meta.supersedes?.length) lines.push(`supersedes: [${meta.supersedes.map((v) => quoteValue(v)).join(', ')}]`);
  if (meta.contradicts?.length) lines.push(`contradicts: [${meta.contradicts.map((v) => quoteValue(v)).join(', ')}]`);
  if (meta.supersededBy) lines.push(yamlLine('superseded_by', meta.supersededBy));
  if (meta.reviewState) lines.push(yamlLine('review_state', meta.reviewState));
  if (meta.reviewedBy) lines.push(yamlLine('reviewed_by', meta.reviewedBy));
  if (meta.reviewedAt) lines.push(yamlLine('reviewed_at', meta.reviewedAt));
  if (meta.reviewNote) lines.push(yamlLine('review_note', meta.reviewNote));
  if (meta.evidenceCount !== undefined) lines.push(`evidence_count: ${meta.evidenceCount}`);
  lines.push(`created_at: ${meta.createdAt}`, `updated_at: ${meta.updatedAt}`, `updated_by: ${quoteValue(meta.updatedBy)}`);
  lines.push(...extraLines(meta.extra), '---', '');
  return `${lines.join('\n')}${String(body).replace(/\s+$/, '')}\n`;
}

/* ──────────────────────────────── tools ────────────────────────────────── */

const TOOLS = [
  {
    name: 'knowledge_search',
    description:
      'Search this project\'s curated knowledge wiki (architecture intent, decisions, conventions, gotchas, testing philosophy). Returns ranked page summaries with an id you can pass to knowledge_read. Pages carry labels and retrieval walks their relation graph, so a page linked only by a label or anchor can surface even without matching every query term. Use before assuming how this project is meant to work, and before changing an invariant.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words that appear in the page (all terms must match).' },
        limit: { type: 'integer', minimum: 1, description: 'Max results (default 12).' },
        include_historical: { type: 'boolean', description: 'Include superseded/deprecated pages.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'knowledge_read',
    description: 'Read one project knowledge page by id: full markdown plus provenance (sources, GitNexus anchors, status and authority).',
    inputSchema: { type: 'object', properties: { page: { type: 'string', description: 'Page id from knowledge_search, e.g. "conventions/harness-lifecycle".' } }, required: ['page'], additionalProperties: false }
  },
  {
    name: 'knowledge_related',
    description: 'Pages related to one page or anchor path, in either direction, with the edge that connects them (related, supersedes, contradicts, anchor, label or link).',
    inputSchema: { type: 'object', properties: { page: { type: 'string', description: 'Page id.' }, path: { type: 'string', description: 'Repo-relative file path an anchor names.' } }, additionalProperties: false }
  },
  {
    name: 'knowledge_propose',
    description:
      'Record a durable project finding with its evidence. A new claim is saved as accepted knowledge, not human-reviewed or verified. A human-reviewed page is protected and a tombstoned claim is refused. If a generated id already contains a different claim, choose a different title for a new page or pass page_id for an intentional update.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        claim: { type: 'string', description: 'One sentence stating what is true.' },
        body: { type: 'string', description: 'Markdown: the claim, the rationale, and how to apply it.' },
        kind: { type: 'string', enum: KINDS },
        page_id: { type: 'string', description: 'Existing page id this updates, when there is one.' },
        keywords: { type: 'array', items: { type: 'string' } },
        labels: { type: 'array', items: { type: 'string' }, description: 'Short normalized tags that group related pages, e.g. "pty" or "auth".' },
        sources: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: SOURCE_TYPES }, ref: { type: 'string' }, note: { type: 'string' } }, required: ['type', 'ref'] } },
        anchors: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, symbol: { type: 'string' } }, required: ['file'] } }
      },
      required: ['title', 'claim', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'knowledge_status',
    description: 'How much curated knowledge this project has, its labels and relation graph, and where the wiki lives.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'session_history_search',
    description:
      'Search what happened in past coding sessions on this project (episodic memory): earlier attempts, failures, debugging discoveries and outcomes. Use it before re-trying an approach. Results are past events, not project truth — use knowledge_search for what must stay true.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for in past transcripts (all terms must match).' },
        limit: { type: 'integer', minimum: 1, description: 'Max results (default 6, max 20).' },
        include_archived: { type: 'boolean', description: 'Also search archived sessions.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  }
];

/**
 * Tools answered only by the app's intelligence gateway: they need what this script cannot hold —
 * the project registry, the memory ledger, collection grants and the user's review. Listed only
 * when the app handed this session a gateway.
 */
const GATEWAY_TOOLS = [
  {
    name: 'intelligence_search',
    description:
      'One question across every source this session may read: the project wiki, memory records, past sessions of this project, the optional graph index and, with scope "collection", what this project\'s collections share. Natural-language questions work. Every result names its provider, project, authority, revision and freshness; results marked historical are what happened, not what is true now. For current code structure (callers, impact) use GitNexus instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question or the words to look for.' },
        scope: { type: 'string', enum: ['project', 'collection'], description: 'project (default) stays inside this project; collection adds what its collections share.' },
        sources: { type: 'array', minItems: 1, items: { type: 'string', enum: ['wiki', 'memory', 'history', 'graph', 'collection'] }, description: 'Restrict to these sources (default: all permitted sources).' },
        limit: { type: 'integer', minimum: 1, description: 'Max results (default 12, max 40).' },
        include_historical: { type: 'boolean', description: 'Include superseded pages, expired records and archived sessions.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'intelligence_trace',
    description:
      'How two things are related, step by step with the relation behind each step. Give two wiki page ids to trace the wiki\'s relation graph, or one to list its relations. When the project opted into the Graphify index, names of code or document nodes are traced there, with the indexed revision and whether it is stale.',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'A wiki page id, or a graph node id or label.' }, to: { type: 'string', description: 'Optional second endpoint; omit to list the relations of `from`.' } }, required: ['from'], additionalProperties: false }
  },
  {
    name: 'context_compile',
    description:
      'A bounded, cited context packet for one task or question: current knowledge, history (labelled as history), graph references, conflicts and missing evidence, inside a token budget. Use it at the start of a task instead of several separate searches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The task or question.' },
        budget_tokens: { type: 'integer', minimum: 1, description: 'Token budget for the packet (default 1500, max 6000).' },
        scope: { type: 'string', enum: ['project', 'collection'] }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_recall',
    description:
      'Episodes, lessons, procedures and preferences recorded for this project, plus matching excerpts from its past sessions: what was tried, what failed, what fixed it. Records that are not servable are unverified recollection — confirm against the code before acting. Omit the query to list the most recent records.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall; natural language works.' },
        types: { type: 'array', minItems: 1, items: { type: 'string', enum: ['episodic', 'semantic', 'procedural', 'preference'] } },
        limit: { type: 'integer', minimum: 1, description: 'Max records (default 8, max 30).' },
        include_unverified: { type: 'boolean', description: 'Include captured and candidate records (default true).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'knowledge_record',
    description:
      'Record sourced knowledge with its memory type. Semantic (a fact or decision) and procedural (a way of working) go to the project wiki; episodic (what was attempted and what happened) goes to memory. Cite real files or commits as evidence, not as proof of a claim. A human-reviewed page is protected; conflicting claims require a human decision.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        claim: { type: 'string', description: 'One sentence stating what is true or what happened.' },
        body: { type: 'string', description: 'Markdown: rationale and how to apply it. Required for semantic and procedural.' },
        memory_type: { type: 'string', enum: ['semantic', 'procedural', 'episodic'], description: 'Default semantic.' },
        kind: { type: 'string', description: `Wiki kind (${KINDS.join(', ')}) for semantic/procedural; attempt, failure, fix, lesson or procedure for episodic.` },
        scope: { type: 'string', enum: ['project', 'branch'], description: 'branch keeps it to this session\'s branch (default project).' },
        page_id: { type: 'string', description: 'Existing wiki page id this intentionally updates.' },
        keywords: { type: 'array', items: { type: 'string' } },
        labels: { type: 'array', items: { type: 'string' } },
        sources: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: SOURCE_TYPES }, ref: { type: 'string' }, note: { type: 'string' } }, required: ['type', 'ref'] } },
        anchors: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, symbol: { type: 'string' } }, required: ['file'] } }
      },
      required: ['title', 'claim'],
      additionalProperties: false
    }
  },
  {
    name: 'knowledge_promote',
    description:
      'Ask for a wiki page or a memory record to be shared beyond this project: into one of its collections, or into the user\'s personal memory. This only files a request — nothing leaves the project until the user approves it in the Knowledge panel.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Wiki page id to promote.' },
        record: { type: 'string', description: 'Memory record id to promote (from memory_recall).' },
        to: { type: 'string', enum: ['collection', 'personal'] },
        collection: { type: 'string', description: 'Collection name or id; optional when the project is in exactly one.' },
        reason: { type: 'string', description: 'Why it is worth sharing.' }
      },
      required: ['to'],
      oneOf: [{ required: ['page'] }, { required: ['record'] }],
      additionalProperties: false
    }
  },
  {
    name: 'memory_forget',
    description:
      'Delete one memory record this session\'s agent recorded in this project, with its search index entry; the same statement is not re-captured. Records a person wrote, verified or shared can only be removed by the user.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Memory record id from memory_recall.' } }, required: ['id'], additionalProperties: false }
  }
];
const GATEWAY_ONLY = new Set(GATEWAY_TOOLS.map((tool) => tool.name));

/** Tools that only read: the app's native harness may run these without a prompt, and plan mode keeps them. */
const READ_ONLY_TOOLS = new Set(['knowledge_search', 'knowledge_read', 'knowledge_related', 'knowledge_status', 'session_history_search', 'intelligence_search', 'intelligence_trace', 'context_compile', 'memory_recall']);
const DESTRUCTIVE_TOOLS = new Set(['knowledge_propose', 'knowledge_record', 'memory_forget']);
for (const tool of [...TOOLS, ...GATEWAY_TOOLS]) {
  const readOnlyHint = READ_ONLY_TOOLS.has(tool.name);
  tool.annotations = { title: tool.name, readOnlyHint, destructiveHint: DESTRUCTIVE_TOOLS.has(tool.name), openWorldHint: false, ...(!readOnlyHint ? { idempotentHint: false } : {}) };
  for (const field of ['sources', 'anchors']) {
    const items = tool.inputSchema.properties[field]?.items;
    if (items?.type === 'object') items.additionalProperties = false;
  }
}

/** The tools this server lists: the six originals, plus the gateway's seven when one is configured. */
export function memoryToolList(hasGateway) {
  return hasGateway ? [...TOOLS, ...GATEWAY_TOOLS] : TOOLS;
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toolResult(result) {
  return isObject(result) && Object.keys(result).every((key) => key === 'content' || key === 'isError')
    && (result.isError === undefined || typeof result.isError === 'boolean')
    && Array.isArray(result.content) && result.content.every((item) => isObject(item) && item.type === 'text' && typeof item.text === 'string' && Object.keys(item).length === 2);
}

/** A configured client has no local disk fallback, including on denial, I/O failure or timeout. */
export function createGatewayClient({ url, token, timeoutMs = 90_000 }) {
  const port = typeof url === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/call$/.exec(url)?.[1];
  if (!port || Number(port) > 65535 || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('Invalid intelligence gateway configuration.');
  }
  const unavailable = () => errorResult('The intelligence gateway is unavailable. Restart the session to reconnect.');
  return async function viaGateway(name, args, cancelled) {
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = cancelled ? AbortSignal.any([cancelled, timeout]) : timeout;
      const body = JSON.stringify({ tool: name, arguments: args });
      // Do not follow redirects, use a proxy, or resolve an attacker-controlled DNS name with a bearer.
      const response = await new Promise((resolve, reject) => {
        const req = request({
          host: '127.0.0.1', port, path: '/call', method: 'POST', agent: false, signal,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token}` }
        }, resolve);
        req.on('error', reject);
        req.end(body);
      });
      if (response.statusCode !== 200 || response.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
        response.destroy();
        return response.statusCode === 401 || response.statusCode === 403
          ? errorResult('The intelligence gateway denied this call. Restart the session to renew its authorization.')
          : unavailable();
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 4_000_000) return unavailable();
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return toolResult(payload?.result) ? payload.result : unavailable();
    } catch {
      // Neither errors from HTTP nor the endpoint itself belong in MCP diagnostics.
      return unavailable();
    }
  };
}

function textResult(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createMemoryTools({ root, branchRoot, branch, userData = null, projectRoot = null, gateway = null }) {
  let searchDb = undefined;
  let searchError = null;
  /** Opens search.db read-only on first use; the app's index is the only source of session history. */
  const ensureSearchDb = async () => {
    if (searchDb !== undefined) return searchDb;
    if (!userData) {
      searchError = 'the app did not provide its data directory';
      searchDb = null;
      return searchDb;
    }
    try {
      const sqlite = await import('node:sqlite');
      const nodePath = await import('node:path');
      searchDb = new sqlite.DatabaseSync(nodePath.join(userData, 'search.db'), { readOnly: true });
    } catch (e) {
      searchError = e && e.message ? String(e.message) : String(e);
      searchDb = null;
    }
    return searchDb;
  };
  const sessionsIndex = async () => {
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    try {
      const parsed = JSON.parse(await fs.readFile(nodePath.join(userData, 'sessions.json'), 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  return async function call(name, args, signal) {
    signal?.throwIfAborted();
    if (gateway) return gateway(name, args, signal);
    if (GATEWAY_ONLY.has(name)) return errorResult(`${name} requires the intelligence gateway; this session started in standalone wiki mode.`);
    const pages = name === 'knowledge_propose' || name === 'session_history_search' ? [] : await loadPages({ root, branchRoot, projectRoot, branch });
    if (name === 'knowledge_search') {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query.trim()) return errorResult('knowledge_search needs a query.');
      const graph = buildGraph(pages);
      const degrees = new Map(graph.nodes.map((n) => [n.id, n.degree]));
      const results = searchPages(pages, query, { limit: Number(args.limit) || 12, includeHistorical: args.include_historical === true, graph });
      return textResult({ project: root, count: results.length, results: results.map((r) => summaryOf(r, degrees)) });
    }
    if (name === 'knowledge_read') {
      const id = typeof args.page === 'string' ? args.page : '';
      const page = pages.find((p) => p.id === id);
      if (!page) return errorResult(`No knowledge page "${id}". Use knowledge_search first.`);
      return textResult({
        id: page.id,
        title: page.title,
        kind: page.kind,
        status: page.status,
        authority: authorityLabel(page),
        scope: page.scope,
        ...(page.branch ? { branch: page.branch } : {}),
        ...(page.claim ? { claim: page.claim } : {}),
        keywords: page.keywords,
        labels: page.labels,
        ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
        ...(page.updatedBy ? { updatedBy: page.updatedBy } : {}),
        ...(page.evidenceCount !== undefined ? { evidenceCount: page.evidenceCount } : {}),
        sources: page.sources,
        anchors: page.anchors,
        ...(page.supersededBy ? { supersededBy: page.supersededBy } : {}),
        body: page.body
      });
    }
    if (name === 'knowledge_related') {
      const explicit = typeof args.page === 'string' ? pages.find((p) => p.id === args.page) : undefined;
      const pathArg = typeof args.path === 'string' ? args.path.replace(/\\/g, '/') : '';
      const matching = pathArg ? pages.filter((p) => p.anchors.some((a) => a.file.replace(/\\/g, '/') === pathArg) || p.sources.some((s) => s.ref.replace(/\\/g, '/') === pathArg)) : [];
      const base = explicit ?? matching[0];
      if (!base) return errorResult(`No page or anchor matched ${pathArg || '(no page given)'}.`);
      // Edges, not just the `related` field: a shared label or anchor connects two pages too.
      const best = new Map();
      for (const edge of buildGraph(pages).edges) {
        if (edge.from !== base.id && edge.to !== base.id) continue;
        const other = edge.from === base.id ? edge.to : edge.from;
        if (other === base.id) continue;
        const current = best.get(other);
        if (!current || edge.weight > current.weight) best.set(other, edge);
      }
      const byId = new Map(pages.map((p) => [p.id, p]));
      const related = [...best.entries()]
        .filter(([id]) => byId.has(id))
        .sort((a, b) => b[1].weight - a[1].weight)
        .map(([id, edge]) => ({ id, title: byId.get(id).title, edge: edge.type }));
      return textResult({ page: base.id, related });
    }
    if (name === 'knowledge_propose') {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const claim = typeof args.claim === 'string' ? args.claim.trim() : '';
      const body = typeof args.body === 'string' ? args.body.trim() : '';
      if (!title || !claim || !body) return errorResult('knowledge_propose needs a title, a claim and a body.');
      const requestedId = typeof args.page_id === 'string' && args.page_id.trim() ? args.page_id.trim() : '';
      if (requestedId && !isValidPageId(requestedId)) return errorResult(`"${requestedId}" is not a usable page id.`);
      const base = projectRoot ?? path.dirname(path.resolve(root));
      const assertUnlinked = async (target) => {
        if (!(await unlinkedWikiPath(fs, path, base, target))) throw new Error('Refusing to write through a linked wiki path.');
      };
      try {
        await assertUnlinked(root);
        signal?.throwIfAborted();
        return await withKnowledgeWriteLock(root, async () => {
          signal?.throwIfAborted();
          // Read only after acquiring the app/MCP mutex: a call-start snapshot is not a guard.
          const pages = await loadPages({ root, branchRoot, projectRoot, branch });
          let rejected = null;
          try {
            const tombstones = path.join(root, '_rejected.json');
            if (await unlinkedWikiPath(fs, path, base, tombstones)) rejected = JSON.parse(await fs.readFile(tombstones, 'utf8'));
          } catch {
            rejected = null;
          }
          if (sameRejectedKnowledgeClaim(rejected?.[claimKey(claim)]?.claim, claim)) {
            return textResult({ id: '', targetPageId: '', status: 'rejected', saved: false, rejected: true, note: 'This claim was rejected before and is tombstoned in _rejected.json; nothing was written.' });
          }
          const readForWrite = async (id) => {
            for (const dir of [branch && branchRoot, root].filter(Boolean)) {
              const file = path.join(dir, `${id}.md`);
              await assertUnlinked(file);
              try {
                const page = toPage(await fs.readFile(file, 'utf8'), file, true);
                if (!page || page.id !== id || !pageInSlice(page, dir === branchRoot ? branch : null)) throw new Error(`Cannot update invalid or out-of-scope knowledge page "${id}".`);
                return page;
              } catch (error) {
                if (error.code !== 'ENOENT') throw error;
              }
            }
            return null;
          };
          let existing = requestedId ? await readForWrite(requestedId) : pages.find((p) => sameKnowledgeClaim(p.claim, claim));
          const kind = KINDS.includes(args.kind) ? args.kind : existing?.kind ?? 'concept';
          const targetPageId = requestedId || existing?.id || `${kind}/${slugify(title)}`;
          if (!isValidPageId(targetPageId)) throw new Error(`"${targetPageId}" is not a usable page id.`);
          existing = await readForWrite(targetPageId);
          if (!requestedId && existing && !sameKnowledgeClaim(existing.claim, claim)) throw knowledgeCollision(targetPageId);
          // A page a person reviewed or wrote is never rewritten from here: the same claim adds its
          // evidence below and keeps the human's text; a different claim is the user's to decide.
          if (existing && isHumanAuthored(existing) && !sameKnowledgeClaim(existing.claim, claim)) {
            throw new Error(`Knowledge page "${targetPageId}" is human-reviewed and was not changed. A different claim needs the user's review: ask them to edit it in the Knowledge panel.`);
          }
          // New knowledge is repo-scoped; an existing branch page stays in its own slice.
          const scope = existing?.scope ?? 'repo';
          const pageBranch = scope === 'branch' ? existing?.branch ?? branch ?? undefined : undefined;
          const targetRoot = scope === 'branch' && branchRoot ? branchRoot : root;
          const file = path.join(targetRoot, `${targetPageId}.md`);
          await assertUnlinked(file);
          // Also protect files omitted by the bounded retrieval scan, and fail closed on damage.
          try {
            const current = toPage(await fs.readFile(file, 'utf8'), file, true);
            if (!current || current.id !== targetPageId || !pageInSlice(current, pageBranch)) throw new Error(`Cannot update invalid or out-of-scope knowledge page "${targetPageId}".`);
            if (!requestedId && !sameKnowledgeClaim(current.claim, claim)) throw knowledgeCollision(targetPageId);
            existing = current;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          const kept = !!existing && isHumanAuthored(existing);
          if (kept && !sameKnowledgeClaim(existing.claim, claim)) {
            throw new Error(`Knowledge page "${targetPageId}" is human-reviewed and was not changed. A different claim needs the user's review: ask them to edit it in the Knowledge panel.`);
          }
          const now = new Date().toISOString();
          // Verification was recorded against the old claim; a changed claim starts unverified.
          const extra = { ...(existing?.extra ?? {}) };
          if (existing && !sameKnowledgeClaim(existing.claim, claim)) for (const key of VERIFICATION_KEYS) delete extra[key];
          const meta = {
            ...existing,
            id: targetPageId,
            title: kept ? existing.title : title,
            kind: kept ? existing.kind : kind,
            ...(kept ? { keepStatus: existing.status } : {}),
            extra,
            scope,
            ...(pageBranch ? { branch: pageBranch } : {}),
            claim,
            keywords: [...new Set([...(existing?.keywords ?? []), ...list(args.keywords, 12)])].slice(0, 24),
            labels: normalizeLabels([...(existing?.labels ?? []), ...list(args.labels, 24)]),
            sources: mergeSources(existing?.sources ?? [], sourcesOf({ sources: Array.isArray(args.sources) ? args.sources : [] })),
            anchors: mergeAnchors(existing?.anchors ?? [], anchorsOf({ anchors: Array.isArray(args.anchors) ? args.anchors : [] })),
            related: existing?.related ?? [],
            supersedes: existing?.supersedes ?? [],
            contradicts: existing?.contradicts ?? [],
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            updatedBy: kept ? existing.updatedBy ?? 'human' : 'agent:mcp',
            evidenceCount: (existing?.evidenceCount ?? 0) + 1
          };
          signal?.throwIfAborted();
          await fs.mkdir(path.dirname(file), { recursive: true });
          signal?.throwIfAborted();
          await writeKnowledgeFileAtomic(file, serializePage(meta, kept ? existing.body : body));
          return textResult({
            id: targetPageId,
            targetPageId,
            status: 'current',
            saved: true,
            scope,
            note: kept
              ? `Page ${targetPageId} is human-reviewed: its text was kept and your sources were added as evidence.`
              : scope === 'branch'
                ? `Recorded in the project wiki, on branch ${pageBranch}.`
                : 'Recorded in the project wiki automatically.'
          });
        });
      } catch (error) {
        return errorResult(error.message ?? String(error));
      }
    }
    if (name === 'knowledge_status') {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      // Legacy proposal files may still be on disk; nothing writes there any more.
      let awaitingReview = 0;
      try {
        const proposals = path.join(root, '_proposals');
        if (await unlinkedWikiPath(fs, path, projectRoot ?? path.dirname(path.resolve(root)), proposals)) {
          awaitingReview = (await fs.readdir(proposals)).filter((f) => f.endsWith('.md')).length;
        }
      } catch {
        awaitingReview = 0;
      }
      const graph = buildGraph(pages);
      const labels = new Set();
      for (const page of pages) for (const label of page.labels) labels.add(label);
      const servableCount = pages.filter(servable).length;
      return textResult({
        wikiDir: root,
        branchWikiDir: branchRoot ?? null,
        pages: pages.length,
        servable: servableCount,
        labels: labels.size,
        graph: { nodes: graph.nodes.length, edges: graph.edges.length },
        awaitingReview,
        toolHint: servableCount ? 'Use knowledge_search before changing an invariant.' : 'No pages yet; knowledge_propose records durable findings in the wiki automatically.'
      });
    }
    if (name === 'session_history_search') {
      const query = typeof args.query === 'string' ? args.query : '';
      const match = ftsQuery(query);
      if (!match) return errorResult('session_history_search needs a query of at least two letters.');
      const db = await ensureSearchDb();
      if (!db) return textResult({ available: false, reason: `Session history is unavailable (${searchError ?? 'no index'}).` });
      // Fail closed: without a project to scope to, transcript recall from *every* project is
      // exactly the privacy boundary this tool exists to hold, so it serves nothing instead.
      if (!projectRoot) return textResult({ available: false, reason: 'Session history needs a project scope, which the app did not provide.' });
      const scope = new Map();
      for (const session of await sessionsIndex()) {
        if (!session || typeof session.id !== 'string') continue;
        const root = session.config && typeof session.config.projectRoot === 'string' ? session.config.projectRoot : null;
        // The same project boundary every other memory surface uses: no cross-project recall.
        if (root !== projectRoot) continue;
        if (session.archived === true && args.include_archived !== true) continue;
        scope.set(session.id, { title: typeof session.title === 'string' ? session.title : session.id });
      }
      if (!scope.size) return textResult({ available: true, projectRoot, count: 0, results: [], note: 'No sessions recorded for this project yet.' });
      const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 20);
      let rows = [];
      try {
        rows = db
          .prepare(
            `SELECT i.sessionId AS sessionId, i.itemId AS itemId, i.kind AS kind, i.ts AS ts, snippet(fts, 0, char(1), char(2), char(8230), 18) AS text
             FROM fts JOIN items i ON i.id = fts.rowid
             WHERE fts MATCH ?
             ORDER BY bm25(fts)
             LIMIT ?`
          )
          .all(match, Math.min(limit * 10, 300));
      } catch (e) {
        return errorResult(`Session history query failed: ${e && e.message ? e.message : String(e)}`);
      }
      const perSession = new Map();
      const results = [];
      for (const row of rows) {
        const session = scope.get(row.sessionId);
        if (!session) continue;
        const used = perSession.get(row.sessionId) ?? 0;
        if (used >= MAX_SESSION_HITS) continue;
        perSession.set(row.sessionId, used + 1);
        results.push({
          sessionId: row.sessionId,
          session: session.title,
          kind: row.kind,
          at: Number.isFinite(Number(row.ts)) ? new Date(Number(row.ts)).toISOString() : null,
          snippet: redactSecrets(row.text)
        });
        if (results.length >= limit) break;
      }
      return textResult({
        available: true,
        projectRoot,
        count: results.length,
        results,
        note: 'Episodic memory: what happened in past sessions on this project. Not project truth — use knowledge_search for that.'
      });
    }
    return errorResult(`Unknown tool ${name}`);
  };
}

/* ────────────────────────────── MCP loop ───────────────────────────────── */

export async function runMemoryServer({ input, output, root, branchRoot = null, branch = null, userData = null, projectRoot = null, gateway = null, log = () => {} } = {}) {
  if (!input || !output) throw new Error('runMemoryServer: input and output streams are required');
  if (!gateway && !root) throw new Error('runMemoryServer: a wiki root is required in standalone mode');
  const call = gateway ? createGatewayClient(gateway) : createMemoryTools({ root, branchRoot, branch, userData, projectRoot });
  const pending = new Map();
  let buffer = '';
  let closed = false;
  const write = (message) => {
    if (closed) return;
    try {
      const json = JSON.stringify(message);
      output.write(`${gateway ? json.replaceAll(gateway.token, '<redacted>') : json}\n`);
    } catch {
      /* the host is gone */
    }
  };
  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (message) => {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === 'notifications/cancelled') pending.get(params?.requestId)?.abort();
      return; // Notifications (including a tool call with no request id) cannot dispatch a tool.
    }
    if ((typeof id !== 'string' && !Number.isFinite(id)) || pending.has(id)) return;
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vocs-memory', version: '1.0.0' },
        instructions: gateway
          ? 'Project knowledge and memory. knowledge_search / knowledge_read: what this project means and what must stay true — search before changing an invariant. context_compile: one cited packet for a task. memory_recall and session_history_search: what was tried before. knowledge_record: record durable findings with their evidence. Results marked historical are past events, not present fact; AGENTS.md and the current code outrank everything here.'
          : 'Curated project knowledge: what this project means, why it is built this way, what must stay true. Search it before changing invariants; record durable findings with knowledge_propose, which writes to the wiki automatically.'
      });
      return;
    }
    if (method === 'ping') {
      respond(id, {});
      return;
    }
    if (method === 'tools/list') {
      respond(id, { tools: memoryToolList(!!gateway) });
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments === undefined ? {} : params.arguments;
      if (typeof name !== 'string' || !isObject(args)) return respondError(id, -32602, 'Expected a tool name and an arguments object');
      const controller = new AbortController();
      pending.set(id, controller);
      try {
        const result = await call(name, args, controller.signal);
        if (!controller.signal.aborted) respond(id, result);
      } catch (error) {
        if (!controller.signal.aborted) {
          log('knowledge MCP call failed');
          respond(id, errorResult(gateway ? 'The intelligence gateway call failed.' : error instanceof Error ? error.message : String(error)));
        }
      } finally {
        pending.delete(id);
      }
      return;
    }
    respondError(id, -32601, 'Method not found');
  };

  input.setEncoding?.('utf8');
  const onData = (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      void handle(message).catch(() => log('knowledge MCP handler failed'));
    }
  };
  await new Promise((resolve) => {
    const finish = () => {
      closed = true;
      input.off('data', onData);
      input.off('end', finish);
      input.off('close', finish);
      for (const controller of pending.values()) controller.abort();
      resolve();
    };
    input.once('end', finish);
    input.once('close', finish);
    input.on('data', onData);
    if (input.readableEnded || input.destroyed) finish();
  });
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const { VOCS_MEMORY_GATEWAY_URL: url, VOCS_MEMORY_GATEWAY_TOKEN: token } = process.env;
  // Presence, not truthiness: even an explicitly empty gateway variable must fail closed.
  const configured = url !== undefined || token !== undefined;
  try {
    await runMemoryServer({
      input: process.stdin,
      output: process.stdout,
      ...(configured ? { gateway: { url, token } } : {
        root: process.env.VOCS_MEMORY_ROOT,
        branchRoot: process.env.VOCS_MEMORY_BRANCH_ROOT || null,
        branch: process.env.VOCS_MEMORY_BRANCH || null,
        userData: process.env.VOCS_MEMORY_USER_DATA || null,
        projectRoot: process.env.VOCS_MEMORY_PROJECT_ROOT || null
      }),
      log: (message) => console.error(`vocs-memory: ${message}`)
    });
  } catch {
    console.error(configured ? 'vocs-memory: Invalid intelligence gateway configuration.' : 'vocs-memory: Could not start the standalone wiki server (VOCS_MEMORY_ROOT is required).');
    process.exitCode = 1;
  }
}
