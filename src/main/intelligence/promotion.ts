/** Cross-project collection and personal-memory promotion workflows and snapshot binding. */
import { createHash } from 'node:crypto';
import { redactSecrets } from '../../shared/analytics/text';
import {
  isRecallableState,
  promotionProblem,
  type EvidenceSource,
  type MemoryKind,
  type MemoryRecord,
  type MemoryType,
  type ProjectCollection,
  type ProjectIdentity,
  type PromotionRequest
} from '../../shared/intelligence';
import { authorityLabel, type KnowledgeVerification } from '../../shared/knowledge';
import type { IntelligenceContext } from './context';
import { normalizeRoot } from './registry';
import {
  clip,
  getIntelligenceSettings,
  INTENT_KINDS,
  resolveProject,
  resolveVisibility,
  scopeOf,
  stampOf,
  type IntelligenceServiceDeps
} from './scope';

export type PromotionSource = { pageId?: string; recordId?: string };
export type PromotionTarget = 'collection' | 'personal';

interface PromotionSnapshot {
  title: string;
  text: string;
  type: MemoryType;
  kind: MemoryKind;
  ref: string;
  problem: string | null;
}

type PromotionDeps = Pick<IntelligenceServiceDeps, 'settings' | 'knowledge' | 'registry' | 'memory' | 'now'>;

function promotionTitle(title: string): string {
  return clip(redactSecrets(title).replace(/\u0000/g, ''), 200);
}

function promotionText(text: string): string {
  return clip(redactSecrets(text).replace(/\u0000/g, '').trim().split(/\r?\n\s*\r?\n/, 1)[0], 600);
}

function promotionDigest({ title, text, type, kind, ref }: PromotionSnapshot): string {
  return createHash('sha256').update(JSON.stringify([title, text, type, kind, ref])).digest('hex');
}

async function collectionFor(
  deps: Pick<IntelligenceServiceDeps, 'settings' | 'registry'>,
  project: ProjectIdentity,
  idOrName: string | undefined
): Promise<ProjectCollection> {
  if (!getIntelligenceSettings(deps).collections) throw new Error('Collections are switched off in Settings.');
  const wanted = (idOrName ?? '').trim();
  const collections = (await deps.registry.collections()).filter((c) => c.members.some((m) => m.projectId === project.id));
  if (!wanted) {
    if (collections.length === 1) return collections[0];
    throw new Error(collections.length ? 'This project is in several collections: name the one to promote into.' : 'This project is not in any collection.');
  }
  const found = collections.find((c) => c.id === wanted) ?? collections.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
  if (!found) throw new Error(`This project is not a member of a collection called "${wanted}".`);
  return found;
}

/** Publish only the short claim shown for review, not the original's supporting material. */
async function promotionSource(
  deps: Pick<IntelligenceServiceDeps, 'settings' | 'knowledge' | 'registry' | 'memory'>,
  ctx: IntelligenceContext,
  project: ProjectIdentity,
  source: PromotionSource,
  to: PromotionTarget
): Promise<PromotionSnapshot> {
  if (!!source.pageId === !!source.recordId) throw new Error('Name exactly one wiki page or memory record to promote.');
  if (source.pageId) {
    const page = await deps.knowledge.store.read(scopeOf(ctx), source.pageId);
    if (!page || page.meta.status !== 'current' || (page.meta.scope === 'branch' && page.meta.branch !== ctx.branch)) throw new Error(`No current wiki page "${source.pageId}" in this project.`);
    const label = authorityLabel(page.meta);
    const verified = label === 'human-reviewed' || page.meta.verification?.method === 'human-review' || (label === 'verified' && !INTENT_KINDS.has(page.meta.kind));
    return {
      title: promotionTitle(page.meta.title),
      text: promotionText(page.meta.claim ?? page.body),
      type: page.meta.memoryType ?? 'semantic',
      kind: page.meta.kind === 'decision' ? 'decision' : page.meta.memoryType === 'procedural' ? 'procedure' : 'lesson',
      ref: `wiki:${page.meta.id}`,
      problem: verified ? null : 'Only a verified or human-reviewed wiki page can be promoted.'
    };
  }
  const { visibility } = await resolveVisibility(deps, ctx, project);
  const record = deps.memory.available ? deps.memory.get(source.recordId!, { ...visibility, personal: false }) : null;
  if (!record || record.projectId !== project.id || (record.scope !== 'project' && record.scope !== 'branch') || !isRecallableState(record.state)) {
    throw new Error(`No memory record "${source.recordId}" in this project that can be promoted.`);
  }
  return { title: promotionTitle(record.title), text: promotionText(record.text), type: record.type, kind: record.kind, ref: `memory:${record.id}`, problem: promotionProblem(record, to) };
}

