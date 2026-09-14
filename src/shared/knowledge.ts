/**
 * Layer 2 project knowledge: page schema, frontmatter codec and the pure helpers every process
 * shares (main, the knowledge MCP server, the renderer and tests).
 *
 * Markdown is the durable source of truth. Every field is optional except identity, because
 * provenance is recorded when it is known and never invented to fill a template. Nothing here
 * describes current code structure — that is GitNexus's job; a page may only *point* at it.
 *
 * No runtime dependencies and no imports outside this folder: the stdio MCP server script loads
 * this file too.
 */

/** Where a project's working wiki lives, relative to a project root or worktree. */
export const KNOWLEDGE_DIR = '.vocs-code/wiki';
/** Where reviewed pages are copied by an explicit Publish (a tracked path in the user's repo). */
export const KNOWLEDGE_PUBLISH_DIR = 'docs/wiki';
/** Reserved subdirectories of a wiki. Pages never live under a leading underscore. */
export const KNOWLEDGE_PROPOSALS_DIR = '_proposals';
export const KNOWLEDGE_OBSERVATIONS_DIR = '_observations';
/** Branch-scope pages live under this directory of a project's wiki, keyed by branch. */
export const KNOWLEDGE_BRANCHES_DIR = 'branches';

/** `vocscode/fix-pty` → `vocscode-fix-pty`; the directory name for one branch's pages. */
export function branchSlug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'branch';
}

/** Identity of a knowledge scope: the project root plus the checkout a session reads from. */
export interface KnowledgeScope {
  projectRoot: string;
  /** Where the session runs: a worktree has its own branch-scope wiki. */
  cwd: string;
  branch?: string;
}

/** App-wide Layer 2 switches (Settings → Project knowledge). */
export interface KnowledgeSettings {
  /** Prime every new session's system prompt with the bounded wiki digest. */
  prime: boolean;
  /** Run the distillation job automatically after commits, PRs and merges. */
  autoDistill: boolean;
}

