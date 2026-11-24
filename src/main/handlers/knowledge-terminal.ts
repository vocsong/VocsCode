/** Layer 2 project knowledge, intelligence/memory ledger, and PTY terminal IPC handlers. */
import { z } from 'zod';
import { isMemoryState, isMemoryType } from '../../shared/intelligence';
import { KNOWLEDGE_USAGE_WINDOWS, type KnowledgeUsageLookup } from '../../shared/knowledge-usage';
import type { IntelligenceContext, IntelligenceService } from '../intelligence/service';
import type { FinishKnowledgeLookup, KnowledgeUsageSample } from '../intelligence/usage';
import { usageForEvidence, usageForPacket } from '../intelligence/usage-observation';
import { sessionIdSchema, type HandlerContext } from './context';

export function registerKnowledgeTerminalHandlers(ctx: HandlerContext): void {
  const { deps, handle, knowledgeScopeOf } = ctx;
  const { sessions, terminals } = deps;

  // Layer 2 project knowledge. Every channel resolves its scope from the session, never from a
  // renderer-supplied path, so a client cannot read or write another project's wiki.
  const knowledgeOf = () => deps.knowledge ?? null;
  handle('knowledge:view', ({ sessionId }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    return k.view(knowledgeScopeOf(sessionId));
  });
  handle('knowledge:create', ({ sessionId }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    return k.createWiki(knowledgeScopeOf(sessionId));
  });
  handle('knowledge:read', ({ sessionId, id }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    return typeof id === 'string' && id ? k.detail(knowledgeScopeOf(sessionId), id) : null;
  });
  handle('knowledge:search', ({ sessionId, q, limit, includeHistorical }) => {
    const k = knowledgeOf();
    if (!k || typeof q !== 'string' || !q.trim()) return [];
    return k.search(knowledgeScopeOf(sessionId), q, { limit: typeof limit === 'number' ? limit : undefined, includeHistorical: includeHistorical === true });
  });
  handle('knowledge:review', async ({ sessionId, id, action, note }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    if (action !== 'accept' && action !== 'reject') throw new Error('Unknown review action');
    const scope = knowledgeScopeOf(sessionId);
    const withdraw = deps.intelligence && action === 'reject' && (await k.store.read(scope, id))?.meta.scope === 'repo';
    await k.review(scope, id, action, { by: 'human', ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}) });
    if (withdraw && !(await k.store.read(scope, id))) await deps.intelligence?.retireWikiPromotions({ sessionId, ...scope }, id);
    return k.view(scope);
  });
  handle('knowledge:reviewAll', async ({ sessionId }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    const scope = knowledgeScopeOf(sessionId);
    const result = await k.acceptAll(scope, { by: 'human' });
    return { accepted: result.accepted, view: await k.view(scope) };
  });
  handle('knowledge:generate', ({ sessionId, mode }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    if (mode !== 'bootstrap' && mode !== 'distill' && mode !== 'reflect') throw new Error('Unknown generation mode');
    return k.generate(knowledgeScopeOf(sessionId), mode);
  });
  handle('knowledge:publish', ({ sessionId, ids }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 50) : [];
    return k.publish(knowledgeScopeOf(sessionId), list);
  });
  handle('knowledge:graph', ({ sessionId }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    return k.graph(knowledgeScopeOf(sessionId));
  });
  handle('knowledge:delete', async ({ sessionId, id }) => {
    const k = knowledgeOf();
    if (!k) throw new Error('Project knowledge is unavailable in this run');
    if (typeof id !== 'string' || !id) throw new Error('A page id is required');
    const scope = knowledgeScopeOf(sessionId);
    const withdraw = deps.intelligence && (await k.store.read(scope, id))?.meta.scope === 'repo';
    // A delete that found nothing must not report success: the panel would claim a page is gone
    // while it is still served to every agent.
    if (!(await k.remove(scope, id))) throw new Error(`Nothing to delete: ${id} is not in this project's wiki.`);
    if (withdraw) await deps.intelligence?.retireWikiPromotions({ sessionId, ...scope }, id);
    return k.view(scope);
  });

  // The intelligence core. As with knowledge, the project, checkout and branch always come from
  // the session the app holds: a renderer can name a session, never a path or a project id.
  const intelligenceOf = (): IntelligenceService => {
    if (!deps.intelligence) throw new Error('Memory and collections are unavailable in this run');
    return deps.intelligence;
  };
  const intelligenceContextOf = (sessionId: string): IntelligenceContext => {
    const id = sessionIdSchema.parse(sessionId);
    return { sessionId: id, ...knowledgeScopeOf(id) };
  };
  const recordId = (id: unknown): string => {
    if (typeof id !== 'string' || !/^mem_[0-9a-z]{6,40}$/.test(id)) throw new Error('A memory record id is required');
    return id;
  };
  const usageOf = () => {
    if (!deps.knowledgeUsage) throw new Error('Local Knowledge usage is unavailable in this run.');
    return deps.knowledgeUsage;
  };
  const usageRequest = z.strictObject({ sessionId: sessionIdSchema, days: z.literal(KNOWLEDGE_USAGE_WINDOWS) });
  const usageConfig = usageRequest.extend({ enabled: z.boolean() });
  const usageVote = z.strictObject({ sessionId: sessionIdSchema, receipt: z.uuid(), vote: z.enum(['helped', 'not-helpful']) });
  const trackEvidence = async <T extends object>(
    ctxObj: IntelligenceContext,
    tool: KnowledgeUsageLookup,
    work: () => Promise<T>,
    describe: (result: T) => KnowledgeUsageSample
  ): Promise<T & { usageReceipt?: string }> => {
    let finish: FinishKnowledgeLookup | undefined;
    try {
      finish = deps.knowledgeUsage?.begin(ctxObj, 'desktop', tool);
    } catch {
      deps.log('warn', 'knowledge usage: could not start counting a lookup');
    }
    if (!finish) return work();
    const record = (sample: () => KnowledgeUsageSample) => {
      try {
        return finish(sample());
      } catch {
        deps.log('warn', 'knowledge usage: could not count a lookup');
        return undefined;
      }
    };
    const result = await work().catch((error: unknown) => {
      record(() => ({ outcome: 'failed' }));
      throw error;
    });
    const usageReceipt = record(() => describe(result));
    return usageReceipt ? { ...result, usageReceipt } : result;
  };

  handle('intelligence:view', ({ sessionId }) => intelligenceOf().view(intelligenceContextOf(sessionId)));
  handle('intelligence:search', ({ sessionId, query, scope, limit, includeHistorical }) => {
    if (typeof query !== 'string' || !query.trim()) throw new Error('A question is required');
    const intelCtx = intelligenceContextOf(sessionId);
    const i = intelligenceOf();
    return trackEvidence(
      intelCtx,
      'intelligence_search',
      () =>
        i.search(intelCtx, {
          query: query.slice(0, 500),
          scope: scope === 'collection' ? 'collection' : 'project',
          ...(typeof limit === 'number' ? { limit } : {}),
          includeHistorical: includeHistorical === true
        }),
      (result) => usageForEvidence(result.results)
    );
  });
  handle('intelligence:compile', ({ sessionId, query, budgetTokens, scope }) => {
    if (typeof query !== 'string' || !query.trim()) throw new Error('A question is required');
    const intelCtx = intelligenceContextOf(sessionId);
    const i = intelligenceOf();
    return trackEvidence(
      intelCtx,
      'context_compile',
      () => i.compile(intelCtx, { query: query.slice(0, 500), ...(typeof budgetTokens === 'number' ? { budgetTokens } : {}), scope: scope === 'collection' ? 'collection' : 'project' }),
      usageForPacket
    );
  });
  handle('intelligence:usage:view', (input) => {
    const { sessionId, days } = usageRequest.parse(input);
    return usageOf().report(intelligenceContextOf(sessionId), days);
  });
  handle('intelligence:usage:configure', async (input) => {
    const { sessionId, days, enabled } = usageConfig.parse(input);
    const intelCtx = intelligenceContextOf(sessionId);
    const usage = usageOf();
    await usage.configure(intelCtx, enabled);
    return usage.report(intelCtx, days);
  });
  handle('intelligence:usage:clear', async (input) => {
    const { sessionId, days } = usageRequest.parse(input);
    const intelCtx = intelligenceContextOf(sessionId);
    const usage = usageOf();
    await usage.clear(intelCtx);
    return usage.report(intelCtx, days);
  });
  handle('intelligence:usage:vote', (input) => {
    const { sessionId, receipt, vote } = usageVote.parse(input);
    return usageOf().vote(intelligenceContextOf(sessionId), receipt, vote);
  });
  handle('intelligence:memory:add', async ({ sessionId, type, title, text, scope }) => {
    if (!isMemoryType(type) || type === 'working') throw new Error('Unknown memory type');
    if (typeof title !== 'string' || !title.trim() || typeof text !== 'string' || !text.trim()) throw new Error('A record needs a title and text');
    if (scope !== 'project' && scope !== 'personal') throw new Error('A record is added to this project or to personal memory');
    const i = intelligenceOf();
    const intelCtx = intelligenceContextOf(sessionId);
    await i.addRecord(intelCtx, { type, title, text, scope });
    return i.view(intelCtx);
  });
  handle('intelligence:memory:decide', async ({ sessionId, id, to, note }) => {
    if (!isMemoryState(to)) throw new Error('Unknown memory state');
    const i = intelligenceOf();
    const intelCtx = intelligenceContextOf(sessionId);
    await i.decide(intelCtx, recordId(id), to, typeof note === 'string' && note.trim() ? { note: note.trim() } : {});
    return i.view(intelCtx);
  });
  handle('intelligence:memory:forget', async ({ sessionId, id }) => {
    const i = intelligenceOf();
    const intelCtx = intelligenceContextOf(sessionId);
    // A forget that removed nothing must not report success: the panel would show a record as gone
    // while it is still recalled.
    if (!(await i.forget(intelCtx, recordId(id), 'human')).forgotten) throw new Error('Nothing was forgotten: that record is no longer there.');
    return i.view(intelCtx);
  });
  handle('intelligence:memory:apply', async ({ sessionId, id }) => {
    const i = intelligenceOf();
    const intelCtx = intelligenceContextOf(sessionId);
    const { pageId } = await i.applyToWiki(intelCtx, recordId(id));
    return { pageId, view: await i.view(intelCtx) };
  });
  handle('intelligence:memory:export', ({ sessionId }) => intelligenceOf().exportMemory(intelligenceContextOf(sessionId)));
  handle('intelligence:memory:import', async ({ sessionId, bundle }) => {
    const i = intelligenceOf();
    const intelCtx = intelligenceContextOf(sessionId);
    const result = await i.importMemory(intelCtx, bundle);
    return { ...result, view: await i.view(intelCtx) };
  });
  handle('intelligence:reflect', ({ sessionId }) => {
    const intelCtx = intelligenceContextOf(sessionId);
    const m = sessions.get(intelCtx.sessionId);
    if (!m) throw new Error('Session not found');
    return intelligenceOf().reflect(intelCtx, { title: m.title }, 'manual');
  });
  handle('intelligence:promote', async ({ sessionId, pageId, recordId: record, to, collectionId }) => {
    if (to !== 'collection' && to !== 'personal') throw new Error('Promote to a collection or to personal memory');
    const i = intelligenceOf();
    const intelCtx = intelligenceContextOf(sessionId);
    await i.promote(intelCtx, {
      ...(typeof pageId === 'string' && pageId ? { pageId } : {}),
      ...(typeof record === 'string' && record ? { recordId: recordId(record) } : {}),
      to,
      ...(typeof collectionId === 'string' && collectionId ? { collectionId } : {})
    });
    return i.view(intelCtx);
  });
  handle('intelligence:promotion:decide', async ({ sessionId, id, decision }) => {
    if (decision !== 'approve' && decision !== 'reject') throw new Error('Unknown decision');
    if (typeof id !== 'string' || !id) throw new Error('A promotion request id is required');
    const i = intelligenceOf();
    const intelCtx = intelligenceContextOf(sessionId);
    await i.decidePromotion(intelCtx, id, decision);
    return i.view(intelCtx);
  });
  handle('intelligence:collection:save', async ({ sessionId, id, name, description, members }) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('A collection needs a name');
    const list = (Array.isArray(members) ? members : [])
      .filter((m): m is { projectId: string; share: 'promoted' | 'wiki' } => !!m && typeof m.projectId === 'string')
      .map((m) => ({ projectId: m.projectId, share: m.share === 'wiki' ? ('wiki' as const) : ('promoted' as const) }));
    const i = intelligenceOf();
    const intelCtx = intelligenceContextOf(sessionId);
    await i.saveCollection({ ...(typeof id === 'string' && id ? { id } : {}), name, ...(typeof description === 'string' ? { description } : {}), members: list });
    return i.view(intelCtx);
  });
  handle('intelligence:collection:delete', async ({ sessionId, id }) => {
    if (typeof id !== 'string' || !id) throw new Error('A collection id is required');
    const i = intelligenceOf();
    const intelCtx = intelligenceContextOf(sessionId);
    if (!(await i.deleteCollection(id))) throw new Error('That collection no longer exists.');
    return i.view(intelCtx);
  });
  handle('intelligence:graph:index', async ({ sessionId }) => {
    const i = intelligenceOf();
    const intelCtx = intelligenceContextOf(sessionId);
    await i.graphIndex(intelCtx);
    return i.view(intelCtx);
  });
  handle('intelligence:graph:clear', async ({ sessionId }) => {
    const i = intelligenceOf();
    const intelCtx = intelligenceContextOf(sessionId);
    await i.graphClear(intelCtx);
    return i.view(intelCtx);
  });

  handle('terminal:list', () => terminals.list());
  handle('terminal:screen', ({ terminalId, lines }) => terminals.screenText(String(terminalId ?? ''), typeof lines === 'number' ? lines : undefined));
  handle('terminal:shells', () => terminals.shells());
  handle('terminal:create', ({ sessionId, shell, cols, rows }) => {
    sessions.assertNotHousekeeping?.(sessionId);
    return terminals.create(sessionId, { shell, cols, rows });
  });
  handle('terminal:attach', ({ terminalId, cols, rows }) => terminals.attach(terminalId, cols, rows));
  handle('terminal:detach', ({ terminalId }) => terminals.detach(terminalId));
  handle('terminal:input', ({ terminalId, data }) => terminals.input(terminalId, data));
  handle('terminal:resize', ({ terminalId, cols, rows }) => terminals.resize(terminalId, cols, rows));
  handle('terminal:ack', ({ terminalId, chars }) => terminals.ack(terminalId, chars));
  handle('terminal:kill', ({ terminalId }) => terminals.kill(terminalId));
  handle('terminal:restart', ({ terminalId }) => terminals.restart(terminalId));
  handle('terminal:close', ({ terminalId }) => terminals.close(terminalId));
  handle('terminal:clear', ({ terminalId }) => terminals.clear(terminalId));
  handle('terminal:rename', ({ terminalId, title }) => terminals.rename(terminalId, title));
}
