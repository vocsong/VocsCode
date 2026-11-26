/** Sourced knowledge recording, local draft submission, and protected-page candidate filing. */
import path from 'node:path';
import { redactSecrets } from '../../shared/analytics/text';
import type { EvidenceSource } from '../../shared/intelligence';
import { KNOWLEDGE_KINDS, type KnowledgeKind, type KnowledgeProposalInput } from '../../shared/knowledge';
import type { KnowledgeProtectedChange } from '../knowledge/service';
import { exists } from '../util/fs';
import type { IntelligenceContext } from './context';
import { checkDraftEvidence } from './draft-evidence';
import {
  INTENT_KINDS,
  memoryAuthority,
  resolveProject,
  scopeOf,
  type IntelligenceServiceDeps,
  type KnowledgeRecordInput,
  type KnowledgeRecordResult
} from './scope';

/** Resolves commit citations without treating their existence as verification of the claim. */
async function checkSources(
  deps: Pick<IntelligenceServiceDeps, 'git'>,
  ctx: IntelligenceContext,
  sources: EvidenceSource[]
): Promise<{ sources: EvidenceSource[]; unresolved: string[] }> {
  const git = deps.git;
  const out: EvidenceSource[] = [];
  const unresolved: string[] = [];
  for (const source of sources.slice(0, 24)) {
    ctx.signal?.throwIfAborted();
    if (!source || typeof source.ref !== 'string' || !source.ref.trim()) continue;
    const next: EvidenceSource = { type: source.type, ref: source.ref.trim(), ...(source.note ? { note: source.note } : {}) };
    if (git && source.type === 'commit') {
      const sha = await git.resolveCommit(ctx.cwd, next.ref).catch(() => null);
      if (sha) next.revision = sha;
      else unresolved.push(next.ref);
    } else if (git && (source.type === 'file' || source.type === 'doc')) {
      const rel = next.ref.replace(/\\/g, '/').replace(/^\.\//, '');
      // A working-tree file can be changed or untracked; don't stamp it as a source from HEAD.
      if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..') || !(await exists(path.join(ctx.cwd, rel)))) unresolved.push(next.ref);
    }
    out.push(next);
  }
  return { sources: out, unresolved };
}

async function recordDraft(
  deps: Pick<IntelligenceServiceDeps, 'knowledge' | 'git'>,
  ctx: IntelligenceContext,
  input: KnowledgeRecordInput,
  proposal: KnowledgeProposalInput
): Promise<KnowledgeRecordResult> {
  if (ctx.restricted || input.pageId || input.memoryType === 'episodic') throw new Error('Drafts only propose new project facts or procedures from an unrestricted session.');
  const { title, claim, body } = proposal;
  const text = [title, claim, body].join('\n');
  if (!body || title.length > 160 || claim.length > 360 || /[\r\n]/.test(claim) || body.length > 2_000) {
    throw new Error('A draft needs a title (up to 160 characters), a one-line claim (360), and a short body (2,000).');
  }
  if (/-----BEGIN|[\u0000-\u0008\u000b\u000c\u000e-\u001f]|:\/\/[^\s/@]+:[^\s/@]+@/i.test(text) || redactSecrets(text) !== text) {
    throw new Error('A draft must not contain credential-like text.');
  }
  const sources = await checkDraftEvidence(ctx.cwd, input.sources, deps.git?.resolveCommit, ctx.signal);
  ctx.signal?.throwIfAborted();
  const result = await deps.knowledge.draft(scopeOf(ctx), { ...proposal, sources }, ctx.signal);
  if (result.rejected) return { stored: 'none', id: '', state: 'rejected', authority: 'none', note: 'This claim was rejected before; nothing was written.' };
  // A repeat or an existing wiki page is not a new draft and must not edit that page.
  return {
    stored: result.saved ? 'wiki' : 'none',
    id: result.id,
    state: 'draft',
    authority: 'candidate',
    note: result.saved
      ? 'Saved a local draft for review. It is not current guidance and is not published or shared.'
      : 'Already recorded; nothing was changed.'
  };
}

/**
 * Captures sourced knowledge from an agent. Durable facts and procedures go to the project wiki
 * through the same ingest path as every other writer; episodes go to the ledger as candidates.
 * A citation is provenance. Only an actual check of the claim or a human review can verify it.
 */
export async function recordKnowledge(
  deps: Pick<IntelligenceServiceDeps, 'knowledge' | 'registry' | 'memory' | 'git'>,
  ctx: IntelligenceContext,
  input: KnowledgeRecordInput,
  origin: string
): Promise<KnowledgeRecordResult> {
  ctx.signal?.throwIfAborted();
  const title = (input.title ?? '').trim();
  const claim = (input.claim ?? '').trim();
  const body = (input.body ?? '').trim();
  if (!title || !claim) throw new Error('A record needs a title and a one-sentence claim.');
  const memoryType = input.memoryType ?? 'semantic';
  if (memoryType !== 'episodic' && memoryType !== 'semantic' && memoryType !== 'procedural') throw new Error('Agents can record episodes, project facts and procedures, not personal preferences.');
  if (input.scope === 'branch' && !ctx.branch) throw new Error('Branch knowledge needs a session on that branch.');
  const kind = (KNOWLEDGE_KINDS as readonly string[]).includes(String(input.kind)) ? (input.kind as KnowledgeKind) : memoryType === 'procedural' ? 'convention' : 'concept';
  const pageScope = input.scope === 'branch' ? 'branch' : 'repo';
  if (input.draft) return recordDraft(deps, ctx, input, { title, claim, body, kind, scope: pageScope, ...(memoryType !== 'episodic' ? { memoryType } : {}) });
  const checked = await checkSources(deps, ctx, input.sources ?? []);
  const unresolvedNote = checked.unresolved.length ? ` ${checked.unresolved.length} cited source(s) could not be found in this checkout.` : '';
  const project = await resolveProject(deps, ctx);
  ctx.signal?.throwIfAborted();

  if (memoryType === 'episodic') {
    if (!deps.memory.available) throw new Error(`Episodic memory is unavailable: ${deps.memory.reason ?? 'the ledger is not open'}`);
    const episodicKind = (['episode', 'attempt', 'failure', 'fix', 'lesson', 'procedure', 'note'] as const).find((k) => k === input.kind) ?? 'lesson';
    const record = deps.memory.create(
      project.id,
      {
        type: 'episodic',
        kind: episodicKind,
        scope: input.scope === 'branch' && ctx.branch ? 'branch' : 'project',
        state: 'candidate',
        title: redactSecrets(title),
        text: redactSecrets(body ? `${claim}\n\n${body}` : claim),
        ...(input.scope === 'branch' && ctx.branch ? { branch: ctx.branch } : {}),
        sessionId: ctx.sessionId,
        sources: [...checked.sources, { type: 'session', ref: ctx.sessionId }]
      },
      origin
    );
    if (!record) return { stored: 'none', id: '', state: 'rejected', authority: 'none', note: 'This was forgotten or rejected before, so nothing was recorded.' };
    deps.memory.audit({ action: 'memory.record', actor: origin, projectId: project.id, ref: record.id, detail: `${record.type} ${record.state}` });
    return {
      stored: 'memory',
      id: record.id,
      state: record.state,
      authority: memoryAuthority(record),
      ...(record.verification ? { verification: record.verification } : {}),
      note: (record.state === 'candidate' ? 'Recorded as a candidate: it is recalled as unverified history until reviewed.' : 'Matched an existing memory without changing its authority.') + unresolvedNote
    };
  }

  if (!body) throw new Error('Project knowledge needs a body: the claim, the rationale, and how to apply it.');
  const scope = scopeOf(ctx);
  const result = await deps.knowledge.propose(
    scope,
    {
      title,
      claim,
      body,
      kind,
      memoryType,
      ...(input.scope === 'branch' && ctx.branch ? { scope: 'branch' as const } : {}),
      ...(input.pageId ? { pageId: input.pageId } : {}),
      ...(input.keywords?.length ? { keywords: input.keywords } : {}),
      ...(input.labels?.length ? { labels: input.labels } : {}),
      ...(checked.sources.length ? { sources: checked.sources } : {}),
      ...(input.anchors?.length ? { anchors: input.anchors } : {})
    },
    origin,
    ctx.sessionId,
    ctx.signal
  );
  if (result.rejected) return { stored: 'none', id: '', state: 'rejected', authority: 'none', note: 'This claim was rejected before and is tombstoned; nothing was written.' };
  if (result.protected === 'refused') {
    return { stored: deps.memory.available ? 'memory' : 'none', id: result.id, state: 'candidate', authority: 'candidate', note: `Page ${result.id} is human-reviewed and was not changed. Your version was filed as a candidate for the user to review in the Knowledge panel.` };
  }
  if (result.protected === 'kept') {
    return { stored: 'wiki', id: result.id, state: 'active', authority: 'human-reviewed', note: `Page ${result.id} is human-reviewed: its text was kept and your sources were added as evidence.${unresolvedNote}` };
  }
  return {
    stored: 'wiki',
    id: result.id,
    state: 'active',
    authority: 'accepted',
    note: (INTENT_KINDS.has(kind)
      ? 'Recorded in the project wiki as accepted. Design intent is verified by a person, not by a citation.'
      : 'Recorded in the project wiki as accepted, not verified.') + unresolvedNote
  };
}

export async function fileProtectedChange(
  deps: Pick<IntelligenceServiceDeps, 'registry' | 'memory'>,
  change: KnowledgeProtectedChange
): Promise<void> {
  if (!deps.memory.available) return;
  const project = await resolveProject(deps, { projectRoot: change.scope.projectRoot, signal: change.signal });
  change.signal?.throwIfAborted();
  const candidate = deps.memory.create(
    project.id,
    {
      type: 'semantic',
      kind: 'note',
      scope: change.scope.branch ? 'branch' : 'project',
      ...(change.scope.branch ? { branch: change.scope.branch } : {}),
      state: 'candidate',
      title: redactSecrets(`Proposed change: ${change.input.title}`),
      text: redactSecrets(`${change.input.claim}\n\n${change.input.body}`),
      ...(change.sessionId ? { sessionId: change.sessionId } : {}),
      sources: [{ type: 'doc', ref: `wiki:${change.pageId}`, note: 'the human-reviewed page this would change' }, ...(change.input.sources ?? [])]
    },
    change.origin
  );
  if (candidate) deps.memory.audit({ action: 'knowledge.protected', actor: change.origin, projectId: project.id, ref: change.pageId, detail: 'change to a human-reviewed page filed as a candidate' });
}