function publishPromotion(
  deps: Pick<IntelligenceServiceDeps, 'settings' | 'memory' | 'now'>,
  project: ProjectIdentity,
  input: PromotionSource & { to: PromotionTarget },
  snapshot: PromotionSnapshot,
  collection: ProjectCollection | null
): MemoryRecord {
  if (!deps.memory.available) throw new Error(`Promotion needs the memory ledger: ${deps.memory.reason ?? 'it is not open'}`);
  if (snapshot.problem) throw new Error(snapshot.problem);
  if (collection && !getIntelligenceSettings(deps).collections) throw new Error('Collections are switched off in Settings.');
  const verification: KnowledgeVerification = { method: 'human-review', at: stampOf(deps), by: 'human' };
  const sources: EvidenceSource[] = [{ type: 'doc', ref: snapshot.ref, projectId: project.id }];
  const record = deps.memory.create(
    input.to === 'personal' ? null : project.id,
    {
      type: input.to === 'personal' && snapshot.type === 'episodic' ? 'procedural' : snapshot.type,
      kind: snapshot.kind,
      scope: input.to,
      state: 'verified',
      title: snapshot.title,
      text: snapshot.text,
      ...(collection ? { collectionId: collection.id } : {}),
      sources,
      verification,
      promotedFrom: { projectId: project.id, projectName: project.name, ...(input.pageId ? { pageId: input.pageId } : {}), ...(input.recordId ? { recordId: input.recordId } : {}) }
    },
    'human'
  );
  if (!record) throw new Error('This was revoked before and is tombstoned; it cannot be promoted again.');
  deps.memory.audit({ action: 'promotion.approve', actor: 'human', projectId: project.id, ref: record.id, detail: `${snapshot.ref} → ${input.to}` });
  return record;
}

export async function runRequestPromotion(
  deps: PromotionDeps,
  ctx: IntelligenceContext,
  input: PromotionSource & { to: PromotionTarget; collection?: string; reason?: string },
  requestedBy: string
): Promise<PromotionRequest> {
  const project = await resolveProject(deps, ctx);
  const collection = input.to === 'collection' ? await collectionFor(deps, project, input.collection) : null;
  const snapshot = await promotionSource(deps, ctx, project, input, input.to);
  const request = await deps.registry.requestPromotion({
    projectId: project.id,
    projectName: project.name,
    source: { ...(input.pageId ? { pageId: input.pageId } : {}), ...(input.recordId ? { recordId: input.recordId } : {}) },
    title: snapshot.title,
    text: snapshot.text,
    to: input.to,
    ...(collection ? { collectionId: collection.id } : {}),
    requestedBy,
    sessionId: ctx.sessionId,
    ...(input.reason ? { reason: clip(redactSecrets(input.reason), 300) } : {}),
    binding: { root: normalizeRoot(ctx.projectRoot), ...(ctx.branch ? { branch: ctx.branch } : {}), digest: promotionDigest(snapshot) }
  }, ctx.signal);
  deps.memory.audit({ action: 'promotion.request', actor: requestedBy, projectId: project.id, ref: snapshot.ref, detail: `to ${input.to}` });
  return request;
}

export async function runPromote(
  deps: PromotionDeps,
  ctx: IntelligenceContext,
  input: PromotionSource & { to: PromotionTarget; collectionId?: string }
): Promise<MemoryRecord> {
  const project = await resolveProject(deps, ctx);
  const collection = input.to === 'collection' ? await collectionFor(deps, project, input.collectionId) : null;
  const snapshot = await promotionSource(deps, ctx, project, input, input.to);
  ctx.signal?.throwIfAborted();
  return publishPromotion(deps, project, input, snapshot, collection);
}

export async function runDecidePromotion(
  deps: PromotionDeps,
  ctx: IntelligenceContext,
  id: string,
  decision: 'approve' | 'reject'
): Promise<MemoryRecord | null> {
  const project = await resolveProject(deps, ctx);
  const pending = (await deps.registry.promotions(project.id)).find((p) => p.id === id);
  ctx.signal?.throwIfAborted();
  if (!pending) throw new Error('That promotion request is no longer waiting.');
  if (decision === 'reject') {
    await deps.registry.takePromotion(id);
    deps.memory.audit({ action: 'promotion.reject', actor: 'human', projectId: project.id, ref: id });
    return null;
  }
  if (!pending.binding || pending.binding.root !== normalizeRoot(ctx.projectRoot) || pending.binding.branch !== ctx.branch) throw new Error('Review the request in its source checkout and branch, or reject and request it again.');
  if (pending.to === 'collection' && !pending.collectionId) throw new Error('The promotion request has no destination collection.');
  const collection = pending.to === 'collection' ? await collectionFor(deps, project, pending.collectionId) : null;
  const snapshot = await promotionSource(deps, ctx, project, pending.source, pending.to);
  ctx.signal?.throwIfAborted();
  if (promotionDigest(snapshot) !== pending.binding.digest || snapshot.title !== pending.title || snapshot.text !== pending.text) throw new Error('The promotion source changed; reject the old request and review the new claim.');
  const record = publishPromotion(deps, project, { ...pending.source, to: pending.to }, snapshot, collection);
  await deps.registry.takePromotion(id);
  return record;
}