export const KNOWLEDGE_KINDS = ['architecture', 'component', 'concept', 'decision', 'convention', 'flow', 'gotcha', 'testing', 'migration'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_STATUSES = ['draft', 'proposed', 'current', 'deprecated', 'superseded', 'uncertain'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

/** Repo pages are shared by every worktree; branch pages only surface in a matching checkout. */
export type KnowledgePageScope = 'repo' | 'branch';

export type KnowledgeConfidence = 'low' | 'medium' | 'high';

export type KnowledgeSourceType = 'file' | 'doc' | 'commit' | 'transcript' | 'session' | 'url' | 'human';

/** One piece of evidence a claim was derived from. `ref` is deliberately free-form but conventional. */
export interface KnowledgeSource {
  type: KnowledgeSourceType;
  ref: string;
  note?: string;
}

/** A pointer into the current implementation. Resolved live through GitNexus when available. */
export interface KnowledgeAnchor {
  file: string;
  symbol?: string;
}

export interface KnowledgeReview {
  state: 'unreviewed' | 'reviewed' | 'rejected';
  by?: string;
  at?: string;
  note?: string;
}

export interface KnowledgePageMeta {
  id: string;
  title: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  scope: KnowledgePageScope;
  /** Set only when scope is 'branch'. */
  branch?: string;
  confidence?: KnowledgeConfidence;
  keywords: string[];
  sources: KnowledgeSource[];
  anchors: KnowledgeAnchor[];
  related: string[];
  supersedes: string[];
  supersededBy?: string;
  contradicts: string[];
  /** The one-line claim this page defends; proposals carry it and merges compare it. */
  claim?: string;
  /** Proposals only: the page the proposal would update when accepted. */
  targetPageId?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  evidenceCount?: number;
  review?: KnowledgeReview;
}

export interface KnowledgePage {
  meta: KnowledgePageMeta;
  body: string;
  /** Wiki-relative path with forward slashes, e.g. `harness/session-lifecycle.md`. */
  path: string;
}

/** A page plus the context the panel and the read tool show beside it. */
export interface KnowledgePageDetail {
  page: KnowledgePage;
  /** Pages that name this one in `related` or wikilinks, in either direction. */
  related: KnowledgePageSummary[];
  /** True when a file source no longer exists or changed since the page was written. */
  stale: boolean;
  staleReasons: string[];
}

export interface KnowledgePageSummary {
  id: string;
  title: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  scope: KnowledgePageScope;
  branch?: string;
  path: string;
  claim?: string;
  targetPageId?: string;
  keywords: string[];
  updatedAt?: string;
  updatedBy?: string;
  confidence?: KnowledgeConfidence;
  /** Higher is more authoritative; human-reviewed outranks a draft (see knowledgeAuthority). */
  authority: number;
  evidenceCount?: number;
  /** Match excerpt with \u0001/\u0002 around the hit, when the summary came from a search. */
  snippet?: string;
}

export interface KnowledgeSearchResult extends KnowledgePageSummary {
  score: number;
}

export interface KnowledgeStatusSummary {
  /** A wiki directory exists for this scope. */
  hasWiki: boolean;
  pages: number;
  /** Pages whose status still needs a human decision (draft/proposed/uncertain). */
  needsReview: number;
  proposals: number;
  /** Pages that name a file source which changed or disappeared. */
  stale: number;
  /** Unresolved GitNexus availability for this project (informational). */
  indexed: boolean;
  lastUpdated?: string;
  generating?: boolean;
  /** The last synthesis job for this project, so a failure cannot vanish into a toast. */
  job?: KnowledgeJobState;
}

/** In-memory state of the most recent bootstrap/distill job for one project. */
export interface KnowledgeJobState {
  mode: 'bootstrap' | 'distill';
  state: 'running' | 'done' | 'failed';
  at: string;
  /** provider/model the job ran on, for the status line. */
  model?: string;
  detail?: string;
  error?: string;
}

/** The payload the Knowledge panel renders for one session's project. */
export interface KnowledgeView {
  projectRoot: string;
  cwd: string;
  branch?: string;
  /** Where this project's working wiki lives, for display. */
  wikiDir: string;
  status: KnowledgeStatusSummary;
  pages: KnowledgePageSummary[];
  proposals: KnowledgePageSummary[];
  /** Proposals rejected before, surfaced so an agent does not refile the same claim. */
  rejectedClaims: string[];
  settings: { prime: boolean; autoDistill: boolean };
}

export interface KnowledgeProposalInput {
  title: string;
  claim: string;
  body: string;
  kind?: KnowledgeKind;
  /** Where the accepted page lands; defaults by scope (see KnowledgeService.defaultScope). */
  scope?: KnowledgePageScope;
  /** Updates this existing page when accepted; a new slug is minted when absent. */
  pageId?: string;
  keywords?: string[];
  sources?: KnowledgeSource[];
  anchors?: KnowledgeAnchor[];
  related?: string[];
  supersedes?: string[];
  contradicts?: string[];
  confidence?: KnowledgeConfidence;
}

export interface KnowledgeProposalRecord extends KnowledgeProposalInput {
  id: string;
  createdAt: string;
  origin: string;
  sessionId?: string;
  /** How many independent sessions have now made this same claim. */
  evidenceCount: number;
}

/** A durable outcome worth remembering even before an LLM looks at it (L3 → L2 boundary). */
export interface KnowledgeEpisode {
  kind: 'commit' | 'pr' | 'merge' | 'session';
  sessionId: string;
  at: string;
  /** Commit subject, PR title or a short session summary. */
  summary: string;
  detail?: string;
}

/* ------------------------------------------------------------------ */
/* Identity and authority                                             */
/* ------------------------------------------------------------------ */

const ID_RE = /^[a-z0-9][a-z0-9/_-]*$/;

export function isKnowledgeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && ID_RE.test(value);
}

/** `Harness lifecycle and session ownership` → `harness-lifecycle-and-session-ownership`. */
export function knowledgeSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'note';
}

/** `harness/session-lifecycle.md` → `harness/session-lifecycle`; rejects escapes. */
export function pageIdFromPath(relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.endsWith('.md') || normalized.startsWith('_')) return null;
  const id = normalized.slice(0, -3);
  if (id.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  return isKnowledgeId(id) ? id : null;
}

