#!/usr/bin/env node
/**
 * Layer 2 retrieval for coding harnesses: a dependency-free MCP stdio server over a project wiki.
 *
 * The app injects one copy per session through the same built-in machinery GitNexus uses
 * (src/main/mcp), with `VOCS_MEMORY_ROOT` pointing at the project's `.vocs-code/wiki` and, for a
 * worktree session, `VOCS_MEMORY_BRANCH_ROOT` at the checkout's own wiki. It reads only markdown:
 * no database, no network, no Electron.
 *
 * Tools are deliberately pull-based and narrow — search, read, related, propose, status — because
 * a wiki that is pasted into every prompt is just context bloat. `propose` writes durable knowledge
 * straight into the wiki (status: current, updated_by: agent:mcp); a claim tombstoned in
 * `_rejected.json` is refused instead. Pages carry labels, and retrieval walks the relation graph
 * derived from related / supersedes / contradicts / wikilinks / shared anchors / shared labels.
 *
 * The frontmatter subset here must stay in lockstep with src/shared/knowledge.ts. That pairing is
 * covered by tests/knowledge-mcp.test.ts, which writes with one side and reads with the other.
 */
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
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && ID_RE.test(value);
}

function sourcesOf(raw) {
  if (!Array.isArray(raw.sources)) return [];
  const out = [];
  for (const entry of raw.sources) {
    if (!entry || typeof entry !== 'object') continue;
    const ref = typeof entry.ref === 'string' ? entry.ref.trim() : '';
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (!ref || !SOURCE_TYPES.includes(type)) continue;
    out.push({ type, ref, ...(entry.note ? { note: String(entry.note) } : {}) });
  }
  return out;
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

export async function loadPages({ root, branchRoot }) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const byId = new Map();
  for (const dir of [root, branchRoot].filter(Boolean)) {
    for (const abs of await listMarkdown(fs, path, dir)) {
      try {
        const page = toPage(await fs.readFile(abs, 'utf8'), abs);
        if (page && byId.size < MAX_PAGES) byId.set(page.id, page);
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
  if (page.reviewState === 'reviewed' || page.updatedBy === 'human') return 2;
  if (page.status === 'current') return 3;
  if (page.status === 'uncertain' || page.status === 'deprecated') return 4;
  return 5;
}

function authorityLabel(page) {
  if (authorityOf(page) <= 2) return 'human-reviewed';
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
  const lines = ['---', yamlLine('id', meta.id), yamlLine('title', meta.title), `kind: ${meta.kind}`, 'status: current', `scope: ${meta.scope}`];
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
  lines.push(`created_at: ${meta.createdAt}`, `updated_at: ${meta.updatedAt}`, `updated_by: ${quoteValue(meta.updatedBy)}`, '---', '');
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
        limit: { type: 'number', description: 'Max results (default 12).' },
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
      'Record durable project knowledge discovered while working (a convention, gotcha, decision or invariant) in the project wiki. This writes immediately: nothing is queued for human review, so record only claims that stay true beyond the current task and are evidenced by files, a command output or a commit. A claim tombstoned in _rejected.json is refused. If a generated id already contains a different claim, choose a different title for a new page or pass page_id for an intentional update.',
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
        limit: { type: 'number', description: 'Max results (default 6, max 20).' },
        include_archived: { type: 'boolean', description: 'Also search archived sessions.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  }
];

/** Tools that only read: the app's native harness may run these without a prompt, and plan mode keeps them. */
const READ_ONLY_TOOLS = new Set(['knowledge_search', 'knowledge_read', 'knowledge_related', 'knowledge_status', 'session_history_search']);
for (const tool of TOOLS) tool.annotations = { readOnlyHint: READ_ONLY_TOOLS.has(tool.name), title: tool.name };

function textResult(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createMemoryTools({ root, branchRoot, branch, userData = null, projectRoot = null }) {
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

  return async function call(name, args) {
    const pages = name === 'knowledge_propose' ? [] : await loadPages({ root, branchRoot });
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
      try {
        return await withKnowledgeWriteLock(root, async () => {
          // Read only after acquiring the app/MCP mutex: a call-start snapshot is not a guard.
          const pages = await loadPages({ root, branchRoot });
          let rejected = null;
          try {
            rejected = JSON.parse(await fs.readFile(path.join(root, '_rejected.json'), 'utf8'));
          } catch {
            rejected = null;
          }
          if (sameRejectedKnowledgeClaim(rejected?.[claimKey(claim)]?.claim, claim)) {
            return textResult({ id: '', targetPageId: '', status: 'rejected', saved: false, rejected: true, note: 'This claim was rejected before and is tombstoned in _rejected.json; nothing was written.' });
          }
          const readForWrite = async (id) => {
            for (const dir of [branchRoot, root].filter(Boolean)) {
              const file = path.join(dir, `${id}.md`);
              try {
                const page = toPage(await fs.readFile(file, 'utf8'), file, true);
                if (!page || page.id !== id) throw new Error(`Cannot update invalid knowledge page "${id}".`);
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
          // New knowledge is repo-scoped; an existing branch page stays in its own slice.
          const scope = existing?.scope ?? 'repo';
          const pageBranch = scope === 'branch' ? existing?.branch ?? branch ?? undefined : undefined;
          const targetRoot = scope === 'branch' && branchRoot ? branchRoot : root;
          const file = path.join(targetRoot, `${targetPageId}.md`);
          // Also protect files omitted by the bounded retrieval scan, and fail closed on damage.
          try {
            const current = toPage(await fs.readFile(file, 'utf8'), file, true);
            if (!current || current.id !== targetPageId) throw new Error(`Cannot update invalid knowledge page "${targetPageId}".`);
            if (!requestedId && !sameKnowledgeClaim(current.claim, claim)) throw knowledgeCollision(targetPageId);
            existing = current;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          const now = new Date().toISOString();
          const meta = {
            ...existing,
            id: targetPageId,
            title,
            kind,
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
            updatedBy: 'agent:mcp',
            evidenceCount: (existing?.evidenceCount ?? 0) + 1
          };
          await fs.mkdir(path.dirname(file), { recursive: true });
          await writeKnowledgeFileAtomic(file, serializePage(meta, body));
          return textResult({
            id: targetPageId,
            targetPageId,
            status: 'current',
            saved: true,
            scope,
            note: scope === 'branch' ? `Recorded in the project wiki, on branch ${pageBranch}.` : 'Recorded in the project wiki automatically.'
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
        awaitingReview = (await fs.readdir(path.join(root, '_proposals'))).filter((f) => f.endsWith('.md')).length;
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

export async function runMemoryServer({ input, output, root, branchRoot = null, branch = null, userData = null, projectRoot = null, log = () => {} } = {}) {
  if (!input || !output) throw new Error('runMemoryServer: input and output streams are required');
  if (!root) throw new Error('runMemoryServer: a wiki root is required');
  const call = createMemoryTools({ root, branchRoot, branch, userData, projectRoot });
  let buffer = '';
  const write = (message) => {
    try {
      output.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* the host is gone */
    }
  };
  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (message) => {
    if (!message || typeof message !== 'object') return;
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vocs-memory', version: '1.0.0' },
        instructions: 'Curated project knowledge: what this project means, why it is built this way, what must stay true. Search it before changing invariants; record durable findings with knowledge_propose, which writes to the wiki automatically.'
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
    if (method === 'ping') {
      if (isRequest) respond(id, {});
      return;
    }
    if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const name = typeof params?.name === 'string' ? params.name : '';
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      try {
        respond(id, await call(name, args));
      } catch (error) {
        log(`knowledge MCP ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
        respond(id, errorResult(error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (isRequest) respondError(id, -32601, `Method not found: ${method}`);
  };

  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
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
      void handle(message).catch((error) => log(`knowledge MCP handler failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
  await new Promise((resolve) => input.on('end', resolve));
  await new Promise((resolve) => input.on('close', resolve));
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const root = process.env.VOCS_MEMORY_ROOT;
  if (!root) {
    console.error('vocs-memory: VOCS_MEMORY_ROOT is not set');
    process.exit(1);
  }
  await runMemoryServer({
    input: process.stdin,
    output: process.stdout,
    root,
    branchRoot: process.env.VOCS_MEMORY_BRANCH_ROOT || null,
    branch: process.env.VOCS_MEMORY_BRANCH || null,
    userData: process.env.VOCS_MEMORY_USER_DATA || null,
    projectRoot: process.env.VOCS_MEMORY_PROJECT_ROOT || null,
    log: (message) => console.error(`vocs-memory: ${message}`)
  });
}
