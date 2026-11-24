import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HOUSEKEEP_SKILL } from '../shared/built-in-skills';
import { housekeepActivityAt, housekeepIsRecent, normalizeHousekeepRecentDays, type HousekeepEvidence, type HousekeepOutcome, type HousekeepPreview, type HousekeepRow } from '../shared/housekeep';
import type { AppSettings, SessionMeta, TranscriptItem } from '../shared/types';
import { usableProviders } from './agents/model';
import { inspectHousekeepWorktree, removeHousekeepWorktree, type HousekeepWorktree } from './housekeep-worktrees';
import { createKnowledgeCompleter } from './knowledge/llm';
import type { SessionManager } from './session-manager';
import { errorMessage } from './util/async';

const PLAN_MS = 30 * 60_000;
const REVIEW_BATCH = 8;

interface Reviewer {
  label: string;
  identity: string;
  complete(prompt: string): Promise<string | null>;
}

/** Unlike background titles/wiki jobs, conversation review never falls back to a different model. */
export function configuredHousekeepReviewer(settings: AppSettings, deps: Omit<Parameters<typeof createKnowledgeCompleter>[0], 'settings'>): Reviewer | null {
  const model = settings.utilityModel;
  const provider = model && usableProviders(settings.providers).find(p => p.id === model.provider);
  if (!model || !provider) return null;
  // Capture the explicitly chosen endpoint rather than re-reading settings across a batch.
  const selected = structuredClone({ ...settings, providers: [provider], utilityModel: model });
  const completion = createKnowledgeCompleter({ ...deps, settings: () => selected });
  return {
    label: `${provider.id}/${model.model}`,
    identity: JSON.stringify([model, provider.kind, provider.baseUrl, provider.headers, provider.envKey]),
    complete: prompt => completion.complete({
      system: `${HOUSEKEEP_SKILL}\n\nReturn only JSON of the form {"reviews":[{"index":0,"verdict":"complete|keep|review","reason":"one short factual sentence"}]}. Use one entry per supplied index, with a single verdict from the three choices. Do not reproduce sensitive data. You have no tools or authorization to archive anything.`,
      prompt,
      maxTokens: 1600,
      timeoutMs: 30_000
    })
  };
}

interface HousekeepDeps {
  sessions: Pick<SessionManager, 'list' | 'get' | 'canHousekeep' | 'housekeepTranscript' | 'archiveForHousekeep'>;
  settings: () => Pick<AppSettings, 'housekeepRecentDays'>;
  savingRecentDays?: () => boolean;
  trashDirectory?: (dir: string) => Promise<void>;
  hasTerminalOrView: (id: string) => boolean;
  runningOwners?: () => Promise<ReadonlySet<string> | null>;
  authorize?: (id: string) => Promise<void>;
  reviewer: () => Reviewer | null;
  now?: () => number;
  inspect?: typeof inspectHousekeepWorktree;
  remove?: typeof removeHousekeepWorktree;
}

type EligibleTree = Exclude<HousekeepWorktree, { kind: 'blocked' }>;
interface Candidate {
  fingerprint: string;
  tree: EligibleTree;
  evidenceDigest: string;
  transcriptActivityAt: number;
}
interface Plan {
  preview: HousekeepPreview;
  recentDaysOverride?: number;
  createdAt: number;
  modelIdentity?: string;
  candidates: Map<string, Candidate>;
  protectedIds: Set<string>;
  assessed?: boolean;
}

const modelReply = z.strictObject({ reviews: z.array(z.strictObject({
  index: z.number().int().nonnegative(),
  verdict: z.enum(['complete', 'keep', 'review']),
  reason: z.string().trim().min(1).max(240)
})).max(REVIEW_BATCH) });

function shorten(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit / 2) + '\n[Excerpt shortened]\n' + trimmed.slice(-limit / 2);
}