/** Case and punctuation are noise in a claim: `Renderer retries PTY connects.` vs `renderer retries`. */
export function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Stable key for dedupe/rejection memory; a 32-bit FNV-1a rendered as hex. */
export function claimKey(claim: string): string {
  const text = normalizeClaim(claim);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The authority ladder, lower number = stronger. Explicit human rules (AGENTS.md) sit above every
 * page; the wiki never outranks them, so retrieval returns this rung with each page.
 */
export function authorityOf(meta: Pick<KnowledgePageMeta, 'status' | 'review' | 'updatedBy'>): number {
  if (meta.review?.state === 'reviewed') return 2;
  if (meta.updatedBy === 'human') return 2;
  if (meta.status === 'current') return 3;
  if (meta.status === 'uncertain' || meta.status === 'deprecated') return 4;
  return 5; // draft / proposed — agent-derived, unreviewed
}

/** Pages an agent may be handed as current truth. Historical pages exist but are not served as now. */
export function isServable(meta: Pick<KnowledgePageMeta, 'status'>): boolean {
  return meta.status === 'current' || meta.status === 'uncertain';
}

export function authorityLabel(meta: Pick<KnowledgePageMeta, 'status' | 'review' | 'updatedBy'>): string {
  const rank = authorityOf(meta);
  if (rank <= 2) return 'human-reviewed';
  if (meta.status === 'current') return 'accepted';
  if (meta.status === 'uncertain') return 'uncertain';
  if (meta.status === 'deprecated') return 'deprecated';
  if (meta.status === 'superseded') return 'superseded';
  return 'proposed';
}

/* ------------------------------------------------------------------ */
/* Frontmatter codec                                                  */
/* ------------------------------------------------------------------ */

const SOURCE_TYPES: KnowledgeSourceType[] = ['file', 'doc', 'commit', 'transcript', 'session', 'url', 'human'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim());
  const one = asString(value);
  return one ? [one] : [];
}

