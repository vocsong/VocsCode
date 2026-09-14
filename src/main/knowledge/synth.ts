/**
 * The two knowledge jobs. Both are explicit, bounded and cancellable by being one-shot: a single
 * background completion with a hard cap on what it may write.
 *
 *   bootstrap  docs + project instructions + the repo's own files → draft pages for review
 *   distill    one commit / PR / merge episode plus its transcript slice → proposals
 *
 * Neither job can mark a page current, publish it, or delete anything. The LLM's only write path is
 * `propose`, which applies the same dedupe, evidence and rejection rules a human proposal gets.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  KNOWLEDGE_KINDS,
  isSameClaim,
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
  propose?: (input: KnowledgeProposalInput, origin: string, sessionId?: string) => Promise<{ promoted: boolean; rejected: boolean }>;
}

const MAX_EVIDENCE_CHARS = 40_000;
const MAX_FILE_CHARS = 5_000;
const MAX_FILES = 14;
const MAX_BOOTSTRAP_PAGES = 12;
const MIN_BODY_CHARS = 80;
const MAX_DISTILLED_PROPOSALS = 3;
const MAX_TRANSCRIPT_CHARS = 6_000;

const BOOTSTRAP_SYSTEM = [
  'You maintain a durable project wiki used by coding agents.',
  'You explain what the project means, why it is built this way, and what must stay true: architecture intent, concepts, decisions, conventions, gotchas, testing philosophy.',
  'You do NOT describe current symbols, call graphs or line numbers — another tool owns the current code structure.',
  'Prefer few, high-signal pages over many thin ones. Every page must be justified by the supplied evidence; never invent file paths or facts.',
  'Reply with JSON only, no prose, matching: {"pages":[{"title":string,"kind":"architecture|component|concept|decision|convention|flow|gotcha|testing|migration","claim":string,"body":string,"keywords":string[],"sources":[{"type":"file|doc|commit|transcript|session|url|human","ref":string,"note":string?}],"anchors":[{"file":string,"symbol":string?}],"related":string[]}]}',
  'A claim is one sentence. A body is 60-400 words of markdown that would still make sense without the source document.'
].join(' ');

const DISTILL_SYSTEM = [
  'You turn work that just happened into candidate project knowledge for a durable wiki.',
  'A candidate is only worth proposing when it is durable (true beyond this task), non-obvious and evidenced by the supplied material.',
  'Never propose current implementation details — symbols, call chains, file lists — that the code already answers.',
  'If nothing durable happened, reply with {"proposals":[]}.',
  'Reply with JSON only, matching: {"proposals":[{"title":string,"kind":"architecture|component|concept|decision|convention|flow|gotcha|testing|migration","claim":string,"body":string,"pageId":string?,"keywords":string[],"sources":[{"type":"file|doc|commit|transcript|session|url|human","ref":string,"note":string?}],"anchors":[{"file":string,"symbol":string?}]}]}'
].join(' ');

/**
 * Reads the project's own documentation. This is the only evidence bootstrap gets: the wiki must be
 * grounded in what the project already wrote about itself, not in the model's guesses.
 */
async function gatherEvidence(scope: KnowledgeScope): Promise<{ text: string; files: string[] }> {
  const root = scope.cwd;
  const candidates: string[] = [];
  for (const name of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md']) {
    if (await isFile(path.join(root, name))) candidates.push(name);
  }
  try {
    const docs = await fs.readdir(path.join(root, 'docs'));
    for (const name of docs.filter((n) => n.endsWith('.md')).slice(0, 12)) candidates.push(`docs/${name}`);
  } catch {
    /* no docs folder */
  }
  const blocks: string[] = [];
  const files: string[] = [];
  let total = 0;
  for (const rel of candidates.slice(0, MAX_FILES)) {
    try {
      const text = await fs.readFile(path.join(root, rel), 'utf8');
      const clipped = text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n…(truncated)` : text;
      if (total + clipped.length > MAX_EVIDENCE_CHARS) break;
      total += clipped.length;
      files.push(rel);
      blocks.push(`### ${rel}\n\n${clipped}`);
    } catch {
      /* unreadable candidates are simply not evidence */
    }
  }
  const dirs = await topLevelDirs(root);
  if (dirs.length) blocks.push(`### layout\n\nTop-level directories: ${dirs.join(', ')}`);
  return { text: blocks.join('\n\n'), files };
}

