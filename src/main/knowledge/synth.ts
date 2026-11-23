/**
 * The knowledge jobs. Each is explicit, bounded and one-shot: a background completion per batch
 * with a hard cap on what it may write.
 *
 *   bootstrap  every changed project document → pages (recursive, batched, incremental)
 *   distill    one commit / merge episode plus its transcript slice → pages
 *   reflect    one PR's commits and bounded diff over the whole wiki → page updates
 *
 * No job can publish or delete anything. Every write goes through `propose`, which applies the
 * same dedupe, evidence and rejection rules any other writer gets.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  KNOWLEDGE_KINDS,
  isSameClaim,
  normalizeClaim,
  normalizeLabels,
  pathForProposal,
  type KnowledgeKind,
  type KnowledgePageMeta,
  type KnowledgeProposalInput,
  type KnowledgeScope,
  type KnowledgeSettings,
  type KnowledgeSource
} from '../../shared/knowledge';
import { errorMessage } from '../util/async';
import type { KnowledgeCompleter } from './llm';
import { parseJsonReply, salvageArrayEntries } from './llm';
import type { KnowledgeStore } from './store';

export interface KnowledgeJobResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

export interface KnowledgeSynthDeps {
  store: KnowledgeStore;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  settings: KnowledgeSettings;
  completer?: KnowledgeCompleter;
  /** Bounded transcript lines for one session, newest last. */
  transcript?: (sessionId: string) => Promise<string[]>;
  /** Wired by the service so every write goes through the same rules. */
  propose?: (input: KnowledgeProposalInput, origin: string, sessionId?: string) => Promise<{ promoted: boolean; rejected: boolean; protected?: 'kept' | 'refused' }>;
}

const MAX_EVIDENCE_CHARS = 40_000;
const MAX_FILE_CHARS = 5_000;
const MAX_SCAN_FILES = 600;
const MAX_PAGES_PER_BATCH = 12;
const MIN_BODY_CHARS = 80;
const MAX_DISTILLED_PROPOSALS = 3;
const MAX_REFLECTED_PAGES = 8;
const MAX_TRANSCRIPT_CHARS = 6_000;
const MAX_EPISODE_CHARS = 8_000;

/** Directories that never hold project knowledge; scanning them would only add noise and cost. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', 'venv', 'target', '.vocs-code', '.gitnexus', 'coverage', '.cache', 'vendor']);
/** Generated or legal files that are not project knowledge. */
const SKIP_FILES = new Set(['changelog.md', 'license.md', 'license']);

const BOOTSTRAP_SYSTEM = [
  'You maintain a durable project wiki used by coding agents.',
  'You explain what the project means, why it is built this way, and what must stay true: architecture intent, concepts, decisions, conventions, gotchas, testing philosophy.',
  'You do NOT describe current symbols, call graphs or line numbers — another tool owns the current code structure.',
  'Prefer few, high-signal pages over many thin ones. Every page must be justified by the supplied evidence; never invent file paths or facts.',
  'Assign labels: a handful of normalized lowercase tags (e.g. "harness", "pty", "release") that group this page with related pages.',
  'Reply with JSON only, no prose, matching: {"pages":[{"title":string,"kind":"architecture|component|concept|decision|convention|flow|gotcha|testing|migration","claim":string,"body":string,"labels":string[],"keywords":string[],"sources":[{"type":"file|doc|commit|transcript|session|url|human","ref":string,"note":string?}],"anchors":[{"file":string,"symbol":string?}],"related":string[]}]}',
  'A claim is one sentence. A body is 60-400 words of markdown that would still make sense without the source document.'
].join(' ');

const DISTILL_SYSTEM = [
  'You turn work that just happened into durable project knowledge for a wiki.',
  'A candidate is only worth recording when it is durable (true beyond this task), non-obvious and evidenced by the supplied material.',
  'Never propose current implementation details — symbols, call chains, file lists — that the code already answers.',
  'If nothing durable happened, reply with {"proposals":[]}.',
  'Assign labels: a handful of normalized lowercase tags that group this page with related pages.',
  'Reply with JSON only, matching: {"proposals":[{"title":string,"kind":"architecture|component|concept|decision|convention|flow|gotcha|testing|migration","claim":string,"body":string,"pageId":string?,"labels":string[],"keywords":string[],"sources":[{"type":"file|doc|commit|transcript|session|url|human","ref":string,"note":string?}],"anchors":[{"file":string,"symbol":string?}]}]}'
].join(' ');