/** The persisted terminal turn, not a git badge or a streamed answer, is the minimum evidence. */
export function housekeepEvidence(items: TranscriptItem[], session?: Pick<SessionMeta, 'id' | 'forkedFrom' | 'createdAt'>): { excerpt: HousekeepEvidence; digest: string; activityAt: number } | string {
  if (items.some(item => item.kind === 'approval' && !item.decision)) return 'An approval or question is still unresolved.';
  if (items.some(item => item.kind === 'tool' && item.status === 'running')) return 'Tool completion is unverified.';
  const ordered = items.filter(item => item.kind === 'user' || item.kind === 'turn' || item.kind === 'assistant')
    .sort((a, b) => a.ts - b.ts);
  const requestAt = ordered.findLastIndex(item => item.kind === 'user');
  const request = ordered[requestAt];
  const turn = ordered.findLast(item => item.kind === 'turn');
  if (!request || request.kind !== 'user' || !request.text.trim() || request.images?.length || request.files?.length || request.imagesOmitted) {
    return 'The latest request is missing or needs attachment context.';
  }
  if (session && (request.userInput && request.userInput.sessionId !== session.id || session.forkedFrom && request.ts < session.createdAt)) {
    return 'The latest request is inherited from another session.';
  }
  if (!turn || turn.kind !== 'turn' || turn.status !== 'completed' || turn.carried || ordered.indexOf(turn) <= requestAt) {
    return 'The latest request has no verified completed turn.';
  }
  const response = ordered.slice(requestAt + 1, ordered.indexOf(turn) + 1).findLast(item =>
    item.kind === 'assistant' && item.phase !== 'commentary' && item.phase !== 'plan' && !item.streaming && item.text.trim());
  if (!response || response.kind !== 'assistant') return 'No final response was recorded for the latest request.';
  return {
    excerpt: { request: shorten(request.text, 1600), response: shorten(response.text, 3200) },
    activityAt: items.reduce((latest, item) => Math.max(latest, item.ts), turn.ts),
    digest: createHash('sha256').update(JSON.stringify([request.id, request.ts, request.text, response.id, response.ts, response.text, turn.id, turn.ts])).digest('hex')
  };
}

const pathKey = (p: string): string => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Resolve through the nearest live ancestor, even after our own temporary worktree move. */
async function canonicalCheckout(cwd: string): Promise<string> {
  if (!path.isAbsolute(cwd)) throw new Error('The session path is not absolute.');
  try { return pathKey(await fs.realpath(cwd)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // ENOENT through a dangling junction isn't proof of an unrelated checkout.
    const entry = await fs.lstat(cwd).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== 'ENOENT') throw cause;
      return null;
    });
    if (entry) throw error;
    const parent = path.dirname(cwd);
    return parent === cwd ? pathKey(cwd) : pathKey(path.join(await canonicalCheckout(parent), path.basename(cwd)));
  }
}
const fingerprint = (session: SessionMeta): string => JSON.stringify([
  session.title, session.cwd, session.config.projectRoot, session.worktreeBranch, session.status,
  session.createdAt, session.updatedAt, session.lastViewedAt, session.lastUserMessageAt
]);

export class HousekeepService {
  private plan?: Plan;
  private busy = false;