function stripQuotes(value: string): string {
  const t = value.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** Splits a `[a, b, c]` inline array into its members; empty members are dropped. */
function parseInlineList(value: string): string[] {
  const inner = value.trim().slice(1, -1);
  if (!inner.trim()) return [];
  return inner
    .split(',')
    .map((part) => stripQuotes(part))
    .filter(Boolean);
}

/**
 * Parses the narrow YAML subset this app writes: scalars, inline arrays and lists of strings or
 * of flat objects (sources, anchors). Anything else in a hand-edited file is preserved in the raw
 * record but ignored by the typed mapping, so a human's extra keys never break a page.
 */
export function parseFrontmatter(text: string): { raw: Record<string, unknown>; body: string } | null {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return null;
  const raw: Record<string, unknown> = {};
  let key: string | null = null;
  let item: Record<string, string> | null = null;
  let list: unknown[] | null = null;
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
  // Trailing whitespace is not content: it keeps parse(serialize(page)) === page.
  const body = normalized.slice(end + 4).replace(/^\n+/, '').replace(/\s+$/, '');
  return { raw, body };
}

function sourceOf(raw: unknown): KnowledgeSource | null {
  if (!isRecord(raw)) return null;
  const ref = asString(raw.ref);
  const type = asString(raw.type) as KnowledgeSourceType | undefined;
  if (!ref || !type || !SOURCE_TYPES.includes(type)) return null;
  const note = asString(raw.note);
  return { type, ref, ...(note ? { note } : {}) };
}

function anchorOf(raw: unknown): KnowledgeAnchor | null {
  if (!isRecord(raw)) return null;
  const file = asString(raw.file);
  if (!file) return null;
  const symbol = asString(raw.symbol);
  return { file, ...(symbol ? { symbol } : {}) };
}

function statusOf(value: unknown): KnowledgeStatus {
  return (KNOWLEDGE_STATUSES as readonly string[]).includes(String(value)) ? (String(value) as KnowledgeStatus) : 'draft';
}

function kindOf(value: unknown): KnowledgeKind {
  return (KNOWLEDGE_KINDS as readonly string[]).includes(String(value)) ? (String(value) as KnowledgeKind) : 'concept';
}

function confidenceOf(value: unknown): KnowledgeConfidence | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function reviewOf(raw: Record<string, unknown>): KnowledgeReview | undefined {
  const state = asString(raw.review_state);
  if (state !== 'unreviewed' && state !== 'reviewed' && state !== 'rejected') return undefined;
  const by = asString(raw.reviewed_by);
  const at = asString(raw.reviewed_at);
  const note = asString(raw.review_note);
  return { state, ...(by ? { by } : {}), ...(at ? { at } : {}), ...(note ? { note } : {}) };
}

/** Maps a parsed document onto the typed page; null when identity/kind are unusable. */
export function toKnowledgePage(raw: Record<string, unknown>, body: string, path: string): KnowledgePage | null {
  const id = asString(raw.id);
  const title = asString(raw.title);
  if (!id || !isKnowledgeId(id) || !title) return null;
  const branch = asString(raw.branch);
  const claim = asString(raw.claim);
  const supersededBy = asString(raw.superseded_by);
  const targetPageId = asString(raw.target_page);
  const createdAt = asString(raw.created_at);
  const updatedAt = asString(raw.updated_at);
  const updatedBy = asString(raw.updated_by);
  const evidenceRaw = raw.evidence_count;
  const evidence = typeof evidenceRaw === 'number' ? evidenceRaw : typeof evidenceRaw === 'string' && /^\d+$/.test(evidenceRaw) ? Number(evidenceRaw) : undefined;
  const meta: KnowledgePageMeta = {
    id,
    title,
    kind: kindOf(raw.kind),
    status: statusOf(raw.status),
    scope: raw.scope === 'branch' ? 'branch' : 'repo',
    keywords: asStringList(raw.keywords),
    sources: (Array.isArray(raw.sources) ? raw.sources : []).map(sourceOf).filter((s): s is KnowledgeSource => !!s),
    anchors: (Array.isArray(raw.anchors) ? raw.anchors : []).map(anchorOf).filter((a): a is KnowledgeAnchor => !!a),
    related: asStringList(raw.related),
    supersedes: asStringList(raw.supersedes),
    contradicts: asStringList(raw.contradicts)
  };
  if (branch) meta.branch = branch;
  const confidence = confidenceOf(raw.confidence);
  if (confidence) meta.confidence = confidence;
  if (claim) meta.claim = claim;
  if (targetPageId && isKnowledgeId(targetPageId)) meta.targetPageId = targetPageId;
  if (supersededBy) meta.supersededBy = supersededBy;
  if (createdAt) meta.createdAt = createdAt;
  if (updatedAt) meta.updatedAt = updatedAt;
  if (updatedBy) meta.updatedBy = updatedBy;
  if (evidence !== undefined && Number.isFinite(evidence)) meta.evidenceCount = evidence;
  const review = reviewOf(raw);
  if (review) meta.review = review;
  return { meta, body, path };
}

/** Parses a full markdown document; null when it is not a knowledge page. */
export function parseKnowledgeDocument(text: string, path: string): KnowledgePage | null {
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;
  return toKnowledgePage(parsed.raw, parsed.body, path);
}

function quote(value: string): string {
  return /^[A-Za-z0-9 .:/_#@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function linesOfList(key: string, values: string[]): string[] {
  if (!values.length) return [];
  return [`${key}:`, ...values.map((v) => `  - ${quote(v)}`)];
}

/** Serializes a page exactly as `parseKnowledgeDocument` reads it (round-trip tested). */
export function serializeKnowledgeDocument(meta: KnowledgePageMeta, body: string): string {
  const lines: string[] = ['---', `id: ${meta.id}`, `title: ${quote(meta.title)}`, `kind: ${meta.kind}`, `status: ${meta.status}`, `scope: ${meta.scope}`];
  if (meta.branch) lines.push(`branch: ${quote(meta.branch)}`);
  if (meta.confidence) lines.push(`confidence: ${meta.confidence}`);
  if (meta.claim) lines.push(`claim: ${quote(meta.claim)}`);
  if (meta.targetPageId) lines.push(`target_page: ${quote(meta.targetPageId)}`);
  if (meta.keywords.length) lines.push(`keywords: [${meta.keywords.map((k) => quote(k)).join(', ')}]`);
  if (meta.sources.length) {
    lines.push('sources:');
    for (const s of meta.sources) {
      lines.push(`  - type: ${s.type}`, `    ref: ${quote(s.ref)}`);
      if (s.note) lines.push(`    note: ${quote(s.note)}`);
    }
  }
  if (meta.anchors.length) {
    lines.push('anchors:');
    for (const a of meta.anchors) {
      lines.push(`  - file: ${quote(a.file)}`);
      if (a.symbol) lines.push(`    symbol: ${quote(a.symbol)}`);
    }
  }
  lines.push(...linesOfList('related', meta.related));
  lines.push(...linesOfList('supersedes', meta.supersedes));
  if (meta.supersededBy) lines.push(`superseded_by: ${quote(meta.supersededBy)}`);
  lines.push(...linesOfList('contradicts', meta.contradicts));
  if (meta.createdAt) lines.push(`created_at: ${meta.createdAt}`);
  if (meta.updatedAt) lines.push(`updated_at: ${meta.updatedAt}`);
  if (meta.updatedBy) lines.push(`updated_by: ${quote(meta.updatedBy)}`);
  if (meta.evidenceCount !== undefined) lines.push(`evidence_count: ${meta.evidenceCount}`);
  if (meta.review) {
    lines.push(`review_state: ${meta.review.state}`);
    if (meta.review.by) lines.push(`reviewed_by: ${quote(meta.review.by)}`);
    if (meta.review.at) lines.push(`reviewed_at: ${meta.review.at}`);
    if (meta.review.note) lines.push(`review_note: ${quote(meta.review.note)}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}${body.replace(/^\n+/, '').replace(/\s+$/, '')}\n`;
}

/* ------------------------------------------------------------------ */
/* Session digest                                                     */
/* ------------------------------------------------------------------ */

/** Kinds most worth an agent's first 2 KB, in the order they earn their space. */
const DIGEST_ORDER: KnowledgeKind[] = ['architecture', 'convention', 'gotcha', 'decision', 'concept', 'flow', 'testing', 'component', 'migration'];

/**
 * The bounded, always-on block primed into a new session. It names pages rather than pasting them:
 * the digest is orientation, the tools are the retrieval. Never contains a page body.
 */
export function renderKnowledgeDigest(pages: KnowledgePageSummary[], opts: { projectName: string; wikiDir: string; maxChars?: number }): string | null {
  const servable = pages.filter((p) => isServable(p));
  if (!servable.length) return null;
  const ranked = [...servable].sort((a, b) => {
    const kind = DIGEST_ORDER.indexOf(a.kind) - DIGEST_ORDER.indexOf(b.kind);
    if (kind !== 0) return kind;
    if (a.authority !== b.authority) return a.authority - b.authority;
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });
  const max = opts.maxChars ?? 2400;
  const lines: string[] = [`# Project knowledge — ${opts.projectName}`, '', `Curated understanding of this project (what it means, why it is built this way, what must stay true). It is not the current implementation — use GitNexus and the code for that. Explicit project rules (AGENTS.md) outrank everything here.`, ''];
  for (const page of ranked) {
    const claim = page.claim ? ` — ${page.claim}` : '';
    const line = `- [${page.kind}] ${page.title}${claim} (${page.path})`;
    if (lines.join('\n').length + line.length > max) break;
    lines.push(line);
  }
  lines.push('', `Call knowledge_search for detail, knowledge_read for one page, and knowledge_propose after discovering something durable. Working wiki: ${opts.wikiDir}`);
  const text = lines.join('\n');
  return text.length > max + 400 ? null : text;
}

/* ------------------------------------------------------------------ */
/* Proposals                                                          */
/* ------------------------------------------------------------------ */

/** A wiki-relative path for a new page: `<kind>/<slug>.md`. */
export function pathForProposal(kind: KnowledgeKind, title: string): string {
  return `${kind}/${knowledgeSlug(title)}.md`;
}

/**
 * Whether a proposal edits the page it names. Editing content needs a human; merely recording
 * another independent sighting of the same claim does not.
 */
export function isSameClaim(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = normalizeClaim(a);
  const right = normalizeClaim(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length >= 24 && longer.includes(shorter);
}