async function topLevelDirs(root: string): Promise<string[]> {
  const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', 'venv', 'target', '.vocs-code', '.gitnexus']);
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name))
      .map((e) => e.name)
      .sort()
      .slice(0, 30);
  } catch {
    return [];
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

interface RawPage {
  title?: unknown;
  kind?: unknown;
  claim?: unknown;
  body?: unknown;
  pageId?: unknown;
  keywords?: unknown;
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

/** Bootstrap: draft pages only. A draft is never served to an agent until a human accepts it. */
export async function bootstrapKnowledge(scope: KnowledgeScope, deps: KnowledgeSynthDeps): Promise<KnowledgeJobResult> {
  if (!deps.completer) return { ok: false, error: 'No background model is configured.' };
  const { text, files } = await gatherEvidence(scope);
  if (text.trim().length < 400) return { ok: false, error: 'Not enough project documentation to synthesise from (README, docs/, AGENTS.md).' };
  const prompt = [
    `Project: ${path.basename(scope.projectRoot)}`,
    '',
    `Evidence (${files.length} file(s)). Propose at most ${MAX_BOOTSTRAP_PAGES} pages, most important first.`,
    '',
    text
  ].join('\n');
  const reply = await deps.completer.complete({ system: BOOTSTRAP_SYSTEM, prompt, maxTokens: 16_000 });
  const parsed = parseJsonReply<{ pages?: RawPage[] }>(reply);
  const salvagedPages = Array.isArray(parsed?.pages) && parsed.pages.length ? parsed.pages : salvageArrayEntries<RawPage>(reply, 'pages');
  const raw = salvagedPages.slice(0, MAX_BOOTSTRAP_PAGES);
  if (!raw.length) {
    return { ok: false, error: reply ? 'The model returned no usable pages. Check the app log for the raw reply.' : `The background model (${deps.completer.label() ?? 'unknown'}) did not answer. Check the app log.` };
  }
  let written = 0;
  for (const entry of raw.slice(0, MAX_BOOTSTRAP_PAGES)) {
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const claim = typeof entry.claim === 'string' ? entry.claim.trim() : '';
    const body = typeof entry.body === 'string' ? entry.body.trim() : '';
    if (!title || !body || body.length < MIN_BODY_CHARS) continue;
    const kind = kindOf(entry.kind);
    const id = pathForProposal(kind, title).replace(/\.md$/, '');
    const existing = await deps.store.read(scope, id);
    if (existing && isSameClaim(existing.meta.claim, claim)) continue;
    const meta: KnowledgePageMeta = {
      id,
      title,
      kind,
      status: 'draft',
      scope: 'repo',
      ...(claim ? { claim } : {}),
      confidence: entry.confidence === 'low' || entry.confidence === 'medium' || entry.confidence === 'high' ? entry.confidence : 'medium',
      keywords: asStringList(entry.keywords, 12),
      sources: asSources(entry.sources, files),
      anchors: asAnchors(entry.anchors),
      related: asStringList(entry.related, 8),
      supersedes: [],
      contradicts: [],
      updatedBy: 'job:bootstrap'
    };
    await deps.store.write(scope, meta, body);
    written++;
  }
  deps.log('info', `knowledge: bootstrap wrote ${written} draft page(s) from ${files.length} file(s)`);
  return { ok: true, detail: `wrote ${written} draft page(s) — review them in the Knowledge panel` };
}

/**
 * Distillation: episodes since the last run, plus the freshest episode's transcript slice, become
 * proposals. The model may only propose; every write goes through the service's rules.
 */
export async function distillKnowledge(scope: KnowledgeScope, deps: KnowledgeSynthDeps): Promise<KnowledgeJobResult> {
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
    .slice(0, 60)
    .map((p) => `- ${p.meta.id}: ${p.meta.title}${p.meta.claim ? ` — ${p.meta.claim}` : ''}`)
    .join('\n');
  const episodeText = episodes
    .slice(0, 12)
    .map((e) => `- [${e.kind}] ${e.at} ${e.summary}${e.detail ? `\n  ${e.detail.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`)
    .join('\n');
  const prompt = [
    `Project: ${path.basename(scope.projectRoot)}${scope.branch ? ` (branch ${scope.branch})` : ''}`,
    '',
    'Recent durable outcomes:',
    episodeText,
    '',
    'Existing wiki pages (prefer updating one of these over creating a near duplicate):',
    index || '(none yet)',
    transcriptText ? '\nTranscript slice from the most recent episode:\n' : '',
    transcriptText
  ].join('\n');
  const reply = await deps.completer.complete({ system: DISTILL_SYSTEM, prompt, maxTokens: 8000 });
  const parsed = parseJsonReply<{ proposals?: RawPage[] }>(reply);
  const raw = (Array.isArray(parsed?.proposals) && parsed.proposals.length ? parsed.proposals : salvageArrayEntries<RawPage>(reply, 'proposals')).slice(0, MAX_DISTILLED_PROPOSALS);
  if (!raw.length) return { ok: true, detail: reply ? 'no durable knowledge proposed' : 'the background model did not answer' };
  let proposed = 0;
  let promoted = 0;
  for (const entry of raw.slice(0, MAX_DISTILLED_PROPOSALS)) {
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
        sources: asSources(entry.sources, []),
        anchors: asAnchors(entry.anchors)
      },
      'agent:distill',
      newest.sessionId
    );
    if (result.rejected) continue;
    proposed++;
    if (result.promoted) promoted++;
  }
  const detail = `proposed ${proposed} candidate(s)${promoted ? `, ${promoted} already backed by repeated evidence` : ''}`;
  deps.log('info', `knowledge: distill ${detail}`);
  return { ok: true, detail };
}