  constructor(private readonly deps: HousekeepDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private days(recentDaysOverride?: number): number {
    // An explicit override belongs to this preview. Ordinary reviews still recheck the live setting.
    return recentDaysOverride ?? normalizeHousekeepRecentDays(this.deps.settings().housekeepRecentDays);
  }

  private protection(session: SessionMeta, excluded: Set<string>, days: number, checkRuntime: () => boolean): string | null {
    if (session.archived) return 'Already archived.';
    if (excluded.has(session.id) || this.deps.hasTerminalOrView(session.id)) return 'Open, has a draft, or has a terminal.';
    if (session.pinned) return 'Pinned session.';
    if (session.status === 'pr') return 'An open pull request is recorded.';
    if (!['idle', 'merged', 'stopped'].includes(session.status) || session.queued || session.goal?.status === 'active' || session.goal?.status === 'paused' || !checkRuntime()) {
      return 'Session activity, queued input, or workspace ownership is not safely idle.';
    }
    const at = housekeepActivityAt(session);
    if (at === null || housekeepIsRecent(at, this.now(), days)) return 'Recent activity, or activity date cannot be verified.';
    return null;
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Housekeep is already working. Wait for it to finish.');
    this.busy = true;
    try { return await task(); } finally { this.busy = false; }
  }

  private current(id: string): Plan {
    if (!this.plan || this.plan.preview.id !== id || this.now() - this.plan.createdAt > PLAN_MS) {
      throw new Error('This Housekeep preview expired. Scan sessions again.');
    }
    return this.plan;
  }

  private snapshot(plan: Plan): HousekeepPreview { return structuredClone(plan.preview); }

  private async assertExclusiveCheckout(session: SessionMeta, sessions: SessionMeta[], paths = new Map<string, Promise<string>>()): Promise<void> {
    if (!session.worktreeBranch) return;
    const canonical = (cwd: string) => {
      let known = paths.get(cwd);
      if (!known) { known = canonicalCheckout(cwd); paths.set(cwd, known); }
      return known;
    };
    const target = await canonical(session.cwd);
    for (const other of sessions) {
      if (other.id !== session.id && (inside(pathKey(session.cwd), pathKey(other.cwd)) || inside(target, await canonical(other.cwd)))) {
        throw new Error('Another session refers to this worktree.');
      }
    }
  }

  private assertSettingsSettled(): void {
    if (this.deps.savingRecentDays?.()) throw new Error('Wait for the new Housekeep setting to finish saving.');
  }

  preview(protectedIds: string[], recentDaysOverride?: number): Promise<HousekeepPreview> {
    return this.exclusive(async () => {
      this.plan = undefined;
      const reviewer = this.deps.reviewer();
      const plan: Plan = {
        preview: { id: randomUUID(), recentDays: this.days(recentDaysOverride), reviewModel: reviewer?.label ?? null, rows: [] },
        recentDaysOverride, createdAt: this.now(), modelIdentity: reviewer?.identity, candidates: new Map(), protectedIds: new Set(protectedIds)
      };
      const sessions = this.deps.sessions.list();
      const runningOwners = await this.deps.runningOwners?.();
      const checkoutPaths = new Map<string, Promise<string>>();
      for (const session of sessions.filter(s => !s.archived).sort((a, b) => (housekeepActivityAt(b) ?? 0) - (housekeepActivityAt(a) ?? 0))) {
        const { id, title, config: { projectRoot } } = session;
        const row: HousekeepRow = { sessionId: id, title, projectRoot, activityAt: housekeepActivityAt(session), verdict: 'protected', reason: '', worktree: null };
        plan.preview.rows.push(row);
        const reason = this.protection(session, plan.protectedIds, plan.preview.recentDays, () => this.deps.sessions.canHousekeep(id));
        if (reason) { row.reason = reason; continue; }
        if (runningOwners === null || runningOwners?.has(id)) { row.reason = 'A process may still be using this session.'; continue; }
        try {
          const signature = fingerprint(session);
          const tree = await (this.deps.inspect ?? inspectHousekeepWorktree)({ projectRoot, cwd: session.cwd, branch: session.worktreeBranch });
          if (tree.kind === 'blocked') { row.reason = tree.reason; continue; }
          if (tree.kind === 'clean') {
            if (!this.deps.trashDirectory) { row.reason = 'Recoverable worktree removal is not available.'; continue; }
            await this.assertExclusiveCheckout(session, sessions, checkoutPaths);
          }
          const evidence = housekeepEvidence(await this.deps.sessions.housekeepTranscript(id), session);
          if (typeof evidence === 'string') { row.reason = evidence; continue; }
          row.activityAt = Math.max(row.activityAt ?? 0, evidence.activityAt);
          const days = this.days(plan.recentDaysOverride);
          if (housekeepIsRecent(row.activityAt, this.now(), days)) { row.reason = 'Recent transcript activity.'; continue; }
          const current = this.deps.sessions.get(id);
          if (!current || fingerprint(current) !== signature || this.protection(current, plan.protectedIds, days, () => this.deps.sessions.canHousekeep(id))) {
            row.reason = 'Session changed during the scan.'; continue;
          }
          row.worktree = tree.kind === 'clean' ? 'remove' : tree.kind;
          row.verdict = 'review';
          row.reason = 'Review the latest request and response before marking complete.';
          row.evidence = evidence.excerpt;
          plan.candidates.set(id, { fingerprint: signature, tree, evidenceDigest: evidence.digest, transcriptActivityAt: evidence.activityAt });
        } catch (error) {
          row.reason = error instanceof Error && error.message === 'Another session refers to this worktree.' ? error.message : 'Could not verify this session and its worktree.';
        }
      }
      plan.createdAt = this.now();
      this.plan = plan;
      return this.snapshot(plan);
    });
  }

  assess(id: string): Promise<HousekeepPreview> {
    return this.exclusive(async () => {
      const plan = this.current(id);
      const reviewer = this.deps.reviewer();
      if (!reviewer || reviewer.identity !== plan.modelIdentity) throw new Error('The utility model changed. Scan again to review with the new model.');
      if (plan.assessed) return this.snapshot(plan);
      plan.assessed = true;
      const rows = plan.preview.rows.filter(row => row.verdict === 'review');
      for (let start = 0; start < rows.length; start += REVIEW_BATCH) {
        const batch = rows.slice(start, start + REVIEW_BATCH).filter(row => {
          const session = this.deps.sessions.get(row.sessionId);
          const candidate = plan.candidates.get(row.sessionId);
          const days = this.days(plan.recentDaysOverride);
          if (candidate && session && !housekeepIsRecent(candidate.transcriptActivityAt, this.now(), days) && fingerprint(session) === candidate.fingerprint &&
              !this.protection(session, plan.protectedIds, days, () => this.deps.sessions.canHousekeep(session.id))) return true;
          row.verdict = 'protected'; row.reason = 'Session changed after the preview.'; delete row.evidence;
          plan.candidates.delete(row.sessionId);
          return false;
        });
        if (!batch.length) continue;
        let parsed: z.infer<typeof modelReply> | undefined;
        try {
          const input = batch.map((row, index) => ({ index, ...row.evidence }));
          const raw = await reviewer.complete(JSON.stringify({ untrustedConversationExcerpts: input }));
          const result = raw && raw.length <= 12_000 ? modelReply.safeParse(JSON.parse(raw)) : null;
          if (result?.success && result.data.reviews.every(r => r.index < batch.length) && new Set(result.data.reviews.map(r => r.index)).size === result.data.reviews.length) parsed = result.data;
        } catch { /* An unavailable reviewer is just manual review, never approval. */ }
        batch.forEach((row, index) => {
          const review = parsed?.reviews.find(r => r.index === index);
          row.verdict = review?.verdict ?? 'review';
          row.reason = review?.reason ?? 'No verified model recommendation. Review this session yourself.';
        });
      }
      plan.createdAt = this.now();
      return this.snapshot(plan);
    });
  }

  apply(id: string, ids: string[], protectedIds: string[]): Promise<HousekeepOutcome[]> {
    return this.exclusive(async () => {
      const plan = this.current(id);
      this.assertSettingsSettled();
      const selected = new Set(ids);
      const rows = plan.preview.rows.filter(row => selected.has(row.sessionId) && (row.verdict === 'review' || row.verdict === 'complete'));
      if (!rows.length || rows.length !== ids.length) throw new Error('Select only eligible sessions from the current preview.');
      this.plan = undefined; // One use, even if a later verification or write fails.
      const excluded = new Set([...plan.protectedIds, ...protectedIds]);
      const result: HousekeepOutcome[] = [];
      for (const row of rows) {
        const { sessionId, title } = row;
        const candidate = plan.candidates.get(sessionId)!;
        try {
          const removed = await this.deps.sessions.archiveForHousekeep(sessionId, async assertIdle => {
            const current = (transcriptActivityAt = candidate.transcriptActivityAt) => {
              assertIdle();
              this.assertSettingsSettled();
              const days = this.days(plan.recentDaysOverride);
              if (housekeepIsRecent(transcriptActivityAt, this.now(), days)) throw new Error('Recent transcript activity.');
              const session = this.deps.sessions.get(sessionId);
              if (!session) throw new Error('Session no longer exists.');
              const reason = this.protection(session, excluded, days, () => true);
              if (reason) throw new Error(reason);
              if (fingerprint(session) !== candidate.fingerprint) throw new Error('Session changed after the preview.');
              return session;
            };
            const session = current();
            await this.deps.authorize?.(sessionId);
            const evidence = housekeepEvidence(await this.deps.sessions.housekeepTranscript(sessionId), session);
            if (typeof evidence === 'string' || evidence.digest !== candidate.evidenceDigest) throw new Error('Transcript changed after the preview.');
            const runningOwners = await this.deps.runningOwners?.();
            if (runningOwners === null || runningOwners?.has(sessionId)) throw new Error('A process may still be using this session.');
            current(evidence.activityAt);
            if (candidate.tree.kind === 'clean') {
              if (!this.deps.trashDirectory) throw new Error('Recoverable worktree removal is not available.');
              await (this.deps.remove ?? removeHousekeepWorktree)(candidate.tree, async () => {
                const live = current(evidence.activityAt);
                await this.assertExclusiveCheckout(live, this.deps.sessions.list());
                current(evidence.activityAt);
              }, this.deps.trashDirectory);
              return true;
            }
            const checked = await (this.deps.inspect ?? inspectHousekeepWorktree)({ projectRoot: session.config.projectRoot, cwd: session.cwd, branch: session.worktreeBranch });
            if (checked.kind !== candidate.tree.kind) throw new Error('Worktree changed after the preview.');
            current(evidence.activityAt);
            return false;
          });
          result.push({ sessionId, title, state: removed ? 'removed' : 'archived' });
        } catch (error) {
          result.push({ sessionId, title, state: 'skipped', detail: errorMessage(error) });
        }
      }
      return result;
    });
  }
}