const REFLECT_SYSTEM = [
  'You reflect a pull request over a durable project wiki used by coding agents.',
  'Update an existing page when the PR changes what the project means, why it is built this way, or what must stay true; create a new page only when nothing existing fits.',
  'Return the pageId of an existing page to update it, and prefer updating over creating a near-duplicate.',
  'Never propose current implementation details — symbols, call chains, file lists — that the code already answers.',
  'Assign labels: a handful of normalized lowercase tags that group each page with related pages.',
  'If the PR changes nothing durable, reply with {"proposals":[]}.',
  'Reply with JSON only, matching: {"proposals":[{"title":string,"kind":"architecture|component|concept|decision|convention|flow|gotcha|testing|migration","claim":string,"body":string,"pageId":string?,"labels":string[],"keywords":string[],"sources":[{"type":"file|doc|commit|transcript|session|url|human","ref":string,"note":string?}],"anchors":[{"file":string,"symbol":string?}]}]}'
].join(' ');

interface DocumentBlock {
  rel: string;
  text: string;
}

/**
 * Walks the checkout for markdown, skipping vendored and generated trees, and returns only the
 * documents whose mtime/size changed since the last scan. The returned ledger is the complete new
 * snapshot; the caller writes it only once the job has finished.
 */
async function scanDocuments(
  scope: KnowledgeScope,
  store: KnowledgeStore
): Promise<{ blocks: DocumentBlock[]; ledger: Record<string, { mtimeMs: number; size: number }> }> {
  const root = scope.cwd;
  const previous = await store.readScan(scope);
  const ledger: Record<string, { mtimeMs: number; size: number }> = {};
  const blocks: DocumentBlock[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 8 || blocks.length >= MAX_SCAN_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(abs, relPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      if (SKIP_FILES.has(entry.name.toLowerCase())) continue;
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      ledger[relPath] = { mtimeMs: stat.mtimeMs, size: stat.size };
      const last = previous[relPath];
      if (last && last.mtimeMs === stat.mtimeMs && last.size === stat.size) continue;
      let text: string;
      try {
        text = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const clipped = text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n…(truncated)` : text;
      blocks.push({ rel: relPath, text: clipped });
    }
  };
  await walk(root, '', 0);
  return { blocks, ledger };
}

/** Splits documents into evidence groups that each fit one completion. */
function batchBlocks(blocks: DocumentBlock[], maxChars: number): DocumentBlock[][] {
  const batches: DocumentBlock[][] = [];
  let current: DocumentBlock[] = [];
  let size = 0;
  for (const block of blocks) {
    const cost = block.text.length + block.rel.length + 8;
    if (current.length && (size + cost > maxChars || current.length >= 24)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(block);
    size += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

interface RawPage {
  title?: unknown;
  kind?: unknown;
  claim?: unknown;
  body?: unknown;
  pageId?: unknown;
  keywords?: unknown;
  labels?: unknown;
  sources?: unknown;
  anchors?: unknown;
  related?: unknown;
  confidence?: unknown;
}

function asStringList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim()).slice(0, cap);
}

function asSources(value: unknown, fallbackFiles: string[]): KnowledgeSource[] {
  const out: KnowledgeSource[] = [];
  if (Array.isArray(value)) {
    for (const raw of value.slice(0, 12)) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const ref = typeof entry.ref === 'string' ? entry.ref.trim() : '';
      const type = entry.type;
      if (!ref) continue;
      if (type === 'file' || type === 'doc' || type === 'commit' || type === 'transcript' || type === 'session' || type === 'url' || type === 'human') {
        out.push({ type, ref, ...(typeof entry.note === 'string' && entry.note ? { note: entry.note.slice(0, 200) } : {}) });
      }
    }
  }
  if (!out.length) for (const file of fallbackFiles.slice(0, 3)) out.push({ type: 'file', ref: file });
  return out;
}

function asAnchors(value: unknown): KnowledgePageMeta['anchors'] {
  if (!Array.isArray(value)) return [];
  const out: KnowledgePageMeta['anchors'] = [];
  for (const raw of value.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const file = typeof entry.file === 'string' ? entry.file.trim() : '';
    if (!file) continue;
    const symbol = typeof entry.symbol === 'string' && entry.symbol.trim() ? entry.symbol.trim() : undefined;
    out.push(symbol ? { file, symbol } : { file });
  }
  return out;
}

function kindOf(value: unknown): KnowledgeKind {
  return (KNOWLEDGE_KINDS as readonly string[]).includes(String(value)) ? (String(value) as KnowledgeKind) : 'concept';
}

/**
 * Bootstrap: recursively scan every changed document, batch the evidence through the utility
 * model, and ingest the pages it returns. Incremental by construction — unchanged files are never
 * re-read, so a second run costs almost nothing.
 */
export async function bootstrapKnowledge(scope: KnowledgeScope, deps: KnowledgeSynthDeps): Promise<KnowledgeJobResult> {
  if (!deps.completer) return { ok: false, error: 'No background model is configured.' };
  const { blocks, ledger } = await scanDocuments(scope, deps.store);
  if (!blocks.length) {
    await deps.store.writeScan(scope, ledger).catch((e) => deps.log('debug', `knowledge: could not record the scan: ${errorMessage(e)}`));
    return { ok: true, detail: 'no changed documentation to scan' };
  }
  const batches = batchBlocks(blocks, MAX_EVIDENCE_CHARS);
  const claims = new Set<string>();
  let ingested = 0;
  let batchesRun = 0;
  let attempted = 0;
  for (const batch of batches) {
    const evidence = batch.map((b) => `### ${b.rel}\n\n${b.text}`).join('\n\n');
    if (evidence.trim().length < 200) continue;
    attempted++;
    const prompt = [`Project: ${path.basename(scope.projectRoot)}`, '', `Evidence (${batch.length} document(s)). Propose at most ${MAX_PAGES_PER_BATCH} pages, most important first.`, '', evidence].join('\n');
    const reply = await deps.completer.complete({ system: BOOTSTRAP_SYSTEM, prompt, maxTokens: 16_000 });
    const parsed = parseJsonReply<{ pages?: RawPage[] }>(reply);
    const raw = (Array.isArray(parsed?.pages) && parsed.pages.length ? parsed.pages : salvageArrayEntries<RawPage>(reply, 'pages')).slice(0, MAX_PAGES_PER_BATCH);
    if (!raw.length) {
      deps.log('warn', `knowledge: bootstrap batch returned no usable pages (${batch.length} document(s))`);
      continue;
    }
    batchesRun++;
    const fallbackFiles = batch.map((b) => b.rel);
    for (const entry of raw) {
      const title = typeof entry.title === 'string' ? entry.title.trim() : '';
      const claim = typeof entry.claim === 'string' ? entry.claim.trim() : '';
      const body = typeof entry.body === 'string' ? entry.body.trim() : '';
      if (!title || !body || body.length < MIN_BODY_CHARS) continue;
      const claimKey = normalizeClaim(claim || title);
      if (claims.has(claimKey)) continue;
      claims.add(claimKey);
      const kind = kindOf(entry.kind);
      const id = pathForProposal(kind, title).replace(/\.md$/, '');
      const existing = await deps.store.read(scope, id);
      // Never overwrite a page a human wrote or reviewed; a duplicate claim is not re-recorded.
      if (existing && (existing.meta.updatedBy?.startsWith('human') || existing.meta.review?.state === 'reviewed')) continue;
      if (existing && isSameClaim(existing.meta.claim, claim)) continue;
      const meta: KnowledgePageMeta = {
        id,
        title,
        kind,
        status: 'current',
        scope: 'repo',
        ...(claim ? { claim } : {}),
        confidence: entry.confidence === 'low' || entry.confidence === 'medium' || entry.confidence === 'high' ? entry.confidence : 'medium',
        keywords: asStringList(entry.keywords, 12),
        labels: normalizeLabels(asStringList(entry.labels, 12)),
        sources: asSources(entry.sources, fallbackFiles),
        anchors: asAnchors(entry.anchors),
        related: asStringList(entry.related, 8),
        supersedes: [],
        contradicts: [],
        updatedBy: 'agent:bootstrap'
      };
      await deps.store.write(scope, meta, body);
      ingested++;
    }
  }
  await deps.store.writeScan(scope, ledger).catch((e) => deps.log('debug', `knowledge: could not record the scan: ${errorMessage(e)}`));
  if (attempted > 0 && ingested === 0) {
    return { ok: false, error: 'The background model returned no usable pages. Check the app log for the raw reply.' };
  }
  deps.log('info', `knowledge: bootstrap ingested ${ingested} page(s) from ${blocks.length} changed document(s) in ${batchesRun} batch(es)`);
  return { ok: true, detail: `ingested ${ingested} page(s) from ${blocks.length} changed document(s)` };
}

export interface DistillOptions {
  /** `reflect` widens the evidence to a PR's commits and diff; `distill` uses one episode. */
  mode?: 'distill' | 'reflect';
}

/**
 * Distillation and PR reflection. Episodes since the last run (plus the newest episode's detail and
 * a transcript slice) become page writes. Every write goes through `propose`, so the service's
 * dedupe, evidence and rejection rules apply.
 */
export async function distillKnowledge(scope: KnowledgeScope, deps: KnowledgeSynthDeps, opts: DistillOptions = {}): Promise<KnowledgeJobResult> {
  const reflect = opts.mode === 'reflect';
  if (!deps.completer) return { ok: false, error: 'No background model is configured.' };
  if (!deps.propose) return { ok: false, error: 'Distillation is not wired to the proposal pipeline.' };
  const episodes = await deps.store.readEpisodes(scope, 20);
  if (!episodes.length) return { ok: true, detail: 'nothing to distil' };
  const newest = episodes[0];
  let transcriptLines: string[] = [];
  if (deps.transcript) {
    try {
      transcriptLines = await deps.transcript(newest.sessionId);
    } catch (e) {
      deps.log('debug', `knowledge: transcript unavailable for ${newest.sessionId}: ${errorMessage(e)}`);
    }
  }
  let transcriptText = transcriptLines.join('\n');
  if (transcriptText.length > MAX_TRANSCRIPT_CHARS) transcriptText = transcriptText.slice(-MAX_TRANSCRIPT_CHARS);
  const pages = await deps.store.load(scope);
  const index = pages
    .slice(0, 80)
    .map((p) => `- ${p.meta.id}: ${p.meta.title}${p.meta.claim ? ` — ${p.meta.claim}` : ''}${p.meta.labels.length ? ` [${p.meta.labels.join(', ')}]` : ''}`)
    .join('\n');
  const episodeText = episodes
    .slice(0, reflect ? 20 : 12)
    .map((e) => {
      const detail = e.detail ? `\n  ${reflect ? e.detail.slice(0, MAX_EPISODE_CHARS) : e.detail.replace(/\s+/g, ' ').slice(0, 400)}` : '';
      return `- [${e.kind}] ${e.at} ${e.summary}${detail}`;
    })
    .join('\n');
  const prompt = [
    `Project: ${path.basename(scope.projectRoot)}${scope.branch ? ` (branch ${scope.branch})` : ''}`,
    '',
    reflect ? 'Pull request outcomes:' : 'Recent durable outcomes:',
    episodeText,
    '',
    'Existing wiki pages (update one of these with its pageId rather than creating a near duplicate):',
    index || '(none yet)',
    transcriptText ? '\nTranscript slice from the most recent episode:\n' : '',
    transcriptText
  ].join('\n');
  const system = reflect ? REFLECT_SYSTEM : DISTILL_SYSTEM;
  const maxPages = reflect ? MAX_REFLECTED_PAGES : MAX_DISTILLED_PROPOSALS;
  const reply = await deps.completer.complete({ system, prompt, maxTokens: reflect ? 16_000 : 8_000 });
  const parsed = parseJsonReply<{ proposals?: RawPage[] }>(reply);
  const raw = (Array.isArray(parsed?.proposals) && parsed.proposals.length ? parsed.proposals : salvageArrayEntries<RawPage>(reply, 'proposals')).slice(0, maxPages);
  if (!raw.length) return { ok: true, detail: reply ? 'no durable knowledge found' : 'the background model did not answer' };
  let proposed = 0;
  let updated = 0;
  for (const entry of raw) {
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const claim = typeof entry.claim === 'string' ? entry.claim.trim() : '';
    const body = typeof entry.body === 'string' ? entry.body.trim() : '';
    if (!title || !claim || !body) continue;
    const pageIdRaw = typeof entry.pageId === 'string' ? entry.pageId.trim() : '';
    const pageId = pageIdRaw && pages.some((p) => p.meta.id === pageIdRaw) ? pageIdRaw : undefined;
    const result = await deps.propose(
      {
        title,
        claim,
        body,
        kind: kindOf(entry.kind),
        ...(pageId ? { pageId } : {}),
        keywords: asStringList(entry.keywords, 12),
        labels: asStringList(entry.labels, 12),
        sources: asSources(entry.sources, []),
        anchors: asAnchors(entry.anchors)
      },
      reflect ? 'agent:reflect' : 'agent:distill',
      newest.sessionId
    );
    // A tombstoned claim and a refused change to a human-reviewed page both wrote nothing.
    if (result.rejected || result.protected === 'refused') continue;
    proposed++;
    if (pageId) updated++;
  }
  const detail = reflect ? `reflected ${proposed} page(s) from the PR` : `recorded ${proposed} page(s)${updated ? `, ${updated} updated` : ''}`;
  deps.log('info', `knowledge: ${reflect ? 'reflect' : 'distill'} ${detail}`);
  return { ok: true, detail };
}
